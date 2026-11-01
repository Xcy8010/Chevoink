import { Prisma, type AiModelConfig } from '@prisma/client'
import { DataAccessError, prisma } from './prisma.js'
import type { AdminModelKind } from '../../shared/contracts/admin-model-lifecycle.js'
import { effectiveModelMultiplier, readModelPromotion } from '../../shared/model-promotion.js'
import { tokenPriceSchema, type TokenPrice } from './billing/token-price.js'
import { webToolChargeMilli } from '../../shared/web-tool-pricing.js'
import { runtimeJson } from './agent/runtime-common.js'

type Db = Prisma.TransactionClient | typeof prisma
export function adminModelKind(metadata: unknown): AdminModelKind {
  const kind = metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'modelKind' in metadata ? metadata.modelKind : null
  return kind === 'vision' || kind === 'image_generation' || kind === 'web_search' || kind === 'web_fetch' ? kind : 'text'
}
export const systemModelRoles = ['speed', 'basic', 'tool:image-generation', 'tool:image-vision', 'tool:web-search', 'tool:web-fetch'] as const
export async function resolveSystemModelConfig(role: string, db: Db = prisma): Promise<AiModelConfig | null> {
  const binding = await db.aiModelSystemBinding.findUnique({ where: { roleKey: role }, include: { model: true } })
  const model = binding?.model ?? await db.aiModelConfig.findFirst({ where: { ownerUserId: null, ...(role === 'speed' || role === 'basic' ? { tier: role } : { key: role }) } })
  if (model?.archivedAt) throw new DataAccessError(409, 'MODEL_ARCHIVED', '原模型已归档，请明确重新选择；未切换模型或重新执行。')
  if (binding && model && !model.enabled) throw new DataAccessError(409, 'MODEL_SELECTION_REQUIRED', '系统用途绑定的模型已停用，未使用其他配置替代。')
  return model
}

/** Price identity is retained; equality checks compare effective charges, never rewrite a rate card. */
export async function modelLifecyclePrice(db: Db, model: Pick<AiModelConfig, 'tier' | 'multiplierBps' | 'metadata'>): Promise<TokenPrice | null> {
  if (adminModelKind(model.metadata) !== 'text' || !model.tier) return null
  const multiplierBps = effectiveModelMultiplier(model)
  if (multiplierBps === 0 || readModelPromotion(model.metadata)) return tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier: model.tier, multiplierBps })
  const card = await db.creditRateCard.findFirst({ where: { modelTier: model.tier, status: 'active' } })
  if (card) {
    const price = tokenPriceSchema.parse(card.price)
    if (price.version !== 'credits-v2-itemized' || price.rateCardId !== card.id || price.modelTier !== model.tier || runtimeJson(price).hash !== card.priceHash) throw new DataAccessError(409, 'MODEL_PRICE_UNVERIFIED', '现行费率无法核验，不能移交系统用途。')
    return price
  }
  if (await db.creditRateCardEvent.count({ where: { status: 'active', card: { modelTier: model.tier } } })) throw new DataAccessError(409, 'MODEL_PRICE_UNVERIFIED', '费率已迁移但当前费率不可用。')
  return tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier: model.tier, multiplierBps })
}
export function modelFeeIdentity(model: Pick<AiModelConfig, 'multiplierBps' | 'metadata'>, price: TokenPrice | null): string {
  const kind = adminModelKind(model.metadata)
  if (kind === 'image_generation') return runtimeJson({ tariff: 'image_call_6000_v1', amountMilli: 6000 }).hash
  if (kind === 'vision') return runtimeJson({ tariff: 'platform_vision_v1', amountMilli: 0 }).hash
  if (kind === 'web_search' || kind === 'web_fetch') return runtimeJson({ tariff: 'web_tool_v1', amountMilli: webToolChargeMilli(effectiveModelMultiplier(model)) }).hash
  const fee = price?.version === 'credits-v2-itemized' ? { version: price.version, rates: price.rates, v1CeilingBps: price.v1CeilingBps ?? null }
    : { version: price?.version ?? 'fixed-tool', multiplierBps: effectiveModelMultiplier(model) }
  return runtimeJson({ fee, promotion: readModelPromotion(model.metadata) }).hash
}

/** Immutable and encrypted server-only copy. Identical replay is safe; collisions fail closed. */
export async function captureAdminModelVersion(tx: Prisma.TransactionClient, model: AiModelConfig): Promise<void> {
  if (model.ownerUserId !== null) return
  const data = { modelConfigId: model.id, revision: model.revision, tier: model.tier, provider: model.provider, modelName: model.modelName,
    baseUrl: model.baseUrl, apiKeyCiphertext: model.apiKeyCiphertext, multiplierBps: model.multiplierBps,
    metadata: model.metadata ?? Prisma.JsonNull }
  await tx.aiModelConfigVersion.createMany({ data: [data], skipDuplicates: true })
  const existing = await tx.aiModelConfigVersion.findUniqueOrThrow({ where: { modelConfigId_revision: { modelConfigId: model.id, revision: model.revision } } })
  const { createdAt: _created, ...saved } = existing
  // Compare opaque ciphertext in memory only; no credential or hash is logged.
  if (runtimeJson({ ...saved, metadata: saved.metadata ?? null }).hash !== runtimeJson({ ...data, metadata: model.metadata ?? null }).hash) throw new DataAccessError(409, 'MODEL_VERSION_CONFLICT', '配置版本已绑定不同内容，原任务身份保留。')

}

export type RetainedModelContext = { userId: string; runId: string; modelConfigId?: string | null; modelConfigRevision?: number | null; provider?: string; modelName?: string | null }
/** Only a verified active run may retain an archived version; no user-facing allowArchived switch. */
export async function resolveRetainedModelConfig(tier: string, context: RetainedModelContext): Promise<AiModelConfig | null> {
  const run = await prisma.agentRun.findFirst({ where: { id: context.runId, userId: context.userId, status: 'running' } })
  if (!run?.startedAt) return null
  const model = await prisma.aiModelConfig.findFirst({ where: { ownerUserId: null, ...(context.modelConfigId ? { id: context.modelConfigId } : { tier }) } })
  if (!model || model.tier !== tier) return null
  const boundId = run.modelConfigId ?? context.modelConfigId
  if (boundId && boundId !== model.id) return null
  if (!boundId && (!context.provider || context.provider !== model.provider || context.modelName !== model.modelName)) return null
  if (model.archivedAt && run.startedAt > model.archivedAt) return null
  const revision = context.modelConfigRevision ?? run.modelConfigRevision
  if (revision) {
    const version = await prisma.aiModelConfigVersion.findUnique({ where: { modelConfigId_revision: { modelConfigId: model.id, revision } } })
    if (version) return { ...model, ...version, id: model.id, enabled: true, selectable: true }
    if (revision !== model.revision) throw new DataAccessError(409, 'MODEL_VERSION_REQUIRED', '原模型版本缺失，未替换配置或继续付费。')
  }
  // Old snapshots must still match their public route at the existing cursor boundary.
  return { ...model, enabled: true, selectable: true }
}

export async function assertAdmittedModelVersion(tx: Prisma.TransactionClient, input: { modelConfigId?: string; modelConfigRevision?: number }): Promise<void> {
  if (!input.modelConfigId) return
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtext('platform-model-catalog'))`
  const row = await tx.aiModelConfig.findUnique({ where: { id: input.modelConfigId } })
  if (!row || row.archivedAt || !row.enabled || row.revision !== input.modelConfigRevision) throw new DataAccessError(409, 'MODEL_SELECTION_REQUIRED', '模型目录已变化，请重新选择；未启动或替换模型。')
  await captureAdminModelVersion(tx, row)
}


/** Fresh default/system work uses the explicit binding. Queued or resumed callers must keep their admitted selection. */
export async function freshSystemModelTier(role: 'speed' | 'basic'): Promise<string> {
  const original = await prisma.aiModelConfig.findFirst({ where: { ownerUserId: null, tier: role } })
  if (!original?.archivedAt && !original?.archivedById) return role
  const target = await resolveSystemModelConfig(role)
  if (!target?.tier || !target.enabled) throw new DataAccessError(409, 'MODEL_SELECTION_REQUIRED', '系统用途没有可用的替代配置。')
  return target.tier
}
export async function assertRunModelNotArchived(run: { modelTier: string; modelConfigId?: string | null }): Promise<void> {
  if (run.modelTier === 'custom') return
  const row = await prisma.aiModelConfig.findFirst({ where: { ownerUserId: null, ...(run.modelConfigId ? { id: run.modelConfigId } : { tier: run.modelTier }) } })
  if (row?.archivedAt) throw new DataAccessError(409, 'MODEL_SELECTION_REQUIRED', '原模型已归档。排队、暂停或恢复的任务须由作者明确重新选择；未切换模型、恢复或重算旧账。')
}

/** Unstarted admitted work cannot silently follow an edited platform config. */
export async function assertQueuedModelVersion(run: { modelTier: string; modelConfigId?: string | null; modelConfigRevision?: number | null }, db: Db = prisma): Promise<void> {
  if (!run.modelConfigId && !run.modelConfigRevision) return
  const row = run.modelConfigId ? await db.aiModelConfig.findUnique({ where: { id: run.modelConfigId } }) : null
  if (!row || row.ownerUserId !== null || row.tier !== run.modelTier || !row.enabled || row.archivedAt || row.revision !== run.modelConfigRevision) {
    throw new DataAccessError(409, 'MODEL_SELECTION_REQUIRED', '排队期间原模型配置已变化，请在新任务或配置变更入口明确重新选择；未替换配置或启动请求。')
  }
}
