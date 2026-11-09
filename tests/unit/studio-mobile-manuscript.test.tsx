// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import EditorCanvas from '../../src/features/studio/components/EditorCanvas'
import type { ChapterDraftState, ChapterPendingReview } from '../../src/features/studio/types'

vi.mock('../../src/features/studio/components/PlanMarkdownEditor', () => ({ default: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const before: ChapterDraftState = {
  id: 'chapter-1', title: '夜里的鞋', summary: '', content: '旧第一段\n保持原样\n旧第二段',
  status: 'draft', visibility: 'private', orderIndex: 1, revision: 1, localOnly: false,
}
const after: ChapterDraftState = { ...before, content: '新第一段\n保持原样\n新第二段', revision: 2 }
const snapshot = { ...before, wordCount: 12, updatedAt: null }
const review: ChapterPendingReview = {
  id: 'review-1', chapterId: after.id, before, after, description: '审阅说明', createdAt: '',
  rollbackSnapshot: { kind: 'restore_chapter', chapter: snapshot, selectedChapterId: after.id },
}

function mobileProps() {
  return {
    variant: 'mobile' as const,
    chapterDraft: after, chapterLoading: false, chapterErrorMessage: null,
    chapterSaveState: 'saved' as const, chapterSaveMessage: '', latestWordCountLabel: '1,157 字',
    selectedCommentCount: 0,
    onSave: vi.fn(), onRetryLoad: vi.fn(), onCreateChapter: vi.fn(), onOpenChapterSettings: vi.fn(),
    onStatusChange: vi.fn(), onChange: vi.fn(), onSelectMobileChapter: vi.fn(),
    onAcceptReviewHunk: vi.fn(), onRejectReviewHunk: vi.fn(), onKeepPendingReview: vi.fn(),
    onRevertPendingReview: vi.fn(), onNavigateReviewFile: vi.fn(), onGoToNextReviewFile: vi.fn(),
  }
}

it('uses one mobile manuscript scroll area with chapter and whole-review actions in its header', () => {
  const props = mobileProps()
  const { container, rerender } = render(<EditorCanvas {...props} pendingChapterReview={review} reviewFileCount={2} />)
  const viewport = container.querySelector('[data-mobile-manuscript]')!
  const toolbar = screen.getByRole('group', { name: '当前变更操作' })
  expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1)
  expect(viewport.contains(toolbar)).toBe(false)
  expect(screen.getAllByText('夜里的鞋')).toHaveLength(1)
  expect(screen.queryByText(/审阅说明/)).toBeNull()
  expect(screen.getByText('旧第一段').tagName).toBe('DEL')
  expect(screen.queryByRole('button', { name: '保留整章' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '选择章节，当前：夜里的鞋' }))
  expect(props.onSelectMobileChapter).toHaveBeenCalledOnce()
  const more = screen.getByRole('button', { name: '更多操作' })
  fireEvent.click(more)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('待审章节 1 / 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '上一待审章节' }))
  expect(props.onNavigateReviewFile).toHaveBeenCalledWith(-1)
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: '下一待审章节' }))
  expect(props.onNavigateReviewFile).toHaveBeenCalledWith(1)
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: '撤回本次整章修改' }))
  expect(props.onRevertPendingReview).toHaveBeenCalledOnce()
  expect(props.onRejectReviewHunk).not.toHaveBeenCalled()

  rerender(<EditorCanvas {...props} pendingReviewRemaining={1} />)
  expect(screen.getByRole('textbox', { name: '章节正文' })).toBeTruthy()
  expect(screen.queryByRole('group', { name: '当前变更操作' })).toBeNull()
  expect(screen.queryByRole('button', { name: '下一待审章节' })).toBeNull()
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: '下一待审章节' }))
  expect(props.onGoToNextReviewFile).toHaveBeenCalledOnce()
})

it('locates and processes the current visible mobile change, including after a manual scroll', () => {
  let viewportHeight = 200
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>('[data-mobile-manuscript]')
    if (this === viewport) return { top: 0, bottom: viewportHeight } as DOMRect
    const first = this.parentElement?.classList.contains('studio-editor-content') && this.textContent?.includes('旧第一段')
    const top = (first ? 24 : 500) - (viewport?.scrollTop ?? 0)
    return { top, bottom: top + 80 } as DOMRect
  })
  const props = mobileProps()
  const { container, rerender } = render(<EditorCanvas {...props} pendingChapterReview={review} />)
  const viewport = container.querySelector<HTMLElement>('[data-mobile-manuscript]')!
  const previous = screen.getByRole<HTMLButtonElement>('button', { name: '上一处变更' })
  const next = screen.getByRole<HTMLButtonElement>('button', { name: '下一处变更' })
  const keep = screen.getByRole<HTMLButtonElement>('button', { name: '保留此处' })
  expect(previous.disabled).toBe(true)
  expect(keep.disabled).toBe(false)

  viewport.scrollTop = 220
  fireEvent.scroll(viewport)
  expect(keep.disabled).toBe(true)
  fireEvent.click(next)
  expect(next.disabled).toBe(true)
  expect(viewport.scrollTop).toBe(488)
  expect(viewport.querySelector('[aria-current="true"]')?.textContent).toContain('新第二段')
  fireEvent.click(keep)
  expect(props.onAcceptReviewHunk).toHaveBeenCalledWith(1)

  viewport.scrollTop = 0
  fireEvent.scroll(viewport)
  expect(previous.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '撤回此处' }))
  expect(props.onRejectReviewHunk).toHaveBeenCalledWith(0)

  // The old hunk is clipped to one pixel, so the readable next change takes focus.
  viewportHeight = 500
  viewport.scrollTop = 103
  fireEvent.scroll(viewport)
  expect(next.disabled).toBe(true)
  expect(viewport.querySelector('[aria-current="true"]')?.textContent).toContain('新第二段')
  rerender(<EditorCanvas {...props} pendingChapterReview={review} pendingChapterReviewBusy />)
  expect(keep.disabled).toBe(true)
  expect(next.disabled).toBe(true)
})

it('reads a newly written chapter as a manuscript and labels whole-chapter withdrawal explicitly', () => {
  const newlyCreated: ChapterPendingReview = {
    ...review, before: null,
    rollbackSnapshot: { kind: 'remove_created_chapter', chapter: snapshot, previousSelectedChapterId: null },
  }
  render(<EditorCanvas {...mobileProps()} pendingChapterReview={newlyCreated} />)
  expect(screen.getByText('新章节 · 待确认')).toBeTruthy()
  expect(screen.getByText(/新第一段/).className).not.toMatch(/(?:emerald|bg-)/)
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
  expect(screen.getByRole('button', { name: '撤回新建章节' })).toBeTruthy()
})

it('restores the writing position only when returning from review in the same chapter and task', () => {
  const props = mobileProps()
  const { container, rerender } = render(<EditorCanvas {...props} mobileScope="task-a" pendingChapterReview={review} />)
  const scrollArea = () => container.querySelector<HTMLElement>('[data-mobile-manuscript]')!
  scrollArea().scrollTop = 370
  fireEvent.scroll(scrollArea())
  rerender(<EditorCanvas {...props} mobileScope="task-a" />)
  expect(scrollArea().scrollTop).toBe(370)

  rerender(<EditorCanvas {...props} mobileScope="task-a" pendingChapterReview={review} />)
  scrollArea().scrollTop = 400
  fireEvent.scroll(scrollArea())
  rerender(<EditorCanvas {...props} mobileScope="task-b" />)
  expect(scrollArea().scrollTop).toBe(0)
})

it('makes a blank-line deletion a visible and actionable mobile hunk', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 40 } as DOMRect)
  const props = mobileProps()
  const blankLineReview = {
    ...review,
    before: { ...before, content: '甲\n\n乙' },
    after: { ...after, content: '甲\n乙' },
  }
  render(<EditorCanvas {...props} pendingChapterReview={blankLineReview} />)
  expect(screen.getByText('删除空行').closest('[aria-current="true"]')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保留此处' }))
  expect(props.onAcceptReviewHunk).toHaveBeenCalledWith(0)
})
