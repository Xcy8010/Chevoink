// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PlanMarkdownEditor from '../../src/features/studio/components/PlanMarkdownEditor'

vi.mock('../../src/features/studio/components/PlanRichMarkdownEditor', () => ({ default: ({ markdown, onChange }: {markdown:string;onChange:(text:string)=>void}) => <button onClick={() => onChange(`${markdown} edited`)}>编辑计划</button> }))
afterEach(() => {cleanup();vi.useRealTimers()})

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
