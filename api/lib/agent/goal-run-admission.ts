import type { Prisma } from '@prisma/client'
import { currentGoalExecution, type GoalExecutionContext } from './goal-context.js'
import { assertGoalRevisionFence } from './goal-fence.js'
import { changeGoal, goalError } from './goal-store.js'
import { databaseNow } from './runtime-common.js'

export interface GoalRunAdmission {
  goalId: string; revision: number; epoch: bigint; continuationIndex: number
  trigger: 'author' | 'goal_auto' | 'revision' | 'steering' | 'subagent'
  sourceEventId: string
}

export async function admitGoalRun(tx: Prisma.TransactionClient, userId: string, sessionId: string, novelId: string,
  admission: GoalRunAdmission, prompt: string) {
  const context: GoalExecutionContext = { ...admission, userId, sessionId, novelId, runId: '' }
  // Parent-created windows keep their own session but share the parent's goal and cancellation fence.
  if (admission.trigger === 'subagent') {
    const parent = currentGoalExecution()
    if (!parent || parent.goalId !== admission.goalId) return goalError('GOAL_SCOPE_MISMATCH', '子任务目标归属不一致。')
    context.sessionId = parent.sessionId
  }
  await assertGoalRevisionFence(tx, context)
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: admission.goalId } })
  if (goal.continuationIndex !== admission.continuationIndex) return goalError('GOAL_VERSION_CONFLICT', '目标执行位置已变化。')
  if (admission.trigger === 'goal_auto' && await tx.agentQueuedRequest.count({ where: { sessionId: goal.sessionId, status: { in: ['pending', 'held'] } } })) {
    return goalError('GOAL_AUTHOR_MESSAGE_PENDING', '先处理作者的待发消息。')
  }
  const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: admission.revision } } })
  if (admission.trigger !== 'subagent' && prompt !== revision.objective) return goalError('GOAL_SCOPE_MISMATCH', '执行请求与目标版本不一致。')
  const budget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId: goal.id } })
  if (budget.tokensUsed + budget.tokensReserved >= budget.tokenLimit || budget.activeTimeMs >= budget.activeTimeLimitMs) {
    return goalError('GOAL_BUDGET_EXHAUSTED', '目标已达到预算上限。')
  }
  if (await tx.agentGoalUsage.count({ where: { goalId: goal.id, status: 'unknown' } })) return goalError('GOAL_RECONCILIATION_REQUIRED', '模型用量尚待核实。')
  const previous = admission.trigger === 'subagent' ? null : await tx.agentGoalExecution.findFirst({
    where: { goalId: goal.id, goalRevision: goal.currentRevision, trigger: { not: 'subagent' } }, orderBy: { continuationIndex: 'desc' }, include: { run: true },
  })
  return { goal, previous, context }
}

export async function bindGoalRun(tx: Prisma.TransactionClient, admitted: Awaited<ReturnType<typeof admitGoalRun>>, admission: GoalRunAdmission, runId: string) {
  const index = admitted.goal.continuationIndex + 1
  await tx.agentGoalExecution.create({ data: { goalId: admission.goalId, goalRevision: admission.revision, epoch: admission.epoch,
    continuationIndex: index, runId, trigger: admission.trigger, sourceEventId: admission.sourceEventId } })
  const now = await databaseNow(tx)
  await changeGoal(tx, admitted.goal, { continuationIndex: index,
    ...(admission.trigger === 'subagent' ? {} : { currentRunId: runId, phase: 'executing', nextEligibleAt: null, reasonCode: null,
      activeSince: admitted.goal.activeSince ?? now }),
  }, 'continuation.scheduled')
}
