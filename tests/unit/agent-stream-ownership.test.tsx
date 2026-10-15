// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentStream } from '../../src/features/studio/agent/useAgentStream'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { claimWorkspaceStreamEvent, isReviewStreamReplay, isStaleChapterReview, isWorkspaceStreamOwnerCurrent, type ChapterStreamOwner, type ReviewStreamCursor } from '../../src/features/studio/components/chapter-stream-handoff'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'
import type { ChapterPendingReview, PlanPendingReview } from '../../src/features/studio/types'
import { readStoredPendingReviewList, writeStoredPendingReview } from '../../src/features/studio/lib/plan-review'

class Source {
  static opened: Source[] = []
  listeners = new Map<string, (event: MessageEvent) => void>()
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) { Source.opened.push(this) }
  addEventListener(type: string, callback: (event: MessageEvent) => void) { this.listeners.set(type, callback) }
  send(event: AgentStreamEvent) { this.listeners.get(event.type)?.(new MessageEvent(event.type, { data: JSON.stringify(event) })) }
}
const owner: ChapterStreamOwner = { novelId: 'a', scope: 'user:a:task-a', sessionId: 'session-a', epoch: 1 }
const resultEvent = (seq = 3, runId = 'run-a'): Extract<AgentStreamEvent, { type: 'tool.result' }> => ({
  type: 'tool.result', seq, runId, ts: '2026-10-15T00:00:00Z', messageId: 'message-a', callId: 'write-a', toolName: 'chapter_write', ok: true,
  summary: '已保存', display: { kind: 'chapterDiff', chapterId: 'chapter-a', chapterTitle: 'A', before: '原文', after: 'AI正文', revision: 7, appliedDirectly: true },
})
beforeEach(() => {
  Source.opened = []
  vi.stubGlobal('EventSource', Source)
  useAgentStore.setState({ runId: 'run-a', activeSessionId: 'session-a', phase: 'running', lastSeq: 0, messages: [] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

it('rejects callbacks and errors from an old source even when a new connection resumes the same run', () => {
  const received = vi.fn(), error = vi.fn()
  const hook = renderHook(() => useAgentStream(received, error))
  act(() => hook.result.current.connect('run-a'))
  const old = Source.opened[0]
  act(() => hook.result.current.connect('run-a'))
  act(() => { old.send(resultEvent()); old.onerror?.() })
  expect(received).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
  expect(useAgentStore.getState().lastSeq).toBe(0)
  act(() => Source.opened[1].send(resultEvent()))
  expect(received).toHaveBeenCalledExactlyOnceWith(resultEvent())
})

it('forwards only store-accepted events and a foreign or duplicate terminal cannot close the active stream', () => {
  const received = vi.fn()
  const hook = renderHook(() => useAgentStream(received))
  act(() => hook.result.current.connect('run-a'))
  const source = Source.opened[0]
  act(() => { source.send(resultEvent()); source.send(resultEvent()); source.send({ type: 'run.paused', runId: 'other', seq: 9, ts: '', reason: 'needs_input' }); source.send({ type: 'run.paused', runId: 'run-a', seq: 2, ts: '', reason: 'needs_input' }) })
  expect(received).toHaveBeenCalledOnce(); expect(source.close).not.toHaveBeenCalled()
  act(() => source.send({ type: 'run.paused', runId: 'run-a', seq: 4, ts: '', reason: 'needs_input' }))
  expect(received).toHaveBeenCalledTimes(2); expect(source.close).toHaveBeenCalledOnce()
})

it('retains the original host epoch when callbacks change before the old connection cleanup', () => {
  const received = vi.fn()
  const hook = renderHook(({ current }: { current: ChapterStreamOwner }) => {
    const latest = useRef(current); latest.current = current
    return useAgentStream(event => {
      const live = useAgentStore.getState()
      if (isWorkspaceStreamOwnerCurrent({ origin: current, current: latest.current, activeSessionId: live.activeSessionId, activeRunId: live.runId, eventRunId: event.runId })) received(event)
    })
  }, { initialProps: { current: owner } })
  act(() => hook.result.current.connect('run-a'))
  hook.rerender({ current: { ...owner, epoch: 3 } })
  act(() => Source.opened[0].send(resultEvent()))
  expect(received).not.toHaveBeenCalled()
})

it('keeps saved revision8 and pending body/plan baselines after A -> B -> A and actual seq0 stream replay', () => {
  const after = { id: 'chapter-a', title: 'A', content: 'AI正文', summary: '', revision: 7, status: 'draft' as const, visibility: 'private' as const, orderIndex: 1, localOnly: false }
  let review: ChapterPendingReview = { id: 'review-a', chapterId: after.id, runId: 'run-a', before: { ...after, content: '原文', revision: 6 }, after, rollbackSnapshot: { kind: 'restore_chapter', chapter: { ...after, content: '原文', wordCount: 2, updatedAt: null } }, description: '待确认', createdAt: '' }
  const plan: PlanPendingReview = { id: 'plan-a', backendArtifactId: 'plan-a', title: '计划', beforeTitle: '旧计划', before: '原计划', after: '最新计划', description: '待确认', runId: 'run-a', createdAt: '', lastAppliedEvent: { runId: 'run-a', seq: 5 } }
  const cursors = new Map<string, ReviewStreamCursor>()
  const applied = vi.fn()
  const hook = renderHook(({ current }: { current: ChapterStreamOwner }) => useAgentStream(event => {
    if (!claimWorkspaceStreamEvent(cursors, current, event)) return
    if (event.type !== 'tool.result') return
    if (event.display?.kind === 'chapterDiff') {
      if (isReviewStreamReplay(review.lastAppliedEvent, event) || isStaleChapterReview(event.display.revision, review.after.revision)) return
      applied(event)
    } else if (event.display?.kind === 'planFile' && !isReviewStreamReplay(plan.lastAppliedEvent, event)) applied(event)
  }), { initialProps: { current: owner } })
  act(() => hook.result.current.connect('run-a'))
  act(() => Source.opened[0].send(resultEvent()))
  // The switch save advances only after/revision; serialize and restore the same
  // pending review, exactly as the durable review storage does between novels.
  review = { ...review, after: { ...review.after, revision: 8, content: '作者保存的新输入' } }
  writeStoredPendingReview('pending:a', [review])
  act(() => { hook.result.current.disconnect(); useAgentStore.getState().resumeRun('run-b', 'session-b') })
  hook.rerender({ current: { novelId: 'b', scope: 'user:b:task-b', sessionId: 'session-b', epoch: 2 } })
  act(() => hook.result.current.connect('run-b'))
  act(() => { hook.result.current.disconnect(); useAgentStore.getState().resumeRun('run-a', 'session-a') })
  hook.rerender({ current: { ...owner, epoch: 3 } })
  review = readStoredPendingReviewList<ChapterPendingReview>('pending:a')[0]
  const saved = structuredClone(review)
  act(() => hook.result.current.connect('run-a', 0))
  const replay = Source.opened[2]
  expect(replay.url).toContain('/run-a/stream')
  act(() => { replay.send(resultEvent()); replay.send({ ...resultEvent(5), display: { kind: 'planFile', artifactId: 'plan-a', title: '计划', content: '旧的重放计划' } }) })
  expect(useAgentStore.getState().lastSeq).toBe(5)
  expect(applied).not.toHaveBeenCalled()
  expect(review).toEqual(saved); expect(review.after.revision).toBe(8)
  expect(plan).toMatchObject({ before: '原计划', after: '最新计划', runId: 'run-a', lastAppliedEvent: { seq: 5 } })
  const newer = { ...resultEvent(6), display: { ...resultEvent().display, kind: 'chapterDiff' as const, chapterId: 'chapter-a', chapterTitle: 'A', before: '作者保存的新输入', after: '后续真实修改', revision: 9, appliedDirectly: true } }
  act(() => replay.send(newer))
  expect(applied).toHaveBeenCalledExactlyOnceWith(newer)
})

it('rejects older revisions after a reload even without an in-memory replay cursor', () => {
  expect(isStaleChapterReview(7, 8, 8, 8)).toBe(true)
  expect(isStaleChapterReview(8, 8)).toBe(true)
  expect(isStaleChapterReview(9, 8)).toBe(false)
  expect(isStaleChapterReview(undefined, 8)).toBe(true)
  expect(isStaleChapterReview(7, undefined, 8)).toBe(true)
})

it('filters old and duplicate deltas before merging the next animation-frame batch', () => {
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const received = vi.fn()
  const hook = renderHook(() => useAgentStream(received))
  act(() => {
    hook.result.current.connect('run-a')
    useAgentStore.setState({ lastSeq: 5, messages: [{ id: 'm', runId: 'run-a', role: 'assistant', parts: [], createdAt: '' }] })
  })
  const source = Source.opened[0]
  const delta = (seq: number, text: string): AgentStreamEvent => ({ type: 'text.delta', runId: 'run-a', messageId: 'm', seq, delta: text, ts: '' })
  // The actual author-text stream publishes complete paragraphs, not partial prose.
  act(() => { source.send(delta(5, '旧')); source.send(delta(6, '新')); source.send(delta(6, '重复')); source.send(delta(7, '内容\n\n')); frame?.(0) })
  expect(received).toHaveBeenCalledExactlyOnceWith(delta(7, '新内容\n\n'))
  expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'text', text: '新内容\n\n' }])
})
