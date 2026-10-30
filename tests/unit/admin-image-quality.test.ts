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
  aiModelConfig: { findMany: vi.fn(async (args: { select?: unknown }) => args.select ? [] : [mocks.row]),
    findFirst: vi.fn(async () => mocks.row), findFirstOrThrow: vi.fn(async () => mocks.row), update: mocks.update },
  aiUsageLog: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), create: mocks.usage, findUnique: vi.fn(async () => null) },
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
  mocks.row = { id: 'image', key: 'tool:image-generation', ownerUserId: null, tier: 'tool_image', provider: 'free-form-proxy',
    displayName: '图片生成', modelName: 'relay/arbitrary-image-alias', baseUrl: 'https://images.invalid/custom/generate', apiKeyCiphertext: 'encrypted',
    multiplierBps: 10000, enabled: true, selectable: false, isDefault: false, sortOrder: 0,
    metadata: { modelKind: 'image_generation', customMarker: { preserve: true } }, updatedAt: new Date('2026-10-30T00:00:00Z') }
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.row = { ...mocks.row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) }
    return mocks.row
  })
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ url: 'https://images.invalid/result.png' }],
    usage: { input_tokens: 17, output_tokens: 23 } }), { headers: { 'content-type': 'application/json' } }))
  mocks.usage.mockResolvedValue({ id: 'image-usage' })
  mocks.assets.mockResolvedValue([{ id: 'asset', imageUrl: '/api/uploads/novel-covers/result.png' }])
})

const input = { prompt: 'Synthetic cover title', size: '768x1024' as const, count: 1 }
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
  expect(runtime.route).toEqual(originalRoute)
  expect(body).not.toHaveProperty('quality')
  expect(body).not.toHaveProperty('reasoning_effort')
  expect(runtimeJson(work.route).hash).toBe(runtimeJson(originalRoute).hash)
  expect(runtimeJson(coverRequest(work)).hash).toBe(runtimeJson(originalRequest).hash)
  expect(coverWorkSchema.parse({ ...work, route: originalRoute })).toEqual(work)
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
