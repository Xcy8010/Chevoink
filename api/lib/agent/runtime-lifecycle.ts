import { randomUUID } from 'node:crypto'
import { databaseNow, lockOwnedRun, lockRunRoot, runtimeError, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import type { RunLeaseToken } from './runtime-lease.js'
import { MODEL_STALLED_MESSAGE } from './runtime-common.js'
import { collectCompletionEvidenceInTransaction } from './runtime-completion-evidence.js'
import { prepareOperationInTransaction, commitOperationEffectInTransaction } from './runtime-operations.js'
import { promisesFurtherAction } from './completion-guard.js'
import { z } from 'zod'
import { assertRunGoalFence } from './goal-fence.js'
import { assertChildParentFence, assertPinnedChildCompletion, pauseChildGrants } from './runtime-child.js'
import { readParentContentionScope } from './runtime-parent-contention.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { readSavedWritingPresentation, savedChapterPresentationProof } from './writing-scope.js'

const liveStatuses = ['queued', 'running', 'awaiting_approval'] as const
const maxEpoch = 9223372036854775807n

/** Existing completion checks plus atomic receipt/state/outbox publication.
 * This is not another model call or a new semantic review policy. */
export async function finalizeDurableTask(token: RunLeaseToken, cursor: { expectedRevision: number; expectedHash: string }) {
  const lease = { ...token }, expected = { ...cursor }
  const contentionScope = await readParentContentionScope(lease.userId, lease.runId, true)
  return runtimeTransaction(async tx => {
    const identity = await tx.agentRun.findFirst({ where: { id: lease.runId, userId: lease.userId, taskRootId: lease.taskRootId }, select: { novelId: true } })
    if (!identity) return runtimeError('RUNTIME_SCOPE_MISMATCH', '终态作品身份无法核实。')
    await lockNovelActiveScope(tx, identity.novelId)
    const { lockWritingRunLineage } = await import('./writing-scope.js')
    await lockWritingRunLineage(tx, { userId: lease.userId, novelId: identity.novelId, runId: lease.runId })
    await assertRunGoalFence(tx, lease.userId, lease.runId)
    if (lease.parent) await assertRunGoalFence(tx, lease.userId, lease.parent.runId)
    const { run, root } = await lockRunRoot(tx, lease.userId, lease.runId)
    const parent = await assertChildParentFence(tx, run.id, lease.parent)
    if (parent && !lease.parent) return runtimeError('RUNTIME_PARENT_LEASE_LOST', '子任务终态缺少父任务执行代次。')
    const held = await tx.agentRunLease.findUnique({ where: { runId: run.id } })
    const now = await databaseNow(tx)
    if (root.id !== lease.taskRootId || root.authorizationMode !== 'legacy' || root.status !== 'active' || !['queued', 'running'].includes(run.status)
      || !held?.enabled || held.ownerId !== lease.ownerId || held.claimId !== lease.claimId || held.epoch !== lease.epoch
      || !held.expiresAt || held.expiresAt <= now) return runtimeError('RUNTIME_LEASE_LOST', '终态提交已失去原执行所有权。')
    const evidence = await collectCompletionEvidenceInTransaction(tx, lease, expected)
    const childGrants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: root.id }, include: { childRun: { include: { taskRoot: true } } } })
    if (childGrants.some(grant => grant.status !== 'completed' || grant.childRun.status !== 'completed' || grant.childRun.taskRoot?.status !== 'completed')) return runtimeError('RUNTIME_CHILD_COMPLETION_REQUIRED', '子任务尚未获得真实完成终态，父任务不能宣称完成。')
    await assertPinnedChildCompletion(tx, root.id)
    const facts = z.object({ blockers: z.array(z.unknown()), candidateHash: z.string() }).parse(evidence.snapshot)
    const { frame } = await readExecutionStateInTransaction(tx, root.id)
    const candidate = frame.state.messages.at(-1)
    if (facts.blockers.length || candidate?.role !== 'assistant' || !candidate.content?.trim() || promisesFurtherAction(candidate.content)) {
      return runtimeError('RUNTIME_COMPLETION_BLOCKED', '原任务仍有未完成事项，不能提交完成终态。')
    }
    // Ordinary completion has already passed. Only serialize a verified saved
    // chapter presentation; preserve the paid candidate and frame unchanged.
    const subject = { userId: lease.userId, novelId: root.novelId, runId: run.id }
    const savedPresentation = await readSavedWritingPresentation(tx, subject)
    const chapterPresentation = savedPresentation && candidate.content !== savedPresentation.text ? savedChapterPresentationProof(subject, savedPresentation) : null
    const operation = await prepareOperationInTransaction(tx, lease, {
      key: `finalize:${frame.revision}`, kind: 'internal', action: 'completion_finalize',
      input: runtimeJson({ sourceRevision: frame.revision, sourceHash: frame.snapshotHash, evidenceHash: evidence.snapshotHash,
        ...(chapterPresentation ? { chapterPresentation } : {}) }).value,
    })
    const receipt = await commitOperationEffectInTransaction(tx, lease, operation.id, operation.inputHash,
      async () => runtimeJson({ version: 1, sourceRevision: frame.revision, sourceHash: frame.snapshotHash,
        candidateHash: facts.candidateHash, evidenceHash: evidence.snapshotHash, evidence: evidence.snapshot,
        ...(chapterPresentation ? { chapterPresentation } : {}) }).value)
    const next = await saveExecutionStateInTransaction(tx, lease, { ...expected,
      snapshot: { ...frame.state, phase: 'completed' } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: run.id, operationId: operation.id,
      eventKey: `decision:${operation.id}`, type: 'execution.completion.decided', payload: {
        version: 1, kind: 'completed', reviewOperationId: operation.id, resultHash: receipt.resultHash,
        sourceRevision: frame.revision, sourceHash: frame.snapshotHash, revision: next.revision, snapshotHash: next.snapshotHash,
      } } })
    await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'completed' } })
    await tx.agentRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: now, errorMessage: null } })
    await tx.agentRunLease.updateMany({ where: { run: { taskRootId: root.id } },
      data: { enabled: false, ownerId: null, claimId: null, expiresAt: null } })
    if (held.expiresAt <= await databaseNow(tx)) return runtimeError('RUNTIME_LEASE_LOST', '终态提交前原执行所有权已过期。')
    await assertChildParentFence(tx, run.id, lease.parent)
    await tx.agentChildExecutionGrant.updateMany({ where: { childRunId: run.id }, data: { status: 'completed' } })
    return { kind: 'completed' as const, frame: next }
  }, { contentionScope, contentionBackoff: Boolean(lease.parent), deadline: contentionScope?.deadline })
}

/** Close the read/abort/admission race: queued legacy runs cannot migrate after a stop. */
export async function fenceLocallyStoppedLegacyRun(userId: string, runId: string): Promise<boolean> {
  return runtimeTransaction(async tx => {
    const run = await lockOwnedRun(tx, userId, runId)
    if (run.runtimeProtocolVersion !== 0 || run.taskRootId) return false
    if (run.status === 'queued') await tx.agentRun.update({ where: { id: run.id }, data: { status: 'paused' } })
    return true
  })
}

/** Persist the stop fence before acknowledging or merely aborting a local controller.
 * This pauses one explicit task root, never every task in the same session/novel. */
export async function pauseDurableTask(userId: string, runId: string) {
  return pauseTask(userId, runId)
}

/** Internal executor handoff, after heartbeat cleanup. A stale worker cannot
 * pause a replacement owner or a newer saved execution frame. */
export async function pauseDurableTaskForAttention(token: RunLeaseToken, cursor: { expectedRevision: number; expectedHash: string }, reason: 'model_stalled' | 'needs_input' = 'model_stalled') {
  const lease = { ...token }
  return pauseTask(lease.userId, lease.runId, { lease, ...cursor, reason })
}

async function pauseTask(userId: string, runId: string, attention?: { lease: RunLeaseToken; expectedRevision: number; expectedHash: string; reason: 'model_stalled' | 'needs_input' }) {
  const eventId = randomUUID()
  const contentionScope = attention ? await readParentContentionScope(userId, runId, true) : undefined
  return runtimeTransaction(async tx => {
    const { run, root } = await lockRunRoot(tx, userId, runId)
    if (root.status === 'paused') {
      const pausedRuns = await tx.agentRun.findMany({ where: { taskRootId: root.id, status: 'paused' }, select: { id: true } })
      return { stopped: true as const, runIds: pausedRuns.map(row => row.id) }
    }
    if (root.status !== 'active' || !(liveStatuses as readonly string[]).includes(run.status)) runtimeError('RUN_NOT_ACTIVE', '任务不在运行中，不能从旧入口停止其他执行。')
    let expiry: Date | null = null
    if (attention) {
      const held = await tx.agentRunLease.findUnique({ where: { runId } })
      const now = await databaseNow(tx)
      if (root.id !== attention.lease.taskRootId || !held?.enabled || held.epoch !== attention.lease.epoch || held.ownerId !== attention.lease.ownerId
        || held.claimId !== attention.lease.claimId || !held.expiresAt || held.expiresAt <= now) return runtimeError('RUNTIME_LEASE_LOST', '原执行者已失去暂停权限。')
      expiry = held.expiresAt
      const { frame } = await readExecutionStateInTransaction(tx, root.id)
      if (frame.revision !== attention.expectedRevision || frame.snapshotHash !== attention.expectedHash
        || (attention.reason === 'model_stalled' && frame.state.phase !== 'idle')) return runtimeError('RUNTIME_STATE_CONFLICT', '待处理判定已过期，不能暂停新的执行位置。')
    }
    const runs = await tx.agentRun.findMany({ where: { taskRootId: root.id, status: { in: [...liveStatuses] } }, select: { id: true } })
    const runIds = runs.map(row => row.id)
    const childRunIds = await pauseChildGrants(tx, root.id)
    // An exhausted epoch must not prevent stopping. It can never be acquired again.
    await tx.agentRunLease.updateMany({ where: { run: { taskRootId: root.id }, enabled: true, epoch: { lt: maxEpoch } }, data: { epoch: { increment: 1 } } })
    await tx.agentRunLease.updateMany({ where: { run: { taskRootId: root.id } }, data: { enabled: false, ownerId: null, claimId: null, expiresAt: null } })
    await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'paused' } })
    await tx.agentRun.updateMany({ where: { id: { in: runIds }, taskRootId: root.id }, data: { status: 'paused', errorMessage: attention
      ? attention.reason === 'model_stalled' ? MODEL_STALLED_MESSAGE : '执行遇到异常，已暂停并保留原始进度。继续前将核对未确认操作，不会自动重复执行。'
      : '任务已由用户暂停，原始状态与已提交内容保留。' } })
    await tx.agentExecutionOutbox.create({ data: { id: eventId, taskRootId: root.id, runId,
      eventKey: `pause:${eventId}`, type: 'run.paused', payload: attention ? { reason: attention.reason, runIds, sourceRevision: attention.expectedRevision, sourceHash: attention.expectedHash } : { reason: 'user_stop', runIds } } })
    if (expiry && expiry <= await databaseNow(tx)) return runtimeError('RUNTIME_LEASE_LOST', '暂停提交前原执行所有权已过期。')
    return { stopped: true as const, runIds: [...runIds, ...childRunIds] }
  }, { contentionScope, contentionBackoff: Boolean(attention?.lease.parent), deadline: contentionScope?.deadline })
}

/** Startup maintenance for protocol zero only. Admission and this update lock the same run.
 * Never mark a durable owner on another worker as orphaned just because it isn't local. */
export async function recoverLegacyOrphanRun(userId: string, runId: string): Promise<boolean> {
  return runtimeTransaction(async tx => {
    const run = await lockOwnedRun(tx, userId, runId)
    if (run.engine !== 'loop' || run.runtimeProtocolVersion !== 0 || run.taskRootId
      || !(liveStatuses as readonly string[]).includes(run.status)) return false
    // A lost process cannot tell us whether the supplier consumed tokens.
    // Preserve that uncertainty; do not charge an invented zero or redispatch.
    await tx.aiUsageLog.updateMany({ where: { userId, agentRunId: run.id, providerType: 'text', billingStatus: 'prepared', modelTier: { not: 'custom' } },
      data: { billingStatus: 'pending_usage', usageSource: 'unknown', billingRetryAt: null } })
    await tx.agentRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(),
      errorMessage: '服务更新导致任务中断。点击输入框启动按钮可继续原任务。' } })
    await tx.agentMessage.create({ data: { runId: run.id, sessionId: run.sessionId, role: 'assistant',
      parts: [{ type: 'text', text: '任务因服务更新中断。已保存内容保留，可点击输入框启动按钮继续原任务。' }] } })
    return true
  })
}

/** Returns false only if the run migrated while the route was reading it. */
export async function pauseLegacyOrphanRun(userId: string, runId: string): Promise<boolean> {
  return runtimeTransaction(async tx => {
    const run = await lockOwnedRun(tx, userId, runId)
    if (run.runtimeProtocolVersion !== 0 || run.taskRootId) return false
    if (!(liveStatuses as readonly string[]).includes(run.status)) runtimeError('RUN_NOT_ACTIVE', '任务不在运行中，无需停止。')
    await tx.aiUsageLog.updateMany({ where: { userId, agentRunId: run.id, providerType: 'text', billingStatus: 'prepared', modelTier: { not: 'custom' } },
      data: { billingStatus: 'pending_usage', usageSource: 'unknown', billingRetryAt: null } })
    await tx.agentRun.update({ where: { id: run.id }, data: { status: 'paused', errorMessage: '任务因服务重启而中断，已就地停止。' } })
    await tx.agentMessage.create({ data: { runId: run.id, sessionId: run.sessionId, role: 'assistant',
      parts: [{ type: 'text', text: '任务已暂停，已保存内容保留，可点击输入框启动按钮继续原任务。' }] } })
    return true
  })
}
