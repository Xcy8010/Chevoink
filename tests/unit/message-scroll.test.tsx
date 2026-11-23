// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMessageScroll } from '../../src/features/studio/agent/components/use-message-scroll'
import type { AgentUIMessage } from '../../shared/contracts/index'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture() {
  const hook = renderHook(({ loading }) => useMessageScroll({ messages: [], pendingApproval: null, pendingQuestion: null, conversationLoading: loading, collapsed: false }), { initialProps: { loading: true } })
  const node = document.createElement('div')
  Object.defineProperties(node, { clientHeight: { value: 200, configurable: true }, scrollHeight: { value: 1000 } })
  hook.result.current.scrollRef.current = node
  return { ...hook, node }
}

function touch(type: string, clientY: number) {
  const event = new Event(type)
  Object.defineProperty(event, 'touches', { value: [{ clientY }] })
  return event
}

it('releases following on upward navigation and restores only near the bottom', () => {
  const { result, node, rerender } = fixture()
  rerender({ loading: false })
  result.current.lastScrollTopRef.current = 800
  node.scrollTop = 800
  node.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
  node.scrollTop = 780
  act(() => result.current.handleMessagesScroll())
  expect(result.current.pinnedToBottomRef.current).toBe(false)
  node.scrollTop = 800
  act(() => result.current.handleMessagesScroll())
  expect(result.current.pinnedToBottomRef.current).toBe(true)
})

it('does not mistake a bottom clamp for upward user navigation', () => {
  const { result, node } = fixture()
  result.current.lastScrollTopRef.current = 1200
  node.scrollTop = 800
  act(() => result.current.handleMessagesScroll())
  expect(result.current.pinnedToBottomRef.current).toBe(true)
})

it('keeps send following when layout moves the viewport upward before the next frame', () => {
  let frame!: FrameRequestCallback
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(next => { frame = next; return 1 })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const { result, node, rerender } = fixture()
  result.current.lastScrollTopRef.current = 1200
  node.scrollTop = 600
  rerender({ loading: false })
  // Appending a prompt changes content-visibility and can shrink earlier rows.
  // Browser anchoring moves upward while the appended prompt is still below.
  act(() => result.current.handleMessagesScroll())
  expect(result.current.pinnedToBottomRef.current).toBe(true)
  act(() => frame(0))
  expect(node.scrollTop).toBe(1000)
})

it.each(['wheel', 'touchmove', 'keydown', 'pointerdown'])('preserves intentional scrollback from %s while a follow frame is queued', input => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(next => { frames.push(next); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const { result, node, rerender } = fixture()
  rerender({ loading: false })
  const followFrame = frames.at(-1)!
  result.current.lastScrollTopRef.current = 800
  node.scrollTop = 800
  if (input === 'touchmove') node.dispatchEvent(touch('touchstart', 10))
  node.dispatchEvent(input === 'keydown' ? new KeyboardEvent(input, { key: 'PageUp' })
    : input === 'wheel' ? new WheelEvent(input, { deltaY: -20 })
      : input === 'touchmove' ? touch(input, 30) : new Event(input))
  // Native smooth keyboard/touch scrolling may not deliver its first scroll
  // until after an already queued follow frame. Input must stop that frame.
  if (input !== 'pointerdown') {
    act(() => followFrame(0))
    expect(node.scrollTop).toBe(800)
    expect(result.current.pinnedToBottomRef.current).toBe(false)
  }
  node.scrollTop = 780
  act(() => result.current.handleMessagesScroll())
  expect(result.current.pinnedToBottomRef.current).toBe(false)
  act(() => followFrame(0))
  expect(node.scrollTop).toBe(780)
})

it('leaves nested scrolling, editable keys and downward input with their owners', () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(next => { frames.push(next); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const { result, node, rerender } = fixture()
  rerender({ loading: false })
  node.scrollTop = 800
  const inner = document.createElement('div')
  inner.style.overflowY = 'auto'
  Object.defineProperties(inner, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } })
  inner.scrollTop = 100
  const input = document.createElement('textarea')
  node.append(inner, input)
  inner.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }))
  inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  node.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }))
  node.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
  expect(result.current.pinnedToBottomRef.current).toBe(true)
  // None of those inputs should label a later layout correction as scrollback.
  node.dispatchEvent(new Event('pointerdown'))
  window.dispatchEvent(new Event('pointerup'))
  result.current.lastScrollTopRef.current = 800
  node.scrollTop = 600
  act(() => result.current.handleMessagesScroll())
  expect(result.current.pinnedToBottomRef.current).toBe(true)
})

it('keeps canonical request replacement and queued-message updates from overriding scrollback', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const row = (id: string, runId = 'new'): AgentUIMessage => ({ id, runId, role: 'user', createdAt: '', parts: [{ type: 'text', text: '请求' }] })
  const { result, rerender } = renderHook(({ messages, loading }) => useMessageScroll({ scopeKey: 'task-a', messages, conversationLoading: loading, pendingApproval: null, pendingQuestion: null, collapsed: false }), { initialProps: { messages: [row('previous', 'old')], loading: true } })
  const node = document.createElement('div')
  Object.defineProperties(node, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } })
  result.current.scrollRef.current = node
  rerender({ messages: [row('previous', 'old'), row('optimistic')], loading: false })
  result.current.lastScrollTopRef.current = 800
  node.scrollTop = 800
  node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
  node.scrollTop = 500
  act(() => result.current.handleMessagesScroll())
  rerender({ messages: [row('previous', 'old'), row('canonical'), row('queued', 'queued')], loading: false })
  expect(result.current.pinnedToBottomRef.current).toBe(false)
  expect(node.scrollTop).toBe(500)
})

it('keeps the observer on the same visible message when remote history changes earlier row heights', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const { result, node, rerender } = fixture()
  rerender({ loading: false })
  node.scrollTop = 500
  node.dispatchEvent(touch('touchstart', 15))
  node.dispatchEvent(touch('touchmove', 50))
  const earlier = node.appendChild(document.createElement('div'))
  const reading = node.appendChild(document.createElement('div'))
  earlier.id = 'agent-message-earlier'
  reading.id = 'agent-message-reading'
  let start = 488
  const rect = (top: number, bottom: number) => ({ top, bottom } as DOMRect)
  vi.spyOn(earlier, 'getBoundingClientRect').mockImplementation(() => rect(-500, start - node.scrollTop))
  vi.spyOn(reading, 'getBoundingClientRect').mockImplementation(() => rect(start - node.scrollTop, start + 250 - node.scrollTop))
  act(() => result.current.captureRemoteViewport())
  start -= 140
  rerender({ loading: false })
  expect(reading.getBoundingClientRect().top).toBe(-12)
  expect(result.current.lastScrollTopRef.current).toBe(360)
  expect(result.current.pinnedToBottomRef.current).toBe(false)
})

it('positions the observer at the new tail before the first follow frame when already following', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const { result, node, rerender } = fixture()
  rerender({ loading: false })
  node.scrollTop = 800
  act(() => result.current.captureRemoteViewport())
  node.scrollTop = 290 // browser clamp during snapshot replacement
  rerender({ loading: false })
  expect(node.scrollTop).toBe(1000)
  expect(result.current.pinnedToBottomRef.current).toBe(true)
})

it('follows changing layout only while pinned and cancels queued frames on unmount', () => {
  let frame!: FrameRequestCallback
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => { frame = next; return 42 })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const { result, node, rerender, unmount } = fixture()
  rerender({ loading: false })
  act(() => frame(0))
  expect(node.scrollTop).toBe(1000)
  result.current.pinnedToBottomRef.current = false
  node.scrollTop = 400
  act(() => frame(1))
  expect(node.scrollTop).toBe(400)
  unmount()
  expect(cancel).toHaveBeenCalledWith(42)
})

it.each([false, true])('follows delayed layout after history hydration only while pinned (revealing text: %s)', revealingText => {
  let resize!: () => void
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe = observe
    disconnect = disconnect
  })
  const messages: AgentUIMessage[] = []
  const { result, rerender, unmount } = renderHook(({ loading }) => useMessageScroll({
    messages, revealingText, conversationLoading: loading, pendingApproval: null, pendingQuestion: null, collapsed: false,
  }), { initialProps: { loading: true } })
  const node = document.createElement('div')
  const content = node.appendChild(document.createElement('div'))
  let height = 1000
  Object.defineProperties(node, { clientHeight: { value: 200 }, scrollHeight: { get: () => height } })
  node.scrollTop = 800
  result.current.scrollRef.current = node
  result.current.scrollContentRef.current = content
  rerender({ loading: false })
  expect(observe).toHaveBeenCalledWith(content)
  expect(observe).toHaveBeenCalledWith(node)

  height = 1250
  act(() => resize())
  expect(node.scrollTop).toBe(1250)
  expect(result.current.lastScrollTopRef.current).toBe(1250)

  result.current.pinnedToBottomRef.current = false
  node.scrollTop = 700
  height = 1500
  act(() => resize())
  expect(node.scrollTop).toBe(700)
  unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('ignores hidden panels and removes navigation listeners on unmount', () => {
  const { result, node, unmount } = fixture()
  const query = vi.spyOn(node, 'querySelector')
  Object.defineProperty(node, 'clientHeight', { value: 0 })
  act(() => window.dispatchEvent(new CustomEvent('chevoink:agent-conversation-navigate', { detail: { messageId: 'one' } })))
  expect(query).not.toHaveBeenCalled()
  expect(result.current.pinnedToBottomRef.current).toBe(true)
  unmount()
  Object.defineProperty(node, 'clientHeight', { value: 200 })
  window.dispatchEvent(new CustomEvent('chevoink:agent-conversation-navigate', { detail: { messageId: 'one' } }))
  expect(query).not.toHaveBeenCalled()
})


it('fences an already queued scroll frame after a task scope changes', () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(next => { frames.push(next); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const { result, rerender } = renderHook(({ scope }) => useMessageScroll({ scopeKey: scope, messages: [], pendingApproval: null, pendingQuestion: null, conversationLoading: false, collapsed: false }), { initialProps: { scope: 'a' } })
  const node = document.createElement('div')
  Object.defineProperties(node, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } })
  result.current.scrollRef.current = node
  rerender({ scope: 'a' })
  const oldFrame = frames.at(-1)!
  rerender({ scope: 'b' })
  rerender({ scope: 'a' })
  node.scrollTop = 123
  act(() => oldFrame(0))
  expect(node.scrollTop).toBe(123)
})
