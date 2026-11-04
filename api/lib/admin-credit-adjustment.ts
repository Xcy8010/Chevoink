import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { MAX_CREDIT_MILLI, type AdminCreditAdjustmentInput, type AdminCreditAdjustmentResult } from '../../shared/contracts/admin-credit-adjustment.js'
import { creditTransaction, lockCreditPolicy } from './credit-policy.js'
import { buildNewCreditAccountData, getCreditWindow } from './credits.js'
import { DataAccessError } from './prisma.js'

/** Reward adjustment shares invitation rewards' balance, never the daily counter. */
export async function adjustAdminBonusCredits(adminId: string, userId: string, input: AdminCreditAdjustmentInput, ip: string | null = null): Promise<AdminCreditAdjustmentResult> {
  const id = createHash('sha256').update(JSON.stringify(['credit-adjustment', adminId, input.requestKey])).digest('hex')
  const requestHash = createHash('sha256').update(JSON.stringify([userId, input.mode, input.amountMilli, input.expectedBonusBalanceMilli, input.reason])).digest('hex')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await creditTransaction(async tx => {
        const actor = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, isSuperAdmin: true, bannedAt: true } })
        if (!actor || actor.role !== 'admin' || !actor.isSuperAdmin || actor.bannedAt) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '该操作仅限超级管理员。')
        const receipt = await tx.adminAuditLog.findUnique({ where: { id } })
        if (receipt) {
          const detail = receipt.detail as Prisma.JsonObject
          if (receipt.adminId !== adminId || receipt.action !== 'credits.adjust_bonus' || receipt.targetId !== userId || detail.requestHash !== requestHash) {
            throw new DataAccessError(409, 'CREDIT_ADJUSTMENT_IDENTITY_CONFLICT', '同一请求的目标或调整内容已改变。')
          }
          return { userId, mode: input.mode, amountMilli: input.amountMilli, requestKey: input.requestKey,
            previousBonusBalanceMilli: Number(detail.previousBonusBalanceMilli), bonusBalanceMilli: Number(detail.bonusBalanceMilli), deltaMilli: Number(detail.deltaMilli) }
        }
        const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true } })
        if (!target) throw new DataAccessError(404, 'NOT_FOUND', '用户不存在。')
        const setting = await lockCreditPolicy(tx)
        const now = new Date()
        const account = await tx.creditAccount.upsert({ where: { userId }, update: {}, create: buildNewCreditAccountData(userId, setting, getCreditWindow(now, setting.resetHourUtc8), now) })
        if (account.bonusBalanceMilli !== input.expectedBonusBalanceMilli) throw new DataAccessError(409, 'CREDIT_BALANCE_CONFLICT', '奖励余额已变化，请刷新后重新确认。')
        const balance = input.mode === 'set' ? input.amountMilli : account.bonusBalanceMilli + (input.mode === 'add' ? input.amountMilli : -input.amountMilli)
        if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_CREDIT_MILLI) throw new DataAccessError(400, 'CREDIT_BALANCE_OUT_OF_RANGE', '调整后奖励余额超出允许范围。')
        const deltaMilli = balance - account.bonusBalanceMilli
        if (deltaMilli < 0) {
          const held = await tx.aiUsageLog.aggregate({ where: { userId, reservedCreditMilli: { gt: 0 }, reservationExpiresAt: { gt: now } }, _sum: { reservedCreditMilli: true } })
          const dailyRemaining = setting.publicBetaEnabled && account.periodEndsAt <= now ? setting.dailyAllowanceMilli : Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli)
          if (dailyRemaining + balance < (held._sum.reservedCreditMilli ?? 0)) throw new DataAccessError(409, 'CREDIT_BALANCE_RESERVED', '额度已被进行中的调用预留，请稍后再调整。')
        }
        await tx.creditAccount.update({ where: { userId }, data: { bonusBalanceMilli: balance } })
        const result: AdminCreditAdjustmentResult = { userId, mode: input.mode, amountMilli: input.amountMilli, previousBonusBalanceMilli: account.bonusBalanceMilli, bonusBalanceMilli: balance, deltaMilli, requestKey: input.requestKey }
        await tx.creditLedgerEntry.create({ data: { id: randomUUID(), userId, deltaMilli, bonusDeltaMilli: deltaMilli, dailyDeltaMilli: 0,
          kind: 'admin_adjustment', sourceType: 'admin_bonus_adjustment', referenceId: adminId, idempotencyKey: `admin-bonus:${id}`, metadata: { mode: input.mode, reason: input.reason, requestKey: input.requestKey } } })
        await tx.adminAuditLog.create({ data: { id, adminId, action: 'credits.adjust_bonus', targetType: 'user', targetId: userId, ip,
          detail: { ...result, expectedBonusBalanceMilli: input.expectedBonusBalanceMilli, reason: input.reason, requestHash } } })
        return result
      })
    } catch (error) {
      // Concurrent copies may race on the unique durable receipt. Re-read it;
      // all losing transaction effects have rolled back before this retry.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < 2) continue
      throw error
    }
  }
  throw new DataAccessError(409, 'CREDIT_CONCURRENCY_CONFLICT', '额度更新冲突，请重试。')
}
