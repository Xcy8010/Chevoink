import { z } from 'zod'
import { runtimeError, runtimeJsonHash, type RuntimeTx } from './runtime-common.js'

export const STALE_PERSONALIZATION_REQUEST = 'PERSONALIZATION_REQUEST_STALE'
const cancelledResult = z.object({ outcome: z.literal('cancelled'), result: z.object({
  code: z.literal(STALE_PERSONALIZATION_REQUEST), dispatched: z.literal(false),
}).strict() }).strict()

/** Only a verified, unsent personalization request can be replaced by a
 * fresh model turn. Sent, unknown and unrelated failed attempts keep the
 * existing reconciliation path. */
export async function assertUnsentPersonalizationRequest(tx: RuntimeTx, taskRootId: string, operationId: string) {
  const attempts = await tx.agentProviderAttempt.findMany({ where: { operationId }, take: 2 })
  const attempt = attempts[0]
  if (attempts.length !== 1 || attempt.status !== 'cancelled' || attempt.dispatchedAt ||
      !cancelledResult.safeParse(attempt.result).success || attempt.resultHash === null || runtimeJsonHash(attempt.result) !== attempt.resultHash ||
      !attempt.requestSnapshot || runtimeJsonHash(attempt.requestSnapshot) !== attempt.requestHash) {
    runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '缺少个性化请求未派发的回执。')
  }
  const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `provider.not_dispatched:${attempt.id}` } })
  const payload = { attemptId: attempt.id, requestHash: attempt.requestHash, code: STALE_PERSONALIZATION_REQUEST, resultHash: attempt.resultHash }
  if (!event || event.taskRootId !== taskRootId || event.operationId !== operationId || event.runId !== attempt.runId ||
      event.type !== 'provider.not_dispatched' || runtimeJsonHash(event.payload) !== runtimeJsonHash(payload)) {
    runtimeError('RUNTIME_RECEIPT_INVALID', '个性化请求缺少原未派发事件。')
  }
}
