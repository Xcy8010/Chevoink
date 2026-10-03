import { randomUUID } from 'node:crypto'
import { agentGoalExecutionOptionsSchema } from '../../../shared/contracts/agent-goal.js'
import { env } from '../../config/env.js'
import { DataAccessError, prisma } from '../prisma.js'
import { stopAgentRun } from './active-runs.js'
import { actOnAgentGoal, revokeGoalExecutions } from './goal-service.js'
import { changeGoal, closeGoalActivity, lockOwnedGoal } from './goal-store.js'
import { databaseNow, runtimeTransaction } from './runtime-common.js'
import { inspectGoalEvidence, nextGoalProgress } from './goal-evidence.js'
import { startLoopRun } from './run-service.js'
import { reconcileGoalUsage } from './goal-budget.js'
import { runtimeJson } from './runtime-common.js'
import { hasAuthorEnded } from './completion-guard.js'
import { reconcileGoalActivation } from './goal-activation-supervisor.js'

/** Database is the scheduler: polling only wakes persisted, eligible goals; it never polls a model. */
export async function superviseAgentGoal(userId: string, sessionId: string, goalId: string) {
  // Reconcile only unresolved rows from persisted receipts. This includes
  // durable provider attempts and still works after cancellation; it never
  // dispatches a provider request or creates a new charge.
  await reconcileGoalUsage(goalId, { userId, sessionId })
  let revokedRunIds: string[] = []
  const action = await runtimeTransaction(async tx => {
    let goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
    const now = await databaseNow(tx)
    if (!env.agentGoalEnabled && goal.status === 'active') return { kind: 'pause' as const, version: goal.stateVersion }
    const activation = await reconcileGoalActivation(tx, goal, now)
    if (activation) return activation === true ? null : activation
    if (['completed', 'cancelled'].includes(goal.status)) return null
    if (goal.pendingRevision) {
      if (await tx.agentGoalUsage.count({ where: { goalId, status: { in: ['reserved', 'unknown'] } } })) return null
      const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId, revision: goal.pendingRevision } } })
      await tx.agentGoalEvidence.upsert({ where: { goalId_revision_criterionId: { goalId, revision: revision.revision, criterionId: 'author-objective' } },
        create: { goalId, revision: revision.revision, criterionId: 'author-objective', kind: 'objective', description: revision.objective, receipt: {} }, update: {} })
      goal = (await changeGoal(tx, goal, { currentRevision: revision.revision, pendingRevision: null, resumeStatus: null,
        currentRunId: null, status: goal.resumeStatus ?? 'paused', phase: goal.resumeStatus === 'active' ? 'queued' : 'idle',
        progressHash: null, blockFingerprint: null, blockCount: 0, nextEligibleAt: goal.resumeStatus === 'active' ? now : null }, 'revision.applied')).goal
    }
    if (goal.status !== 'active') return null
    const run = goal.currentRunId ? await tx.agentRun.findUnique({ where: { id: goal.currentRunId } }) : null
    // The author's explicit end remains final even when the last settled
    // request also reaches a budget ceiling.
    if (run && !['queued', 'running', 'awaiting_approval'].includes(run.status) && hasAuthorEnded(run.usage)) {
      await closeGoalActivity(tx, goal, now)
      revokedRunIds = await revokeGoalExecutions(tx, goal, now)
      await changeGoal(tx, goal, { status: 'cancelled', phase: 'idle', activeSince: null, nextEligibleAt: null,
        epoch: { increment: 1 }, reasonCode: 'AUTHOR_CANCELLED', finishedAt: now }, 'cancelled')
      return null
    }
    const budget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId } })
    const inFlight = goal.activeSince ? BigInt(Math.max(0, now.getTime() - goal.activeSince.getTime())) : 0n
    if (budget.tokensUsed >= budget.tokenLimit || budget.activeTimeMs + inFlight >= budget.activeTimeLimitMs) {
      await closeGoalActivity(tx, goal, now)
      revokedRunIds = await revokeGoalExecutions(tx, goal, now)
      await changeGoal(tx, goal, { status: 'budget_limited', phase: 'idle', activeSince: null, nextEligibleAt: null, epoch: { increment: 1 }, reasonCode: 'GOAL_BUDGET_EXHAUSTED' })
      return null
    }
    if (run && ['queued', 'running', 'awaiting_approval'].includes(run.status)) return null
    if (goal.currentRunId && !run) {
      if (goal.phase !== 'reconciling' || goal.activeSince || goal.reasonCode !== 'GOAL_RUN_HANDLE_MISSING') {
        await closeGoalActivity(tx, goal, now)
        await changeGoal(tx, goal, { phase: 'reconciling', activeSince: null, nextEligibleAt: null, reasonCode: 'GOAL_RUN_HANDLE_MISSING' })
      }
      return null
    }
    // Legacy novel_import prepare is a human handoff. Keep the goal parked
    // until the exact run-bound job has a real commit receipt; an unrelated
    // successful import in the same novel must never wake this goal.
    if (goal.reasonCode === 'GOAL_IMPORT_AWAITING_AUTHOR') {
      const importJob = goal.currentRunId
        ? await tx.novelImportJob.findFirst({ where: { userId, novelId: goal.novelId, agentRunId: goal.currentRunId },
          include: { commit: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] })
        : null
      if (importJob?.status === 'succeeded' && importJob.commit) {
        await closeGoalActivity(tx, goal, now)
        goal = (await changeGoal(tx, goal, { phase: 'queued', activeSince: null, nextEligibleAt: now, reasonCode: null })).goal
      } else {
        const reasonCode = importJob && ['cancelled', 'failed', 'expired'].includes(importJob.status)
          ? `GOAL_IMPORT_${importJob.status.toUpperCase()}` : 'GOAL_IMPORT_AWAITING_AUTHOR'
        if (goal.phase !== 'awaiting_input' || goal.reasonCode !== reasonCode) {
          await closeGoalActivity(tx, goal, now)
          await changeGoal(tx, goal, { phase: 'awaiting_input', activeSince: null, nextEligibleAt: null, reasonCode })
        }
        return null
      }
    }
    if (goal.phase === 'awaiting_input' || goal.phase === 'awaiting_approval') return null
    if (goal.nextEligibleAt && goal.nextEligibleAt > now) return null
    // A terminal run may leave the goal in any non-waiting phase after a
    // crash. Reconcile it before dispatching again; reconciling is a durable
    // wait state, not a terminal state.
    if (run || goal.phase === 'reconciling') {
      const inspection = await inspectGoalEvidence(tx, goal)
      if (inspection.blockers.some(item => item.code === 'CHILD_EXECUTING')) {
        const activeSince = inspection.childrenExecuting ? goal.activeSince ?? now : null
        if (!inspection.childrenExecuting) await closeGoalActivity(tx, goal, now)
        if (goal.phase !== 'awaiting_provider' || goal.reasonCode !== 'GOAL_CHILD_EXECUTING' || goal.activeSince !== activeSince) {
          await changeGoal(tx, goal, { phase: 'awaiting_provider', activeSince,
            nextEligibleAt: null, reasonCode: 'GOAL_CHILD_EXECUTING' })
        }
        return null
      }
      await closeGoalActivity(tx, goal, now)
      if (inspection.blockers.some(item => ['USAGE_UNRESOLVED', 'OPERATION_UNRESOLVED'].includes(item.code))) {
        if (goal.phase !== 'reconciling' || goal.activeSince || goal.reasonCode !== 'GOAL_RECONCILIATION_REQUIRED') {
          await changeGoal(tx, goal, { phase: 'reconciling', activeSince: null, reasonCode: 'GOAL_RECONCILIATION_REQUIRED' })
        }
        return null
      }
      if (inspection.needsScopeDecision) {
        await changeGoal(tx, goal, { phase: 'awaiting_input', activeSince: null, reasonCode: 'GOAL_SCOPE_DECISION_REQUIRED' }); return null
      }
      // The locked domain inspection is authoritative. A model omitting its
      // optional completion report must not trigger another paid writing round.
      if (!inspection.requirements.needsAuthorVerification && inspection.blockers.length === 0 && inspection.hasDeliverable) {
        const receipt = { source: 'domain-evidence', progressHash: inspection.progressHash }
        await tx.agentGoalEvidence.upsert({ where: { goalId_revision_criterionId: { goalId, revision: goal.currentRevision, criterionId: 'author-objective' } },
          create: { goalId, revision: goal.currentRevision, criterionId: 'author-objective', kind: 'objective',
            description: inspection.objective, status: 'verified', receipt, verifiedAt: now },
          update: { status: 'verified', receipt, verifiedAt: now } })
        await changeGoal(tx, goal, { status: 'completed', phase: 'idle', activeSince: null, nextEligibleAt: null, finishedAt: now }, 'completed'); return null
      }
      // Arbitrary qualitative requirements need the author's decision once
      // their persisted deliverables exist; more model rounds cannot provide
      // that authorization and would only repeat the finished work.
      if (inspection.requirements.needsAuthorVerification && inspection.blockers.length === 0 && inspection.hasDeliverable) {
        await changeGoal(tx, goal, { phase: 'awaiting_input', activeSince: null, nextEligibleAt: null,
          reasonCode: 'GOAL_COMPLETION_REVIEW_REQUIRED' }, 'completion.review_required'); return null
      }
      // A poll/admission race is not another executable round. Persist the
      // reviewed run watermark in the same transaction as the fuse update.
      const criterionId = `execution-review:${run?.id ?? 'initial'}`
      const reviewed = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: {
        goalId, revision: goal.currentRevision, criterionId,
      } } })
      const progress = reviewed ? { progressHash: goal.progressHash, blockFingerprint: goal.blockFingerprint,
        blockCount: goal.blockCount, blocked: false } : nextGoalProgress(goal, inspection.progressHash, inspection.blockers.map(item => `${item.code}:${item.id}`))
      if (!reviewed) await tx.agentGoalEvidence.create({ data: { goalId, revision: goal.currentRevision, criterionId,
        kind: 'execution-review', description: '已核对本轮执行的真实进度。', status: 'verified', verifiedAt: now,
        receipt: runtimeJson({ runId: run?.id ?? null, progressHash: inspection.progressHash,
          blockerFingerprint: progress.blockFingerprint }).value,
      } })
      if (progress.blocked) {
        await changeGoal(tx, goal, { progressHash: progress.progressHash, blockFingerprint: progress.blockFingerprint, blockCount: progress.blockCount,
          status: 'blocked', phase: 'idle', activeSince: null, nextEligibleAt: null, reasonCode: 'GOAL_NO_PROGRESS' }); return null
      }
      if (!reviewed || goal.phase !== 'queued' || goal.activeSince || goal.reasonCode) {
        goal = (await changeGoal(tx, goal, { progressHash: progress.progressHash, blockFingerprint: progress.blockFingerprint, blockCount: progress.blockCount,
          phase: 'queued', activeSince: null, nextEligibleAt: now, reasonCode: null })).goal
      }
    }
    if (await tx.agentQueuedRequest.count({ where: { sessionId, status: { in: ['pending', 'held'] } } })) return null
    const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId, revision: goal.currentRevision } } })
    return { kind: 'dispatch' as const, goal, objective: revision.objective, options: agentGoalExecutionOptionsSchema.parse(goal.executionOptions) }
  })
  revokedRunIds.forEach(stopAgentRun)
  if (!action) return
  if (action.kind === 'pause') {
    await actOnAgentGoal(userId, sessionId, goalId, { requestId: randomUUID(), expectedStateVersion: action.version, action: 'pause' }); return
  }
  if (action.kind === 'activation_continue') {
    try { await (await import('./run-service.js')).continueActivatedGoalRun(userId, action.runId, action.goal.id, action.goal.epoch) }
    catch (error) {
      const code = error instanceof DataAccessError ? error.code : 'GOAL_DISPATCH_UNAVAILABLE'
      if (['RUN_IN_PROGRESS', 'RUN_LIMIT', 'RUNTIME_LEASE_BUSY', 'GOAL_VERSION_CONFLICT'].includes(code)) return
      await runtimeTransaction(async tx => {
        const goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
        if (goal.epoch !== action.goal.epoch || goal.status !== 'active') return
        await changeGoal(tx, goal, { status: code.startsWith('CREDITS_') ? 'usage_limited' : code.includes('EXHAUSTED') ? 'budget_limited' : 'blocked',
          phase: 'idle', nextEligibleAt: null, activeSince: null, reasonCode: code })
      })
    }
    return
  }
  try {
    const goal = action.goal
    await startLoopRun(userId, { ...action.options, sessionId, novelId: goal.novelId, prompt: action.objective }, { goal: {
      goalId, revision: goal.currentRevision, epoch: goal.epoch, continuationIndex: goal.continuationIndex,
      trigger: goal.continuationIndex === 0 ? 'author' : 'goal_auto', sourceEventId: `${goalId}:${goal.currentRevision}:${goal.continuationIndex + 1}`,
    } })
  } catch (error) {
    const code = error instanceof DataAccessError ? error.code : 'GOAL_DISPATCH_UNAVAILABLE'
    if (['RUN_IN_PROGRESS', 'RUN_LIMIT', 'GOAL_VERSION_CONFLICT', 'GOAL_AUTHOR_MESSAGE_PENDING', 'GOAL_EXECUTION_FENCED'].includes(code)) {
      // A transient admission race must not make the same terminal run count
      // as three fresh no-progress rounds while the goal remains queued.
      if (['RUN_IN_PROGRESS', 'RUN_LIMIT'].includes(code)) await runtimeTransaction(async tx => {
        const current = await lockOwnedGoal(tx, userId, sessionId, goalId)
        if (current.status !== 'active' || current.epoch !== action.goal.epoch || current.continuationIndex !== action.goal.continuationIndex) return
        const now = await databaseNow(tx)
        await changeGoal(tx, current, { nextEligibleAt: new Date(now.getTime() + 5_000) }, 'dispatch.backoff')
      })
      return
    }
    await runtimeTransaction(async tx => {
      const goal = await lockOwnedGoal(tx, userId, sessionId, goalId)
      if (goal.status !== 'active' || goal.epoch !== action.goal.epoch || goal.continuationIndex !== action.goal.continuationIndex) return
      const status = code.startsWith('CREDITS_') ? 'usage_limited' : code === 'GOAL_BUDGET_EXHAUSTED' ? 'budget_limited' : 'blocked'
      await changeGoal(tx, goal, { status, phase: 'idle', reasonCode: code, nextEligibleAt: null })
    })
  }
}

let scanCursor: string | undefined
export async function dispatchAgentGoals() {
  // Cursor only provides fairness; every decision remains DB fenced. Waiting
  // goals cannot permanently occupy the first batch and starve later sessions.
  const goals = await prisma.agentGoal.findMany({ where: { OR: [{ status: { in: ['active', 'updating'] } }, { pendingRevision: { not: null } },
    { evidence: { some: { criterionId: 'activation-source', receipt: { path: ['baselineBound'], equals: false } } } }] },
    select: { id: true, userId: true, sessionId: true }, orderBy: { id: 'asc' }, take: 50,
    ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}) })
  scanCursor = goals.length === 50 ? goals.at(-1)?.id : undefined
  for (const goal of goals) {
    try { await superviseAgentGoal(goal.userId, goal.sessionId, goal.id) }
    catch (error) { console.error('[agent-goal] 调度待恢复', { goalId: goal.id, code: error instanceof DataAccessError ? error.code : 'DATABASE_UNAVAILABLE' }) }
  }
}
