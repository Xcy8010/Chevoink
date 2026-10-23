import { EventEmitter } from 'node:events'
import type { Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../api/lib/agent/runtime-event-projection.js', () => ({ publishDurableEvents: vi.fn(async () => []), loadDurableEvents: vi.fn(), isDurablePauseResumed: vi.fn() }))
import { streamDurableRun } from '../../api/lib/agent/runtime-stream.js'
import { loadDurableEvents, isDurablePauseResumed } from '../../api/lib/agent/runtime-event-projection.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

class StreamResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  chunks: string[] = []
  writeHead = vi.fn()
  write(chunk: string) { this.chunks.push(chunk); return true }
  end() { this.writableEnded = true }
  destroy() { this.destroyed = true }
}
const paused: AgentStreamEvent = { type: 'run.paused', reason: 'needs_input', runId: 'run', seq: 1, ts: '2026-10-23T00:00:00Z' }
const resumed: AgentStreamEvent = { type: 'run.started', agent: { type: 'orchestrator', title: 'Chevoink Agent', model: 'speed' }, mode: 'build', title: '恢复原任务',
  authorContinue: { eventId: 'original-resume-event', afterSeq: 1 }, runId: 'run', seq: 2, ts: '2026-10-23T00:00:01Z' }
afterEach(() => vi.clearAllMocks())

describe('same-run bootstrap stream resume', () => {
  it.each([0, 1, 2])('keeps the stream open across a verified resumed pause from cursor %i', async cursor => {
    let initialized = false
    const started: AgentStreamEvent = { ...resumed, seq: 3, authorContinue: undefined }
    vi.mocked(isDurablePauseResumed).mockResolvedValue(true)
    vi.mocked(loadDurableEvents).mockImplementation(async (_user, _run, since, limit) => [paused, resumed, ...(initialized ? [started] : [])]
      .filter(event => event.seq > since).slice(0, limit ?? 200))
    const response = new StreamResponse()
    const pending = streamDurableRun('owner', 'run', cursor, response as unknown as Response)
    try {
      await vi.waitFor(() => expect(response.writeHead).toHaveBeenCalled())
      expect(response.writableEnded).toBe(false)
      expect(response.chunks.join('')).not.toContain('event: run.paused')
      initialized = true
      // node:timers/promises is a real stream polling delay, not a global fake
      // timer. Observe the actual next batch within the unchanged test deadline.
      await vi.waitFor(() => expect(response.chunks.join('')).toContain('id: 3\nevent: run.started'), { timeout: 2000, interval: 10 })
      expect(response.writableEnded).toBe(false)
    } finally { response.emit('close'); await pending }
  })
  it('still terminates an actual current pause without a valid recovery source', async () => {
    vi.mocked(isDurablePauseResumed).mockResolvedValue(false)
    vi.mocked(loadDurableEvents).mockResolvedValue([paused])
    const response = new StreamResponse()
    await streamDurableRun('owner', 'run', 0, response as unknown as Response)
    expect(response.chunks.join('')).toContain('event: run.paused')
    expect(response.writableEnded).toBe(true)
  })
})
