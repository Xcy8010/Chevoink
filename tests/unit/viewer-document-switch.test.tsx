// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PlanMarkdownEditor from '../../src/features/studio/components/PlanMarkdownEditor'
import StudioChapterViewer from '../../src/features/studio/components/StudioChapterViewer'

const rich = vi.hoisted(() => ({ ready: new Map<string, () => void>(), edits: new Map<string, {
  onChange: (text: string) => void; onCommitPending: (text: string) => void
}>() }))
vi.mock('../../src/features/studio/components/PlanRichMarkdownEditor', () => ({
  default: ({ markdown, onReady, onChange, onCommitPending }: {
    markdown: string; onReady: () => void; onChange: (text: string) => void; onCommitPending: (text: string) => void
  }) => {
    rich.ready.set(markdown, onReady)
    rich.edits.set(markdown, { onChange, onCommitPending })
    return <div>编辑器已接收 {markdown}</div>
  },
}))
afterEach(() => { cleanup(); rich.ready.clear(); rich.edits.clear(); vi.useRealTimers() })

it('supersedes the pending debounce when the editor flushes its latest author transaction', async () => {
  const save = vi.fn()
  const ui = render(<PlanMarkdownEditor documentId="a" positionScope="task" markdown="甲" onChange={save} />)
  await vi.waitFor(() => expect(rich.edits.has('甲')).toBe(true))
  vi.useFakeTimers()
  const editor = rich.edits.get('甲')!
  act(() => {
    editor.onChange('未提交的旧输入')
    editor.onCommitPending('完整的最终输入')
    vi.advanceTimersByTime(300)
  })
  ui.unmount()
  expect(save).toHaveBeenCalledExactlyOnceWith('完整的最终输入')
})

it('shows the selected plan from the first render and hands off only to its own ready editor', async () => {
  const first = '# 甲计划', second = '# 乙计划'
  const ui = render(<PlanMarkdownEditor documentId="a" positionScope="work" markdown={first} />)
  expect(screen.getByRole('heading', { name: '甲计划' })).toBeTruthy()
  await vi.waitFor(() => expect(rich.ready.has(first)).toBe(true))
  const finishFirst = rich.ready.get(first)!
  ui.rerender(<PlanMarkdownEditor documentId="b" positionScope="work" markdown={second} />)
  expect(screen.queryByRole('heading', { name: '甲计划' })).toBeNull()
  expect(screen.getByRole('heading', { name: '乙计划' })).toBeTruthy()
  act(() => finishFirst())
  expect(screen.getByRole('heading', { name: '乙计划' })).toBeTruthy()
  await vi.waitFor(() => expect(rich.ready.has(second)).toBe(true))
  act(() => rich.ready.get(second)!())
  expect(screen.queryByRole('heading', { name: '乙计划' })).toBeNull()
  expect(screen.getByText('编辑器已接收 ' + second).closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('false')
})

it('retains the previous body read-only during a cold read and flushes buffered text only to its original chapter', () => {
  vi.useFakeTimers()
  const commitChapter = vi.fn(), commitCatalog = vi.fn(), select = vi.fn()
  const common = {
    positionScope: 'task-a', selection: { start: 0, end: 0, text: '' }, onSelectionChange: select,
    onAddSelection: vi.fn(), onClose: vi.fn(), onBlur: vi.fn(), onChange: commitChapter,
  }
  const chapter = { id: 'same', title: '甲章', content: '甲章内容', summary: '', orderIndex: 0, revision: 1, localOnly: false, status: 'draft' as const, visibility: 'private' as const }
  const ui = render(<StudioChapterViewer {...common} draft={chapter} />)
  const old = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(old, { target: { value: '尚未保存的甲章' } })
  old.setSelectionRange(1, 5)
  fireEvent.select(old)
  select.mockClear()
  ui.rerender(<StudioChapterViewer {...common} draft={null} workspaceDocument={{
    kind: 'catalog', id: 'same', title: '目录', content: '目录正文', description: '', editableContent: true, editableTitle: false,
  }} onWorkspaceDocumentChange={commitCatalog} />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('目录正文')
  expect(commitChapter).toHaveBeenCalledExactlyOnceWith({ ...chapter, content: '尚未保存的甲章' })
  act(() => vi.advanceTimersByTime(300))
  expect(commitCatalog).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  ui.rerender(<StudioChapterViewer {...common} draft={null} pendingChapterTitle="冷启动乙章" loading />)
  expect(screen.getByRole('status').textContent).toContain('冷启动乙章')
  expect(screen.getByRole('status').classList.contains('sr-only')).toBe(true)
  const retained = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(retained.value).toBe('目录正文')
  expect(retained.readOnly).toBe(true)
  expect(screen.getByText('目录')).toBeTruthy()
  expect((screen.getByRole('button', { name: '添加到输入框' }) as HTMLButtonElement).disabled).toBe(true)
  ui.rerender(<StudioChapterViewer {...common} draft={null} pendingChapterTitle="冷启动乙章" errorMessage="无权访问本章" />)
  expect(screen.getByText('无权访问本章')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  ui.rerender(<StudioChapterViewer {...common} draft={chapter} />)
  ui.rerender(<StudioChapterViewer {...common} positionScope="task-b" draft={null} pendingChapterTitle="其他任务" loading />)
  expect(screen.getByText('其他任务')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})
