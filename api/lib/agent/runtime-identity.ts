import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { Prisma } from '@prisma/client'
import { DURABLE_RUNTIME_VERSION, lockOwnedRun, runtimeError, runtimeId, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { createTaskBudgetPolicy } from './runtime-budget.js'
import { recordTaskContentBaseline } from './runtime-postconditions.js'
import { assertRunGoalFence } from './goal-fence.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'

function frozenSpec(raw: unknown) {
  const parsed = taskSpecSchema.safeParse(raw)
  if (!parsed.success) return runtimeError('RUNTIME_INPUT_INVALID', '建立持久任务需要完整的原任务合同。')
  if (parsed.data.authorization) runtimeError('TASK_AUTHORIZATION_NOT_ACTIVATED', '阶段授权签发及效果执行尚未接入，不能作为旧权限任务启用。')
  runtimeId(parsed.data.id)
  // runId is execution provenance, not a new task or permission on continuation.
  const spec = { ...parsed.data }; delete spec.runId
  return { spec: parsed.data, frozen: runtimeJson(JSON.parse(JSON.stringify(spec))) }
}

/** Internal bootstrap from a persisted user message. No HTTP/model-facing issuer exists yet. */
export async function initializeDurableTask(input: { userId: string; runId: string; sourceMessageId: string; tokenBudget?: number }) {
  input = { ...input }
  runtimeId(input.sourceMessageId)
  const budgetPolicy = createTaskBudgetPolicy(input.tokenBudget)
  return runtimeTransaction(async tx => {
    const goalBinding = await tx.agentGoalExecution.findUnique({ where: { runId: input.runId } })
    if (goalBinding) await (await import('./goal-fence.js')).assertRunGoalFence(tx, input.userId, input.runId)
    const run = await lockOwnedRun(tx, input.userId, input.runId)
    if (await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: run.id } })) return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '子任务只能由原父任务授权初始化，不能作为作者新任务重建。')
    if (run.runtimeProtocolVersion === 0 && run.status !== 'queued') runtimeError('RUNTIME_NOT_ACTIVE', '只能在旧执行器启动之前建立持久任务。')
    const { spec, frozen } = frozenSpec(run.taskSpec)
    if (spec.scope.novelId !== run.novelId || (run.taskRootId && run.taskRootId !== spec.id)
      || ![0, DURABLE_RUNTIME_VERSION].includes(run.runtimeProtocolVersion)) runtimeError('RUNTIME_SCOPE_MISMATCH', '任务根或版本不匹配，不能重建为新任务。')
    const message = await tx.agentMessage.findFirst({ where: { id: input.sourceMessageId, runId: run.id, sessionId: run.sessionId,
      role: goalBinding && goalBinding.trigger !== 'author' ? 'system' : 'user' } })
    if (!message) return runtimeError('RUNTIME_SOURCE_REQUIRED', '缺少本任务的原始用户消息，不能从历史摘要补造授权。')
    const request = runtimeJson(message.parts)
    const digest = runtimeJson({ spec: frozen.value, request: request.value }).hash
    const old = await tx.agentTaskRoot.findUnique({ where: { id: spec.id } })
    if (old && (old.userId !== run.userId || old.sessionId !== run.sessionId || old.novelId !== run.novelId
      || old.sourceMessageId !== message.id || old.inputHash !== digest || old.protocolVersion !== DURABLE_RUNTIME_VERSION)) runtimeError('RUNTIME_IDENTITY_CONFLICT', '任务根已绑定其他输入，拒绝覆盖。')
    const root = old ?? await tx.agentTaskRoot.create({ data: {
      id: spec.id, userId: run.userId, sessionId: run.sessionId, novelId: run.novelId,
      sourceMessageId: message.id, inputHash: digest, specSnapshot: frozen.value, requestSnapshot: request.value,
      budget: { create: { policy: budgetPolicy.value, policyHash: budgetPolicy.hash, tokenLimit: budgetPolicy.initialTokens } },
    } })
    if (!old && spec.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED')) await recordTaskContentBaseline(tx, root, run.id)
    if (old && input.tokenBudget !== undefined) {
      const budget = await tx.agentTaskBudget.findUnique({ where: { taskRootId: old.id } })
      if (!budget || budget.policyHash !== budgetPolicy.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '恢复不能修改原任务预算合同。')
    }
    await tx.agentRun.update({ where: { id: run.id }, data: { taskRootId: root.id, runtimeProtocolVersion: DURABLE_RUNTIME_VERSION } })
    if (goalBinding) await tx.agentGoalExecution.update({ where: { runId: run.id }, data: { taskRootId: root.id } })
    return root
  })
}

/** Explicit continuation only. Same session membership is never enough. */
export async function attachRunToDurableTask(input: { userId: string; runId: string; taskRootId: string }) {
  input = { ...input }
  runtimeId(input.taskRootId)
  return runtimeTransaction(async tx => {
    const run = await lockOwnedRun(tx, input.userId, input.runId)
    if (await tx.agentChildExecutionGrant.findFirst({ where: { OR: [{ childRunId: run.id }, { childRun: { taskRootId: input.taskRootId } }] } })) return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '不能通过作者继续入口接管子任务授权。')
    if (run.runtimeProtocolVersion === 0 && run.status !== 'queued') runtimeError('RUNTIME_NOT_ACTIVE', '只能在旧执行器启动之前绑定持久任务。')
    const { spec, frozen } = frozenSpec(run.taskSpec)
    await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${input.taskRootId} FOR UPDATE`
    const root = await tx.agentTaskRoot.findUnique({ where: { id: input.taskRootId } })
    if (!root || root.userId !== run.userId || root.sessionId !== run.sessionId || root.novelId !== run.novelId
      || root.id !== spec.id || runtimeJson(root.specSnapshot).hash !== frozen.hash || root.status !== 'active'
      || root.protocolVersion !== DURABLE_RUNTIME_VERSION || ![0, DURABLE_RUNTIME_VERSION].includes(run.runtimeProtocolVersion)
      || (run.taskRootId && run.taskRootId !== root.id)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '继续请求与原任务范围不匹配。')
    await tx.agentRun.update({ where: { id: run.id }, data: { taskRootId: root.id, runtimeProtocolVersion: DURABLE_RUNTIME_VERSION } })
    return root
  })
}

/** Expansion fence: a durable marker may not silently enter an unfenced legacy loop. */
export function assertLegacyRuntimeCompatible(run: { runtimeProtocolVersion?: number; taskRootId?: string | null }): void {
  if ((run.runtimeProtocolVersion ?? 0) !== 0 || run.taskRootId) runtimeError('TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED', '此任务已使用持久执行协议，旧执行器不能忽略该协议继续运行。')
}

/** Atomic admission: checking the version after an unconditional status update is too late. */
export async function startLegacyRuntimeRun(userId: string, runId: string, resume = false, activation?: { goalId: string; epoch: bigint }) {
  try {
    return await runtimeTransaction(async tx => {
      let activationNovelId: string | null = null
      if (activation) {
        const { lockOwnedGoal, changeGoal, goalError } = await import('./goal-store.js')
        const run = await tx.agentRun.findFirst({ where: { id: runId, userId } })
        if (!run) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原任务不存在。')
        activationNovelId = run.novelId
        const goal = await lockOwnedGoal(tx, userId, run.sessionId, activation.goalId)
        const grant = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: { goalId: goal.id, revision: 1, criterionId: 'activation-resume' } } })
        if (!resume || goal.status !== 'active' || goal.epoch !== activation.epoch || goal.currentRunId !== runId
          || goal.reasonCode !== 'GOAL_ACTIVATION_RESUME_READY' || grant?.status !== 'verified'
          || !grant.receipt || typeof grant.receipt !== 'object' || Array.isArray(grant.receipt)
          || grant.receipt.epoch !== String(goal.epoch) || grant.receipt.sourceRunId !== runId) return goalError('GOAL_VERSION_CONFLICT', '原任务继续授权已变化。')
        await tx.agentGoalExecution.update({ where: { runId }, data: { epoch: goal.epoch } })
        await (await import('./goal-fence.js')).assertGoalRevisionFence(tx, { userId, sessionId: goal.sessionId, novelId: goal.novelId, goalId: goal.id, revision: goal.currentRevision, epoch: goal.epoch, runId })
        await tx.agentGoalEvidence.update({ where: { id: grant.id }, data: { status: 'consumed' } })
        await changeGoal(tx, goal, { phase: 'executing', reasonCode: null, activeSince: new Date(), nextEligibleAt: null }, 'activation.continued')
      }
      // Goal control is the admission fence. It must run in the same
      // transaction as the status CAS so a paused/cancelled goal cannot be
      // resurrected by an old legacy startup path.
      if (!activation) await assertRunGoalFence(tx, userId, runId)
      const started = await tx.agentRun.update({
        where: { id: runId, userId, runtimeProtocolVersion: 0, taskRootId: null,
          status: resume ? { in: ['paused', 'failed'] } : 'queued' },
        data: { status: 'running', ...(!resume ? { startedAt: new Date() } : {}), errorMessage: null },
        select: { taskSpec: true, taskRootId: true, runtimeProtocolVersion: true, usage: true, currentTurn: true, startedAt: true,
          events: { where: { type: { in: ['run.started', 'run.paused', 'run.finished'] } }, orderBy: { seq: 'asc' }, select: { type: true, createdAt: true } } },
      })
      if (activationNovelId) await assertAgentManuscriptCurrent(tx, { userId, novelId: activationNovelId, runId })
      return started
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      runtimeError('TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED', '任务状态或执行协议已变化，不能覆盖当前任务重新启动。')
    }
    throw error
  }
}
