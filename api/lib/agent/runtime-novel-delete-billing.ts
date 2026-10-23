import { runtimeError, type RuntimeTx } from './runtime-common.js'
import { readVerifiedNovelDeletion } from './runtime-novel-delete-read.js'

/** Historical ownership only. Money and refunds remain in the original live
 * ledger; this archive never supplies a frozen net total or dispatch permit. */
export async function readDeletedTaskCreditScope(tx: RuntimeTx, userId: string, runId: string) {
  const proof = await readVerifiedNovelDeletion(tx, userId, runId)
  if (!proof) return null
  const { run } = proof
  const lineage = proof.rows.filter(row => row.kind === 'run' && row.userId === userId && row.novelId === run.novelId && row.sessionId === run.sessionId
    && (row.id === runId || run.taskKey !== null && row.taskKey === run.taskKey))
  const runIds = lineage.map(row => row.id)
  const usage = proof.rows.filter(row => row.kind === 'usage' && row.userId === userId && row.agentRunId !== null && runIds.includes(row.agentRunId))
  // Do not infer ownership from a now-orphaned agentRunId string. The original
  // row and exact recorded binding must still agree with the authenticated TX.
  for (const row of usage) {
    if (row.kind !== 'usage') continue
    const log = await tx.aiUsageLog.findUnique({ where: { id: row.id } })
    if (!log || log.userId !== row.userId || log.agentRunId !== row.agentRunId
      || log.novelId !== null || log.chapterId !== null) return runtimeError('RUNTIME_RECEIPT_INVALID', '删除后的原用量身份或关系保留证据不一致。')
  }
  return { run, runIds }
}
