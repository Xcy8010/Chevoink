import type { Prisma } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import type { GoalExecutionContext } from './goal-context.js'
import { goalError } from './goal-store.js'

export async function readGoalExecution(userId: string, runId: string, tx: Prisma.TransactionClient = prisma): Promise<GoalExecutionContext | undefined> {
  const execution = await tx.agentGoalExecution.findUnique({ where: { runId }, include: { goal: true } })
  if (!execution) return undefined
  const goal = execution.goal
  if (goal.userId !== userId) return goalError('NOT_FOUND', '目标不存在。', 404)
  return { goalId: goal.id, revision: execution.goalRevision, epoch: execution.epoch, userId,
    novelId: goal.novelId, sessionId: goal.sessionId, runId }
}

/** All domain mutations check inside their actual transaction, BEFORE acquiring run/root locks.
 * The manuscript lock orders goal controls against existing import/restore fences. */
export async function assertGoalRevisionFence(tx: Prisma.TransactionClient, context: GoalExecutionContext): Promise<void> {
  await lockNovelActiveScope(tx, context.novelId)
  await tx.$queryRaw`SELECT id FROM agent_goals WHERE id = ${context.goalId} FOR UPDATE`
  const goal = await tx.agentGoal.findFirst({ where: { id: context.goalId, userId: context.userId,
    novelId: context.novelId, sessionId: context.sessionId } })
  if (!env.agentGoalEnabled || !goal || goal.status !== 'active' || goal.pendingRevision !== null
    || goal.currentRevision !== context.revision || goal.epoch !== context.epoch) {
    return goalError('GOAL_EXECUTION_FENCED', '目标已暂停、取消或更新，旧执行不能继续操作。')
  }
}

export async function assertGoalFence(tx: Prisma.TransactionClient, context: GoalExecutionContext): Promise<void> {
  await assertGoalRevisionFence(tx, context)
  const run = await tx.agentRun.findFirst({ where: { id: context.runId, userId: context.userId, novelId: context.novelId,
    status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })
  if (!run) return goalError('GOAL_EXECUTION_FENCED', '该目标执行已结束，不能继续产生副作用。')
}

export async function assertRunGoalFence(tx: Prisma.TransactionClient, userId: string, runId: string) {
  const context = await readGoalExecution(userId, runId, tx)
  if (context) await assertGoalFence(tx, context)
  return context
}
