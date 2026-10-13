import { describe, expect, it } from 'vitest'

import { RunEventBus } from '../../api/lib/agent/events.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

describe('Agent run event bus', () => {
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
