import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findModel: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUsage: vi.fn(),
  charge: vi.fn(), access: vi.fn(), reserve: vi.fn(), runtime: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}, prisma: { agentGoalUsage: { findUnique: vi.fn(async () => null) }, agentModelAssignment: { findMany: vi.fn(async () => []) },
  aiModelConfig: { findFirst: mocks.findModel }, aiUsageLog: { create: mocks.create, update: mocks.update,
    updateMany: mocks.updateMany, findUnique: mocks.findUsage } } }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.access, reserveTokenCredits: mocks.reserve,
  consumeTokenCredits: mocks.charge, getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async (modelTier: string, multiplierBps: number) => ({ version: 'credits-v1-exact', modelTier, multiplierBps }) }))

import { chatWithTools, generateTextCompletion } from '../../api/lib/ai-service.js'
import { ModelRouteRejected } from '../../api/lib/model-route-pool.js'

type Usage = Record<string, unknown> & { id: string; userId: string; billingStatus: string }
let rows: Map<string, Usage>
const runtime = { tier: 'standard' as const, provider: 'fixture', modelName: 'selected-model', baseUrl: 'https://selected.test/v1',
  apiKey: 'fixture-key', reasoningEffort: 'medium' as const, multiplierBps: 12000, visionEnabled: false, contextWindowTokens: null }
const response = () => new Response('data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } })
const rejection = (usage?: object) => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' },
  ...(usage === undefined ? {} : { usage }) }), { status: 429 })
function invoke(channel: 'chat' | 'auxiliary', userId: string) {
  return channel === 'chat' ? chatWithTools({ messages: [{ role: 'user', content: 'synthetic' }], tools: [], provider: runtime.provider,
    model: runtime.modelName, providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey, reasoningEffort: runtime.reasoningEffort,
    usageLog: { userId, action: 'rate-limit-fixture', modelTier: runtime.tier, multiplierBps: runtime.multiplierBps } })
    : generateTextCompletion('system', 'synthetic', { userId, action: 'rate-limit-fixture', modelRuntime: runtime })
}
beforeEach(() => {
  vi.clearAllMocks(); rows = new Map()
  mocks.findModel.mockResolvedValue({ id: 'selected', ...runtime, metadata: { routes: [] } })
  mocks.access.mockResolvedValue(undefined)
  mocks.create.mockImplementation(async ({ data }) => {
    const row: Usage = { id: `usage-${rows.size + 1}`, requestTokens: null, responseTokens: null, reservedCreditMilli: 0,
      creditChargeMilli: 0, ...data }
    rows.set(row.id, row); return structuredClone(row)
  })
  mocks.reserve.mockImplementation(async (_userId, id) => { rows.get(id)!.reservedCreditMilli = 123 })
  mocks.update.mockImplementation(async ({ where, data }) => {
    const row = rows.get(where.id)!; Object.assign(row, data); return structuredClone(row)
  })
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    const row = rows.get(where.id)
    if (!row || where.userId && where.userId !== row.userId || where.billingStatus
      && !(typeof where.billingStatus === 'string' ? where.billingStatus === row.billingStatus : where.billingStatus.in.includes(row.billingStatus))) return { count: 0 }
    Object.assign(row, data); return { count: 1 }
  })
  mocks.findUsage.mockImplementation(async ({ where }) => {
    const row = rows.get(where.id)
    return row && (!where.userId || where.userId === row.userId) ? structuredClone(row) : null
  })
  mocks.charge.mockImplementation(async ({ usageLogId, requestTokens, responseTokens }) => {
    const chargedMilli = requestTokens === 0 && responseTokens === 0 ? 0 : 42
    Object.assign(rows.get(usageLogId)!, { billingStatus: 'settled', creditChargeMilli: chargedMilli, reservedCreditMilli: 0 })
    return { chargedMilli, remainingMilli: 1000, exhausted: false }
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('actual singleton rate-limit request accounting', () => {
  for (const channel of ['chat', 'auxiliary'] as const) {
    it.each([undefined, { prompt_tokens: 0, completion_tokens: 0 }])(`${channel} retries only an actual known zero-fee rejection %j`, async usage => {
      vi.useFakeTimers()
      const fetcher = vi.fn().mockImplementationOnce(async () => rejection(usage)).mockImplementationOnce(async () => response())
      vi.stubGlobal('fetch', fetcher)
      const pending = invoke(channel, `${channel}-positive-${usage === undefined ? 'absent' : 'zero'}`)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(rows.get('usage-1')).toMatchObject(usage === undefined
        ? { billingStatus: 'provider_rejected', requestTokens: null, responseTokens: null, reservedCreditMilli: 0, creditChargeMilli: 0 }
        : { billingStatus: 'settled', requestTokens: 0, responseTokens: 0, reservedCreditMilli: 0, creditChargeMilli: 0 })
      await vi.advanceTimersByTimeAsync(1)
      const result = await pending
      expect(typeof result === 'string' ? result : result.content).toBe('complete')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0])
      for (const [, init] of fetcher.mock.calls) {
        expect(init.headers.Authorization).toBe('Bearer fixture-key')
        expect(JSON.parse(init.body).model).toBe('selected-model')
      }
      expect([...rows.values()].every(row => row.multiplierBps === 12000)).toBe(true)
      expect(rows.get('usage-2')).toMatchObject({ billingStatus: 'settled', creditChargeMilli: 42 })
    })

    it.each([{}, { prompt_cache_hit_tokens: 5 }, { total_tokens: 5 }, { prompt_tokens: 0 }, { completion_tokens: 0 },
      { prompt_tokens: 3, completion_tokens: 0 }])(`${channel} preserves unknown or charged 429 and sends only once %j`, async usage => {
      const fetcher = vi.fn(async () => rejection(usage)); vi.stubGlobal('fetch', fetcher)
      const error = await invoke(channel, `${channel}-negative-${JSON.stringify(usage)}`).catch(error => error)
      expect(error).not.toBeInstanceOf(ModelRouteRejected)
      expect(error).toMatchObject({ code: 'AI_PROVIDER_ERROR' })
      expect(fetcher).toHaveBeenCalledOnce()
      const row = rows.get('usage-1')!
      expect(row.requestTokens).toBe('prompt_tokens' in usage ? usage.prompt_tokens : null)
      expect(row.responseTokens).toBe('completion_tokens' in usage ? usage.completion_tokens : null)
      if ('prompt_cache_hit_tokens' in usage) expect(row.promptCacheHitTokens).toBe(usage.prompt_cache_hit_tokens)
      if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
        expect(row).toMatchObject({ billingStatus: 'settled', creditChargeMilli: 42 })
        expect(mocks.charge).toHaveBeenCalledOnce()
      } else {
        expect(row).toMatchObject({ billingStatus: 'pending_usage', reservedCreditMilli: 123 })
        expect(mocks.charge).not.toHaveBeenCalled()
      }
    })

    it(`${channel} never retries zero reported usage with failed settlement`, async () => {
      mocks.charge.mockRejectedValue(new Error('settlement offline'))
      const fetcher = vi.fn(async () => rejection({ prompt_tokens: 0, completion_tokens: 0 })); vi.stubGlobal('fetch', fetcher)
      const error = await invoke(channel, `${channel}-failed-settlement`).catch(error => error)
      expect(error).not.toBeInstanceOf(ModelRouteRejected)
      expect(fetcher).toHaveBeenCalledOnce()
      expect(rows.get('usage-1')).toMatchObject({ billingStatus: 'pending_settlement', requestTokens: 0, responseTokens: 0, reservedCreditMilli: 123 })
    })

    it(`${channel} requires a readable known terminal ledger before retrying`, async () => {
      mocks.findUsage.mockRejectedValue(new Error('ledger read unavailable'))
      const fetcher = vi.fn(async () => rejection()); vi.stubGlobal('fetch', fetcher)
      await expect(invoke(channel, `${channel}-unreadable-proof`)).rejects.toBeDefined()
      expect(fetcher).toHaveBeenCalledOnce()
      expect(rows.get('usage-1')).toMatchObject({ billingStatus: 'provider_rejected', reservedCreditMilli: 0 })
    })

    it(`${channel} does not infer a terminal rejection from a failed ledger compare-and-swap`, async () => {
      mocks.updateMany.mockResolvedValue({ count: 0 })
      const fetcher = vi.fn(async () => rejection()); vi.stubGlobal('fetch', fetcher)
      const error = await invoke(channel, `${channel}-uncommitted-rejection`).catch(error => error)
      expect(error).not.toBeInstanceOf(ModelRouteRejected)
      expect(fetcher).toHaveBeenCalledOnce()
      expect(rows.get('usage-1')).toMatchObject({ billingStatus: 'prepared', reservedCreditMilli: 123 })
    })
  }
})
