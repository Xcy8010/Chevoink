import type { AgentGoal } from '@prisma/client'
import { getActiveRun } from './active-runs.js'
import { activationReceiptSchema, readActivationSource, readGoalActivationReceipt } from './goal-activation.js'
import { changeGoal, goalError, type GoalTx } from './goal-store.js'
import { inspectGoalEvidence } from './goal-evidence.js'
import { recoverLegacyRunUsage, recoverRunElapsedMs } from './checkpoint.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { runtimeJson } from './runtime-common.js'
import { hasAuthorEnded } from './completion-guard.js'
import { z } from 'zod'
import { readExecutionFrame } from './runtime-state.js'

async function hasDurableCompletionReceipt(tx: GoalTx, rootId: string, runId: string) {
  const event = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: rootId, runId, type: 'execution.completion.decided' }, orderBy: { sequence: 'desc' } })
  const decision = z.object({ version: z.literal(1), kind: z.literal('completed'), reviewOperationId: z.string(), resultHash: z.string(),
    sourceRevision: z.number().int().nonnegative(), sourceHash: z.string(), revision: z.number().int().positive(), snapshotHash: z.string() }).strict().safeParse(event?.payload)
  if (!event || !decision.success) return false
  const receipt = await tx.agentEffectReceipt.findUnique({ where: { operationId: decision.data.reviewOperationId }, include: { operation: true } })
  const proof = z.object({ version: z.literal(1), sourceRevision: z.number(), sourceHash: z.string(), candidateHash: z.string(),
    evidenceHash: z.string(), evidence: z.object({ blockers: z.array(z.never()) }).passthrough() }).safeParse(receipt?.result)
  const reviewed = z.object({ verdict: z.object({ verdict: z.literal('complete') }) }).safeParse(receipt?.result)
  const before = await readExecutionFrame(tx, rootId, decision.data.sourceRevision)
  const frame = await readExecutionFrame(tx, rootId, decision.data.revision)
  const candidate = before.state.messages.at(-1)
  const validProof = receipt?.operation.action === 'completion_finalize' && proof.success && candidate?.role === 'assistant'
    && proof.data.sourceRevision === decision.data.sourceRevision && proof.data.sourceHash === decision.data.sourceHash
    && runtimeJson(proof.data.evidence).hash === proof.data.evidenceHash
    && proof.data.candidateHash === runtimeJson({ content: candidate.content, reasoning: candidate.reasoning ?? null }).hash
  return Boolean(receipt && (validProof || receipt.operation.action === 'completion_review' && reviewed.success)
    && receipt.operation.taskRootId === rootId && receipt.operation.status === 'succeeded'
    && event.operationId === receipt.operationId && event.eventKey === `decision:${receipt.operationId}`
    && runtimeJson(receipt.result).hash === decision.data.resultHash && receipt.resultHash === decision.data.resultHash
    && receipt.operation.inputSnapshot && runtimeJson(receipt.operation.inputSnapshot).hash === receipt.operation.inputHash
    && decision.data.revision === decision.data.sourceRevision + 1 && before.snapshotHash === decision.data.sourceHash
    && frame.snapshotHash === decision.data.snapshotHash && frame.state.phase === 'completed'
    && runtimeJson(frame.state.messages).hash === runtimeJson(before.state.messages).hash)
}

/** Only source receipts may account for ordinary work. No charge, provider call,
 * new task root, reconstructed prompt or new budget is created here. */
export async function reconcileGoalActivation(tx: GoalTx, goal: AgentGoal, now: Date): Promise<boolean | { kind: 'activation_continue'; goal: AgentGoal; runId: string }> {
  const activation = await readGoalActivationReceipt(tx, goal)
  if (!activation) return false
  if (goal.currentRevision !== 1 || activation.receipt.baselineBound && goal.pendingRevision) return false
  // Activation remains a distinct protocol after binding. Normal goal dispatch
  // is forbidden from turning a completed ordinary task into a new paid root.
  if (goal.pendingRevision) return true
  const saved = activation.receipt
  const source = await readActivationSource(tx, { userId: goal.userId, novelId: goal.novelId, sessionId: goal.sessionId, runId: saved.sourceRunId })
  const immutable = { ...saved, baselineBound: false }
  const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: 1 } } })
  if (saved.sourceRootId !== source.sourceRootId || saved.sourceMessageId !== source.original.id
    || saved.startHash !== runtimeJson(source.run.startRequest).hash || saved.specHash !== runtimeJson(source.run.taskSpec).hash
    || saved.messageHash !== runtimeJson(source.original.parts).hash || saved.requestHash !== source.admitted.grant.requestHash
    || saved.optionsHash !== runtimeJson(source.options).hash || saved.authorityHash !== runtimeJson(saved.toolAuthority).hash
    || saved.consentHash !== source.consentHash || saved.consentRequestId !== (source.journal?.row.id ?? null) || revision.authorityHash !== runtimeJson(immutable).hash
    || revision.objective !== source.objective || runtimeJson(goal.executionOptions).hash !== saved.optionsHash) {
    return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '目标原始授权或执行配置已变化，需要作者处理。')
  }
  const runs = await tx.agentRun.findMany({ where: { userId: goal.userId, novelId: goal.novelId, sessionId: goal.sessionId,
    ...(source.run.taskRootId ? { taskRootId: saved.sourceRootId } : { taskSpec: { path: ['id'], equals: saved.sourceRootId } }) },
    include: { events: { where: { type: { in: ['run.started', 'run.paused', 'run.finished'] } }, orderBy: { seq: 'asc' } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (!runs.some(run => run.id === saved.sourceRunId) || !runs.some(run => run.id === saved.activationRunId)) return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '原执行链缺失，不能推测剩余任务。')
  const runIds = runs.map(run => run.id)
  for (const id of [...runIds].sort()) await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${id} FOR UPDATE`
  if (source.run.taskRootId) await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${source.run.taskRootId} FOR UPDATE`
  const children = await tx.agentRun.findMany({ where: { userId: goal.userId, novelId: goal.novelId,
    session: { spawnedFromRunId: { in: runIds } } }, select: { id: true, status: true, taskRootId: true } })
  if ([...runs, ...children].some(run => ['queued', 'running', 'awaiting_approval'].includes(run.status) || getActiveRun(run.id))) return true
  const allIds = [...runIds, ...children.map(run => run.id)]
  if (await tx.agentRunLease.count({ where: { runId: { in: allIds }, expiresAt: { gt: now } } })) return true
  const allRoots = [...new Set([...runs, ...children].flatMap(run => run.taskRootId ? [run.taskRootId] : []))]
  const latest = runs.at(-1)!
  const authorResume = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: { goalId: goal.id, revision: 1, criterionId: 'activation-resume' } } })
  const resume = authorResume?.status === 'verified' && authorResume.receipt && typeof authorResume.receipt === 'object' && !Array.isArray(authorResume.receipt)
    && authorResume.receipt.epoch === String(goal.epoch) && authorResume.receipt.sourceRunId === latest.id
  const unresolved = allRoots.length ? await tx.agentOperation.findMany({ where: { taskRootId: { in: allRoots }, status: { in: ['prepared', 'dispatched', 'unknown'] } } }) : []
  if (unresolved.length) {
    if (goal.status !== 'active' || !resume || latest.status !== 'paused' || !latest.taskRootId || unresolved.length !== 1) return true
    const pending = unresolved[0]
    if (pending.status !== 'prepared' || pending.taskRootId !== latest.taskRootId || !['tool', 'provider'].includes(pending.kind)
      || !runIds.includes(pending.originRunId) || !pending.inputSnapshot || runtimeJson(pending.inputSnapshot).hash !== pending.inputHash
      || await tx.agentEffectReceipt.count({ where: { operationId: pending.id } })
      || await tx.agentProviderAttempt.count({ where: { operationId: pending.id } })) return true
    // The existing tool/model recovery paths use precisely this saved cursor.
    // A prepared operation has no effects and is not cancelled or recreated.
    const current = await readExecutionStateInTransaction(tx, latest.taskRootId)
    if (current.frame.state.phase !== 'awaiting_operation' || current.frame.state.pendingOperationId !== pending.id || current.frame.revision < 1) return true
    const before = await readExecutionFrame(tx, latest.taskRootId, current.frame.revision - 1)
    if (before.state.phase !== 'idle' || pending.operationKey !== `exec:${before.state.nextOperationSequence}`
      || current.frame.state.nextOperationSequence !== before.state.nextOperationSequence + 1
      || current.frame.state.turn !== before.state.turn + (pending.kind === 'provider' ? 1 : 0)
      || runtimeJson(current.frame.state.messages).hash !== runtimeJson(before.state.messages).hash) return true
  }
  const logs = await tx.aiUsageLog.findMany({ where: { userId: goal.userId, agentRunId: { in: allIds } } })
  const attempts = await tx.agentProviderAttempt.findMany({ where: { runId: { in: allIds } }, include: { usageReceipt: true } })
  if (attempts.some(attempt => ['prepared', 'dispatched', 'unknown'].includes(attempt.status))) return true
  const keys = [...logs.map(log => ({ key: `legacy:${log.id}`, runId: log.agentRunId! })), ...attempts.map(attempt => ({ key: `durable:${attempt.id}`, runId: attempt.runId }))]
  // Monotone seed. syncGoal*Usage uses the existing real settlement receipts on
  // the next supervisor poll; missing/unknown measurements stay unresolved.
  let seeded = false
  for (const key of keys) {
    const prior = await tx.agentGoalUsage.findUnique({ where: { sourceKey: key.key } })
    if (prior && (prior.goalId !== goal.id || prior.runId !== key.runId)) return goalError('GOAL_SCOPE_MISMATCH', '原执行用量已有其他目标归属。')
    if (!prior) {
      await tx.agentGoalUsage.create({ data: { sourceKey: key.key, goalId: goal.id, runId: key.runId, status: 'unknown' } })
      seeded = true
    }
  }
  if (seeded || await tx.agentGoalUsage.count({ where: { goalId: goal.id, status: { in: ['unknown', 'reserved'] } } })) return true
  if (runs.some(run => !run.taskRootId && !recoverLegacyRunUsage(run.currentTurn, logs.filter(log => log.agentRunId === run.id && log.providerType === 'text' && log.turn !== null)))) return true
  let activeTimeMs = 0n
  const durableState = source.run.taskRootId ? await readExecutionStateInTransaction(tx, source.run.taskRootId) : null
  const durableBoundaries = source.run.taskRootId ? await tx.agentExecutionOutbox.findMany({ where: { taskRootId: source.run.taskRootId,
    type: { in: ['run.paused', 'execution.completion.decided'] } }, orderBy: { sequence: 'asc' } }) : []
  for (const run of runs) {
    if (!run.startedAt) { if (run.currentTurn > 0) return true; continue }
    const events = run.taskRootId ? durableBoundaries.filter(event => event.runId === run.id || event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      && Array.isArray(event.payload.runIds) && event.payload.runIds.includes(run.id)).map(event => ({ type: event.type === 'run.paused' ? 'run.paused' : 'run.finished', at: event.createdAt.getTime() }))
      : run.events.map(event => ({ type: event.type, at: event.createdAt.getTime() }))
    const last = events.at(-1)
    if (!last || !['run.paused', 'run.finished'].includes(last.type)) return true
    const elapsed = recoverRunElapsedMs(run.startedAt.getTime(), last.at, events)
    if (elapsed === null) return true
    activeTimeMs += BigInt(elapsed)
  }
  const existingBudget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId: goal.id } })
  if (activeTimeMs > existingBudget.activeTimeMs) await tx.agentGoalBudget.update({ where: { goalId: goal.id }, data: { activeTimeMs } })
  if (!saved.baselineBound) {
    let index = goal.continuationIndex
    for (const run of [...runs, ...children]) {
      const previous = await tx.agentGoalExecution.findUnique({ where: { runId: run.id } })
      if (previous && previous.goalId !== goal.id) return goalError('GOAL_SCOPE_MISMATCH', '原任务已归属另一个目标。')
      if (!previous) await tx.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: goal.epoch,
        runId: run.id, taskRootId: run.taskRootId, continuationIndex: ++index, trigger: 'author',
        sourceEventId: `activation:${goal.id}:${run.id}`, ...(children.some(child => child.id === run.id) ? { trigger: 'subagent' } : {}) } })
    }
    await tx.agentGoalEvidence.update({ where: { id: activation.evidence.id }, data: { receipt: runtimeJson(activationReceiptSchema.parse({ ...saved, baselineBound: true })).value } })
    goal = (await changeGoal(tx, goal, { continuationIndex: index }, 'activation.baseline_bound')).goal
  }
  // Late receipts settle paused/cancelled goals without reviving their source.
  if (goal.status !== 'active') return true
  if (latest.status === 'completed' && durableState && durableState.frame.state.phase !== 'completed') return true
  const completed = latest.status === 'completed' && (!latest.taskRootId || await hasDurableCompletionReceipt(tx, latest.taskRootId, latest.id))
  if (hasAuthorEnded(latest.usage)) {
    await changeGoal(tx, goal, { status: 'cancelled', phase: 'idle', nextEligibleAt: null, activeSince: null, reasonCode: 'AUTHOR_CANCELLED', finishedAt: now }, 'cancelled')
    return true
  }
  const inspection = await inspectGoalEvidence(tx, goal)
  if (completed && !inspection.needsScopeDecision && inspection.blockers.length === 0 && inspection.hasDeliverable) {
    if (!inspection.requirements.needsAuthorVerification) {
      await tx.agentGoalEvidence.upsert({ where: { goalId_revision_criterionId: { goalId: goal.id, revision: 1, criterionId: 'author-objective' } },
        create: { goalId: goal.id, revision: 1, criterionId: 'author-objective', kind: 'objective', description: inspection.objective,
          status: 'verified', receipt: { source: 'domain-evidence', progressHash: inspection.progressHash }, verifiedAt: now },
        update: { status: 'verified', receipt: { source: 'domain-evidence', progressHash: inspection.progressHash }, verifiedAt: now } })
      await changeGoal(tx, goal, { status: 'completed', phase: 'idle', activeSince: null, nextEligibleAt: null, finishedAt: now, reasonCode: null }, 'completed')
      return true
    }
  }
  const budget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId: goal.id } })
  const limited = budget.tokensUsed >= budget.tokenLimit || budget.activeTimeMs >= budget.activeTimeLimitMs
  if (resume && !limited && ['paused', 'failed'].includes(latest.status)) {
    // The consumed human grant is durable. Dispatch retries reuse the same
    // goal epoch and source cursor; they cannot invent a second attempt.
    const changed = goal.reasonCode === 'GOAL_ACTIVATION_RESUME_READY' ? goal
      : (await changeGoal(tx, goal, { currentRunId: latest.id, reasonCode: 'GOAL_ACTIVATION_RESUME_READY', phase: 'queued' }, 'activation.resume_ready')).goal
    return { kind: 'activation_continue', goal: changed, runId: latest.id }
  }
  const status = limited ? 'budget_limited' : latest.status === 'failed' ? 'blocked' : latest.status === 'paused' ? 'paused' : 'active'
  const reasonCode = limited ? 'GOAL_BUDGET_EXHAUSTED' : latest.status === 'failed' ? 'GOAL_SOURCE_FAILED'
    : inspection.hasDeliverable && inspection.blockers.length === 0 ? 'GOAL_COMPLETION_REVIEW_REQUIRED'
      : 'GOAL_ACTIVATION_AUTHOR_INPUT_REQUIRED'
  if (goal.status !== status || goal.reasonCode !== reasonCode || goal.phase !== 'awaiting_input') {
    await changeGoal(tx, goal, { status, phase: 'awaiting_input', activeSince: null, nextEligibleAt: null, reasonCode }, 'activation.waiting')
  }
  // Completed source without proof and every explicit pause/failure wait for
  // human input. Model prose cannot authorize replay of the source request.
  return true
}
