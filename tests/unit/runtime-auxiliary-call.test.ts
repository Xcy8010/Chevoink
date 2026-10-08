import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { chatWithTools as Chat, ChatCompletionResult } from '../../api/lib/ai-service.js'
import type { beginDurableChat as Begin } from '../../api/lib/agent/runtime-provider.js'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(), access: vi.fn(), begin: vi.fn<typeof Begin>(),
  existing: null as null | { status: string; inputSnapshot: unknown; inputHash: string },
}))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: mocks.runtime, assertCreditAccess: mocks.access }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: {},
}))
vi.mock('../../api/lib/agent/runtime-provider.js', () => ({ beginDurableChat: mocks.begin }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ readGoalExecution: vi.fn(async () => undefined) }))
vi.mock('../../api/lib/agent/runtime-heartbeat.js', () => ({
  withLeaseHeartbeat: (_lease: unknown, signal: AbortSignal, work: (signal: AbortSignal) => unknown) => work(signal),
}))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({
  withRunLease: (_lease: unknown, work: (tx: RuntimeTx) => unknown) => work({ agentOperation: { findUnique: async () => mocks.existing } } as unknown as RuntimeTx),
  withManuscriptRunLease: (_lease: unknown, work: (tx: RuntimeTx) => unknown) => work({} as RuntimeTx),
}))

import { chatWithTools } from '../../api/lib/ai-service.js'
import { auxiliaryRouteForRuntime, callDurableAuxiliary, resolveDurableAuxiliaryRuntime } from '../../api/lib/agent/runtime-auxiliary-call.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const lease = { userId: 'owner', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const result: ChatCompletionResult = { content: '合成检查结果', reasoning: '', toolCalls: [], finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, promptCacheHitTokens: null, promptCacheMissTokens: null } }
const runtime = { tier: 'custom' as const, provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1',
  apiKey: 'fixture-not-a-key', reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>,
  multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000 }
const selection = { tier: 'custom' as const, customModelId: 'owned-model', reasoningEffort: 'high' as const }
const price = { version: 'credits-v1-exact' as const, modelTier: 'custom' as const, multiplierBps: 0 }
const steps = ['quality_critic', 'quality_format_recovery', 'quality_evidence_correction', 'quality_repair', 'quality_repair_retry'] as const
const input = (step: typeof steps[number] = 'quality_critic') => ({ lease, parentOperationId: 'parent', step,
  route: auxiliaryRouteForRuntime({ ...runtime, honorAssignedReasoning: true }, selection, 1024), price,
  system: '合成检查规则', content: '合成完整原文', temperature: 0.15, signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}) })

beforeEach(() => {
  mocks.existing = null
  mocks.runtime.mockReset().mockResolvedValue(structuredClone(runtime))
  mocks.access.mockReset().mockResolvedValue(undefined)
  mocks.begin.mockReset().mockImplementation(async request => {
    await request.admit()
    return { replay: undefined, observe: vi.fn(async () => {}), finish: async response => response,
      interrupted: vi.fn(async () => {}), rejected: vi.fn(async () => {}) }
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: result.content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)))
})
afterEach(() => vi.unstubAllGlobals())

describe('durable quality non-thinking policy without rewriting old paid requests', () => {
  it('resolves new independent quality at the configured default without requesting unsupported low', async () => {
    mocks.runtime.mockResolvedValue({ ...runtime, tier: 'speed' })
    expect(await resolveDurableAuxiliaryRuntime({ userId: 'owner', task: 'quality' })).toMatchObject({ selection: { tier: 'speed', reasoningEffort: 'high' } })
    expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith('speed', 'owner')
    mocks.runtime.mockClear()
    await resolveDurableAuxiliaryRuntime({ userId: 'owner', task: 'continuity' })
    expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith('speed', 'owner', null, 'low')
  })
  it.each(steps)('forces new %s HTTP off even when the assignment honors high', async step => {
    const request = input(step)
    expect(request.route.honorReasoningEffort).toBe(true)
    expect(await callDurableAuxiliary(request)).toMatchObject({ content: result.content })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ thinking: { type: 'disabled' }, model: runtime.modelName, max_tokens: 1024 })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('tools')
    expect(mocks.begin.mock.calls[0][0].request).toMatchObject({ body })
    expect(mocks.begin.mock.calls[0][0].action).toBe(step)
    expect(mocks.runtime).toHaveBeenCalledWith('custom', 'owner', 'owned-model', 'high')
    expect(fetch).toHaveBeenCalledOnce()
    expect(request.route.reasoningEffort).toBe('high')
  })

  it('uses verified native-none proof for an unknown BYOK gateway', async () => {
    const request = input()
    request.route = { ...request.route, provider: 'fixture', model: 'verified-model', baseUrl: 'https://verified.example/v1' }
    mocks.runtime.mockResolvedValue({ ...runtime, provider: request.route.provider, modelName: request.route.model, baseUrl: request.route.baseUrl,
      thinkingEnabled: false, reasoningParameterMode: 'native' })
    await callDurableAuxiliary(request)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ reasoning_effort: 'none' })
  })

  it.each(['succeeded', 'unknown'] as const)('keeps the original %s request without policy upgrade, credentials resolution or HTTP replay', async status => {
    const request = input()
    const saved = { endpoint: request.route.baseUrl + '/chat/completions', body: { model: runtime.modelName, thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: '原冻结合成请求' }] } }
    const snapshot = { input: { request: saved } }
    mocks.existing = { status, inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash }
    const original = structuredClone(mocks.existing)
    mocks.runtime.mockRejectedValue(new Error('Old paid operation must not resolve current credentials'))
    mocks.begin.mockImplementation(async received => {
      expect(received.request).toEqual(saved)
      expect(received.execution.operationKey).toBe('aux:parent:quality_critic')
      if (status === 'unknown') throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', 'Unknown paid result')
      return { replay: result, observe: vi.fn(async () => {}), finish: async response => response,
        interrupted: vi.fn(async () => {}), rejected: vi.fn(async () => {}) }
    })
    if (status === 'unknown') await expect(callDurableAuxiliary(request)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    else expect(await callDurableAuxiliary(request)).toEqual(result)
    expect(mocks.begin).toHaveBeenCalledOnce()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(request.assertCurrent).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.existing).toEqual(original)
  })

  it('leaves a prepared old request/hash unchanged when the new body conflicts', async () => {
    const request = input()
    const saved = { endpoint: request.route.baseUrl + '/chat/completions', body: { thinking: { type: 'enabled' } } }
    const snapshot = { input: { request: saved } }
    mocks.existing = { status: 'prepared', inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash }
    const original = structuredClone(mocks.existing)
    mocks.begin.mockImplementation(async received => {
      expect(received.request).toMatchObject({ body: { thinking: { type: 'disabled' } } })
      expect(runtimeJson(received.request).hash).not.toBe(runtimeJson(saved).hash)
      throw new DataAccessError(409, 'RUNTIME_IDENTITY_CONFLICT', 'Original request cannot be overwritten')
    })
    await expect(callDurableAuxiliary(request)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.existing).toEqual(original)
  })

  it('rejects unverified thinking-only routes before preparing a durable provider operation', async () => {
    const request = input()
    request.route = { ...request.route, provider: 'fixture', model: 'thinking-only', baseUrl: 'https://unknown.example/v1' }
    mocks.runtime.mockResolvedValue({ ...runtime, provider: request.route.provider, modelName: request.route.model, baseUrl: request.route.baseUrl,
      reasoningEfforts: ['high'], reasoningParameterMode: 'native', thinkingEnabled: false })
    await expect(callDurableAuxiliary(request)).rejects.toMatchObject({ code: 'AI_QUALITY_NON_THINKING_UNSUPPORTED' })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a hostile omit/false/only-none proxy before preparing durable work or sending HTTP', async () => {
    const request = input()
    request.route = { ...request.route, provider: 'fixture', model: 'opaque-model', baseUrl: 'https://hostile-default-thinking.example/v1', reasoningEffort: 'none' }
    mocks.runtime.mockResolvedValue({ ...runtime, provider: request.route.provider, modelName: request.route.model, baseUrl: request.route.baseUrl,
      reasoningEffort: 'none', reasoningEfforts: ['none'], reasoningParameterMode: 'omit', thinkingEnabled: false })
    await expect(callDurableAuxiliary(request)).rejects.toMatchObject({ code: 'AI_QUALITY_NON_THINKING_UNSUPPORTED' })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.access).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.existing).toBeNull()
  })

  it('does not apply quality policy to a main tool-bearing request', async () => {
    const params: Parameters<typeof Chat>[0] = { messages: [], tools: [{ type: 'function', function: { name: 'chapter_write', description: '合成工具', parameters: {} } }],
      provider: runtime.provider, model: runtime.modelName, providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey,
      reasoningEffort: 'high', durableExecution: { lease, operationKey: 'main:0', attemptKey: '1', price },
      usageLog: { userId: lease.userId, agentRunId: lease.runId, action: 'mainWriting', modelTier: 'custom', multiplierBps: 0 } }
    await chatWithTools(params)
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ thinking: { type: 'enabled' }, tools: params.tools })
  })
})
