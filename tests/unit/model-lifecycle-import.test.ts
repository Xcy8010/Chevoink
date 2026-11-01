import { beforeEach, expect, it, vi } from 'vitest'
import { novelImportModelSchema } from '../../shared/contracts/novel-import.js'
import { freezeBasicImportSelection, resolveImportModelRoute, storedImportModelSchema } from '../../api/lib/novel-import/model-router.js'
import { DataAccessError } from '../../api/lib/prisma.js'
const mocks = vi.hoisted(() => ({ runtime: vi.fn(), model: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: { aiModelConfig: { findFirst: mocks.model } } }))
beforeEach(() => { vi.clearAllMocks(); mocks.model.mockResolvedValue({ id: 'original', revision: 1, archivedAt: null }); mocks.runtime.mockResolvedValue({ tier: 'basic', modelConfigId: 'original', modelConfigRevision: 1, provider: 'fixture', modelName: 'original-model', baseUrl: 'https://fixture.example/v1', apiKey: 'offline-fixture-only', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, multiplierBps: 10000 }) })
it('freezes a new basic import internally without accepting private lifecycle identity from author input', async () => {
  const stored = await freezeBasicImportSelection({ kind: 'basic' })
  expect(stored).toEqual({ kind: 'basic', modelConfigId: 'original', modelConfigRevision: 1, resolvedTier: 'basic' })
  expect(storedImportModelSchema.parse(stored)).toEqual(stored)
  expect(novelImportModelSchema.safeParse(stored).success).toBe(false)
  expect(JSON.stringify(stored)).not.toContain('offline-fixture-only')
})
it.each([false, true])('rejects archived basic import before resolving a different model; frozen=%s', async frozen => {
  mocks.model.mockResolvedValue({ id: 'original', revision: 2, archivedAt: new Date() })
  const selection = frozen ? { kind: 'basic' as const, modelConfigId: 'original', modelConfigRevision: 1, resolvedTier: 'basic' as const } : { kind: 'basic' as const }
  await expect(resolveImportModelRoute('owner', selection)).rejects.toMatchObject({ code: 'IMPORT_MODEL_CHANGED' })
  expect(mocks.runtime).not.toHaveBeenCalled()
})
it('rejects a changed restored version before any route dispatch and retains the stored selection', async () => {
  const stored = { kind: 'basic' as const, modelConfigId: 'original', modelConfigRevision: 1, resolvedTier: 'basic' as const }
  mocks.model.mockResolvedValue({ id: 'original', revision: 4, archivedAt: null })
  await expect(resolveImportModelRoute('owner', stored)).rejects.toMatchObject({ code: 'IMPORT_MODEL_CHANGED' })
  expect(stored.modelConfigRevision).toBe(1)
  expect(mocks.runtime).not.toHaveBeenCalled()
})
it('retains local import parsing when no LLM is configured without inventing another model', async () => {
  mocks.runtime.mockRejectedValue(new DataAccessError(409, 'MODEL_TIER_UNAVAILABLE', '未配置'))
  expect(await freezeBasicImportSelection({ kind: 'basic' })).toEqual({ kind: 'basic' })
  expect(mocks.runtime).toHaveBeenCalledOnce()
})
