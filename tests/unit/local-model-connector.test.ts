import { describe, expect, it, vi } from 'vitest'
import { normalizeLocalModelUrl } from '../../shared/local-model.js'
import { LIMITS, normalizeLocalUrl, validateConfig, parseJob, ollamaRequest, ollamaChoice, runJob, runConnector } from '../../public/chevoink-local-connector.mjs'

const setup = { version: 1, server: 'https://chevoink.chevolink.com', token: 'chevoink-local-v1.model-id.' + 'a'.repeat(43),
  provider: 'local-openai', model: 'local-model', baseUrl: 'http://localhost:1234/v1', contextWindowTokens: 16000, apiKey: 'local-private-key' }
const config = validateConfig(setup)
const job = (body = {}) => ({ id: 'job-1', body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'synthetic' }], ...body }) })
const ok = (data: object = { ok: true }) => new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } })
function harness(upstream: () => Response | Promise<Response>, rejection = 0) {
  const frames: Record<string, unknown>[] = [], calls: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    if (url.includes('/responses/')) { frames.push(JSON.parse(String(init.body))); return rejection ? new Response('{}', { status: rejection }) : ok() }
    if (url.includes('/requests/')) return ok({ active: true })
    return upstream()
  })
  return { frames, calls, fetcher, text: () => Buffer.concat(frames.filter(frame => frame.chunk).map(frame => Buffer.from(String(frame.chunk), 'base64'))).toString() }
}

describe('standalone local connector trust boundary', () => {
  it('accepts a long-context poll envelope while retaining the request payload bound', async () => {
    const controller = new AbortController()
    const task = job({ messages: [{ role: 'user', content: 'synthetic"\\'.repeat(7000) }] })
    expect(Buffer.byteLength(task.body)).toBeGreaterThan(LIMITS.control)
    let upstream = 0
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/poll')) return ok({ job: task })
      if (url.includes('/responses/')) { if (JSON.parse(String(init.body)).done) controller.abort(); return ok() }
      if (url.includes('/requests/')) return ok({ active: true })
      upstream++; expect(init.body).toBe(task.body)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    await runConnector(config, { fetch: fetcher, signal: controller.signal, flushMs: 0 })
    expect(upstream).toBe(1)
  })
  it.each(['http://localhost:1234/v1', 'https://127.0.0.1/v1', 'http://[::1]:11434', 'http://10.2.3.4/api', 'http://172.16.0.1', 'https://192.168.1.2'])('matches shared URL policy for %s', value => {
    expect(normalizeLocalUrl(value)).toBe(normalizeLocalModelUrl(value))
  })
  it.each(['http://169.254.169.254', 'http://0.0.0.0', 'http://172.32.0.1', 'https://example.com', 'file:///tmp/x', 'http://user@127.0.0.1',
    'http://127.0.0.1/?token=x', 'http://127.0.0.1/#x', 'http://127.0.0.1/%2e%2e/a', 'http://2130706433', 'http://0177.0.0.1', 'http://127.0.0.1\\v1', 'http://127.0.0.1/a/../v1'])('rejects unsafe target %s', value => {
    expect(() => normalizeLocalUrl(value)).toThrow()
    expect(() => normalizeLocalModelUrl(value)).toThrow()
  })
  it('pins config and rejects alternate cloud target, credential injection, model drift and payload bounds', () => {
    expect(Object.isFrozen(config)).toBe(true)
    expect(() => validateConfig({ ...setup, server: 'https://other.example' })).toThrow()
    expect(() => validateConfig({ ...setup, apiKey: 'x\r\na:b' })).toThrow()
    expect(() => validateConfig({ ...setup, contextWindowTokens: 0 })).toThrow()
    for (const body of [{ model: 'another' }, { baseUrl: 'http://10.1.1.1' }, { headers: { Authorization: 'cloud-key' } }, { max_tokens: 16001 }]) {
      expect(() => parseJob(job(body), config)).toThrow()
    }
    expect(() => parseJob({ id: 'job-1', body: ' '.repeat(LIMITS.request + 1) }, config)).toThrow()
  })
  it('forwards raw JSON/SSE fragments unchanged, with credentials confined to their target', async () => {
    const raw = 'data: {"choices":[{"delta":{"reasoning_content":"思考","tool_calls":[{"id":"call_1","function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n'
    const bytes = Buffer.from(raw)
    const h = harness(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 21)); controller.enqueue(bytes.subarray(21)); controller.close() } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }))
    const task = job({ stream: true }); await runJob(config, task, { fetch: h.fetcher })
    expect(h.text()).toBe(raw)
    expect(h.frames.map(frame => frame.sequence)).toEqual(h.frames.map((_, i) => i))
    expect(h.frames[0]).toEqual({ sequence: 0, status: 200, contentType: 'text/event-stream' })
    expect(h.frames.at(-1)?.done).toBe(true)
    const upstream = h.calls.find(call => call.url.startsWith(config.baseUrl))!
    expect(upstream.init.body).toBe(task.body)
    expect(upstream.init.headers).toMatchObject({ Authorization: 'Bearer local-private-key' })
    expect(upstream.init.redirect).toBe('error')
    for (const call of h.calls.filter(call => call.url.startsWith(config.server))) {
      expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${config.token}` })
      expect(JSON.stringify(call)).not.toContain(config.apiKey)
    }
    expect(JSON.stringify(upstream)).not.toContain(config.token)
  })
  it.each([401, 409, 503])('aborts once when response acknowledgement is %s', async status => {
    const h = harness(() => new Response('{}', { headers: { 'content-type': 'application/json' } }), status)
    await expect(runJob(config, job(), { fetch: h.fetcher })).rejects.toThrow('no model request was retried')
    expect(h.calls.filter(call => call.url.startsWith(config.baseUrl))).toHaveLength(1)
    expect(h.frames).toHaveLength(1)
    expect(h.calls[0].init.signal?.aborted).toBe(true)
  })
  it('rejects redirects and upstream timeouts without repeating the request', async () => {
    const redirected = harness(() => new Response('', { status: 302, headers: { location: 'http://192.168.1.1' } }))
    await expect(runJob(config, job(), { fetch: redirected.fetcher })).rejects.toThrow()
    expect(redirected.calls.filter(call => call.url.startsWith(config.baseUrl))).toHaveLength(1)
    vi.useFakeTimers()
    try {
      let calls = 0
      const fetcher = async (url: string, init: RequestInit) => {
        if (url.includes('/responses/')) return ok()
        calls++
        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
      }
      const result = runJob(config, job(), { fetch: fetcher, headerTimeout: 10 }).catch(error => error)
      await vi.advanceTimersByTimeAsync(11)
      expect(await result).toBeInstanceOf(Error); expect(calls).toBe(1)
    } finally { vi.useRealTimers() }
  })
  it('splits response frames at 32768 bytes and rejects oversized upstream output', async () => {
    const h = harness(() => new Response('x'.repeat(70000), { headers: { 'content-type': 'application/json' } }))
    await runJob(config, job(), { fetch: h.fetcher })
    expect(h.frames.filter(frame => frame.chunk).map(frame => Buffer.from(String(frame.chunk), 'base64').length)).toEqual([32768, 32768, 4464])
    const large = harness(() => new Response(new Uint8Array(LIMITS.response + 1), { headers: { 'content-type': 'application/json' } }))
    await expect(runJob(config, job(), { fetch: large.fetcher })).rejects.toThrow()
    expect(large.frames.at(-1)?.error).toBe(true)
    expect(large.calls.filter(call => call.url.startsWith(config.baseUrl))).toHaveLength(1)
  })
  it('coalesces token fragments and awaits each acknowledgement before sending another frame', async () => {
    const h = harness(() => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < 100; i++) controller.enqueue(Buffer.from('x'))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } }))
    await runJob(config, job(), { fetch: h.fetcher })
    expect(h.frames.filter(frame => frame.chunk)).toHaveLength(1)
    let release: () => void = () => {}, pendingAcks = 0, maxPending = 0
    const blocked = harness(() => new Response(new Uint8Array(70000), { headers: { 'content-type': 'application/json' } }))
    const fetcher = async (url: string, init: RequestInit) => {
      const frame = url.includes('/responses/') ? JSON.parse(String(init.body)) : null
      if (frame?.chunk && pendingAcks === 0 && maxPending === 0) {
        pendingAcks++; maxPending = Math.max(maxPending, pendingAcks)
        await new Promise<void>(resolve => { release = resolve }); pendingAcks--
      }
      return blocked.fetcher(url, init)
    }
    const result = runJob(config, job(), { fetch: fetcher, flushMs: 0 })
    await vi.waitFor(() => expect(maxPending).toBe(1))
    expect(blocked.frames).toHaveLength(1)
    release(); await result
    expect(blocked.frames.at(-1)?.done).toBe(true)
  })
  it('serializes an upstream failure behind an already pending timed-flush acknowledgement', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>, release: () => void = () => {}
    const frames: Record<string, unknown>[] = []
    const fetcher = async (url: string, init: RequestInit) => {
      if (!url.includes('/responses/')) return new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(Buffer.from('x')) } }), { headers: { 'content-type': 'text/event-stream' } })
      const frame = JSON.parse(String(init.body)); frames.push(frame)
      if (frame.chunk) await new Promise<void>(resolve => { release = resolve })
      return ok()
    }
    const result = runJob(config, job(), { fetch: fetcher, flushMs: 0 }).catch(error => error)
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    upstream.error(new Error('synthetic stream error'))
    await Promise.resolve(); await Promise.resolve()
    expect(frames.map(frame => frame.sequence)).toEqual([0, 1])
    release()
    expect(await result).toBeInstanceOf(Error)
    expect(frames).toEqual([{ sequence: 0, status: 200, contentType: 'text/event-stream' }, { sequence: 1, chunk: 'eA==' }, { sequence: 2, error: true }])
  })
  it('cancels upstream on heartbeat revocation without a second generation', async () => {
    vi.useFakeTimers()
    try {
      let generations = 0
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes('/requests/')) return ok({ active: false })
        generations++
        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      })
      const result = runJob(config, job(), { fetch: fetcher, heartbeatMs: 5 }).catch(error => error)
      await vi.advanceTimersByTimeAsync(6)
      expect(await result).toBeInstanceOf(Error)
      expect(generations).toBe(1)
      expect(fetcher.mock.calls[0][1].signal!.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('does not keep the header deadline running after headers arrive', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(() => new Response(new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(Buffer.from('{}')); controller.close() }, 50) } }), { headers: { 'content-type': 'application/json' } }))
      const result = runJob(config, job(), { fetch: h.fetcher, headerTimeout: 10 })
      await vi.advanceTimersByTimeAsync(20)
      expect(h.calls[0].init.signal!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(40); await result
      expect(h.frames.at(-1)?.done).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('rejects duplicate delivery rather than repeating the same local request', async () => {
    const h = harness(() => new Response('{}', { headers: { 'content-type': 'application/json' } }))
    const fetcher = async (url: string, init?: RequestInit) => url.endsWith('/poll') ? ok({ job: job() }) : h.fetcher(url, init)
    await expect(runConnector(config, { fetch: fetcher })).rejects.toThrow('duplicate delivery')
    expect(h.calls.filter(call => call.url.startsWith(config.baseUrl))).toHaveLength(1)
  })
})

describe('native Ollama translation', () => {
  const native = validateConfig({ ...setup, provider: 'local-ollama', baseUrl: 'http://localhost:11434/v1' })
  it('pins context/output bounds and translates tool history without ignoring unsupported knobs', () => {
    const body = parseJob(job({ max_tokens: 42, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }), native)
    expect(ollamaRequest(body, native)).toMatchObject({ options: { num_ctx: 16000, num_predict: 42 }, stream: false })
    for (const value of [{ tool_choice: 'required' }, { response_format: { type: 'json_schema' } }, { reasoning_effort: 'high' }]) {
      expect(() => ollamaRequest({ ...body, ...value }, native)).toThrow()
    }
    expect(ollamaRequest({ ...body, reasoning_effort: 'high' }, native, ['low', 'high']).think).toBe('high')
    expect(ollamaRequest({ ...body, reasoning_effort: 'none' }, native, [false]).think).toBe(false)
    expect(() => ollamaRequest({ ...body, reasoning_effort: 'high' }, native, [true])).toThrow()
    const history = { ...body, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, { role: 'tool', tool_call_id: 'call-a', content: 'result' }] }
    expect(ollamaRequest(history, native).messages).toEqual([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: { q: 'x' } } }] }, { role: 'tool', content: 'result', tool_name: 'lookup' }])
  })
  it('converts fragmented NDJSON into OpenAI reasoning/tools/usage SSE with stable IDs', async () => {
    const records = [{ message: { thinking: '推理' }, done: false }, { message: { content: '', tool_calls: [{ function: { index: 0, name: 'lookup', arguments: { q: 'x' } } }] }, done: false },
      { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 9 }]
    const bytes = Buffer.from(records.map(value => JSON.stringify(value)).join('\n') + '\n')
    const h = harness(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 31)); controller.enqueue(bytes.subarray(31, 98)); controller.enqueue(bytes.subarray(98)); controller.close() } })))
    await runJob(native, job({ stream: true }), { fetch: h.fetcher })
    expect(h.calls[0].url).toBe('http://127.0.0.1:11434/api/chat')
    expect(JSON.parse(String(h.calls[0].init.body)).options).toEqual({ num_ctx: 16000, num_predict: 4096 })
    const values = h.text().split('\n\n').filter(Boolean).map(line => line.slice(6))
    expect(values.at(-1)).toBe('[DONE]')
    const chunks = values.slice(0, -1).map(value => JSON.parse(value))
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('推理')
    expect(chunks[1].choices[0].delta.tool_calls[0]).toMatchObject({ id: 'call_job-1_0', index: 0, function: { arguments: '{"q":"x"}' } })
    expect(chunks[2].usage).toEqual({ prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 })
    expect(chunks[2].choices[0].finish_reason).toBe('tool_calls')
    expect(ollamaChoice({ message: { content: 'x' }, done: true, done_reason: 'length' }, native, 'id', false).choices[0].finish_reason).toBe('length')
  })
  it('returns an explicit unsupported schema error without calling the model', async () => {
    const h = harness(() => { throw new Error('must not generate') })
    await runJob(native, job({ response_format: { type: 'json_schema' } }), { fetch: h.fetcher })
    expect(h.frames[0].status).toBe(400)
    expect(JSON.parse(h.text()).error.param).toBe('response_format')
    expect(h.calls.every(call => call.url.startsWith(native.server))).toBe(true)
  })
  it('uses exact native thinking metadata and translates only explicit think rejection', async () => {
    const h = harness(() => new Response(JSON.stringify({ error: 'think value is not supported' }), { status: 400 }))
    const fetcher = async (url: string, init: RequestInit) => url.endsWith('/api/show')
      ? new Response(JSON.stringify({ thinking: { values: ['low', 'high'] } })) : h.fetcher(url, init)
    await runJob(native, job({ reasoning_effort: 'high' }), { fetch: fetcher })
    expect(JSON.parse(String(h.calls[0].init.body)).think).toBe('high')
    expect(JSON.parse(h.text()).error.param).toBe('reasoning_effort')
    const generic = harness(() => new Response(JSON.stringify({ error: 'invalid model' }), { status: 400 }))
    const genericFetch = async (url: string, init: RequestInit) => url.endsWith('/api/show')
      ? new Response(JSON.stringify({ thinking: { values: ['high'] } })) : generic.fetcher(url, init)
    await runJob(native, job({ reasoning_effort: 'high' }), { fetch: genericFetch })
    expect(JSON.parse(generic.text()).error).toEqual({ message: 'invalid model' })
  })
})
