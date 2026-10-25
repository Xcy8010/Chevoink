import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), row: vi.fn(), update: vi.fn(), ledger: vi.fn(), account: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { $transaction: mocks.transaction } }))
vi.mock('../../api/lib/credit-policy.js', () => ({ lockCreditPolicy: async () => ({ resetHourUtc8: 0, publicBetaEnabled: false, globallyPaused: false }), creditTransaction: vi.fn() }))
import { reserveTokenCredits } from '../../api/lib/credits.js'
import { FALLBACK_USAGE_POLICY } from '../../api/lib/billing/reservation-policy.js'
const price = { version: 'credits-v1-exact' as const, modelTier: 'standard' as const, multiplierBps: 12000 }
const authority = { price, newCallId: 'new-call', runId: 'run', novelId: 'novel', chapterId: 'chapter' }
const prepared = () => ({ id: 'usage', userId: 'author', billingStatus: 'authorized_pending', usageSource: 'prepared', providerType: 'text',
  action: 'agent3HumanityAuthorReplacement', agentRunId: 'run', novelId: 'novel', chapterId: 'chapter', targetType: 'chapter', targetId: 'new-call',
  modelTier: 'standard', multiplierBps: 12000, durationMs: 0, requestTokens: null, responseTokens: null, creditChargeMilli: 0, reservedCreditMilli: 0,
  billingSnapshot: price, billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 1000, outputEstimate: 0, responseObserved: false } })
beforeEach(() => {
  vi.resetAllMocks(); mocks.row.mockResolvedValue(prepared()); mocks.ledger.mockResolvedValue(null)
  mocks.account.mockResolvedValue({ suspendedAt: null, dailyAllowanceMilli: 50000, dailyUsedMilli: 0, bonusBalanceMilli: 0 })
  const tx = { aiUsageLog: { findFirstOrThrow: mocks.row, update: mocks.update, count: vi.fn(async () => 0),
    aggregate: vi.fn(async () => ({ _sum: { reservedCreditMilli: 18023 } })) }, creditLedgerEntry: { findUnique: mocks.ledger },
    creditAccount: { upsert: vi.fn(), findUniqueOrThrow: mocks.account } }
  mocks.transaction.mockImplementation(async work => work(tx))
})
it('real reserveTokenCredits admits only a scoped authorized pre-dispatch row while retaining other reservations', async () => {
  await reserveTokenCredits('author', 'usage', 1000, 16384, authority)
  expect(mocks.update).toHaveBeenCalledOnce()
  expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: 'usage' } })
  expect(mocks.update.mock.calls[0][0].data.reservedCreditMilli).toBeGreaterThan(0)
  expect(mocks.update.mock.calls[0][0].data.reservedCreditMilli).toBeLessThanOrEqual(31977)
  expect(mocks.ledger).toHaveBeenCalledExactlyOnceWith({ where: { idempotencyKey: 'usage:usage' } })
})
it('does not extend the ordinary reservation entry point to authorization-held rows', async () => {
  await expect(reserveTokenCredits('author', 'usage', 1000, 16384)).rejects.toMatchObject({ code: 'CREDIT_USAGE_MISMATCH' })
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.account).not.toHaveBeenCalled()
})
it.each([
  { billingStatus: 'observed' }, { billingStatus: 'prepared' }, { billingStatus: 'settled' }, { billingStatus: 'pending_authorization' },
  { usageSource: 'unknown' }, { action: 'agent3HumanityCritic' }, { agentRunId: 'foreign' }, { novelId: 'foreign' }, { chapterId: 'foreign' },
  { targetId: 'different-call' }, { modelTier: 'speed' }, { multiplierBps: 10000 }, { durationMs: 1 }, { requestTokens: 0 },
  { responseTokens: 0 }, { creditChargeMilli: 1 }, { billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 1000, outputEstimate: 1, responseObserved: true } },
])('rejects tampered or already observed reservation evidence: %j', async changed => {
  mocks.row.mockResolvedValue({ ...prepared(), ...changed })
  await expect(reserveTokenCredits('author', 'usage', 1000, 16384, authority)).rejects.toMatchObject({ code: 'CREDIT_USAGE_MISMATCH' })
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.account).not.toHaveBeenCalled()
})
it('rejects an existing charge rather than reserving the same request again', async () => {
  mocks.ledger.mockResolvedValue({ id: 'actual-charge' })
  await expect(reserveTokenCredits('author', 'usage', 1000, 16384, authority)).rejects.toMatchObject({ code: 'CREDIT_USAGE_MISMATCH' })
  expect(mocks.update).not.toHaveBeenCalled()
})
it('preserves ordinary prepared reservation behavior', async () => {
  mocks.row.mockResolvedValue({ ...prepared(), billingStatus: 'prepared', action: 'ordinary' })
  await reserveTokenCredits('author', 'usage', 1000, 16384)
  expect(mocks.update).toHaveBeenCalledOnce()
})

it('admits the exact manual continuity operation with immutable itemized rates and original route multiplier metadata', async () => {
  const itemized = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'synthetic-speed-card',
    rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 }, v1CeilingBps: 11000 }
  const manual = { ...authority, price: itemized, manualReviewRepairOperationId: `mrr_${'a'.repeat(56)}` }
  mocks.row.mockResolvedValue({ ...prepared(), action: 'agent3ContinuityCritic', targetType: 'story_compilation', modelTier: 'speed',
    multiplierBps: 15000, billingSnapshot: itemized })
  await reserveTokenCredits('author', 'usage', 1000, 16384, manual)
  expect(mocks.update).toHaveBeenCalledOnce()
  expect(mocks.update.mock.calls[0][0].data.reservedCreditMilli).toBeGreaterThan(0)
})
it.each(['no-marker', 'bad-marker', 'wrong-action', 'wrong-target', 'wrong-tier'] as const)('refuses manual reservation %s', async kind => {
  mocks.row.mockResolvedValue({ ...prepared(), action: kind === 'wrong-action' ? 'ordinary' : 'agent3ContinuityCritic',
    targetType: kind === 'wrong-target' ? 'chapter' : 'story_compilation', modelTier: kind === 'wrong-tier' ? 'speed' : 'standard' })
  const manual = kind === 'no-marker' ? authority : { ...authority, manualReviewRepairOperationId: kind === 'bad-marker' ? 'continue' : `mrr_${'a'.repeat(56)}` }
  await expect(reserveTokenCredits('author', 'usage', 1000, 16384, manual)).rejects.toMatchObject({ code: 'CREDIT_USAGE_MISMATCH' })
  expect(mocks.update).not.toHaveBeenCalled()
})
