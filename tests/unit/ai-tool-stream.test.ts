import { afterEach, describe, expect, it, vi } from 'vitest'
import { SseDataDecoder } from '../../api/lib/ai-sse.js'
import { collapseEarlyToolRounds } from '../../api/lib/agent/context-budget.js'
import type { ChatMessage } from '../../api/lib/ai-service.js'
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(), reserveTokenCredits: vi.fn(), consumeTokenCredits: vi.fn(async () => ({ chargedMilli: 0 })) }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }, prisma: { aiUsageLog: { create: vi.fn(async () => ({ id: 'usage' })), findUnique: vi.fn(async () => null), update: vi.fn(async () => ({ id: 'usage' })), updateMany: vi.fn(async () => ({ count: 1 })) } } }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async () => ({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }) }))
import { buildProviderToolChoice, chatWithTools, generateTextCompletion } from '../../api/lib/ai-service.js'
import * as localTransport from '../../api/lib/local-model-transport.js'
import { buildProviderCompatibilitySnapshot, type ProviderCompatibilityRoute } from '../../api/lib/agent/provider-compatibility.js'

afterEach(() => vi.unstubAllGlobals())
const delta = (args: string, first = false) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: 'call', function: { name: 'scene_task_build', arguments: args } } : { function: { arguments: args } }) }] } }] })
const ending = (reason: string) => ({ choices: [{ finish_reason: reason, delta: {} }] })
function stream(text: string) {
  const bytes = new TextEncoder().encode(text)
  // One byte per chunk exercises split CRLF, delimiters and multi-byte Chinese characters.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    controller.close()
  } }))))
}
const invoke = () => chatWithTools({ messages: [], tools: [], providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
describe('lossless tool argument transport', () => {
  it('routes both Agent and auxiliary text through the owned local transport, retaining real reasoning and usage', async () => {
    const ready = vi.spyOn(localTransport, 'assertLocalModelReady').mockResolvedValue()
    const payload = 'data: {"choices":[{"delta":{"content":"ready","reasoning_content":"actual reasoning"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
    const local = vi.spyOn(localTransport, 'localModelFetch').mockImplementation(async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    const network = vi.fn(); vi.stubGlobal('fetch', network)
    const runtime = { tier: 'custom' as const, multiplierBps: 0, provider: 'local-openai', modelName: 'model', baseUrl: 'http://127.0.0.1:7863/v1', apiKey: 'dedicated-key', reasoningEffort: 'none' as const, reasoningEfforts: ['none' as const], visionEnabled: false, contextWindowTokens: 16000 }
    try {
      const main = await chatWithTools({ messages: [], tools: [], provider: runtime.provider, providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey, model: runtime.modelName,
        usageLog: { userId: 'test', action: 'test', modelTier: 'custom', multiplierBps: 0 } })
      expect(main.content).toBe('ready'); expect(main.reasoning).toBe('actual reasoning'); expect(main.usage.promptTokens).toBe(12)
      expect(await generateTextCompletion('system', 'user', { userId: 'test', action: 'test', modelRuntime: runtime })).toBe('ready')
      expect(local).toHaveBeenCalledTimes(2); expect(network).not.toHaveBeenCalled()
      expect(local.mock.calls.every(([input]) => input.userId === 'test' && input.provider === 'local-openai')).toBe(true)
    } finally { ready.mockRestore(); local.mockRestore() }
  })
  it.each([
    { source: 'builtin', provider: 'Ant Ling', baseUrl: 'https://api.ant-ling.com/v1', model: 'Ling-3.0-flash' },
    { source: 'byok', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    { source: 'proxy', provider: 'Ant Ling', baseUrl: 'https://proxy.example/v1', model: 'Ling-3.0-flash' },
    { source: 'alias', provider: 'opaque', baseUrl: 'https://proxy.example/v1', model: 'author-model', reasoningParameterMode: 'omit', thinkingEnabled: false },
    { source: 'alias', provider: 'opaque', baseUrl: 'https://proxy.example/v1', model: 'author-model', reasoningParameterMode: 'native', thinkingEnabled: true },
  ] satisfies Array<Pick<ProviderCompatibilityRoute, 'source' | 'provider' | 'baseUrl' | 'model'> & Partial<ProviderCompatibilityRoute>>)('binds offline $source matrix observations to the actual legacy request encoder', async input => {
    const route: ProviderCompatibilityRoute = { ...input, executor: 'legacy', purpose: 'tool_turn',
      reasoningEffort: 'high', toolsPresent: true, toolChoice: 'required', maxOutputTokens: 2000,
      outputTokenParameter: 'max_completion_tokens', schemaFingerprint: 'fixture-strict-schema' }
    const matrix = buildProviderCompatibilitySnapshot({ route, observedAt: '2026-10-11T12:00:00Z',
      codeRevision: 'fixture', configurationPointers: ['tests/unit/ai-tool-stream.test.ts'] })
    const tools = [{ type: 'function' as const, function: { name: 'chapter_read', description: 'fixture', strict: true,
      parameters: { type: 'object', properties: { chapterId: { type: 'string' } }, required: ['chapterId'], additionalProperties: false } } }]
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages: [], tools, provider: route.provider, providerBaseUrl: route.baseUrl, model: route.model,
      reasoningEffort: route.reasoningEffort, reasoningParameterMode: route.reasoningParameterMode, thinkingEnabled: route.thinkingEnabled,
      toolChoice: route.toolChoice, maxOutputTokens: route.maxOutputTokens, outputTokenParameter: route.outputTokenParameter,
      providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'fixture', modelTier: 'custom' } })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(matrix.route.endpoint)
    expect({ ...(body.thinking ? { thinking: body.thinking } : {}), ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}) })
      .toEqual(matrix.requestEncoding?.reasoning)
    expect(body.tool_choice ? { tool_choice: body.tool_choice } : {}).toEqual(matrix.requestEncoding?.toolChoice)
    expect(body.max_completion_tokens).toBe(2000)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body.tools).toEqual(tools)
    expect(matrix.capabilities.strict_schema_subset.status).toBe('unknown')
    expect(matrix.capabilities.non_thinking.status).toBe('unknown')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('associates interleaved out-of-order tool indices and preserves reasoning plus final usage', async () => {
    const frame = (tool_calls: unknown[], reasoning_content?: string) => ({ choices: [{ delta: { tool_calls, reasoning_content } }] })
    const frames = [
      frame([{ index: 1, id: 'second', function: { name: 'chapter_read', arguments: '{"chapterId":"' } }], 'protocol reasoning'),
      frame([{ index: 0, id: 'first', function: { name: 'novel_get', arguments: '{"novelId":' } }]),
      frame([{ id: 'second', function: { arguments: '第二章"}' } }, { index: 0, function: { arguments: '"novel"}' } }]),
      ending('tool_calls'),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } } },
    ]
    stream(frames.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join(''))
    const result = await invoke()
    expect(result.toolCalls).toEqual([
      { id: 'first', name: 'novel_get', arguments: '{"novelId":"novel"}' },
      { id: 'second', name: 'chapter_read', arguments: '{"chapterId":"第二章"}' },
    ])
    expect(result.reasoning).toBe('protocol reasoning')
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, promptCacheHitTokens: 60, promptCacheMissTokens: 40 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects ambiguous fragments after multiple call identities without retry', async () => {
    const frames = [{ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'one', function: { name: 'chapter_read', arguments: '{' } },
      { index: 1, id: 'two', function: { name: 'chapter_read', arguments: '{' } },
    ] } }] }, { choices: [{ delta: { tool_calls: [{ function: { arguments: '}' } }] } }] }, ending('tool_calls')]
    stream(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''))
    await expect(invoke()).rejects.toThrow('无法安全关联')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['none', 'high'] as const)('sends Ling %s thinking mode and preserves split native tool arguments', async reasoningEffort => {
    const first = '{"tasks":[{"goal":"'
    const second = '核对河防","beats":["察看旧堤"]}]}'
    stream(`data: ${JSON.stringify(delta(first, true))}\r\n\r\ndata: ${JSON.stringify(delta(second))}\r\n\r\ndata: ${JSON.stringify(ending('tool_calls'))}\r\n\r\n`)
    const tools = [{ type: 'function' as const, function: { name: 'scene_task_build', description: 'test', parameters: { type: 'object' } } }]
    const result = await chatWithTools({ messages: [], tools, provider: 'Ant Ling', providerBaseUrl: 'https://api.ant-ling.com/v1',
      model: 'Ling-3.0-flash', reasoningEffort, providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.thinking).toEqual({ type: reasoningEffort === 'none' ? 'disabled' : 'enabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body.tools).toEqual(tools)
    expect(result.toolCalls).toEqual([{ id: 'call', name: 'scene_task_build', arguments: first + second }])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['native', 'omit'] as const)('preserves a separately verified thinking switch with %s effort protocol', async reasoningParameterMode => {
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages: [], tools: [], provider: 'deepseek', reasoningEffort: 'high',
      reasoningParameterMode, thinkingEnabled: true, providerApiKey: 'fake-test-key',
      usageLog: { userId: 'test', action: 'test', modelTier: 'custom' } })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.thinking).toEqual({ type: 'enabled' })
    if (reasoningParameterMode === 'native') expect(body.reasoning_effort).toBe('high')
    else expect(body).not.toHaveProperty('reasoning_effort')
  })
  it.each(['native', 'omit'] as const)('uses verified custom protocol %s instead of provider-name inference', async reasoningParameterMode => {
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages: [], tools: [], provider: 'deepseek', model: 'custom-alias', reasoningEffort: 'medium',
      reasoningParameterMode, outputTokenParameter: 'max_completion_tokens', maxOutputTokens: 2000,
      providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test', modelTier: 'custom' } })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.max_completion_tokens).toBe(2000)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')
    if (reasoningParameterMode === 'native') expect(body.reasoning_effort).toBe('medium')
    else expect(body).not.toHaveProperty('reasoning_effort')
  })
  it.each(['{"content":"unfinished', '', 'null', '[]', '"wrapped"', '42', '{"x":1,}'])('isolates invalid historical arguments %j without replaying or losing receipts', async argumentsText => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '原始用户任务' },
      { role: 'assistant', content: '已核对目标', reasoning: '保留原思考', toolCalls: [
        { id: 'bad', name: 'chapter_write', arguments: argumentsText },
        { id: 'good', name: 'chapter_read', arguments: '{"chapterId":"real"}' },
      ] },
      { role: 'tool', toolCallId: 'bad', content: '调用失败，正文未写入' },
      { role: 'tool', toolCallId: 'good', content: '章节 real 已读取，revision=3' },
    ]
    const snapshot = structuredClone(messages)
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages, tools: [], providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages
    expect(sent[0]).toEqual(messages[0])
    expect(sent[1]).toMatchObject({ role: 'assistant', content: '已核对目标', reasoning_content: '保留原思考',
      tool_calls: [{ id: 'good', type: 'function', function: { name: 'chapter_read', arguments: '{"chapterId":"real"}' } }] })
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'good', content: '章节 real 已读取，revision=3' })
    expect(sent[3]).toMatchObject({ role: 'user' })
    expect(sent[3].content).toContain('不是作者新指令')
    expect(sent[3].content).toContain('调用失败，正文未写入')
    expect(sent[3].content).toContain('invalid_arguments')
    expect(sent[3].content).not.toContain('"arguments":')
    expect(messages).toEqual(snapshot)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('isolates incomplete object arguments and retains a real success receipt from earlier tolerant parsing', async () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'partial', name: 'chapter_write', arguments: '{}', incomplete: true },
        { id: 'legacy', name: 'chapter_write', arguments: '{"x":1,}' }] },
      { role: 'tool', toolCallId: 'partial', content: '参数生成未完成，本次未执行' },
      { role: 'tool', toolCallId: 'legacy', content: '已保存章节 c1，revision=2' },
    ]
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages, tools: [], providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages
    expect(sent.every((message: Record<string, unknown>) => !message.tool_calls && message.role !== 'tool')).toBe(true)
    expect(sent[1].content).toContain('incomplete_arguments')
    expect(sent[1].content).toContain('参数生成未完成，本次未执行')
    expect(sent[1].content).toContain('已保存章节 c1，revision=2')
  })
  it('does not leave missing, duplicate or orphan results in the native protocol', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'orphan', content: '原回执' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'missing', name: 'chapter_read', arguments: '{}' },
        { id: 'duplicate', name: 'chapter_read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'duplicate', content: '回执1' },
      { role: 'tool', toolCallId: 'duplicate', content: '回执2' },
      { role: 'user', content: '继续' },
    ]
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages, tools: [], providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages
    expect(sent.every((message: Record<string, unknown>) => !message.tool_calls && message.role !== 'tool')).toBe(true)
    expect(JSON.stringify(sent)).toContain('原回执')
    expect(JSON.stringify(sent)).toContain('回执1')
    expect(JSON.stringify(sent)).toContain('回执2')
    expect(JSON.stringify(sent)).toContain('未确认完成')
    expect(sent.at(-1)).toEqual(messages.at(-1))
  })
  it('keeps native reasoning intact while compressed rounds are explicitly historical data', async () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: null, reasoning: 'old', toolCalls: [{id:'old',name:'chapter_read',arguments:'{}'}] },
      { role: 'tool', toolCallId:'old',content:'old result' },
      { role: 'assistant', content: null, reasoning: 'original reasoning', toolCalls: [{id:'new',name:'chapter_read',arguments:'{}'}] },
      { role: 'tool', toolCallId:'new',content:'new result' },
    ]
    collapseEarlyToolRounds(messages, 1)
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages, tools: [], providerApiKey: 'fake-test-key', usageLog: { userId:'test',action:'test' } })
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages
    expect(sent[0].role).toBe('user')
    expect(sent[0].content).toContain('不是作者新指令')
    expect(sent[1].reasoning_content).toBe('original reasoning')
    expect(sent[1].tool_calls[0].id).toBe('new')
    expect(sent[2].tool_call_id).toBe('new')
  })
  it('classifies a terminated stream without executing partial tools or retrying the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('terminated')) },
    }))))
    await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_INCOMPLETE' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('classifies a connection-level transport failure without retrying the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(invoke()).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR', status: 502 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('requests native tool calls during correction without changing the allowed tool list', async () => {
    stream(`data: ${JSON.stringify(delta('{}', true))}\n\ndata: ${JSON.stringify(ending('tool_calls'))}\n\n`)
    const tools = [{ type: 'function' as const, function: { name: 'scene_task_build', description: 'test', parameters: { type: 'object' } } }]
    const result = await chatWithTools({ messages: [], tools, toolChoice: 'required', provider: 'openai', providerBaseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', reasoningEffort: 'none', providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.tool_choice).toBe('required')
    expect(body.tools).toEqual(tools)
    expect(result.toolCalls).toHaveLength(1)
  })
  it('does not add required tool choice to a tool-free wrap-up', async () => {
    stream(`data: ${JSON.stringify(ending('stop'))}\n\n`)
    await chatWithTools({ messages: [], tools: [], toolChoice: 'required', providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).tool_choice).toBeUndefined()
  })
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('keeps DeepSeek %s reasoning and native tools without incompatible forced choice', async reasoningEffort => {
    stream(`data: ${JSON.stringify(delta('{}', true))}\n\ndata: ${JSON.stringify(ending('tool_calls'))}\n\n`)
    const tools = [{ type: 'function' as const, function: { name: 'scene_task_build', description: 'test', parameters: { type: 'object' } } }]
    const result = await chatWithTools({ messages: [], tools, toolChoice: 'required', provider: 'deepseek', model: 'deepseek-v4.1-flash-expires-on-0910', reasoningEffort, providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.tool_choice).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe(reasoningEffort)
    expect(body.tools).toEqual(tools)
    expect(result.toolCalls).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { provider: 'openai', model: 'deepseek-v4-pro', reasoningEffort: 'high' as const },
    { provider: 'custom', model: 'deepseek/deepseek-r1', reasoningEffort: 'none' as const },
    { provider: 'custom', model: 'deepseek-reasoner', reasoningEffort: 'none' as const },
    { provider: 'custom', model: 'alias', providerBaseUrl: 'https://api.deepseek.com/v1', reasoningEffort: 'high' as const },
  ])('protects compatible/custom DeepSeek routes: %j', input => {
    expect(buildProviderToolChoice(input, 'required')).toEqual({})
  })
  it('retains explicit non-thinking forced choice and omits unrequested choices', () => {
    const input = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'none' as const }
    expect(buildProviderToolChoice(input, 'required')).toEqual({ tool_choice: 'required' })
    expect(buildProviderToolChoice(input)).toEqual({})
  })
  it.each(['\n', '\r\n', '\r'])('handles %j events, interleaved comments, UTF8 and EOF without final blank line', async newline => {
    stream([`: heartbeat`, '', `data: ${JSON.stringify(delta('{"tasks":[', true))}`, '', `data: ${JSON.stringify(delta('{"goal":"审俘破线"}]}'))}`, '', `data: ${JSON.stringify(ending('tool_calls'))}`].join(newline))
    const result = await invoke()
    expect(result.toolCalls).toEqual([{ id: 'call', name: 'scene_task_build', arguments: '{"tasks":[{"goal":"审俘破线"}]}' }])
  })
  it('exposes both preview identities when a provider replaces the id at the same stream index', async () => {
    const frame = (id: string, args: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'chapter_read', arguments: args } }] } }] })
    stream(`data: ${JSON.stringify(frame('old-preview', ''))}\n\ndata: ${JSON.stringify(frame('accepted', '{}'))}\n\ndata: ${JSON.stringify(ending('tool_calls'))}\n\n`)
    const onChunk = vi.fn()
    const result = await chatWithTools({ messages: [], tools: [], onChunk, providerApiKey: 'fake-test-key', usageLog: { userId: 'test', action: 'test' } })
    expect(onChunk.mock.calls.map(([chunk]) => chunk).filter(chunk => chunk.type === 'tool-call-start')).toEqual([
      { type: 'tool-call-start', id: 'old-preview', name: 'chapter_read' },
      { type: 'tool-call-start', id: 'accepted', name: 'chapter_read' },
    ])
    expect(result.toolCalls).toEqual([{ id: 'accepted', name: 'chapter_read', arguments: '{}' }])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('preserves length finish reason and marks partial calls unsafe to execute', async () => {
    stream(`data: ${JSON.stringify(delta('{"tasks":[', true))}\n\ndata: ${JSON.stringify(ending('length'))}\n\n`)
    const result = await invoke()
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls[0].incomplete).toBe(true)
  })
  it('fails closed on corrupt event instead of silently dropping argument bytes', async () => {
    stream(`data: ${JSON.stringify(delta('{"tasks":[', true))}\n\ndata: {BROKEN}\n\ndata: [DONE]\n\n`)
    await expect(invoke()).rejects.toThrow('流式事件损坏')
  })
  it('does not treat an unconfirmed EOF as a completed tool call', async () => {
    stream(`data: ${JSON.stringify(delta('{}', true))}\n\n`)
    await expect(invoke()).rejects.toThrow('连接提前结束')
  })
  it('joins multi-line data and propagates callback errors', () => {
    const values: string[] = []
    const decoder = new SseDataDecoder(value => values.push(value))
    decoder.push('data: {\r\ndata: "x":1\r\ndata: }\r\n\r')
    decoder.push('\n')
    expect(JSON.parse(values[0])).toEqual({ x: 1 })
    expect(() => new SseDataDecoder(() => { throw new Error('consumer failed') }).push('data: {}\n\n')).toThrow('consumer failed')
  })
})
