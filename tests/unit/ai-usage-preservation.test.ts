import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findModel: vi.fn(), create: vi.fn(), charge: vi.fn(), access: vi.fn(), update: vi.fn(), updateMany: vi.fn(), runtime: vi.fn(), imageCharge: vi.fn(), owner: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.access, consumeTokenCredits: mocks.charge, reserveTokenCredits: vi.fn(), consumeCredits: mocks.imageCharge, getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/data-access.js', () => ({ ensureNovelOwner: mocks.owner, createCoverAssetsData: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }, prisma: { aiModelConfig: { findFirst: mocks.findModel }, aiUsageLog: { create: mocks.create, update: mocks.update, updateMany: mocks.updateMany } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async () => ({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }) }))
import { chatWithTools, generateTextCompletion, generateCoverImageData } from '../../api/lib/ai-service.js'

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

describe('explicit zero provider usage is not missing usage', () => {
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
    await expect(generateTextCompletion('system', 'user', { userId: 'test', action: 'test' })).rejects.toThrow('rate limited')
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
