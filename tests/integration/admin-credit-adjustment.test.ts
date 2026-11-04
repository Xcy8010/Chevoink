import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { adjustAdminBonusCredits } from '../../api/lib/admin-credit-adjustment.js'
import { getCreditActivity } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })
describe.runIf(available)('admin reward adjustment on real isolated PostgreSQL', () => {
  async function fixture(work: (adminId: string, userId: string) => Promise<void>) {
    const adminId = randomUUID(), userId = randomUUID()
    await prisma.user.createMany({ data: [{ id: adminId, nickname: 'adjust-admin', role: 'admin', isSuperAdmin: true, passwordHash: 'fixture-only' }, { id: userId, nickname: 'adjust-user', passwordHash: 'fixture-only' }] })
    try { await work(adminId, userId) }
    finally {
      await prisma.adminAuditLog.deleteMany({ where: { adminId } })
      await prisma.aiUsageLog.deleteMany({ where: { userId } })
      await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } })
    }
  }
  it('deduplicates concurrent requests and preserves daily policy, ledger and original replay after spend', async () => {
    await fixture(async (adminId, userId) => {
      const old = new Date(Date.now() - 86400000)
      await prisma.creditAccount.create({ data: { userId, bonusBalanceMilli: 10000, dailyAllowanceMilli: 450000, dailyUsedMilli: 123000, periodStartedAt: old, periodEndsAt: old, suspendedAt: old } })
      const before = await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })
      const payload = { mode: 'add' as const, amountMilli: 1250, expectedBonusBalanceMilli: 10000, reason: '合成客服奖励', requestKey: randomUUID() }
      const results = await Promise.all([adjustAdminBonusCredits(adminId, userId, payload), adjustAdminBonusCredits(adminId, userId, payload)])
      expect(results[0]).toEqual(results[1])
      expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).toMatchObject({ bonusBalanceMilli: 11250, dailyUsedMilli: before.dailyUsedMilli, dailyAllowanceMilli: before.dailyAllowanceMilli, periodStartedAt: before.periodStartedAt, periodEndsAt: before.periodEndsAt, suspendedAt: before.suspendedAt })
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId } })).toMatchObject([{ bonusDeltaMilli: 1250, dailyDeltaMilli: 0, deltaMilli: 1250 }])
      expect(await prisma.adminAuditLog.count({ where: { adminId, action: 'credits.adjust_bonus' } })).toBe(1)
      await prisma.creditAccount.update({ where: { userId }, data: { bonusBalanceMilli: 5000 } })
      expect(await adjustAdminBonusCredits(adminId, userId, payload)).toEqual(results[0])
      await expect(adjustAdminBonusCredits(adminId, userId, { ...payload, mode: 'set' })).rejects.toMatchObject({ code: 'CREDIT_ADJUSTMENT_IDENTITY_CONFLICT' })
      const next = { ...payload, requestKey: randomUUID(), expectedBonusBalanceMilli: 5000 }
      const concurrent = await Promise.allSettled([adjustAdminBonusCredits(adminId, userId, next), adjustAdminBonusCredits(adminId, userId, { ...next, requestKey: randomUUID() })])
      expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).bonusBalanceMilli).toBe(6250)
    })
  })
  it('rolls back lazy account creation on stale balance and protects active reservations', async () => {
    await fixture(async (adminId, userId) => {
      const payload = { mode: 'set' as const, amountMilli: 0, expectedBonusBalanceMilli: 1000, reason: '合成扣减', requestKey: randomUUID() }
      await expect(adjustAdminBonusCredits(adminId, userId, payload)).rejects.toMatchObject({ code: 'CREDIT_BALANCE_CONFLICT' })
      expect(await prisma.creditAccount.findUnique({ where: { userId } })).toBeNull()
      const now = new Date(), future = new Date(now.getTime() + 86400000)
      await prisma.creditAccount.create({ data: { userId, bonusBalanceMilli: 1000, dailyAllowanceMilli: 450000, dailyUsedMilli: 450000, periodStartedAt: now, periodEndsAt: future } })
      await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture', modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', durationMs: 0, requestTokens: 0, responseTokens: 0, reservedCreditMilli: 900, reservationExpiresAt: future, billingStatus: 'prepared' } })
      await expect(adjustAdminBonusCredits(adminId, userId, payload)).rejects.toMatchObject({ code: 'CREDIT_BALANCE_RESERVED' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).bonusBalanceMilli).toBe(1000)
    })
  })
  it('keeps administrator reductions out of personal spending, usage days and streaks while counting legitimate calls', async () => {
    await fixture(async (adminId, userId) => {
      const now = new Date('2026-11-04T04:00:00Z')
      await prisma.creditAccount.create({ data: { userId, bonusBalanceMilli: 10000, periodStartedAt: now, periodEndsAt: new Date('2030-01-01T00:00:00Z') } })
      const payload = { mode: 'subtract' as const, amountMilli: 1000, expectedBonusBalanceMilli: 10000, reason: '合成奖励扣减', requestKey: randomUUID() }
      await adjustAdminBonusCredits(adminId, userId, payload)
      await adjustAdminBonusCredits(adminId, userId, { ...payload, mode: 'set', amountMilli: 7000, expectedBonusBalanceMilli: 9000, requestKey: randomUUID() })
      await prisma.creditLedgerEntry.updateMany({ where: { userId, kind: 'admin_adjustment' }, data: { createdAt: new Date('2026-11-03T04:00:00Z') } })
      const adjustmentsOnly = await getCreditActivity(userId, now)
      expect(adjustmentsOnly.stats).toMatchObject({ cumulativeSpent: 0, peakDailySpent: 0, activeDays: 0, currentStreakDays: 0, longestStreakDays: 0, activity: [] })
      await prisma.creditLedgerEntry.createMany({ data: [
        { userId, kind: 'usage', sourceType: 'model_tokens', deltaMilli: -1000, idempotencyKey: randomUUID(), createdAt: new Date('2026-11-02T04:00:00Z') },
        { userId, kind: 'usage', sourceType: 'web_search', deltaMilli: -2000, idempotencyKey: randomUUID(), createdAt: now },
      ] })
      const mixed = await getCreditActivity(userId, now)
      expect(mixed.stats).toMatchObject({ cumulativeSpent: 3, peakDailySpent: 2, activeDays: 2, currentStreakDays: 1, longestStreakDays: 1,
        activity: [{ date: '2026-11-02', creditsSpent: 1, eventCount: 1 }, { date: '2026-11-04', creditsSpent: 2, eventCount: 1 }] })
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).bonusBalanceMilli).toBe(7000)
      expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'admin_adjustment' } })).toBe(2)
    })
  })
})
