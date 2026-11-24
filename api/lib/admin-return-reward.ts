import { env } from '../config/env.js'
import { ADMIN_RETURN_EMAIL_PURPOSE, ADMIN_RETURN_TEMPLATE_ID, adminEmailCampaignSchema } from '../../shared/contracts/admin-email.js'
import { MAX_CREDIT_MILLI } from '../../shared/contracts/admin-credit-adjustment.js'
import { returnRewardTokenFormat } from '../../shared/return-reward.js'
import { notifyBonusCreditChange } from './admin-credit-adjustment.js'
import { campaignDeadline, type AdminEmailTemplateSnapshot } from './admin-email-template.js'
import { rewardAttemptId } from './admin-return-reward-link.js'
import { creditTransaction, lockCreditPolicy } from './credit-policy.js'
import { buildNewCreditAccountData, getCreditWindow } from './credits.js'
import { DataAccessError } from './prisma.js'

const unavailable = () => new DataAccessError(404, 'RETURN_REWARD_UNAVAILABLE', '这封活动邮件的领取链接不适用于当前账号。')

export async function claimAdminReturnReward(userId: string, token: unknown) {
  const mode = env.appEnv === 'production' || env.adminEmailTencentEnabled ? 'tencent' : env.adminEmailMockEnabled ? 'mock' : null
  if (!mode || typeof token !== 'string' || !returnRewardTokenFormat.test(token)) throw unavailable()
  return creditTransaction(async tx => {
    const recipient = await tx.adminEmailRecipient.findFirst({
      where: { attemptId: rewardAttemptId(token), userId, state: { in: ['accepted', 'deferred', 'delivered'] },
        batch: { mode, purpose: ADMIN_RETURN_EMAIL_PURPOSE, confirmedAt: { not: null } } },
      select: { userId: true, state: true, attemptedAt: true, batch: { select: { id: true, template: true } } },
    })
    const template = recipient?.batch.template as AdminEmailTemplateSnapshot | undefined
    const campaign = adminEmailCampaignSchema.safeParse(template?.campaign)
    if (!recipient?.attemptedAt || recipient.userId.startsWith('mock-address:') || template?.id !== ADMIN_RETURN_TEMPLATE_ID || !campaign.success) throw unavailable()
    const { workspacePath, maxCredits } = campaign.data
    const now = new Date()
    const paid = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `creator-return:${userId}` }, select: { deltaMilli: true } })
    if (paid) {
      const wallet = await tx.creditAccount.findUniqueOrThrow({ where: { userId }, select: { bonusBalanceMilli: true } })
      return { ...wallet, workspacePath, amountMilli: paid.deltaMilli, alreadyClaimed: true }
    }
    if (now < recipient.attemptedAt) throw unavailable()
    if (now >= campaignDeadline(campaign.data, recipient.attemptedAt)) {
      throw new DataAccessError(410, 'RETURN_REWARD_EXPIRED', '这封邮件的奖励已过领取期限。')
    }
    if (recipient.state !== 'delivered') {
      throw new DataAccessError(409, 'RETURN_REWARD_RECEIPT_PENDING', '邮件投递回执正在同步，请稍后再试一次。')
    }
    const policy = await lockCreditPolicy(tx)
    await tx.creditAccount.upsert({ where: { userId }, update: {}, create: buildNewCreditAccountData(userId, policy, getCreditWindow(now, policy.resetHourUtc8), now) })
    const amountMilli = maxCredits * 1000
    const changed = await tx.creditAccount.updateMany({ where: { userId, bonusBalanceMilli: { lte: MAX_CREDIT_MILLI - amountMilli } },
      data: { bonusBalanceMilli: { increment: amountMilli } } })
    if (!changed.count) throw new DataAccessError(409, 'CREDIT_BALANCE_OUT_OF_RANGE', '领取后的奖励余额超出允许范围。')
    const { bonusBalanceMilli } = await tx.creditAccount.findUniqueOrThrow({ where: { userId }, select: { bonusBalanceMilli: true } })
    await tx.creditLedgerEntry.create({ data: { userId, kind: 'reward', sourceType: 'creator_return', referenceId: recipient.batch.id,
      idempotencyKey: `creator-return:${userId}`, deltaMilli: amountMilli, dailyDeltaMilli: 0, bonusDeltaMilli: amountMilli,
      metadata: { batchId: recipient.batch.id, claim: 'email_link' } } })
    await notifyBonusCreditChange(tx, userId, amountMilli, bonusBalanceMilli, 'creator_return')
    return { amountMilli, bonusBalanceMilli, workspacePath, alreadyClaimed: false }
  })
}
