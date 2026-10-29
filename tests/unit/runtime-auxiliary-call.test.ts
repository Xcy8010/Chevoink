import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { chatWithTools as Chat, ChatCompletionResult } from '../../api/lib/ai-service.js'
import type { beginDurableChat as Begin } from '../../api/lib/agent/runtime-provider.js'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(), access: vi.fn(), manuscriptBudget: vi.fn(), begin: vi.fn<typeof Begin>(),
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
  withManuscriptRunLease: (_lease: unknown, work: (tx: RuntimeTx) => unknown, options?: { timeoutMs?: number }) => { mocks.manuscriptBudget(options); return work({} as RuntimeTx) },
}))

import { chatWithTools } from '../../api/lib/ai-service.js'
import { auxiliaryRouteForRuntime, callDurableAuxiliary, resolveDurableAuxiliaryRuntime, resolveReviewModelRuntime } from '../../api/lib/agent/runtime-auxiliary-call.js'
import * as assignments from '../../api/lib/agent/model-assignment-context.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { buildProviderCompatibilitySnapshot, type ProviderCompatibilityRoute } from '../../api/lib/agent/provider-compatibility.js'
import { env } from '../../api/config/env.js'

const lease = { userId: 'owner', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const result: ChatCompletionResult = { content: '合成检查结果', reasoning: '', toolCalls: [], finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, promptCacheHitTokens: null, promptCacheMissTokens: null } }
const runtime = { tier: 'custom' as const, provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1',
  apiKey: 'fixture-not-a-key', reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>,
  multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000 }
const selection = { tier: 'custom' as const, customModelId: 'owned-model', reasoningEffort: 'high' as const }
const price = { version: 'credits-v1-exact' as const, modelTier: 'custom' as const, multiplierBps: 0 }
const steps = ['quality_critic', 'quality_format_recovery', 'quality_evidence_correction', 'quality_repair', 'quality_repair_retry', 'continuity_critic', 'continuity_format_recovery', 'continuity_evidence_correction', 'continuity_reassessment', 'continuity_repair', 'continuity_repair_retry', 'continuity_coordinated_revision'] as const
const input = (step: typeof steps[number] = 'quality_critic') => ({ lease, parentOperationId: 'parent', step,
  route: auxiliaryRouteForRuntime({ ...runtime, honorAssignedReasoning: true }, selection, 1024), price,
  system: '合成检查规则', content: '合成完整原文', temperature: 0.15, signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}) })

beforeEach(() => {
  mocks.manuscriptBudget.mockReset()
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('durable reviewer reasoning compatibility without rewriting old paid requests', () => {
  it.each(steps)('freezes JSON mode for new MiMo %s requests', async step => {
    const mimo = { ...runtime, provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1' }
    mocks.runtime.mockResolvedValue(mimo)
    const request = { ...input(step), route: auxiliaryRouteForRuntime(mimo, selection, 1024) }
    expect(request.route.responseFormat).toBe('json_object')
    // This exact original review alone receives the full-source DB budget.
    await callDurableAuxiliary(request)
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: mimo.modelName, response_format: { type: 'json_object' } })
    expect(mocks.begin.mock.calls[0][0].request).toMatchObject({ body })
    expect(mocks.manuscriptBudget).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 20_000 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['publish_advice', 'research_dossier_synthesis', 'creative_critique', 'creative_revision'] as const)('keeps unrelated %s admission on the ordinary DB budget', async step => {
    await callDurableAuxiliary({ ...input(), step })
    expect(mocks.manuscriptBudget).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['unprepared', 'prepared'] as const)('preserves an old MiMo %s request without retrofitting JSON mode', async state => {
    const mimo = { ...runtime, provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1' }
    mocks.runtime.mockResolvedValue(mimo)
    const request = { ...input(), route: auxiliaryRouteForRuntime(mimo, selection, 1024) }
    delete request.route.responseFormat
    const body = { model: mimo.modelName, stream: true, messages: [{ role: 'user', content: 'Original request' }] }
    if (state === 'prepared') {
      const snapshot = { input: { request: { endpoint: mimo.baseUrl + '/chat/completions', body } } }
      mocks.existing = { status: 'prepared', inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash }
    }
    await callDurableAuxiliary(request)
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(sent).not.toHaveProperty('response_format')
    if (state === 'prepared') expect(sent).toEqual(body)
  })

  it.each([
    { source: 'builtin', provider: runtime.provider, baseUrl: runtime.baseUrl, model: runtime.modelName },
    { source: 'byok', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    { source: 'proxy', provider: 'deepseek', baseUrl: 'https://proxy.example/v1', model: 'alias', reasoningParameterMode: 'native', thinkingEnabled: false },
    { source: 'alias', provider: 'opaque', baseUrl: 'https://proxy.example/v1', model: 'alias', reasoningParameterMode: 'omit', thinkingEnabled: true },
  ] satisfies Array<Pick<ProviderCompatibilityRoute, 'source' | 'provider' | 'baseUrl' | 'model'> & Partial<ProviderCompatibilityRoute>>)('binds $source matrix encodings to the actual frozen durable main request', async inputRoute => {
    const route: ProviderCompatibilityRoute = { ...inputRoute, executor: 'durable', purpose: 'tool_turn', reasoningEffort: 'high',
      toolsPresent: true, toolChoice: 'required', maxOutputTokens: 1024 }
    const matrix = buildProviderCompatibilitySnapshot({ route, observedAt: '2026-10-11T12:00:00Z', codeRevision: 'fixture',
      configurationPointers: ['tests/unit/runtime-auxiliary-call.test.ts'] })
    await chatWithTools({ messages: [], tools: [{ type: 'function', function: { name: 'chapter_read', description: '合成工具', parameters: {} } }],
      provider: route.provider, model: route.model, providerBaseUrl: route.baseUrl, providerApiKey: 'fixture-not-a-key',
      reasoningEffort: route.reasoningEffort, reasoningParameterMode: route.reasoningParameterMode, thinkingEnabled: route.thinkingEnabled,
      toolChoice: route.toolChoice, maxOutputTokens: route.maxOutputTokens, durableExecution: { lease, operationKey: 'main:0', attemptKey: '1', price },
      usageLog: { userId: lease.userId, agentRunId: lease.runId, action: 'mainWriting', modelTier: 'custom', multiplierBps: 0 } })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect({ ...(body.thinking ? { thinking: body.thinking } : {}), ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}) })
      .toEqual(matrix.requestEncoding?.reasoning)
    expect(body.tool_choice ? { tool_choice: body.tool_choice } : {}).toEqual(matrix.requestEncoding?.toolChoice)
    expect(body.max_tokens).toBe(1024)
    expect(mocks.begin.mock.calls[0][0].request).toEqual({ endpoint: matrix.route.endpoint, body })
    expect(matrix.capabilities.native_tool_stream.status).toBe('unknown')
    expect(matrix.route.reasoningEffort).toBe('high')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([{ modelSelection: undefined, code: 'RUNTIME_MODEL_ADAPTER_REQUIRED' },
    { modelSelection: { tier: 'custom' as const, customModelId: null, reasoningEffort: 'high' as const }, code: 'RUNTIME_MODEL_ADAPTER_REQUIRED' },
    { modelSelection: { tier: 'speed' as const, customModelId: null, reasoningEffort: 'high' as const }, code: 'RUNTIME_IDENTITY_CONFLICT' }])('rejects missing or mismatched native custom identity %# before any paid fallback', async ({ modelSelection, code }) => {
    await expect(resolveDurableAuxiliaryRuntime({ userId: 'owner', modelRuntime: runtime, modelSelection, task: 'quality' }))
      .rejects.toMatchObject({ code })
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['quality', 'continuity'] as const)('does not invent a speed route when the %s task has no selected identity', async task => {
    const assigned = vi.spyOn(assignments, 'assignedTaskModel').mockResolvedValue({ runtime,
      selection: { modelTier: 'custom', customModelId: 'owned-assigned' } })
    const modelAssignments = { version: 1 as const, globalRevision: 1, novelRevision: 0,
      assignments: { [task]: { modelTier: 'custom' as const, customModelId: 'owned-assigned', reasoningEffort: 'high' as const } } }
    await expect(resolveDurableAuxiliaryRuntime({ userId: 'owner', task, modelAssignments })).rejects.toMatchObject({ code: 'RUNTIME_MODEL_ADAPTER_REQUIRED' })
    await expect(resolveReviewModelRuntime({ userId: 'owner', task, modelAssignments })).rejects.toMatchObject({ code: 'RUNTIME_MODEL_ADAPTER_REQUIRED' })
    expect(assigned).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
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

  it.each(['quality_critic', 'continuity_critic'] as const)('uses verified native-none proof for an unknown BYOK gateway (%s)', async step => {
    const request = input(step)
    request.route = { ...request.route, provider: 'fixture', model: 'verified-model', baseUrl: 'https://verified.example/v1' }
    mocks.runtime.mockResolvedValue({ ...runtime, provider: request.route.provider, modelName: request.route.model, baseUrl: request.route.baseUrl,
      thinkingEnabled: false, reasoningParameterMode: 'native' })
    await callDurableAuxiliary(request)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ reasoning_effort: 'none' })
  })

  it.each(['quality_critic', 'continuity_critic'].flatMap(step => ['succeeded', 'unknown'].map(status => ({ step, status }))))('keeps the original $status $step request and price after current selection changes without new HTTP', async ({ step, status }) => {
    const request = input(step as 'quality_critic' | 'continuity_critic')
    request.route = { ...request.route, tier: 'ultimate', customModelId: null }
    const frozenPrice = { version: 'credits-v1-exact' as const, modelTier: 'ultimate' as const, multiplierBps: 15000 }
    const saved = { endpoint: request.route.baseUrl + '/chat/completions', body: { model: runtime.modelName, thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: '原冻结合成请求' }] } }
    const snapshot = { input: { request: saved } }
    mocks.existing = { status, inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash }
    const original = structuredClone(mocks.existing)
    mocks.runtime.mockRejectedValue(new Error('Old paid operation must not resolve current credentials'))
    mocks.begin.mockImplementation(async received => {
      expect(received.request).toEqual(saved)
      expect(received.price).toEqual(frozenPrice)
      expect(received.execution.price).toEqual(frozenPrice)
      expect(received.execution.operationKey).toBe(`aux:parent:${step}`)
      if (status === 'unknown') throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', 'Unknown paid result')
      return { replay: result, observe: vi.fn(async () => {}), finish: async response => response,
        interrupted: vi.fn(async () => {}), rejected: vi.fn(async () => {}) }
    })
    const current = { ...runtime, tier: 'builtin_1234567890abcdef' as const, provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', multiplierBps: 25000 }
    const resolvedCurrent = await resolveDurableAuxiliaryRuntime({ userId: 'owner', task: step.startsWith('quality') ? 'quality' : 'continuity', modelRuntime: current })
    expect(resolvedCurrent.runtime.multiplierBps).toBe(25000)
    if (status === 'unknown') await expect(callDurableAuxiliary({ ...request, price: frozenPrice })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    else expect(await callDurableAuxiliary({ ...request, price: frozenPrice })).toEqual(result)
    expect(mocks.begin).toHaveBeenCalledOnce()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(request.assertCurrent).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.existing).toEqual(original)
  })

  it.each(['quality_critic', 'continuity_critic'] as const)('dispatches a prepared old %s with its original body, price and unchanged hash', async step => {
    const request = input(step)
    request.route = { ...request.route, tier: 'ultimate', customModelId: null }
    const frozenPrice = { version: 'credits-v1-exact' as const, modelTier: 'ultimate' as const, multiplierBps: 15000 }
    mocks.runtime.mockResolvedValue({ ...runtime, tier: 'ultimate', multiplierBps: 25000 })
    const saved = { endpoint: request.route.baseUrl + '/chat/completions', body: { model: runtime.modelName,
      stream: true, thinking: { type: 'enabled' }, max_tokens: 1024, messages: [{ role: 'user', content: '原冻结请求' }] } }
    const snapshot = { input: { request: saved } }
    mocks.existing = { status: 'prepared', inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash }
    const original = structuredClone(mocks.existing)
    await expect(callDurableAuxiliary({ ...request, price: frozenPrice })).resolves.toMatchObject({ content: result.content })
    expect(mocks.begin.mock.calls[0][0].request).toEqual(saved)
    expect(mocks.begin.mock.calls[0][0].price).toEqual(frozenPrice)
    expect(mocks.begin.mock.calls[0][0].execution.price).toEqual(frozenPrice)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual(saved.body)
    expect(fetch).toHaveBeenCalledOnce()
    expect(mocks.existing).toEqual(original)
  })

  it.each(steps)('uses selected high for a thinking-only route in %s without an off-mode probe', async step => {
    const request = input(step)
    request.route = { ...request.route, provider: 'fixture', model: 'thinking-only', baseUrl: 'https://unknown.example/v1' }
    mocks.runtime.mockResolvedValue({ ...runtime, provider: request.route.provider, modelName: request.route.model, baseUrl: request.route.baseUrl,
      reasoningEfforts: ['high'], reasoningParameterMode: 'native', thinkingEnabled: false })
    await expect(callDurableAuxiliary(request)).resolves.toMatchObject({ content: result.content })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: request.route.model, reasoning_effort: 'high', max_tokens: 1024 })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('temperature')
    expect(mocks.begin).toHaveBeenCalledOnce()
    expect(mocks.begin.mock.calls[0][0].request).toMatchObject({ body })
    expect(mocks.begin.mock.calls[0][0].price).toEqual(price)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['quality_critic', 'continuity_critic'] as const)('uses the configured provider default when its reasoning parameters are omitted (%s)', async step => {
    const request = input(step)
    request.route = { ...request.route, provider: 'fixture', model: 'opaque-model', baseUrl: 'https://hostile-default-thinking.example/v1', reasoningEffort: 'none' }
    mocks.runtime.mockResolvedValue({ ...runtime, provider: request.route.provider, modelName: request.route.model, baseUrl: request.route.baseUrl,
      reasoningEffort: 'none', reasoningEfforts: ['none'], reasoningParameterMode: 'omit', thinkingEnabled: false })
    await expect(callDurableAuxiliary(request)).resolves.toMatchObject({ content: result.content })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('temperature')
    expect(mocks.begin).toHaveBeenCalledOnce()
    expect(mocks.begin.mock.calls[0][0].request).toMatchObject({ body })
    expect(mocks.access).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(mocks.existing).toBeNull()
  })

  it.each(['quality_critic', 'continuity_critic'] as const)('reviews with a built-in thinking-only model without explicit protocol metadata (%s)', async step => {
    const selected = { ...runtime, tier: 'builtin_0123456789abcdef' as const, provider: 'openai', modelName: 'synthetic-thinking-model',
      baseUrl: 'https://gateway.example/v1', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const }
    mocks.runtime.mockResolvedValue(selected)
    const selectedPrice = { ...price, modelTier: selected.tier }
    const request = { ...input(step), price: selectedPrice, route: auxiliaryRouteForRuntime({ ...selected, reasoningEfforts: [...selected.reasoningEfforts] },
      { tier: selected.tier, customModelId: null, reasoningEffort: 'high' }, 1024) }
    await expect(callDurableAuxiliary(request)).resolves.toMatchObject({ content: result.content })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: selected.modelName, reasoning_effort: 'high', max_tokens: 1024 })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('temperature')
    expect(mocks.begin.mock.calls[0][0].request).toMatchObject({ body })
    expect(mocks.begin.mock.calls[0][0].price).toEqual(selectedPrice)
    expect(mocks.runtime).toHaveBeenCalledWith(selected.tier, lease.userId, null, 'high')
    expect(fetch).toHaveBeenCalledOnce()
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

describe('selected paid review model through resolution, frozen route and actual HTTP', () => {
  it('normalizes an admitted server-default null model exactly as admission and dispatch', async () => {
    const admittedRuntime = { ...runtime, tier: 'speed' as const, provider: 'deepseek', modelName: null,
      baseUrl: 'https://api.deepseek.com/v1', multiplierBps: 10000 }
    const admittedSelection = { tier: 'speed' as const, customModelId: null, reasoningEffort: 'high' as const,
      provider: admittedRuntime.provider, modelName: env.aiTextModel }
    mocks.runtime.mockResolvedValue(admittedRuntime)
    const resolved = await resolveDurableAuxiliaryRuntime({ userId: 'owner', modelSelection: admittedSelection, task: 'quality' })
    expect(resolved.runtime).toBe(admittedRuntime)
    expect(resolved.selection).toMatchObject(admittedSelection)
    const route = auxiliaryRouteForRuntime(resolved.runtime, resolved.selection, 1024)
    expect(route.model).toBe(env.aiTextModel)
    const selectedPrice = { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 10000 }
    await callDurableAuxiliary({ ...input('quality_critic'), route, price: selectedPrice })
    expect(mocks.runtime).toHaveBeenLastCalledWith('speed', 'owner', null, 'high')
    expect(mocks.begin).toHaveBeenCalledOnce()
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: env.aiTextModel, thinking: { type: 'disabled' } })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects a different frozen model when the current runtime model is null', async () => {
    mocks.runtime.mockResolvedValue({ ...runtime, tier: 'speed', provider: 'deepseek', modelName: null, multiplierBps: 10000 })
    await expect(resolveDurableAuxiliaryRuntime({ userId: 'owner', task: 'continuity', modelSelection: {
      tier: 'speed', customModelId: null, reasoningEffort: 'high', provider: 'deepseek', modelName: env.aiTextModel + '-different',
    } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.access).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  const chosenModels = [
    { tier: 'builtin_1234567890abcdef' as const, provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1', outputTokenParameter: 'max_completion_tokens' as const },
    { tier: 'builtin_abcdef1234567890' as const, provider: 'Zhipu', modelName: 'glm-5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', outputTokenParameter: 'max_tokens' as const },
  ]
  it.each(chosenModels.flatMap(chosen => steps.flatMap(step => ['runtime', 'selection'].map(entry => ({ chosen, step, entry })))))(
    '$chosen.modelName $step follows the admitted $entry instead of speed/DS', async ({ chosen, step, entry }) => {
      const selectedRuntime = { ...runtime, ...chosen, multiplierBps: 15000, thinkingEnabled: true, reasoningParameterMode: 'native' as const }
      const selected = { tier: chosen.tier, customModelId: null, reasoningEffort: 'high' as const, provider: chosen.provider, modelName: chosen.modelName }
      mocks.runtime.mockResolvedValue(selectedRuntime)
      const task = step.startsWith('quality') ? 'quality' as const : 'continuity' as const
      const resolved = await resolveDurableAuxiliaryRuntime({ userId: 'owner', task, modelSelection: selected,
        ...(entry === 'runtime' ? { modelRuntime: selectedRuntime } : {}) })
      expect(resolved.runtime).toBe(selectedRuntime)
      expect(resolved.selection).toMatchObject(selected)
      expect(mocks.runtime).toHaveBeenCalledTimes(entry === 'runtime' ? 0 : 1)
      const route = auxiliaryRouteForRuntime(resolved.runtime, resolved.selection, 1024)
      const selectedPrice = { version: 'credits-v1-exact' as const, modelTier: chosen.tier, multiplierBps: 15000 }
      await callDurableAuxiliary({ ...input(step), route, price: selectedPrice })
      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
      expect(body.model).toBe(chosen.modelName)
      expect(body.thinking?.type).not.toBe('enabled')
      expect(body.reasoning_effort ?? 'none').toBe('none')
      expect(body[chosen.outputTokenParameter]).toBe(1024)
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(chosen.baseUrl + '/chat/completions')
      expect(mocks.runtime).toHaveBeenLastCalledWith(chosen.tier, 'owner', null, 'high')
      expect(mocks.begin.mock.calls[0][0]).toMatchObject({ provider: chosen.provider, model: chosen.modelName,
        price: selectedPrice, request: { body: { model: chosen.modelName } } })
      expect(fetch).toHaveBeenCalledOnce()
    })
  it.each(['tier', 'provider', 'model', 'reasoning', 'fallback-basic'] as const)('%s identity drift rejects before a new HTTP request', async mismatch => {
    const chosen = chosenModels[0], selectedRuntime = { ...runtime, ...chosen, multiplierBps: 15000 }
    const selected = { tier: mismatch === 'fallback-basic' ? 'basic' as const : chosen.tier, customModelId: null, reasoningEffort: 'high' as const,
      provider: chosen.provider, modelName: chosen.modelName }
    mocks.runtime.mockResolvedValue({ ...selectedRuntime, ...(mismatch === 'tier' || mismatch === 'fallback-basic' ? { tier: 'speed' } : {}),
      ...(mismatch === 'provider' ? { provider: 'deepseek' } : {}), ...(mismatch === 'model' ? { modelName: 'other' } : {}), ...(mismatch === 'reasoning' ? { reasoningEffort: 'low' } : {}) })
    await expect(resolveDurableAuxiliaryRuntime({ userId: 'owner', task: 'quality', modelSelection: selected })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.begin).not.toHaveBeenCalled()
  })
  it('preserves the legacy paid/BYOK full runtime without reconstructing a native custom ID', async () => {
    const paid = { ...runtime, ...chosenModels[0], multiplierBps: 15000 }
    expect(await resolveReviewModelRuntime({ userId: 'owner', novelId: 'novel', modelRuntime: paid, task: 'quality' })).toBe(paid)
    expect(await resolveReviewModelRuntime({ userId: 'owner', novelId: 'novel', modelRuntime: runtime, task: 'continuity' })).toBe(runtime)
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
  it.each(chosenModels.flatMap(chosen => (['quality', 'continuity'] as const).flatMap(task =>
    (['runtime', 'selection'] as const).map(entry => ({ chosen, task, entry })))))(
    '$task ignores task assignment and keeps the current $chosen.modelName $entry and price', async ({ chosen, task, entry }) => {
    const main = { ...runtime, ...chosen, multiplierBps: 17500, thinkingEnabled: true, reasoningParameterMode: 'native' as const }
    const selected = { tier: chosen.tier, customModelId: null, reasoningEffort: 'high' as const, provider: chosen.provider, modelName: chosen.modelName }
    const modelAssignments = { version: 1 as const, globalRevision: 1, novelRevision: 0,
      assignments: { [task]: { modelTier: 'custom' as const, customModelId: 'owned-assigned', reasoningEffort: 'high' as const } } }
    const assigned = vi.spyOn(assignments, 'assignedTaskModel').mockResolvedValue({ runtime,
      selection: { modelTier: 'custom', customModelId: 'owned-assigned' } })
    mocks.runtime.mockResolvedValue(main)
    const request = { userId: 'owner', novelId: 'novel', task, modelAssignments, modelSelection: selected,
      ...(entry === 'runtime' ? { modelRuntime: main } : {}) }
    const resolved = await resolveDurableAuxiliaryRuntime(request)
    expect(resolved.runtime).toBe(main)
    expect(resolved.selection).toMatchObject(selected)
    expect(await resolveReviewModelRuntime(request)).toBe(main)
    expect(assigned).not.toHaveBeenCalled()
    expect(mocks.runtime).toHaveBeenCalledTimes(entry === 'runtime' ? 0 : 2)
    const selectedPrice = { version: 'credits-v1-exact' as const, modelTier: resolved.selection.tier, multiplierBps: resolved.runtime.multiplierBps }
    await callDurableAuxiliary({ ...input(task === 'quality' ? 'quality_critic' : 'continuity_critic'),
      route: auxiliaryRouteForRuntime(resolved.runtime, resolved.selection, 1024), price: selectedPrice })
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(chosen.baseUrl + '/chat/completions')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).model).toBe(chosen.modelName)
    expect(mocks.begin.mock.calls[0][0]).toMatchObject({ provider: chosen.provider, model: chosen.modelName,
      price: { version: 'credits-v1-exact', modelTier: chosen.tier, multiplierBps: 17500 } })
  })
})
