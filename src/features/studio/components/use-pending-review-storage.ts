import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ChapterPendingReview, PlanPendingReview } from '../types'
import { PENDING_CHAPTER_REVIEW_STORAGE_PREFIX, PENDING_PLAN_REVIEW_STORAGE_PREFIX, readStoredPendingReview, readStoredPendingReviewList, writeStoredPendingReview } from '../lib/plan-review'

/** Hydrate and persist only values owned by the currently selected novel. */
export function usePendingReviewStorage(
  novelId: string,
  chapters: ChapterPendingReview[],
  plan: PlanPendingReview | null,
  setChapters: Dispatch<SetStateAction<ChapterPendingReview[]>>,
  setPlan: Dispatch<SetStateAction<PlanPendingReview | null>>,
) {
  const [hydratedNovelId, setHydratedNovelId] = useState<string>()
  const latest = useRef({ novelId, hydratedNovelId, chapters, plan })
  latest.current = { novelId, hydratedNovelId, chapters, plan }
  useLayoutEffect(() => {
    setChapters(readStoredPendingReviewList<ChapterPendingReview>(`${PENDING_CHAPTER_REVIEW_STORAGE_PREFIX}${novelId}`))
    setPlan(readStoredPendingReview<PlanPendingReview>(`${PENDING_PLAN_REVIEW_STORAGE_PREFIX}${novelId}`))
    setHydratedNovelId(novelId)
  }, [novelId, setChapters, setPlan])
  useLayoutEffect(() => {
    // The outgoing commit still contains the previous novel's review values.
    if (hydratedNovelId !== novelId) return
    writeStoredPendingReview(`${PENDING_CHAPTER_REVIEW_STORAGE_PREFIX}${novelId}`, chapters.length ? chapters : null)
    writeStoredPendingReview(`${PENDING_PLAN_REVIEW_STORAGE_PREFIX}${novelId}`, plan)
  }, [novelId, hydratedNovelId, chapters, plan])
  return useCallback((chapterReviews?: ChapterPendingReview[]) => {
    const current = latest.current
    if (current.hydratedNovelId !== current.novelId) throw new Error('作品审查状态尚未恢复，请稍后再试。')
    // Unlike the background best-effort effect, switching requires real durable
    // storage; a quota/permission failure must leave the author in this novel.
    const write = (key: string, value: unknown) => {
      if (value) window.localStorage.setItem(key, JSON.stringify(value))
      else window.localStorage.removeItem(key)
    }
    const reviews = chapterReviews ?? current.chapters
    write(`${PENDING_CHAPTER_REVIEW_STORAGE_PREFIX}${current.novelId}`, reviews.length ? reviews : null)
    write(`${PENDING_PLAN_REVIEW_STORAGE_PREFIX}${current.novelId}`, current.plan)
  }, [])
}
