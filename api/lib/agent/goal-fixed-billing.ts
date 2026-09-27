import type { CreditLedgerEntry, Prisma } from '@prisma/client'
import { z } from 'zod'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { currentGoalExecution } from './goal-context.js'
import { assertGoalFence } from './goal-fence.js'
import { changeGoal, goalError } from './goal-store.js'
import { databaseNow } from './runtime-common.js'

const bindingSchema = z.object({ goalId: z.string(), runId: z.string() }).strict()
export const isGoalFixedCharge = (sourceType: string) => sourceType === 'image_generation' || sourceType === 'web_search'

/** Fixed fees use their real wallet receipt, independently of provider token
 * observations. The wallet and goal total commit together; no second debit. */
export async function admitGoalFixedCharge(tx: Prisma.TransactionClient, userId: string, sourceType: string) {
  const context = currentGoalExecution()
  if (!context || !isGoalFixedCharge(sourceType)) return undefined
  if (context.userId !== userId) return goalError('GOAL_SCOPE_MISMATCH', '费用与目标归属不一致。')
  await assertGoalFence(tx, context)
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: context.goalId } })
  const budget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
  const now = await databaseNow(tx)
  const elapsed = goal.activeSince ? BigInt(Math.max(0, now.getTime() - goal.activeSince.getTime())) : 0n
  if (budget.tokensUsed >= budget.tokenLimit || budget.activeTimeMs + elapsed >= budget.activeTimeLimitMs) {
    return goalError('GOAL_BUDGET_EXHAUSTED', '目标已达到执行预算，未发起新的收费操作。')
  }
  return { goalId: context.goalId, runId: context.runId }
}

export async function recordGoalFixedCharge(tx: Prisma.TransactionClient, entry: CreditLedgerEntry,
  binding: { goalId: string; runId: string } | undefined) {
  if (!binding) return
  const goal = await tx.agentGoal.findFirstOrThrow({ where: { id: binding.goalId, userId: entry.userId } })
  const sourceKey = `ledger:${entry.id}`
  const previous = await tx.agentGoalUsage.findUnique({ where: { sourceKey } })
  if (previous) {
    if (previous.goalId !== goal.id || previous.runId !== binding.runId) return goalError('GOAL_SCOPE_MISMATCH', '费用回执归属不一致。')
    return
  }
  const creditsMicros = BigInt(Math.max(0, -entry.deltaMilli)) * 1000n
  await tx.agentGoalUsage.create({ data: { sourceKey, goalId: goal.id, runId: binding.runId,
    creditsMicros, status: 'known' } })
  await tx.agentGoalBudget.update({ where: { goalId: goal.id }, data: { creditsUsedMicros: { increment: creditsMicros } } })
  await changeGoal(tx, goal, {}, 'usage.updated')
}

/** Called before wallet locks, including background refunds after cancellation.
 * The recorded source identity, not the current ALS or a model, owns the refund. */
export async function lockGoalFixedRefund(tx: Prisma.TransactionClient, original: CreditLedgerEntry | null) {
  if (!original || !isGoalFixedCharge(original.sourceType) || !original.metadata || typeof original.metadata !== 'object' || Array.isArray(original.metadata)) return undefined
  const binding = bindingSchema.safeParse(original.metadata.goalBinding)
  if (!binding.success) return undefined
  const known = await tx.agentGoalUsage.findUnique({ where: { sourceKey: `ledger:${original.id}` }, include: { goal: true } })
  if (!known || known.goalId !== binding.data.goalId || known.runId !== binding.data.runId || known.goal.userId !== original.userId) {
    return goalError('GOAL_SCOPE_MISMATCH', '退款与目标费用回执不一致。')
  }
  await lockNovelActiveScope(tx, known.goal.novelId)
  await tx.$queryRaw`SELECT id FROM agent_goals WHERE id = ${known.goalId} FOR UPDATE`
  return known.sourceKey
}

/** The existing refund protocol only permits a full, identity-checked refund. */
export async function recordGoalFixedRefund(tx: Prisma.TransactionClient, sourceKey: string | undefined) {
  if (!sourceKey) return
  const usage = await tx.agentGoalUsage.findUniqueOrThrow({ where: { sourceKey } })
  if (usage.creditsMicros === 0n) return
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: usage.goalId } })
  await tx.agentGoalUsage.update({ where: { sourceKey }, data: { creditsMicros: 0n } })
  await tx.agentGoalBudget.update({ where: { goalId: usage.goalId }, data: { creditsUsedMicros: { decrement: usage.creditsMicros } } })
  await changeGoal(tx, goal, {}, 'usage.refunded')
}
