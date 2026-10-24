// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { readSessionMessagesCache, useAgentStore } from '../../src/features/studio/agent/agentStore'
import type { AgentMessagePart, AgentStreamEvent } from '../../shared/contracts/agent-events.js'
import type { ReviewOutcome } from '../../shared/review-lifecycle.js'

const runId = 'synthetic-review-run', sessionId = 'synthetic-review-session', messageId = 'synthetic-review-message'
const ts = '2026-10-20T10:00:00.000Z'
const summary = '合成事实尚待业务处理；原检查结果保留。'
beforeEach(() => {
  useAgentStore.getState().resetRun()
  useAgentStore.setState({ runId, activeSessionId: sessionId, loadedSessionId: sessionId, phase: 'running', lastSeq: 0,
    messages: [{ id: messageId, runId, role: 'assistant', parts: [], createdAt: ts }], workspaceActivities: [] })
})
afterEach(cleanup)
function apply(outcome: ReviewOutcome | undefined, ok = false) {
  const event: AgentStreamEvent = { type: 'tool.result', runId, seq: 2, ts, messageId, callId: 'review-call',
    toolName: 'continuity_validate', ok, summary, durationMs: 20, ...(outcome ? { reviewOutcome: outcome } : {}) }
  useAgentStore.getState().applyEvent({ type: 'tool.call', runId, seq: 1, ts, messageId, callId: 'review-call',
    toolName: 'continuity_validate', title: '合成连续性复查', args: { compilationId: 'synthetic-compilation' } })
  useAgentStore.getState().applyEvent(event)
  return event
}
function part() {
  return useAgentStore.getState().messages[0].parts.find((p): p is Extract<AgentMessagePart, { type: 'tool-call' }> => p.type === 'tool-call')!
}
it('retains business decisions across live delivery, duplicate replay and cached history without declaring success', () => {
  const usageBefore = useAgentStore.getState().usage
  const event = apply('decision_required')
  expect(part()).toMatchObject({ status: 'failed', reviewOutcome: 'decision_required', summary })
  useAgentStore.getState().applyEvent(event)
  expect(useAgentStore.getState().messages[0].parts).toHaveLength(1)
  expect(useAgentStore.getState().phase).toBe('running')
  expect(useAgentStore.getState().usage).toEqual(usageBefore)
  expect(useAgentStore.getState().workspaceActivities).toEqual([])
  useAgentStore.getState().resetRun()
  const cached = readSessionMessagesCache(sessionId)!
  useAgentStore.getState().restoreMessages(cached, sessionId)
  expect(part()).toMatchObject({ status: 'failed', reviewOutcome: 'decision_required', summary })
  const view = render(<AgentMessageParts parts={useAgentStore.getState().messages[0].parts} streaming={false} runActive summaryExpanded />)
  expect(screen.getByText('待处理').className).toContain('text-amber-600')
  expect(screen.getByText(summary).className).toContain('text-amber-600')
  expect(view.container.querySelector('.text-emerald-600')).toBeNull()
  expect(screen.queryByText('已完成')).toBeNull()
})
it.each([
  ['evidence_repair_required', '证据待修复'], ['provider_unresolved', '调用待核'],
  ['provider_failed', '调用失败'], ['stale', '版本失效'],
] as const)('keeps %s and its original failure visible', (outcome, label) => {
  apply(outcome)
  const view = render(<AgentMessageParts parts={[part()]} streaming={false} runActive summaryExpanded />)
  expect(part()).toMatchObject({ status: 'failed', reviewOutcome: outcome, summary })
  expect(screen.getByText(label).className).toContain('text-rose-500')
  expect(screen.getByText(summary).className).toContain('text-rose-500')
  expect(view.container.querySelector('.text-emerald-600')).toBeNull()
  expect(screen.queryByText('待处理')).toBeNull()
})
it.each([undefined, 'complete'] as const)('does not turn a legacy or contradictory failed status green (%s)', outcome => {
  apply(outcome)
  const view = render(<AgentMessageParts parts={[part()]} streaming={false} runActive summaryExpanded />)
  expect(part().status).toBe('failed')
  expect(screen.getByText(summary).className).toContain('text-rose-500')
  expect(view.container.querySelector('.text-emerald-600')).toBeNull()
})
it('preserves a real completed review and rejects a late result from another run', () => {
  const event = apply('complete', true)
  useAgentStore.getState().applyEvent({ ...event, seq: 3, runId: 'another-run', reviewOutcome: 'decision_required', ok: false })
  const view = render(<AgentMessageParts parts={[part()]} streaming={false} runActive summaryExpanded />)
  expect(part()).toMatchObject({ status: 'success', reviewOutcome: 'complete' })
  expect(view.container.querySelector('.text-emerald-600')).not.toBeNull()
  expect(screen.queryByText('待处理')).toBeNull()
})