import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { consumeCredits, recordImageRefundIntent, reconcileCreditRefunds } from '../../api/lib/credits.js'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)

async function fixture(work: (userId: string, key: string) => Promise<void>) {
  const userId = 'refund-clock-' + randomUUID(), key = 'image-clock:' + randomUUID()
  await prisma.user.create({ data: { id: userId, nickname: 'Synthetic refund clock', passwordHash: 'synthetic-unusable-password', role: 'user' } })
  try {
    await consumeCredits({ userId, amountMilli: 6000, kind: 'usage', sourceType: 'image_generation', idempotencyKey: key })
    await work(userId, key)
  } finally {
    vi.useRealTimers()
    await prisma.creditLedgerEntry.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
}

it('settles the exact new image refund immediately when the application clock trails database time', () => fixture(async (userId, key) => {
  const applicationNow = Date.now() - 1000
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(applicationNow)
  const intent = await recordImageRefundIntent(userId, key, { outcome: 'rejected', deliveredImages: 0 })
  const result = await reconcileCreditRefunds({ userId, limit: 10 })
  console.info('[refund-clock-evidence]', { applicationNow, nextAttemptAt: intent.nextAttemptAt.getTime(), examined: result.examined, settled: result.settled })
  expect(result).toEqual({ examined: 1, settled: 1 })
  expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'usage', deltaMilli: -6000 } })).toBe(1)
  expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund', deltaMilli: 6000 } })).toBe(1)
  expect((await reconcileCreditRefunds({ userId, limit: 10 })).settled).toBe(0)
  expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund' } })).toBe(1)
}))

it('does not erase existing backoff or retry an old refund early when its intent is recorded again', () => fixture(async (userId, key) => {
  const first = await recordImageRefundIntent(userId, key, { outcome: 'unknown', deliveredImages: 0 })
  const retryAt = new Date(Date.now() + 60_000)
  await prisma.creditRefundIntent.update({ where: { originalEntryId: first.originalEntryId }, data: { attempts: 2, nextAttemptAt: retryAt } })
  const replay = await recordImageRefundIntent(userId, key, { outcome: 'unknown', deliveredImages: 0 })
  expect(replay).toMatchObject({ originalEntryId: first.originalEntryId, attempts: 2, nextAttemptAt: retryAt, settledAt: null })
  expect(await reconcileCreditRefunds({ userId, limit: 10 })).toEqual({ examined: 0, settled: 0 })
  expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund' } })).toBe(0)
}))
