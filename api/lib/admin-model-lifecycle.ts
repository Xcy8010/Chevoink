import { Prisma, type AiModelConfig } from '@prisma/client'
import { archiveAdminModelSchema, restoreAdminModelSchema, type AdminModelLifecyclePreview, type AdminModelLifecycleResult } from '../../shared/contracts/admin-model-lifecycle.js'
import { DataAccessError } from './prisma.js'
import { creditTransaction } from './credit-policy.js'
import { adminModelKind, captureAdminModelVersion, modelFeeIdentity, modelLifecyclePrice, systemModelRoles } from './model-lifecycle.js'
import { runtimeJson } from './agent/runtime-common.js'
import { clearToolModelRuntimeCache } from './tool-model-config.js'

type Tx = Prisma.TransactionClient
async function catalog(tx: Tx, adminId: string) {
  const actor = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, isSuperAdmin: true, bannedAt: true } })
  if (!actor || actor.role !== 'admin' || !actor.isSuperAdmin || actor.bannedAt) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '该操作仅限超级管理员。')
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('platform-model-catalog'))`
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('credit-rate-card-lifecycle'))`
}
async function platformModel(tx: Tx, id: string) {
  const row = await tx.aiModelConfig.findFirst({ where: { id, ownerUserId: null } })
  if (!row) throw new DataAccessError(404, 'MODEL_NOT_FOUND', '平台模型不存在。')
  return row
}
async function impact(tx: Tx, model: AiModelConfig): Promise<AdminModelLifecyclePreview['impact']> {
  const tier = model.tier ?? ''
  const runs = { OR: [{ modelConfigId: model.id }, { modelConfigId: null, modelTier: tier }] }
  const [queued, running, paused, historicalCalls, references] = await Promise.all([
    tx.agentRun.count({ where: { ...runs, status: 'queued' } }),
    tx.agentRun.count({ where: { ...runs, status: { in: ['running', 'awaiting_approval'] } } }),
    tx.agentRun.count({ where: { ...runs, status: 'paused' } }),
    tier ? tx.aiUsageLog.count({ where: { modelTier: tier } }) : Promise.resolve(0),
    tx.$queryRaw<Array<{ assignments: bigint; queuedRequests: bigint; goals: bigint; schedules: bigint; imports: bigint }>>`
      SELECT
        (SELECT count(*) FROM agent_model_assignments WHERE ${tier} <> '' AND jsonb_path_exists(assignments, '$.**.modelTier ? (@ == $tier)', jsonb_build_object('tier', CAST(${tier} AS text)))) AS assignments,
        (SELECT count(*) FROM agent_queued_requests WHERE status IN ('pending','held') AND ${tier} <> '' AND jsonb_path_exists(payload, '$.**.modelTier ? (@ == $tier)', jsonb_build_object('tier', CAST(${tier} AS text)))) AS "queuedRequests",
        (SELECT count(*) FROM agent_goals WHERE status NOT IN ('completed','cancelled') AND ${tier} <> '' AND jsonb_path_exists(execution_options, '$.**.modelTier ? (@ == $tier)', jsonb_build_object('tier', CAST(${tier} AS text)))) AS goals,
        (SELECT count(*) FROM agent_schedules WHERE status <> 'cancelled' AND (model_config_id = ${model.id} OR (model_config_id IS NULL AND ${model.tier === 'speed'}))) AS schedules,
        (SELECT count(*) FROM novel_import_jobs WHERE ${tier} <> '' AND ("modelSelection"->>'modelTier' = ${tier} OR "modelSelection"->>'modelConfigId' = ${model.id} OR (${model.tier === 'basic'} AND "modelSelection"->>'kind' = 'basic'))) AS imports
    `,
  ])
  const row = references[0]
  return { queued, running, paused, historicalCalls, assignments: Number(row?.assignments ?? 0), queuedRequests: Number(row?.queuedRequests ?? 0), goals: Number(row?.goals ?? 0), schedules: Number(row?.schedules ?? 0), imports: Number(row?.imports ?? 0) }
}
async function preview(tx: Tx, id: string): Promise<AdminModelLifecyclePreview> {
  const model = await platformModel(tx, id)
  const modelKind = adminModelKind(model.metadata)
  const [bindings, counts, rows] = await Promise.all([
    tx.aiModelSystemBinding.findMany({ orderBy: { roleKey: 'asc' } }),
    impact(tx, model), tx.aiModelConfig.findMany({ where: { ownerUserId: null, archivedAt: null, id: { not: model.id } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
  ])
  // Empty installations seed their catalog after migration. A missing binding
  // still belongs to its original role; an explicit transferred binding wins.
  const systemRoles = [...new Set([...bindings.filter(row => row.modelConfigId === model.id).map(row => row.roleKey), ...systemModelRoles.filter(role => {
    const binding = bindings.find(row => row.roleKey === role)
    return binding ? binding.modelConfigId === model.id
      : role === 'speed' || role === 'basic' ? model.tier === role : model.key === role
  })])].sort()
  const sourcePrice = await modelLifecyclePrice(tx, model)
  const fee = modelFeeIdentity(model, sourcePrice)
  const candidates: AdminModelLifecyclePreview['candidates'] = []
  for (const candidate of rows) {
    const kind = adminModelKind(candidate.metadata), reasons: string[] = []
    if (kind !== modelKind) reasons.push('模型类型不同')
    if (!candidate.enabled || candidate.modelName === 'unconfigured' || candidate.tier !== 'speed' && (!candidate.baseUrl || !candidate.apiKeyCiphertext)) reasons.push('服务未启用或配置不完整')
    if (model.isDefault && (!candidate.selectable || kind !== 'text' || !candidate.tier)) reasons.push('不能承担用户默认模型')
    if (!reasons.length) {
      try { if (fee !== modelFeeIdentity(candidate, await modelLifecyclePrice(tx, candidate))) reasons.push('生效费率或免费期限不同') }
      catch { reasons.push('替代模型费率无法核验') }
    }
    candidates.push({ id: candidate.id, displayName: candidate.displayName, revision: candidate.revision, modelKind: kind, eligible: reasons.length === 0, reasons })
  }
  const result = { id: model.id, displayName: model.displayName, revision: model.revision, archivedAt: model.archivedAt?.toISOString() ?? null,
    modelKind, isDefault: model.isDefault, systemRoles, impact: counts, historyAttribution: 'tier' as const, candidates }
  return { ...result, previewHash: runtimeJson(result).hash }
}
export async function getAdminModelLifecyclePreview(adminId: string, id: string): Promise<AdminModelLifecyclePreview> {
  return creditTransaction(async tx => { await catalog(tx, adminId); return preview(tx, id) })
}
export async function archiveAdminModel(adminId: string, id: string, raw: unknown): Promise<AdminModelLifecycleResult> {
  const parsed = archiveAdminModelSchema.safeParse(raw)
  if (!parsed.success) throw new DataAccessError(400, 'VALIDATION_ERROR', '归档参数格式不正确，请提供当前版本、影响预览及操作原因。')
  const input = parsed.data
  const result = await creditTransaction(async tx => {
    await catalog(tx, adminId)
    const model = await platformModel(tx, id)
    if (model.archivedAt || model.revision !== input.expectedRevision) throw new DataAccessError(409, 'MODEL_LIFECYCLE_CONFLICT', '模型状态或版本已变化，请刷新影响预览。')
    const view = await preview(tx, id)
    if (view.previewHash !== input.previewHash) throw new DataAccessError(409, 'MODEL_IMPACT_CHANGED', '引用或替代配置已变化，请重新核对影响。')
    const required = model.isDefault || view.systemRoles.length > 0
    const candidate = input.replacementId ? view.candidates.find(row => row.id === input.replacementId) : null
    if (required && !candidate) throw new DataAccessError(409, 'MODEL_REPLACEMENT_REQUIRED', '默认或系统用途必须先指定同类型、同生效费率的有效替代配置。')
    if (input.replacementId && (!candidate?.eligible || candidate.revision !== input.replacementRevision)) throw new DataAccessError(409, 'MODEL_REPLACEMENT_INVALID', candidate?.reasons.join('；') || '替代配置已变化或不可用。')
    await captureAdminModelVersion(tx, model)
    if (candidate) {
      const target = await platformModel(tx, candidate.id)
      await captureAdminModelVersion(tx, target)
      for (const roleKey of view.systemRoles) await tx.aiModelSystemBinding.upsert({ where: { roleKey },
        create: { roleKey, modelConfigId: target.id }, update: { modelConfigId: target.id, revision: { increment: 1 } } })
      if (model.isDefault) await tx.aiModelConfig.update({ where: { id: target.id }, data: { isDefault: true, revision: { increment: 1 } } })
    }
    const changed = await tx.aiModelConfig.updateMany({ where: { id, ownerUserId: null, archivedAt: null, revision: input.expectedRevision },
      data: { archivedAt: new Date(), archivedById: adminId, archiveReason: input.reason, enabled: false, selectable: false, isDefault: false, revision: { increment: 1 } } })
    if (changed.count !== 1) throw new DataAccessError(409, 'MODEL_LIFECYCLE_CONFLICT', '模型版本已变化。')
    await tx.adminAuditLog.create({ data: { adminId, action: 'models.archive', targetType: 'aiModelConfig', targetId: id,
      detail: { reason: input.reason, fromRevision: model.revision, revision: model.revision + 1, replacementId: candidate?.id ?? null, replacementRevision: candidate?.revision ?? null,
        systemRoles: view.systemRoles, defaultMoved: model.isDefault, impact: view.impact, historyAttribution: 'tier' } } })
    return { id, revision: model.revision + 1, archived: true }
  })
  clearToolModelRuntimeCache()
  return result
}
export async function restoreAdminModel(adminId: string, id: string, raw: unknown): Promise<AdminModelLifecycleResult> {
  const parsed = restoreAdminModelSchema.safeParse(raw)
  if (!parsed.success) throw new DataAccessError(400, 'VALIDATION_ERROR', '恢复参数格式不正确，请提供当前版本及操作原因。')
  const input = parsed.data
  const result = await creditTransaction(async tx => {
    await catalog(tx, adminId)
    const model = await platformModel(tx, id)
    if (!model.archivedAt || model.revision !== input.expectedRevision) throw new DataAccessError(409, 'MODEL_LIFECYCLE_CONFLICT', '模型状态或版本已变化。')
    await captureAdminModelVersion(tx, model)
    await tx.aiModelConfig.update({ where: { id }, data: { archivedAt: null, enabled: false, selectable: false, isDefault: false, revision: { increment: 1 } } })
    await tx.adminAuditLog.create({ data: { adminId, action: 'models.restore', targetType: 'aiModelConfig', targetId: id, detail: { reason: input.reason, fromRevision: model.revision, revision: model.revision + 1,
      enabled: false, selectable: false, isDefault: false, resumedTasks: 0 } } })
    return { id, revision: model.revision + 1, archived: false }
  })
  clearToolModelRuntimeCache()
  return result
}
