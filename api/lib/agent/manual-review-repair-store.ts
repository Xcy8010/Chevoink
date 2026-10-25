import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import type { LegacyAssessmentInput } from './assessment-response-lifecycle.js'
import type { ToolContext } from './tools/types.js'
import { tokenPriceSchema } from '../billing/token-price.js'
import { priceTokenEvidence } from '../billing/reservation-policy.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const repairHash = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value ?? null))).hash
export const repairEventId = (operationId: string, stage: string) => `mr${createHash('sha256').update(`${operationId}:${stage}`).digest('hex').slice(0, 60)}`
export function refuseManualRepair(message: string): never { throw new DataAccessError(409, 'MANUAL_REVIEW_REPAIR_REFUSED', message) }

/** The database primary key reserves the semantic operation. Caller holds the
 * novel/run lock; event sequence allocation shares that same transaction. */
export async function appendManualRepairEvent(tx: Prisma.TransactionClient, runId: string, operationId: string, stage: string, value: unknown) {
  const id = repairEventId(operationId, stage), prior = await tx.agentRunEvent.findUnique({ where: { id } })
  if (prior) {
    if (prior.runId !== runId || prior.type !== `review.manual_repair.${stage}` || repairHash(prior.payload) !== repairHash({ value, hash: repairHash(value) })) {
      refuseManualRepair('修复操作的原持久化回执不能替换。')
    }
    return prior
  }
  const last = await tx.agentRunEvent.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return tx.agentRunEvent.create({ data: { id, runId, seq: (last?.seq ?? 0) + 1, type: `review.manual_repair.${stage}`,
    payload: runtimeJson({ value, hash: repairHash(value) }).value } })
}

export async function readManualRepairEvent(tx: Prisma.TransactionClient, runId: string, operationId: string, stage: string) {
  const row = await tx.agentRunEvent.findUnique({ where: { id: repairEventId(operationId, stage) } })
  if (!row) return null
  const payload = object(row.payload)
  if (row.runId !== runId || row.type !== `review.manual_repair.${stage}` || payload.hash !== repairHash(payload.value)) refuseManualRepair('修复操作证据损坏。')
  return { row, value: object(payload.value) }
}

/** Replayed by the ordinary assessment reader, including terminal/commit
 * consumers. A model-supplied manifest is never its own grant certificate. */
export async function assertManualRepairLineage(tx: Prisma.TransactionClient, ctx: Pick<ToolContext, 'userId' | 'novelId' | 'runId' | 'callId'>, input: LegacyAssessmentInput) {
  const manual = input.continuityManifest?.manualRepair
  if (!manual) return
  const grant = await readManualRepairEvent(tx, ctx.runId, manual.operationId, 'authorized')
  const dispatch = await readManualRepairEvent(tx, ctx.runId, manual.operationId, 'dispatch')
  if (!grant || !dispatch || grant.row.seq >= dispatch.row.seq || dispatch.row.createdAt < grant.row.createdAt) refuseManualRepair('本次修复缺少唯一作者授权与派发回执。')
  const frozen = object(grant.value.frozen), subject = object(frozen.subject)
  if (grant.value.intent !== 'repair_failed_review_once' || grant.value.actorUserId !== ctx.userId
    || frozen.kind !== 'manual_review_repair' || frozen.operationId !== manual.operationId || frozen.maxProviderDispatches !== 1
    || subject.userId !== ctx.userId || subject.novelId !== ctx.novelId || subject.runId !== ctx.runId || ctx.callId !== manual.operationId
    || frozen.taskId !== manual.originalTaskId || frozen.failedAssessmentKey !== manual.failedAssessmentKey
    || repairHash(frozen.input) !== repairHash(input) || dispatch.value.frozenHash !== repairHash(frozen)
    || typeof dispatch.value.usageId !== 'string') refuseManualRepair('修复授权与原任务、冻结输入或请求归属不一致。')
  const lifecycle = await import('./assessment-response-lifecycle.js')
  const { readOriginalTaskRequest, originalTaskRunIds } = await import('./original-request.js')
  const task = await readOriginalTaskRequest(tx, ctx), runIds = await originalTaskRunIds(tx, ctx, task)
  if (task.taskId !== manual.originalTaskId || !runIds.includes(String(object(frozen.source).runId))) refuseManualRepair('修复授权不属于原作者任务谱系。')
  const old = lifecycle.legacyAssessmentInputSchema.safeParse(frozen.originalInput), source = object(frozen.source)
  if (!old.success || old.data.continuityManifest?.manualRepair || typeof source.runId !== 'string' || typeof source.callId !== 'string'
    || lifecycle.legacyContinuityAssessmentKey({ runId: source.runId, callId: source.callId }, old.data) !== manual.failedAssessmentKey) refuseManualRepair('原失败检查身份无法认证。')
  if (repairHash({ bodies: old.data.bodies, candidate: old.data.terminalCandidate, chapterId: old.data.chapterId, revision: old.data.revision,
    targetType: old.data.targetType, targetId: old.data.targetId }) !== repairHash({ bodies: input.bodies, candidate: input.terminalCandidate,
    chapterId: input.chapterId, revision: input.revision, targetType: input.targetType, targetId: input.targetId })) refuseManualRepair('修复材料与原失败检查的冻结身份不一致。')
  const original = await lifecycle.readLegacyContinuityAssessment(tx, { ...ctx, runId: source.runId, callId: source.callId } as ToolContext, old.data)
  if (original.inspected.complete || !original.billingKnown || !original.providerComplete || !original.recoveryReady || !original.slotUsed
    || repairHash(object(frozen.originalAudit)) !== repairHash(lifecycle.bindLegacyContinuityAssessment(original.inspected, { ...ctx, runId: source.runId, callId: source.callId } as ToolContext, old.data).audit)) {
    refuseManualRepair('原失败完整检查或费用证据已变化。')
  }
  const frames = await tx.agentArtifact.findMany({ where: { runId: source.runId, artifactType: 'continuityReview',
    metadata: { path: ['assessmentKey'], equals: manual.failedAssessmentKey } } })
  const raw = ['first', 'reassessment'].map(stage => frames.filter(row => object(row.metadata).stage === stage
    && typeof object(object(row.metadata).response).content === 'string'))
  if (raw.some(rows => rows.length !== 1)) refuseManualRepair('原两份完整响应不唯一。')
  const raws = raw.map(rows => JSON.parse(String(object(object(rows[0].metadata).response).content)) as unknown)
  if (raws.some(value => typeof value !== 'string') || repairHash(raws.map(value => createHash('sha256').update(String(value)).digest('hex'))) !== repairHash(manual.originalRawHashes)
    || repairHash(lifecycle.continuityReassessmentCandidates(String(raws[0]))) !== repairHash(manual.originalFindings)
    || repairHash(raws) !== repairHash(frozen.originalRawResponses)) refuseManualRepair('原意见或完整原响应与本次修复授权不一致。')
  const usage = await tx.aiUsageLog.findFirst({ where: { id: dispatch.value.usageId, userId: ctx.userId, novelId: ctx.novelId,
    agentRunId: ctx.runId, chapterId: input.chapterId, targetType: input.targetType, targetId: input.targetId, action: 'agent3ContinuityCritic' } })
  if (!usage || repairHash(usage.billingSnapshot) !== repairHash(frozen.price) || usage.modelName !== object(frozen.model).modelName
    || usage.modelTier !== object(frozen.model).tier || usage.providerName !== object(frozen.model).provider
    || usage.multiplierBps !== object(frozen.model).multiplierBps || usage.createdAt < grant.row.createdAt) refuseManualRepair('修复请求账目未绑定原模型与冻结价格。')
  const price = tokenPriceSchema.parse(frozen.price)
  if (usage.usageSource !== 'reported' || !['settled', 'exempt'].includes(usage.billingStatus ?? '') || usage.reservedCreditMilli !== 0
    || usage.requestTokens === null || usage.responseTokens === null || usage.requestTokens < 0 || usage.responseTokens <= 0
    || usage.requestTokens > Number(frozen.inputTokenCeiling) || usage.responseTokens > 16384) refuseManualRepair('修复实际用量与结算尚未核实。')
  const charge = priceTokenEvidence(price, usage.requestTokens, usage.responseTokens, usage.promptCacheHitTokens)
  if (charge > Number(frozen.maxCreditMilli) || usage.creditChargeMilli !== charge) refuseManualRepair('修复实际费用与冻结上限不一致。')
  const ledger = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `usage:${usage.id}` } })
  if (charge !== 0 || ledger) {
    if (!ledger || ledger.userId !== ctx.userId || ledger.kind !== 'usage' || ledger.sourceType !== 'model_tokens'
      || ledger.referenceId !== usage.targetId || ledger.deltaMilli !== -charge || ledger.requestTokens !== usage.requestTokens
      || ledger.responseTokens !== usage.responseTokens) refuseManualRepair('修复实际扣费回执不一致。')
  } else if (price.multiplierBps !== 0) refuseManualRepair('修复费用没有可核对的结算回执。')
  const baseline = Array.isArray(frozen.baselineUsage) ? frozen.baselineUsage.map(object) : []
  const historical = await tx.aiUsageLog.findMany({ where: { id: { in: baseline.map(row => String(row.id)) }, userId: ctx.userId,
    novelId: ctx.novelId }, orderBy: { id: 'asc' } })
  if (!baseline.length || repairHash(historical.map(row => ({ id: row.id, hash: repairHash(row) }))) !== repairHash(baseline)) {
    refuseManualRepair('原费用或未知结果记录已变化，未重写历史账目。')
  }
}
