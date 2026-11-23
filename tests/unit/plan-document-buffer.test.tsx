// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PlanMarkdownEditor from '../../src/features/studio/components/PlanMarkdownEditor'

vi.mock('../../src/features/studio/components/PlanRichMarkdownEditor', () => ({ default: ({ markdown, onChange }: {markdown:string;onChange:(text:string)=>void}) => <button onClick={() => onChange(`${markdown} edited`)}>编辑计划</button> }))
afterEach(() => {cleanup();vi.useRealTimers()})

it('paints an outline with editor block geometry and keeps authored inline whitespace', () => {
  const markdown = [
    '# 大纲', '', '> 第一段', '', '- *甲*', '  *乙*', '  - 子项', '',
    '    缩进代码', '', '| 表头 |', '| --- |', '| 正文 |',
  ].join('\n')
  const { container } = render(<PlanMarkdownEditor documentId="outline" markdown={markdown} />)
  const reading = container.querySelector('[data-plan-reading-preview] .ProseMirror')!
  expect([...reading.childNodes].every(node => node.nodeType === Node.ELEMENT_NODE)).toBe(true)
  expect(reading.querySelector('blockquote')?.firstChild?.nodeName).toBe('P')
  expect(reading.querySelector('li > p')?.textContent).toBe('甲\n乙')
  expect(reading.querySelector('li > ul > li > p')?.textContent).toBe('子项')
  expect(reading.querySelector('td > p')?.textContent).toBe('正文')
  expect(reading.lastElementChild?.outerHTML).toBe('<p><br></p>')
})

it('flushes a switched document buffer to its own callback, never the newly selected plan', async () => {
  const first = vi.fn(), second = vi.fn()
  const view = render(<PlanMarkdownEditor documentId="book-a-plan" markdown="A" onChange={first} />)
  await screen.findByText('编辑计划')
  vi.useFakeTimers()
  fireEvent.click(screen.getByText('编辑计划'))
  view.rerender(<PlanMarkdownEditor documentId="book-b-plan" markdown="B" onChange={second} />)
  await act(async () => {vi.advanceTimersByTime(500)})
  expect(first).toHaveBeenCalledExactlyOnceWith('A edited')
  expect(second).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('编辑计划'))
  await act(async () => {vi.advanceTimersByTime(500)})
  expect(second).toHaveBeenCalledExactlyOnceWith('B edited')
})


it('keeps a buffered same-document edit bound to the version callback observed before a remote refresh', async () => {
  const v1 = vi.fn(), v2 = vi.fn()
  const view = render(<PlanMarkdownEditor documentId="same-plan" markdown="v1" onChange={v1} />)
  await screen.findByText('编辑计划')
  vi.useFakeTimers()
  fireEvent.click(screen.getByText('编辑计划'))
  view.rerender(<PlanMarkdownEditor documentId="same-plan" markdown="v2 remote" onChange={v2} />)
  await act(async () => { vi.advanceTimersByTime(500) })
  expect(v1).toHaveBeenCalledExactlyOnceWith('v1 edited')
  expect(v2).not.toHaveBeenCalled()
})
