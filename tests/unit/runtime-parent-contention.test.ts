import { afterEach, describe, expect, it, vi } from 'vitest'
import { createParentContentionGate, PARENT_CONTENTION_LIMITS, readParentContentionScope } from '../../api/lib/agent/runtime-parent-contention.js'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/lib/prisma.js')>()
  return { ...actual, prisma: { agentChildExecutionGrant: { findFirst: mocks.findFirst } } }
})
afterEach(() => { vi.useRealTimers(); mocks.findFirst.mockReset() })
const scope = (root = 'root', userId = 'author') => ({ userId, parentRootId: root })
const deadline = () => Date.now() + 5000

describe('immutable parent-root DB contention permits', () => {
  it('serializes one parent, permits other parents/users, and removes entries after release', async () => {
    const gate = createParentContentionGate()
    const first = await gate.acquire(scope(), { deadline: deadline() })
    let admitted = false
    const queued = gate.acquire(scope(), { deadline: deadline() }).then(permit => { admitted = true; return permit })
    const other = await gate.acquire(scope('other'), { deadline: deadline() })
    const author = await gate.acquire(scope('root', 'another-author'), { deadline: deadline() })
    expect(admitted).toBe(false)
    first.release()
    const second = await queued
    expect(admitted).toBe(true)
    first.release() // An old release cannot release its successor.
    expect(gate.size()).toEqual({ roots: 3, waiting: 0 })
    second.release(); other.release(); author.release()
    expect(gate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('removes cancelled and timed-out waiters and never admits them later', async () => {
    vi.useFakeTimers()
    const gate = createParentContentionGate(), controller = new AbortController()
    const first = await gate.acquire(scope(), { deadline: deadline() })
    const aborted = gate.acquire(scope(), { deadline: deadline(), signal: controller.signal })
    const timed = gate.acquire(scope(), { deadline: Date.now() + 100 })
    const abortCheck = expect(aborted).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_ABORTED' })
    const timeCheck = expect(timed).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_TIMEOUT' })
    controller.abort()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([abortCheck, timeCheck])
    expect(gate.size()).toEqual({ roots: 1, waiting: 0 })
    expect(vi.getTimerCount()).toBe(0)
    first.release()
    expect(gate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('bounds per-root waiters without bypass and clears them on cancellation', async () => {
    const gate = createParentContentionGate(), controllers = Array.from({ length: PARENT_CONTENTION_LIMITS.perRootWaiting }, () => new AbortController())
    const held = await gate.acquire(scope(), { deadline: deadline() })
    const queued = controllers.map(controller => gate.acquire(scope(), { deadline: deadline(), signal: controller.signal }).catch(error => error.code))
    await expect(gate.acquire(scope(), { deadline: deadline() })).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_CAPACITY' })
    controllers.forEach(controller => controller.abort())
    expect((await Promise.all(queued)).every(code => code === 'RUNTIME_CONTENTION_ABORTED')).toBe(true)
    held.release()
    expect(gate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('bounds active roots and total waiters as fixed resource ceilings', async () => {
    vi.useFakeTimers()
    const gate = createParentContentionGate()
    const held = await Promise.all(Array.from({ length: PARENT_CONTENTION_LIMITS.activeRoots }, (_, i) => gate.acquire(scope(String(i)), { deadline: deadline() })))
    await expect(gate.acquire(scope('overflow'), { deadline: deadline() })).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_CAPACITY' })
    const queued = Array.from({ length: PARENT_CONTENTION_LIMITS.totalWaiting }, (_, i) => gate.acquire(scope(String(i % PARENT_CONTENTION_LIMITS.activeRoots)), { deadline: Date.now() + 100 }).catch(error => error.code))
    await expect(gate.acquire(scope('0'), { deadline: deadline() })).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_CAPACITY' })
    vi.advanceTimersByTime(100)
    expect((await Promise.all(queued)).every(code => code === 'RUNTIME_CONTENTION_TIMEOUT')).toBe(true)
    held.forEach(permit => permit.release())
    expect(gate.size()).toEqual({ roots: 0, waiting: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('single persisted lineage scheduling lookup', () => {
  it('selects no lease relations for late evidence or ordinary family lookup', async () => {
    mocks.findFirst.mockResolvedValue({ parentRootId: 'parent', childRunId: 'child' })
    expect(await readParentContentionScope('author', 'child')).toEqual({ userId: 'author', parentRootId: 'parent', isChild: true })
    expect(mocks.findFirst).toHaveBeenCalledOnce()
    expect(mocks.findFirst.mock.calls[0][0]).toEqual({ where: { OR: [
      { childRunId: 'child', childRun: { userId: 'author' } },
      { parentRoot: { userId: 'author', runs: { some: { id: 'child', userId: 'author' } } } },
    ] }, select: { parentRootId: true, childRunId: true } })
  })
  it('selects lease relations once and uses the earliest child and parent expiry', async () => {
    mocks.findFirst.mockResolvedValue({ parentRootId: 'parent', childRunId: 'child',
      childRun: { executionLease: { expiresAt: new Date(2000) } }, currentParentRun: { executionLease: { expiresAt: new Date(1000) } } })
    expect(await readParentContentionScope('author', 'child', true)).toEqual({ userId: 'author', parentRootId: 'parent', isChild: true, deadline: 1000 })
    expect(mocks.findFirst).toHaveBeenCalledOnce()
    expect(mocks.findFirst.mock.calls[0][0].select).toEqual({ parentRootId: true, childRunId: true,
      childRun: { select: { executionLease: { select: { expiresAt: true } } } },
      currentParentRun: { select: { executionLease: { select: { expiresAt: true } } } } })
  })
  it('uses only the parent expiry for parent work and leaves absent expiries to transaction fences', async () => {
    mocks.findFirst.mockResolvedValue({ parentRootId: 'parent', childRunId: 'child',
      childRun: { executionLease: { expiresAt: new Date(500) } }, currentParentRun: { executionLease: { expiresAt: new Date(1000) } } })
    expect(await readParentContentionScope('author', 'parent-run', true)).toEqual({ userId: 'author', parentRootId: 'parent', isChild: false, deadline: 1000 })
    mocks.findFirst.mockResolvedValue({ parentRootId: 'parent', childRunId: 'child', childRun: { executionLease: null }, currentParentRun: { executionLease: { expiresAt: null } } })
    expect(await readParentContentionScope('author', 'child', true)).toEqual({ userId: 'author', parentRootId: 'parent', isChild: true })
    expect(mocks.findFirst).toHaveBeenCalledTimes(2)
  })
  it.each([false, true])('keeps main without a family ungated with leaseDeadline=%s', async leaseDeadline => {
    mocks.findFirst.mockResolvedValue(null)
    expect(await readParentContentionScope('author', 'ordinary-main', leaseDeadline)).toBeUndefined()
    expect(mocks.findFirst).toHaveBeenCalledOnce()
  })
})
