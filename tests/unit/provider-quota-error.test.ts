import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findModel: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), charge: vi.fn(), access: vi.fn(),
  runtime: vi.fn(), begin: vi.fn(), rejected: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}, prisma: { agentModelAssignment: { findMany: vi.fn(async () => []) }, aiModelConfig: { findFirst: mocks.findModel },
  aiUsageLog: { create: mocks.create, update: mocks.update, updateMany: mocks.updateMany, findUnique: vi.fn(async () => null) } } }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.access, reserveTokenCredits: vi.fn(), consumeTokenCredits: mocks.charge,
  getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async () => ({ version: 'credits-v1-exact' }) }))
vi.mock('../../api/lib/agent/runtime-provider.js', () => ({ beginDurableChat: mocks.begin }))
vi.mock('../../api/lib/agent/runtime-heartbeat.js', () => ({ withLeaseHeartbeat: (_lease: unknown, signal: AbortSignal | undefined,
  invoke: (signal: AbortSignal | undefined) => unknown) => invoke(signal) }))

import { chatWithTools, generateTextCompletion } from '../../api/lib/ai-service.js'
import { ModelRouteRejected } from '../../api/lib/model-route-pool.js'
import { isProviderQuotaError } from '../../api/lib/provider-quota-error.js'

const observedMessage = 'You account balance exceeded your current quota'
const customRuntime = { tier: 'custom' as const, provider: 'fixture', modelName: 'fixture', apiKey: 'fixture-key',
  baseUrl: 'https://fixture.test/v1', reasoningEffort: 'high' as const, multiplierBps: 0, visionEnabled: false, contextWindowTokens: null }
const invokeChat = (custom = false) => chatWithTools({ messages: [], tools: [], providerApiKey: 'fixture-key',
  usageLog: { userId: 'owner', action: 'quota-fixture', modelTier: custom ? 'custom' : 'speed' } })
const invokeAuxiliary = (custom = false) => generateTextCompletion('system', 'user', { userId: 'owner', action: 'quota-fixture',
  modelRuntime: custom ? customRuntime : { ...customRuntime, tier: 'speed', multiplierBps: 10000 } })
const stream = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findModel.mockResolvedValue(null)
  mocks.create.mockResolvedValue({ id: 'usage' })
  mocks.update.mockResolvedValue({ id: 'usage' })
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.charge.mockResolvedValue({ chargedMilli: 0 })
  mocks.access.mockResolvedValue(undefined)
  mocks.begin.mockResolvedValue({ rejected: mocks.rejected })
})
afterEach(() => vi.unstubAllGlobals())

describe('supplier quota error boundary', () => {
  it.each([{ code: 'insufficient_quota' }, { type: 'insufficient_quota' }, { code: 'quota_exceeded' },
    { type: 'insufficient_balance' }, { message: observedMessage }, observedMessage])('recognizes explicit quota evidence %j', error => {
    expect(isProviderQuotaError(error)).toBe(true)
  })
  it.each([{ code: 'rate_limit_exceeded' }, { type: 'tokens', message: 'Rate limit reached' }, { message: 'quota mentioned in a story' },
    { message: `He said "${observedMessage}"` }, { choices: [{ message: { content: observedMessage } }] }, null])('rejects unrelated evidence %j', error => {
    expect(isProviderQuotaError(error)).toBe(false)
  })

  for (const [channel, invoke] of [['chat', invokeChat], ['auxiliary', invokeAuxiliary]] as const) {
    it.each([402, 429])(`${channel} classifies HTTP %i quota with unknown usage and no retry`, async status => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: observedMessage } }), { status }))
      vi.stubGlobal('fetch', fetcher)
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED', message: expect.stringContaining('内置模型的上游供应商账号') })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(mocks.charge).not.toHaveBeenCalled()
      expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { usageSource: 'unknown', billingStatus: 'pending_usage' } }))
      expect(mocks.updateMany.mock.calls.some(([arg]) => arg.data.reservedCreditMilli === 0)).toBe(false)
    })
    it(`${channel} classifies the observed plain HTTP quota message`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(observedMessage, { status: 402 })))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      expect(fetch).toHaveBeenCalledOnce()
    })
    it(`${channel} leaves transient HTTP429 eligible for existing rate-limit recovery`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"rate_limit_exceeded","message":"RPM exceeded"}}', { status: 429 })))
      const error = await invoke().catch(error => error)
      expect(error).toBeInstanceOf(ModelRouteRejected)
      expect(error.upstreamStatus).toBe(429)
      expect(error.code).toBe('AI_PROVIDER_ERROR')
    })
    it(`${channel} preserves reported HTTP error usage before quota classification`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { type: 'insufficient_quota' },
        usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 429 })))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 12, responseTokens: 3, usageSource: 'reported' }) }))
      expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ requestTokens: 12, responseTokens: 3 }))
      expect(fetch).toHaveBeenCalledOnce()
    })
    it(`${channel} preserves same-frame SSE usage before stopping at quota`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ usage: { prompt_tokens: 15, completion_tokens: 2 }, error: { message: observedMessage } }])))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      const observations = [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].map(([arg]) => arg.data)
      expect(observations).toContainEqual(expect.objectContaining({ requestTokens: 15, responseTokens: 2, usageSource: 'reported' }))
      expect(fetch).toHaveBeenCalledOnce()
    })
    it(`${channel} preserves earlier SSE usage before a later quota frame`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ usage: { prompt_tokens: 21, completion_tokens: 4 } }, { error: { code: 'insufficient_quota' } }])))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      const observations = [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].map(([arg]) => arg.data)
      expect(observations).toContainEqual(expect.objectContaining({ requestTokens: 21, responseTokens: 4, usageSource: 'reported' }))
    })
    it(`${channel} preserves partial known SSE usage and keeps the missing count unknown`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ usage: { prompt_tokens: 21 }, error: { code: 'insufficient_quota' } }])))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      const observations = [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].map(([arg]) => arg.data)
      expect(observations).toContainEqual(expect.objectContaining({ requestTokens: 21, responseTokens: null, usageSource: 'unknown' }))
    })
    it(`${channel} keeps missing SSE usage unknown`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ error: { code: 'insufficient_quota' } }])))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      expect(mocks.charge).not.toHaveBeenCalled()
      expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { usageSource: 'unknown', billingStatus: 'pending_usage' } }))
    })
    it(`${channel} returns BYOK account guidance without retrying or charging platform credits`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"type":"insufficient_quota"}}', { status: 429 })))
      await expect(invoke(true)).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED', message: expect.stringContaining('自定义模型的供应商账号') })
      expect(fetch).toHaveBeenCalledOnce()
      expect(mocks.charge).not.toHaveBeenCalled()
      expect(mocks.findModel).not.toHaveBeenCalled()
    })
    it(`${channel} preserves BYOK reported quota usage as exempt`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"insufficient_quota"},"usage":{"prompt_tokens":11,"completion_tokens":0}}', { status: 402 })))
      await expect(invoke(true)).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 11, responseTokens: 0,
        billingStatus: 'exempt', usageSource: 'reported' }) }))
      expect(mocks.charge).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledOnce()
    })
    it(`${channel} returns normal narrative containing the quota phrase unchanged`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ choices: [{ delta: { content: observedMessage }, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 10 } }])))
      const result = await invoke()
      expect(typeof result === 'string' ? result : result.content).toBe(observedMessage)
    })
  }

  it('does not fail over built-in quota rejection to another supplier account or mutate route configuration', async () => {
    const config = { id: 'main', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://fixture.test/v1', apiKeyCiphertext: 'fixture-key',
      metadata: { routes: [{ id: '6a18e83b-4c75-422d-8173-3e524fb64892', label: 'backup', provider: 'fixture', modelName: 'backup',
        baseUrl: 'https://backup.test/v1', apiKeyCiphertext: 'backup-fixture-key', enabled: true }] } }
    const original = structuredClone(config)
    mocks.findModel.mockResolvedValue(config)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })))
    await expect(invokeAuxiliary()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(config).toEqual(original)
  })

  it('preserves HTTP quota usage and classification in the durable rejection contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"insufficient_quota"},"usage":{"prompt_tokens":12,"completion_tokens":3}}', { status: 429 })))
    await expect(chatWithTools({ messages: [], tools: [], providerApiKey: 'fixture-key',
      usageLog: { userId: 'owner', action: 'quota-fixture' }, durableExecution: {
        operationKey: 'operation', attemptKey: '1', lease: { userId: 'owner', runId: 'run', taskRootId: 'task', epoch: 1, leaseToken: 'lease' },
        price: { modelTier: 'speed' },
      } as NonNullable<Parameters<typeof chatWithTools>[0]['durableExecution']> })).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
    expect(mocks.rejected).toHaveBeenCalledWith(429, { quotaExceeded: true, usage: { source: 'reported', promptTokens: 12,
      completionTokens: 3, cacheHitTokens: null, cacheMissTokens: null } })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
  })
})
