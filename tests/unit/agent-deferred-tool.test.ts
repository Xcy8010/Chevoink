import { describe, expect, it, vi } from 'vitest'
import { deferredToolPart } from '../../api/lib/agent/deferred-tool.js'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

describe('persisted deferred chapter commit', () => {
  it.each(['step.finish', 'run.paused'] as const)('retains the failed proposal after %s and event replay', end => {
    const store = useAgentStore
    store.getState().resetRun()
    store.getState().resumeRun('run', 'session')
    const base = { runId: 'run', ts: new Date().toISOString() }
    const apply = store.getState().applyEvent
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'tool.delta', messageId: 'm', callId: 'commit', toolName: 'chapter_bridge_commit', title: '提交章节终态', argsChars: 20 })
    let seq = 2
    const bus = { emit: vi.fn(event => apply({ ...base, seq: ++seq, ...event })) }
    const part = deferredToolPart({ id: 'commit', name: 'chapter_bridge_commit', arguments: '{}' }, '提交章节终态', { compilationId: 'comp' }, '当前版本仍需复核', 'm', bus)
    if (end === 'step.finish') apply({ ...base, seq: ++seq, type: end, turn: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
    else apply({ ...base, seq: ++seq, type: end, reason: 'needs_input' })
    expect(part).toMatchObject({ callId: 'commit', status: 'failed', summary: '未执行：当前版本仍需复核', durationMs: 0 })
    expect(store.getState().messages[0].parts).toEqual([expect.objectContaining({ callId: 'commit', status: 'failed', preparing: false })])
    expect(store.getState().workspaceActivities.filter(item => item.status === 'accepted')).toEqual([])
    expect(bus.emit).toHaveBeenCalledTimes(2)
    expect(bus.emit.mock.calls[1][0]).toMatchObject({ type: 'tool.result', ok: false })
  })
})
