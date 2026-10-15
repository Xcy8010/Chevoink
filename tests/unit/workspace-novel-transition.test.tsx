// @vitest-environment jsdom
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceNovelTransition } from '../../src/features/studio/components/use-workspace-novel-transition'
import { useChapterPersistence } from '../../src/features/studio/components/use-chapter-persistence'
import { usePendingReviewStorage } from '../../src/features/studio/components/use-pending-review-storage'
import { usePlanSync } from '../../src/features/studio/components/use-plan-sync'
import type { ChapterDraftState, ChapterPendingReview, PlanPendingReview } from '../../src/features/studio/types'
import type { Chapter } from '../../shared/contracts/index.js'
import { PENDING_CHAPTER_REVIEW_STORAGE_PREFIX as CHAPTER, PENDING_PLAN_REVIEW_STORAGE_PREFIX as PLAN } from '../../src/features/studio/lib/plan-review'

const api = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn(), plan: vi.fn() }))
vi.mock('../../src/features/studio/api', () => ({ updateChapterDraft: api.update, createChapterDraft: api.create, updateNovelPlanFile: api.plan }))
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

it('joins one outgoing save and navigates only to the most recent B -> C intent', async () => {
  const pending = deferred<void>(), save = vi.fn(() => pending.promise), navigate = vi.fn(), onError = vi.fn(), owner = {}
  const hook = renderHook(() => useWorkspaceNovelTransition({ owner, novelId: 'a', save, navigate, onError }))
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = hook.result.current('b'); second = hook.result.current('c') })
  await act(async () => { await Promise.resolve() })
  expect(save).toHaveBeenCalledOnce()
  expect(navigate).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(); await Promise.all([first, second]) })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('c', undefined)
})

it('selecting current A cancels the pending A -> B intent without cancelling its normal save', async () => {
  const pending = deferred<void>(), save = vi.fn(() => pending.promise), navigate = vi.fn(), owner = {}
  const hook = renderHook(() => useWorkspaceNovelTransition({ owner, novelId: 'a', save, navigate, onError: vi.fn() }))
  let waiting!: Promise<void>
  act(() => { waiting = hook.result.current('b'); void hook.result.current('a') })
  await act(async () => { pending.resolve(); await waiting })
  expect(save).toHaveBeenCalledOnce()
  expect(navigate).not.toHaveBeenCalled()
})

it('fences a late A response after A -> B -> A or unmount rather than trusting the same novel id', async () => {
  const pending = deferred<void>(), navigate = vi.fn(), onError = vi.fn()
  const hook = renderHook(({ owner, novelId }) => useWorkspaceNovelTransition({ owner, novelId, save: () => pending.promise, navigate, onError }), { initialProps: { owner: {}, novelId: 'a' } })
  let waiting!: Promise<void>
  act(() => { waiting = hook.result.current('c') })
  await act(async () => { await Promise.resolve() })
  hook.rerender({ owner: {}, novelId: 'b' }); hook.rerender({ owner: {}, novelId: 'a' }); hook.unmount()
  await act(async () => { pending.reject(new Error('late error')); await waiting })
  expect(navigate).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled()
})

const draft: ChapterDraftState = { id: 'chapter-a', title: 'A章节', content: 'AI正文', summary: '', status: 'draft', visibility: 'private', orderIndex: 1, revision: 7, localOnly: false }
const review: ChapterPendingReview = { id: 'review-a', chapterId: draft.id, runId: 'run-a', artifactId: 'artifact-a', before: { ...draft, content: '原文', revision: 6 }, after: draft, rollbackSnapshot: { kind: 'restore_chapter', chapter: { ...draft, content: '原文', wordCount: 2, updatedAt: null } }, description: '待确认', createdAt: '2026-10-15T00:00:00Z' }
const plan: PlanPendingReview = { id: 'plan-review-a', backendArtifactId: 'plan-a', title: '计划', beforeTitle: '旧计划', before: '原计划', after: 'AI计划', description: '待确认', runId: 'run-a', createdAt: review.createdAt }
function workspace() {
  localStorage.setItem(CHAPTER+'a', JSON.stringify([review])); localStorage.setItem(PLAN+'a', JSON.stringify(plan))
  const database = new Map<string, ChapterDraftState>([['a', draft], ['b', { ...draft, id: 'chapter-b', content: 'B正文', revision: 3 }]])
  const onError = vi.fn(), navigate = vi.fn()
  const hook = renderHook(() => {
    const [novel, setNovel] = useState('a'), [current, setDraft] = useState<ChapterDraftState | null>(draft), [dirty, setDirty] = useState(false)
    const [reviews, setReviews] = useState<ChapterPendingReview[]>([]), [pendingPlan, setPlan] = useState<PlanPendingReview | null>(null)
    const currentRef = useRef(current), dirtyRef = useRef(dirty), reviewRef = useRef(reviews)
    currentRef.current = current; dirtyRef.current = dirty; reviewRef.current = reviews
    const owner = useMemo(() => ({ novel, session: 'session-'+novel }), [novel])
    const flushReviews = usePendingReviewStorage(novel, reviews, pendingPlan, setReviews, setPlan)
    const plans = usePlanSync()
    useEffect(() => { setDraft(database.get(novel)!); setDirty(false) }, [novel])
    const persist = useChapterPersistence({ activeNovelId: novel, scope: owner.session, chapterDraft: current, chapterDirty: dirty,
      chapterDraftStateRef: currentRef, chapterDirtyStateRef: dirtyRef, pendingChapterReviewsRef: reviewRef, setPendingChapterReviews: setReviews,
      selectedChapterIdStateRef: { current: current?.id ?? null }, setChapterDraft: setDraft, setChapterDirty: setDirty,
      syncSavedChapter: saved => database.set(novel, saved), promptConfirmPendingChapterReview: vi.fn(), setChapterSaveState: vi.fn(), setChapterSaveMessage: vi.fn(), setChapters: vi.fn(), setSelectedTreeItemId: vi.fn(), setSelectedChapterId: vi.fn(), setChapterLastSavedAt: vi.fn(), setCurrentNovel: vi.fn(), syncStudioPayload: vi.fn() })
    const transition = useWorkspaceNovelTransition({ owner, novelId: novel,
      save: async () => { await persist.flushForSwitch(); await plans.awaitPlanServerSync(); flushReviews(reviewRef.current) },
      navigate: (target, sessionId) => { navigate(target, sessionId); setNovel(target) }, onError })
    return { novel, current, dirty, reviews, pendingPlan, session: owner.session, transition, persist, plans,
      edit: (content: string, id = currentRef.current!.id) => { const next = { ...currentRef.current!, id, content }; currentRef.current = next; dirtyRef.current = true; setDraft(next); setDirty(true) } }
  }, { wrapper: StrictMode })
  return { ...hook, onError, navigate, database }
}

it('saves author edits without deciding reviews and restores A pending body/plan/revision and session after A -> B -> A', async () => {
  api.update.mockImplementation(async (_novel, _chapter, input) => ({ ...draft, ...input, revision: 8, updatedAt: review.createdAt, wordCount: input.content.length } as Chapter))
  const hook = workspace()
  act(() => hook.result.current.edit('作者新输入'))
  await act(async () => { await hook.result.current.transition('b') })
  expect(hook.result.current.novel).toBe('b'); expect(hook.result.current.reviews).toEqual([])
  expect(hook.result.current.pendingPlan).toBeNull()
  expect(api.update).toHaveBeenCalledExactlyOnceWith('a', draft.id, expect.objectContaining({ content: '作者新输入', expectedRevision: 7 }))
  const preserved = JSON.parse(localStorage.getItem(CHAPTER+'a')!) as ChapterPendingReview[]
  expect(preserved).toEqual([{ ...review, after: expect.objectContaining({ content: '作者新输入', revision: 8 }) }])
  expect(JSON.parse(localStorage.getItem(PLAN+'a')!)).toEqual(plan)
  await act(async () => { await hook.result.current.transition('a') })
  expect(hook.result.current.current).toMatchObject({ content: '作者新输入', revision: 8 })
  expect(hook.result.current.reviews).toEqual(preserved); expect(hook.result.current.pendingPlan).toEqual(plan)
  expect(hook.result.current.session).toBe('session-a'); expect(api.create).not.toHaveBeenCalled()
})

it('keeps A dirty and its pending baseline/revision intact when the normal save fails', async () => {
  const error = new Error('真实 revision 冲突')
  api.update.mockRejectedValueOnce(error)
  const hook = workspace()
  act(() => hook.result.current.edit('未保存作者输入'))
  await act(async () => { await hook.result.current.transition('b') })
  expect(hook.result.current.novel).toBe('a'); expect(hook.result.current.dirty).toBe(true)
  expect(hook.result.current.current?.content).toBe('未保存作者输入'); expect(hook.result.current.reviews).toEqual([review])
  expect(hook.onError).toHaveBeenCalledExactlyOnceWith(error); expect(hook.navigate).not.toHaveBeenCalled()
})

it('joins an existing real body save and does not navigate on its failure', async () => {
  const pending = deferred<Chapter>(), error = new Error('inflight network failed')
  api.update.mockReturnValueOnce(pending.promise)
  const hook = workspace()
  // A normal auto save for an unrelated reviewed chapter is still permitted.
  act(() => hook.result.current.edit('输入', 'unreviewed'))
  let save!: Promise<void>, switching!: Promise<void>
  act(() => { save = hook.result.current.persist('auto'); switching = hook.result.current.transition('b') })
  await act(async () => { await Promise.resolve() })
  expect(hook.navigate).not.toHaveBeenCalled(); expect(api.update).toHaveBeenCalledOnce()
  await act(async () => { pending.reject(error); await Promise.all([save, switching]) })
  expect(hook.navigate).not.toHaveBeenCalled(); expect(hook.result.current.novel).toBe('a')
  expect(hook.onError).toHaveBeenCalledExactlyOnceWith(error)
})

it('preserves both pending reviews and remains in A when flushing a plan fails', async () => {
  const error = new Error('计划原始保存错误')
  api.plan.mockRejectedValueOnce(error)
  const hook = workspace()
  act(() => hook.result.current.plans.schedulePlanServerSync('plan-a', '计划', '作者计划'))
  await act(async () => { await hook.result.current.transition('b') })
  expect(hook.result.current.novel).toBe('a'); expect(hook.result.current.reviews).toEqual([review]); expect(hook.result.current.pendingPlan).toEqual(plan)
  expect(hook.onError).toHaveBeenCalledExactlyOnceWith(error); expect(hook.navigate).not.toHaveBeenCalled()
})

it('saves newer author input using the returned revision before it can leave A', async () => {
  const first = deferred<Chapter>()
  api.update.mockReturnValueOnce(first.promise).mockImplementationOnce(async (_novel, _chapter, input) => ({ ...draft, ...input, revision: 9, updatedAt: review.createdAt, wordCount: input.content.length } as Chapter))
  const hook = workspace()
  act(() => hook.result.current.edit('第一批输入'))
  let switching!: Promise<void>
  act(() => { switching = hook.result.current.transition('b') })
  await act(async () => { await Promise.resolve() })
  act(() => hook.result.current.edit('保存期间的新输入'))
  await act(async () => { first.resolve({ ...draft, content: '第一批输入', revision: 8, updatedAt: review.createdAt } as Chapter); await switching })
  expect(api.update.mock.calls.map(call => ({ revision: call[2].expectedRevision, content: call[2].content }))).toEqual([
    { revision: 7, content: '第一批输入' }, { revision: 8, content: '保存期间的新输入' },
  ])
  expect(hook.result.current.novel).toBe('b')
  expect(JSON.parse(localStorage.getItem(CHAPTER+'a')!)[0]).toEqual({ ...review, after: expect.objectContaining({ content: '保存期间的新输入', revision: 9 }) })
})

it('joins an existing auto save, then saves newer input with its real revision before navigating', async () => {
  const first = deferred<Chapter>()
  api.update.mockReturnValueOnce(first.promise).mockImplementationOnce(async (_novel, _chapter, input) => ({ ...draft, id: 'unreviewed', ...input, revision: 9, updatedAt: review.createdAt } as Chapter))
  const hook = workspace()
  act(() => hook.result.current.edit('自动保存中的旧输入', 'unreviewed'))
  let saving!: Promise<void>, switching!: Promise<void>
  act(() => { saving = hook.result.current.persist('auto'); switching = hook.result.current.transition('b') })
  await act(async () => { await Promise.resolve() })
  act(() => hook.result.current.edit('自动保存后又输入'))
  expect(hook.navigate).not.toHaveBeenCalled()
  await act(async () => { first.resolve({ ...draft, id: 'unreviewed', content: '自动保存中的旧输入', revision: 8, updatedAt: review.createdAt } as Chapter); await Promise.all([saving, switching]) })
  expect(api.update.mock.calls.map(call => ({ revision: call[2].expectedRevision, content: call[2].content }))).toEqual([
    { revision: 7, content: '自动保存中的旧输入' }, { revision: 8, content: '自动保存后又输入' },
  ])
  expect(hook.result.current.novel).toBe('b'); expect(hook.database.get('a')).toMatchObject({ content: '自动保存后又输入', revision: 9 })
})
