import { describe, expect, it } from 'vitest'
import { agentToolProgress, normalizeAgentProgressText, publicAgentProgressEvent, publicAgentProgressPart } from '../../shared/agent-progress.js'
import { publicRunEvent } from '../../api/lib/agent/events.js'
import type { AgentStreamEvent, AgentMessagePart } from '../../shared/contracts/index.js'

const base = { runId: 'run-a', seq: 3, ts: '2026-11-06T00:00:00Z' }
describe('author progress boundary', () => {
  it('keeps native reasoning private in live and persisted replay projections without mutating evidence', () => {
    const event: AgentStreamEvent = { ...base, type: 'reasoning.delta', messageId: 'm', delta: '好。开始。private reasoning\\nchapterId=secret' }
    const original = structuredClone(event)
    expect(publicRunEvent(event, new Map())).toEqual({ ...event, delta: '', activity: true })
    expect(publicAgentProgressEvent(event)).toEqual({ ...event, delta: '', activity: true })
    expect(publicAgentProgressPart({ type: 'reasoning', text: event.delta })).toEqual({ type: 'reasoning', text: '', activity: true })
    expect(event).toEqual(original)
    expect(publicAgentProgressPart({ type: 'reasoning', text: ' \n' })).toEqual({ type: 'reasoning', text: '' })
    expect(publicAgentProgressEvent({ ...event, delta: ' \n' })).not.toHaveProperty('activity')
  })
  it('decodes newlines only for progress summaries, preserving tool input and ordinary prose', () => {
    const text = '已保存。\\r\\n复查未完成。\\n请核对。'
    expect(normalizeAgentProgressText(text)).toBe('已保存。\n复查未完成。\n请核对。')
    const part: AgentMessagePart = { type: 'tool-call', callId: 'write', toolName: 'chapter_write', title: '', status: 'success', summary: text, args: { content: text } }
    expect(publicAgentProgressPart(part)).toEqual({ ...part, summary: normalizeAgentProgressText(text) })
    const prose: AgentMessagePart = { type: 'text', text }
    expect(publicAgentProgressPart(prose)).toBe(prose)
    expect(publicAgentProgressEvent({ ...base, type: 'text.delta', messageId: 'm', delta: text })).toMatchObject({ delta: text })
  })
  it('does not turn a successful report receipt into repaired issues or completed goals', () => {
    const part: Extract<AgentMessagePart, { type: 'tool-call' }> = { type: 'tool-call', callId: 'check', toolName: 'quality_analyze', title: '', status: 'success', summary: '已取得报告，仍有两处意见。' }
    expect(agentToolProgress(part)).toBe(part.summary)
    expect(agentToolProgress({ ...part, reviewOutcome: 'decision_required' })).toBe('已取得报告，仍有两处意见。（仍需处理）')
    expect(agentToolProgress({ ...part, status: 'running' })).toBe('正在复查章节')
    expect(agentToolProgress({ ...part, preparing: true })).toBe('正在准备复查章节')
  })
})
