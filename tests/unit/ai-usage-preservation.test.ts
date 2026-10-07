import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findModel: vi.fn(), create: vi.fn(), charge: vi.fn(), access: vi.fn(), update: vi.fn(), updateMany: vi.fn(), runtime: vi.fn(), imageCharge: vi.fn(), owner: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.access, consumeTokenCredits: mocks.charge, reserveTokenCredits: vi.fn(), consumeCredits: mocks.imageCharge, getModelTierRuntime: mocks.runtime,
  resolveCustomReasoningEffort: (effort: string, supported: string[]) => supported.includes(effort) ? effort : supported[0] }))
vi.mock('../../api/lib/data-access.js', () => ({ ensureNovelOwner: mocks.owner, createCoverAssetsData: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }, prisma: { agentModelAssignment: { findMany: vi.fn(async () => []) }, aiModelConfig: { findFirst: mocks.findModel }, aiUsageLog: { create: mocks.create, findUnique: vi.fn(async () => null), update: mocks.update, updateMany: mocks.updateMany } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async (modelTier: string, multiplierBps: number) => ({ version: 'credits-v1-exact', modelTier, multiplierBps }) }))
import { chatWithTools, generateTextCompletion, generateCoverImageData } from '../../api/lib/ai-service.js'
import { env } from '../../api/config/env.js'
import { TEXT_ACTION_TASKS, withModelAssignmentContext } from '../../api/lib/agent/model-assignment-context.js'
import { generateReviewCompletion } from '../../api/lib/agent/review-completion.js'

beforeEach(() => {
  mocks.findModel.mockReset().mockResolvedValue(null)
  mocks.imageCharge.mockReset()
  mocks.owner.mockReset().mockResolvedValue(undefined)
  mocks.create.mockReset().mockResolvedValue({ id: 'test-usage' })
  mocks.access.mockReset().mockResolvedValue(undefined)
  mocks.update.mockReset().mockResolvedValue({ id: 'test-usage' })
  mocks.updateMany.mockReset().mockResolvedValue({ count: 1 })
  mocks.runtime.mockReset().mockResolvedValue({ tier: 'speed', apiKey: 'fixture-not-a-key', provider: 'openai', reasoningEffort: 'high', multiplierBps: 10000, modelName: 'fixture' })
  mocks.charge.mockReset().mockResolvedValue({ chargedMilli: 0, remainingMilli: 1000, exhausted: false })
})
afterEach(() => vi.unstubAllGlobals())

async function invoke(usages: Array<Record<string, unknown>>) {
  const frames = usages.map(usage => `data: ${JSON.stringify({ usage, choices: [] })}\n\n`).join('')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`${frames}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)))
  return chatWithTools({ messages: [{ role: 'user', content: 'test input' }], tools: [], providerApiKey: 'fixture-not-a-key', usageLog: { userId: 'test', action: 'test' } })
}

type TextRuntime = NonNullable<Parameters<typeof generateTextCompletion>[2]['modelRuntime']>
function qualityRuntime(overrides: Partial<TextRuntime> = {}): TextRuntime {
  return { tier: 'custom', provider: 'fixture', modelName: 'verified-model', baseUrl: 'https://verified.example/v1',
    apiKey: 'fixture-not-a-key', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native',
    thinkingEnabled: false, multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000, ...overrides }
}
const qualityResponse = (finish = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 20 } }))

describe('fixed non-thinking humanity quality policy after actual model resolution', () => {
  it.each([
    { label: 'official Ling', runtime: { provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1', reasoningParameterMode: undefined, thinkingEnabled: undefined }, payload: { thinking: { type: 'disabled' } } },
    { label: 'official DeepSeek', runtime: { provider: 'deepseek', modelName: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1', reasoningEfforts: ['low', 'high'], reasoningParameterMode: undefined, thinkingEnabled: undefined }, payload: { thinking: { type: 'disabled' } } },
    { label: 'verified Tencent TokenHub DeepSeek', runtime: { provider: 'custom', modelName: 'deepseek/deepseek-flash', baseUrl: 'https://tokenhub.tencentmaas.com/v1', reasoningEfforts: ['low', 'high', 'max'], reasoningParameterMode: 'native', thinkingEnabled: false }, payload: { thinking: { type: 'disabled' } } },
    { label: 'documented TokenHub Flash version', runtime: { modelName: 'deepseek-v4-flash-202605', baseUrl: 'https://tokenhub.tencentmaas.com/v1', reasoningEfforts: ['high'] }, payload: { thinking: { type: 'disabled' } } },
    { label: 'official MiMo', runtime: { provider: 'xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1', reasoningParameterMode: undefined, thinkingEnabled: undefined }, payload: { thinking: { type: 'disabled' } } },
    { label: 'official GLM', runtime: { provider: 'zhipu', modelName: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', reasoningParameterMode: undefined, thinkingEnabled: undefined }, payload: { thinking: { type: 'disabled' } } },
    { label: 'validated native none', runtime: { thinkingEnabled: true }, payload: { reasoning_effort: 'none' } },
    { label: 'official Ling with omit', runtime: { provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1', reasoningParameterMode: 'omit', thinkingEnabled: undefined }, payload: { thinking: { type: 'disabled' } } },
  ] satisfies Array<{ label: string; runtime: Partial<TextRuntime>; payload: Record<string, unknown> }>)('uses $label without changing the configured main-turn default', async ({ runtime, payload }) => {
    const modelRuntime = qualityRuntime(runtime)
    const saved = structuredClone(modelRuntime)
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => qualityResponse())
    vi.stubGlobal('fetch', fetcher)
    await generateTextCompletion('规则', '合成完整正文', { userId: 'test', action: 'agent3HumanityCritic', modelRuntime, reasoningEffort: 'low', boundedReview: false })
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect({ ...(body.thinking ? { thinking: body.thinking } : {}), ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}) }).toEqual(payload)
    expect(body.model).toBe(modelRuntime.modelName)
    expect(modelRuntime).toEqual(saved)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.charge).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'unknown native thinking-only', runtime: { reasoningEfforts: ['high'] } },
    { label: 'unknown omit thinking switch', runtime: { reasoningParameterMode: 'omit', thinkingEnabled: true } },
    { label: 'omit without non-thinking proof', runtime: { reasoningParameterMode: 'omit', thinkingEnabled: undefined, reasoningEfforts: ['high'] } },
    { label: 'hostile proxy accepting text but defaulting to thinking', runtime: { reasoningParameterMode: 'omit', thinkingEnabled: false, reasoningEffort: 'none', reasoningEfforts: ['none'] } },
    { label: 'only-none without disable proof', runtime: { reasoningParameterMode: undefined, reasoningEffort: 'none', reasoningEfforts: ['none'] } },
    { label: 'official omit rejecting thinking switch', runtime: { provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1', reasoningParameterMode: 'omit', thinkingEnabled: false, reasoningEfforts: ['none'] } },
    { label: 'unknown proxy bearing Ling name', runtime: { provider: 'Ant Ling', modelName: 'Ling-3.0-flash', reasoningParameterMode: undefined, thinkingEnabled: undefined } },
    { label: 'unknown DeepSeek proxy', runtime: { provider: 'deepseek', modelName: 'deepseek-v4-flash', reasoningParameterMode: undefined, thinkingEnabled: undefined } },
    { label: 'TokenHub unsupported model', runtime: { modelName: 'unknown-reasoner', baseUrl: 'https://tokenhub.tencentmaas.com/v1', reasoningEfforts: ['high'] } },
    { label: 'TokenHub undocumented version', runtime: { modelName: 'deepseek-v4-flash-202606', baseUrl: 'https://tokenhub.tencentmaas.com/v1', reasoningEfforts: ['high'] } },
    { label: 'TokenHub lookalike host', runtime: { modelName: 'deepseek/deepseek-flash', baseUrl: 'https://tokenhub.tencentmaas.com.example/v1', reasoningEfforts: ['high'] } },
    { label: 'TokenHub insecure transport', runtime: { modelName: 'deepseek/deepseek-flash', baseUrl: 'http://tokenhub.tencentmaas.com/v1', reasoningEfforts: ['high'] } },
    { label: 'unknown incomplete capabilities', runtime: { reasoningParameterMode: undefined, thinkingEnabled: undefined, reasoningEfforts: [] } },
    { label: 'official thinking-only reasoner', runtime: { provider: 'deepseek', modelName: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', reasoningParameterMode: undefined, thinkingEnabled: true, reasoningEfforts: ['high'] } },
    { label: 'verified rejection of thinking switch', runtime: { provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1', reasoningEfforts: ['high'] } },
  ] satisfies Array<{ label: string; runtime: Partial<TextRuntime> }>)('rejects $label before usage preparation or paid dispatch', async ({ runtime }) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('规则', '合成完整正文', { userId: 'test', action: 'agent3HumanityCritic',
      modelRuntime: qualityRuntime(runtime), reasoningEffort: 'low' })).rejects.toMatchObject({ code: 'AI_QUALITY_NON_THINKING_UNSUPPORTED' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
  })

  it('keeps the assigned quality model and fixed policy through the actual bounded output recovery', async () => {
    const selected = qualityRuntime({ tier: 'ultimate', provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1',
      reasoningParameterMode: undefined, thinkingEnabled: undefined, multiplierBps: 25000 })
    mocks.runtime.mockResolvedValue(selected)
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => qualityResponse())
      .mockImplementationOnce(async () => qualityResponse('length'))
    vi.stubGlobal('fetch', fetcher)
    const frozen = { version: 1 as const, globalRevision: 2, novelRevision: 0, assignments: { quality: { modelTier: 'ultimate' as const, reasoningEffort: 'high' as const } } }
    const original = structuredClone(frozen)
    await withModelAssignmentContext({ userId: 'test', novelId: 'novel', frozen }, () => generateReviewCompletion('固定审查规则', '合成完整原文首尾', {
      userId: 'test', novelId: 'novel', action: 'agent3HumanityCritic', reasoningEffort: 'low', modelRuntime: qualityRuntime(),
    }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [index, call] of fetcher.mock.calls.entries()) {
      expect(call[0]).toBe('https://api.ant-ling.com/v1/chat/completions')
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ model: 'Ling-3.0-flash', thinking: { type: 'disabled' },
        max_tokens: index === 0 ? 16384 : 32768, messages: [{ role: 'system', content: '固定审查规则' }, { role: 'user', content: '合成完整原文首尾' }] })
      expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty('reasoning_effort')
    }
    expect(mocks.create.mock.calls.map(([arg]) => arg.data.action)).toEqual(['agent3HumanityCritic', 'agent3HumanityCriticOutputRecovery'])
    expect(selected.reasoningEffort).toBe('high')
    expect(frozen).toEqual(original)
  })

  it('preserves the configured main-writing high payload before and after a quality check', async () => {
    const modelRuntime = qualityRuntime({ tier: 'speed', provider: 'Ant Ling', modelName: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1',
      reasoningParameterMode: undefined, thinkingEnabled: undefined })
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => qualityResponse())
    vi.stubGlobal('fetch', fetcher)
    for (const action of ['mainWriting', 'agent3HumanityCritic', 'mainWriting']) await generateTextCompletion('规则', '合成正文', { userId: 'test', action, modelRuntime })
    const bodies = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
    expect(bodies[0]).toEqual(bodies[2])
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' } })
    expect(bodies[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(modelRuntime.reasoningEffort).toBe('high')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each(['standard', 'performance'] as const)('reevaluates the actual alternate %s route without borrowing source protocol', async tier => {
    const unsupported = tier === 'performance'
    const source = qualityRuntime({ tier, provider: 'fixture', modelName: `primary-${tier}`, baseUrl: `https://primary-${tier}.example/v1` })
    mocks.runtime.mockResolvedValue(source)
    mocks.findModel.mockResolvedValue({ id: `quality-${tier}`, tier, provider: source.provider, modelName: source.modelName, baseUrl: source.baseUrl,
      apiKeyCiphertext: source.apiKey, metadata: { routes: [{ id: tier === 'standard' ? '00000000-0000-4000-8000-000000000041' : '00000000-0000-4000-8000-000000000042',
        label: 'alternate', provider: 'deepseek', modelName: 'deepseek-v4-flash', baseUrl: unsupported ? 'https://unknown-quality-proxy.example/v1' : 'https://api.deepseek.com/v1',
        apiKeyCiphertext: 'fixture-alternate', enabled: true }] } })
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => qualityResponse())
      .mockImplementationOnce(async () => new Response('{"error":{"message":"busy"},"usage":{"prompt_tokens":0,"completion_tokens":0}}', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const result = generateTextCompletion('规则', '合成完整正文', { userId: 'test', action: 'agent3HumanityCritic', modelRuntime: source })
    if (unsupported) {
      await expect(result).rejects.toMatchObject({ code: 'AI_QUALITY_NON_THINKING_UNSUPPORTED' })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(mocks.create).toHaveBeenCalledOnce()
    } else {
      await expect(result).resolves.toBe('{"findings":[]}')
      expect(fetcher).toHaveBeenCalledTimes(2)
      const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
      expect(body).toMatchObject({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' } })
      expect(body).not.toHaveProperty('reasoning_effort')
    }
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ reasoning_effort: 'none' })
    expect(source.reasoningParameterMode).toBe('native')
    expect(source.reasoningEffort).toBe('high')
  })
})

describe('explicit zero provider usage is not missing usage', () => {
  it.each(['none', 'high'] as const)('uses the configured Ling %s default for an auxiliary call without changing usage or the route', async reasoningEffort => {
    const modelRuntime = { tier: 'speed' as const, provider: 'Ant Ling', modelName: 'Ling-3.0-flash',
      baseUrl: 'https://api.ant-ling.com/v1', apiKey: 'fixture-not-a-key', reasoningEffort,
      reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>, multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000 }
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: '合成结果' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 },
    })))
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('system', '合成输入', { userId: 'test', action: 'test', modelRuntime })).resolves.toBe('合成结果')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe('https://api.ant-ling.com/v1/chat/completions')
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: 'Ling-3.0-flash', thinking: { type: reasoningEffort === 'none' ? 'disabled' : 'enabled' } })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(modelRuntime.reasoningEffort).toBe(reasoningEffort)
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ requestTokens: 20, responseTokens: 8 }))
  })

  it.each(Object.entries(TEXT_ACTION_TASKS))('routes actual auxiliary %s body through frozen purpose %s and honors effort', async (action, task) => {
    mocks.runtime.mockImplementation(async (tier, _user, _custom, effort) => ({ tier, provider: 'openai', modelName: 'selected-model',
      baseUrl: 'https://selected.example/v1', apiKey: 'fixture-not-a-key', reasoningEffort: effort ?? 'high', reasoningEfforts: ['none', 'low', 'medium', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false,
      multiplierBps: tier === 'custom' ? 0 : 25000, visionEnabled: true, contextWindowTokens: 128000 }))
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '完整结果' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })))
    vi.stubGlobal('fetch', fetcher)
    await withModelAssignmentContext({ userId: 'test', novelId: 'novel', frozen: { version: 1, globalRevision: 1, novelRevision: 0,
      assignments: { [task]: { modelTier: 'ultimate', reasoningEffort: 'high' } } } }, () => generateTextCompletion('isolated-system', '完整正文及上下文', {
      userId: 'test', novelId: 'novel', action, boundedReview: true, multiplierBps: 0,
      modelRuntime: { tier: 'custom', provider: 'openai', modelName: 'old-main', apiKey: 'fixture-not-a-key', baseUrl: 'https://old.example/v1',
        reasoningEffort: 'low', reasoningEfforts: ['low'], multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000 },
    }))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe('https://selected.example/v1/chat/completions')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: 'selected-model', reasoning_effort: task === 'quality' ? 'none' : 'high',
      messages: [{ role: 'system', content: 'isolated-system' }, { role: 'user', content: '完整正文及上下文' }] })
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ modelTier: 'ultimate', multiplierBps: 25000,
      billingSnapshot: { version: 'credits-v1-exact', modelTier: 'ultimate', multiplierBps: 25000 } }) }))
  })
  it.each(['speed', 'custom'] as const)('sends non-thinking critic requests for %s without changing the selected model or main-turn effort', async tier => {
    const runtime = { tier, provider: 'deepseek', modelName: 'deepseek-flash', apiKey: 'fixture-not-a-key', baseUrl: 'https://fixture.test/v1',
      reasoningEffort: 'high' as const, reasoningEfforts: ['low', 'high'] as const, thinkingEnabled: true, reasoningParameterMode: 'native' as const,
      multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000 }
    const fetcher = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"{\\"findings\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":8}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    await generateTextCompletion('system', '完整正文', { userId: 'test', action: 'agent3ContinuityCritic', boundedReview: true, maxOutputTokens: 16384,
      modelRuntime: { ...runtime, reasoningEfforts: [...runtime.reasoningEfforts] } })
    await chatWithTools({ messages: [{ role: 'user', content: '完整正文' }], tools: [], ...runtime, model: runtime.modelName,
      providerApiKey: runtime.apiKey, providerBaseUrl: runtime.baseUrl, boundedReview: true, usageLog: { userId: 'test', action: 'continuity_critic', modelTier: tier, multiplierBps: 0 } })
    for (const call of vi.mocked(fetch).mock.calls) {
      const body = JSON.parse(String(call[1]?.body))
      expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
      expect(body.reasoning_effort).toBeUndefined()
    }
    expect(runtime.reasoningEffort).toBe('high')
  })
  it.each([429, 500, 503])('routes a rejected HTTP %s request to another configured account', async status => {
    const primary = { id: `primary-${status}`, tier: 'speed', provider: 'openai', modelName: 'fixture', baseUrl: 'https://primary.test/v1', apiKeyCiphertext: 'fixture-not-a-key', metadata: { routes: [{ id: `00000000-0000-4000-8000-000000000${status}`, label: 'backup', provider: 'openai', modelName: 'backup', baseUrl: 'https://backup.test/v1', apiKeyCiphertext: 'other-fixture-key', enabled: true }] } }
    mocks.findModel.mockResolvedValue(primary)
    mocks.runtime.mockResolvedValue({ tier: 'speed', apiKey: 'fixture-not-a-key', baseUrl: primary.baseUrl, provider: 'openai', reasoningEffort: 'high', multiplierBps: 10000, modelName: 'fixture' })
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' }, usage: { prompt_tokens: 0, completion_tokens: 0 } }), { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '完整结果' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })))
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).resolves.toBe('完整结果')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1].headers.Authorization).not.toBe(fetcher.mock.calls[1][1].headers.Authorization)
  })
  it('does not treat a valid-looking truncated JSON gateway report as complete', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 8192 } })))
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('system', 'chapter', { userId: 'test', action: 'quality', maxOutputTokens: 8192 })).rejects.toMatchObject({ code: 'AI_PROVIDER_OUTPUT_LIMIT' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ responseTokens: 8192 }))
  })
  it('reserves room for thinking and the final continuity JSON, preserving reported usage above the generic ceiling', async () => {
    const fetcher = vi.fn(async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"检查过程"}}]}\n\ndata: {"choices":[{"delta":{"content":"{\\"findings\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":9000}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('system', '完整正文', { userId: 'test', action: 'agent3ContinuityCritic', maxOutputTokens: 16_384, reasoningEffort: 'low' })).resolves.toBe('{"findings":[]}')
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ max_tokens: 16_384, reasoning_effort: 'low' })
    expect(body.messages[1].content).toBe('完整正文')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ responseTokens: 9000 }))
  })
  it('sends MiMo the thinking switch and an enforceable max_completion_tokens budget instead of the ignored max_tokens', async () => {
    const fetcher = vi.fn(async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"核对过程"}}]}\n\ndata: {"choices":[{"delta":{"content":"{\\"findings\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":9000,"completion_tokens_details":{"reasoning_tokens":6000}}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    mocks.runtime.mockResolvedValue({ tier: 'standard', apiKey: 'fixture-not-a-key', provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', reasoningEffort: 'low', multiplierBps: 0, modelName: 'mimo-v2.6-flash' })
    await expect(generateTextCompletion('system', '完整正文', { userId: 'test', action: 'agent3ContinuityCritic', maxOutputTokens: 16_384, reasoningEffort: 'low' })).resolves.toBe('{"findings":[]}')
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.max_completion_tokens).toBe(16_384)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ responseTokens: 9000 }))
  })
  it('aborts a silent MiMo stream after the idle window instead of waiting for the whole call deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n'))
        // 之后保持静默，模拟网关挂死
      } }), { headers: { 'content-type': 'text/event-stream' } }))
      vi.stubGlobal('fetch', fetcher)
      mocks.runtime.mockResolvedValue({ tier: 'standard', apiKey: 'fixture-not-a-key', provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', reasoningEffort: 'low', multiplierBps: 0, modelName: 'mimo-v2.6-flash' })
      const result = generateTextCompletion('system', '完整正文', { userId: 'test', action: 'agent3ContinuityCritic', maxOutputTokens: 16_384, reasoningEffort: 'low' })
      const assertion = expect(result).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(env.aiTextStreamIdleMs)
      await assertion
      expect(fetcher).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('classifies gateway HTML timeouts without reporting a malformed quality report or redispatching', async () => {
    const fetcher = vi.fn(async () => new Response('<html>Gateway Timeout</html>', { status: 504 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('system', 'chapter', { userId: 'test', action: 'quality' })).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.charge).not.toHaveBeenCalled()
    const body = JSON.parse((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].body as string)
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(body.max_tokens).toBeGreaterThan(0) // Explicit output budget matches admission instead of the provider's smaller default.
  })
  it('keeps estimated evidence separate from absent provider usage on successful output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '完整报告' } }] }))))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).resolves.toBe('完整报告')
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: null, responseTokens: null, usageSource: 'estimated' }) }))
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ billingEvidence: expect.objectContaining({ responseObserved: true, outputEstimate: 4 }) }) }))
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ requestTokens: 0, responseTokens: 0 })) // Settlement reads the saved evidence, not fabricated provider totals.
  })
  it('preserves partial auxiliary output counts on a broken SSE stream without returning a completed report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"已收到的片段"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).rejects.toThrow('连接提前结束')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ billingEvidence: expect.objectContaining({ responseObserved: true, outputEstimate: 6 }) }) }))
    expect(mocks.charge).not.toHaveBeenCalled()
  })
  it('settles a complete SSE auxiliary response using reported usage', async () => {
    const frames = 'data: {"choices":[{"delta":{"content":"完整报告"}}]}\n\ndata: {"usage":{"prompt_tokens":100,"completion_tokens":20},"choices":[]}\n\ndata: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } })))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).resolves.toBe('完整报告')
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ requestTokens: 100, responseTokens: 20 }))
  })
  it('accepts a provider-confirmed stop without a DONE marker, but keeps missing usage separate', async () => {
    const frames = 'data: {"choices":[{"delta":{"content":"完整报告"},"finish_reason":"stop"}]}\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } })))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).resolves.toBe('完整报告')
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: null, responseTokens: null }) }))
  })
  it('releases a provider-rejected auxiliary request rather than holding the account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"rate limited"}}', { status: 429 })))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).rejects.toThrow('每分钟请求或 Token 限制')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { billingStatus: 'provider_rejected', reservedCreditMilli: 0, reservationExpiresAt: null } }))
    expect(mocks.charge).not.toHaveBeenCalled()
  })
  it('routes an internal BYOK completion to its own provider and never charges platform credits', async () => {
    const modelRuntime = { tier: 'custom' as const, apiKey: 'fixture-custom', provider: 'openai',
      baseUrl: 'https://custom.example/v1', modelName: 'custom-model', multiplierBps: 0,
      reasoningEffort: 'high' as const, reasoningEfforts: ['high' as const], visionEnabled: false, contextWindowTokens: null }
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '自定义质量报告' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } })))
    vi.stubGlobal('fetch', fetcher)
    await expect(generateTextCompletion('system', 'chapter', { userId: 'owner', action: 'quality', modelRuntime, reasoningEffort: 'low' })).resolves.toBe('自定义质量报告')
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.access).toHaveBeenCalledWith('owner', 'custom', false)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://custom.example/v1/chat/completions')
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ modelTier: 'custom', multiplierBps: 0, billingSnapshot: { version: 'byok-exempt' } }) }))
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ billingStatus: 'exempt' }) }))
    expect(mocks.charge).not.toHaveBeenCalled()
  })
  it('aborts auxiliary requests immediately without dispatching a retry or billing unknown usage as zero', async () => {
    const controller = new AbortController()
    const fetching = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal)
      controller.abort()
      init.signal!.throwIfAborted()
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetching)
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetching).toHaveBeenCalledOnce()
    expect(mocks.charge).not.toHaveBeenCalled()
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetching).toHaveBeenCalledOnce()
  })
  it('returns generated output while retaining a failed settlement for recovery', async () => {
    mocks.charge.mockRejectedValueOnce(new Error('wallet unavailable'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '已保存用量的完整结果' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }))))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).resolves.toBe('已保存用量的完整结果')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ billingStatus: 'pending_settlement' }) }))
  })
  it('requires the original price snapshot to persist before any provider dispatch', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    mocks.create.mockRejectedValueOnce(new Error('snapshot unavailable'))
    await expect(chatWithTools({ messages: [], tools: [], providerApiKey: 'fixture', usageLog: { userId: 'test', action: 'test' } })).rejects.toThrow('snapshot unavailable')
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
  })
  it.each([0, -1, 5, 1.5, NaN, Infinity])('rejects invalid shared-service image count %s before charging', async count => {
    await expect(generateCoverImageData('test', { prompt: '封面测试', size: '768x1024', count })).rejects.toThrow()
    expect(mocks.imageCharge).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('checks image novel ownership before any charge or provider dispatch', async () => {
    mocks.owner.mockRejectedValue(new Error('not owned'))
    await expect(generateCoverImageData('test', { prompt: '封面测试', size: '768x1024', count: 1, novelId: 'other-novel' })).rejects.toThrow('not owned')
    expect(mocks.owner).toHaveBeenCalledWith('test', 'other-novel')
    expect(mocks.imageCharge).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each(['empty', 'http-error', 'missing-usage'] as const)('30 CR02: non-streaming %s preserves only reported usage', async scenario => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }],
      ...(scenario === 'missing-usage' ? {} : { usage: { prompt_tokens: 12, completion_tokens: 0 } }) }), { status: scenario === 'http-error' ? 502 : 200 })))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).rejects.toThrow()
    if (scenario === 'missing-usage') {
      expect(mocks.create).toHaveBeenCalledOnce()
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ usageSource: 'prepared' }) }))
      expect(mocks.update).not.toHaveBeenCalled()
      expect(mocks.charge).not.toHaveBeenCalled()
    } else {
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 12, responseTokens: 0 }) }))
      expect(mocks.charge).toHaveBeenCalledOnce()
    }
  })

  it('30 CR01: non-streaming paid output also survives exact exhaustion', async () => {
    mocks.charge.mockResolvedValue({ chargedMilli: 10, remainingMilli: 0, exhausted: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '完整结果' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }))))
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).resolves.toBe('完整结果')
  })

  it.each(['bad-frame', 'provider-error', 'early-eof', 'read-error', 'abort'] as const)('30 CR02: preserves observed usage on %s without returning partial tools', async failure => {
    const controller = new AbortController()
    const first = `data: ${JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
      choices: [{ delta: { content: '尚未完成' } }] })}\n\n`
    const tail = failure === 'bad-frame' ? 'data: {broken\n\n' : failure === 'provider-error' ? 'data: {"error":{"message":"failed"}}\n\n' : ''
    const reader = { read: vi.fn().mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(first + tail) }), cancel: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn() }
    if (failure === 'read-error') reader.read.mockRejectedValueOnce(new Error('connection failed'))
    else reader.read.mockResolvedValue({ done: true })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: { getReader: () => reader } })))
    await expect(chatWithTools({ messages: [{ role: 'user', content: 'test' }], tools: [], providerApiKey: 'fixture-not-a-key', signal: controller.signal,
      usageLog: { userId: 'test', action: 'test' }, onChunk: () => {
        if (failure === 'abort') { controller.abort(); throw new DOMException('stopped', 'AbortError') }
      } })).rejects.toThrow()
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 12, responseTokens: 0 }) }))
    expect(mocks.charge).toHaveBeenCalledOnce()
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(reader.releaseLock).toHaveBeenCalledOnce()
  })

  it('30 CR02: missing output usage stays unknown rather than an estimate of partial output', async () => {
    const onUsage = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"usage":{"prompt_tokens":12},"choices":[]}\n\ndata: {broken\n\n')))
    await expect(chatWithTools({ messages: [{ role: 'user', content: 'test' }], tools: [], providerApiKey: 'fixture-not-a-key',
      usageLog: { userId: 'test', action: 'test' }, onUsage })).rejects.toThrow()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 12, responseTokens: null }) }))
    expect(onUsage).toHaveBeenCalledOnce()
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 12, completionTokens: null, totalTokens: null })
  })

  it('30 CR06: a later invalid usage frame cannot replace earlier trusted usage', async () => {
    await expect(invoke([{ prompt_tokens: 12, completion_tokens: 3 }, { prompt_tokens: -1, completion_tokens: 3 }])).rejects.toThrow()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 12, responseTokens: 3 }) }))
    expect(mocks.charge).toHaveBeenCalledOnce()
  })

  it('30 CR01: delivers paid tool arguments at zero balance and blocks the next provider request', async () => {
    mocks.charge.mockResolvedValue({ chargedMilli: 10, remainingMilli: 0, exhausted: true })
    const args = JSON.stringify({ tasks: [{ title: '已付费的场景参数' }] })
    const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'scene', type: 'function', function: { name: 'scene_task_build', arguments: args } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }
    const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`))
    vi.stubGlobal('fetch', fetcher)
    const params = { messages: [{ role: 'user' as const, content: '建立场景' }], tools: [], providerApiKey: 'fixture-not-a-key', usageLog: { userId: 'test', action: 'test' } }
    const result = await chatWithTools(params)
    expect(result.toolCalls).toContainEqual(expect.objectContaining({ id: 'scene', name: 'scene_task_build', arguments: args }))
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ usageLogId: 'test-usage', requestTokens: 20, responseTokens: 30 }))
    expect(mocks.update).toHaveBeenCalledOnce() // Observation updates the prepared record; no separate charge display write.
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty('creditChargeMilli')
    mocks.access.mockRejectedValueOnce(new Error('credits unavailable'))
    await expect(chatWithTools(params)).rejects.toThrow('credits unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.charge).toHaveBeenCalledOnce()
  })

  it.each([[1, 0], [0, 1], [0, 0]])('preserves P=%i O=%i in the result, usage log and charge input', async (p, o) => {
    const result = await invoke([{ prompt_tokens: p, completion_tokens: o, total_tokens: p + o }])
    expect(result.usage).toMatchObject({ promptTokens: p, completionTokens: o, totalTokens: p + o })
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: p, responseTokens: o }) }))
    expect(mocks.charge).toHaveBeenCalledWith(expect.objectContaining({ requestTokens: p, responseTokens: o }))
  })

  it('keeps earlier explicit zero when later frames omit the field', async () => {
    const result = await invoke([{ prompt_tokens: 1, completion_tokens: 0 }, { prompt_cache_hit_tokens: 0, prompt_tokens: 1 }])
    expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 0 })
  })

  it('preserves the legacy missing-usage estimate until durable measurement provenance is connected', async () => {
    const result = await invoke([{}])
    expect(result.usage.promptTokens).toBeGreaterThan(0)
    expect(mocks.create).toHaveBeenCalledOnce()
  })
})
