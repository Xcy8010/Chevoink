// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import type { AgentToolDisplayPayload, AgentStreamEvent, AgentUIMessage } from '../../shared/contracts/index.js'
import { useAgentStore, WORKSPACE_WRITE_TOOLS } from '../../src/features/studio/agent/agentStore.js'
import { workspaceBodyChanges } from '../../src/features/studio/agent/workspace-body-changes.js'
import { resolveActivityNavigation } from '../../src/features/studio/agent/activity-navigation.js'
import { qualityAppliedBodyChange } from '../../shared/agent-applied-body-change.js'

const display: Extract<AgentToolDisplayPayload, { kind: 'qualityReport' }> = { kind: 'qualityReport', reportId: 'report', chapterId: 'chapter', chapterRevision: 15,
  status: 'repaired', repairRound: 1, findings: [], appliedBodyChange: { version: 1, chapterId: 'chapter', chapterTitle: 'Chapter five', before: 'Old.', after: 'New text.', sourceRevision: 14, targetRevision: 15 } }
const result = (seq: number, payload = display, ok = true): AgentStreamEvent => ({ type: 'tool.result', runId: 'run', seq, ts: new Date(0).toISOString(), messageId: 'message',
  callId: 'quality-call', toolName: 'quality_analyze', ok, summary: 'Saved two changes', durationMs: 100, display: payload })
beforeEach(() => {
  useAgentStore.getState().resetRun()
  useAgentStore.setState({ runId: 'run', activeSessionId: 'session', loadedSessionId: 'session', phase: 'running', messages: [], lastSeq: 0, workspaceActivities: [] })
})
it('counts an actual automatic repair live and after history restore, without changing the quality card', () => {
  expect(WORKSPACE_WRITE_TOOLS.has('quality_analyze')).toBe(false)
  useAgentStore.getState().applyEvent(result(1))
  useAgentStore.getState().applyEvent(result(2))
  const state = useAgentStore.getState(), activity = state.workspaceActivities[0]
  expect(state.workspaceActivities).toHaveLength(1)
  expect(activity).toMatchObject({ toolName: 'quality_analyze', chapterId: 'chapter', before: 'Old.', after: 'New text.', status: 'done' })
  // The existing review diff counts changed lines, including their punctuation.
  expect(workspaceBodyChanges(state.workspaceActivities)).toMatchObject([{ key: 'chapter:chapter', added: 9, removed: 4 }])
  expect(state.messages[0].parts[0]).toMatchObject({ type: 'tool-call', display: { kind: 'qualityReport', reportId: 'report' } })
  expect(state.messages[0].parts[0]).not.toHaveProperty('accepted')
  expect(resolveActivityNavigation(activity)).toMatchObject({ kind: 'document', title: 'Chapter five', args: { chapterId: 'chapter' } })
  const messages = structuredClone(state.messages) as AgentUIMessage[]
  useAgentStore.getState().restoreMessages(messages, 'session')
  expect(workspaceBodyChanges(useAgentStore.getState().workspaceActivities)).toMatchObject([{ key: 'chapter:chapter', added: 9, removed: 4 }])
})
it.each(['read', 'failed', 'mismatched-chapter', 'mismatched-revision', 'no-op'] as const)('does not infer a prose change from %s report state', scenario => {
  const payload = structuredClone(display)
  if (scenario === 'read') delete payload.appliedBodyChange
  if (scenario === 'mismatched-chapter') payload.appliedBodyChange!.chapterId = 'other'
  if (scenario === 'mismatched-revision') payload.appliedBodyChange!.targetRevision++
  if (scenario === 'no-op') payload.appliedBodyChange!.after = payload.appliedBodyChange!.before
  useAgentStore.getState().applyEvent(result(1, payload, scenario !== 'failed'))
  expect(workspaceBodyChanges(useAgentStore.getState().workspaceActivities)).toEqual([])
})
it('keeps the earliest body baseline across normal writing, automatic repair, and a later exact revert', () => {
  const write = { callId: 'write', toolName: 'chapter_write', label: 'Chapter five', chapterId: 'chapter', deltaChars: 4, status: 'done' as const,
    display: { kind: 'chapterDiff' as const, chapterId: 'chapter', chapterTitle: 'Chapter five', before: 'Base.', after: 'Old.', appliedDirectly: true, revision: 14 } }
  useAgentStore.setState({ workspaceActivities: [write] })
  useAgentStore.getState().applyEvent(result(1))
  expect(workspaceBodyChanges(useAgentStore.getState().workspaceActivities)).toMatchObject([{ added: 9, removed: 5 }])
  const reverted = { ...display, chapterRevision: 16, appliedBodyChange: { ...display.appliedBodyChange!, before: 'New text.', after: 'Base.', sourceRevision: 15, targetRevision: 16 } }
  expect(qualityAppliedBodyChange(reverted)).not.toBeNull()
  useAgentStore.getState().applyEvent({ ...result(2, reverted), callId: 'revert' })
  expect(workspaceBodyChanges(useAgentStore.getState().workspaceActivities)).toEqual([])
})
