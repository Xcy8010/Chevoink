import { afterEach, describe, expect, it, vi } from 'vitest'
import { SseDataDecoder } from '../../api/lib/ai-sse.js'
import { collapseEarlyToolRounds } from '../../api/lib/agent/context-budget.js'
import type { ChatMessage } from '../../api/lib/ai-service.js'
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(), reserveTokenCredits: vi.fn(), consumeTokenCredits: vi.fn(async () => ({ chargedMilli: 0 })) }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }, prisma: { aiUsageLog: { create: vi.fn(async () => ({ id: 'usage' })), update: vi.fn(async () => ({ id: 'usage' })), updateMany: vi.fn(async () => ({ count: 1 })) } } }))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async () => ({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }) }))
import { buildProviderToolChoice, chatWithTools } from '../../api/lib/ai-service.js'

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
