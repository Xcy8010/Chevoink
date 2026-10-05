import { randomUUID } from 'node:crypto'
import { runtimeJson } from './runtime-common.js'
import { withManuscriptRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { readCompletedWritingDelivery } from './writing-scope.js'

/** Append a server-projected candidate; immutable prior model frames/calls and
 * usage remain in place. No pending operation or unknown outcome is skipped. */
export async function advanceDurableWritingDelivery(token: RunLeaseToken) {
  return withManuscriptRunLease(token, async tx => {
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: token.taskRootId } })
    const state = await readExecutionStateInTransaction(tx, root.id)
    if (state.frame.state.phase !== 'idle') return null
    const delivery = await readCompletedWritingDelivery(tx, { userId: token.userId, novelId: root.novelId, runId: token.runId })
    if (!delivery) return null
    if (await tx.agentOperation.count({ where: { taskRootId: root.id, status: { in: ['prepared', 'dispatched', 'unknown'] } } })
      || await tx.agentProviderAttempt.count({ where: { operation: { taskRootId: root.id }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })) return null
    const latest = state.frame.state.messages.at(-1)
    if (latest?.role === 'assistant' && !latest.toolCalls?.length && latest.content === delivery.text) return null
    const proof = runtimeJson({ version: 1, chapters: delivery.chapters.map(({ id, revision, contentHash }) => ({ id, revision, contentHash })), text: delivery.text })
    const next = await saveExecutionStateInTransaction(tx, token, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
      snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: delivery.text }] } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: token.runId,
      eventKey: `writing-delivery:${root.id}:${next.revision}`, type: 'writing.delivery.projected', payload: { sourceRevision: state.frame.revision,
        sourceHash: state.frame.snapshotHash, revision: next.revision, snapshotHash: next.snapshotHash, proof: proof.value, proofHash: proof.hash } } })
    return next
  })
}
