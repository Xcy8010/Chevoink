// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePendingReviewStorage } from '../../src/features/studio/components/use-pending-review-storage'
import type { ChapterPendingReview, PlanPendingReview } from '../../src/features/studio/types'
import { PENDING_CHAPTER_REVIEW_STORAGE_PREFIX as CHAPTER, PENDING_PLAN_REVIEW_STORAGE_PREFIX as PLAN } from '../../src/features/studio/lib/plan-review'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

function useFixture(novelId: string) {
  const [chapters, setChapters] = useState<ChapterPendingReview[]>([])
  const [plan, setPlan] = useState<PlanPendingReview | null>(null)
  const flush = usePendingReviewStorage(novelId, chapters, plan, setChapters, setPlan)
  return { chapters, plan, setChapters, setPlan, flush }
}

it('preserves the old novel reviews across creation, return and refresh, including StrictMode', () => {
  const chapters = [{ id: 'review-a', chapterId: 'chapter-a', before: { content: 'old' }, after: { content: 'new' }, description: 'pending' }]
  const plan = { id: 'plan-a', before: 'old plan', after: 'new plan' }
  localStorage.setItem(CHAPTER + 'a', JSON.stringify(chapters))
  localStorage.setItem(PLAN + 'a', JSON.stringify(plan))
  const hook = renderHook(({ novel }) => useFixture(novel), { initialProps: { novel: 'a' }, wrapper: StrictMode })
  expect(hook.result.current.chapters).toEqual(chapters)
  expect(hook.result.current.plan).toEqual(plan)
  hook.rerender({ novel: 'new-b' })
  expect(hook.result.current.chapters).toEqual([])
  expect(hook.result.current.plan).toBeNull()
  expect(JSON.parse(localStorage.getItem(CHAPTER + 'a')!)).toEqual(chapters)
  expect(JSON.parse(localStorage.getItem(PLAN + 'a')!)).toEqual(plan)
  hook.rerender({ novel: 'a' })
  expect(hook.result.current.chapters).toEqual(chapters)
  expect(hook.result.current.plan).toEqual(plan)
  hook.unmount()
  const restored = renderHook(() => useFixture('a'), { wrapper: StrictMode })
  expect(restored.result.current.chapters).toEqual(chapters)
  expect(restored.result.current.plan).toEqual(plan)
})

it('persists explicit review resolution only in the owning novel', () => {
  for (const novel of ['a', 'b']) {
    localStorage.setItem(CHAPTER + novel, JSON.stringify([{ id: novel }]))
    localStorage.setItem(PLAN + novel, JSON.stringify({ id: novel }))
  }
  const hook = renderHook(({ novel }) => useFixture(novel), { initialProps: { novel: 'a' } })
  act(() => { hook.result.current.setChapters([]); hook.result.current.setPlan(null) })
  expect(localStorage.getItem(CHAPTER + 'a')).toBeNull()
  expect(localStorage.getItem(PLAN + 'a')).toBeNull()
  hook.rerender({ novel: 'b' })
  expect(hook.result.current.chapters).toEqual([{ id: 'b' }])
  expect(hook.result.current.plan).toEqual({ id: 'b' })
})

it('reports a real storage failure instead of declaring the outgoing reviews preserved', () => {
  const hook = renderHook(() => useFixture('a'))
  const error = new DOMException('Review storage quota exceeded', 'QuotaExceededError')
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw error })
  try {
    let caught: unknown
    try { hook.result.current.flush([{ id: 'pending' } as ChapterPendingReview]) } catch (failure) { caught = failure }
    expect(caught).toBe(error)
  } finally { write.mockRestore() }
})
