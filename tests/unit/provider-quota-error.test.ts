import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findModel: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), charge: vi.fn(), access: vi.fn(),
  runtime: vi.fn(), begin: vi.fn(), rejected: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}, prisma: { agentModelAssignment: { findMany: vi.fn(async () => []) }, agentGoalExecution: { findUnique: vi.fn(async () => null) },
  aiModelConfig: { findFirst: mocks.findModel },
  aiUsageLog: { create: mocks.create, update: mocks.update, updateMany: mocks.updateMany, findUnique: vi.fn(async () => null) } } }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.access, reserveTokenCredits: vi.fn(), consumeTokenCredits: mocks.charge,
  getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async (modelTier: string, multiplierBps: number) => ({ version: 'credits-v1-exact', modelTier, multiplierBps }) }))
vi.mock('../../api/lib/agent/runtime-provider.js', () => ({ beginDurableChat: mocks.begin }))
vi.mock('../../api/lib/agent/runtime-heartbeat.js', () => ({ withLeaseHeartbeat: (_lease: unknown, signal: AbortSignal | undefined,
  invoke: (signal: AbortSignal | undefined) => unknown) => invoke(signal) }))

import { chatWithTools, generateTextCompletion } from '../../api/lib/ai-service.js'
import { ModelRouteRejected } from '../../api/lib/model-route-pool.js'
import { isProviderQuotaError } from '../../api/lib/provider-quota-error.js'

const observedMessage = 'You account balance exceeded your current quota'
const insufficientBalanceMessage = 'Insufficient Balance (request_id: 00000000-0000-4000-8000-000000000001)'
const customRuntime = { tier: 'custom' as const, provider: 'fixture', modelName: 'fixture', apiKey: 'fixture-key',
  baseUrl: 'https://fixture.test/v1', reasoningEffort: 'high' as const, multiplierBps: 0, visionEnabled: false, contextWindowTokens: null }
const invokeChat = (custom = false) => chatWithTools({ messages: [], tools: [], providerApiKey: 'fixture-key',
  usageLog: { userId: 'owner', action: 'quota-fixture', modelTier: custom ? 'custom' : 'speed' } })
const invokeAuxiliary = (custom = false) => generateTextCompletion('system', 'user', { userId: 'owner', action: 'quota-fixture',
  modelRuntime: custom ? customRuntime : { ...customRuntime, tier: 'speed', multiplierBps: 10000 } })
const stream = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })
const yunshuEndpoint = 'https://yunshu.chevolink.com/v1/chat/completions'
const yunshuRequestId = '20261112120000123456789abcdef01AbCdEf12'

function httpRejection(url: string, requestId: string, body: BodyInit, status = 400) {
  const response = new Response(body, { status, headers: { 'X-Oneapi-Request-Id': requestId } })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

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
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('provider HTTP rejection diagnostics', () => {
  const action = 'diagnostic-fixture'
  const agentRunId = 'synthetic-run'
  const context = { userId: 'owner', action, agentRunId }
  const invokeAgent = () => chatWithTools({ messages: [], tools: [], providerBaseUrl: 'https://yunshu.chevolink.com/v1',
    providerApiKey: 'fixture-key', usageLog: { ...context, turn: 3 } })
  const invokeAux = () => generateTextCompletion('synthetic system', 'synthetic user', {
    ...context, modelRuntime: { ...customRuntime, baseUrl: 'https://yunshu.chevolink.com/v1' },
  })

  it.each([
    { channel: 'agent', invoke: invokeAgent, turn: 3 },
    { channel: 'auxiliary', invoke: invokeAux, turn: null },
  ])('$channel records safe fields and retains one-dispatch rejection accounting', async ({ invoke, turn }) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const response = httpRejection(yunshuEndpoint, yunshuRequestId, JSON.stringify({
        error: { message: 'synthetic private response', param: 'tools[17].function.parameters.properties.privateName' },
      }))
      const fetcher = vi.fn(async () => response)
      vi.stubGlobal('fetch', fetcher)
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR', message: '模型服务暂时不可用。' })
      expect(log).toHaveBeenCalledExactlyOnceWith('[ai-provider-http-rejection]', JSON.stringify({
        agentRunId, action, turn, upstreamStatus: 400, errorParam: 'tools[17].function.parameters', gatewayRequestId: yunshuRequestId,
      }))
      expect(fetcher).toHaveBeenCalledOnce()
      expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { billingStatus: 'provider_rejected', reservedCreditMilli: 0, reservationExpiresAt: null },
      }))
      expect(mocks.charge).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  it.each([
    { url: 'https://elsewhere.example/v1/chat/completions', requestId: yunshuRequestId, body: '{"error":{"param":"private-text"}}', gatewayRequestId: null },
    { url: yunshuEndpoint, requestId: 'unrecognized-id', body: 'synthetic private non-JSON body', gatewayRequestId: null },
    { url: yunshuEndpoint, requestId: yunshuRequestId, body: 'synthetic private non-JSON body', gatewayRequestId: yunshuRequestId },
  ])('records only trusted fields when the response is incomplete or untrusted', async ({ url, requestId, body, gatewayRequestId }) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.stubGlobal('fetch', vi.fn(async () => httpRejection(url, requestId, body, 422)))
      await expect(invokeAgent()).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' })
      expect(log).toHaveBeenCalledExactlyOnceWith('[ai-provider-http-rejection]', JSON.stringify({
        agentRunId, action, turn: 3, upstreamStatus: 422, errorParam: null, gatewayRequestId,
      }))
      expect(fetch).toHaveBeenCalledOnce()
    } finally { log.mockRestore() }
  })

  it('records response headers when reading the error body fails', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('synthetic read failure')
    try {
      const body = new ReadableStream({ start(controller) { controller.error(failure) } })
      vi.stubGlobal('fetch', vi.fn(async () => httpRejection(yunshuEndpoint, yunshuRequestId, body, 422)))
      await expect(invokeAgent()).rejects.toBe(failure)
      expect(log).toHaveBeenCalledExactlyOnceWith('[ai-provider-http-rejection]', JSON.stringify({
        agentRunId, action, turn: 3, upstreamStatus: 422, errorParam: null, gatewayRequestId: yunshuRequestId,
      }))
      expect(fetch).toHaveBeenCalledOnce()
      expect(mocks.charge).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })
})

describe('supplier quota error boundary', () => {
  it.each([{ code: 'insufficient_quota' }, { type: 'insufficient_quota' }, { code: 'quota_exceeded' },
    { type: 'insufficient_balance' }, { message: observedMessage }, observedMessage,
    { message: 'Insufficient Balance' }, 'Insufficient Balance', { message: insufficientBalanceMessage }, insufficientBalanceMessage])('recognizes explicit quota evidence %j', error => {
    expect(isProviderQuotaError(error)).toBe(true)
  })
  it.each([{ code: 'rate_limit_exceeded' }, { type: 'tokens', message: 'Rate limit reached' }, { message: 'quota mentioned in a story' },
    { message: `He said "${observedMessage}"` }, { choices: [{ message: { content: observedMessage } }] },
    { message: `He said "${insufficientBalanceMessage}"` }, { message: `${insufficientBalanceMessage} is dialogue.` },
    { message: 'Insufficient Balance (request_id: not-a-uuid)' }, { message: 'Insufficient Balance while standing on one foot' },
    { choices: [{ message: { content: insufficientBalanceMessage } }] }, { content: insufficientBalanceMessage }, null])('rejects unrelated evidence %j', error => {
    expect(isProviderQuotaError(error)).toBe(false)
  })

  for (const [channel, invoke] of [['chat', invokeChat], ['auxiliary', invokeAuxiliary]] as const) {
    it.each([400, 402, 429])(`${channel} classifies HTTP %i balance message with request ID and no quota code`, async status => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: insufficientBalanceMessage } }), { status })))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED', message: expect.stringContaining('这不是 Chevoink Credits 不足') })
      expect(fetch).toHaveBeenCalledOnce()
      expect(mocks.charge).not.toHaveBeenCalled()
      expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { usageSource: 'unknown', billingStatus: 'pending_usage' } }))
      expect(mocks.updateMany.mock.calls.some(([arg]) => arg.data.reservedCreditMilli === 0)).toBe(false)
    })
    it.each([402, 429])(`${channel} classifies HTTP %i quota with unknown usage and no retry`, async status => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: observedMessage } }), { status }))
      vi.stubGlobal('fetch', fetcher)
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED', message: expect.stringContaining('内置模型的上游供应商账号') })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(mocks.charge).not.toHaveBeenCalled()
      expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { usageSource: 'unknown', billingStatus: 'pending_usage' } }))
      expect(mocks.updateMany.mock.calls.some(([arg]) => arg.data.reservedCreditMilli === 0)).toBe(false)
    })
    it.each([observedMessage, insufficientBalanceMessage])(`${channel} classifies the observed plain HTTP quota message: %s`, async message => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(message, { status: 402 })))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      expect(fetch).toHaveBeenCalledOnce()
    })
    it(`${channel} leaves an unconfirmed transient HTTP429 outside automatic recovery`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"rate_limit_exceeded","message":"RPM exceeded"}}', { status: 429 })))
      const error = await invoke().catch(error => error)
      expect(error).not.toBeInstanceOf(ModelRouteRejected)
      expect(error.code).toBe('AI_PROVIDER_ERROR')
      expect(fetch).toHaveBeenCalledOnce()
    })
    it(`${channel} preserves reported HTTP error usage before quota classification`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { type: 'insufficient_quota' },
        usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 429 })))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 12, responseTokens: 3, usageSource: 'reported' }) }))
      expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ requestTokens: 12, responseTokens: 3 }))
      expect(fetch).toHaveBeenCalledOnce()
    })
    it.each([observedMessage, insufficientBalanceMessage])(`${channel} preserves same-frame SSE usage before stopping at quota: %s`, async message => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ usage: { prompt_tokens: 15, completion_tokens: 2 }, error: { message } }])))
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
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ usage: { prompt_tokens: 21 }, error: { message: insufficientBalanceMessage } }])))
      await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA_EXCEEDED' })
      const observations = [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].map(([arg]) => arg.data)
      expect(observations).toContainEqual(expect.objectContaining({ requestTokens: 21, responseTokens: null, usageSource: 'unknown' }))
    })
    it.each([{ code: 'insufficient_quota' }, { message: insufficientBalanceMessage }])(`${channel} keeps missing SSE usage unknown: %j`, async error => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ error }])))
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
    it.each([observedMessage, insufficientBalanceMessage])(`${channel} returns normal narrative containing the quota phrase unchanged: %s`, async message => {
      vi.stubGlobal('fetch', vi.fn(async () => stream([{ choices: [{ delta: { content: message }, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 10 } }])))
      const result = await invoke()
      expect(typeof result === 'string' ? result : result.content).toBe(message)
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

  it.each([{ code: 'insufficient_quota' }, { message: insufficientBalanceMessage }])('preserves HTTP quota usage and classification in the durable rejection contract: %j', async error => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error, usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 429 })))
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

  it.each([400, 503])('preserves actual counts from non-quota HTTP%s in the durable receipt', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"synthetic failure"},"usage":{"prompt_tokens":12,"completion_tokens":3}}', { status })))
    await expect(chatWithTools({ messages: [], tools: [], providerApiKey: 'fixture-key',
      usageLog: { userId: 'owner', action: 'failure-fixture' }, durableExecution: {
        operationKey: 'operation', attemptKey: '1', lease: { userId: 'owner', runId: 'run', taskRootId: 'task', epoch: 1, leaseToken: 'lease' },
        price: { modelTier: 'speed' },
      } as NonNullable<Parameters<typeof chatWithTools>[0]['durableExecution']> })).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' })
    expect(mocks.rejected).toHaveBeenCalledWith(status, { quotaExceeded: false, usage: { source: 'reported', promptTokens: 12,
      completionTokens: 3, cacheHitTokens: null, cacheMissTokens: null } })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })
})
