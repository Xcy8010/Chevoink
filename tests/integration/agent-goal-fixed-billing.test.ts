import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { consumeCredits, consumeCreditsInTransaction, getCreditWindow, refundCreditCharge } from '../../api/lib/credits.js'
import { createAgentGoal, actOnAgentGoal, readAgentGoal } from '../../api/lib/agent/goal-service.js'
import { withGoalExecutionContext, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(() => prisma.$disconnect())

async function fixture(work: (context: GoalExecutionContext) => Promise<void>) {
  const previous = env.agentGoalEnabled
  env.agentGoalEnabled = true
  const user = await prisma.user.create({ data: { nickname: `goal-fee-${randomUUID()}`, passwordHash: 'fixture-only' } })
  try {
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: user.id, dailyAllowanceMilli: 10000,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '固定费用合成测试', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '固定费用测试' } })
    const goal = await createAgentGoal(user.id, { sessionId: session.id }, { requestId: randomUUID(), objective: '调研封面', options: { mode: 'build' } })
    const run = await prisma.agentRun.create({ data: { userId: user.id, novelId: novel.id, sessionId: session.id,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running', inputSummary: 'fixture' } })
    await prisma.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: 1n,
      runId: run.id, continuationIndex: 1, trigger: 'author', sourceEventId: randomUUID() } })
    await work({ goalId: goal.id, revision: 1, epoch: 1n, userId: user.id, novelId: novel.id, sessionId: session.id, runId: run.id })
  } finally {
    await prisma.agentGoalCommand.deleteMany({ where: { userId: user.id } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
    env.agentGoalEnabled = previous
  }
}

describe.skipIf(!dbAvailable)('goal fixed-fee ledger integration', () => {
  it.each(['image_generation', 'web_search'])('counts %s once and refunds after cancellation without reopening the goal', async sourceType => {
    await fixture(async context => {
      const key = `goal-fixed:${randomUUID()}`
      const input = { userId: context.userId, amountMilli: 2000, kind: 'usage', sourceType, idempotencyKey: key }
      await withGoalExecutionContext(context, () => consumeCredits(input))
      await withGoalExecutionContext(context, () => consumeCredits(input))
      let budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
      expect(budget).toMatchObject({ creditsUsedMicros: 2_000_000n, tokensUsed: 0n, tokensReserved: 0n })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId, kind: 'usage' } })).toBe(1)
      const goal = (await readAgentGoal(context.userId, context.sessionId))!
      await actOnAgentGoal(context.userId, context.sessionId, context.goalId,
        { requestId: randomUUID(), expectedStateVersion: goal.stateVersion, action: 'cancel' })
      await expect(withGoalExecutionContext(context, () => consumeCredits({ ...input, idempotencyKey: `${key}:late` })))
        .rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
      await refundCreditCharge(context.userId, key, 'fixture-refund')
      await refundCreditCharge(context.userId, key, 'fixture-refund')
      budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
      expect(budget.creditsUsedMicros).toBe(0n)
      expect((await readAgentGoal(context.userId, context.sessionId))?.status).toBe('cancelled')
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId, kind: 'refund' } })).toBe(1)
    })
  })

  it('rolls wallet, goal usage and goal events back together', async () => {
    await fixture(async context => {
      const before = (await readAgentGoal(context.userId, context.sessionId))!
      await expect(withGoalExecutionContext(context, () => prisma.$transaction(async tx => {
        await consumeCreditsInTransaction(tx, { userId: context.userId, amountMilli: 2000, kind: 'usage',
          sourceType: 'web_search', idempotencyKey: `rollback:${randomUUID()}` })
        throw new Error('fixture transaction rollback')
      }))).rejects.toThrow('fixture transaction rollback')
      expect(await prisma.agentGoalUsage.count({ where: { goalId: context.goalId } })).toBe(0)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId } })).toBe(0)
      expect((await readAgentGoal(context.userId, context.sessionId))?.stateVersion).toBe(before.stateVersion)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: context.userId } })).dailyUsedMilli).toBe(0)
    })
  })

  it.each(['tokens', 'time'])('does not charge another fixed-fee tool after the %s budget is exhausted', async kind => {
    await fixture(async context => {
      const budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
      await prisma.agentGoalBudget.update({ where: { goalId: context.goalId }, data: kind === 'tokens'
        ? { tokensUsed: budget.tokenLimit } : { activeTimeMs: budget.activeTimeLimitMs } })
      await expect(withGoalExecutionContext(context, () => consumeCredits({ userId: context.userId, amountMilli: 2000,
        kind: 'usage', sourceType: 'web_search', idempotencyKey: `exhausted:${randomUUID()}` })))
        .rejects.toMatchObject({ code: 'GOAL_BUDGET_EXHAUSTED' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId } })).toBe(0)
      expect(await prisma.agentGoalUsage.count({ where: { goalId: context.goalId } })).toBe(0)
    })
  })
})
