import { expect, it } from 'vitest'
import { canAdoptChapterResult, canApplyChapterSnapshot } from '../../src/features/studio/components/chapter-stream-handoff'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

const draft = { id: 'chapter', title: '章', content: '旧正文', summary: '', status: 'draft' as const, visibility: 'private' as const, orderIndex: 1, revision: 4, localOnly: false }
const owner = { novelId: 'novel', scope: 'user:novel:task', sessionId: 'session' }
const event = { type: 'tool.result', runId: 'run', callId: 'call', toolName: 'chapter_write', ok: true, ts: '', display: { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '章', before: '旧正文', after: '已保存正文', revision: 5, appliedDirectly: true } } as Extract<AgentStreamEvent, { type: 'tool.result' }>
const options = { event, origin: owner, current: owner, activeSessionId: 'session', activeRunId: 'run', selectedChapterId: 'chapter', dirty: false, draft }
it('adopts only a successful committed result for the current novel/task/session/run/chapter', () => {
  expect(canAdoptChapterResult(options)).toBe(true)
  for (const current of [{ ...owner, novelId: 'other' }, { ...owner, scope: 'other' }, { ...owner, sessionId: 'other' }, { ...owner, scope: undefined }]) expect(canAdoptChapterResult({ ...options, current })).toBe(false)
  for (const extra of [{ activeRunId: 'old' }, { activeSessionId: 'other' }, { selectedChapterId: 'other' }, { dirty: true }, { draft: { ...draft, revision: 6 } }]) expect(canAdoptChapterResult({ ...options, ...extra })).toBe(false)
  expect(canAdoptChapterResult({ ...options, event: { ...event, ok: false } })).toBe(false)
  const display = event.display as Extract<NonNullable<typeof event.display>, { kind: 'chapterDiff' }>
  expect(canAdoptChapterResult({ ...options, event: { ...event, display: { ...display, appliedDirectly: false } } })).toBe(false)
  expect(canAdoptChapterResult({ ...options, event: { ...event, display: { ...display, revision: undefined } } })).toBe(false)
})
it('prevents stale refetches from regressing the saved handoff and preserves newer author input', () => {
  const saved = { ...draft, content: '已保存正文', revision: 5 }
  expect(canApplyChapterSnapshot(saved, draft, false)).toBe(false)
  expect(canApplyChapterSnapshot(saved, { ...saved, revision: 6 }, true)).toBe(false)
  expect(canApplyChapterSnapshot(saved, saved, false)).toBe(true)
  expect(canApplyChapterSnapshot(saved, { ...draft, id: 'other' }, false)).toBe(true)
})
