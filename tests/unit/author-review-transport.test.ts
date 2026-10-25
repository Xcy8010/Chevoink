import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), find: vi.fn(), charge: vi.fn(), reserve: vi.fn(), runtime: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(), consumeTokenCredits: mocks.charge, reserveTokenCredits: mocks.reserve,
  consumeCredits: vi.fn(), getModelTierRuntime: mocks.runtime, resolveCustomReasoningEffort: (effort: string) => effort }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { agentGoalUsage: { findUnique: vi.fn(async () => null) }, agentModelAssignment: { findMany: vi.fn(async () => []) },
    aiModelConfig: { findFirst: vi.fn(async () => null) }, aiUsageLog: { create: mocks.create, findUnique: mocks.find, update: mocks.update, updateMany: mocks.updateMany } } }))
vi.mock('../../api/lib/data-access.js', () => ({ ensureNovelOwner: vi.fn(), createCoverAssetsData: vi.fn() }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
import { generateTextCompletion } from '../../api/lib/ai-service.js'
import { ModelRouteRejected } from '../../api/lib/model-route-pool.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import type { TokenPrice } from '../../api/lib/billing/token-price.js'
import type { ModelTierRuntime } from '../../api/lib/credits.js'
const runtime: ModelTierRuntime = { tier: 'standard', modelName: 'mimo-v2.6-flash', provider: 'Xiaomi', label: '标准', description: '',
  baseUrl: 'https://mock.example/v1', apiKey: 'test-only', reasoningEffort: 'medium', reasoningEfforts: ['none', 'medium'], reasoningParameterMode: 'native',
  thinkingEnabled: false, multiplierBps: 12000, visionEnabled: false, contextWindowTokens: 128000 }
const price: TokenPrice = { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }
const envelope = () => ({ price, inputTokenCeiling: 500, maxCreditMilli: priceTokenEvidence(price, 500, 64, 0), beforeDispatch: vi.fn(async () => {}) })
beforeEach(() => { vi.resetAllMocks(); mocks.create.mockResolvedValue({ id: 'new-only' }); mocks.update.mockResolvedValue({ id: 'new-only' });
  mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.find.mockResolvedValue(null); mocks.charge.mockResolvedValue({ chargedMilli: 0, remainingMilli: 1000, exhausted: false }) })
afterEach(() => vi.unstubAllGlobals())
function invoke(policy = envelope(), observe = vi.fn()) {
  return generateTextCompletion('rules', 'body', { userId: 'author', novelId: 'novel', chapterId: 'chapter', agentRunId: 'run',
    action: 'agent3HumanityAuthorReplacement', targetType: 'chapter', targetId: 'one-call', modelRuntime: runtime,
    maxOutputTokens: 64, explicitModelSelection: true, authorizedRequest: policy, onObservedCompletion: observe })
}
it('rejects a changed quote before any usage reservation or provider HTTP', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(invoke({ ...envelope(), maxCreditMilli: 20000 })).rejects.toMatchObject({ code: 'TEXT_REQUEST_AUTHORIZATION_CONFLICT' })
  expect(fetcher).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.charge).not.toHaveBeenCalled()
})
it('rechecks the durable claim after preparing usage and refuses HTTP when authority changed', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const policy = envelope(); policy.beforeDispatch.mockRejectedValue(new Error('claim no longer valid'))
  await expect(invoke(policy)).rejects.toThrow('claim no longer valid')
  expect(mocks.create).toHaveBeenCalledOnce(); expect(policy.beforeDispatch).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled()
  expect(mocks.charge).not.toHaveBeenCalled()
})
it('keeps a one-request authorization to one HTTP even when the rejection has known zero billing', async () => {
  const usage = { id: 'new-only', usageSource: 'prepared', billingStatus: 'authorized_pending', requestTokens: null,
    responseTokens: null, reservedCreditMilli: 123, creditChargeMilli: 0, promptCacheHitTokens: null, promptCacheMissTokens: null }
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.billingStatus && !(typeof where.billingStatus === 'string' ? where.billingStatus === usage.billingStatus
      : where.billingStatus.in.includes(usage.billingStatus))) return { count: 0 }
    Object.assign(usage, data); return { count: 1 }
  })
  mocks.find.mockImplementation(async () => ({ ...usage }))
  const policy = envelope(), fetcher = vi.fn(async () => new Response('{"error":{"message":"rate limit"}}', { status: 429 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(invoke(policy)).rejects.toBeInstanceOf(ModelRouteRejected)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(policy.beforeDispatch).toHaveBeenCalledOnce()
  expect(usage).toMatchObject({ billingStatus: 'provider_rejected', reservedCreditMilli: 0, creditChargeMilli: 0 })
  expect(mocks.charge).not.toHaveBeenCalled()
})
it.each(['missing-counts', 'over-cap', 'billing-error', 'truncated', 'evidence-db-error'] as const)('retains real response with one selected-model HTTP and no repeat: %s', async scenario => {
  const observe = vi.fn(), policy = envelope()
  const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }],
    ...(scenario === 'missing-counts' ? {} : { usage: { prompt_tokens: scenario === 'over-cap' ? 501 : 100, completion_tokens: 20 } }) })))
  vi.stubGlobal('fetch', fetcher)
  if (scenario === 'billing-error') mocks.charge.mockRejectedValue(new Error('settlement offline'))
  if (scenario === 'evidence-db-error') mocks.update.mockRejectedValue(new Error('evidence db offline'))
  if (scenario === 'billing-error') {
    await expect(invoke(policy, observe)).resolves.toBe('{"findings":[]}')
    expect(mocks.updateMany.mock.calls.some(([input]) => input.data.billingStatus === 'pending_settlement')).toBe(true)
  } else await expect(invoke(policy, observe)).rejects.toBeDefined()
  expect(fetcher).toHaveBeenCalledOnce(); expect(policy.beforeDispatch).toHaveBeenCalledOnce()
  const request = JSON.parse(fetcher.mock.calls[0][1]?.body as string)
  expect(request.model).toBe('mimo-v2.6-flash')
  expect(observe).toHaveBeenCalledExactlyOnceWith({ usageId: 'new-only', content: '{"findings":[]}', finishReason: scenario === 'truncated' ? 'length' : 'stop', toolCalls: [] })
  if (scenario === 'missing-counts' || scenario === 'over-cap' || scenario === 'evidence-db-error') expect(mocks.charge).not.toHaveBeenCalled()
  expect(mocks.runtime).not.toHaveBeenCalled()
})
