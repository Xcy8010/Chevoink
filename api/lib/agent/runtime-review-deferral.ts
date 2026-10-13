import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentStreamEventBody } from '../../../shared/contracts/index.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import type { RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, saveExecutionStateInTransaction } from './runtime-state.js'

const schema = z.object({ version: z.literal(1), sourceRevision: z.number().int().nonnegative(),
  sourceHash: z.string(), resultHash: z.string(), callId: z.string(), toolName: z.enum(['chapter_write', 'chapter_append', 'chapter_edit_range']),
  argumentsHash: z.string(), reason: z.string().min(1) }).strict()
const reply = (reason: string) => `[系统] 本次改稿提议未执行，正文与当前检查保持不变。${reason}`

/** Called only after the same transaction validates the saved next proposal and
 * current review admission. No operation, effect receipt or progress is invented. */
export async function deferReviewWriteInTransaction(tx: RuntimeTx, lease: RunLeaseToken,
  frame: Awaited<ReturnType<typeof readExecutionFrame>>, call: { id: string; name: string; arguments: string }, reason: string) {
  if (frame.state.phase !== 'idle' || frame.state.pendingOperationId) return runtimeError('RUNTIME_STATE_CONFLICT', '已有操作需要恢复，不能改为未执行提议。')
  const next = await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
    snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'tool', toolCallId: call.id, content: reply(reason) }] } })
  const payload = schema.parse({ version: 1, sourceRevision: frame.revision, sourceHash: frame.snapshotHash, resultHash: next.snapshotHash,
    callId: call.id, toolName: call.name, argumentsHash: runtimeJson(call.arguments).hash, reason })
  await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId,
    eventKey: `review-deferred:${lease.taskRootId}:${next.revision}`, type: 'review.proposal.deferred', payload: runtimeJson(payload).value } })
  return next
}

/** The immutable frame pair proves this was guidance before execution. It must
 * never project a successful edit or a failed execution card. */
export async function projectReviewWriteDeferral(tx: RuntimeTx, taskRootId: string,
  previous: Awaited<ReturnType<typeof readExecutionFrame>>, frame: Awaited<ReturnType<typeof readExecutionFrame>>,
  messageId: string): Promise<AgentStreamEventBody[] | null> {
  const witness = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `review-deferred:${taskRootId}:${frame.revision}` } })
  if (!witness) return null
  const parsed = schema.safeParse(witness.payload)
  if (!parsed.success || witness.taskRootId !== taskRootId || witness.type !== 'review.proposal.deferred') return runtimeError('RUNTIME_RECEIPT_INVALID', '改稿提议记录无效。')
  const value = parsed.data
  let index = previous.state.messages.length - 1
  while (index >= 0 && previous.state.messages[index].role === 'tool') index--
  const assistant = previous.state.messages[index]
  const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(item => !previous.state.messages.slice(index + 1)
    .some(message => message.role === 'tool' && message.toolCallId === item.id)) : undefined
  const expected = { ...previous.state, messages: [...previous.state.messages, { role: 'tool', toolCallId: value.callId, content: reply(value.reason) }] }
  if (previous.state.phase !== 'idle' || previous.state.pendingOperationId || frame.revision !== previous.revision + 1
    || value.sourceRevision !== previous.revision || value.sourceHash !== previous.snapshotHash || value.resultHash !== frame.snapshotHash
    || !call || call.incomplete || call.id !== value.callId || call.name !== value.toolName || runtimeJson(call.arguments).hash !== value.argumentsHash
    || runtimeJson(frame.state).hash !== runtimeJson(expected).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '改稿提议与原执行位置不一致。')
  return [{ type: 'tool.deferred', messageId, callId: value.callId, toolName: value.toolName, reason: value.reason, execution: 'not_dispatched' }]
}
