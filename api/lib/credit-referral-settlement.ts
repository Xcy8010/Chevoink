import { Prisma } from '@prisma/client'
import { claimCreditPhone } from './credit-phone-identity.js'
import { creditTransaction } from './credit-policy.js'
import { prisma } from './prisma.js'

function readyReferrals(db: Prisma.TransactionClient, limit: number, referralId?: string) {
  return db.$queryRaw<{ id: string }[]>`
    SELECT referral.id
      FROM referral_redemptions referral
      JOIN users invitee ON invitee.id = referral.invitee_user_id
      JOIN users inviter ON inviter.id = referral.inviter_user_id
     WHERE referral.reward_status = 'pending'
       AND invitee.phone IS NOT NULL AND invitee.phone_verified_at IS NOT NULL
       AND invitee.banned_at IS NULL AND inviter.banned_at IS NULL
       ${referralId ? Prisma.sql`AND referral.id = ${referralId}` : Prisma.empty}
       AND EXISTS (
         SELECT 1 FROM agent_runs run
          WHERE run.user_id = invitee.id
            AND run.created_at >= GREATEST(referral.created_at, invitee.phone_verified_at)
            AND run.status = 'completed'
            AND EXISTS (
              SELECT 1 FROM agent_messages message
               CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(message.parts) = 'array' THEN message.parts ELSE '[]'::jsonb END
               ) AS part
               WHERE message.run_id = run.id AND message.role = 'assistant'
                 AND part->>'type' = 'text' AND part->>'text' ~ '[^[:space:]]'
            )
            AND (
              EXISTS (SELECT 1 FROM ai_usage_logs usage
                       WHERE usage.agent_run_id = run.id AND usage.user_id = invitee.id
                         AND usage.provider_type = 'text' AND usage.response_tokens > 0
                         AND usage.billing_status = 'settled')
              OR EXISTS (
                SELECT 1 FROM agent_execution_outbox event
                 JOIN agent_provider_usage_receipts usage ON usage.attempt_id = event.payload->>'attemptId'
                 WHERE event.run_id = run.id AND event.type = 'credit.settled'
                   AND usage.settlement_status = 'settled' AND usage.completion_tokens > 0
              )
            )
       )
     ORDER BY referral.created_at, referral.id
     LIMIT ${limit}
  `
}

/** Settle only completed, verified activity. No effect on the request or its own billing. */
export async function settleReadyReferralRewards() {
  const ready = await readyReferrals(prisma, 50)
  for (const { id } of ready) {
    await creditTransaction(async tx => {
      if (!(await readyReferrals(tx, 1, id)).length) return
      const referral = await tx.referralRedemption.findUniqueOrThrow({
        where: { id },
        include: { invitee: { select: { phone: true } } },
      })
      const phone = referral.invitee.phone
      if (!phone) return
      const eligible = await claimCreditPhone(tx, referral.inviteeUserId, phone)
      const changed = await tx.referralRedemption.updateMany({
        where: { id, rewardStatus: 'pending' },
        data: { rewardStatus: eligible ? 'credited' : 'ineligible' },
      })
      if (!changed.count || !eligible) return

      const rewards = [
        { party: 'inviter', userId: referral.inviterUserId, otherId: referral.inviteeUserId, amount: referral.inviterRewardMilli },
        { party: 'invitee', userId: referral.inviteeUserId, otherId: referral.inviterUserId, amount: referral.inviteeRewardMilli },
      ].sort((a, b) => a.userId.localeCompare(b.userId))
      for (const reward of rewards) {
        await tx.creditAccount.update({
          where: { userId: reward.userId },
          data: { bonusBalanceMilli: { increment: reward.amount } },
        })
        await tx.creditLedgerEntry.create({ data: {
          userId: reward.userId, deltaMilli: reward.amount, bonusDeltaMilli: reward.amount,
          kind: 'reward', sourceType: `referral_${reward.party}`, referenceId: reward.otherId,
          idempotencyKey: `referral:${reward.party}:${referral.inviteeUserId}`,
        } })
      }
    })
  }
}
