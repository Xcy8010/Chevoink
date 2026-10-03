import type { AgentGoal, Prisma } from '@prisma/client'
import { actOnAgentGoalSchema, createAgentGoalSchema, goalIsTerminal, updateAgentGoalSchema,
  type ActOnAgentGoalRequest, type AgentGoalDetail, type AgentGoalSnapshot, type CreateAgentGoalRequest,
  type UpdateAgentGoalRequest } from '../../../shared/contracts/agent-goal.js'
import { env } from '../../config/env.js'
import { assertManagedAttachmentsAccess } from '../agent-attachment-storage.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { DataAccessError, prisma } from '../prisma.js'
import { stopAgentRun } from './active-runs.js'
import { databaseNow, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { assertGoalVersion, changeGoal, closeGoalActivity, goalError, goalSnapshot, lockGoalSession, lockOwnedGoal,
  writeGoalEvent, type GoalTx } from './goal-store.js'
import { inspectGoalEvidence } from './goal-evidence.js'
import { goalResumeBudget } from './goal-resume-budget.js'
import { reconcileGoalUsage } from './goal-budget.js'
import { readGoalActivationReceipt } from './goal-activation.js'

export function requireGoalEnabled() {
  if (!env.agentGoalEnabled) goalError('GOAL_DISABLED', '目标模式暂未开放。', 503)
}
const terminal = (goal: AgentGoal) => goalIsTerminal(goal.status as AgentGoalSnapshot['status'])

async function replay(tx: GoalTx, userId: string, requestId: string, hash: string): Promise<AgentGoalSnapshot | null> {
  const command = await tx.agentGoalCommand.findUnique({ where: { userId_requestId: { userId, requestId } } })
  if (!command) return null
  if (command.requestHash !== hash) return goalError('GOAL_CONFLICT', '重复请求的内容不一致。')
  return command.response as unknown as AgentGoalSnapshot
}
async function receipt(tx: GoalTx, userId: string, requestId: string, hash: string, snapshot: AgentGoalSnapshot) {
  await tx.agentGoalCommand.create({ data: { userId, requestId, requestHash: hash, response: runtimeJson(snapshot).value } })
  return snapshot
}

/** Persist the queue intent with the goal. No network/model call occurs in admission. */
export async function createAgentGoal(userId: string, target: { sessionId: string } | { novelId: string }, input: CreateAgentGoalRequest) {
  requireGoalEnabled()
  const body = createAgentGoalSchema.parse(input)
  await assertManagedAttachmentsAccess(body.options.attachments, userId)
  const hash = runtimeJson({ operation: 'create', target, body }).hash
  return runtimeTransaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${userId}`}, 0))::text`
    // Replay before creating a session: a lost first response must not leave an empty second window.
    const previous = await replay(tx, userId, body.requestId, hash)
    if (previous) return previous
    let sessionId: string
    if ('sessionId' in target) sessionId = target.sessionId
    else {
      const novel = await tx.novel.findFirst({ where: { id: target.novelId, authorId: userId }, select: { id: true } })
      if (!novel) return goalError('NOT_FOUND', '作品不存在。', 404)
      await lockNovelActiveScope(tx, novel.id)
      sessionId = (await tx.agentSession.create({ data: { userId, novelId: novel.id, title: Array.from(body.objective).slice(0, 60).join('') } })).id
    }
    const session = await lockGoalSession(tx, userId, sessionId)
    if (await tx.agentGoal.findFirst({ where: { sessionId, status: { notIn: ['completed', 'cancelled'] } } })) {
      return goalError('GOAL_CONFLICT', '当前任务窗口已有未结束的目标。')
    }
    if (await tx.agentRun.count({ where: { sessionId, status: { in: ['queued', 'running', 'awaiting_approval'] } } })) {
      return goalError('RUN_IN_PROGRESS', '请先等待当前任务结束，或停止后再发送目标。')
    }
    if (await tx.agentQueuedRequest.count({ where: { sessionId, status: { in: ['pending', 'held'] } } })) {
      return goalError('GOAL_CONFLICT', '请先处理当前窗口的待发消息。')
    }
    const now = await databaseNow(tx)
    const platformTokenCap = BigInt(Math.floor(env.agentRunTokenBudgetCeiling))
    const platformTimeCapMs = BigInt(Math.floor(env.agentRunWallClockLongMinutes * 60_000))
    const tokenLimit = BigInt(body.limits?.tokenLimit ?? platformTokenCap)
    const activeTimeLimitMs = BigInt(body.limits?.activeTimeLimitMs ?? platformTimeCapMs)
    if (tokenLimit > platformTokenCap || activeTimeLimitMs > platformTimeCapMs) return goalError('GOAL_BUDGET_REQUIRED', '目标限制不能超过平台上限。')
    const goal = await tx.agentGoal.create({ data: { userId, novelId: session.novelId, sessionId, executionOptions: runtimeJson(body.options).value,
      nextEligibleAt: now, revisions: { create: { revision: 1, objective: body.objective, request: runtimeJson(body.options).value,
        authorityHash: runtimeJson({ objective: body.objective, options: body.options, novelId: session.novelId, userId }).hash, sourceActionId: body.requestId } },
      budget: { create: { tokenLimit, platformTokenCap, activeTimeLimitMs, platformTimeCapMs } },
      evidence: { create: { revision: 1, criterionId: 'author-objective', description: body.objective, kind: 'objective', receipt: {} } },
    } })
    return receipt(tx, userId, body.requestId, hash, await writeGoalEvent(tx, goal, 'goal.created'))
  })
}

/** Isolation is durable before abort is signalled. Accounting/receipts may still reconcile afterwards. */
export async function revokeGoalExecutions(tx: GoalTx, goal: AgentGoal, now: Date): Promise<string[]> {
  const executions = await tx.agentGoalExecution.findMany({ where: { goalId: goal.id }, select: { runId: true } })
  const runIds = executions.map(row => row.runId)
  const activation = await readGoalActivationReceipt(tx, goal)
  if (activation) {
    const source = await tx.agentRun.findFirst({ where: { id: activation.receipt.sourceRunId, userId: goal.userId, novelId: goal.novelId, sessionId: goal.sessionId } })
    if (source) {
      const sourceRuns = await tx.agentRun.findMany({ where: { userId: goal.userId, novelId: goal.novelId, sessionId: goal.sessionId,
        ...(source.taskRootId ? { taskRootId: source.taskRootId } : { taskSpec: { path: ['id'], equals: activation.receipt.sourceRootId } }) }, select: { id: true } })
      for (const run of sourceRuns) if (!runIds.includes(run.id)) runIds.push(run.id)
      const children = await tx.agentRun.findMany({ where: { userId: goal.userId, novelId: goal.novelId,
        session: { spawnedFromRunId: { in: sourceRuns.map(run => run.id) } } }, select: { id: true } })
      for (const run of children) if (!runIds.includes(run.id)) runIds.push(run.id)
    }
  }
  if (!runIds.length) return []
  if (activation) for (const runId of [...runIds].sort()) await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${runId} FOR UPDATE`
  const runs = await tx.agentRun.findMany({ where: { id: { in: runIds } }, select: { taskRootId: true } })
  const roots = runs.flatMap(run => run.taskRootId ? [run.taskRootId] : [])
  if (activation) for (const rootId of [...new Set(roots)].sort()) {
    await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${rootId} FOR UPDATE`
    const live = await tx.agentRun.findMany({ where: { taskRootId: rootId, status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })
    if (live.length) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      await tx.agentExecutionOutbox.create({ data: { id, taskRootId: rootId, runId: live[0].id,
        eventKey: `pause:${id}`, type: 'run.paused', payload: { reason: 'user_stop', runIds: live.map(run => run.id) } } })
    }
  }
  await tx.agentRunLease.updateMany({ where: { runId: { in: runIds } }, data: { epoch: { increment: 1 }, enabled: false, expiresAt: now } })
  await tx.agentTaskRoot.updateMany({ where: { id: { in: roots }, status: 'active' }, data: { status: 'paused' } })
  await tx.agentRun.updateMany({ where: { id: { in: runIds }, status: { in: ['queued', 'running', 'awaiting_approval'] } },
    data: { status: 'paused', finishedAt: now } })
  return runIds
}

export async function updateAgentGoal(userId: string, sessionId: string, goalId: string, input: UpdateAgentGoalRequest) {
  requireGoalEnabled()
  const body = updateAgentGoalSchema.parse(input)
  const hash = runtimeJson({ operation: 'update', sessionId, goalId, body }).hash
  const result = await runtimeTransaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
    const previous = await replay(tx, userId, body.requestId, hash)
    if (previous) return { snapshot: previous, runIds: [] }
    assertGoalVersion(goal, body.expectedStateVersion, body.expectedRevision)
    const activation = await readGoalActivationReceipt(tx, goal)
    if (activation && !activation.receipt.baselineBound) return goalError('GOAL_RECONCILIATION_REQUIRED', '原任务尚未完成结算，请稍后修改目标。')
    if (terminal(goal) || goal.pendingRevision) return goalError('GOAL_CONFLICT', '当前目标不能修改。')
    const revision = goal.currentRevision + 1
    const now = await databaseNow(tx)
    await tx.agentGoalRevision.create({ data: { goalId, revision, objective: body.objective, request: goal.executionOptions as Prisma.InputJsonValue,
      authorityHash: runtimeJson({ objective: body.objective, request: goal.executionOptions, novelId: goal.novelId, userId }).hash, sourceActionId: body.requestId } })
    await closeGoalActivity(tx, goal, now)
    const runIds = await revokeGoalExecutions(tx, goal, now)
    const changed = await changeGoal(tx, goal, { status: 'updating', resumeStatus: goal.status,
      pendingRevision: revision, epoch: { increment: 1 }, phase: 'reconciling', activeSince: null, nextEligibleAt: now }, 'revision.accepted')
    return { snapshot: await receipt(tx, userId, body.requestId, hash, changed.snapshot), runIds }
  })
  result.runIds.forEach(stopAgentRun)
  return result.snapshot
}

export async function actOnAgentGoal(userId: string, sessionId: string, goalId: string, input: ActOnAgentGoalRequest) {
  const body = actOnAgentGoalSchema.parse(input)
  if (body.action === 'resume') requireGoalEnabled()
  const hash = runtimeJson({ operation: 'action', sessionId, goalId, body }).hash
  // Authenticate and validate the author's version before reconciling. Usage
  // receipts increment stateVersion themselves, but cannot invalidate this resume.
  const resumeFence = body.action === 'resume' ? await runtimeTransaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
    const previous = await replay(tx, userId, body.requestId, hash)
    if (previous) return { previous, epoch: goal.epoch, revision: goal.currentRevision }
    assertGoalVersion(goal, body.expectedStateVersion)
    if (!['paused', 'blocked', 'usage_limited', 'budget_limited'].includes(goal.status) || goal.pendingRevision) {
      return goalError('GOAL_NOT_RESUMABLE', '目标当前不能继续。')
    }
    return { previous: null, epoch: goal.epoch, revision: goal.currentRevision }
  }) : null
  if (resumeFence?.previous) return resumeFence.previous
  if (resumeFence) await reconcileGoalUsage(goalId, { userId, sessionId })
  const result = await runtimeTransaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
    const previous = await replay(tx, userId, body.requestId, hash)
    if (previous) return { snapshot: previous, runIds: [] }
    // A late pause never demotes a committed completion.
    if (terminal(goal)) {
      if (body.action === 'resume') return goalError('GOAL_NOT_RESUMABLE', '已结束的目标不能恢复，请发送新目标。')
      return { snapshot: await receipt(tx, userId, body.requestId, hash, await goalSnapshot(tx, goal)), runIds: [] }
    }
    if (resumeFence) {
      if (goal.epoch !== resumeFence.epoch || goal.currentRevision !== resumeFence.revision || goal.pendingRevision) {
        return goalError('GOAL_VERSION_CONFLICT', '目标状态已变化，请读取最新状态后继续。')
      }
    } else assertGoalVersion(goal, body.expectedStateVersion)
    const now = await databaseNow(tx)
    if (body.action === 'confirm_completion') {
      if (goal.pendingRevision) return goalError('GOAL_VERSION_CONFLICT', '请等待目标更新后核对成果。')
      const inspection = await inspectGoalEvidence(tx, goal)
      const blockers = inspection.blockers
      if (!body.completion || body.completion.progressHash !== inspection.progressHash) return goalError('GOAL_VERSION_CONFLICT', '目标成果已变化，请读取最新结果后确认。')
      if (blockers.length || !inspection.hasDeliverable) return goalError('GOAL_EVIDENCE_INCOMPLETE', '仍有未完成执行或成果缺口，请完成后再确认。')
      await tx.agentGoalEvidence.upsert({ where: { goalId_revision_criterionId: { goalId, revision: goal.currentRevision, criterionId: 'author-objective' } },
        create: { goalId, revision: goal.currentRevision, criterionId: 'author-objective', kind: 'objective', description: inspection.objective,
          status: 'verified', verifiedAt: now, receipt: { source: 'author-confirmation', userId, requestId: body.requestId, progressHash: inspection.progressHash } },
        update: { status: 'verified', verifiedAt: now, receipt: { source: 'author-confirmation', userId, requestId: body.requestId, progressHash: inspection.progressHash } } })
      await closeGoalActivity(tx, goal, now)
      const snapshot = (await changeGoal(tx, goal, { status: 'completed', phase: 'idle', epoch: { increment: 1 }, activeSince: null,
        nextEligibleAt: null, reasonCode: null, finishedAt: now }, 'completed')).snapshot
      return { snapshot: await receipt(tx, userId, body.requestId, hash, snapshot), runIds: [] }
    }
    if (body.action === 'resume') {
      if (!['paused', 'blocked', 'usage_limited', 'budget_limited'].includes(goal.status) || goal.pendingRevision) {
        return goalError('GOAL_NOT_RESUMABLE', '目标当前不能继续。')
      }
      const activation = await readGoalActivationReceipt(tx, goal)
      if (activation && goal.currentRevision === 1) {
        if (body.model || body.budgetChange) return goalError('GOAL_ACTIVATION_SCOPE_IMMUTABLE', '继续原任务不能替换模型、权限或增加预算。')
        const source = await tx.agentRun.findFirst({ where: { id: goal.currentRunId ?? activation.receipt.sourceRunId, userId, sessionId, novelId: goal.novelId } })
        if (!source || ['queued', 'running', 'awaiting_approval'].includes(source.status)) return goalError('GOAL_RECONCILIATION_REQUIRED', '原任务尚未收尾，请稍后继续。')
        if (await tx.agentGoalUsage.count({ where: { goalId, status: { in: ['reserved', 'unknown'] } } })) return goalError('GOAL_RECONCILIATION_REQUIRED', '原任务用量仍待核对，请稍后继续。')
        const snapshot = (await changeGoal(tx, goal, { status: 'active', phase: 'reconciling', activeSince: null, nextEligibleAt: null,
          epoch: { increment: 1 }, reasonCode: 'GOAL_ACTIVATION_PENDING' }, 'activation.resume_requested')).snapshot
        await tx.agentGoalEvidence.upsert({ where: { goalId_revision_criterionId: { goalId, revision: 1, criterionId: 'activation-resume' } },
          create: { goalId, revision: 1, criterionId: 'activation-resume', kind: 'author-resume', description: '作者要求继续原任务。', status: 'verified', verifiedAt: now,
            receipt: { epoch: String(goal.epoch + 1n), sourceRunId: source.id, requestId: body.requestId } },
          update: { status: 'verified', verifiedAt: now, receipt: { epoch: String(goal.epoch + 1n), sourceRunId: source.id, requestId: body.requestId } } })
        return { snapshot: await receipt(tx, userId, body.requestId, hash, snapshot), runIds: [] }
      }
      if (await tx.agentGoalUsage.count({ where: { goalId, status: { in: ['reserved', 'unknown'] } } })) {
        return goalError('GOAL_RECONCILIATION_REQUIRED', '尚有执行结果待核对，请稍后继续。')
      }
      const budget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId } })
      const nextBudget = goalResumeBudget(budget, goal.status === 'budget_limited', {
        tokens: BigInt(Math.floor(env.agentRunTokenBudgetCeiling)),
        timeMs: BigInt(Math.floor(env.agentRunWallClockLongMinutes * 60_000)),
      }, body.budgetChange)
      if (nextBudget.tokenLimit > nextBudget.platformTokenCap || nextBudget.activeTimeLimitMs > nextBudget.platformTimeCapMs
        || nextBudget.tokenLimit < budget.tokenLimit || nextBudget.activeTimeLimitMs < budget.activeTimeLimitMs
        || nextBudget.tokenLimit <= budget.tokensUsed + budget.tokensReserved || nextBudget.activeTimeLimitMs <= budget.activeTimeMs) {
        return goalError('GOAL_BUDGET_REQUIRED', '当前执行预算不可用，请稍后继续。')
      }
      await tx.agentGoalBudget.update({ where: { goalId }, data: nextBudget })
      // Execution options are separately versioned; never rewrite an immutable objective revision.
      const options = body.model ? { ...(goal.executionOptions as Record<string, Prisma.JsonValue>), ...body.model } : goal.executionOptions
      const snapshot = (await changeGoal(tx, goal, { status: 'active', phase: 'queued', epoch: { increment: 1 }, executionOptions: options as Prisma.InputJsonValue,
        nextEligibleAt: now, reasonCode: null, blockCount: 0, blockFingerprint: null }, 'state.changed')).snapshot
      return { snapshot: await receipt(tx, userId, body.requestId, hash, snapshot), runIds: [] }
    }
    await closeGoalActivity(tx, goal, now)
    const runIds = await revokeGoalExecutions(tx, goal, now)
    const cancel = body.action === 'cancel'
    const snapshot = (await changeGoal(tx, goal, { status: cancel ? 'cancelled' : 'paused', phase: 'idle', epoch: { increment: 1 },
      activeSince: null, nextEligibleAt: null, reasonCode: cancel ? 'AUTHOR_CANCELLED' : 'AUTHOR_PAUSED',
      ...(goal.pendingRevision ? { resumeStatus: cancel ? 'cancelled' : 'paused' } : {}),
      finishedAt: cancel ? now : null }, cancel ? 'cancelled' : 'state.changed')).snapshot
    return { snapshot: await receipt(tx, userId, body.requestId, hash, snapshot), runIds }
  })
  result.runIds.forEach(stopAgentRun)
  return result.snapshot
}

export async function readAgentGoal(userId: string, sessionId: string): Promise<AgentGoalSnapshot | null> {
  return prisma.$transaction(async tx => {
    await lockGoalSession(tx, userId, sessionId)
    const goal = await tx.agentGoal.findFirst({ where: { userId, sessionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    return goal ? goalSnapshot(tx, goal) : null
  })
}

export async function readAgentGoalDetail(userId: string, sessionId: string, goalId: string,
  cursors: { revision?: number; evidence?: string } = {}): Promise<AgentGoalDetail> {
  return prisma.$transaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
    const revisions = await tx.agentGoalRevision.findMany({ where: { goalId, ...(cursors.revision ? { revision: { lt: cursors.revision } } : {}) },
      orderBy: { revision: 'desc' }, take: 51 })
    const evidence = await tx.agentGoalEvidence.findMany({ where: { goalId, revision: goal.currentRevision,
      ...(cursors.evidence ? { id: { gt: cursors.evidence } } : {}) }, orderBy: { id: 'asc' }, take: 51 })
    const inspection = await inspectGoalEvidence(tx, goal)
    const blockers = inspection.blockers
    return { goal: await goalSnapshot(tx, goal), completion: { progressHash: inspection.progressHash,
      canConfirm: !terminal(goal) && !goal.pendingRevision && inspection.hasDeliverable && blockers.length === 0,
      needsAuthorVerification: inspection.requirements.needsAuthorVerification, blockers },
    revisions: revisions.slice(0, 50).map(row => ({ revision: row.revision,
      objective: row.objective, createdAt: row.createdAt.toISOString() })),
    evidence: evidence.slice(0, 50).map(row => ({ criterionId: row.criterionId, description: row.description, kind: row.kind,
      targetId: row.targetId, status: row.status, receipt: row.receipt, verifiedAt: row.verifiedAt?.toISOString() ?? null })),
    nextRevisionCursor: revisions.length > 50 ? revisions[49].revision : null, nextEvidenceCursor: evidence.length > 50 ? evidence[49].id : null }
  })
}

/** The public stop endpoint uses this instead of leaving a goal eligible for auto continuation. */
export async function pauseGoalForRun(userId: string, runId: string): Promise<boolean> {
  const execution = await prisma.agentGoalExecution.findUnique({ where: { runId }, include: { goal: true } })
  if (!execution) {
    const pending = await prisma.agentGoal.findFirst({ where: { userId, currentRunId: runId, status: { notIn: ['completed', 'cancelled'] },
      evidence: { some: { criterionId: 'activation-source' } } } })
    if (!pending) return false
    const stopped = await runtimeTransaction(async tx => {
      const goal = await lockOwnedGoal(tx, userId, pending.sessionId, pending.id)
      if (terminal(goal) || goal.currentRunId !== runId) return []
      const now = await databaseNow(tx)
      const ids = await revokeGoalExecutions(tx, goal, now)
      await changeGoal(tx, goal, { status: 'paused', phase: 'idle', epoch: { increment: 1 }, activeSince: null, nextEligibleAt: null, reasonCode: 'AUTHOR_PAUSED' })
      return ids
    })
    stopped.forEach(stopAgentRun)
    return true
  }
  if (execution.goal.userId !== userId) return false
  const runIds = await runtimeTransaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, execution.goal.sessionId, execution.goalId)
    // The stop button names a run, so an old run's delayed request cannot
    // pause a later revision/resumption. Usage-only version changes, however,
    // must not make a current stop fail with a spurious edit conflict.
    if (terminal(goal) || goal.epoch !== execution.epoch || goal.currentRevision !== execution.goalRevision) return []
    const now = await databaseNow(tx)
    await closeGoalActivity(tx, goal, now)
    const stopped = await revokeGoalExecutions(tx, goal, now)
    await changeGoal(tx, goal, { status: 'paused', phase: 'idle', epoch: { increment: 1 },
      activeSince: null, nextEligibleAt: null, reasonCode: 'AUTHOR_PAUSED',
      ...(goal.pendingRevision ? { resumeStatus: 'paused' } : {}) }, 'state.changed')
    return stopped
  })
  runIds.forEach(stopAgentRun)
  return true
}

/** Queue steering is an author control, not a model-derived new objective.
 * Fence the old epoch and prioritize the saved message atomically. */
export async function steerGoalQueuedRequest(userId: string, sessionId: string, id: string, revision: number): Promise<boolean> {
  const candidate = await prisma.agentGoal.findFirst({ where: { userId, sessionId, status: { notIn: ['completed', 'cancelled'] } } })
  if (!candidate) return false
  const runIds = await runtimeTransaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, sessionId, candidate.id)
    const activation = await readGoalActivationReceipt(tx, goal)
    if (activation && !activation.receipt.baselineBound) return goalError('GOAL_RECONCILIATION_REQUIRED', '原任务尚未完成结算，补充消息已保留。')
    if (goal.status !== 'active' || goal.pendingRevision) return goalError('GOAL_NOT_ACTIVE', '请先继续当前目标，补充消息仍保留。')
    const now = await databaseNow(tx)
    await tx.agentQueuedRequest.updateMany({ where: { userId, sessionId, status: { in: ['pending', 'held'] } }, data: { priority: 0 } })
    const claimed = await tx.agentQueuedRequest.updateMany({ where: { id, userId, sessionId, revision, status: { in: ['pending', 'held'] } },
      data: { priority: 1, status: 'pending', error: null, revision: { increment: 1 } } })
    if (claimed.count !== 1) return goalError('QUEUE_CHANGED', '待发需求已发送或被修改，请刷新。')
    await closeGoalActivity(tx, goal, now)
    const stopped = await revokeGoalExecutions(tx, goal, now)
    await changeGoal(tx, goal, { phase: 'queued', epoch: { increment: 1 }, activeSince: null, nextEligibleAt: now, reasonCode: null }, 'author.steering')
    return stopped
  })
  runIds.forEach(stopAgentRun)
  return true
}

/** Execution failures do not grant a fresh budget or silently choose a different model. */
export async function noteGoalResourceFailure(userId: string, runId: string, error: unknown) {
  if (!(error instanceof DataAccessError)) return
  const status = error.code === 'GOAL_BUDGET_EXHAUSTED' ? 'budget_limited'
    : error.code.startsWith('CREDITS_') ? 'usage_limited' : null
  if (!status) return
  const execution = await prisma.agentGoalExecution.findUnique({ where: { runId }, include: { goal: true } })
  if (!execution || execution.goal.userId !== userId) return
  const runIds = await runtimeTransaction(async tx => {
    const goal = await lockOwnedGoal(tx, userId, execution.goal.sessionId, execution.goalId)
    if (goal.status !== 'active' || goal.currentRevision !== execution.goalRevision || goal.epoch !== execution.epoch) return []
    const now = await databaseNow(tx)
    await closeGoalActivity(tx, goal, now)
    const stopped = await revokeGoalExecutions(tx, goal, now)
    await changeGoal(tx, goal, { status, phase: 'idle', reasonCode: error.code, activeSince: null,
      nextEligibleAt: null, epoch: { increment: 1 } }, 'resource.limited')
    return stopped
  })
  runIds.forEach(stopAgentRun)
}
