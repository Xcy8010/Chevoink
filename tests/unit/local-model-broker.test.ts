import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } } }))
import { LocalModelBroker } from '../../api/lib/local-model-broker.js'
import { normalizeLocalModelUrl } from '../../shared/local-model.js'

afterEach(() => vi.useRealTimers())
async function connected(broker: LocalModelBroker, key = 'owner/model') {
  const controller = new AbortController(), poll = broker.poll(key, controller.signal)
  return { controller, poll }
}
describe('local model transient bridge', () => {
  it('never queues an offline request or describes it as sent', async () => {
    const broker = new LocalModelBroker()
    await expect(broker.request('offline', '{}')).rejects.toMatchObject({ dispatched: false })
  })
  it('delivers once, preserves SSE bytes and rejects foreign/duplicate/stale frames', async () => {
    const broker = new LocalModelBroker(), { poll } = await connected(broker)
    const response = broker.request('owner/model', '{"model":"local"}')
    const job = (await poll)!
    expect(job.body).toBe('{"model":"local"}')
    await expect(broker.frame('another-owner', job.id, { sequence: 0, status: 200 })).rejects.toThrow()
    await broker.frame('owner/model', job.id, { sequence: 0, status: 200, contentType: 'text/event-stream' })
    const result = await response, text = result.text()
    await expect(broker.frame('owner/model', job.id, { sequence: 0, status: 200 })).rejects.toThrow()
    const content = 'data: {"choices":[{"delta":{"reasoning_content":"思考","tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n'
    await broker.frame('owner/model', job.id, { sequence: 1, chunk: Buffer.from(content).toString('base64') })
    await broker.frame('owner/model', job.id, { sequence: 2, done: true })
    expect(await text).toBe(content)
    expect(result.headers.get('content-type')).toBe('text/event-stream')
    await expect(broker.frame('owner/model', job.id, { sequence: 3, done: true })).rejects.toThrow()
  })
  it('does not redeliver a request after a second poll or accept concurrent requests', async () => {
    vi.useFakeTimers()
    const broker = new LocalModelBroker(), first = await connected(broker)
    const response = broker.request('owner/model', '{}').catch(error => error)
    const job = (await first.poll)!
    await expect(broker.request('owner/model', '{}')).rejects.toMatchObject({ dispatched: false })
    const again = broker.poll('owner/model', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await again).toBeNull()
    expect(broker.active('owner/model', job.id)).toBe(true)
    broker.revoke('owner/model')
    expect(await response).toMatchObject({ dispatched: true })
  })
  it('cancelled queued requests are not delivered later', async () => {
    const broker = new LocalModelBroker(), connection = await connected(broker)
    connection.controller.abort(); await connection.poll.catch(() => undefined)
    const signal = new AbortController()
    const response = broker.request('owner/model', '{}', signal.signal).catch(error => error)
    signal.abort()
    expect(await response).toMatchObject({ dispatched: false })
    expect(broker.active('owner/model', 'anything')).toBe(false)
  })
  it('aborts a delivered stream without returning a successful completion', async () => {
    const broker = new LocalModelBroker(), { poll } = await connected(broker), signal = new AbortController()
    const response = broker.request('owner/model', '{}', signal.signal)
    const job = (await poll)!
    await broker.frame('owner/model', job.id, { sequence: 0, status: 200 })
    const result = await response, reading = result.text()
    signal.abort()
    await expect(reading).rejects.toMatchObject({ dispatched: true })
    expect(broker.active('owner/model', job.id)).toBe(false)
  })
  it('separates cold-load header timeout from the streaming duration', async () => {
    vi.useFakeTimers()
    const broker = new LocalModelBroker(100, 1000), { poll } = await connected(broker)
    const response = broker.request('owner/model', '{}'), job = (await poll)!
    await broker.frame('owner/model', job.id, { sequence: 0, status: 200 })
    const reading = (await response).text()
    await vi.advanceTimersByTimeAsync(101)
    expect(broker.active('owner/model', job.id)).toBe(true)
    await broker.frame('owner/model', job.id, { sequence: 1, chunk: Buffer.from('valid').toString('base64') })
    await broker.frame('owner/model', job.id, { sequence: 2, done: true })
    expect(await reading).toBe('valid')
  })
  it('rejects body and frame limits before unbounded allocation', async () => {
    const broker = new LocalModelBroker(), { poll } = await connected(broker)
    await expect(broker.request('owner/model', 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ dispatched: false })
    const response = broker.request('owner/model', '{}').catch(error => error), job = (await poll)!
    await expect(broker.frame('owner/model', job.id, { sequence: 0, status: 204 })).rejects.toThrow()
    broker.revoke('owner/model'); expect(await response).toMatchObject({ dispatched: true })
  })
  it('expires transport once without retrying the local provider', async () => {
    vi.useFakeTimers()
    const broker = new LocalModelBroker(50, 100), { poll } = await connected(broker)
    const response = broker.request('owner/model', '{}').catch(error => error), job = (await poll)!
    await vi.advanceTimersByTimeAsync(51)
    expect(await response).toMatchObject({ dispatched: true })
    expect(broker.active('owner/model', job.id)).toBe(false)
  })
})
describe('local endpoint policy', () => {
  it.each(['http://localhost:7863/v1/', 'http://127.0.0.1:1234/v1', 'http://[::1]:11434', 'https://192.168.1.2:8443/v1', 'http://10.1.2.3/v1', 'http://172.16.2.3/v1'])('accepts an explicit local target %s', value => expect(normalizeLocalModelUrl(value)).toMatch(/^https?:/))
  it.each(['http://169.254.169.254', 'http://0.0.0.0', 'http://8.8.8.8/v1', 'http://models.internal/v1', 'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?key=secret', 'http://127.0.0.1/v1#x', 'file:///etc/passwd', 'http://127.0.0.1/a%2fb', 'http://2130706433/v1', 'http://0177.0.0.1/v1', 'http://127.0.0.1/a/../v1'])('rejects ambiguous, public or metadata target %s', value => expect(() => normalizeLocalModelUrl(value)).toThrow())
})
