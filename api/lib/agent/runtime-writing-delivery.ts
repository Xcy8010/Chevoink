import { randomUUID } from 'node:crypto'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { readWritingTodoSyncDelivery } from './runtime-writing-todo.js'
import { runtimeJson } from './runtime-common.js'
import { withManuscriptRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { readCompletedWritingDelivery } from './writing-scope.js'
import { readLimitedWritingDelivery } from './writing-delivery-limitations.js'
import { readDurableTodoItems } from './tools/durable-todo.js'
import { completedWritingTodoGuidance } from './tools/todo-tools.js'

/** Append a server-projected candidate; immutable prior model frames/calls and
 * usage remain in place. No pending operation or unknown outcome is skipped. */
export async function advanceDurableWritingDelivery(token: RunLeaseToken) {
  return withManuscriptRunLease(token, async tx => {
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: token.taskRootId } })
    const state = await readExecutionStateInTransaction(tx, root.id)
    if (state.frame.state.phase !== 'idle') return null
    let assistantIndex = state.frame.state.messages.length - 1
    while (assistantIndex >= 0 && state.frame.state.messages[assistantIndex].role === 'tool') assistantIndex--
    const assistant = state.frame.state.messages[assistantIndex]
    if (assistant?.role === 'assistant' && assistant.toolCalls?.some(call => !state.frame.state.messages.slice(assistantIndex + 1).some(message => message.role === 'tool' && message.toolCallId === call.id))) return null
    const subject = { userId: token.userId, novelId: root.novelId, runId: token.runId }
    const completed = await readCompletedWritingDelivery(tx, subject)
    const todos = await readDurableTodoItems(tx, root.id, state.frame.revision)
    const unfinishedTodos = todos.some(item => item.status === 'pending' || item.status === 'in_progress')
    const todoDelivery = completed ?? (unfinishedTodos ? await readWritingTodoSyncDelivery(tx, subject, taskSpecSchema.parse(state.originalSpec)) : null)
    const limited = completed || todoDelivery ? null : await readLimitedWritingDelivery(tx, subject)
    const delivery = completed ?? limited
    if (!delivery && !todoDelivery) return null
    if (await tx.agentOperation.count({ where: { taskRootId: root.id, status: { in: ['prepared', 'dispatched', 'unknown'] } } })
      || await tx.agentProviderAttempt.count({ where: { operation: { taskRootId: root.id }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })) return null
    const latest = state.frame.state.messages.at(-1)
    if (todoDelivery && unfinishedTodos) {
      const content = completedWritingTodoGuidance(todos)
      if (latest?.role === 'system' && latest.content === content) return null
      const next = await saveExecutionStateInTransaction(tx, token, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
        snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'system', content }] } })
      await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: token.runId,
        eventKey: `writing-todo-sync:${root.id}:${next.revision}`, type: 'writing.todo_sync', payload: runtimeJson({ sourceRevision: state.frame.revision,
          sourceHash: state.frame.snapshotHash, revision: next.revision, snapshotHash: next.snapshotHash,
          chapters: todoDelivery.chapters.map(({ id, revision, contentHash }) => ({ id, revision, contentHash })), todos }).value } })
      return next
    }
    if (!delivery) return null
    if (latest?.role === 'assistant' && !latest.toolCalls?.length && latest.content === delivery.text) return null
    const proof = runtimeJson({ version: 1, chapters: delivery.chapters.map(({ id, revision, contentHash }) => ({ id, revision, contentHash })), text: delivery.text,
      ...(limited ? { limitedWritingDelivery: limited } : {}) })
    const next = await saveExecutionStateInTransaction(tx, token, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
      snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: delivery.text }] } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: token.runId,
      eventKey: `writing-delivery:${root.id}:${next.revision}`, type: 'writing.delivery.projected', payload: { sourceRevision: state.frame.revision,
        sourceHash: state.frame.snapshotHash, revision: next.revision, snapshotHash: next.snapshotHash, proof: proof.value, proofHash: proof.hash } } })
    return next
  }, { timeoutMs: 20_000 })
}
