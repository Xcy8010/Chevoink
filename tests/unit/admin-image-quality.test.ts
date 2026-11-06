import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { getAdminModelManagement, updateAdminModel } from '../../api/lib/admin-credit-model.js'
import { generateCoverImageData, requestCoverImages, resolveCoverImageRuntime } from '../../api/lib/ai-service.js'
import { clearToolModelRuntimeCache } from '../../api/lib/tool-model-config.js'
import { coverRequest, coverWorkSchema } from '../../api/lib/agent/runtime-cover-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { IMAGE_QUALITY_OPTIONS, imageQualityConfigSchema } from '../../shared/contracts/image-model.js'

const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, update: vi.fn(), fetch: vi.fn(), charge: vi.fn(), usage: vi.fn(), assets: vi.fn() }))
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: mocks.fetch }))
vi.mock('../../api/lib/secret-box.js', async original => ({ ...await original<object>(), decryptSecret: () => 'offline-image-key' }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: {
  appReleaseChannel: { findMany: vi.fn(async () => []) }, // This fixture exercises the unconfigured legacy channel.
  aiModelConfig: { findMany: vi.fn(async (args: { select?: unknown }) => args.select ? [] : [mocks.row]),
    findUnique: vi.fn(async () => mocks.row), findFirst: vi.fn(async () => mocks.row), findFirstOrThrow: vi.fn(async () => mocks.row), update: mocks.update },
  aiUsageLog: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), create: mocks.usage, findUnique: vi.fn(async () => null) },
  adminAuditLog: { create: vi.fn(async () => ({})) },
  user: { findUnique: vi.fn(async () => ({ role: 'admin', isSuperAdmin: true, bannedAt: null })) }, $queryRaw: vi.fn(async () => []),
} }))
vi.mock('../../api/lib/credit-policy.js', async original => ({ ...await original<object>(),
  creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work((await import('../../api/lib/prisma.js')).prisma),
}))
vi.mock('../../api/lib/credits.js', async original => ({ ...await original<object>(), consumeCredits: mocks.charge }))
vi.mock('../../api/lib/billing/rate-cards.js', async original => ({ ...await original<object>(), getActiveTokenPrices: vi.fn(async () => new Map()) }))
vi.mock('../../api/lib/data-access.js', () => ({ createCoverAssetsData: mocks.assets, ensureNovelOwner: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  clearToolModelRuntimeCache()
  mocks.row = { revision: 1, archivedAt: null, id: 'image', key: 'tool:image-generation', ownerUserId: null, tier: 'tool_image', provider: 'free-form-proxy',
    displayName: '图片生成', modelName: 'relay/arbitrary-image-alias', baseUrl: 'https://images.invalid/custom/generate', apiKeyCiphertext: 'encrypted',
    multiplierBps: 10000, enabled: true, selectable: false, isDefault: false, sortOrder: 0,
    metadata: { modelKind: 'image_generation', customMarker: { preserve: true } }, updatedAt: new Date('2026-10-30T00:00:00Z') }
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.row = { ...mocks.row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, key === 'revision' && value && typeof value === 'object' && 'increment' in value ? Number(mocks.row.revision) + Number(value.increment) : value])) }
    return mocks.row
  })
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ url: 'https://images.invalid/result.png' }],
    usage: { input_tokens: 17, output_tokens: 23 } }), { headers: { 'content-type': 'application/json' } }))
  mocks.usage.mockResolvedValue({ id: 'image-usage' })
  mocks.assets.mockResolvedValue([{ id: 'asset', imageUrl: '/api/uploads/novel-covers/result.png' }])
})

const input = { prompt: 'Synthetic cover title', size: '768x1024' as const, count: 1 }
it('saves image fallback routes, preserves encrypted keys on unrelated edits and omits text capability constraints', async () => {
  await updateAdminModel('admin', 'image', { routes: [{ label: '备用生图', provider: 'deepseek', modelName: 'image-alias',
    baseUrl: 'https://backup.invalid/generate', apiKey: 'synthetic-test-key', enabled: true }], reasoningEfforts: ['none', 'high'], visionEnabled: true })
  const metadata = mocks.row.metadata as { routes: Array<{ id: string; apiKeyCiphertext: string }> }
  expect(metadata.routes).toHaveLength(1)
  const frozen = metadata.routes[0]
  expect(frozen.apiKeyCiphertext).not.toBe('synthetic-test-key')
  const presented = (await getAdminModelManagement()).models[0].routes!
  expect(presented[0]).toMatchObject({ id: frozen.id, apiKeyConfigured: true, modelName: 'image-alias' })
  expect(JSON.stringify(presented)).not.toContain('synthetic-test-key')
  expect(JSON.stringify(presented)).not.toContain(frozen.apiKeyCiphertext)
  await updateAdminModel('admin', 'image', { displayName: '新生图名称', routes: presented.map(({ apiKeyConfigured: _configured, ...route }) => route) })
  expect((mocks.row.metadata as typeof metadata).routes[0]).toMatchObject(frozen)
  expect((await resolveCoverImageRuntime()).route.modelName).toBe(mocks.row.modelName)
})

it.each(['vision', 'web_search', 'web_fetch'])('rejects fallback routes on %s tools', async modelKind => {
  mocks.row = { ...mocks.row, tier: null, metadata: { modelKind } }
  await expect(updateAdminModel('admin', 'image', { routes: [{ label: '错误线路', provider: 'relay', modelName: 'alias',
    baseUrl: 'https://backup.invalid/generate', apiKey: 'synthetic-test-key', enabled: true }] })).rejects.toMatchObject({ code: 'MODEL_ROUTES_INVALID' })
  expect(mocks.update).not.toHaveBeenCalled()
})
async function captureBothPaths() {
  const runtime = await resolveCoverImageRuntime()
  const work = coverWorkSchema.parse({ version: 1, novelId: 'novel', title: 'Synthetic title', displayTitle: null,
    ...input, assetIds: [randomUUID()], tariff: 'image_call_6000_v1', amountMilli: 6000, route: runtime.route })
  await requestCoverImages(runtime, input)
  await generateCoverImageData('owner', input)
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  const bodies = mocks.fetch.mock.calls.map(([endpoint, options]) => {
    expect(endpoint).toBe(runtime.route.baseUrl)
    expect(options.headers.Authorization).toBe('Bearer offline-image-key')
    return JSON.parse(options.body)
  })
  expect(bodies[0]).toEqual(bodies[1])
  expect(coverRequest(work)).toEqual({ endpoint: runtime.route.baseUrl, body: bodies[0] })
  expect(JSON.stringify(work.route)).not.toContain('offline-image-key')
  // Keep the existing image tariff/observation flow; quality does not invent token accounting or a new rate card.
  expect(mocks.charge).toHaveBeenCalledOnce()
  expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ amountMilli: 6000, sourceType: 'image_generation' }))
  expect(mocks.usage).toHaveBeenCalledWith({ data: expect.objectContaining({ providerType: 'image', modelName: runtime.route.modelName,
    requestTokens: null, responseTokens: null, usageSource: null }) })
  return { runtime, work, body: bodies[0] }
}

it.each([...IMAGE_QUALITY_OPTIONS.map(option => option.value), 'proxy-ultra-v2'])('roundtrips %s from admin metadata into both HTTP paths and frozen requests for arbitrary model IDs', async quality => {
  const imageQuality = imageQualityConfigSchema.parse({ supportedValues: [quality], defaultValue: quality })
  await updateAdminModel('admin', 'image', { imageQuality })
  expect((await getAdminModelManagement()).models[0].imageQuality).toEqual(imageQuality)
  // Refresh and unrelated edits preserve this declaration without relying on a model-name match.
  await updateAdminModel('admin', 'image', { provider: 'another-relay', modelName: 'renamed/unlisted-alias', displayName: '重命名' })
  const refreshed = (await getAdminModelManagement()).models[0]
  expect(refreshed).toMatchObject({ imageQuality, modelName: 'renamed/unlisted-alias', provider: 'another-relay', apiKeyConfigured: true })
  expect(JSON.stringify(refreshed)).not.toContain('encrypted')
  expect(mocks.row.metadata).toMatchObject({ imageQuality, modelKind: 'image_generation', customMarker: { preserve: true } })
  const { runtime, body } = await captureBothPaths()
  expect(runtime.route.quality).toBe(quality)
  expect(body).toEqual({ model: 'renamed/unlisted-alias', prompt: input.prompt, size: input.size, n: 1, quality })
})

it.each(['legacy', 'omit'] as const)('keeps %s requests and original route/request hashes free of any quality field', async mode => {
  if (mode === 'omit') await updateAdminModel('admin', 'image', { imageQuality: { supportedValues: ['auto', 'max', 'relay-quality'], defaultValue: null } })
  else await updateAdminModel('admin', 'image', { displayName: '旧图片模型' })
  const { runtime, work, body } = await captureBothPaths()
  const originalRoute = { provider: 'free-form-proxy', modelName: 'relay/arbitrary-image-alias', baseUrl: 'https://images.invalid/custom/generate', providerMode: runtime.route.providerMode }
  const originalRequest = { endpoint: originalRoute.baseUrl, body: { model: originalRoute.modelName, prompt: input.prompt, size: input.size, n: 1 } }
  const { modelConfigId, modelConfigRevision, ...publicRoute } = runtime.route
  expect({ modelConfigId, modelConfigRevision }).toEqual({ modelConfigId: 'image', modelConfigRevision: mocks.row.revision })
  expect(publicRoute).toEqual(originalRoute)
  expect(body).not.toHaveProperty('quality')
  expect(body).not.toHaveProperty('reasoning_effort')
  const legacyWork = coverWorkSchema.parse({ ...work, route: originalRoute })
  expect(runtimeJson(legacyWork.route).hash).toBe(runtimeJson(originalRoute).hash)
  expect(runtimeJson(coverRequest(work)).hash).toBe(runtimeJson(originalRequest).hash)
  expect(legacyWork).toEqual({ ...work, route: originalRoute })
  expect(coverRequest(legacyWork)).toEqual(coverRequest(work))
  const refreshed = (await getAdminModelManagement()).models[0]
  if (mode === 'legacy') expect(refreshed).not.toHaveProperty('imageQuality')
  else expect(refreshed.imageQuality).toEqual({ supportedValues: ['auto', 'max', 'relay-quality'], defaultValue: null })
})

it('invalidates the cached image quality when the admin changes the default, preserving credentials and other metadata', async () => {
  expect((await resolveCoverImageRuntime()).route).not.toHaveProperty('quality')
  await updateAdminModel('admin', 'image', { imageQuality: { supportedValues: ['max'], defaultValue: 'max' } })
  expect((await resolveCoverImageRuntime()).route.quality).toBe('max')
  await updateAdminModel('admin', 'image', { imageQuality: { supportedValues: ['max'], defaultValue: null } })
  expect((await resolveCoverImageRuntime()).route).not.toHaveProperty('quality')
  expect(mocks.row.apiKeyCiphertext).toBe('encrypted')
  expect(mocks.row.metadata).toMatchObject({ customMarker: { preserve: true } })
  expect(mocks.fetch).not.toHaveBeenCalled()
})

vi.mock('../../api/lib/model-lifecycle.js', async original => ({ ...await original<object>(), captureAdminModelVersion: vi.fn(async () => {}) }))

it.each([0, 5000, 15000])('keeps the unchanged v1 image tariff when legacy declared multiplier is %s and no activity exists', async multiplierBps => {
  mocks.row.multiplierBps = multiplierBps
  const captured = await captureBothPaths()
  expect(captured.runtime.price).toBeUndefined()
  expect(captured.work).toMatchObject({ version: 1, tariff: 'image_call_6000_v1', amountMilli: 6000 })
  expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ amountMilli: 6000 }))
})
it('rejects saving a positive image activity at zero base, while accepting explicitly free activity', async () => {
  const activities = { revision: 0, timezone: 'Asia/Shanghai' as const, rules: [{ id: 'explicit', name: '明确活动', enabled: true, startDate: null, endDate: null,
    weekdays: [0, 1, 2, 3, 4, 5, 6], allDay: true, startTime: '00:00', endTime: '00:00', multiplierBps: 10000 }] }
  mocks.row.multiplierBps = 0
  await expect(updateAdminModel('admin', 'image', { activities })).rejects.toMatchObject({ code: 'MODEL_ACTIVITY_BASE_REQUIRED' })
  expect(mocks.update).not.toHaveBeenCalled()
  await expect(updateAdminModel('admin', 'image', { activities: { ...activities, rules: [{ ...activities.rules[0], multiplierBps: 0 }] } })).resolves.toBeUndefined()
  expect((await resolveCoverImageRuntime()).price?.amountMilli).toBe(0)
})
