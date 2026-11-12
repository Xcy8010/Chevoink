// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentQuestionCard } from '../../src/features/studio/agent/components/AgentQuestionCard'
import type { AgentQuestionDecision } from '../../shared/contracts/agent-events.js'

const question = {
  callId: 'question-1', requestId: 'request-1', question: '先从哪条路线开始？',
  options: [
    { label: '夜市', detail: '先写一场意外的相遇' },
    { label: '码头', detail: '从返乡的船开始' },
  ],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('moves through a single native radio group and requires explicit confirmation before submitting', async () => {
  // jsdom does not implement the browser CSS.escape used by user-event's radio navigation.
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') })
  let accept!: (value: boolean) => void
  const onAnswer = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve }))
  const user = userEvent.setup()
  render(<AgentQuestionCard question={question} onAnswer={onAnswer} />)
  const nightMarket = screen.getByRole('radio', { name: '夜市' }) as HTMLInputElement
  const port = screen.getByRole('radio', { name: '码头' }) as HTMLInputElement
  const submit = screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  expect(submit.querySelector('svg.lucide-corner-down-left')).toBeTruthy()
  await user.tab()
  expect(document.activeElement).toBe(nightMarket)
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(port)
  expect(port.checked).toBe(true)
  expect(nightMarket.checked).toBe(false)
  expect(submit.disabled).toBe(false)
  expect(onAnswer).not.toHaveBeenCalled()

  await user.keyboard('{Enter}')
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ answer: '码头（从返乡的船开始）' })
  const submitting = screen.getByRole('button', { name: '提交中…' }) as HTMLButtonElement
  expect(submitting.disabled).toBe(true)
  expect(submitting.querySelector('svg.lucide-corner-down-left')).toBeTruthy()
  fireEvent.click(submitting)
  await act(async () => { accept(true) })
  expect((screen.getByRole('button', { name: '已提交' }) as HTMLButtonElement).disabled).toBe(true)
  expect(onAnswer).toHaveBeenCalledOnce()
})

it('preserves a free-text answer for retry and ignores Enter during IME composition', async () => {
  const onAnswer = vi.fn<(decision: AgentQuestionDecision) => Promise<boolean>>()
    .mockRejectedValueOnce(new Error('网络中断，请重试。')).mockResolvedValueOnce(true)
  const user = userEvent.setup()
  render(<AgentQuestionCard question={question} onAnswer={onAnswer} />)
  const input = screen.getByRole('textbox', { name: '自定义回答' }) as HTMLInputElement
  const customOption = screen.getByRole('radio', { name: '自定义回答' }) as HTMLInputElement
  expect(input.placeholder).toBe('输入自定义回答（如果你有其它想法...）')
  expect(customOption.checked).toBe(false)
  await user.click(input)
  expect(document.activeElement).toBe(input)
  expect(customOption.checked).toBe(true)
  screen.getByRole('button', { name: '取消' }).focus()
  await user.click(screen.getByRole('radio', { name: '自定义回答' }).closest('label')!)
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: '  从山里开始  ' } })
  await user.click(screen.getByText('夜市'))
  expect(customOption.checked).toBe(false)
  expect(input.value).toBe('  从山里开始  ')
  await user.click(input)
  expect(customOption.checked).toBe(true)
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(onAnswer).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect((await screen.findByRole('alert')).textContent).toBe('网络中断，请重试。')
  expect(input.value).toBe('  从山里开始  ')
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect(await screen.findByRole('button', { name: '已提交' })).toBeTruthy()
  expect(onAnswer.mock.calls).toEqual([[{ answer: '从山里开始' }], [{ answer: '从山里开始' }]])
})

it('opens option information outside the form without choosing an answer', async () => {
  const onAnswer = vi.fn(async () => true)
  const user = userEvent.setup()
  render(<AgentQuestionCard question={question} onAnswer={onAnswer} />)
  const toggle = screen.getByRole('button', { name: '查看「夜市」说明' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('tooltip')).toBeNull()
  await user.click(toggle)
  const detail = screen.getByRole('tooltip')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(detail.id).toBe(toggle.getAttribute('aria-controls'))
  expect(detail.textContent).toBe('先写一场意外的相遇')
  expect(screen.getByRole('form').contains(detail)).toBe(false)
  expect((screen.getByRole('radio', { name: '夜市' }) as HTMLInputElement).checked).toBe(false)
  await user.click(toggle)
  expect(screen.queryByRole('tooltip')).toBeNull()

  await user.click(screen.getByRole('radio', { name: '夜市' }))
  toggle.focus()
  await user.keyboard('{Enter}')
  const focusedTooltip = screen.getByRole('tooltip')
  act(() => { focusedTooltip.focus() })
  fireEvent.keyDown(focusedTooltip, { key: 'Enter' })
  expect(onAnswer).not.toHaveBeenCalled()
  fireEvent.keyDown(focusedTooltip, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(document.activeElement).toBe(toggle)
  await user.click(toggle)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('tooltip')).toBeNull()

  await user.click(toggle)
  fireEvent.keyDown(toggle, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(onAnswer).not.toHaveBeenCalled()
})

it('keeps each answer through navigation and retry and submits the ordered batch once', async () => {
  const onAnswer = vi.fn<(decision: AgentQuestionDecision) => Promise<boolean>>()
    .mockRejectedValueOnce(new Error('稍后重试')).mockResolvedValueOnce(true)
  const user = userEvent.setup()
  render(<AgentQuestionCard question={{ ...question, questions: [
    { question: '第一题', options: [{ label: '地图' }] },
    { question: '第二题', options: [{ label: '散文' }] },
    { question: '第三题', options: [{ label: '清晨' }] },
  ] }} onAnswer={onAnswer} />)
  expect(screen.getByText('1 / 3')).toBeTruthy()
  const headerBack = screen.getByRole('button', { name: '上一题' }) as HTMLButtonElement
  const headerNext = screen.getByRole('button', { name: '下一题' }) as HTMLButtonElement
  const footerBack = screen.getByRole('button', { name: '返回' }) as HTMLButtonElement
  expect(headerBack.disabled).toBe(true)
  expect(headerNext.disabled).toBe(true)
  expect(footerBack.disabled).toBe(true)
  await user.click(screen.getByRole('radio', { name: '地图' }))
  expect(headerNext.disabled).toBe(false)
  fireEvent.keyDown(screen.getByRole('radio', { name: '地图' }), { key: 'Enter' })
  expect(screen.getByText('2 / 3')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '第二题' }))
  expect(headerNext.disabled).toBe(true)
  expect(headerBack.disabled).toBe(false)
  expect(footerBack.disabled).toBe(false)
  await user.click(screen.getByRole('radio', { name: '自定义回答' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  自定义草稿  ' } })
  await user.click(headerNext)
  expect(screen.getByText('3 / 3')).toBeTruthy()
  expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
  await user.click(headerBack)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('  自定义草稿  ')
  await user.click(screen.getByRole('button', { name: '返回' }))
  expect((screen.getByRole('radio', { name: '地图' }) as HTMLInputElement).checked).toBe(true)
  await user.click(screen.getByRole('button', { name: '继续' }))
  await user.click(screen.getByRole('button', { name: '继续' }))
  await user.click(screen.getByRole('radio', { name: '清晨' }))
  expect(headerNext.disabled).toBe(true)
  fireEvent.click(headerNext)
  expect(onAnswer).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect((await screen.findByRole('alert')).textContent).toBe('稍后重试')
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect(await screen.findByRole('button', { name: '已提交' })).toBeTruthy()
  expect(onAnswer.mock.calls).toEqual([
    [{ answers: ['地图', '自定义草稿', '清晨'] }],
    [{ answers: ['地图', '自定义草稿', '清晨'] }],
  ])
})

it('sends a one-question batch as an array and only cancels Escape pressed inside the form', async () => {
  const onAnswer = vi.fn<(decision: AgentQuestionDecision) => Promise<boolean>>().mockResolvedValue(true)
  const user = userEvent.setup()
  const view = render(<AgentQuestionCard question={{ ...question, questions: [{ question: '批次仅有一题', options: [{ label: '方案甲' }] }] }}
    onAnswer={onAnswer} />)
  await user.click(screen.getByRole('radio', { name: '方案甲' }))
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ answers: ['方案甲'] })

  onAnswer.mockClear()
  view.rerender(<AgentQuestionCard question={{ ...question, requestId: 'another-request' }} onAnswer={onAnswer} />)
  await user.click(screen.getByRole('radio', { name: '自定义回答' }))
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '取消时不能发送的草稿' } })
  fireEvent.keyDown(document.body, { key: 'Escape' })
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true, keyCode: 229 })
  expect(onAnswer).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(await screen.findByRole('button', { name: '已取消' })).toBeTruthy()
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ cancelled: true })
})

it('resets selection and text when a different question arrives', async () => {
  const onAnswer = vi.fn(async () => true)
  const user = userEvent.setup()
  const view = render(<AgentQuestionCard question={question} onAnswer={onAnswer} />)
  await user.click(screen.getByRole('radio', { name: '自定义回答' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '上一个问题的草稿' } })
  view.rerender(<AgentQuestionCard question={{ ...question, requestId: 'request-2', question: '决定作品的标题？' }} onAnswer={onAnswer} />)
  expect(screen.getByRole('heading', { name: '决定作品的标题？' })).toBeTruthy()
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
  expect((screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement).disabled).toBe(true)
  expect(onAnswer).not.toHaveBeenCalled()
})

it('shows two cover choices and custom, with zoom and selection operating independently', async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') })
  const user = userEvent.setup()
  const onAnswer = vi.fn(async () => true)
  const covers = {
    ...question,
    question: '采用哪张封面？',
    options: [
      { label: '封面 A', detail: '冷色调', coverAssetId: 'asset-a' },
      { label: '封面 B', detail: '暖色调', coverAssetId: 'asset-b' },
    ],
  }
  render(<AgentQuestionCard question={covers} onAnswer={onAnswer}
    coverImages={new Map([['asset-a', '/fixtures/cover-a.png'], ['asset-b', '/fixtures/cover-b.png']])} />)
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  expect(screen.getByRole('radio', { name: '自定义回答' })).toBeTruthy()
  expect(screen.getByPlaceholderText('输入自定义回答（如果你有其它想法...）')).toBeTruthy()
  const first = screen.getByRole('radio', { name: '封面 A' }) as HTMLInputElement
  const second = screen.getByRole('radio', { name: '封面 B' }) as HTMLInputElement
  const zoom = screen.getByRole('button', { name: '放大查看封面「封面 A」' })
  await user.click(zoom)
  expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy()
  const close = screen.getByRole('button', { name: '关闭图片预览' })
  expect(document.activeElement).toBe(close)
  await user.tab()
  expect(document.activeElement).toBe(close)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(zoom)
  expect(first.checked).toBe(false)
  expect(onAnswer).not.toHaveBeenCalled()

  const thumbnail = first.closest('label')!.querySelector('img')!
  expect(thumbnail.getAttribute('src')).toBe('/fixtures/cover-a.png')
  await user.click(thumbnail)
  expect(first.checked).toBe(true)
  await user.click(screen.getByText('封面 B'))
  expect(second.checked).toBe(true)
  expect(first.checked).toBe(false)
  second.focus()
  await user.keyboard('{ArrowUp}')
  expect(first.checked).toBe(true)
  await user.keyboard('{Enter}')
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ answer: '封面 A（冷色调）' })
})

it('leaves unresolved cover IDs as text choices in their original order', async () => {
  const user = userEvent.setup()
  const onAnswer = vi.fn(async () => true)
  const covers = {
    ...question,
    options: [
      { label: '先用文字选项' },
      { label: '封面已找不到', coverAssetId: 'missing' },
      { label: '封面还在', coverAssetId: 'available' },
    ],
  }
  render(<AgentQuestionCard question={covers} onAnswer={onAnswer} coverImages={new Map([['available', '/fixtures/cover.png']])} />)
  expect(screen.getAllByRole('radio').map(input => document.getElementById(input.getAttribute('aria-labelledby')!)?.textContent))
    .toEqual(['先用文字选项', '封面已找不到', '封面还在', '自定义回答'])
  expect(screen.queryByRole('button', { name: '放大查看封面「封面已找不到」' })).toBeNull()
  expect(screen.getByRole('button', { name: '放大查看封面「封面还在」' })).toBeTruthy()
  await user.click(screen.getByText('封面已找不到'))
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ answer: '封面已找不到' })
})
