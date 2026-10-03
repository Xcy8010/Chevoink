import type { StartAgentLoopRunRequest } from '../../../shared/contracts/index.js'
import { agentGoalExecutionOptionsSchema } from '../../../shared/contracts/agent-goal.js'
import { prisma } from '../prisma.js'
import { currentGoalExecution } from './goal-context.js'
import { goalError } from './goal-store.js'
import type { GoalRunAdmission } from './goal-run-admission.js'

/** Resolve from owned server state, never accept goal identity or version from model arguments. */
export async function resolveGoalAuthorAdmission(userId: string, input: StartAgentLoopRunRequest, sourceEventId: string,
  orchestration = false): Promise<{ input: StartAgentLoopRunRequest; admission?: GoalRunAdmission; steering?: StartAgentLoopRunRequest }> {
  const parent = currentGoalExecution()
  if (parent && orchestration) {
    const goal = await prisma.agentGoal.findFirstOrThrow({ where: { id: parent.goalId, userId, novelId: input.novelId } })
    const session = await prisma.agentSession.findFirst({ where: { id: input.sessionId, userId, novelId: input.novelId,
      spawnedFromSessionId: parent.sessionId } })
    if (!session) return goalError('GOAL_SCOPE_MISMATCH', '只能将目标分工交给本目标派生的窗口。')
    return { input, admission: { goalId: goal.id, revision: parent.revision, epoch: parent.epoch,
      continuationIndex: goal.continuationIndex, trigger: 'subagent', sourceEventId } }
  }
  const goal = await prisma.agentGoal.findFirst({ where: { userId, sessionId: input.sessionId, novelId: input.novelId,
    status: { notIn: ['completed', 'cancelled'] } } })
  if (!goal) return { input }
  const activation = await (await import('./goal-activation.js')).readGoalActivationReceipt(prisma, goal)
  if (activation && !activation.receipt.baselineBound) return goalError('GOAL_RECONCILIATION_REQUIRED', '原任务尚未完成结算，补充消息已保留。')
  if (goal.status !== 'active' || goal.pendingRevision) return goalError('GOAL_NOT_ACTIVE', '请先继续当前目标，或取消后再发送新任务。')
  if (goal.phase === 'awaiting_input' && goal.reasonCode === 'GOAL_SCOPE_DECISION_REQUIRED') {
    return goalError('GOAL_SCOPE_UPDATE_REQUIRED', '请在目标条中修改目标，明确本次要完成的范围后继续。')
  }
  const revision = await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: goal.currentRevision } } })
  const options = agentGoalExecutionOptionsSchema.parse(goal.executionOptions)
  return { input: { ...options, sessionId: goal.sessionId, novelId: goal.novelId, prompt: revision.objective }, steering: input,
    admission: { goalId: goal.id, revision: goal.currentRevision, epoch: goal.epoch, continuationIndex: goal.continuationIndex,
      trigger: goal.continuationIndex === 0 ? 'author' : 'steering', sourceEventId } }
}
