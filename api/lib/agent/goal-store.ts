import type { AgentGoal, Prisma } from '@prisma/client'
import type { AgentGoalSnapshot } from '../../../shared/contracts/agent-goal.js'
import { agentGoalPhaseSchema, agentGoalStatusSchema } from '../../../shared/contracts/agent-goal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { DataAccessError } from '../prisma.js'
import { databaseNow, runtimeJson } from './runtime-common.js'
import { serializeExecutionControl, type EffectiveExecutionControl } from './execution-control.js'
import { goalControlPointerSchema, readGoalExecutionControl } from './goal-execution-control.js'

export type GoalTx = Prisma.TransactionClient
export const goalError = (code: string, message: string, status = 409): never => { throw new DataAccessError(status, code, message) }

/** Admission and control share this order: user -> manuscript -> session -> goal -> run/root. */
export async function lockGoalSession(tx: GoalTx, userId: string, sessionId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${userId}`}, 0))::text`
  const session = await tx.agentSession.findFirst({ where: { id: sessionId, userId }, include: { novel: { select: { authorId: true } } } })
  if (!session || session.novel.authorId !== userId) return goalError('NOT_FOUND', '任务不存在。', 404)
  await lockNovelActiveScope(tx, session.novelId)
  await tx.$queryRaw`SELECT id FROM agent_sessions WHERE id = ${sessionId} AND user_id = ${userId} FOR UPDATE`
  return session
}

export async function lockOwnedGoal(tx: GoalTx, userId: string, sessionId: string, goalId: string) {
  const session = await lockGoalSession(tx, userId, sessionId)
  await tx.$queryRaw`SELECT id FROM agent_goals WHERE id = ${goalId} AND user_id = ${userId} AND session_id = ${sessionId} FOR UPDATE`
  const goal = await tx.agentGoal.findFirst({ where: { id: goalId, userId, sessionId, novelId: session.novelId } })
  if (!goal) return goalError('NOT_FOUND', '目标不存在。', 404)
  return goal
}

export async function goalSnapshot(tx: GoalTx, goal: AgentGoal, admittedControl?: EffectiveExecutionControl): Promise<AgentGoalSnapshot> {
  const revision = await tx.agentGoalRevision.findUnique({ where: { goalId_revision: { goalId: goal.id, revision: goal.pendingRevision ?? goal.currentRevision } } })
  const budget = await tx.agentGoalBudget.findUnique({ where: { goalId: goal.id } })
  if (!revision || !budget) return goalError('GOAL_STATE_INCOMPLETE', '目标记录不完整，请稍后重试。')
  const pointer = goalControlPointerSchema.safeParse((goal.executionOptions as Record<string, Prisma.JsonValue>)?.goalExecutionControl)
  return { id: goal.id, sessionId: goal.sessionId, novelId: goal.novelId, objective: revision.objective,
    revision: goal.currentRevision, pendingRevision: goal.pendingRevision, status: agentGoalStatusSchema.parse(goal.status),
    phase: agentGoalPhaseSchema.parse(goal.phase), stateVersion: goal.stateVersion, currentRunId: goal.currentRunId,
    reasonCode: goal.reasonCode, executionControl: serializeExecutionControl(admittedControl ?? await readGoalExecutionControl(tx, goal.id)),
    ...(pointer.success ? { executionControlReceiptHash: pointer.data.receiptHash } : {}),
    tokenLimit: String(budget.tokenLimit), tokensUsed: String(budget.tokensUsed),
    tokensReserved: String(budget.tokensReserved), creditsUsedMicros: String(budget.creditsUsedMicros),
    activeTimeMs: String(budget.activeTimeMs), activeTimeLimitMs: String(budget.activeTimeLimitMs), activeSince: goal.activeSince?.toISOString() ?? null,
    serverTime: (await databaseNow(tx)).toISOString(), createdAt: goal.createdAt.toISOString(), updatedAt: goal.updatedAt.toISOString(),
    finishedAt: goal.finishedAt?.toISOString() ?? null }
}

/** Must hold the goal lock. Event and authoritative state commit together. */
export async function writeGoalEvent(tx: GoalTx, goal: AgentGoal, type: string, admittedControl?: EffectiveExecutionControl): Promise<AgentGoalSnapshot> {
  const snapshot = await goalSnapshot(tx, goal, admittedControl)
  await tx.agentGoalEvent.create({ data: { goalId: goal.id, sessionId: goal.sessionId, stateVersion: goal.stateVersion,
    goalRevision: goal.currentRevision, type, payload: runtimeJson(snapshot).value } })
  return snapshot
}

export async function changeGoal(tx: GoalTx, goal: AgentGoal, data: Prisma.AgentGoalUpdateInput, type = 'state.changed', admittedControl?: EffectiveExecutionControl) {
  const updated = await tx.agentGoal.update({ where: { id: goal.id, stateVersion: goal.stateVersion },
    data: { ...data, stateVersion: { increment: 1 } } })
  const snapshot = await writeGoalEvent(tx, updated, type, admittedControl)
  return { goal: updated, snapshot }
}

export async function closeGoalActivity(tx: GoalTx, goal: AgentGoal, now: Date) {
  if (goal.activeSince) {
    await tx.agentGoalBudget.update({ where: { goalId: goal.id }, data: {
      activeTimeMs: { increment: BigInt(Math.max(0, now.getTime() - goal.activeSince.getTime())) },
    } })
  }
}

export function assertGoalVersion(goal: AgentGoal, expectedStateVersion: number, expectedRevision?: number) {
  if (goal.stateVersion !== expectedStateVersion || (expectedRevision !== undefined && goal.currentRevision !== expectedRevision)) {
    goalError('GOAL_VERSION_CONFLICT', '目标已在另一处更新。你的修改已保留，请读取新版后重试。')
  }
}
