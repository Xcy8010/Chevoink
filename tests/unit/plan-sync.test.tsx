// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
