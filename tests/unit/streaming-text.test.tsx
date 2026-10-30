// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStreamingText } from '../../src/features/studio/components/use-streaming-text'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('reveals real chunks progressively, flushes end/failure/cancel and discards pending scope text', () => {
  vi.useFakeTimers()
  const hook = renderHook(({ text, active, scope }) => useStreamingText(text, active, scope), {
    initialProps: { text: '', active: true, scope: 'a' }, wrapper: StrictMode,
  })
  const text = '真实的实时文字逐步出现，不凭空产生进度。'
  hook.rerender({ text, active: true, scope: 'a' })
  act(() => vi.advanceTimersByTime(16))
  expect(hook.result.current.length).toBeGreaterThan(0)
  expect(hook.result.current.length).toBeLessThan(text.length)
  expect(text.startsWith(hook.result.current)).toBe(true)
  hook.rerender({ text: '新任务', active: true, scope: 'b' })
  expect(hook.result.current).toBe('新任务')
  act(() => vi.advanceTimersByTime(500))
  expect(hook.result.current).toBe('新任务')
  for (const end of ['已完成', '失败', '已取消']) {
    hook.rerender({ text: end.repeat(10), active: true, scope: 'b' })
    hook.rerender({ text: end, active: false, scope: 'b' })
    expect(hook.result.current).toBe(end)
    expect(vi.getTimerCount()).toBe(0)
  }
  hook.rerender({ text: '已取消后新输出', active: true, scope: 'b' })
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('shows received text immediately with reduced motion', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const hook = renderHook(({ text }) => useStreamingText(text, true, 'a'), { initialProps: { text: '' } })
  hook.rerender({ text: '即时显示完整文本' })
  expect(hook.result.current).toBe('即时显示完整文本')
  expect(vi.getTimerCount()).toBe(0)
})
