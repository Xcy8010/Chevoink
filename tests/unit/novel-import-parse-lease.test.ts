import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { novelImportJob: db } }))
import { startNovelImportParseLease } from '../../api/lib/novel-import/parse-lease.js'

const now = Date.UTC(2026, 8, 14)
const claim = () => ({ id: 'job', userId: 'owner', novelId: 'novel', leaseOwner: 'worker', leaseEpoch: 7, parseDeadlineAt: new Date(now + 30 * 60_000) })
const active = () => ({ status: 'parsing', leaseOwner: 'worker', leaseEpoch: 7, leaseUntil: new Date(Date.now() + 150_000), expiresAt: new Date(now + 86400_000) })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); db.findUnique.mockImplementation(async () => active()); db.updateMany.mockResolvedValue({ count: 1 }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
describe('bounded persisted parse lease', () => {
  it('continues beyond old 120 seconds with fenced renewal, without changing version or deadline', async () => {
    const lease = startNovelImportParseLease(claim())
    await vi.advanceTimersByTimeAsync(180_000)
    expect(lease.signal.aborted).toBe(false)
    expect(db.updateMany).toHaveBeenCalledTimes(9)
    const write = db.updateMany.mock.calls[0][0]
    expect(write.where).toMatchObject({ id: 'job', userId: 'owner', novelId: 'novel', leaseOwner: 'worker', leaseEpoch: 7, status: 'parsing' })
    expect(write.where.leaseUntil.gt).toBeInstanceOf(Date)
    expect(write.data).not.toHaveProperty('jobVersion')
    expect(write.data).not.toHaveProperty('parseDeadlineAt')
    lease.stop()
  })
  it('never exceeds persisted remaining budget on a recovered worker', async () => {
    const lease = startNovelImportParseLease({ ...claim(), parseDeadlineAt: new Date(now + 25_000) })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(db.updateMany.mock.calls[0][0].data.leaseUntil).toEqual(new Date(now + 25_000))
    await vi.advanceTimersByTimeAsync(5000)
    expect(lease.signal.aborted).toBe(true); expect(lease.timedOut).toBe(true)
    lease.stop()
  })
  it('fails legacy missing and expired deadlines before any renewal', () => {
    for (const parseDeadlineAt of [null, new Date(now - 1)]) {
      const lease = startNovelImportParseLease({ ...claim(), parseDeadlineAt })
      expect(lease.signal.aborted).toBe(true); expect(lease.timedOut).toBe(true); lease.stop()
    }
    expect(db.updateMany).not.toHaveBeenCalled()
  })
  it.each(['cancelled', 'foreign-owner', 'foreign-epoch', 'expired-lease', 'missing'])('aborts on %s without reviving the claim', async reason => {
    const value = active()
    if (reason === 'cancelled') value.status = 'cancelled'
    if (reason === 'foreign-owner') value.leaseOwner = 'other'
    if (reason === 'foreign-epoch') value.leaseEpoch++
    if (reason === 'expired-lease') value.leaseUntil = new Date(now)
    db.findUnique.mockResolvedValue(reason === 'missing' ? null : value)
    const lease = startNovelImportParseLease(claim())
    await vi.advanceTimersByTimeAsync(1000)
    expect(lease.signal.aborted).toBe(true); expect(lease.timedOut).toBe(false)
    expect(db.updateMany).not.toHaveBeenCalled(); lease.stop()
  })
  it('aborts on a rejected renewal and on DB uncertainty', async () => {
    db.updateMany.mockResolvedValue({ count: 0 })
    const lease = startNovelImportParseLease(claim())
    await vi.advanceTimersByTimeAsync(20_000)
    expect(lease.signal.aborted).toBe(true); lease.stop()
    db.findUnique.mockRejectedValue(new Error('database unavailable'))
    const failed = startNovelImportParseLease(claim())
    await vi.advanceTimersByTimeAsync(1000)
    expect(failed.signal.aborted).toBe(true); failed.stop()
  })
  it('keeps one in-flight poll and removes both timers on completion', async () => {
    let finish: ((value: ReturnType<typeof active>) => void) | undefined
    db.findUnique.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const lease = startNovelImportParseLease(claim())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(db.findUnique).toHaveBeenCalledTimes(1)
    finish?.(active()); await Promise.resolve()
    lease.stop(); const calls = db.findUnique.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(db.findUnique).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })
})
