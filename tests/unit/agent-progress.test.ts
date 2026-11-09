import { describe, expect, it } from 'vitest'
import { agentToolProgress, normalizeAgentProgressText, publicAgentProgressEvent, publicAgentProgressPart } from '../../shared/agent-progress.js'
import { publicRunEvent } from '../../api/lib/agent/events.js'
import type { AgentStreamEvent, AgentMessagePart } from '../../shared/contracts/index.js'

const base = { runId: 'run-a', seq: 3, ts: '2026-11-06T00:00:00Z' }
describe('author progress boundary', () => {
  it('preserves returned reasoning in live and replay without mutating evidence', () => {
    const event: AgentStreamEvent = { ...base, type: 'reasoning.delta', messageId: 'm', delta: '好。开始。private reasoning\\nchapterId=secret' }
    const original = structuredClone(event)
    expect(publicRunEvent(event, new Map())).toEqual({ ...event, activity: true })
    expect(publicAgentProgressEvent(event)).toEqual({ ...event, activity: true })
    expect(publicAgentProgressPart({ type: 'reasoning', text: event.delta })).toEqual({ type: 'reasoning', text: event.delta, activity: true })
    expect(event).toEqual(original)
    expect(publicAgentProgressPart({ type: 'reasoning', text: ' \n' })).toEqual({ type: 'reasoning', text: ' \n' })
    expect(publicAgentProgressEvent({ ...event, delta: ' \n' })).not.toHaveProperty('activity')
  })
  it('decodes newlines only for progress/reasoning presentation, preserving tool input and ordinary prose', () => {
    const text = '已保存。\\r\\n复查未完成。\\n请核对。'
    expect(normalizeAgentProgressText(text)).toBe('已保存。\n复查未完成。\n请核对。')
    const part: AgentMessagePart = { type: 'tool-call', callId: 'write', toolName: 'chapter_write', title: '', status: 'success', summary: text, args: { content: text } }
    expect(publicAgentProgressPart(part)).toEqual({ ...part, summary: normalizeAgentProgressText(text) })
    const prose: AgentMessagePart = { type: 'text', text }
    expect(publicAgentProgressPart(prose)).toBe(prose)
    expect(publicAgentProgressEvent({ ...base, type: 'text.delta', messageId: 'm', delta: text })).toMatchObject({ delta: text })
  })
  it('publishes only the reasoning channel fields while retaining timing and legacy activity', () => {
    const part = { type: 'reasoning' as const, text: '返回的思考', durationMs: 123, privateContext: 'not public', providerResponse: { key: 'not public' } }
    expect(publicAgentProgressPart(part)).toEqual({ type: 'reasoning', text: part.text, durationMs: 123, activity: true })
    const event = { ...base, type: 'reasoning.delta' as const, messageId: 'm', delta: part.text, privateContext: part.privateContext }
    expect(publicAgentProgressEvent(event)).toEqual({ ...base, type: event.type, messageId: 'm', delta: part.text, activity: true })
    expect(publicAgentProgressPart({ type: 'reasoning', text: '', activity: true })).toEqual({ type: 'reasoning', text: '', activity: true })
  })
  it.each([
    ['chapter_write', '正在写入正文'],
    ['chapter_append', '正在写入正文'],
    ['chapter_edit_range', '正在写入正文修改'],
    ['plan_save', '正在写入创作计划'],
  ])('uses the active action for %s while the draft streams', (toolName, label) => {
    expect(agentToolProgress({ type: 'tool-call', callId: 'draft', toolName, title: '', args: null, status: 'running', preparing: true })).toBe(label)
  })

  it('does not turn a successful report receipt into repaired issues or completed goals', () => {
    const part: Extract<AgentMessagePart, { type: 'tool-call' }> = { type: 'tool-call', callId: 'check', toolName: 'quality_analyze', title: '', args: {}, status: 'success', summary: '已取得报告，仍有两处意见。' }
    expect(agentToolProgress(part)).toBe(part.summary)
    expect(agentToolProgress({ ...part, reviewOutcome: 'decision_required' })).toBe('已取得报告，仍有两处意见。（仍需处理）')
    expect(agentToolProgress({ ...part, status: 'running' })).toBe('正在进行章节人类感复查')
    expect(agentToolProgress({ ...part, status: 'running', preparing: true })).toBe('正在进行章节人类感复查')
    expect(agentToolProgress({ ...part, preparing: true })).toBe(part.summary)
  })
})
