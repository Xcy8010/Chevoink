// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ChapterSidebar from '../../src/features/studio/components/ChapterSidebar'
afterEach(() => { cleanup(); localStorage.clear() })
const noop = () => {}
const props: ComponentProps<typeof ChapterSidebar> = {
  taskScope: 'user:n:task-a',
  chapters: [{ id: 'c1', title: '起始', volumeId: 'v1', orderIndex: 1, orderInVolume: 1 }, { id: 'c2', title: '转折', volumeId: 'v2', orderIndex: 2, orderInVolume: 1 }] as ComponentProps<typeof ChapterSidebar>['chapters'],
  volumes: [{ id: 'v1', title: '开篇', orderIndex: 1 }, { id: 'v2', title: '发展', orderIndex: 2 }] as ComponentProps<typeof ChapterSidebar>['volumes'],
  savedPlans: [], selectedChapterId: null, selectedTreeItemId: null, catalogPreview: { title: '目录', content: '', description: '' }, novelTitle: '合成作品', novelWordCountLabel: '', chapterCountLabel: '', activeCoverLabel: '',
  onSelectChapter: noop, onSelectPlan: noop, onSelectCatalog: noop, onCreateChapter: noop, onCreatePlan: noop, onOpenChapterSettings: noop, onOpenPlanSettings: noop,
}
it('keeps volume expansion under each task through A to B to A and remount', () => {
  const view = render(<ChapterSidebar {...props} />, { wrapper: StrictMode })
  const first = screen.getByRole('button', { name: '第 1 卷 · 开篇' })
  expect(first.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(first)
  expect(screen.queryByText('第 1 章 · 起始')).toBeNull()
  expect(document.activeElement === first || document.activeElement === document.body).toBe(true)
  view.rerender(<ChapterSidebar {...props} taskScope="user:n:task-b" />)
  expect(screen.getByRole('button', { name: '第 1 卷 · 开篇' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('第 1 章 · 起始')).toBeTruthy()
  view.rerender(<ChapterSidebar {...props} />)
  expect(screen.getByRole('button', { name: '第 1 卷 · 开篇' }).getAttribute('aria-expanded')).toBe('false')
  view.unmount(); render(<ChapterSidebar {...props} />)
  expect(screen.getByRole('button', { name: '第 1 卷 · 开篇' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByText('第 1 章 · 转折')).toBeTruthy()
})
it('keeps volume settings and chapter drop targets reachable while collapsed', () => {
  const onOpenVolumeSettings = vi.fn(), onMoveChapter = vi.fn()
  render(<ChapterSidebar {...props} onOpenVolumeSettings={onOpenVolumeSettings} onMoveChapter={onMoveChapter} />)
  fireEvent.click(screen.getByRole('button', { name: '第 1 卷 · 开篇' }))
  fireEvent.click(screen.getByRole('button', { name: '卷设置：开篇' }))
  expect(onOpenVolumeSettings).toHaveBeenCalledExactlyOnceWith('v1')
  expect(screen.getByRole('button', { name: '第 1 卷 · 开篇' }).getAttribute('aria-expanded')).toBe('false')
  const row = screen.getByText('第 1 章 · 转折').closest('[draggable]')!
  const dataTransfer = { effectAllowed: '', setData: vi.fn() }
  fireEvent.dragStart(row, { dataTransfer })
  fireEvent.drop(screen.getByRole('button', { name: '第 1 卷 · 开篇' }).parentElement!, { dataTransfer })
  expect(onMoveChapter).toHaveBeenCalledWith('c2', 'v1', 2)
})
