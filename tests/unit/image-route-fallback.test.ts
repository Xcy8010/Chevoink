import { beforeEach, expect, it, vi } from 'vitest'
import { generateCoverImageData } from '../../api/lib/ai-service.js'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), charge: vi.fn(), refund: vi.fn(), reconcile: vi.fn(), usage: vi.fn(), assets: vi.fn(), runtime: vi.fn() }))
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: mocks.fetch }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), getToolModelRuntime: mocks.runtime }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: { aiUsageLog: { create: mocks.usage, findUnique: vi.fn(async () => null) } } }))
vi.mock('../../api/lib/credits.js', async original => ({ ...await original<object>(), consumeCredits: mocks.charge,
  recordImageRefundIntent: mocks.refund, reconcileCreditRefunds: mocks.reconcile }))
vi.mock('../../api/lib/data-access.js', () => ({ createCoverAssetsData: mocks.assets, ensureNovelOwner: vi.fn() }))

const input = { prompt: 'Synthetic cover title', count: 1, size: '768x1024' as const }
const primary = { provider: 'primary', modelName: 'image-a', baseUrl: 'https://primary.invalid/generate', apiKey: 'primary-secret' }
const backup = { id: 'baed63b4-cd4d-4e8e-a263-413ba008fb27', provider: 'backup', modelName: 'image-b', baseUrl: 'https://backup.invalid/generate', apiKey: 'backup-secret' }
const success = () => new Response(JSON.stringify({ data: [{ url: 'https://result.invalid/cover.png' }] }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.runtime.mockResolvedValue({ ...primary, routes: [backup], imageQuality: { supportedValues: ['high'], defaultValue: 'high' } })
  mocks.fetch.mockReset().mockResolvedValue(success())
  mocks.usage.mockResolvedValue({ id: 'usage' })
  mocks.refund.mockResolvedValue(undefined)
  mocks.reconcile.mockResolvedValue(undefined)
  mocks.assets.mockResolvedValue([{ id: 'asset', imageUrl: '/api/uploads/novel-covers/synthetic.png' }])
})

it('uses only the primary when it succeeds', async () => {
  await generateCoverImageData('owner', input)
  expect(mocks.fetch).toHaveBeenCalledOnce()
  expect(mocks.fetch.mock.calls[0][0]).toBe(primary.baseUrl)
  expect(mocks.charge).toHaveBeenCalledOnce()
  expect(mocks.refund).not.toHaveBeenCalled()
})

it.each([429, 500, 502, 503, 200])('routes a complete %s failure to the next account and charges the logical call once', async status => {
  mocks.fetch.mockResolvedValueOnce(new Response(status === 200 ? '{"data":[]}' : 'upstream unavailable', { status })).mockResolvedValueOnce(success())
  await generateCoverImageData('owner', input)
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([primary.baseUrl, backup.baseUrl])
  expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer backup-secret')
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ model: 'image-b', prompt: input.prompt, size: input.size, n: 1, quality: 'high' })
  expect(mocks.charge).toHaveBeenCalledOnce()
  expect(mocks.assets).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'image-b' }))
  expect(mocks.refund).not.toHaveBeenCalled()
  const logs = JSON.stringify(mocks.usage.mock.calls)
  expect(logs).not.toContain('primary-secret')
  expect(logs).not.toContain('backup-secret')
  expect(mocks.usage).toHaveBeenCalledWith({ data: expect.objectContaining({ modelName: 'image-a', action: 'generateCoverImageRouteFailure', creditChargeMilli: 0 }) })
})

it.each(['timeout', 'gateway-timeout', 'partial-body', 'invalid', 'unauthorized', 'cancelled'] as const)('does not switch after %s', async scenario => {
  const abort = new AbortController()
  if (scenario === 'gateway-timeout') mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: 504 }))
  if (scenario === 'timeout') mocks.fetch.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
  if (scenario === 'partial-body') mocks.fetch.mockResolvedValueOnce({ status: 503, text: async () => { throw Error('connection lost') } })
  if (scenario === 'invalid') mocks.fetch.mockResolvedValueOnce(new Response('not json'))
  if (scenario === 'unauthorized') mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  if (scenario === 'cancelled') mocks.fetch.mockImplementationOnce(async () => { abort.abort(); return new Response('{}', { status: 503 }) })
  await expect(generateCoverImageData('owner', input, { signal: abort.signal })).rejects.toBeDefined()
  expect(mocks.fetch).toHaveBeenCalledOnce()
  expect(mocks.assets).not.toHaveBeenCalled()
  expect(mocks.refund).toHaveBeenCalledOnce()
  if (scenario === 'timeout' || scenario === 'gateway-timeout' || scenario === 'partial-body') expect(mocks.refund).toHaveBeenCalledWith('owner', expect.any(String), { outcome: 'unknown', deliveredImages: 0 })
})

it('exhausts the configured pool once and records one refund obligation', async () => {
  mocks.fetch.mockImplementation(async () => new Response('{}', { status: 503 }))
  await expect(generateCoverImageData('owner', input)).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' })
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.charge).toHaveBeenCalledOnce()
  expect(mocks.refund).toHaveBeenCalledOnce()
  expect(mocks.assets).not.toHaveBeenCalled()
})
