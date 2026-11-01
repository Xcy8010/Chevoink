import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { createAdminModel, getAdminModelManagement, updateAdminModel } from '../../api/lib/admin-credit-model.js'
import { archiveAdminModel, getAdminModelLifecyclePreview, restoreAdminModel } from '../../api/lib/admin-model-lifecycle.js'
import { assertAdmittedModelVersion, assertRunModelNotArchived, captureAdminModelVersion } from '../../api/lib/model-lifecycle.js'
import { initializePersistedLoopRun } from '../../api/lib/agent/run-service.js'
import { getModelTierRuntime } from '../../api/lib/credits.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { CreditModelTier } from '../../shared/contracts/model-tier.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

afterAll(async () => { await prisma.$disconnect() })
const input = { provider: 'fixture-provider', displayName: '生命周期合成模型', modelName: 'retained-original-model', baseUrl: 'https://fixture.example/v1', apiKey: 'isolated-offline-fixture-only', enabled: true, selectable: true, multiplier: 1.25,
  reasoningEfforts: ['low', 'high', 'max'] as Array<'low' | 'high' | 'max'>, defaultReasoningEffort: 'high' as const }
async function order() { return (await getAdminModelManagement('active')).models.filter(row => row.modelKind === 'text' && row.tier !== 'basic').map(row => row.id) }
async function catalogFixture(work: (scope: { adminId: string; created: string[]; role: string }) => Promise<void>) {
  const adminId = randomUUID(), created: string[] = [], role = `fixture:${randomUUID()}`
  await prisma.user.create({ data: { id: adminId, nickname: 'isolated-lifecycle-admin', role: 'admin', isSuperAdmin: true, passwordHash: 'unusable' } })
  try { await work({ adminId, created, role }) }
  finally {
    await prisma.aiModelSystemBinding.deleteMany({ where: { roleKey: role } })
    await prisma.aiModelConfigVersion.deleteMany({ where: { modelConfigId: { in: created } } })
    await prisma.aiModelConfig.deleteMany({ where: { id: { in: created } } })
    await prisma.adminAuditLog.deleteMany({ where: { adminId } })
    await prisma.user.delete({ where: { id: adminId } })
  }
}

describe.runIf(available)('recoverable model lifecycle on isolated PostgreSQL', () => {
  it('keeps the admitted active configuration and price after archive/restore/edit while new or recovered work requires selection', async () => fixture(async f => catalogFixture(async scope => {
    const source = await createAdminModel(scope.adminId, input, await order()); scope.created.push(source.id)
    const target = await createAdminModel(scope.adminId, { ...input, displayName: '同费率替代模型', modelName: 'replacement-model' }, await order()); scope.created.push(target.id)
    await prisma.aiModelSystemBinding.create({ data: { roleKey: scope.role, modelConfigId: source.id } })
    const runtime = await getModelTierRuntime(source.tier as CreditModelTier, f.userId, null, 'high')
    await prisma.$transaction(tx => assertAdmittedModelVersion(tx, runtime))
    const price = runtime.tokenPrice ?? { version: 'credits-v1-exact', modelTier: source.tier!, multiplierBps: runtime.multiplierBps }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', startedAt: new Date(), modelTier: source.tier!, modelConfigId: source.id, modelConfigRevision: runtime.modelConfigRevision, modelPriceSnapshot: price } })
    const view = await getAdminModelLifecyclePreview(scope.adminId, source.id)
    expect(view.impact.running).toBe(1)
    const candidate = view.candidates.find(row => row.id === target.id)!
    expect(candidate.eligible).toBe(true)
    const archived = await archiveAdminModel(scope.adminId, source.id, { expectedRevision: view.revision, previewHash: view.previewHash, reason: '合成目录整理', replacementId: target.id, replacementRevision: candidate.revision })
    expect((await prisma.aiModelSystemBinding.findUniqueOrThrow({ where: { roleKey: scope.role } })).modelConfigId).toBe(target.id)
    await expect(getModelTierRuntime(source.tier as CreditModelTier, f.userId, null, 'high')).rejects.toMatchObject({ code: 'MODEL_ARCHIVED' })
    await expect(assertRunModelNotArchived({ modelTier: source.tier!, modelConfigId: source.id })).rejects.toMatchObject({ code: 'MODEL_SELECTION_REQUIRED' })
    const retained = { userId: f.userId, runId: f.runId, modelConfigId: source.id, modelConfigRevision: runtime.modelConfigRevision, provider: runtime.provider, modelName: runtime.modelName }
    expect(await getModelTierRuntime(source.tier as CreditModelTier, f.userId, null, 'high', retained)).toMatchObject({ provider: input.provider, modelName: input.modelName })
    const restored = await restoreAdminModel(scope.adminId, source.id, { expectedRevision: archived.revision, reason: '合成恢复检查' })
    expect(await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ enabled: false, selectable: false, isDefault: false })
    await updateAdminModel(scope.adminId, source.id, { expectedRevision: restored.revision, provider: 'new-provider', modelName: 'new-edited-model', apiKey: 'different-offline-fixture-only', enabled: true, selectable: true })
    const oldRuntime = await getModelTierRuntime(source.tier as CreditModelTier, f.userId, null, 'high', retained)
    expect({ provider: oldRuntime.provider, modelName: oldRuntime.modelName, sameCredential: oldRuntime.apiKey === runtime.apiKey }).toEqual({ provider: input.provider, modelName: input.modelName, sameCredential: true })
    const savedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(savedRun.modelConfigId).toBe(source.id)
    expect(savedRun.modelConfigRevision).toBe(runtime.modelConfigRevision)
    expect(runtimeJson(savedRun.modelPriceSnapshot).hash).toBe(runtimeJson(price).hash)
    expect(savedRun.status).toBe('running')
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused' } })
    // A paused task cannot use the running-only version resolver to bypass fresh admission.
    await expect(getModelTierRuntime(source.tier as CreditModelTier, f.userId, null, 'high', retained)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
  })))

  it('blocks changed-fee replacement and performs no role transfer or task mutation', async () => catalogFixture(async scope => {
    const source = await createAdminModel(scope.adminId, input, await order()); scope.created.push(source.id)
    const target = await createAdminModel(scope.adminId, { ...input, multiplier: 2 }, await order()); scope.created.push(target.id)
    await prisma.aiModelSystemBinding.create({ data: { roleKey: scope.role, modelConfigId: source.id } })
    const view = await getAdminModelLifecyclePreview(scope.adminId, source.id)
    const candidate = view.candidates.find(row => row.id === target.id)!
    expect(candidate).toMatchObject({ eligible: false, reasons: ['生效费率或免费期限不同'] })
    await expect(archiveAdminModel(scope.adminId, source.id, { expectedRevision: view.revision, previewHash: view.previewHash, reason: '合成拒绝场景', replacementId: target.id, replacementRevision: candidate.revision })).rejects.toMatchObject({ code: 'MODEL_REPLACEMENT_INVALID' })
    expect((await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull()
    expect((await prisma.aiModelSystemBinding.findUniqueOrThrow({ where: { roleKey: scope.role } })).modelConfigId).toBe(source.id)
    expect(await prisma.adminAuditLog.count({ where: { adminId: scope.adminId, action: 'models.archive' } })).toBe(0)
  }))

  it('protects a newly initialized original tool role before bindings exist and never reclaims a transferred role on restore', async () => catalogFixture(async scope => {
    const roleKey = 'tool:web-fetch'
    const original = await prisma.aiModelConfig.findUnique({ where: { key: roleKey } })
    const previousBinding = await prisma.aiModelSystemBinding.findUnique({ where: { roleKey } })
    const toolInput = { ...input, modelKind: 'web_fetch' as const, provider: 'custom-fixture', webToolProtocol: 'deepseek' as const, selectable: false }
    const source = await createAdminModel(scope.adminId, toolInput, await order()); scope.created.push(source.id)
    const target = await createAdminModel(scope.adminId, { ...toolInput, displayName: '新安装同费率替代读取配置' }, await order()); scope.created.push(target.id)
    const sourceRow = await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: source.id } })
    try {
      // Simulate migration of an empty catalog, followed by normal initialization.
      if (original) await prisma.aiModelConfig.update({ where: { id: original.id }, data: { key: `fixture:${randomUUID()}` } })
      await prisma.aiModelConfig.update({ where: { id: source.id }, data: { key: roleKey } })
      await prisma.aiModelSystemBinding.deleteMany({ where: { roleKey } })
      const view = await getAdminModelLifecyclePreview(scope.adminId, source.id)
      expect(view.systemRoles).toContain(roleKey)
      await expect(archiveAdminModel(scope.adminId, source.id, { expectedRevision: view.revision, previewHash: view.previewHash, reason: '合成初始化拒绝' })).rejects.toMatchObject({ code: 'MODEL_REPLACEMENT_REQUIRED' })
      const candidate = view.candidates.find(row => row.id === target.id)!
      expect(candidate.eligible).toBe(true)
      const archived = await archiveAdminModel(scope.adminId, source.id, { expectedRevision: view.revision, previewHash: view.previewHash, reason: '合成初始化移交', replacementId: target.id, replacementRevision: candidate.revision })
      expect((await prisma.aiModelSystemBinding.findUniqueOrThrow({ where: { roleKey } })).modelConfigId).toBe(target.id)
      await restoreAdminModel(scope.adminId, source.id, { expectedRevision: archived.revision, reason: '合成恢复不回抢' })
      expect((await getAdminModelLifecyclePreview(scope.adminId, source.id)).systemRoles).not.toContain(roleKey)
      expect((await prisma.aiModelSystemBinding.findUniqueOrThrow({ where: { roleKey } })).modelConfigId).toBe(target.id)
    } finally {
      // Restore only the test's temporarily displaced isolated catalog identity.
      await prisma.aiModelSystemBinding.deleteMany({ where: { roleKey } })
      if (previousBinding) await prisma.aiModelSystemBinding.create({ data: previousBinding })
      await prisma.aiModelConfig.update({ where: { id: source.id }, data: { key: sourceRow.key } })
      if (original) await prisma.aiModelConfig.update({ where: { id: original.id }, data: { key: original.key } })
    }
  }))

  it('blocks a queued admission after config edit and preserves its original model, price and uninitialized state', async () => fixture(async f => catalogFixture(async scope => {
    const source = await createAdminModel(scope.adminId, input, await order()); scope.created.push(source.id)
    const runtime = await getModelTierRuntime(source.tier as CreditModelTier, f.userId, null, 'high')
    const price = runtime.tokenPrice ?? { version: 'credits-v1-exact', modelTier: source.tier!, multiplierBps: runtime.multiplierBps }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { modelTier: source.tier!, modelConfigId: source.id, modelConfigRevision: runtime.modelConfigRevision,
      modelPriceSnapshot: price, startRequest: { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt: '修改本章', mode: 'build' } } })
    const admitted = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    await updateAdminModel(scope.adminId, source.id, { expectedRevision: runtime.modelConfigRevision, provider: 'edited-provider', modelName: 'edited-model' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('No provider allowed for rejected queued bootstrap') }))
    await expect(initializePersistedLoopRun(f.userId, f.runId)).rejects.toMatchObject({ status: 409, code: 'MODEL_SELECTION_REQUIRED' })
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(admitted)
    expect(await prisma.agentExecutionState.findUnique({ where: { taskRootId: f.rootId } })).toBeNull()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })))

  it('captures the same immutable configuration version concurrently without overwriting it', async () => catalogFixture(async scope => {
    const source = await createAdminModel(scope.adminId, input, await order()); scope.created.push(source.id)
    const row = await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: source.id } })
    await Promise.all([1, 2].map(() => prisma.$transaction(tx => captureAdminModelVersion(tx, row))))
    expect(await prisma.aiModelConfigVersion.count({ where: { modelConfigId: row.id, revision: row.revision } })).toBe(1)
    await expect(prisma.$transaction(tx => captureAdminModelVersion(tx, { ...row, modelName: 'same-version-collision' }))).rejects.toMatchObject({ code: 'MODEL_VERSION_CONFLICT' })
    expect((await prisma.aiModelConfigVersion.findUniqueOrThrow({ where: { modelConfigId_revision: { modelConfigId: row.id, revision: row.revision } } })).modelName).toBe(input.modelName)
  }))
})
