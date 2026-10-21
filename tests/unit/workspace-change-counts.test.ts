import { expect, it } from 'vitest'
import type { WorkspaceActivity } from '../../src/features/studio/agent/agentStore.js'
import { workspaceActivityDelta, workspaceBodyChanges, workspaceGroupDelta } from '../../src/features/studio/agent/workspace-body-changes.js'

const chapter = (callId: string, before: string, after: string, id = 'chapter'): WorkspaceActivity => ({ callId, toolName: 'quality_analyze', label: 'Chapter', chapterId: id,
  status: 'done', deltaChars: after.length - before.length, before, after })
it('does not count the long unchanged body between two distant patches', () => {
  const middle = 'unchanged line\n'.repeat(40), activity = chapter('repair', `old first\n${middle}old last`, `new first\n${middle}new last`)
  // The two changed lines contain 9 + 8 code points; shared newlines stay equal.
  expect(workspaceActivityDelta(activity)).toEqual({ added: 17, removed: 17 })
  expect(workspaceGroupDelta([activity])).toEqual({ added: 17, removed: 17 })
  expect(workspaceBodyChanges([activity])).toMatchObject([{ added: 17, removed: 17 }])
})
it('aggregates documents from first before to last successful after, including an exact revert', () => {
  const activities = [chapter('1', 'A', 'B'), chapter('2', 'B', 'C'), chapter('3', 'C', 'A')]
  expect(activities.map(workspaceActivityDelta)).toEqual(Array.from({ length: 3 }, () => ({ added: 1, removed: 1 })))
  expect(workspaceGroupDelta(activities)).toEqual({ added: 0, removed: 0 })
})
it('uses plan IDs to keep separate documents in the same group and preserves non-body deltas', () => {
  const plan = (id: string, text: string): WorkspaceActivity => ({ callId: id, toolName: 'plan_save', label: 'Plan', chapterId: null, status: 'done', deltaChars: null,
    display: { kind: 'planDiff', artifactId: id, title: 'Plan', before: '', after: text } })
  const memory: WorkspaceActivity = { callId: 'memory', toolName: 'memory_save', label: 'Memory', chapterId: null, status: 'done', deltaChars: -2 }
  expect(workspaceGroupDelta([plan('a', 'one'), plan('b', 'two'), memory])).toEqual({ added: 6, removed: 2 })
  expect(workspaceActivityDelta(memory)).toEqual({ added: 0, removed: 2 })
})
it('counts Unicode code points and omits failed or still running prose', () => {
  const activity = chapter('unicode', '甲😀\n尾', '乙😺\n尾')
  expect(workspaceActivityDelta(activity)).toEqual({ added: 2, removed: 2 })
  const unsettled = [{ ...activity, status: 'failed' as const }, { ...activity, status: 'running' as const }]
  expect(unsettled.map(workspaceActivityDelta)).toEqual([{ added: 0, removed: 0 }, { added: 0, removed: 0 }])
  expect(workspaceGroupDelta(unsettled)).toEqual({ added: 0, removed: 0 })
})
