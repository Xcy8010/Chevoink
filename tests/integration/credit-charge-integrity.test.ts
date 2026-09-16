import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'
import { reserveTokenCredits, getCreditSummary, assertCreditAccess, consumeCredits, consumeCreditsInTransaction, consumeTokenCredits, getCreditWindow, refundCreditCharge,
  recordSearchRefundIntent, recordImageRefundIntent, reconcileCreditRefunds, getSearchRefundState, getTaskCreditUsage, type ConsumeCreditInput } from '../../api/lib/credits.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { resetAdminUsersCredits } from '../../api/lib/admin-credit-model.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

async function fixture(run: (userId: string, input: ConsumeCreditInput) => Promise<void>, balance = 10000) {
  const id = randomUUID()
  await prisma.user.create({ data: { id, phone: `test-${id.slice(0, 18)}`, nickname: 'credit-integrity-fixture', passwordHash: 'test-only-unusable' } })
  try {
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: id, dailyAllowanceMilli: balance, dailyUsedMilli: 0, bonusBalanceMilli: 0, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    await run(id, { userId: id, idempotencyKey: `test-charge:${randomUUID()}`, amountMilli: 2000, kind: 'usage', sourceType: 'web_search', referenceId: 'test-run', modelTier: 'speed', metadata: { query: 'test query' } })
  } finally {
    // Both wallet and ledger are owned by this exact fixture user and cascade on delete.
    // Novels deliberately restrict author deletion; clear only this fixture's
    // generated novels first, including when an assertion fails midway.
    await prisma.agentRun.deleteMany({ where: { userId: id } })
    await prisma.agentSession.deleteMany({ where: { userId: id } })
    await prisma.novel.deleteMany({ where: { authorId: id } })
    await prisma.user.delete({ where: { id } })
  }
}

describe.skipIf(!dbAvailable)('credit request identity and wallet integrity (isolated PG)', () => {
  it('never overbooks concurrent reservations or lets another paid tool spend reserved funds', async () => {
    await fixture(async (userId, payment) => {
      const ids: string[] = []
      try {
        for (let i = 0; i < 5; i++) ids.push((await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture',
          modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', durationMs: 0, billingStatus: 'prepared',
          billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 } } })).id)
        const results = await Promise.allSettled(ids.map(id => reserveTokenCredits(userId, id, 100000, 10000)))
        expect(results.some(result => result.status === 'fulfilled')).toBe(true)
        const held = (await prisma.aiUsageLog.aggregate({ where: { userId }, _sum: { reservedCreditMilli: true } }))._sum.reservedCreditMilli ?? 0
        expect(held).toBeGreaterThan(0)
        expect(held).toBeLessThanOrEqual(10000)
        await expect(consumeCredits({ ...payment, amountMilli: 10001 - held })).rejects.toMatchObject({ code: 'CREDITS_RESERVED' })
        expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { id: { in: ids }, userId } }) }
    })
  })
  it('never reserves or bills a zero-rate free-tier call on an empty balance', async () => {
    await fixture(async userId => {
      const usage = await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture', modelName: 'fixture-free',
        action: 'fixture', targetType: 'text', modelTier: 'lite', multiplierBps: 0, requestTokens: 1000, responseTokens: 500,
        durationMs: 0, billingStatus: 'prepared', usageSource: 'prepared', billingSnapshot: { version: 'credits-v1-exact', modelTier: 'lite', multiplierBps: 0 } } })
      try {
        await prisma.creditAccount.update({ where: { userId }, data: { dailyAllowanceMilli: 0, dailyUsedMilli: 0, bonusBalanceMilli: 0 } })
        await expect(reserveTokenCredits(userId, usage.id, 100000, 10000)).resolves.toBeUndefined()
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toMatchObject({ reservedCreditMilli: 0, billingStatus: 'prepared' })
        const charge = await consumeTokenCredits({ userId, usageLogId: usage.id, requestTokens: 1000, responseTokens: 500, modelTier: 'lite', multiplierBps: 0 })
        expect(charge.chargedMilli).toBe(0)
        expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(1)
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })
  it.each(['reported', 'partial', 'unknown', 'expired'] as const)('isolates a %s call reservation and preserves settlement identity', async scenario => {
    await fixture(async userId => {
      const evidence = { policy: 'observed-output-estimate-2026-09-09', inputEstimate: 1000, outputEstimate: 40, responseObserved: scenario === 'partial' }
      const usage = await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture', modelName: 'fixture',
        action: 'fixture', targetType: 'text', modelTier: 'speed', durationMs: 0, billingStatus: 'prepared', usageSource: 'prepared', billingEvidence: evidence,
        billingSnapshot: { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'fixture-reserve',
          rates: { inputNano: 100000, cacheNano: 25000, outputNano: 1000000 } } } })
      try {
        await Promise.all([reserveTokenCredits(userId, usage.id, 1000, 10000), reserveTokenCredits(userId, usage.id, 1000, 10000)])
        expect(await getCreditSummary(userId)).toMatchObject({ balance: 10, reserved: 2.5, totalRemaining: 7.5 })
        expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
        await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { billingStatus: 'pending_usage', usageSource: scenario === 'reported' ? 'reported' : 'unknown',
          ...(scenario === 'reported' ? { requestTokens: 1000, responseTokens: 100 } : {}),
          ...(scenario === 'expired' ? { reservationExpiresAt: new Date(Date.now() - 1000) } : {}) } })
        await expect(assertCreditAccess(userId, 'speed')).resolves.toBeUndefined()
        if (scenario === 'reported' || scenario === 'partial') {
          const input = { userId, usageLogId: usage.id, requestTokens: scenario === 'reported' ? 1000 : 0, responseTokens: scenario === 'reported' ? 100 : 0, modelTier: 'speed' as const }
          const charge = scenario === 'reported' ? 125 : 65
          const results = await Promise.all([consumeTokenCredits(input), consumeTokenCredits(input)])
          expect(results.map(item => item.chargedMilli)).toEqual([charge, charge])
          expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(1)
          expect(await getCreditSummary(userId)).toMatchObject({ reserved: 0, totalRemaining: (10000 - charge) / 1000 })
          if (scenario === 'partial') {
            expect((await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId } })).metadata).toMatchObject({ estimated: true })
            expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toMatchObject({ requestTokens: null, responseTokens: null })
          }
        } else {
          expect(await getCreditSummary(userId)).toMatchObject({ reserved: scenario === 'expired' ? 0 : 2.5 })
          expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
        }
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })
  it('does not let a prior-window unknown receipt lock fresh allowance or exempt BYOK calls', async () => {
    await fixture(async userId => {
      const usage = await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture',
        modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', durationMs: 1,
        createdAt: new Date(getCreditWindow().startedAt.getTime() - 1), usageSource: 'unknown', billingStatus: 'pending_usage',
        billingSnapshot: { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
          rateCardId: 'fixture', rates: { inputNano: 100000, cacheNano: 25000, outputNano: 1000000 } } } })
      try {
        await expect(assertCreditAccess(userId, 'speed')).resolves.toBeUndefined()
        await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { createdAt: new Date() } })
        await expect(assertCreditAccess(userId, 'speed')).resolves.toBeUndefined()
        await expect(assertCreditAccess(userId, 'custom')).resolves.toBeUndefined()
        expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } }))
          .toMatchObject({ requestTokens: null, responseTokens: null, billingStatus: 'pending_usage' })
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })
  it('settles and refunds capped V2 exactly once without repricing the frozen request', async () => {
    await fixture(async userId => {
      const price = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 11000, v1CeilingBps: 11000,
        rateCardId: 'fixture-quarter', rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
      const usage = await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture',
        modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', multiplierBps: 11000,
        requestTokens: 10000, responseTokens: 1000, promptCacheHitTokens: 0, promptCacheMissTokens: 10000,
        durationMs: 1, billingSnapshot: price, usageSource: 'reported' } })
      try {
        const input = { userId, usageLogId: usage.id, requestTokens: 10000, responseTokens: 1000, modelTier: 'speed' as const, multiplierBps: 11000 }
        const charges = await Promise.all([consumeTokenCredits(input), consumeTokenCredits(input)])
        expect(charges.map(item => item.chargedMilli)).toEqual([1100, 1100])
        expect(await prisma.creditLedgerEntry.count({ where: { userId, sourceType: 'model_tokens' } })).toBe(1)
        const ledger = await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId, sourceType: 'model_tokens' } })
        expect(ledger.metadata).toMatchObject({ v1CeilingBps: 11000, rateCardId: 'fixture-quarter' })
        await refundCreditCharge(userId, `usage:${usage.id}`, 'fixture-refund')
        expect(await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId, kind: 'refund' } }))
          .toMatchObject({ deltaMilli: 1100, metadata: { v1CeilingBps: 11000 } })
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })
  it('settles default-path V2 from an immutable pre-dispatch price without double multiplying, and defers unknown usage', async () => {
    await fixture(async userId => {
      const price = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 50000,
        rateCardId: 'fixture-frozen', rates: { inputNano: 100000, cacheNano: 50000, outputNano: 1000000 } }
      const usage = await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture',
        modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', multiplierBps: 10000,
        requestTokens: 1000, responseTokens: 100, durationMs: 1, billingSnapshot: price, usageSource: 'estimated' } })
      try {
        const input = { userId, usageLogId: usage.id, requestTokens: 1000, responseTokens: 100, modelTier: 'speed' as const, multiplierBps: 10000 }
        expect(await consumeTokenCredits(input)).toMatchObject({ chargedMilli: 0, pendingUsage: true })
        expect(await prisma.creditLedgerEntry.count({ where: { userId, sourceType: 'model_tokens' } })).toBe(0)
        await expect(prisma.aiUsageLog.update({ where: { id: usage.id }, data: { billingSnapshot: { ...price, rateCardId: 'changed' } } })).rejects.toThrow()
        await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { usageSource: 'reported', promptCacheHitTokens: 200, promptCacheMissTokens: 800 } })
        expect(await consumeTokenCredits(input)).toMatchObject({ chargedMilli: 190 })
        expect(await consumeTokenCredits(input)).toMatchObject({ chargedMilli: 190 })
        expect(await prisma.creditLedgerEntry.count({ where: { userId, sourceType: 'model_tokens' } })).toBe(1)
        const ledger = await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId, sourceType: 'model_tokens' } })
        expect(ledger.metadata).toMatchObject({ pricingVersion: price.version, rateCardId: price.rateCardId, rates: price.rates })
        expect((await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).creditChargeMilli).toBe(190)
        await refundCreditCharge(userId, `usage:${usage.id}`, 'fixture-refund')
        const refund = await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId, kind: 'refund' } })
        expect(refund).toMatchObject({ deltaMilli: 190, requestTokens: 1000, responseTokens: 100 })
        expect(refund.metadata).toMatchObject({ pricingVersion: price.version, rateCardId: price.rateCardId, rates: price.rates, originalEntryId: ledger.id })
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })
  it('settles reported totals with unknown cache once at the approved discount, preserving null evidence', async () => {
    await fixture(async userId => {
      const usage = await prisma.aiUsageLog.create({ data: { userId, providerType: 'text', providerMode: 'fixture',
        modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', multiplierBps: 10000,
        requestTokens: 1000, responseTokens: 100, durationMs: 1, usageSource: 'reported', billingStatus: 'pending_usage',
        billingSnapshot: { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
          rateCardId: 'fixture-discount', rates: { inputNano: 100000, cacheNano: 25000, outputNano: 1000000 } } } })
      try {
        const input = { userId, usageLogId: usage.id, requestTokens: 1000, responseTokens: 100, modelTier: 'speed' as const, multiplierBps: 10000 }
        expect(await consumeTokenCredits(input)).toMatchObject({ chargedMilli: 125 })
        expect(await consumeTokenCredits(input)).toMatchObject({ chargedMilli: 125 })
        expect(await prisma.creditLedgerEntry.count({ where: { userId, sourceType: 'model_tokens' } })).toBe(1)
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toMatchObject({ promptCacheHitTokens: null, billingStatus: 'settled', creditChargeMilli: 125 })
        expect((await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId, sourceType: 'model_tokens' } })).metadata)
          .toMatchObject({ cacheHitTokens: null, cachePricingPolicy: 'unknown-cache-discount-2026-09-09', platformAbsorbsDifference: true })
        await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { promptCacheHitTokens: 0, promptCacheMissTokens: 1000 } })
        expect(await consumeTokenCredits(input)).toMatchObject({ chargedMilli: 125 })
        expect(await prisma.creditLedgerEntry.count({ where: { userId, sourceType: 'model_tokens' } })).toBe(1)
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })
  it('keeps database defaults and application timestamps in UTC even on a non-UTC database host', async () => {
    const [clock] = await prisma.$queryRaw<Array<{ zone: string; delta: number }>>`
      SELECT current_setting('TimeZone') AS zone,
        abs(extract(epoch FROM (CURRENT_TIMESTAMP::timestamp - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))::float8 AS delta`
    expect(clock).toEqual({ zone: 'UTC', delta: 0 })
  })
  it('replays one admin reset without clearing newly incurred charges', async () => {
    await fixture(async (userId, input) => {
      const requestKey = randomUUID()
      try {
        await consumeCredits(input)
        const results = await Promise.all([
          resetAdminUsersCredits([userId], userId, requestKey),
          resetAdminUsersCredits([userId], userId, requestKey),
        ])
        expect(results.every(result => result.users === 1)).toBe(true)
        expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'admin_reset' } })).toBe(1)
        await consumeCredits({ ...input, idempotencyKey: randomUUID() })
        expect(await resetAdminUsersCredits([userId], userId, requestKey)).toEqual({ users: 1, stoppedRuns: 0 })
        expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(2000)
        expect(await prisma.adminAuditLog.count({ where: { adminId: userId, action: 'credits.reset_receipt' } })).toBe(1)
        const novel = await prisma.novel.create({ data: { authorId: userId, title: '重置后新任务', slug: randomUUID(), summary: '' } })
        const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '新任务' } })
        const laterRun = await prisma.agentRun.create({ data: { userId, novelId: novel.id, sessionId: session.id,
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'queued' } })
        try {
          // Simulate losing the post-reset completion marker. The persisted
          // original stop set is empty; a retry must not enumerate new runs.
          await prisma.adminAuditLog.deleteMany({ where: { adminId: userId, action: 'credits.reset_stop_receipt' } })
          expect(await resetAdminUsersCredits([userId], userId, requestKey)).toEqual({ users: 1, stoppedRuns: 0 })
          expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: laterRun.id } })).status).toBe('queued')
          expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(2000)
        } finally {
          await prisma.agentRun.delete({ where: { id: laterRun.id } })
          await prisma.agentSession.delete({ where: { id: session.id } })
          await prisma.novel.delete({ where: { id: novel.id } })
        }
        await resetAdminUsersCredits([userId], userId, randomUUID())
        expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
      } finally { await prisma.adminAuditLog.deleteMany({ where: { adminId: userId, action: { in: ['credits.reset_receipt', 'credits.reset_stop_receipt'] } } }) }
    })
  }, 15_000)
  it.each(['rejected', 'empty', 'unknown'] as const)('persists and reconciles an image %s refund without losing its cost uncertainty', async outcome => {
    await fixture(async (userId, input) => {
      const charge = { ...input, amountMilli: 6000, sourceType: 'image_generation' }
      await consumeCredits(charge)
      await recordImageRefundIntent(userId, charge.idempotencyKey, { outcome, deliveredImages: 0 })
      await recordImageRefundIntent(userId, charge.idempotencyKey, { outcome, deliveredImages: 0 })
      await Promise.all([reconcileCreditRefunds({ userId }), reconcileCreditRefunds({ userId })])
      const intent = await prisma.creditRefundIntent.findFirstOrThrow({ where: { originalEntry: { userId } } })
      expect(intent.evidence).toEqual({ outcome, deliveredImages: 0 })
      expect(intent.settledAt).not.toBeNull()
      expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund' } })).toBe(1)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
      await expect(recordImageRefundIntent(randomUUID(), charge.idempotencyKey, { outcome, deliveredImages: 0 })).rejects.toMatchObject({ code: 'CREDIT_REFUND_IDENTITY_INVALID' })
    })
  })
  it('isolates task costs while merging continuation runs and paginating equal-time ledger entries', async () => {
    await fixture(async (userId, input) => {
      const novel = await prisma.novel.create({ data: { authorId: userId, title: '费用测试', slug: randomUUID(), summary: '' } })
      const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '任务费用' } })
      const runId = randomUUID(), resumedId = randomUUID(), otherId = randomUUID()
      const spec = buildTaskSpec({ runId, novelId: novel.id, prompt: '分析指定资料' })
      const base = { userId, novelId: novel.id, sessionId: session.id, mode: 'act' as const,
        action: 'workspaceAgent' as const, agentType: 'writingOrchestrator' as const, engine: 'loop' }
      for (const id of [runId, resumedId, otherId]) {
        const task = id === otherId ? buildTaskSpec({ runId: id, novelId: novel.id, prompt: '其他任务' }) : { ...spec, runId: id }
        await prisma.agentRun.create({ data: { ...base, id, taskSpec: JSON.parse(JSON.stringify(task)) } })
      }
      const firstCharge = { ...input, referenceId: runId }
      await consumeCredits(firstCharge)
      await consumeCredits({ ...input, idempotencyKey: randomUUID(), referenceId: resumedId })
      await consumeCredits({ ...input, idempotencyKey: randomUUID(), referenceId: otherId })
      const sameTime = new Date(Date.now() - 1000)
      await prisma.creditLedgerEntry.updateMany({ where: { userId }, data: { createdAt: sameTime } })
      await recordSearchRefundIntent(userId, firstCharge.idempotencyKey, { attempts: [{ provider: 'bing', outcome: 'failed', durationMs: 5 }] })
      const first = await getTaskCreditUsage(userId, resumedId, { take: 1 })
      expect(first).toMatchObject({ charged: 4, refunded: 0, netCharged: 4, pendingRefund: 2, unresolvedProviderAttempts: null })
      expect(first.ledger).toHaveLength(1)
      expect(first.nextCursor).not.toBeNull()
      // New entries after the first-page cutoff cannot shift subsequent pages.
      await reconcileCreditRefunds({ userId })
      const second = await getTaskCreditUsage(userId, resumedId, { take: 1, cursor: first.nextCursor! })
      expect(second).toMatchObject({ charged: 4, refunded: 0, pendingRefund: 2, asOf: first.asOf, nextCursor: null })
      expect(second.ledger).toHaveLength(1)
      expect(second.ledger[0].id).not.toBe(first.ledger[0].id)
      expect(await getTaskCreditUsage(userId, runId)).toMatchObject({ charged: 4, refunded: 2, netCharged: 2, pendingRefund: 0 })
      expect(await getTaskCreditUsage(userId, otherId)).toMatchObject({ charged: 2, refunded: 0 })
      // Legacy model calls often reference a chapter, not the run. Their usage
      // identity is authoritative; another task in this session stays excluded.
      const usageIds: string[] = []
      try {
        for (const agentRunId of [resumedId, otherId]) {
          const usage = await prisma.aiUsageLog.create({ data: { userId, agentRunId, targetType: 'chapter', targetId: 'shared-chapter',
            providerType: 'text', providerMode: 'test', modelName: 'fixture', action: 'test', requestTokens: 10000,
            responseTokens: 0, modelTier: 'speed', multiplierBps: 10000, durationMs: 1 } })
          usageIds.push(usage.id)
          await consumeTokenCredits({ userId, usageLogId: usage.id, requestTokens: 10000, responseTokens: 0,
            modelTier: 'speed', referenceId: 'shared-chapter' })
        }
        expect(await getTaskCreditUsage(userId, runId)).toMatchObject({ charged: 5, refunded: 2, netCharged: 3 })
        expect(await getTaskCreditUsage(userId, otherId)).toMatchObject({ charged: 3, refunded: 0 })
        await refundCreditCharge(userId, `usage:${usageIds[0]}`, 'test provider failure')
        // The pagination assertions above have already checked the frozen cutoff.
        // This final assertion tests task attribution, not DB/JS clock alignment;
        // make only this fixture's new refund visible to the fresh snapshot.
        await prisma.creditLedgerEntry.update({
          where: { idempotencyKey: `refund:usage:${usageIds[0]}`, userId, kind: 'refund' },
          data: { createdAt: sameTime },
        })
        expect(await getTaskCreditUsage(userId, resumedId)).toMatchObject({ charged: 5, refunded: 3, netCharged: 2 })
      } finally { await prisma.aiUsageLog.deleteMany({ where: { id: { in: usageIds }, userId } }) }
      await expect(getTaskCreditUsage(randomUUID(), runId)).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_FOUND' })
      await expect(getTaskCreditUsage(userId, otherId, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'CREDIT_CURSOR_INVALID' })
      await expect(getTaskCreditUsage(userId, runId, { cursor: 'not-json' })).rejects.toMatchObject({ code: 'CREDIT_CURSOR_INVALID' })
      await expect(getTaskCreditUsage(userId, runId, { take: 101 })).rejects.toMatchObject({ code: 'CREDIT_PAGE_INVALID' })
    })
  })
  it('resumes a persisted search refund and commits its marker with exactly one wallet credit', async () => {
    await fixture(async (userId, input) => {
      await consumeCredits(input)
      const evidence = { attempts: [{ provider: 'bocha', outcome: 'failed', durationMs: 10, httpStatus: 200, providerCode: '401', providerRequestId: 'provider-log-19' }] }
      await recordSearchRefundIntent(userId, input.idempotencyKey, evidence)
      await recordSearchRefundIntent(userId, input.idempotencyKey, evidence)
      expect(await getSearchRefundState(userId, input.idempotencyKey)).toBe('pending')
      expect((await prisma.creditRefundIntent.findFirstOrThrow({ where: { originalEntry: { userId } } })).evidence).toEqual(evidence)
      expect(await getSearchRefundState(randomUUID(), input.idempotencyKey)).toBeNull()
      await Promise.all([reconcileCreditRefunds({ userId }), reconcileCreditRefunds({ userId })])
      expect(await getSearchRefundState(userId, input.idempotencyKey)).toBe('settled')
      expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund' } })).toBe(1)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
      expect(await reconcileCreditRefunds({ userId })).toEqual({ examined: 0, settled: 0 })
      await expect(recordSearchRefundIntent(randomUUID(), input.idempotencyKey, evidence)).rejects.toMatchObject({ code: 'CREDIT_REFUND_IDENTITY_INVALID' })
      await expect(recordSearchRefundIntent(userId, input.idempotencyKey, { attempts: [{ provider: 'bocha', outcome: 'empty', durationMs: 10 }] })).rejects.toMatchObject({ code: 'CREDIT_REFUND_EVIDENCE_INVALID' })
    })
  })
  it('retains invalid refund evidence for reconciliation rather than crediting money or spinning', async () => {
    await fixture(async (userId, input) => {
      await consumeCredits(input)
      const intent = await recordSearchRefundIntent(userId, input.idempotencyKey, { attempts: [{ provider: 'bing', outcome: 'failed', durationMs: 20 }] })
      // Invalid-evidence handling is the subject, not DB/JS clock alignment.
      // Explicitly make this exact fixture intent due before invoking the scan.
      await prisma.creditRefundIntent.update({
        where: { originalEntryId: intent.originalEntryId, originalEntry: { userId } },
        data: { evidence: {}, nextAttemptAt: new Date(Date.now() - 60_000) },
      })
      expect(await reconcileCreditRefunds({ userId })).toEqual({ examined: 1, settled: 0 })
      const retained = await prisma.creditRefundIntent.findUniqueOrThrow({ where: { originalEntryId: intent.originalEntryId } })
      expect(retained.settledAt).toBeNull()
      expect(retained.attempts).toBe(1)
      expect(retained.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
      expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund' } })).toBe(0)
      expect(await reconcileCreditRefunds({ userId })).toEqual({ examined: 0, settled: 0 })
    })
  })
  it('CR03 commits wallet, ledger and usage display together and retries a rolled-back debit once', async () => {
    await fixture(async userId => {
      const usage = await prisma.aiUsageLog.create({ data: { userId, targetType: 'test', providerType: 'text', providerMode: 'test', modelName: 'fixture', action: 'test',
        requestTokens: 10000, responseTokens: 0, modelTier: 'speed', multiplierBps: 10000, durationMs: 1 } })
      try {
        const input = { userId, usageLogId: usage.id, requestTokens: 10000, responseTokens: 0, modelTier: 'speed' as const }
        await expect(prisma.$transaction(async tx => {
          await consumeTokenCredits(input, tx)
          expect((await tx.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).creditChargeMilli).toBe(1000)
          throw new Error('fixture interruption before commit')
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toThrow('fixture interruption before commit')
        expect((await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).creditChargeMilli).toBe(0)
        expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
        expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
        await expect(consumeTokenCredits({ ...input, requestTokens: 20000 })).rejects.toMatchObject({ code: 'CREDIT_USAGE_MISMATCH' })
        const first = await consumeTokenCredits(input)
        expect(await consumeTokenCredits(input)).toEqual(first)
        expect((await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).creditChargeMilli).toBe(1000)
        expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(1000)
        expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(1)
      } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
    })
  })

  it('rolls wallet and ledger back when the enclosing receipt transaction fails after the debit', async () => {
    await fixture(async (userId, input) => {
      await expect(prisma.$transaction(async tx => {
        expect(await consumeCreditsInTransaction(tx, input)).toMatchObject({ chargedMilli: 2000 })
        expect(await tx.creditLedgerEntry.count({ where: { userId } })).toBe(1)
        throw new Error('fixture receipt persistence failed')
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toThrow('fixture receipt persistence failed')
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
      expect(await consumeCredits(input)).toMatchObject({ chargedMilli: 2000, remainingMilli: 8000 })
    })
  })
  it('replays the same charge once, including metadata with reordered keys', async () => {
    await fixture(async (userId, input) => {
      input.metadata = { query: 'test query', options: { a: 1, b: 2 } }
      const first = await consumeCredits(input)
      const second = await consumeCredits({ ...input, metadata: { options: { b: 2, a: 1 }, query: 'test query' } })
      expect(second).toEqual(first)
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(1)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(2000)
    })
  })

  it.each([
    { label: 'amount', change: { amountMilli: 3000 } },
    { label: 'reference', change: { referenceId: 'other-run' } },
    { label: 'source', change: { sourceType: 'image_generation' } },
    { label: 'metadata', change: { metadata: { query: 'different query' } } },
    { label: 'partial policy', change: { allowPartialOnExhaustion: true } },
    { label: 'multiplier', change: { multiplierBps: 18000 } },
  ])('rejects a reused key with different $label', async ({ change }) => {
    await fixture(async (userId, input) => {
      await consumeCredits(input)
      await expect(consumeCredits({ ...input, ...change })).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(1)
    })
  })

  it('does not return another user’s charge or refund result for a collided key', async () => {
    await fixture(async (firstId, input) => {
      await consumeCredits(input)
      await fixture(async secondId => {
        await expect(refundCreditCharge(secondId, input.idempotencyKey, 'test')).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
      })
      await refundCreditCharge(firstId, input.idempotencyKey, 'test')
      await fixture(async secondId => {
        await expect(consumeCredits({ ...input, userId: secondId })).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
        await expect(refundCreditCharge(secondId, input.idempotencyKey, 'test')).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
        expect(await prisma.creditLedgerEntry.count({ where: { userId: secondId } })).toBe(0)
      })
    })
  })

  it.each([-1, NaN, Infinity, 0.5, 2147483648])('rejects illegal milli amount %s before touching the wallet', async amountMilli => {
    await fixture(async (userId, input) => {
      await expect(consumeCredits({ ...input, amountMilli })).rejects.toMatchObject({ code: 'CREDIT_INPUT_INVALID' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
    })
  })

  it('persists a free charge identity without treating an empty wallet as exhausted', async () => {
    await fixture(async (userId, input) => {
      expect(await consumeCredits({ ...input, amountMilli: 0 })).toEqual({ chargedMilli: 0, remainingMilli: 0, exhausted: false })
      await expect(consumeCredits(input)).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(1)
    }, 0)
  })

  it('retains exact-exhaustion and partial-charge facts for the next-admission boundary', async () => {
    await fixture(async (_userId, input) => {
      expect(await consumeCredits({ ...input, amountMilli: 1000, allowPartialOnExhaustion: true })).toEqual({ chargedMilli: 1000, remainingMilli: 0, exhausted: true })
    }, 1000)
    await fixture(async (_userId, input) => {
      const request = { ...input, amountMilli: 2000, allowPartialOnExhaustion: true }
      expect(await consumeCredits(request)).toEqual({ chargedMilli: 1000, remainingMilli: 0, exhausted: true })
      expect(await consumeCredits(request)).toEqual({ chargedMilli: 1000, remainingMilli: 0, exhausted: true })
    }, 1000)
  })

  it('serializes duplicate charges and duplicate full refunds', async () => {
    await fixture(async (userId, input) => {
      const charges = await Promise.all([consumeCredits(input), consumeCredits(input)])
      expect(charges.map(charge => charge.chargedMilli)).toEqual([2000, 2000])
      await Promise.all([refundCreditCharge(userId, input.idempotencyKey, 'test'), refundCreditCharge(userId, input.idempotencyKey, 'test')])
      const entries = await prisma.creditLedgerEntry.findMany({ where: { userId } })
      expect(entries).toHaveLength(2)
      expect(entries.reduce((sum, row) => sum + row.deltaMilli, 0)).toBe(0)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
    })
  })

  it('preserves verifiable old fixed-price and partial token ledger replays without rewriting history', async () => {
    await fixture(async (userId, input) => {
      const fixed = await consumeCredits(input)
      await prisma.creditLedgerEntry.update({ where: { idempotencyKey: input.idempotencyKey }, data: { metadata: input.metadata } })
      expect(await consumeCredits(input)).toEqual(fixed)
      const tokenInput = { ...input, idempotencyKey: `test-token:${randomUUID()}`, sourceType: 'model_tokens', amountMilli: 20000, requestTokens: 200000, responseTokens: 100, metadata: undefined, allowPartialOnExhaustion: true }
      const partial = await consumeCredits(tokenInput)
      await prisma.creditLedgerEntry.update({ where: { idempotencyKey: tokenInput.idempotencyKey }, data: { metadata: Prisma.JsonNull } })
      expect(await consumeCredits(tokenInput)).toEqual(partial)
      await expect(consumeCredits({ ...tokenInput, amountMilli: 21000 })).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(2)
      expect((await prisma.creditLedgerEntry.findUniqueOrThrow({ where: { idempotencyKey: tokenInput.idempotencyKey } })).metadata).toBeNull()
    })
  })

  it('refuses a malformed new receipt instead of treating it as a legacy charge', async () => {
    await fixture(async (_userId, input) => {
      await consumeCredits(input)
      await prisma.creditLedgerEntry.update({ where: { idempotencyKey: input.idempotencyKey }, data: { metadata: { __creditRequest: { version: 99, fingerprint: 'invalid' } } } })
      await expect(consumeCredits(input)).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
    })
  })

  it('blocks new free consumption during account suspension but still permits refunds', async () => {
    await fixture(async (userId, input) => {
      await consumeCredits(input)
      await prisma.creditAccount.update({ where: { userId }, data: { suspendedAt: new Date() } })
      await expect(consumeCredits({ ...input, idempotencyKey: `test-free:${randomUUID()}`, amountMilli: 0 })).rejects.toMatchObject({ status: 423 })
      await refundCreditCharge(userId, input.idempotencyKey, 'test')
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).dailyUsedMilli).toBe(0)
    })
  })

  it('restores a crossed-window debit to bonus without negative daily usage', async () => {
    await fixture(async (userId, input) => {
      await consumeCredits(input)
      await prisma.creditLedgerEntry.update({ where: { idempotencyKey: input.idempotencyKey }, data: { createdAt: new Date(Date.now() - 2 * 86400000) } })
      await prisma.creditAccount.update({ where: { userId }, data: { dailyUsedMilli: 0 } })
      await refundCreditCharge(userId, input.idempotencyKey, 'test')
      await refundCreditCharge(userId, input.idempotencyKey, 'retry')
      expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).toMatchObject({ dailyUsedMilli: 0, bonusBalanceMilli: 2000 })
    })
  })

  it('rolls back a refund that would overflow the bonus column', async () => {
    await fixture(async (userId, input) => {
      await consumeCredits(input)
      await prisma.creditLedgerEntry.update({ where: { idempotencyKey: input.idempotencyKey }, data: { createdAt: new Date(Date.now() - 2 * 86400000) } })
      await prisma.creditAccount.update({ where: { userId }, data: { dailyUsedMilli: 0, bonusBalanceMilli: 2147483647 } })
      await expect(refundCreditCharge(userId, input.idempotencyKey, 'test')).rejects.toMatchObject({ code: 'CREDIT_INPUT_INVALID' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId, kind: 'refund' } })).toBe(0)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).bonusBalanceMilli).toBe(2147483647)
    })
  })
})
