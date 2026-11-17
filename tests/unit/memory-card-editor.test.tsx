// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MemoryCardEditor, { MemoryCardDeleteDialog } from '../../src/features/studio/agent/components/MemoryCardEditor'
import { updateStoryMemory, deleteStoryMemory } from '../../src/features/studio/agent/agentApi'
import type { StoryMemoryCard } from '../../shared/contracts'

vi.mock('../../src/features/studio/agent/agentApi', () => ({ updateStoryMemory: vi.fn(), deleteStoryMemory: vi.fn() }))
vi.mock('../../src/store/useShellStore', () => ({ useShellStore: (select: (s: unknown) => unknown) => select({ sessionUser: { id: 'u' } }) }))
const card: StoryMemoryCard = { id: 'c', title: '林舟', content: '原设定', memoryType: 'characterCard', layer: 'L1', importance: 80, status: 'confirmed', version: 1, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})
function setup(value = card, novelId = 'n') {
  const onClose = vi.fn(), onSaved = vi.fn()
  const view = render(<MemoryCardEditor card={value} novelId={novelId} onClose={onClose} onSaved={onSaved} />)
  return { ...view, onClose, onSaved }
}
it('backdrop/scroll does not dismiss edits; Escape shows unsaved choice, keeps draft on reopen', () => {
  const view = setup()
  fireEvent.change(screen.getByLabelText('内容'), { target: { value: '未保存草稿' } })
  fireEvent.click(screen.getByRole('dialog')); fireEvent.scroll(screen.getByRole('dialog'))
  expect(view.onClose).not.toHaveBeenCalled()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(screen.getByRole('region', { name: '未保存修改' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(view.onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并关闭' }))
  expect(view.onClose).toHaveBeenCalledOnce()
  view.unmount(); setup()
  expect((screen.getByLabelText('内容') as HTMLTextAreaElement).value).toBe('未保存草稿')
})
it('drafts are scoped per work/card, preserve revision conflicts, and require explicit discard', () => {
  const a = setup()
  fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'A草稿' } }); a.unmount()
  const b = setup({ ...card, id: 'b' }, 'other')
  expect((screen.getByLabelText('内容') as HTMLTextAreaElement).value).toBe('原设定'); b.unmount()
  setup({ ...card, version: 2, content: '服务端新版' })
  expect((screen.getByLabelText('内容') as HTMLTextAreaElement).value).toBe('A草稿')
  expect((screen.getByRole('button', { name: '保存修订' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '取消' })); fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(sessionStorage.length).toBe(0)
})
it('save errors retain draft and successful versioned save clears it', async () => {
  const view = setup()
  fireEvent.change(screen.getByLabelText('内容'), { target: { value: '修改' } })
  vi.mocked(updateStoryMemory).mockRejectedValueOnce(new Error('版本冲突'))
  fireEvent.click(screen.getByRole('button', { name: '保存修订' }))
  await screen.findByText('版本冲突')
  expect(sessionStorage.length).toBe(1)
  expect(view.onSaved).not.toHaveBeenCalled()
  vi.mocked(updateStoryMemory).mockResolvedValueOnce({ memory: { ...card, content: '修改', version: 2 } })
  fireEvent.click(screen.getByRole('button', { name: '保存修订' }))
  await waitFor(() => expect(view.onSaved).toHaveBeenCalledOnce())
  expect(updateStoryMemory).toHaveBeenLastCalledWith('c', expect.objectContaining({ expectedVersion: 1, content: '修改' }))
  expect(sessionStorage.length).toBe(0)
})
it('repositions the editor with the visual viewport without losing the edited field', () => {
  const viewport = Object.assign(new EventTarget(), { height: 780, offsetTop: 0 })
  vi.stubGlobal('visualViewport', viewport)
  const view = setup()
  const dialog = screen.getByRole('dialog')
  expect(dialog.style.getPropertyValue('--memory-viewport-height')).toBe('780px')
  const content = screen.getByLabelText('内容')
  content.focus()
  fireEvent.change(content, { target: { value: '键盘打开后的草稿' } })
  viewport.height = 315
  viewport.offsetTop = 70
  viewport.dispatchEvent(new Event('resize'))
  viewport.dispatchEvent(new Event('scroll'))
  expect(dialog.style.getPropertyValue('--memory-viewport-height')).toBe('315px')
  expect(dialog.style.getPropertyValue('--memory-viewport-top')).toBe('70px')
  expect(document.activeElement).toBe(content)
  expect((content as HTMLTextAreaElement).value).toBe('键盘打开后的草稿')
  expect(screen.getByRole('button', { name: '保存修订' }).closest('footer')).toBeTruthy()
  view.unmount()
  viewport.height = 340
  viewport.dispatchEvent(new Event('resize'))
  expect(dialog.style.getPropertyValue('--memory-viewport-height')).toBe('315px')
})
it('delete requires explicit confirmation, cannot be repeated or dismissed while pending, errors retain card', async () => {
  const onClose = vi.fn(), onDeleted = vi.fn()
  let reject!: (reason: Error) => void
  vi.mocked(deleteStoryMemory).mockReturnValue(new Promise((_, fail) => { reject = fail }))
  render(<MemoryCardDeleteDialog card={card} onClose={onClose} onDeleted={onDeleted} />)
  fireEvent.click(screen.getByRole('dialog'))
  expect(deleteStoryMemory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
  fireEvent.click(screen.getByRole('button', { name: '删除中…' }))
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(deleteStoryMemory).toHaveBeenCalledExactlyOnceWith('c', 1)
  expect(onClose).not.toHaveBeenCalled()
  reject(new Error('服务器不可用'))
  await screen.findByText('服务器不可用')
  expect(onDeleted).not.toHaveBeenCalled()
})
