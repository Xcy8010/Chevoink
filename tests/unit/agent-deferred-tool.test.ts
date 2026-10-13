import { describe, expect, it, vi } from 'vitest'
import { deferToolProposal } from '../../api/lib/agent/deferred-tool.js'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

describe('deferred chapter proposal', () => {
  it.each(['step.finish', 'run.paused'] as const)('keeps arbitration out of executed activity after %s and event replay', end => {
    const store = useAgentStore
    store.getState().resetRun()
    store.getState().resumeRun('run', 'session')
    const base = { runId: 'run', ts: new Date().toISOString() }
    const apply = store.getState().applyEvent
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'tool.delta', messageId: 'm', callId: 'commit', toolName: 'chapter_bridge_commit', title: '提交章节终态', argsChars: 20 })
    let seq = 2
    const bus = { emit: vi.fn(event => apply({ ...base, seq: ++seq, ...event })) }
    deferToolProposal({ id: 'commit', name: 'chapter_bridge_commit', arguments: '{}' }, '当前版本仍需复核', 'm', bus)
    if (end === 'step.finish') apply({ ...base, seq: ++seq, type: end, turn: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
    else apply({ ...base, seq: ++seq, type: end, reason: 'needs_input' })
    expect(store.getState().messages[0].parts).toEqual([])
    expect(store.getState().workspaceActivities).toEqual([])
    expect(bus.emit).toHaveBeenCalledExactlyOnceWith({ type: 'tool.deferred', messageId: 'm', callId: 'commit', toolName: 'chapter_bridge_commit', reason: '当前版本仍需复核', execution: 'not_dispatched' })
    apply({ ...base, seq: ++seq, type: 'tool.result', messageId: 'm', callId: 'actual', toolName: 'continuity_validate', ok: false, summary: '引用未定位', durationMs: 12 })
    expect(store.getState().messages[0].parts).toEqual([expect.objectContaining({ callId: 'actual', status: 'failed' })])
  })
})
