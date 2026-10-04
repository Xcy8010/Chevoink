import { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), delay: vi.fn() }))
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }))
vi.mock('../../api/lib/prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
import { runtimeTransaction } from '../../api/lib/agent/runtime-common.js'
import { parentContentionGate } from '../../api/lib/agent/runtime-parent-contention.js'
const conflict = new Prisma.PrismaClientKnownRequestError('fixture conflict', { code: 'P2034', clientVersion: 'test' })
beforeEach(() => { vi.restoreAllMocks(); mocks.transaction.mockReset(); mocks.delay.mockReset().mockResolvedValue(undefined) })
afterEach(() => { vi.useRealTimers() })

describe('bounded child DB contention timing', () => {
  it('shares the original connection allowance with permit waiting and uses an earlier deadline', async () => {
    vi.useFakeTimers()
    const contentionScope = { userId: 'author', parentRootId: 'deadline-root' }
    const held = await parentContentionGate.acquire(contentionScope, { deadline: Date.now() + 5000 })
    mocks.transaction.mockResolvedValue('committed')
    const pending = runtimeTransaction(async () => undefined, { contentionScope })
    await vi.advanceTimersByTimeAsync(2000)
    held.release()
    expect(await pending).toBe('committed')
    expect(mocks.transaction.mock.calls[0][1]).toMatchObject({ maxWait: 3000, timeout: 10000 })
    const stillHeld = await parentContentionGate.acquire(contentionScope, { deadline: Date.now() + 5000 })
    const early = runtimeTransaction(async () => undefined, { contentionScope, deadline: Date.now() + 100 })
    const rejected = expect(early).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(mocks.transaction).toHaveBeenCalledOnce()
    stillHeld.release()
    expect(parentContentionGate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('releases the parent-root permit before conflict backoff so a sibling can commit', async () => {
    const contentionScope = { userId: 'author', parentRootId: 'root' }
    let reached!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { reached = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    mocks.delay.mockImplementationOnce(async () => { reached(); await resume })
    mocks.transaction.mockRejectedValueOnce(conflict).mockResolvedValue('committed')
    const retry = runtimeTransaction(async () => 'original', { contentionScope, contentionBackoff: true })
    await waiting
    expect(await runtimeTransaction(async () => 'sibling', { contentionScope })).toBe('committed')
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    release()
    expect(await retry).toBe('committed')
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(parentContentionGate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('begins same-parent transactions serially while a different parent can begin', async () => {
    let release!: () => void, reached!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const begun = new Promise<void>(resolve => { reached = resolve })
    mocks.transaction.mockImplementationOnce(async () => { reached(); await held; return 'first' }).mockResolvedValue('other')
    const first = runtimeTransaction(async () => undefined, { contentionScope: { userId: 'author', parentRootId: 'root' } })
    await begun
    const sibling = runtimeTransaction(async () => undefined, { contentionScope: { userId: 'author', parentRootId: 'root' } })
    expect(await runtimeTransaction(async () => undefined, { contentionScope: { userId: 'author', parentRootId: 'other-root' } })).toBe('other')
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    release()
    await Promise.all([first, sibling])
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(parentContentionGate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('removes aborted waiters without beginning or retrying and releases after a thrown transaction', async () => {
    const contentionScope = { userId: 'author', parentRootId: 'root' }, controller = new AbortController()
    const held = await parentContentionGate.acquire(contentionScope, { deadline: Date.now() + 5000 })
    const work = vi.fn(async () => undefined)
    const pending = runtimeTransaction(work, { contentionScope, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_CONTENTION_ABORTED' })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    held.release()
    const error = new Error('business refusal')
    mocks.transaction.mockRejectedValue(error)
    await expect(runtimeTransaction(work, { contentionScope })).rejects.toBe(error)
    expect(parentContentionGate.size()).toEqual({ roots: 0, waiting: 0 })
  })
  it('uses at most the same three Serializable attempts with no more than 450ms total delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    mocks.transaction.mockRejectedValue(conflict)
    await expect(runtimeTransaction(async () => undefined, { contentionBackoff: true })).rejects.toBe(conflict)
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(mocks.delay.mock.calls.map(call => call[0])).toEqual([150, 300])
    expect(mocks.transaction.mock.calls.every(call => call[1].isolationLevel === 'Serializable')).toBe(true)
  })
  it('restarts the DB callback from a fresh transaction after a conflict', async () => {
    const work = vi.fn(async () => 'committed')
    mocks.transaction.mockImplementationOnce(async () => { throw conflict }).mockImplementationOnce(async callback => callback({ fresh: true }))
    expect(await runtimeTransaction(work, { contentionBackoff: true })).toBe('committed')
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    expect(work).toHaveBeenCalledOnce()
    expect(mocks.delay).toHaveBeenCalledOnce()
  })
  it('never retries or waits for a non-conflict failure', async () => {
    const error = new Error('business permission denied')
    mocks.transaction.mockRejectedValue(error)
    await expect(runtimeTransaction(async () => undefined, { contentionBackoff: true })).rejects.toBe(error)
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.delay).not.toHaveBeenCalled()
  })
  it('leaves ordinary parent retry timing unchanged', async () => {
    mocks.transaction.mockRejectedValueOnce(conflict).mockResolvedValueOnce('committed')
    expect(await runtimeTransaction(async () => 'committed')).toBe('committed')
    expect(mocks.delay).not.toHaveBeenCalled()
  })
})
