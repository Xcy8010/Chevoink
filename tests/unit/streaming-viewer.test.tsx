// @vitest-environment jsdom
import { StrictMode, useLayoutEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import LocalFirstTextarea from '../../src/features/studio/components/LocalFirstTextarea'
import { useStreamingAutoFollow } from '../../src/features/studio/components/useStreamingAutoFollow'
import StudioChapterViewer from '../../src/features/studio/components/StudioChapterViewer'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
function Scroll({ content, scope = 'task:chapter', rich = false }: { content: string; scope?: string; rich?: boolean }) {
  const follow = useStreamingAutoFollow<HTMLElement>(true, content, scope)
  return rich ? <div ref={follow.ref} onScroll={follow.onScroll} data-testid="scroller">{content}</div>
    : <textarea aria-label="正文" readOnly value={content} ref={follow.ref} onScroll={follow.onScroll} />
}
function metrics(node: HTMLElement) {
  let height = 600, top = 0
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 200)) } },
  })
  return { grow: (next: number) => { height = next } }
}
const frame = () => act(() => vi.advanceTimersByTime(20))
it('follows growth despite layout scroll events, pauses for human wheel/keyboard scroll and resumes at the real bottom', () => {
  const view = render(<StrictMode><Scroll content="一" /></StrictMode>)
  const node = screen.getByRole('textbox')
  const size = metrics(node)
  frame()
  expect(node.scrollTop).toBe(400)
  size.grow(900)
  view.rerender(<StrictMode><Scroll content="一二" /></StrictMode>)
  fireEvent.scroll(node)
  frame()
  expect(node.scrollTop).toBe(700)
  fireEvent.wheel(node, { deltaY: -200 })
  node.scrollTop = 300
  fireEvent.scroll(node)
  size.grow(1200)
  view.rerender(<StrictMode><Scroll content="一二三" /></StrictMode>)
  frame()
  expect(node.scrollTop).toBe(300)
  // Programmatic growth alone cannot resume following.
  act(() => vi.advanceTimersByTime(1300))
  node.scrollTop = 1000
  fireEvent.scroll(node)
  size.grow(1400)
  view.rerender(<StrictMode><Scroll content="一二三四" /></StrictMode>)
  frame()
  expect(node.scrollTop).toBe(1000)
  fireEvent.keyDown(node, { key: 'End' })
  node.scrollTop = 1200
  fireEvent.scroll(node)
  size.grow(1600)
  view.rerender(<StrictMode><Scroll content="五" /></StrictMode>)
  fireEvent.scroll(node)
  frame()
  expect(node.scrollTop).toBe(1400)
})
it('resets manual intent and pending work on document/task change without remounting the editor', () => {
  const view = render(<Scroll content="一" />)
  const node = screen.getByRole('textbox')
  const size = metrics(node)
  frame()
  fireEvent.pointerDown(node)
  node.scrollTop = 10
  fireEvent.scroll(node)
  size.grow(1000)
  view.rerender(<Scroll content="另一个文档" scope="other:chapter" />)
  expect(screen.getByRole('textbox')).toBe(node)
  frame()
  expect(node.scrollTop).toBe(800)
  fireEvent.scroll(node)
  size.grow(1100)
  view.rerender(<Scroll content="另一个文档继续" scope="other:chapter" />)
  frame()
  expect(node.scrollTop).toBe(900)
})
it('follows rich editor DOM delivery after the content render, and cancels detached work', async () => {
  const view = render(<Scroll content="一" rich />)
  const node = screen.getByTestId('scroller')
  const size = metrics(node)
  frame()
  size.grow(900)
  await act(async () => { node.textContent = '富文本延迟交付'; await Promise.resolve() })
  frame()
  expect(node.scrollTop).toBe(700)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('keeps the exact textarea and saved content through the read-only stream handoff before parent layout/paint', () => {
  const commit = vi.fn(), seen: string[] = []
  function Probe({ value, readOnly }: { value: string; readOnly: boolean }) {
    const node = useRef<HTMLTextAreaElement>(null)
    useLayoutEffect(() => { seen.push(node.current!.value) })
    return <LocalFirstTextarea ref={node} aria-label="正文" value={value} readOnly={readOnly} resetKey="chapter" onCommit={commit} />
  }
  const view = render(<Probe value="" readOnly={false} />)
  const node = screen.getByRole('textbox') as HTMLTextAreaElement
  node.focus()
  view.rerender(<Probe value="流式正文" readOnly />)
  view.rerender(<Probe value="完整已保存正文" readOnly />)
  seen.length = 0
  view.rerender(<Probe value="完整已保存正文" readOnly={false} />)
  expect(seen).toEqual(['完整已保存正文'])
  expect(screen.getByRole('textbox')).toBe(node)
  expect(document.activeElement).toBe(node)
  view.unmount()
  expect(commit).not.toHaveBeenCalled()
})
it('retains ordinary local typing/echo, IME debounce and reset authority', () => {
  const commit = vi.fn()
  const view = render(<LocalFirstTextarea aria-label="正文" value="原文" resetKey="a" onCommit={commit} />)
  const node = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.compositionStart(node)
  fireEvent.change(node, { target: { value: '中文输入' } })
  act(() => vi.advanceTimersByTime(300))
  expect(commit).not.toHaveBeenCalled()
  fireEvent.compositionEnd(node)
  act(() => vi.advanceTimersByTime(40))
  expect(commit).toHaveBeenLastCalledWith('中文输入')
  fireEvent.change(node, { target: { value: '中文输入继续' } })
  view.rerender(<LocalFirstTextarea aria-label="正文" value="中文输入" resetKey="a" onCommit={commit} />)
  expect(node.value).toBe('中文输入继续')
  view.rerender(<LocalFirstTextarea aria-label="正文" value="另一章" resetKey="b" onCommit={commit} />)
  expect(node.value).toBe('另一章')
  act(() => vi.advanceTimersByTime(300))
  expect(commit).toHaveBeenCalledTimes(1)
})
it('flushes pending author input before the streaming lock without committing preview text', () => {
  const commit = vi.fn()
  const view = render(<LocalFirstTextarea aria-label="正文" value="原文" resetKey="a" onCommit={commit} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '作者尚未防抖提交的修改' } })
  view.rerender(<LocalFirstTextarea aria-label="正文" value="流式预览" readOnly resetKey="a" onCommit={commit} />)
  expect(commit).toHaveBeenCalledExactlyOnceWith('作者尚未防抖提交的修改')
  view.rerender(<LocalFirstTextarea aria-label="正文" value="作者尚未防抖提交的修改" resetKey="a" onCommit={commit} />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('作者尚未防抖提交的修改')
  view.unmount()
  expect(commit).toHaveBeenCalledTimes(1)
})
it('keeps Work viewer IME input across lock and failed-write unlock without committing streamed text', () => {
  const change = vi.fn()
  const draft = { id: 'a', title: '章', summary: '', content: '原文', orderIndex: 1, revision: 1, localOnly: false, status: 'draft' as const, visibility: 'private' as const }
  const props = { draft, positionScope: 'task-a', selection: { start: 0, end: 0, text: '' }, onChange: change, onSelectionChange: vi.fn(), onAddSelection: vi.fn(), onClose: vi.fn(), onBlur: vi.fn() }
  const view = render(<StudioChapterViewer {...props} />)
  const node = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.compositionStart(node)
  fireEvent.change(node, { target: { value: '中文候选尚未完成' } })
  view.rerender(<StudioChapterViewer {...props} streamingContent="Agent只读预览" writeLocked />)
  expect(node.value).toBe('Agent只读预览')
  expect(change).not.toHaveBeenCalled()
  view.rerender(<StudioChapterViewer {...props} />)
  expect(node.value).toBe('中文候选尚未完成')
  fireEvent.compositionEnd(node)
  act(() => vi.advanceTimersByTime(40))
  expect(change).toHaveBeenCalledExactlyOnceWith({ ...draft, content: '中文候选尚未完成' })
})
it('commits the author candidate if IME ends under the lock and fences callbacks across a task/document reset', () => {
  const author = vi.fn(), locked = vi.fn(), other = vi.fn()
  const view = render(<LocalFirstTextarea aria-label="正文" value="原文" resetKey="task-a:chapter" onCommit={author} />)
  const node = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.compositionStart(node)
  fireEvent.change(node, { target: { value: '作者候选' } })
  view.rerender(<LocalFirstTextarea aria-label="正文" value="预览" readOnly resetKey="task-a:chapter" onCommit={locked} />)
  fireEvent.compositionEnd(node)
  act(() => vi.advanceTimersByTime(40))
  expect(author).toHaveBeenCalledExactlyOnceWith('作者候选')
  expect(locked).not.toHaveBeenCalled()
  view.rerender(<LocalFirstTextarea aria-label="正文" value="作者候选" resetKey="task-a:chapter" onCommit={author} />)
  fireEvent.change(node, { target: { value: '旧任务未提交输入' } })
  view.rerender(<LocalFirstTextarea aria-label="正文" value="新任务预览" readOnly resetKey="task-b:chapter" onCommit={other} />)
  act(() => vi.advanceTimersByTime(200))
  expect(author).toHaveBeenCalledTimes(1)
  expect(other).not.toHaveBeenCalled()
  expect(node.value).toBe('新任务预览')
})
