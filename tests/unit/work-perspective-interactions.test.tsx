// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WorkPerspective from '../../src/features/studio/components/WorkPerspective'
import { useWorkConversation } from '../../src/features/studio/components/work-conversation-context'
import { openWorkDocument } from '../../src/features/studio/components/work-viewer-events'

function Conversation() {
  const { collapsed, expand } = useWorkConversation()
  const [draft, setDraft] = useState('原有草稿')
  return <div><span>{collapsed ? '浮动输入' : '完整会话'}</span><input aria-label="草稿" value={draft} onChange={e => setDraft(e.target.value)} /><button onClick={expand}>展开对话</button></div>
}
function props(scopeKey = 'task-a') {
  return { scopeKey, conversationRail: 'rail', conversation: <Conversation />, inspector: 'inspector', viewer: 'viewer', viewerIdentity: 'chapter-1', rightOpen: true, inspectorWidth: 400, viewerWidth: 600, onToggleRight: vi.fn(), inspectorTab: 'work' as const, onSelectInspectorTab: vi.fn(), activityDock: 'activity' }
}
beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId = 7 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { width: this.dataset.studioPanel ? Number.parseFloat(this.style.width) : 1600, height: 900, x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, toJSON: () => ({}) } })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => true })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete document.documentElement.dataset.studioResizing })
function move(root: Element, x: number) { fireEvent.pointerMove(root, { clientX: x }); act(() => vi.advanceTimersByTime(300)) }
it('preserves a folded viewer through delayed hydration, task revisit and remount, but opens for an explicit scoped selection', () => {
  const saved = { viewer: 600, inspector: 400, viewerCollapsed: true, inspectorCollapsed: false, chatCollapsed: false }
  localStorage.setItem('chevoink:work-split-v2:task-a', JSON.stringify(saved))
  const view = render(<WorkPerspective {...props()} viewer={undefined} viewerIdentity={null} />)
  view.rerender(<WorkPerspective {...props()} />)
  const folded = () => view.container.querySelector('[data-studio-panel="workViewer"]')?.getAttribute('aria-hidden')
  expect(folded()).toBe('true')
  view.rerender(<WorkPerspective {...props('task-b')} />)
  act(() => openWorkDocument('task-a'))
  view.rerender(<WorkPerspective {...props()} viewerIdentity="chapter-2" />)
  expect(folded()).toBe('true')
  expect(JSON.parse(localStorage.getItem('chevoink:work-split-v2:task-a')!).viewerCollapsed).toBe(true)
  act(() => openWorkDocument('task-a'))
  expect(folded()).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: '展开对话' }))
  view.unmount()
  const reopened = render(<WorkPerspective {...props()} viewer={undefined} viewerIdentity={null} />)
  reopened.rerender(<WorkPerspective {...props()} />)
  expect(reopened.container.querySelector('[data-studio-panel="workViewer"]')?.getAttribute('aria-hidden')).toBe('true')
})
it('restores A/B/A widths and explicit collapsed flags, including remount', () => {
  localStorage.setItem('chevoink:work-split-v2:task-a', JSON.stringify({ viewer: 260, inspector: 220, viewerCollapsed: true, inspectorCollapsed: true, chatCollapsed: false }))
  localStorage.setItem('chevoink:work-split-v2:task-b', JSON.stringify({ viewer: 380, inspector: 240, viewerCollapsed: false, inspectorCollapsed: false, chatCollapsed: false }))
  const view = render(<WorkPerspective {...props()} />)
  expect(screen.getByRole('button', { name: '展开检查区' })).toBeTruthy()
  view.rerender(<WorkPerspective {...props('task-b')} />)
  act(() => vi.advanceTimersByTime(400))
  expect(view.container.querySelector<HTMLElement>('[data-studio-panel="workViewer"]')?.style.width).toBe('380px')
  view.rerender(<WorkPerspective {...props()} />)
  expect(view.container.querySelector('[data-studio-panel="workViewer"]')?.getAttribute('aria-hidden')).toBe('true')
  expect(screen.getByRole('button', { name: '展开检查区' })).toBeTruthy()
  view.unmount()
  render(<WorkPerspective {...props()} />)
  expect(screen.getByRole('button', { name: '展开检查区' })).toBeTruthy()
})
it('retains pointer capture through pair fold and chat fold, preserving the exact input node', () => {
  const view = render(<WorkPerspective {...props()} />)
  const root = view.container.querySelector('[data-studio-layout]')!
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '不会丢失的附件旁草稿' } })
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整查看器与对话宽度' }), { button: 0, clientX: 600 })
  move(root, 1300)
  expect(root.getAttribute('data-activity-dock')).toBe('visible')
  expect(root.getAttribute('data-dragging')).toBe('true')
  move(root, 1270)
  expect(view.container.querySelector('[data-studio-panel="workViewer"]')?.getAttribute('aria-hidden')).toBe('false')
  move(root, 100)
  expect(screen.getByText('浮动输入')).toBeTruthy()
  expect(screen.getByRole('textbox')).toBe(input)
  fireEvent.pointerUp(root)
  fireEvent.click(screen.getByRole('button', { name: '展开对话' }))
  expect(screen.getByRole('textbox')).toBe(input)
  expect((input as HTMLInputElement).value).toBe('不会丢失的附件旁草稿')
  expect(view.container.querySelector('[data-studio-panel="workViewer"]')?.getAttribute('aria-hidden')).toBe('true')
  expect(root.getAttribute('data-chat-collapsed')).toBe('false')
  expect(document.documentElement.dataset.studioResizing).toBeUndefined()
})
it('resets folded conversation on task change and releases a pending gesture on blur', () => {
  const view = render(<WorkPerspective {...props()} />)
  const root = view.container.querySelector('[data-studio-layout]')!
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整查看器与对话宽度' }), { key: 'Home' })
  expect(root.getAttribute('data-chat-collapsed')).toBe('true')
  view.rerender(<WorkPerspective {...props('task-b')} />)
  expect(root.getAttribute('data-chat-collapsed')).toBe('false')
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整查看器与对话宽度' }), { button: 0, clientX: 600 })
  fireEvent(window, new Event('blur'))
  expect(root.getAttribute('data-dragging')).toBe('false')
  expect(document.documentElement.dataset.studioResizing).toBeUndefined()
})
it.each(['viewer', 'inspector', 'both'] as const)('restores the same conversation when %s closes while chat is folded', pane => {
  const view = render(<WorkPerspective {...props()} />)
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整查看器与对话宽度' }), { key: 'Home' })
  expect(screen.getByText('浮动输入')).toBeTruthy()
  if (pane === 'inspector') fireEvent.click(screen.getByRole('button', { name: '收起检查区' }))
  else view.rerender(<WorkPerspective {...props()} viewer={undefined} viewerIdentity={null} rightOpen={pane !== 'both'} />)
  expect(screen.getByText('完整会话')).toBeTruthy()
  expect(screen.getByRole('textbox')).toBe(input)
})
it('reverses within the same pointer capture after reaching the right edge, and allows a fresh folded-edge drag', () => {
  const view = render(<WorkPerspective {...props()} />)
  const root = view.container.querySelector('[data-studio-layout]')!
  const viewer = view.container.querySelector('[data-studio-panel="workViewer"]')!
  const handle = screen.getByRole('separator', { name: '调整查看器与对话宽度' })
  fireEvent.pointerDown(handle, { button: 0, clientX: 600 })
  move(root, 1400)
  move(root, 1599)
  expect(viewer.getAttribute('aria-hidden')).toBe('true')
  move(root, 1569)
  expect(viewer.getAttribute('aria-hidden')).toBe('false')
  expect(root.getAttribute('data-dragging')).toBe('true')
  move(root, 1599)
  move(root, 1750)
  fireEvent.pointerUp(root)
  expect(viewer.getAttribute('aria-hidden')).toBe('true')
  fireEvent.pointerDown(handle, { button: 0, clientX: 1554 })
  move(root, 1524)
  expect(viewer.getAttribute('aria-hidden')).toBe('false')
  fireEvent.pointerCancel(root)
  expect(root.getAttribute('data-dragging')).toBe('false')
})
