import { beforeEach, expect, it, vi } from 'vitest'
import type { AiModelConfig, Prisma } from '@prisma/client'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { archiveAdminModel, getAdminModelLifecyclePreview, restoreAdminModel } from '../../api/lib/admin-model-lifecycle.js'
import { captureAdminModelVersion, modelFeeIdentity, resolveRetainedModelConfig } from '../../api/lib/model-lifecycle.js'

const mocks = vi.hoisted(() => ({ models: [] as Array<Record<string, unknown>>, versions: new Map<string, Record<string, unknown>>(), bindings: [] as Array<{ roleKey: string; modelConfigId: string; revision: number }>, run: null as Record<string, unknown> | null, audits: [] as unknown[] }))
function match(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('not' in value) return row[key] !== value.not
      return true
    }
    return row[key] === value
  })
}
const db = {
  user: { findUnique: vi.fn(async () => ({ role: 'admin', isSuperAdmin: true, bannedAt: null })) },
  aiModelConfig: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => mocks.models.find(row => match(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => mocks.models.filter(row => match(row, where))),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => mocks.models.find(row => row.id === where.id) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const row = mocks.models.find(row => row.id === where.id)!; Object.assign(row, { ...data, revision: Number(row.revision) + 1 }); return row }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { const rows = mocks.models.filter(row => match(row, where)); for (const row of rows) Object.assign(row, { ...data, revision: Number(row.revision) + 1 }); return { count: rows.length } }),
  },
  aiModelConfigVersion: {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { for (const row of data) { const key = `${row.modelConfigId}:${row.revision}`; if (!mocks.versions.has(key)) mocks.versions.set(key, { ...row, metadata: row.metadata, createdAt: new Date() }) } return { count: data.length } }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { modelConfigId_revision: { modelConfigId: string; revision: number } } }) => { const key = where.modelConfigId_revision; return mocks.versions.get(`${key.modelConfigId}:${key.revision}`)! }),
    findUnique: vi.fn(async ({ where }: { where: { modelConfigId_revision: { modelConfigId: string; revision: number } } }) => { const key = where.modelConfigId_revision; return mocks.versions.get(`${key.modelConfigId}:${key.revision}`) ?? null }),
  },
  aiModelSystemBinding: {
    findMany: vi.fn(async () => mocks.bindings),
    upsert: vi.fn(async ({ where, create, update }: { where: { roleKey: string }; create: { roleKey: string; modelConfigId: string }; update: { modelConfigId: string } }) => { const row = mocks.bindings.find(row => row.roleKey === where.roleKey); if (row) { row.modelConfigId = update.modelConfigId; row.revision++; return row }; const added = { ...create, revision: 1 }; mocks.bindings.push(added); return added }),
    updateMany: vi.fn(async ({ where, data }: { where: { modelConfigId: string }; data: { modelConfigId: string } }) => { for (const row of mocks.bindings) if (row.modelConfigId === where.modelConfigId) { row.modelConfigId = data.modelConfigId; row.revision++ } return { count: 1 } }),
  },
  agentRun: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => mocks.run) },
  aiUsageLog: { count: vi.fn(async () => 12) },
  creditRateCard: { findFirst: vi.fn(async () => null) }, creditRateCardEvent: { count: vi.fn(async () => 0) },
  adminAuditLog: { create: vi.fn(async ({ data }: { data: unknown }) => { mocks.audits.push(data); return data }) },
  $queryRaw: vi.fn(async () => []),
}
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: new Proxy({}, { get: (_target, key) => db[key as keyof typeof db] }) }))
vi.mock('../../api/lib/credit-policy.js', () => ({ creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work(db) }))
function model(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, ownerUserId: null, key: id, tier: id === 'source' ? 'speed' : 'builtin_0123456789abcdef', provider: 'fixture-provider', displayName: id, modelName: `model-${id}`, baseUrl: 'https://fixture.example/v1', apiKeyCiphertext: 'encrypted-offline-only', multiplierBps: 10000, enabled: true, selectable: true, isDefault: false, sortOrder: 0, revision: 1, archivedAt: null, archivedById: null, archiveReason: null, metadata: { marker: 'retained' }, createdAt: new Date(), updatedAt: new Date(), ...patch }
}
beforeEach(() => { vi.clearAllMocks(); mocks.models = [model('source'), model('replacement')]; mocks.versions.clear(); mocks.bindings = []; mocks.run = null; mocks.audits = [] })

it('archives with same-type/same-fee required-role replacement and preserves encrypted version/history identity', async () => {
  mocks.models[0].isDefault = true
  mocks.bindings = [{ roleKey: 'speed', modelConfigId: 'source', revision: 1 }]
  const view = await getAdminModelLifecyclePreview('fixture-admin', 'source')
  expect(view.candidates[0]).toMatchObject({ id: 'replacement', eligible: true })
  expect(JSON.stringify(view)).not.toContain('encrypted-offline-only')
  await archiveAdminModel('fixture-admin', 'source', { expectedRevision: 1, previewHash: view.previewHash, reason: '目录整理', replacementId: 'replacement', replacementRevision: 1 })
  expect(mocks.models[0]).toMatchObject({ id: 'source', tier: 'speed', enabled: false, selectable: false, isDefault: false, revision: 2, modelName: 'model-source' })
  expect(mocks.models[0].archivedAt).toBeInstanceOf(Date)
  expect(mocks.models[1]).toMatchObject({ id: 'replacement', isDefault: true })
  expect(mocks.bindings[0]).toMatchObject({ modelConfigId: 'replacement', revision: 2 })
  expect(mocks.versions.get('source:1')).toMatchObject({ modelName: 'model-source', apiKeyCiphertext: 'encrypted-offline-only', multiplierBps: 10000 })
  expect(mocks.audits).toHaveLength(1)
})

it.each([{ multiplierBps: 20000 }, { metadata: { modelKind: 'web_search' } }, { enabled: false }])('blocks invalid replacement without archive or audit %j', async patch => {
  mocks.bindings = [{ roleKey: 'speed', modelConfigId: 'source', revision: 1 }]
  Object.assign(mocks.models[1], patch)
  const view = await getAdminModelLifecyclePreview('fixture-admin', 'source')
  expect(view.candidates[0].eligible).toBe(false)
  await expect(archiveAdminModel('fixture-admin', 'source', { expectedRevision: 1, previewHash: view.previewHash, reason: '整理', replacementId: 'replacement', replacementRevision: 1 })).rejects.toMatchObject({ code: 'MODEL_REPLACEMENT_INVALID' })
  expect(mocks.models[0].archivedAt).toBeNull()
  expect(mocks.audits).toHaveLength(0)
})

it('rejects stale preview/revision and requires replacement for a required role', async () => {
  mocks.bindings = [{ roleKey: 'speed', modelConfigId: 'source', revision: 1 }]
  const view = await getAdminModelLifecyclePreview('fixture-admin', 'source')
  await expect(archiveAdminModel('fixture-admin', 'source', { expectedRevision: 2, previewHash: view.previewHash, reason: '整理' })).rejects.toMatchObject({ code: 'MODEL_LIFECYCLE_CONFLICT' })
  await expect(archiveAdminModel('fixture-admin', 'source', { expectedRevision: 1, previewHash: view.previewHash, reason: '整理' })).rejects.toMatchObject({ code: 'MODEL_REPLACEMENT_REQUIRED' })
  mocks.models[1].revision = 2
  await expect(archiveAdminModel('fixture-admin', 'source', { expectedRevision: 1, previewHash: view.previewHash, reason: '整理', replacementId: 'replacement', replacementRevision: 1 })).rejects.toMatchObject({ code: 'MODEL_IMPACT_CHANGED' })
})

it('restores the same identity as disabled and never rebinds default/system roles or touches task/price records', async () => {
  Object.assign(mocks.models[0], { archivedAt: new Date(), enabled: false, selectable: false, isDefault: false, revision: 2 })
  mocks.bindings = [{ roleKey: 'speed', modelConfigId: 'replacement', revision: 2 }]
  await restoreAdminModel('fixture-admin', 'source', { expectedRevision: 2, reason: '重新核对配置' })
  expect(mocks.models[0]).toMatchObject({ id: 'source', tier: 'speed', archivedAt: null, enabled: false, selectable: false, isDefault: false, revision: 3 })
  expect(mocks.bindings[0].modelConfigId).toBe('replacement')
  expect(mocks.audits[0]).toMatchObject({ action: 'models.restore', detail: { resumedTasks: 0 } })
})

it('retains an admitted running version after archive/restore/edit and rejects paused or wrong-owner selection', async () => {
  await captureAdminModelVersion(db as unknown as Prisma.TransactionClient, mocks.models[0] as unknown as AiModelConfig)
  Object.assign(mocks.models[0], { revision: 4, provider: 'replacement-provider', apiKeyCiphertext: 'encrypted-new-config', metadata: { marker: 'changed' } })
  mocks.run = { id: 'running', userId: 'owner', status: 'running', startedAt: new Date('2026-10-31T00:00:00Z'), modelConfigId: 'source', modelConfigRevision: 1 }
  const context = { userId: 'owner', runId: 'running', modelConfigId: 'source', modelConfigRevision: 1 }
  expect(await resolveRetainedModelConfig('speed', context)).toMatchObject({ provider: 'fixture-provider', apiKeyCiphertext: 'encrypted-offline-only', metadata: { marker: 'retained' }, revision: 1 })
  mocks.run = null
  expect(await resolveRetainedModelConfig('speed', context)).toBeNull()
})

it('never overwrites an existing config version on replay or collision', async () => {
  const row = mocks.models[0] as unknown as AiModelConfig
  await captureAdminModelVersion(db as unknown as Prisma.TransactionClient, row)
  await captureAdminModelVersion(db as unknown as Prisma.TransactionClient, row)
  expect(mocks.versions.size).toBe(1)
  row.modelName = 'different-at-same-version'
  await expect(captureAdminModelVersion(db as unknown as Prisma.TransactionClient, row)).rejects.toMatchObject({ code: 'MODEL_VERSION_CONFLICT' })
  expect(mocks.versions.get('source:1')?.modelName).toBe('model-source')
})

it('compares actual itemized amounts while keeping rate-card identities separate and retaining promotion differences', () => {
  const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'source-card', rates: { inputNano: 100, cacheNano: 25, outputNano: 1000 } }
  expect(modelFeeIdentity(mocks.models[0] as unknown as AiModelConfig, price)).toBe(modelFeeIdentity(mocks.models[1] as unknown as AiModelConfig, { ...price, modelTier: 'builtin_0123456789abcdef', rateCardId: 'target-card' }))
  expect(modelFeeIdentity(mocks.models[0] as unknown as AiModelConfig, price)).not.toBe(modelFeeIdentity(mocks.models[1] as unknown as AiModelConfig, { ...price, rates: { ...price.rates, outputNano: 1001 } }))
  expect(runtimeJson(price).hash).not.toBe(runtimeJson({ ...price, rateCardId: 'target-card' }).hash)
})

it.each([
  { tier: 'speed', key: 'source', role: 'speed' },
  { tier: 'basic', key: 'source', role: 'basic' },
  ...['tool:image-generation', 'tool:image-vision', 'tool:web-search', 'tool:web-fetch'].map(role => ({ tier: null, key: role, role })),
])('infers missing initialization binding for $role and explicitly transfers it without reclaiming it on restore', async ({ tier, key, role }) => {
  Object.assign(mocks.models[0], { tier, key })
  if (role.startsWith('tool:')) {
    const modelKind = { 'tool:image-generation': 'image_generation', 'tool:image-vision': 'vision', 'tool:web-search': 'web_search', 'tool:web-fetch': 'web_fetch' }[role]!
    for (const row of mocks.models) Object.assign(row, { tier: null, metadata: { modelKind } })
  }
  const view = await getAdminModelLifecyclePreview('fixture-admin', 'source')
  expect(view.systemRoles).toContain(role)
  await expect(archiveAdminModel('fixture-admin', 'source', { expectedRevision: 1, previewHash: view.previewHash, reason: '初始化目录整理' })).rejects.toMatchObject({ code: 'MODEL_REPLACEMENT_REQUIRED' })
  await archiveAdminModel('fixture-admin', 'source', { expectedRevision: 1, previewHash: view.previewHash, reason: '初始化目录整理', replacementId: 'replacement', replacementRevision: 1 })
  expect(mocks.bindings.find(row => row.roleKey === role)).toMatchObject({ modelConfigId: 'replacement' })
  await restoreAdminModel('fixture-admin', 'source', { expectedRevision: 2, reason: '合成恢复' })
  expect((await getAdminModelLifecyclePreview('fixture-admin', 'source')).systemRoles).not.toContain(role)
  expect(mocks.bindings.find(row => row.roleKey === role)).toMatchObject({ modelConfigId: 'replacement' })
})
