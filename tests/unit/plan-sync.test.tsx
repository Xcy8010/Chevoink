import { useRef, useState } from 'react'
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SaveState } from '../../src/features/studio/types'
import { usePlanSync } from '../../src/features/studio/components/use-plan-sync'

const update = vi.hoisted(() => vi.fn())
vi.mock('../../src/features/studio/api', () => ({ updateNovelPlanFile: update }))
beforeEach(() => { vi.useFakeTimers(); update.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers() })

it('sends only the latest pending text after 800ms', async () => {
  const { result } = renderHook(usePlanSync)
  act(() => { result.current.schedulePlanServerSync('a', 'Title', 'old'); result.current.schedulePlanServerSync('a', 'Title', 'new') })
  await act(async () => { await vi.advanceTimersByTimeAsync(799) })
  expect(update).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'Title', content: 'new' })
})

it('flushes the previous document before switching pending targets', async () => {
  const { result } = renderHook(usePlanSync)
  act(() => { result.current.schedulePlanServerSync('a', 'A', 'first'); result.current.schedulePlanServerSync('b', 'B', 'second') })
  expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'A', content: 'first' })
  act(() => result.current.flushPlanServerSync())
  expect(update).toHaveBeenLastCalledWith('b', { title: 'B', content: 'second' })
  await act(async () => { await vi.advanceTimersByTimeAsync(800) })
  expect(update).toHaveBeenCalledTimes(2)
})

it('keeps empty flushes idempotent and allows a later edit after failure', async () => {
  update.mockRejectedValueOnce(new Error('offline'))
  const { result } = renderHook(usePlanSync)
  act(() => { result.current.flushPlanServerSync(); result.current.schedulePlanServerSync('a', 'A', 'first'); result.current.flushPlanServerSync() })
  await act(async () => { await Promise.resolve() })
  act(() => { result.current.schedulePlanServerSync('a', 'A', 'retry'); result.current.flushPlanServerSync() })
  expect(update).toHaveBeenCalledTimes(2)
  expect(update).toHaveBeenLastCalledWith('a', { title: 'A', content: 'retry' })
})

it('serializes writes to the same document without blocking another document', async () => {
  let finishFirst!: () => void
  update.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
  const { result } = renderHook(usePlanSync)
  act(() => {
    result.current.schedulePlanServerSync('a', 'A', 'old')
    result.current.flushPlanServerSync()
    result.current.schedulePlanServerSync('a', 'A', 'new')
    result.current.flushPlanServerSync()
    result.current.schedulePlanServerSync('b', 'B', 'independent')
    result.current.flushPlanServerSync()
  })
  expect(update.mock.calls.map((call) => call[1].content)).toEqual(['old', 'independent'])
  await act(async () => { finishFirst(); await Promise.resolve() })
  expect(update.mock.calls.map((call) => call[1].content)).toEqual(['old', 'independent', 'new'])
})

it('continues queued latest content after an older save fails', async () => {
  let failFirst!: (error: Error) => void
  update.mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject }))
  const { result } = renderHook(usePlanSync)
  act(() => {
    result.current.schedulePlanServerSync('a', 'A', 'old')
    result.current.flushPlanServerSync()
    result.current.schedulePlanServerSync('a', 'A', 'latest')
    result.current.flushPlanServerSync()
  })
  expect(update).toHaveBeenCalledOnce()
  await act(async () => { failFirst(new Error('offline')); await Promise.resolve() })
  expect(update).toHaveBeenLastCalledWith('a', { title: 'A', content: 'latest' })
})

it('waits for the actual in-flight plan save and reports its original failure to a novel transition', async () => {
  const error = new Error('计划保存网络失败')
  let fail!: (error: Error) => void
  update.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
  const { result } = renderHook(usePlanSync)
  act(() => { result.current.schedulePlanServerSync('a', 'A', 'pending plan'); result.current.flushPlanServerSync() })
  let completed = false
  const waiting = result.current.awaitPlanServerSync().then(() => { completed = true }, failure => failure)
  expect(completed).toBe(false)
  await act(async () => { fail(error); expect(await waiting).toBe(error) })
  expect(update).toHaveBeenCalledOnce()
  expect(completed).toBe(false)
})

it('flushes the pending plan before resolving a successful transition', async () => {
  const { result } = renderHook(usePlanSync)
  act(() => result.current.schedulePlanServerSync('a', 'A', 'latest plan'))
  await act(async () => { await result.current.awaitPlanServerSync() })
  expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'A', content: 'latest plan' })
})


it('advances expectedPlanHash through serialized saves without dropping their original scope', async () => {
  let resolve!: (item: object) => void
  update.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  update.mockResolvedValueOnce({ id: 'a', planHash: 'h2' }).mockResolvedValueOnce({ id: 'a', planHash: 'h3' })
  const onSaved = vi.fn()
  const { result } = renderHook(() => usePlanSync(onSaved))
  act(() => {
    result.current.schedulePlanServerSync('a', 'A', 'one', 'h0', 'novel:1'); result.current.flushPlanServerSync()
    result.current.schedulePlanServerSync('a', 'A', 'two', 'h0', 'novel:1'); result.current.flushPlanServerSync()
    result.current.schedulePlanServerSync('a', 'A', 'three', 'h0', 'novel:1'); result.current.flushPlanServerSync()
  })
  expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'A', content: 'one', expectedPlanHash: 'h0' })
  await act(async () => { resolve({ id: 'a', planHash: 'h1' }); await result.current.awaitPlanServerSync() })
  expect(update.mock.calls.map(call => call[1].expectedPlanHash)).toEqual(['h0', 'h1', 'h2'])
  expect(onSaved).toHaveBeenLastCalledWith({ id: 'a', planHash: 'h3' }, 'novel:1', 'three')
})

it('does not replace an externally refreshed version with an old locally cached hash', async () => {
  update.mockResolvedValueOnce({ id: 'a', planHash: 'h1' }).mockResolvedValueOnce({ id: 'a', planHash: 'h3' })
  const { result } = renderHook(() => usePlanSync())
  act(() => result.current.schedulePlanServerSync('a', 'A', 'one', 'h0'))
  await act(async () => result.current.awaitPlanServerSync())
  act(() => result.current.schedulePlanServerSync('a', 'A', 'external base', 'external-h2'))
  await act(async () => result.current.awaitPlanServerSync())
  expect(update).toHaveBeenLastCalledWith('a', { title: 'A', content: 'external base', expectedPlanHash: 'external-h2' })
})

it('a title-only rename preserves the pending text and its concurrency version', async () => {
  const { result } = renderHook(() => usePlanSync())
  act(() => {
    result.current.schedulePlanServerSync('a', 'A', 'pending', 'h0')
    result.current.schedulePlanServerSync('a', 'Renamed')
  })
  await act(async () => result.current.awaitPlanServerSync())
  expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'Renamed', content: 'pending', expectedPlanHash: 'h0' })
})

it('settings wait for text saves and use the resulting version before updating a dependency', async () => {
  update.mockResolvedValueOnce({ id: 'a', planHash: 'h1' }).mockResolvedValueOnce({ id: 'a', planHash: 'h2' })
  const { result } = renderHook(() => usePlanSync())
  act(() => result.current.schedulePlanServerSync('a', 'A', 'pending', 'h0'))
  await act(async () => { await result.current.savePlanMetadata('a', { parentPlanId: 'parent', expectedParentPlanHash: 'p1', expectedPlanHash: 'h0' }) })
  expect(update).toHaveBeenLastCalledWith('a', { parentPlanId: 'parent', expectedParentPlanHash: 'p1', expectedPlanHash: 'h1' })
})

it('keeps a rejected version visible to the transition instead of silently rebasing on the server', async () => {
  update.mockRejectedValueOnce(new Error('版本已变化'))
  const { result } = renderHook(() => usePlanSync())
  act(() => result.current.schedulePlanServerSync('a', 'A', 'pending', 'old'))
  await act(async () => { await expect(result.current.awaitPlanServerSync()).rejects.toThrow('版本已变化') })
  expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'A', content: 'pending', expectedPlanHash: 'old' })
})


it('reports a background version conflict immediately and clears it after the corrected draft saves', async () => {
  const conflict = new Error('计划版本已变化，请重新核对')
  const feedback = vi.fn()
  update.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ id: 'a', planHash: 'h2' })
  const { result } = renderHook(() => usePlanSync(undefined, feedback))
  act(() => result.current.schedulePlanServerSync('a', 'A', '\n待保存原文\n', 'old', 'novel:1'))
  await act(async () => { await vi.advanceTimersByTimeAsync(800) })
  expect(feedback).toHaveBeenLastCalledWith('error', conflict.message, 'novel:1')
  await act(async () => { await expect(result.current.awaitPlanServerSync()).rejects.toBe(conflict) })
  expect(update).toHaveBeenCalledOnce()
  act(() => result.current.schedulePlanServerSync('a', 'A', '\n作者核对后的原文\n', 'current', 'novel:1'))
  expect(feedback).toHaveBeenLastCalledWith('error', conflict.message, 'novel:1')
  expect(update).toHaveBeenCalledOnce()
  await act(async () => result.current.awaitPlanServerSync())
  expect(update).toHaveBeenLastCalledWith('a', { title: 'A', content: '\n作者核对后的原文\n', expectedPlanHash: 'current' })
  expect(feedback).toHaveBeenLastCalledWith('saved', '计划已保存。', 'novel:1')
})

it('retains unsaved body content when a failed save is followed by a title-only edit', async () => {
  update.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 'a', planHash: 'h1' })
  const { result } = renderHook(() => usePlanSync())
  act(() => result.current.schedulePlanServerSync('a', 'A', '\n保留草稿\n', 'h0', 'novel:1'))
  await act(async () => { await expect(result.current.awaitPlanServerSync()).rejects.toThrow('offline') })
  act(() => result.current.schedulePlanServerSync('a', 'Renamed', undefined, undefined, 'novel:1'))
  await act(async () => result.current.awaitPlanServerSync())
  expect(update).toHaveBeenLastCalledWith('a', { title: 'Renamed', content: '\n保留草稿\n', expectedPlanHash: 'h0' })
})

it('does not clear a failed document status when a different plan in that scope saves', async () => {
  const feedback = vi.fn()
  update.mockRejectedValueOnce(new Error('a conflict')).mockResolvedValueOnce({ id: 'b', planHash: 'b1' })
  const { result } = renderHook(() => usePlanSync(undefined, feedback))
  act(() => result.current.schedulePlanServerSync('a', 'A', 'A draft', 'a0', 'novel:1'))
  await act(async () => { await expect(result.current.awaitPlanServerSync()).rejects.toThrow('a conflict') })
  feedback.mockClear()
  act(() => result.current.schedulePlanServerSync('b', 'B', 'B draft', 'b0', 'novel:1'))
  await act(async () => { await expect(result.current.awaitPlanServerSync()).rejects.toThrow('a conflict') })
  expect(feedback.mock.calls.some(call => call[0] === 'saved')).toBe(false)
})

it('fences a late failure after A to B to A using the originating scope and keeps the new draft', async () => {
  let reject!: (reason: Error) => void
  update.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  const { result, rerender } = renderHook(({ scope, draft }: { scope: string; draft: string }) => {
    const currentScope = useRef(scope)
    currentScope.current = scope
    const [feedback, setFeedback] = useState<{ scope: string; state: SaveState; message: string }>({ scope, state: 'idle', message: '' })
    const sync = usePlanSync(undefined, (state, message, originScope) => {
      if (originScope !== currentScope.current) return
      setFeedback({ scope: originScope, state, message })
    })
    return { ...sync, feedback, draft }
  }, { initialProps: { scope: 'novel-a:1', draft: 'A draft' } })
  act(() => { result.current.schedulePlanServerSync('a', 'A', 'A draft', 'h0', 'novel-a:1'); result.current.flushPlanServerSync() })
  rerender({ scope: 'novel-b:2', draft: 'B draft' })
  rerender({ scope: 'novel-a:3', draft: 'new A draft' })
  await act(async () => { reject(new Error('old A conflict')); await Promise.resolve() })
  expect(result.current.feedback.state).not.toBe('error')
  expect(result.current.draft).toBe('new A draft')
})
