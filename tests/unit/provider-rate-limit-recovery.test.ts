import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findModel: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUsage: vi.fn(),
  charge: vi.fn(), access: vi.fn(), reserve: vi.fn(), runtime: vi.fn(), price: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}, prisma: { agentGoalUsage: { findUnique: vi.fn(async () => null) }, agentModelAssignment: { findMany: vi.fn(async () => []) },
  aiModelConfig: { findFirst: mocks.findModel }, aiUsageLog: { create: mocks.create, update: mocks.update,
    updateMany: mocks.updateMany, findUnique: mocks.findUsage } } }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.access, reserveTokenCredits: mocks.reserve,
  consumeTokenCredits: mocks.charge, getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: mocks.price }))

import { chatWithTools, generateTextCompletion } from '../../api/lib/ai-service.js'
import { ModelRouteRejected } from '../../api/lib/model-route-pool.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'

type Usage = Record<string, unknown> & { id: string; userId: string; billingStatus: string }
let rows: Map<string, Usage>
const runtime = { tier: 'standard' as const, provider: 'fixture', modelName: 'selected-model', baseUrl: 'https://selected.test/v1',
  apiKey: 'fixture-key', reasoningEffort: 'medium' as const, reasoningEfforts: ['none', 'medium'] as const,
  reasoningParameterMode: 'native' as const, thinkingEnabled: false, multiplierBps: 12000, visionEnabled: false, contextWindowTokens: null }
const response = () => new Response('data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } })
const rejection = (usage?: object) => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' },
  ...(usage === undefined ? {} : { usage }) }), { status: 429 })
function invoke(channel: 'chat' | 'auxiliary' | 'quality' | 'continuity', userId: string) {
  return channel === 'chat' ? chatWithTools({ messages: [{ role: 'user', content: 'synthetic' }], tools: [], provider: runtime.provider,
    model: runtime.modelName, providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey, reasoningEffort: runtime.reasoningEffort,
    usageLog: { userId, action: 'rate-limit-fixture', modelTier: runtime.tier, multiplierBps: runtime.multiplierBps } })
    : generateTextCompletion('system', 'synthetic', { userId,
      action: channel === 'quality' ? 'agent3HumanityCritic' : channel === 'continuity' ? 'agent3ContinuityCritic' : 'rate-limit-fixture',
      modelRuntime: { ...runtime, reasoningEfforts: [...runtime.reasoningEfforts] } })
}
beforeEach(() => {
  vi.clearAllMocks(); rows = new Map()
  mocks.price.mockReset().mockImplementation(async (modelTier: string, multiplierBps: number) => ({ version: 'credits-v1-exact', modelTier, multiplierBps }))
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
  for (const channel of ['chat', 'auxiliary', 'quality', 'continuity'] as const) {
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
      if (usage !== undefined) expect(rows.get('usage-1')!.billingEvidence).toMatchObject({ responseObserved: false, providerRejection: { status: 429 } })
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
      if (channel === 'quality' || channel === 'continuity') {
        expect(mocks.findModel).not.toHaveBeenCalled()
        expect(JSON.parse(fetcher.mock.calls[0][1].body).reasoning_effort).toBe('none')
        expect(JSON.parse(fetcher.mock.calls[1][1].body).reasoning_effort).toBe('none')
      }
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

describe('configured model route HTTP 404 failover', () => {
  it.each([
    ['chat', '0ad2ca88-5d2d-432a-bfe1-c80c4ba251bb'],
    ['auxiliary', 'fd55faea-31b0-4f84-adb8-dd22081c47b4'],
  ] as const)('%s continues the original request on another route after a verified zero-fee 404', async (channel, id) => {
    const backup = { id, label: '备用', enabled: true,
      provider: runtime.provider, modelName: 'backup-model', baseUrl: 'https://backup.test/v1', apiKeyCiphertext: 'fixture-backup' }
    mocks.findModel.mockResolvedValue({ id: `selected-${channel}`, ...runtime, apiKeyCiphertext: runtime.apiKey, metadata: { routes: [backup] } })
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 }))
      .mockImplementationOnce(async () => response())
    vi.stubGlobal('fetch', fetcher)

    const result = await invoke(channel, `${channel}-route-404`)

    expect(typeof result === 'string' ? result : result.content).toBe('complete')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [first, second] = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(new Set([first.model, second.model])).toEqual(new Set([runtime.modelName, backup.modelName]))
    expect(second).toEqual({ ...first, model: second.model })
    expect(rows.get('usage-1')).toMatchObject({ modelName: first.model, billingStatus: 'provider_rejected', reservedCreditMilli: 0, creditChargeMilli: 0 })
    expect(rows.get('usage-2')).toMatchObject({ modelName: second.model, billingStatus: 'settled' })
    expect(mocks.charge).toHaveBeenCalledOnce()
  })
})

describe('logical operation price admission', () => {
  it('refreshes an independent operation instead of authorizing from the cached run price', async () => {
    const original = { version: 'credits-v1-exact' as const, modelTier: 'standard' as const, multiplierBps: 0 }
    const next = { ...original, multiplierBps: 12000 }
    mocks.price.mockResolvedValueOnce(original).mockResolvedValueOnce(next)
    const fetcher = vi.fn(async () => response()); vi.stubGlobal('fetch', fetcher)
    const cached = { ...runtime, multiplierBps: 0, tokenPrice: original, reasoningEfforts: [...runtime.reasoningEfforts] }
    const options = { userId: 'two-operations', action: 'operation-price-fixture', modelRuntime: cached }
    await generateTextCompletion('system', 'first', options)
    await generateTextCompletion('system', 'second', options)
    expect(mocks.price).toHaveBeenCalledTimes(2)
    expect(mocks.price.mock.calls.every(([, , admission]) => admission.freshOperation === true)).toBe(true)
    expect(rows.get('usage-1')).toMatchObject({ multiplierBps: 0, billingSnapshot: original })
    expect(rows.get('usage-2')).toMatchObject({ multiplierBps: 12000, billingSnapshot: next })
    expect(cached.tokenPrice).toEqual(original)
  })
  it('keeps one admitted price across a known-zero HTTP retry crossing the price boundary', async () => {
    vi.useFakeTimers()
    const original = { version: 'credits-v1-exact' as const, modelTier: 'standard' as const, multiplierBps: 12000 }
    mocks.price.mockResolvedValueOnce(original).mockResolvedValue({ ...original, multiplierBps: 24000 })
    const fetcher = vi.fn().mockImplementationOnce(async () => rejection()).mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetcher)
    const pending = invoke('chat', 'same-operation-price')
    await vi.advanceTimersByTimeAsync(60000)
    await pending
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(mocks.price).toHaveBeenCalledOnce()
    expect(rows.get('usage-1')?.billingSnapshot).toEqual(original)
    expect(rows.get('usage-2')?.billingSnapshot).toEqual(original)
    await invoke('chat', 'next-operation-price')
    expect(rows.get('usage-3')?.billingSnapshot).toMatchObject({ multiplierBps: 24000 })
  })
  it('keeps an explicitly authorized old quote after the runtime cache and current price change', async () => {
    const original = { version: 'credits-v1-exact' as const, modelTier: 'standard' as const, multiplierBps: 12000 }
    mocks.price.mockResolvedValue({ ...original, multiplierBps: 24000 })
    const fetcher = vi.fn(async () => response()); vi.stubGlobal('fetch', fetcher)
    await generateTextCompletion('system', 'whole chapter', { userId: 'owner', novelId: 'novel', chapterId: 'chapter', agentRunId: 'original-run', targetType: 'chapter', targetId: 'new-call',
      action: 'agent3HumanityAuthorReplacement', maxOutputTokens: 100, modelRuntime: { ...runtime, multiplierBps: 24000, tokenPrice: { ...original, multiplierBps: 24000 }, reasoningEfforts: [...runtime.reasoningEfforts] },
      authorizedRequest: { price: original, inputTokenCeiling: 1000, maxCreditMilli: 120, beforeDispatch: async () => undefined } })
    expect(mocks.price).not.toHaveBeenCalled()
    expect(rows.get('usage-1')).toMatchObject({ multiplierBps: 12000, billingSnapshot: original })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('V2 route metadata and frozen itemized price ownership', () => {
  const card = { version: 'credits-v2-itemized' as const, modelTier: 'standard' as const, multiplierBps: 11000,
    rateCardId: 'original-card', rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
  it.each(['chat', 'auxiliary'] as const)('%s keeps nominal route metadata across retry while the next operation admits a new card', async channel => {
    vi.useFakeTimers()
    const next = { ...card, rateCardId: 'next-card', rates: { inputNano: 220000, cacheNano: 55000, outputNano: 2200000 } }
    mocks.price.mockResolvedValueOnce(card).mockResolvedValue(next)
    const fetcher = vi.fn().mockImplementationOnce(async () => rejection()).mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetcher)
    const pending = invoke(channel, 'v2-operation')
    await vi.advanceTimersByTimeAsync(60000)
    await pending
    expect(mocks.price).toHaveBeenCalledOnce()
    for (const id of ['usage-1', 'usage-2']) expect(rows.get(id)).toMatchObject({ multiplierBps: 12000, billingSnapshot: card })
    expect(mocks.charge.mock.calls.at(-1)?.[0]).toMatchObject({ multiplierBps: 12000 })
    await invoke(channel, 'v2-next-operation')
    expect(mocks.price).toHaveBeenCalledTimes(2)
    expect(rows.get('usage-3')).toMatchObject({ multiplierBps: 12000, billingSnapshot: next })
    expect(card.rates).toEqual({ inputNano: 110000, cacheNano: 27500, outputNano: 1100000 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it.each(['chat', 'auxiliary'] as const)('%s uses explicit activity effective metadata without rewriting the frozen card rates', async channel => {
    const price = { ...card, activity: { baseMultiplierBps: 12000, effectiveMultiplierBps: 6000, revision: 3, timezone: 'Asia/Shanghai' as const,
      admittedAt: '2026-11-06T12:00:00Z', activityId: 'evening', activityName: '晚间折扣' } }
    mocks.price.mockResolvedValue(price)
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    await invoke(channel, 'v2-activity-operation')
    expect(rows.get('usage-1')).toMatchObject({ multiplierBps: 6000, billingSnapshot: price })
    expect(mocks.charge.mock.calls[0][0]).toMatchObject({ multiplierBps: 6000 })
    expect(rows.get('usage-1')?.billingSnapshot).toEqual(price)
  })
  it('keeps an explicit old V2 authorization and nominal route without resolving a newer price', async () => {
    expect(priceTokenEvidence(card, 1000, 100, 0)).toBe(220)
    mocks.price.mockResolvedValue({ ...card, rateCardId: 'new-card' })
    const fetcher = vi.fn(async () => response()); vi.stubGlobal('fetch', fetcher)
    await generateTextCompletion('system', 'whole chapter', { userId: 'owner', novelId: 'novel', chapterId: 'chapter', agentRunId: 'run', targetType: 'chapter', targetId: 'answer',
      action: 'agent3HumanityAuthorReplacement', maxOutputTokens: 100, modelRuntime: { ...runtime, multiplierBps: 15000, reasoningEfforts: [...runtime.reasoningEfforts] },
      authorizedRequest: { price: card, inputTokenCeiling: 1000, maxCreditMilli: 220, beforeDispatch: async () => undefined } })
    expect(mocks.price).not.toHaveBeenCalled()
    expect(rows.get('usage-1')).toMatchObject({ multiplierBps: 15000, billingSnapshot: card })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
