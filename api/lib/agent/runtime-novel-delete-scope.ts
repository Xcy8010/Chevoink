import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import type { RunLeaseToken } from './runtime-lease.js'
import type { NovelDeleteArchiveRow } from './runtime-novel-delete-contract.js'
import type { AiUsageLog } from '@prisma/client'
import { fallbackUsageEvidenceSchema } from '../billing/reservation-policy.js'
import { tokenPriceSchema } from '../billing/token-price.js'

const blocked = (detail: string): never => runtimeError('RUNTIME_DELETE_RECONCILIATION_REQUIRED', `作品尚未删除：${detail}。原数据及费用证据保留。`)

/** Existing prepareTextUsage -> markUnobservedUsage(false) evidence. This is
 * not a zero-price inference from failure/HTTP status or missing usage. */
export function isKnownUndispatchedDeletionUsage(log: Pick<AiUsageLog, 'providerType' | 'modelTier' | 'multiplierBps' | 'billingStatus' | 'usageSource'
  | 'reservedCreditMilli' | 'reservationExpiresAt' | 'creditChargeMilli' | 'requestTokens' | 'responseTokens' | 'promptCacheHitTokens'
  | 'promptCacheMissTokens' | 'durationMs' | 'billingSnapshot' | 'billingEvidence'>) {
  if (log.providerType !== 'text' || log.billingStatus !== 'not_dispatched' || log.usageSource !== 'unknown' || log.durationMs !== 0
    || log.reservedCreditMilli !== 0 || log.reservationExpiresAt !== null || log.creditChargeMilli !== 0 || log.requestTokens !== null
    || log.responseTokens !== null || log.promptCacheHitTokens !== null || log.promptCacheMissTokens !== null) return false
  const evidence = fallbackUsageEvidenceSchema.safeParse(log.billingEvidence), price = tokenPriceSchema.safeParse(log.billingSnapshot)
  const byok = log.billingSnapshot && typeof log.billingSnapshot === 'object' && !Array.isArray(log.billingSnapshot)
    && Object.keys(log.billingSnapshot).length === 1 && log.billingSnapshot.version === 'byok-exempt' && log.modelTier === 'custom'
  return Boolean(evidence.success && !evidence.data.responseObserved && evidence.data.outputEstimate === 0
    && (byok || price.success && price.data.modelTier === log.modelTier && price.data.multiplierBps === log.multiplierBps))
}

/** Called under the novel and owned lease locks, in the actual deletion TX.
 * This first implementation never cancels another task or erases grants/goals
 * to make a foreign-key constraint pass. Unsupported accounting stays explicit. */
export async function collectNovelDeletionScope(tx: RuntimeTx, token: RunLeaseToken, novelId: string, operationId: string) {
  const chapters = await tx.chapter.findMany({ where: { novelId }, select: { id: true }, orderBy: { id: 'asc' } })
  const runs = await tx.agentRun.findMany({ where: { novelId }, orderBy: { id: 'asc' } })
  const runIds = runs.map(run => run.id), rootIds = [...new Set(runs.flatMap(run => run.taskRootId ? [run.taskRootId] : []))]
  if (!runs.some(run => run.id === token.runId && run.taskRootId === token.taskRootId)
    || runs.some(run => run.userId !== token.userId)) blocked('任务归属不完整')
  const roots = await tx.agentTaskRoot.findMany({ where: { id: { in: rootIds } } })
  if (roots.length !== rootIds.length || roots.some(root => root.userId !== token.userId || root.novelId !== novelId
    || runs.some(run => run.taskRootId === root.id && run.sessionId !== root.sessionId))) blocked('历史任务根的原归属不一致')
  if (runs.some(run => run.id !== token.runId && ['queued', 'running', 'awaiting_approval'].includes(run.status))) blocked('仍有其他活动任务')
  if (await tx.agentQueuedRequest.count({ where: { session: { novelId }, status: { notIn: ['dispatched', 'cancelled'] } } })) blocked('仍有已保存的作者排队请求')
  if (await tx.agentRunLease.count({ where: { runId: { in: runIds, not: token.runId }, enabled: true, ownerId: { not: null } } })) blocked('其他执行者尚未释放所有权')
  if (await tx.agentChildExecutionGrant.count({ where: { OR: [{ admissionRunId: { in: runIds } },
    { currentParentRunId: { in: runIds } }, { childRunId: { in: runIds } }] } })) blocked('子任务授权历史仍引用本作品，尚不支持在保留该历史时删除')
  // Goal fixed-fee refunds still require their original live goal binding. Do
  // not cascade even a completed goal until its historical refund reader exists.
  if (await tx.agentGoal.count({ where: { novelId } })) blocked('目标任务的原账务绑定仍需保留')
  if (await tx.agentSchedule.count({ where: { novelId, status: 'active' } })
    || await tx.agentSubtaskRun.count({ where: { novelId, status: { notIn: ['completed', 'succeeded', 'failed', 'cancelled'] } } })
    || await tx.memoryExtractionJob.count({ where: { novelId, status: { in: ['pending', 'processing'] } } })
    || await tx.novelImportJob.count({ where: { novelId, status: { notIn: ['completed', 'cancelled', 'expired', 'failed'] } } })
    || await tx.styleLearningJob.count({ where: { profile: { novelId }, status: { in: ['queued', 'processing', 'analyzing', 'interrupted'] } } })
    || await tx.changeSet.count({ where: { novelId, status: 'applying' } })) blocked('后台工作尚未结束')
  if (await tx.agentOperation.count({ where: { taskRootId: { in: rootIds }, id: { not: operationId },
    status: { in: ['prepared', 'dispatched', 'unknown'] } } })) blocked('存在尚待恢复或核对的操作')
  const attempts = await tx.agentProviderAttempt.findMany({ where: { OR: [{ runId: { in: runIds } }, { operation: { taskRootId: { in: rootIds } } }] }, include: { usageReceipt: true } })
  for (const attempt of attempts) {
    // Fixed image accounting verifies the original novel FK. Detaching it
    // without a historical reader would turn a known fee into an unknown one.
    if (attempt.usageReceipt?.settlementStatus === 'fixed_unit') blocked('封面固定费用的原归属仍需保留')
    if (['prepared', 'dispatched', 'unknown'].includes(attempt.status)) blocked('供应商请求结果尚未核实')
    if (attempt.dispatchedAt && (!attempt.resultHash || attempt.result === null || runtimeJson(attempt.result).hash !== attempt.resultHash
      || !attempt.usageReceipt || !['settled', 'exempt'].includes(attempt.usageReceipt.settlementStatus))) blocked('供应商用量或结算尚未核实')
  }
  const web = await tx.webToolCall.findMany({ where: { runId: { in: runIds } }, orderBy: { id: 'asc' } })
  if (web.some(call => !['completed', 'failed'].includes(call.status) || !['search', 'fetch'].includes(call.kind)
    || call.status === 'completed' && call.outcome === null)) blocked('联网调用结果尚未核实')
  const usage = await tx.aiUsageLog.findMany({ where: { OR: [{ novelId }, { chapterId: { in: chapters.map(chapter => chapter.id) } }, { agentRunId: { in: runIds } }] }, orderBy: { id: 'asc' } })
  for (const log of usage) {
    if (log.agentRunId && runIds.includes(log.agentRunId) && log.novelId !== null && log.novelId !== novelId) blocked('用量记录的原作品归属不一致')
    if (log.providerType === 'image') blocked('图片费用的原归属仍需保留')
    if (log.reservedCreditMilli !== 0 || log.reservationExpiresAt || ['reserved', 'pending', 'unknown'].includes(log.billingStatus ?? '')) blocked('仍有预留或待核对费用')
    const snapshot = log.billingSnapshot && typeof log.billingSnapshot === 'object' && !Array.isArray(log.billingSnapshot) ? log.billingSnapshot : null
    if (snapshot?.version === 'byok-exempt' && log.billingStatus === 'observed' && log.creditChargeMilli === 0) continue
    const debit = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `usage:${log.id}` } })
    if (isKnownUndispatchedDeletionUsage(log) && (!debit || debit.userId === log.userId && debit.kind === 'usage' && debit.deltaMilli === 0)) continue
    if (!debit || debit.userId !== log.userId || debit.kind !== 'usage' || debit.deltaMilli !== -log.creditChargeMilli) blocked('原模型账单未完整核实')
  }
  const rows: NovelDeleteArchiveRow[] = []
  for (const run of runs) {
    const spec = run.taskSpec === null ? null : taskSpecSchema.safeParse(run.taskSpec)
    if (spec && (!spec.success || spec.data.scope.novelId !== novelId)) blocked('历史任务合同不一致')
    const latest = await tx.agentRunEvent.findFirst({ where: { runId: run.id }, orderBy: { seq: 'desc' }, select: { seq: true } })
    if ((latest?.seq ?? 0) > 2_147_483_647 - (run.id === token.runId ? 4 : 1)) blocked('终态事件序号容量不足')
    rows.push({ kind: 'run', id: run.id, userId: run.userId, novelId, sessionId: run.sessionId, taskRootId: run.taskRootId,
      taskKey: run.taskRootId ?? (spec?.success ? spec.data.id : null), taskSpecHash: runtimeJson({ spec: run.taskSpec }).hash,
      status: run.status, lastSequence: latest?.seq ?? 0 })
  }
  for (const log of usage) rows.push({ kind: 'usage', id: log.id, userId: log.userId, novelId: log.novelId, chapterId: log.chapterId,
    agentRunId: log.agentRunId, providerType: log.providerType, providerMode: log.providerMode, modelName: log.modelName, action: log.action,
    targetType: log.targetType, targetId: log.targetId, creditChargeMilli: log.creditChargeMilli, requestTokens: log.requestTokens, responseTokens: log.responseTokens,
    promptCacheHitTokens: log.promptCacheHitTokens, promptCacheMissTokens: log.promptCacheMissTokens, multiplierBps: log.multiplierBps,
    billingSnapshotHash: runtimeJson({ snapshot: log.billingSnapshot }).hash, billingEvidenceHash: runtimeJson({ evidence: log.billingEvidence }).hash, createdAt: log.createdAt.toISOString() })
  for (const call of web) rows.push({ kind: 'web', id: call.id, runId: call.runId, requestHash: call.requestHash, toolKind: call.kind as 'search' | 'fetch',
    amountMilli: call.amountMilli, multiplierBps: call.multiplierBps, status: call.status, outcomeHash: runtimeJson({ outcome: call.outcome }).hash,
    createdAt: call.createdAt.toISOString(), updatedAt: call.updatedAt.toISOString() })
  return { chapters, runs, rows }
}
