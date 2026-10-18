// Node 22 standalone connector. No dependencies, listeners, shell or model retries.
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LIMITS = Object.freeze({ request: 2 * 1024 * 1024, response: 16 * 1024 * 1024, frame: 32768, control: 65536 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function normalizeLocalUrl(value) {
  const raw = /^https?:\/\/(\[::1\]|[^/:?#]+)(?::([0-9]{1,5}))?(\/[^?#]*)?$/i.exec(value)
  if (!raw || /[\s%\\]/.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw[3] ?? '')) throw new Error('Invalid local model URL')
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (raw[1].replace(/^\[|\]$/g, '').toLowerCase() !== host) throw new Error('Only literal local hosts are allowed')
  const parts = host.split('.').map(Number)
  const ipv4 = parts.length === 4 && parts.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === host.split('.')[i])
  const privateV4 = ipv4 && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['localhost', '127.0.0.1', '::1'].includes(host) && !privateV4 || /%|\\/.test(url.pathname)) throw new Error('Invalid local model URL')
  if (host === 'localhost') url.hostname = '127.0.0.1'
  return url.toString().replace(/\/+$/, '')
}
export function validateConfig(input) {
  if (!object(input) || input.version !== 1 || !['local-openai', 'local-lmstudio', 'local-ollama'].includes(input.provider)
    || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256 || /[\r\n]/.test(input.model)
    || !/^chevoink-local-v1\.[\w-]{1,64}\.[\w-]{43}$/.test(input.token ?? '')
    || !Number.isInteger(input.contextWindowTokens) || input.contextWindowTokens < 1024 || input.contextWindowTokens > 4_000_000
    || typeof (input.apiKey ?? '') !== 'string' || (input.apiKey ?? '').length > 8192 || /[\r\n]/.test(input.apiKey ?? '')) throw new Error('Invalid connector configuration')
  const server = new URL(input.server)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname)
  if (server.username || server.password || server.search || server.hash || server.pathname !== '/'
    || server.origin !== 'https://chevoink.chevolink.com' && !(server.protocol === 'http:' && loopback)) throw new Error('Invalid connector server')
  return Object.freeze({ version: 1, server: server.origin, token: input.token, provider: input.provider, model: input.model,
    baseUrl: normalizeLocalUrl(input.baseUrl), contextWindowTokens: input.contextWindowTokens, apiKey: input.apiKey ?? '' })
}
export class UnsupportedParameter extends Error {
  constructor(param) { super('Unsupported or invalid requested parameter: ' + param); this.param = param }
}
const unsupported = param => { throw new UnsupportedParameter(param) }
export function parseJob(job, config) {
  if (!object(job) || !/^[\w-]{1,64}$/.test(job.id ?? '') || typeof job.body !== 'string'
    || Buffer.byteLength(job.body) > LIMITS.request) throw new Error('Invalid or oversized connector job')
  const body = JSON.parse(job.body)
  if (!object(body) || body.model !== config.model) unsupported('model')
  for (const key of ['url', 'baseUrl', 'apiKey', 'authorization', 'headers', 'provider', 'server']) if (key in body) unsupported(key)
  for (const key of ['max_tokens', 'max_completion_tokens']) if (key in body
    && (!Number.isInteger(body[key]) || body[key] < 1 || body[key] > config.contextWindowTokens)) unsupported(key)
  return body
}
export function ollamaRequest(body, config, thinkingValues) {
  const allowed = new Set(['model', 'messages', 'tools', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens',
    'temperature', 'top_p', 'seed', 'stop', 'reasoning_effort'])
  for (const key of Object.keys(body)) if (!allowed.has(key)) unsupported(key)
  if ('max_tokens' in body && 'max_completion_tokens' in body) unsupported('max_completion_tokens')
  if ('stream_options' in body && (!object(body.stream_options) || Object.keys(body.stream_options).some(key => key !== 'include_usage')
    || typeof body.stream_options.include_usage !== 'boolean')) unsupported('stream_options')
  if (!Array.isArray(body.messages) || !body.messages.length) unsupported('messages')
  const names = new Map()
  const messages = body.messages.map(message => {
    if (!object(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)
      || message.content != null && typeof message.content !== 'string') unsupported('messages')
    for (const key of Object.keys(message)) if (!['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content'].includes(key)) unsupported('messages.' + key)
    const result = { role: message.role, content: message.content ?? '' }
    if (message.reasoning_content !== undefined) {
      if (typeof message.reasoning_content !== 'string') unsupported('messages.reasoning_content')
      result.thinking = message.reasoning_content
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) unsupported('messages.tool_calls')
      result.tool_calls = message.tool_calls.map(call => {
        if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !object(call.function)
          || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') unsupported('messages.tool_calls')
        let args
        try { args = JSON.parse(call.function.arguments) } catch { unsupported('messages.tool_calls') }
        if (!object(args)) unsupported('messages.tool_calls')
        names.set(call.id, call.function.name)
        return { function: { name: call.function.name, arguments: args } }
      })
    }
    if (message.role === 'tool') {
      if (!names.has(message.tool_call_id)) unsupported('messages.tool_call_id')
      result.tool_name = names.get(message.tool_call_id)
    }
    return result
  })
  const result = { model: config.model, messages, stream: body.stream === true,
    options: { num_ctx: config.contextWindowTokens, num_predict: body.max_completion_tokens ?? body.max_tokens ?? Math.min(4096, config.contextWindowTokens) } }
  if ('stream' in body && typeof body.stream !== 'boolean') unsupported('stream')
  if ('tools' in body) {
    if (!Array.isArray(body.tools)) unsupported('tools')
    result.tools = body.tools.map(tool => {
      if (!object(tool) || tool.type !== 'function' || !object(tool.function) || typeof tool.function.name !== 'string') unsupported('tools')
      if (Object.keys(tool).some(key => !['type', 'function'].includes(key))
        || Object.keys(tool.function).some(key => !['name', 'description', 'parameters'].includes(key))) unsupported('tools')
      return tool
    })
  }
  for (const key of ['temperature', 'top_p', 'seed', 'stop']) if (key in body) result.options[key] = body[key]
  if ('reasoning_effort' in body) {
    const think = body.reasoning_effort === 'none' ? false : body.reasoning_effort
    if (!['low', 'medium', 'high', false].includes(think) || !Array.isArray(thinkingValues) || !thinkingValues.includes(think)) unsupported('reasoning_effort')
    result.think = think
  }
  return result
}
export function ollamaChoice(value, config, id, streaming, toolState = { next: 0 }) {
  if (!object(value) || value.error || !object(value.message) && !value.done) throw new Error('Invalid native model response')
  const source = value.message ?? {}, message = { role: 'assistant' }
  if (source.content !== undefined) { if (typeof source.content !== 'string') throw new Error('Invalid native content'); message.content = source.content }
  if (source.thinking !== undefined) { if (typeof source.thinking !== 'string') throw new Error('Invalid native thinking'); message.reasoning_content = source.thinking }
  if (source.tool_calls !== undefined) {
    if (!Array.isArray(source.tool_calls)) throw new Error('Invalid native tool calls')
    message.tool_calls = source.tool_calls.map(call => {
      if (!object(call.function) || typeof call.function.name !== 'string' || !object(call.function.arguments)) throw new Error('Invalid native tool call')
      const nativeIndex = call.function.index ?? call.index
      toolState.indices ??= new Map()
      const key = Number.isInteger(nativeIndex) && nativeIndex >= 0 ? nativeIndex : Symbol()
      if (!toolState.indices.has(key)) toolState.indices.set(key, toolState.next++)
      const index = toolState.indices.get(key)
      return { ...(streaming ? { index } : {}), id: `call_${id}_${index}`, type: 'function',
        function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) } }
    })
    if (message.tool_calls.length) toolState.hasTools = true
  }
  const reason = value.done ? value.done_reason === 'length' ? 'length' : toolState.hasTools ? 'tool_calls' : 'stop' : null
  const result = { id: `chatcmpl-${id}`, object: streaming ? 'chat.completion.chunk' : 'chat.completion', model: config.model,
    choices: [{ index: 0, [streaming ? 'delta' : 'message']: message, finish_reason: reason }] }
  if (value.done && Number.isSafeInteger(value.prompt_eval_count) && value.prompt_eval_count >= 0
    && Number.isSafeInteger(value.eval_count) && value.eval_count >= 0) result.usage = {
    prompt_tokens: value.prompt_eval_count, completion_tokens: value.eval_count, total_tokens: value.prompt_eval_count + value.eval_count }
  return result
}
async function readBounded(response, limit) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length
      if (size > limit) throw new Error('Response size limit exceeded'); chunks.push(value) }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function control(config, path, fetchImpl, signal, frame) {
  const response = await fetchImpl(config.server + '/api/local-model-connector' + path, {
    method: frame ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${config.token}`, ...(frame ? { 'Content-Type': 'application/json' } : {}) },
    ...(frame ? { body: JSON.stringify(frame) } : {}) })
  // Poll envelopes contain a JSON-escaped request string, which can double
  // the encoded size. Small acknowledgement/status responses retain 64KiB.
  const bytes = await readBounded(response, path === '/poll' ? LIMITS.request * 2 + LIMITS.control : LIMITS.control)
  if (!response.ok) throw new Error('Connector control rejected')
  let result
  try { result = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Invalid control response') }
  if (result.success !== true || !object(result.data)) throw new Error('Invalid control response')
  return result.data
}
export async function runJob(config, job, options = {}) {
  if (!object(job) || !/^[\w-]{1,64}$/.test(job.id ?? '')) throw new Error('Invalid connector job identity')
  const fetchImpl = options.fetch ?? globalThis.fetch, controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const totalTimer = setTimeout(() => controller.abort(), options.totalTimeout ?? 1_200_000)
  let sequence = 0, response, bytesSent = 0, cloudRejected = false, checking = false
  let pending = Buffer.alloc(0), flushTimer, flushChain = Promise.resolve(), lastChunkAt = 0
  const post = async frame => {
    try { await control(config, `/responses/${job.id}`, fetchImpl, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), { sequence, ...frame }); sequence++ }
    catch { cloudRejected = true; controller.abort(); throw new Error('Connector delivery stopped') }
  }
  const flush = () => {
    clearTimeout(flushTimer); flushTimer = undefined
    if (!pending.length) return flushChain
    const bytes = pending; pending = Buffer.alloc(0)
    flushChain = flushChain.then(async () => {
      const wait = Math.max(0, (options.flushMs ?? 125) - (Date.now() - lastChunkAt))
      if (wait) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, wait)
        const abort = () => { clearTimeout(timer); reject(new Error('Connector stopped')) }
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
      await post({ chunk: bytes.toString('base64') }); lastChunkAt = Date.now()
    })
    return flushChain
  }
  const chunk = async bytes => {
    bytesSent += bytes.length
    if (bytesSent > LIMITS.response) throw new Error('Response size limit exceeded')
    let offset = 0
    while (offset < bytes.length) {
      const length = Math.min(LIMITS.frame - pending.length, bytes.length - offset)
      pending = Buffer.concat([pending, bytes.subarray(offset, offset + length)]); offset += length
      if (pending.length === LIMITS.frame) await flush()
    }
    if (pending.length && !flushTimer) flushTimer = setTimeout(() => { flush().catch(() => controller.abort()) }, options.flushMs ?? 125)
    await flushChain
  }
  const heartbeat = setInterval(async () => {
    if (checking || signal.aborted) return
    checking = true
    try { const data = await control(config, `/requests/${job.id}`, fetchImpl, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      if (data.active !== true) controller.abort() }
    catch { controller.abort() } finally { checking = false }
  }, options.heartbeatMs ?? 5000)
  const localFetch = async (url, body) => {
    const headers = new AbortController(), timer = setTimeout(() => headers.abort(), options.headerTimeout ?? 300_000)
    try { return await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, headers.signal]),
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body }) }
    finally { clearTimeout(timer) }
  }
  try {
    const body = parseJob(job, config)
    let target = config.baseUrl + '/chat/completions', wire = job.body
    const native = config.provider === 'local-ollama'
    if (native) {
      const root = config.baseUrl.replace(/\/(?:v1|api)$/, '')
      let values
      if ('reasoning_effort' in body) {
        const show = await localFetch(root + '/api/show', JSON.stringify({ model: config.model }))
        if (show.ok) { const metadata = JSON.parse((await readBounded(show, LIMITS.request)).toString('utf8')); values = metadata.thinking?.values }
        else { await show.body?.cancel(); throw new Error('Native thinking metadata unavailable') }
      }
      wire = JSON.stringify(ollamaRequest(body, config, values)); target = root + '/api/chat'
    }
    response = await localFetch(target, wire)
    if (response.status < 200 || response.status >= 600 || response.status >= 300 && response.status < 400 || [204, 205].includes(response.status)) throw new Error('Invalid upstream status or redirect')
    if (native && !response.ok) {
      let payload
      try { payload = JSON.parse((await readBounded(response, LIMITS.control)).toString('utf8')) } catch { payload = { error: { message: 'Native model rejected request' } } }
      const message = typeof payload.error === 'string' ? payload.error : payload.error?.message
      if ('reasoning_effort' in body && /\bthink(?:ing)?\b/i.test(message ?? '') && /unsupported|not support|invalid|unknown|unrecognized|not allowed/i.test(message)) {
        payload = { error: { message: 'Native think parameter rejected reasoning_effort', param: 'reasoning_effort', type: 'invalid_request_error' } }
      } else if (typeof payload.error === 'string') payload = { error: { message: payload.error } }
      await post({ status: response.status, contentType: 'application/json' }); await chunk(Buffer.from(JSON.stringify(payload)))
    } else if (native && !body.stream) {
      const value = JSON.parse((await readBounded(response, LIMITS.response)).toString('utf8'))
      if (value.done !== true) throw new Error('Native response was incomplete')
      await post({ status: response.status, contentType: 'application/json' }); await chunk(Buffer.from(JSON.stringify(ollamaChoice(value, config, job.id, false))))
    } else if (native) {
      await post({ status: response.status, contentType: 'text/event-stream' })
      const reader = response.body.getReader(), decoder = new TextDecoder(), state = { next: 0 }
      let pending = '', received = 0, finished = false
      try {
        const emit = async line => {
          if (!line.trim()) return
          if (finished) throw new Error('Native data after completion')
          const value = JSON.parse(line)
          await chunk(Buffer.from('data: ' + JSON.stringify(ollamaChoice(value, config, job.id, true, state)) + '\n\n'))
          if (value.done === true) { finished = true; await chunk(Buffer.from('data: [DONE]\n\n')) }
        }
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.length; if (received > LIMITS.response) throw new Error('Native response size limit exceeded')
          pending += decoder.decode(value, { stream: true })
          let newline
          while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); await emit(line) }
        }
        pending += decoder.decode(); await emit(pending)
        if (!finished) throw new Error('Native stream was incomplete')
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } else {
      const type = response.headers.get('content-type')?.split(';')[0].trim()
      if (!['application/json', 'text/event-stream'].includes(type)) throw new Error('Unsupported upstream content type')
      await post({ status: response.status, contentType: type })
      if (!response.body) throw new Error('Missing upstream body')
      const reader = response.body.getReader()
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; await chunk(value) } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    await flush(); await post({ done: true })
  } catch (error) {
    clearTimeout(flushTimer); pending = Buffer.alloc(0)
    // A timed flush may already be awaiting acknowledgement. Preserve one
    // ordered writer before sending an error; never race two sequence numbers.
    await flushChain.catch(() => {})
    if (!cloudRejected && !signal.aborted) {
      try {
        if (error instanceof UnsupportedParameter && sequence === 0) {
          await post({ status: 400, contentType: 'application/json' })
          await chunk(Buffer.from(JSON.stringify({ error: { message: error.message, param: error.param, type: 'invalid_request_error', code: 'unsupported_parameter' } })))
          await flush(); await post({ done: true }); return
        }
        await post({ error: true })
      } catch { /* Unknown delivery must never be retried. */ }
    }
    throw new Error('Local request stopped; no model request was retried')
  } finally { clearInterval(heartbeat); clearTimeout(totalTimer); clearTimeout(flushTimer); controller.abort(); await flushChain.catch(() => {}); await response?.body?.cancel().catch(() => {}) }
}
export async function runConnector(config, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch, seen = new Set()
  while (!options.signal?.aborted) {
    const data = await control(config, '/poll', fetchImpl, options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000))
    if (data.job === null) continue
    if (!object(data.job) || seen.has(data.job.id) || seen.size >= 10000) throw new Error('Invalid or duplicate delivery; restart only after checking server state')
    seen.add(data.job.id)
    await runJob(config, data.job, options)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 is required')
    const configPath = process.argv[2] ?? 'chevoink-connector.local.json'
    if (statSync(configPath).size > LIMITS.control) throw new Error('Configuration size limit exceeded')
    const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')))
    console.log('Chevoink local connector running. Keep this terminal open; Ctrl+C stops it.')
    await runConnector(config)
  } catch { console.error('Connector stopped. Check the local configuration, model service and website connection before restarting. No model request was retried.'); process.exitCode = 1 }
}
