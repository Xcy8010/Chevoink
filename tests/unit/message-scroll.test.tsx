// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMessageScroll } from '../../src/features/studio/agent/components/use-message-scroll'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture() {
  const hook = renderHook(({ loading }) => useMessageScroll({ messages: [], pendingApproval: null, pendingQuestion: null, conversationLoading: loading, collapsed: false }), { initialProps: { loading: true } })
  const node = document.createElement('div')
  Object.defineProperties(node, { clientHeight: { value: 200, configurable: true }, scrollHeight: { value: 1000 } })
  hook.result.current.scrollRef.current = node
  return { ...hook, node }
}

it('releases following on upward navigation and restores only near the bottom', () => {
  const { result, node } = fixture()
  result.current.lastScrollTopRef.current = 800
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
  node.scrollTop = 123
  act(() => oldFrame(0))
  expect(node.scrollTop).toBe(123)
})
