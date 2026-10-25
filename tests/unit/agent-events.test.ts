import { describe, expect, it } from 'vitest'

import { RunEventBus, createRunEventBus, disposeRunEventBus, getRunEventBus } from '../../api/lib/agent/events.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

describe('Agent run event bus', () => {
  it('publishes an already committed start once without another persistence write or sequence', async () => {
    const bus = new RunEventBus('atomic-start', 4)
    const event: Extract<AgentStreamEvent, { type: 'run.started' }> = { seq: 5, runId: 'atomic-start', ts: new Date(0).toISOString(),
      type: 'run.started', agent: { type: 'writingOrchestrator', title: '写作', model: 'speed' }, mode: 'build', title: '继续' }
    const replay: AgentStreamEvent[] = []
    bus.subscribe(value => replay.push(value))
    bus.publishPersistedStart(event)
    expect(bus.lastSeq).toBe(5)
    expect(replay).toEqual([event])
    // persist() would access Prisma if publication had enqueued another write.
    await expect(bus.persist()).resolves.toBeUndefined()
    expect(() => bus.publishPersistedStart(event)).toThrow('顺序')
    expect(() => bus.publishPersistedStart({ ...event, runId: 'other', seq: 6 })).toThrow('顺序')
    expect(() => bus.publishPersistedStart({ ...event, seq: 7 })).toThrow('顺序')
    const connected: AgentStreamEvent[] = []
    bus.subscribe(value => connected.push(value), 4)
    expect(connected).toEqual([event])
  })
  it('does not close a replacement owner bus when a stale executor disposes its old bus', async () => {
    const old = createRunEventBus('replacement-owner')
    await disposeRunEventBus(old.runId, old)
    const current = createRunEventBus(old.runId, 7)
    try {
      await disposeRunEventBus(old.runId, old)
      expect(getRunEventBus(old.runId)).toBe(current)
      expect(() => current.publishPersistedStart({ seq: 8, runId: current.runId, ts: new Date(0).toISOString(), type: 'run.started',
        agent: { type: 'writingOrchestrator', title: '写作', model: 'speed' }, mode: 'build', title: '继续' })).not.toThrow()
      await expect(current.persist()).resolves.toBeUndefined()
    } finally { await disposeRunEventBus(current.runId, current) }
  })
  it('drops a deferred proposal preview before reconnection without inventing an execution', () => {
    const bus = new RunEventBus('deferred-preview')
    bus.emitTransient({ type: 'tool.delta', messageId: 'm', callId: 'c', toolName: 'chapter_bridge_commit', argsChars: 5 })
    bus.emitTransient({ type: 'tool.deferred', messageId: 'm', callId: 'c', toolName: 'chapter_bridge_commit', execution: 'not_dispatched', reason: '先复核' })
    const replay: AgentStreamEvent[] = []
    bus.subscribe(event => replay.push(event))
    expect(replay).toEqual([])
  })
  it('isolates a failed listener while replaying in-memory history', () => {
    const bus = new RunEventBus('run-replay')
    const event: AgentStreamEvent = {
      seq: 1,
      runId: 'run-replay',
      ts: new Date(0).toISOString(),
      type: 'run.paused',
      reason: 'user_stop',
    }

    ;(bus as unknown as { history: AgentStreamEvent[] }).history = [event]

    expect(() => bus.subscribe(() => {
      throw new Error('response already closed')
    })).not.toThrow()
  })
})
