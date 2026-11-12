import { describe, expect, it } from 'vitest'
import { buildResponsesToolRequest, createResponsesToolFrameAdapter, responsesUsageToChat } from '../../api/lib/ai-responses-tools.js'
import { requiresResponsesToolProtocol, resolveResponsesEndpoint } from '../../api/lib/ai-responses-route.js'

describe('tool protocol selection', () => {
  const baseUrl = 'https://api.openai.com/v1'
  it.each(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'])('uses the documented Responses route for %s', model => {
    expect(resolveResponsesEndpoint({ model, baseUrl, reasoningEffort: 'high' })).toBe(baseUrl + '/responses')
  })
  it.each(['gpt-6-sol', 'gpt-6-luna'])('retains Chat only for explicit none on %s', model => {
    expect(resolveResponsesEndpoint({ model, baseUrl, reasoningEffort: 'none' })).toBeNull()
    expect(resolveResponsesEndpoint({ model, baseUrl, reasoningEffort: 'none', reasoningParameterMode: 'omit' })).toBe(baseUrl + '/responses')
    expect(resolveResponsesEndpoint({ model, baseUrl, reasoningEffort: 'medium' })).toBe(baseUrl + '/responses')
  })
  it('honors an explicit endpoint override without inferring from aliases or unrelated proxies', () => {
    const model = 'gpt-6.1-terra'
    const proxy = 'https://custom.example/api/v2/'
    expect(resolveResponsesEndpoint({ model, baseUrl: proxy, reasoningEffort: 'high' })).toBeNull()
    expect(resolveResponsesEndpoint({ model: 'author-alias', baseUrl: proxy, reasoningEffort: 'high', toolCallingProtocol: 'responses' }))
      .toBe('https://custom.example/api/v2/responses')
    expect(resolveResponsesEndpoint({ model, baseUrl, reasoningEffort: 'high', toolCallingProtocol: 'chat' })).toBeNull()
    expect(resolveResponsesEndpoint({ model, baseUrl: baseUrl + '?private=value', reasoningEffort: 'high', toolCallingProtocol: 'responses' })).toBeNull()
  })
  it('requires a directional protocol rejection from the provider', () => {
    const detail = 'Function tools with reasoning_effort are not supported in /v1/chat/completions. To use function tools, use /v1/responses.'
    expect(requiresResponsesToolProtocol(400, detail)).toBe(true)
    expect(requiresResponsesToolProtocol(429, detail)).toBe(false)
    expect(requiresResponsesToolProtocol(400, 'The Responses API does not support tools. Use Chat Completions.')).toBe(false)
    expect(requiresResponsesToolProtocol(400, 'Do not use the Responses API for these function tools.')).toBe(false)
    expect(requiresResponsesToolProtocol(400, 'Invalid reasoning effort.')).toBe(false)
  })
})

const call = (id: string, name: string, args: string) => ({
  id, type: 'function', function: { name, arguments: args },
})
const tool = {
  type: 'function' as const,
  function: { name: 'inspect', description: 'Synthetic fixture', parameters: { type: 'object' } },
}
const request = { model: 'synthetic', tools: [tool], maxOutputTokens: 512 }

describe('stateless Responses tool requests', () => {
  it('keeps exact effort, role and content, images, and matching native call receipts', () => {
    const args = '{"chapter":3}'
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: [
        { type: 'text', text: 'review' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
        { type: 'image_url', image_url: { url: 'https://example.invalid/fixture.png' } },
      ] },
      { role: 'assistant', content: 'I will inspect it.', reasoning_content: 'not a Responses message field',
        tool_calls: [call('call_a', 'inspect', args), call('call_b', 'inspect', '{}')] },
      { role: 'tool', tool_call_id: 'call_b', content: 'receipt b' },
      { role: 'tool', tool_call_id: 'call_a', content: 'receipt a' },
    ]
    expect(buildResponsesToolRequest({ ...request, messages, reasoningEffort: 'high', toolChoice: 'required' })).toEqual({
      model: 'synthetic', stream: true, store: false, include: ['reasoning.encrypted_content'],
      max_output_tokens: 512, reasoning: { effort: 'high' },
      tool_choice: 'required', tools: [{ type: 'function', ...tool.function, strict: false }],
      input: [
        { role: 'system', content: 'system' },
        { role: 'user', content: [
          { type: 'input_text', text: 'review' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
          { type: 'input_image', image_url: 'https://example.invalid/fixture.png', detail: 'auto' },
        ] },
        { role: 'assistant', content: 'I will inspect it.' },
        { type: 'function_call', call_id: 'call_a', name: 'inspect', arguments: args },
        { type: 'function_call', call_id: 'call_b', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_b', output: 'receipt b' },
        { type: 'function_call_output', call_id: 'call_a', output: 'receipt a' },
      ],
    })
  })

  it('omits explicitly disabled optional wire fields and does not make an empty assistant item for tools', () => {
    const result = buildResponsesToolRequest({ ...request, tools: [], toolChoice: 'required', messages: [
      { role: 'assistant', content: '', tool_calls: [call('call_a', 'inspect', '{}')] },
      { role: 'tool', tool_call_id: 'call_a', content: 'receipt' },
    ] })
    expect(result).toEqual({ model: 'synthetic', stream: true, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 512, input: [
      { type: 'function_call', call_id: 'call_a', name: 'inspect', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'receipt' },
    ] })
    expect(buildResponsesToolRequest({ ...request, messages: [], reasoningEffort: 'none',
      tools: [{ ...tool, function: { ...tool.function, strict: true } }] })).toMatchObject({
      reasoning: { effort: 'none' }, tools: [{ strict: true }],
    })
  })

  it('rejects orphaned and mismatched tool history before request encoding', () => {
    const assistant = { role: 'assistant', content: '', tool_calls: [call('call_a', 'inspect', '{}')] }
    const result = { role: 'tool', tool_call_id: 'call_b', content: 'different receipt' }
    for (const messages of [[assistant], [result], [assistant, result]]) {
      expect(() => buildResponsesToolRequest({ ...request, messages })).toThrow('未执行工具')
    }
  })
})

const functionItem = (id: string, args = '', status = 'in_progress') => ({
  type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'inspect', arguments: args, status,
})
const added = (index: number, item: ReturnType<typeof functionItem>) =>
  ({ type: 'response.output_item.added', output_index: index, item })
const argumentDelta = (index: number, id: string, delta: string) =>
  ({ type: 'response.function_call_arguments.delta', output_index: index, item_id: 'fc_' + id, delta })
const argumentsDone = (index: number, id: string, args: string) =>
  ({ type: 'response.function_call_arguments.done', output_index: index, item_id: 'fc_' + id, name: 'inspect', arguments: args })
const itemDone = (index: number, item: ReturnType<typeof functionItem>) =>
  ({ type: 'response.output_item.done', output_index: index, item })
const terminal = (output: unknown[], usage: unknown = undefined) =>
  ({ type: 'response.completed', response: { status: 'completed', output, usage } })
const measured = { input_tokens: 50, output_tokens: 12, total_tokens: 62, input_tokens_details: { cached_tokens: 5 } }

describe('Responses stream frames', () => {
  it('adapts interleaved text, reasoning summary and tool calls without duplicating argument suffixes', () => {
    const adapt = createResponsesToolFrameAdapter()
    const first = functionItem('a', '{"x":1}', 'completed'), second = functionItem('b', '{}', 'completed')
    const history = [
      { type: 'response.in_progress', response: { status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'visible ' },
      { type: 'response.reasoning_summary_text.delta', delta: 'summary' },
      added(2, functionItem('b')), added(1, functionItem('a')),
      argumentDelta(1, 'a', '{"x"'), argumentDelta(2, 'b', '{}'),
      argumentsDone(1, 'a', first.arguments), itemDone(1, first), argumentsDone(2, 'b', second.arguments), itemDone(2, second),
    ]
    const adapted = history.map(adapt)
    expect(adapted).toEqual([
      null, { choices: [{ delta: { content: 'visible ' } }] }, { choices: [{ delta: { reasoning_content: 'summary' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 2, id: 'call_b', function: { name: 'inspect' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_a', function: { name: 'inspect' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"x"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':1}' } }] } }] },
      null, null, null,
    ])
    expect(adapt.completed()).toBe(false)
    expect(adapt(terminal([{ type: 'reasoning' }, first, second], measured))).toEqual({
      usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62, prompt_tokens_details: { cached_tokens: 5 } },
      choices: [{ finish_reason: 'tool_calls', delta: {} }],
    })
    expect(adapt.completed()).toBe(true)
    expect(() => adapt(argumentDelta(1, 'a', 'extra'))).toThrow('未执行工具')
  })

  it('accepts the authoritative completed call with no argument deltas', () => {
    const adapt = createResponsesToolFrameAdapter()
    adapt(added(0, functionItem('a')))
    expect(adapt(terminal([functionItem('a', '{}', 'completed')]))?.choices).toEqual([
      { finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } },
    ])
    expect(adapt.completed()).toBe(true)
  })

  it('rejects a repeated call ID, an unknown delta identity and mismatched final arguments', () => {
    const repeated = createResponsesToolFrameAdapter()
    repeated(added(0, functionItem('a')))
    expect(() => repeated(added(1, { ...functionItem('b'), call_id: 'call_a' }))).toThrow('未执行工具')
    const unknown = createResponsesToolFrameAdapter()
    unknown(added(0, functionItem('a')))
    expect(() => unknown(argumentDelta(0, 'b', '{}'))).toThrow('未执行工具')
    const replaced = createResponsesToolFrameAdapter()
    replaced(added(0, functionItem('a')))
    expect(() => replaced({ type: 'response.output_item.done', output_index: 0, item: { type: 'message' } })).toThrow('未执行工具')
    const mismatched = createResponsesToolFrameAdapter()
    mismatched(added(0, functionItem('a')))
    mismatched(argumentDelta(0, 'a', '{"x":'))
    expect(mismatched(terminal([functionItem('a', '{"y":1}', 'completed')], measured))).toMatchObject({
      error: { code: 'responses_stream_failed' }, usage: { prompt_tokens: 50, completion_tokens: 12 },
    })
    expect(mismatched.completed()).toBe(false)
  })

  it('fails closed on malformed final arguments or missing completed call', () => {
    for (const output of [[functionItem('a', '{"x":', 'completed')], []]) {
      const adapt = createResponsesToolFrameAdapter()
      adapt(added(0, functionItem('a')))
      expect(adapt(terminal(output))).toMatchObject({ error: { code: 'responses_stream_failed' } })
      expect(adapt.completed()).toBe(false)
    }
    const malformed = createResponsesToolFrameAdapter()
    malformed(added(0, functionItem('a')))
    const item = functionItem('a', '[]', 'completed')
    expect(malformed(itemDone(0, item))).toBeNull()
    expect(malformed(terminal([item], measured))).toMatchObject({
      error: { code: 'responses_stream_failed' }, usage: { prompt_tokens: 50, completion_tokens: 12 },
    })
    expect(malformed.completed()).toBe(false)
  })

  it('classifies max-output incomplete separately while never completing a partial tool', () => {
    const adapt = createResponsesToolFrameAdapter()
    adapt(added(0, functionItem('a')))
    adapt(argumentDelta(0, 'a', '{"partial":'))
    expect(adapt(argumentsDone(0, 'a', '{"partial":'))).toBeNull()
    expect(adapt(itemDone(0, functionItem('a', '{"partial":', 'incomplete')))).toBeNull()
    expect(adapt({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      usage: measured } })).toMatchObject({
      choices: [{ finish_reason: 'length', delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 12 },
    })
    expect(adapt.completed()).toBe(true)
    const rejected = createResponsesToolFrameAdapter()
    expect(rejected({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' },
      usage: { input_tokens: 7 } } })).toMatchObject({ error: { code: 'responses_stream_failed' }, usage: { prompt_tokens: 7 } })
    expect(rejected.completed()).toBe(false)
  })

  it('retains nested error and observed usage or emits a fixed error for missing detail', () => {
    const rejected = createResponsesToolFrameAdapter()
    const error = { code: 'insufficient_quota' }
    expect(rejected({ type: 'response.failed', response: { error, usage: { input_tokens: 3, output_tokens: 0 } } })).toEqual({
      error, usage: { prompt_tokens: 3, completion_tokens: 0 },
    })
    expect(createResponsesToolFrameAdapter()({ type: 'response.failed' })).toMatchObject({ error: { code: 'responses_stream_failed' } })
    expect(createResponsesToolFrameAdapter()({ type: 'error', code: 'invalid_request_error', message: 'fixture' }))
      .toMatchObject({ error: { code: 'invalid_request_error', message: 'fixture' } })
  })

  it('keeps missing usage distinct from observed zero and rejects invalid measurements', () => {
    expect(responsesUsageToChat(null)).toBeUndefined()
    expect(responsesUsageToChat({ prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 })).toBeUndefined()
    expect(responsesUsageToChat({ input_tokens: 0, input_tokens_details: { cached_tokens: 0 } }))
      .toEqual({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } })
    expect(() => responsesUsageToChat({ input_tokens: -1 })).toThrow()
  })
})
