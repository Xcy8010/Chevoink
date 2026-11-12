import type { ModelReasoningEffort } from '../../shared/contracts/index.js'
import type { OpenAIToolDefinition } from './ai-service.js'
import { responsesReasoningItemSchema, type ResponsesReasoningItem } from './ai-responses-continuation.js'

type WireObject = Record<string, unknown>

const object = (value: unknown): WireObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WireObject : null

function protocolError(): never {
  throw new Error('模型返回不完整或不一致的 Responses 事件，未执行工具。')
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return protocolError()
  return value
}

export function buildResponsesToolRequest(input: {
  model: string
  messages: readonly WireObject[]
  tools: readonly OpenAIToolDefinition[]
  reasoningEffort?: ModelReasoningEffort
  maxOutputTokens: number
  toolChoice?: 'required'
}): WireObject {
  const items: WireObject[] = []
  const pending = new Set<string>()
  for (const message of input.messages) {
    const { role, content } = message
    if (role === 'tool') {
      const callId = nonEmptyString(message.tool_call_id)
      if (!pending.delete(callId) || typeof content !== 'string') return protocolError()
      items.push({ type: 'function_call_output', call_id: callId, output: content })
      continue
    }
    if (pending.size || (role !== 'system' && role !== 'user' && role !== 'assistant')) return protocolError()

    if (role === 'user' && Array.isArray(content)) {
      items.push({ role, content: content.map(raw => {
        const part = object(raw)
        if (part?.type === 'text' && typeof part.text === 'string') return { type: 'input_text', text: part.text }
        if (part?.type !== 'image_url') return protocolError()
        const image = object(part.image_url)
        const detail = image?.detail ?? 'auto'
        if (detail !== 'low' && detail !== 'high' && detail !== 'auto') return protocolError()
        return { type: 'input_image', image_url: nonEmptyString(image?.url), detail }
      }) })
      continue
    }
    if (typeof content !== 'string') return protocolError()
    if (role === 'assistant' && Array.isArray(message.responses_reasoning)) items.push(...message.responses_reasoning)
    if (content || role !== 'assistant' || !Array.isArray(message.tool_calls)) items.push({ role, content })
    if (role !== 'assistant' || message.tool_calls === undefined) continue
    if (!Array.isArray(message.tool_calls)) return protocolError()
    for (const raw of message.tool_calls) {
      const call = object(raw), fn = object(call?.function)
      const callId = nonEmptyString(call?.id)
      if (call?.type !== 'function' || pending.has(callId) || typeof fn?.arguments !== 'string') return protocolError()
      pending.add(callId)
      items.push({ type: 'function_call', call_id: callId, name: nonEmptyString(fn.name), arguments: fn.arguments })
    }
  }
  if (pending.size) return protocolError()
  return {
    model: input.model,
    input: items,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: input.maxOutputTokens,
    ...(input.reasoningEffort === undefined ? {} : { reasoning: { effort: input.reasoningEffort } }),
    ...(input.tools.length ? { tools: input.tools.map(({ function: fn }) => ({ type: 'function', ...fn, strict: fn.strict ?? false })) } : {}),
    ...(input.tools.length && input.toolChoice ? { tool_choice: input.toolChoice } : {}),
  }
}

type ChatUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens: number }
}

export function responsesUsageToChat(value: unknown): ChatUsage | undefined {
  if (value == null) return undefined
  const usage = object(value)
  if (!usage) return protocolError()
  const count = (item: unknown) => {
    if (item == null) return undefined
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > 2147483647) return protocolError()
    return item
  }
  const prompt = count(usage.input_tokens), completion = count(usage.output_tokens), total = count(usage.total_tokens)
  const cached = count(object(usage.input_tokens_details)?.cached_tokens)
  if (prompt === undefined && completion === undefined && cached === undefined) return undefined
  return {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(completion === undefined ? {} : { completion_tokens: completion }),
    ...(total === undefined ? {} : { total_tokens: total }),
    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
  }
}

type ChatCallDelta = { index: number; id?: string; function: { name?: string; arguments?: string } }
type ChatDelta = { content?: string; reasoning_content?: string; tool_calls?: ChatCallDelta[] }
type ChatFrame = {
  error?: unknown
  usage?: ChatUsage
  choices?: { finish_reason?: 'stop' | 'length' | 'tool_calls'; delta: ChatDelta }[]
}
type Call = { itemId: string; callId: string; name: string; args: string; argumentsDone: boolean; incomplete?: true }
type Adapter = ((value: unknown) => ChatFrame | null) & { completed(): boolean; reasoningItems(): ResponsesReasoningItem[] }

function outputIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return protocolError()
  return value
}

function objectArguments(args: string): boolean {
  try { return object(JSON.parse(args)) !== null } catch { return false }
}

export function createResponsesToolFrameAdapter(): Adapter {
  const calls = new Map<number, Call>()
  const itemIds = new Set<string>(), callIds = new Set<string>()
  let terminal = false, completed = false
  const reasoningItems: ResponsesReasoningItem[] = []
  let streamedText = ''

  function readCall(index: number, item: WireObject): { call: Call; delta: ChatCallDelta } {
    const itemId = nonEmptyString(item.id), callId = nonEmptyString(item.call_id), name = nonEmptyString(item.name)
    const call = calls.get(index)
    if (call) {
      if (call.itemId !== itemId || call.callId !== callId || call.name !== name) return protocolError()
      return { call, delta: { index, function: {} } }
    }
    if (itemIds.has(itemId) || callIds.has(callId)) return protocolError()
    const created = { itemId, callId, name, args: '', argumentsDone: false }
    calls.set(index, created)
    itemIds.add(itemId); callIds.add(callId)
    return { call: created, delta: { index, id: callId, function: { name } } }
  }

  function finishArguments(call: Call, value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith(call.args)
      || (call.argumentsDone && value !== call.args)) return protocolError()
    const suffix = value.slice(call.args.length)
    call.args = value
    call.argumentsDone = true
    return suffix
  }

  function completedCall(index: number, item: WireObject): ChatCallDelta {
    if (item.status !== undefined && item.status !== 'completed') return protocolError()
    const { call, delta } = readCall(index, item)
    if (call.incomplete || typeof item.arguments !== 'string' || !objectArguments(item.arguments)) return protocolError()
    const suffix = finishArguments(call, item.arguments)
    if (suffix) delta.function.arguments = suffix
    return delta
  }

  const chunk = (delta: ChatDelta): ChatFrame => ({ choices: [{ delta }] })
  const withCall = (delta: ChatCallDelta): ChatFrame | null =>
    delta.id || delta.function.arguments ? chunk({ tool_calls: [delta] }) : null
  const fallbackError = { code: 'responses_stream_failed' }

  const adapt = (value: unknown): ChatFrame | null => {
    const event = object(value)
    if (!event || typeof event.type !== 'string' || terminal) return protocolError()
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta'
      || event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta !== 'string') return protocolError()
      if (event.type === 'response.reasoning_summary_text.delta') return chunk({ reasoning_content: event.delta })
      streamedText += event.delta
      return chunk({ content: event.delta })
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = object(event.item)
      if (!item || typeof item.type !== 'string') return protocolError()
      const index = outputIndex(event.output_index)
      if (item.type !== 'function_call') return calls.has(index) ? protocolError() : null
      if (event.type === 'response.output_item.done') {
        if (item.status !== 'incomplete' && typeof item.arguments === 'string' && objectArguments(item.arguments)) {
          return withCall(completedCall(index, item))
        }
        // A final length event can still carry observed usage. Retain the
        // identity without appending partial arguments or accepting the call.
        readCall(index, item).call.incomplete = true
        return null
      }
      if (calls.has(index) || (item.arguments !== undefined && typeof item.arguments !== 'string')) return protocolError()
      const { call, delta } = readCall(index, item)
      if (typeof item.arguments === 'string' && item.arguments) {
        call.args = item.arguments
        delta.function.arguments = item.arguments
      }
      return withCall(delta)
    }
    if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done') {
      const index = outputIndex(event.output_index), call = calls.get(index)
      if (!call || call.itemId !== event.item_id || (event.name !== undefined && event.name !== call.name)) return protocolError()
      if (event.type === 'response.function_call_arguments.done') {
        if (typeof event.arguments !== 'string' || !event.arguments.startsWith(call.args)) return protocolError()
        if (!objectArguments(event.arguments)) {
          call.incomplete = true
          return null
        }
        return withCall({ index, function: { arguments: finishArguments(call, event.arguments) } })
      }
      if (call.argumentsDone || call.incomplete || typeof event.delta !== 'string') return protocolError()
      call.args += event.delta
      return withCall({ index, function: { arguments: event.delta } })
    }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.cancelled') {
      terminal = true
      const response = object(event.response)
      const error = response?.error ?? event.error
        ?? (typeof event.code === 'string' || typeof event.message === 'string' ? { code: event.code, message: event.message } : fallbackError)
      return { error: error || fallbackError, usage: responsesUsageToChat(response?.usage ?? event.usage) }
    }
    if (event.type !== 'response.completed' && event.type !== 'response.incomplete') return null

    terminal = true
    const response = object(event.response)
    const usage = responsesUsageToChat(response?.usage)
    if (event.type === 'response.incomplete') {
      if (response?.status !== 'incomplete' || response.error || object(response.incomplete_details)?.reason !== 'max_output_tokens') {
        return { error: response?.error || fallbackError, usage }
      }
      // The caller treats every call from a length-limited turn as incomplete.
      completed = true
      return { usage, choices: [{ finish_reason: 'length', delta: {} }] }
    }

    const toolCalls: ChatCallDelta[] = []
    let finalText = ''
    try {
      if (response?.status !== 'completed' || response.error || !Array.isArray(response.output)) return protocolError()
      const output = response.output
      for (const [index, raw] of output.entries()) {
        const item = object(raw)
        if (!item || typeof item.type !== 'string' || (calls.has(index) && item.type !== 'function_call')) return protocolError()
        if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content) {
          const { type, id, summary, encrypted_content } = item
          const reasoning = responsesReasoningItemSchema.safeParse({ type, id, summary, encrypted_content })
          if (!reasoning.success) return protocolError()
          reasoningItems.push(reasoning.data)
        }
        if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
          for (const rawPart of item.content) {
            const part = object(rawPart)
            if (part?.type === 'output_text' && typeof part.text === 'string') finalText += part.text
            if (part?.type === 'refusal' && typeof part.refusal === 'string') finalText += part.refusal
          }
        }
        if (item.type !== 'function_call') continue
        const delta = completedCall(index, item)
        if (delta.id || delta.function.arguments) toolCalls.push(delta)
      }
      if ([...calls.keys()].some(index => index >= output.length)) return protocolError()
      if (finalText && !finalText.startsWith(streamedText)) return protocolError()
    } catch {
      return { error: fallbackError, usage }
    }
    completed = true
    return { usage, choices: [{ finish_reason: calls.size ? 'tool_calls' : 'stop',
      delta: {
        ...(finalText.length > streamedText.length ? { content: finalText.slice(streamedText.length) } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      } }] }
  }
  return Object.assign(adapt, { completed: () => completed, reasoningItems: () => reasoningItems })
}
