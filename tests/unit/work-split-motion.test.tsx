// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkSplitMotion, type WorkPaneSizes } from '../../src/features/studio/components/use-work-split-motion'

const open: WorkPaneSizes = { rail: 44, chat: 556, viewer: 600, inspector: 400, dock: 0 }
const folded: WorkPaneSizes = { rail: 44, chat: 1214, viewer: 0, inspector: 46, dock: 296 }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('updates ordinary resizing immediately, without a width transition', () => {
  const hook = renderHook(({ target, phase }) => useWorkSplitMotion(target, phase), { initialProps: { target: open, phase: 'open' } })
  hook.rerender({ target: { ...open, viewer: 580 }, phase: 'open' })
  expect(hook.result.current.viewer).toBe(580)
})
it('finishes on the original deadline despite changing pointer targets every frame', () => {
  const hook = renderHook(({ target, phase }) => useWorkSplitMotion(target, phase), { initialProps: { target: folded, phase: 'folded' } })
  hook.rerender({ target: open, phase: 'open' })
  expect(hook.result.current.viewer).toBe(0)
  for (let index = 0; index < 14; index++) {
    hook.rerender({ target: { ...open, viewer: 220 + index * 4 }, phase: 'open' })
    act(() => vi.advanceTimersByTime(16))
  }
  expect(hook.result.current.viewer).toBe(272)
  expect(vi.getTimerCount()).toBe(0)
})
it('uses the original damped curve and completes within the old 220ms transition', () => {
  const hook = renderHook(({ target, phase }) => useWorkSplitMotion(target, phase), { initialProps: { target: folded, phase: 'folded' } })
  hook.rerender({ target: open, phase: 'open' })
  act(() => vi.advanceTimersByTime(32))
  expect(hook.result.current.viewer).toBeGreaterThan(300)
  expect(hook.result.current.viewer).toBeLessThan(360)
  act(() => vi.advanceTimersByTime(160))
  expect(hook.result.current.viewer).toBeLessThan(600)
  act(() => vi.advanceTimersByTime(32))
  expect(hook.result.current.viewer).toBe(600)
})
it('reverses mid-animation from the displayed width instead of jumping to a stale endpoint', () => {
  const hook = renderHook(({ target, phase }) => useWorkSplitMotion(target, phase), { initialProps: { target: open, phase: 'open' } })
  hook.rerender({ target: folded, phase: 'folded' })
  act(() => vi.advanceTimersByTime(64))
  const middle = hook.result.current.viewer
  expect(middle).toBeGreaterThan(0)
  expect(middle).toBeLessThan(600)
  hook.rerender({ target: open, phase: 'open' })
  expect(hook.result.current.viewer).toBe(middle)
  act(() => vi.advanceTimersByTime(16))
  expect(hook.result.current.viewer).toBeGreaterThan(middle)
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('respects reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const hook = renderHook(({ target, phase }) => useWorkSplitMotion(target, phase), { initialProps: { target: open, phase: 'open' } })
  hook.rerender({ target: folded, phase: 'folded' })
  expect(hook.result.current).toEqual(folded)
  expect(vi.getTimerCount()).toBe(0)
})
