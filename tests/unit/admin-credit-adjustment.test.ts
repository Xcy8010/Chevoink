import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { adminCreditAdjustmentSchema, MAX_CREDIT_MILLI } from '../../shared/contracts/admin-credit-adjustment.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const mocks = vi.hoisted(() => ({
  user: { findUnique: vi.fn() }, creditAccount: { upsert: vi.fn(), update: vi.fn() },
  adminAuditLog: { findUnique: vi.fn(), create: vi.fn() }, creditLedgerEntry: { create: vi.fn() }, aiUsageLog: { aggregate: vi.fn() },
}))
vi.mock('../../api/lib/credit-policy.js', () => ({
  creditTransaction: (work: (tx: typeof mocks) => unknown) => work(mocks),
  lockCreditPolicy: vi.fn(async () => ({ publicBetaEnabled: true, dailyAllowanceMilli: 450000, resetHourUtc8: 15, globallyPaused: false })),
}))
import { adjustAdminBonusCredits } from '../../api/lib/admin-credit-adjustment.js'
const input = () => ({ mode: 'add' as const, amountMilli: 1250, expectedBonusBalanceMilli: 5000, requestKey: randomUUID(), reason: '客服补偿' })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === 'admin' ? { role: 'admin', isSuperAdmin: true, bannedAt: null } : { id: where.id })
  mocks.adminAuditLog.findUnique.mockResolvedValue(null)
  mocks.creditAccount.upsert.mockResolvedValue({ userId: 'user', bonusBalanceMilli: 5000, dailyAllowanceMilli: 450000, dailyUsedMilli: 450000, periodEndsAt: new Date(Date.now() + 86400000) })
  mocks.aiUsageLog.aggregate.mockResolvedValue({ _sum: { reservedCreditMilli: 0 } })
})
it('credits the invitation reward bucket with an atomic matching ledger and durable audit', async () => {
  const payload = input()
  expect(await adjustAdminBonusCredits('admin', 'user', payload)).toMatchObject({ previousBonusBalanceMilli: 5000, bonusBalanceMilli: 6250, deltaMilli: 1250 })
  expect(mocks.creditAccount.update).toHaveBeenCalledWith({ where: { userId: 'user' }, data: { bonusBalanceMilli: 6250 } })
  expect(mocks.creditLedgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ deltaMilli: 1250, bonusDeltaMilli: 1250, dailyDeltaMilli: 0, kind: 'admin_adjustment', sourceType: 'admin_bonus_adjustment' }) })
  expect(mocks.adminAuditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ adminId: 'admin', action: 'credits.adjust_bonus', detail: expect.objectContaining({ reason: '客服补偿', ...payload, bonusBalanceMilli: 6250 }) }) })
})
it('sets zero and subtracts only reward balance', async () => {
  expect(await adjustAdminBonusCredits('admin', 'user', { ...input(), mode: 'subtract' })).toMatchObject({ bonusBalanceMilli: 3750, deltaMilli: -1250 })
  expect(await adjustAdminBonusCredits('admin', 'user', { ...input(), mode: 'set', amountMilli: 0 })).toMatchObject({ bonusBalanceMilli: 0, deltaMilli: -5000 })
})
it('does not write on actor denial, stale balance, insufficient reward, overflow or live reservations', async () => {
  mocks.user.findUnique.mockResolvedValueOnce({ role: 'user', isSuperAdmin: false, bannedAt: null })
  await expect(adjustAdminBonusCredits('admin', 'user', input())).rejects.toMatchObject({ status: 403 })
  await expect(adjustAdminBonusCredits('admin', 'user', { ...input(), expectedBonusBalanceMilli: 0 })).rejects.toMatchObject({ code: 'CREDIT_BALANCE_CONFLICT' })
  await expect(adjustAdminBonusCredits('admin', 'user', { ...input(), mode: 'subtract', amountMilli: 6000 })).rejects.toMatchObject({ code: 'CREDIT_BALANCE_OUT_OF_RANGE' })
  await expect(adjustAdminBonusCredits('admin', 'user', { ...input(), amountMilli: MAX_CREDIT_MILLI })).rejects.toMatchObject({ code: 'CREDIT_BALANCE_OUT_OF_RANGE' })
  mocks.aiUsageLog.aggregate.mockResolvedValue({ _sum: { reservedCreditMilli: 4000 } })
  await expect(adjustAdminBonusCredits('admin', 'user', inputWithSubtract())).rejects.toMatchObject({ code: 'CREDIT_BALANCE_RESERVED' })
  expect(mocks.creditAccount.update).not.toHaveBeenCalled()
  expect(mocks.creditLedgerEntry.create).not.toHaveBeenCalled()
  expect(mocks.adminAuditLog.create).not.toHaveBeenCalled()
})
function inputWithSubtract() { return { ...input(), mode: 'subtract' as const } }
it('replays original outcome after balance changed and rejects reuse with different content', async () => {
  const payload = input()
  const result = await adjustAdminBonusCredits('admin', 'user', payload)
  const receipt = mocks.adminAuditLog.create.mock.calls[0][0].data
  vi.clearAllMocks()
  mocks.adminAuditLog.findUnique.mockResolvedValue(receipt)
  expect(await adjustAdminBonusCredits('admin', 'user', payload)).toEqual(result)
  await expect(adjustAdminBonusCredits('admin', 'user', { ...payload, amountMilli: 9 })).rejects.toMatchObject({ code: 'CREDIT_ADJUSTMENT_IDENTITY_CONFLICT' })
  expect(mocks.creditAccount.upsert).not.toHaveBeenCalled()
  expect(mocks.creditAccount.update).not.toHaveBeenCalled()
})
it('propagates ledger failure so the enclosing database transaction rolls back', async () => {
  mocks.creditLedgerEntry.create.mockRejectedValueOnce(new DataAccessError(503, 'FIXTURE', 'fixture failure'))
  await expect(adjustAdminBonusCredits('admin', 'user', input())).rejects.toMatchObject({ code: 'FIXTURE' })
  expect(mocks.adminAuditLog.create).not.toHaveBeenCalled()
})
it('rejects decimals, negatives, unsafe integers, overflow, blank reason and zero deltas before execution', () => {
  for (const patch of [{ amountMilli: -1 }, { amountMilli: 1.1 }, { amountMilli: MAX_CREDIT_MILLI + 1 }, { amountMilli: Number.MAX_SAFE_INTEGER }, { amountMilli: 0 }, { expectedBonusBalanceMilli: -1 }, { reason: ' ' }, { mode: 'bad' }]) {
    expect(adminCreditAdjustmentSchema.safeParse({ ...input(), ...patch }).success).toBe(false)
  }
  expect(adminCreditAdjustmentSchema.parse({ ...input(), mode: 'set', amountMilli: 0, reason: ' 补偿 ' }).reason).toBe('补偿')
})
