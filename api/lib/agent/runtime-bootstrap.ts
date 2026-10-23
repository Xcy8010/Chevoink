import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readHumanAdmission } from './goal-activation-authority.js'
import { durableTaskSpecIdentity } from './runtime-identity.js'
import { lockRunRoot, runtimeError, runtimeJson, runtimeTransaction, databaseNow, type RuntimeTx } from './runtime-common.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { prisma } from '../prisma.js'

export const bootstrapAdmissionSchema = z.object({ version: z.literal(1), sourceMessageId: z.string(), inputHash: z.string(),
  startHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export const bootstrapPauseSchema = z.object({ version: z.literal(1), admissionId: z.string(), inputHash: z.string(), code: z.string().regex(/^[A-Z0-9_]{1,96}$/) }).strict()
const bootstrapResumeSchema = z.object({ pauseId: z.string(), admissionId: z.string(), inputHash: z.string() }).strict()

/** Historical verification remains valid after the first frame is saved. */
export async function readFreshBootstrapResume(tx: RuntimeTx, userId: string, runId: string, sourceId: string) {
  const original = await readFreshBootstrapAdmission(tx, userId, runId)
  const source = await tx.agentExecutionOutbox.findUnique({ where: { id: sourceId } })
  const payload = bootstrapResumeSchema.safeParse(source?.payload)
  const pause = payload.success ? await tx.agentExecutionOutbox.findUnique({ where: { id: payload.data.pauseId } }) : null
  const failed = bootstrapPauseSchema.safeParse(pause?.payload)
  const stopped = z.object({ reason: z.literal('user_stop'), runIds: z.array(z.string()) }).strict().safeParse(pause?.payload)
  if (!source || source.type !== 'execution.bootstrap.resumed' || source.runId !== runId || source.taskRootId !== original.root.id
    || !payload.success || payload.data.admissionId !== original.admission.id || payload.data.inputHash !== original.root.inputHash
    || source.eventKey !== `bootstrap-resume:${payload.data.pauseId}` || !pause || pause.runId !== runId || pause.taskRootId !== original.root.id || source.sequence <= pause.sequence
    || !(pause.type === 'execution.bootstrap.paused' && pause.eventKey === `bootstrap-pause:${pause.id}` && failed.success
      && failed.data.admissionId === original.admission.id && failed.data.inputHash === original.root.inputHash
      || pause.type === 'run.paused' && pause.eventKey === `pause:${pause.id}` && stopped.success && stopped.data.runIds.includes(runId))) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '初始化继续与原暂停、请求不一致。')
  }
  return { ...original, source, pause }
}

/** Authenticate a genuine new HTTP task/goal admission. This is a reader, not an issuer
 * for old runs with missing frames or user-role/model-generated instructions. */
export async function readFreshBootstrapAdmission(tx: RuntimeTx, userId: string, runId: string) {
  const { run, root } = await lockRunRoot(tx, userId, runId)
  const admission = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `bootstrap:${root.id}` } })
  const parsed = bootstrapAdmissionSchema.safeParse(admission?.payload)
  const human = readHumanAdmission(run.startRequest), original = durableTaskSpecIdentity(run.taskSpec)
  const goalSource = await (await import('./fresh-goal-source.js')).readFreshGoalBootstrapSource(tx, userId, runId)
  const request = goalSource?.request ?? human?.request
  if (!admission || admission.type !== 'execution.bootstrap.admitted' || admission.runId !== runId || admission.taskRootId !== root.id
    || !parsed.success || parsed.data.sourceMessageId !== root.sourceMessageId || parsed.data.inputHash !== root.inputHash
    || (goalSource || parsed.data.startHash !== undefined) && parsed.data.startHash !== runtimeJson(run.startRequest).hash
    || goalSource && goalSource.binding.taskRootId !== root.id
    || root.authorizationMode !== 'legacy' || !request || request.sessionId !== run.sessionId || request.novelId !== run.novelId
    || !original.spec.scope.capabilityCatalog || original.frozen.hash !== runtimeJson(root.specSnapshot).hash
    || runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash !== root.inputHash) {
    return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '缺少本次真实新任务的原始准入，不能重建旧执行状态。')
  }
  const message = await tx.agentMessage.findFirst({ where: { id: root.sourceMessageId, runId, sessionId: run.sessionId, role: 'user' } })
  const parts = [{ type: 'text', text: request.prompt }, ...(request.attachments ?? []).map(item => ({ type: 'attachment', kind: item.kind, name: item.name, url: item.url, size: item.size }))]
  if (!message || runtimeJson(message.parts).hash !== runtimeJson(root.requestSnapshot).hash
    || runtimeJson(JSON.parse(JSON.stringify(parts))).hash !== runtimeJson(root.requestSnapshot).hash) {
    return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '新任务原始请求与冻结输入不一致。')
  }
  return { run, root, admission, goalSource }
}

export async function assertUnstartedFreshBootstrap(tx: RuntimeTx, userId: string, runId: string) {
  const current = await readFreshBootstrapAdmission(tx, userId, runId)
  const id = current.root.id
  if (await tx.agentExecutionState.findUnique({ where: { taskRootId: id } })
    || await tx.agentExecutionFrame.count({ where: { taskRootId: id } })
    || await tx.agentOperation.count({ where: { taskRootId: id } })
    || await tx.aiUsageLog.count({ where: { agentRunId: runId } })
    || await tx.webToolCall.count({ where: { runId } })
    || await tx.agentResearchRequest.count({ where: { ownerRunId: runId } })
    || await tx.agentRuntimeCheckpoint.count({ where: { taskRootId: id } })
    || await tx.agentRun.count({ where: { taskRootId: id, id: { not: runId } } })
    || await tx.agentChildExecutionGrant.count({ where: { OR: [{ childRunId: runId }, { parentRootId: id }] } })
    || !current.goalSource && await tx.agentGoalExecution.count({ where: { runId } })) {
    return runtimeError('RUNTIME_STATE_REQUIRED', '已有原执行事实，不能从初始化入口重新装配或重复请求。')
  }
  const { budget } = await readTaskBudgetInTransaction(tx, id)
  if (budget.checkpointCount !== 0 || budget.compactionCount !== 0) return runtimeError('RUNTIME_BUDGET_INVALID', '原始任务预算不完整，不能重新分配。')
  return current
}

/** Before any model operation exists, a bootstrap failure may preserve a
 * truthful paused task. A committed initial frame or live owner is untouched. */
export async function pauseFreshBootstrap(userId: string, runId: string, code: string): Promise<boolean> {
  return runtimeTransaction(async tx => {
    const owned = await tx.agentRun.findFirst({ where: { id: runId, userId }, select: { taskRootId: true } })
    if (!owned?.taskRootId || await tx.agentExecutionState.findUnique({ where: { taskRootId: owned.taskRootId } })) return false
    // Goal controls acquire novel/goal before run/root, matching the original
    // lease/effect order. A concurrently paused goal cannot be reactivated.
    const goalContext = await (await import('./goal-fence.js')).assertRunGoalFence(tx, userId, runId)
    const { run, root, admission } = await assertUnstartedFreshBootstrap(tx, userId, runId)
    if (root.status !== 'active' || run.status !== 'queued') return false
    const held = await tx.agentRunLease.findUnique({ where: { runId } })
    if (held?.expiresAt && held.expiresAt > await databaseNow(tx)) return false
    await tx.agentRunLease.updateMany({ where: { runId, epoch: { lt: 9223372036854775807n } }, data: { epoch: { increment: 1 } } })
    await tx.agentRunLease.updateMany({ where: { runId }, data: { enabled: false, ownerId: null, claimId: null, expiresAt: null } })
    await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'paused' } })
    await tx.agentRun.update({ where: { id: runId }, data: { status: 'paused', errorMessage: '任务初始化未完成，尚未发起模型请求。原始需求已保留，可继续恢复。' } })
    const payload = bootstrapPauseSchema.parse({ version: 1, admissionId: admission.id, inputHash: root.inputHash,
      code: /^[A-Z0-9_]{1,96}$/.test(code) ? code : 'RUNTIME_BOOTSTRAP_UNAVAILABLE' })
    const eventId = randomUUID()
    await tx.agentExecutionOutbox.create({ data: { id: eventId, taskRootId: root.id, runId, eventKey: `bootstrap-pause:${eventId}`,
      type: 'execution.bootstrap.paused', payload } })
    if (goalContext) {
      const { closeGoalActivity, changeGoal } = await import('./goal-store.js')
      const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: goalContext.goalId } })
      await closeGoalActivity(tx, goal, await databaseNow(tx))
      await changeGoal(tx, goal, { status: 'blocked', phase: 'idle', activeSince: null, nextEligibleAt: null, reasonCode: payload.code })
    }
    return true
  })
}

/** Explicit Continue before the first frame. Same root, request and budget;
 * no bootstrap path exists for historical missing/corrupt execution states. */
export async function resumeFreshBootstrap(userId: string, runId: string) {
  return runtimeTransaction(tx => resumeFreshBootstrapInTransaction(tx, userId, runId))
}

/** Goal controls already hold the owned goal fence. A new goal attempt must
 * not allocate a second root/budget while the first has not acquired a frame. */
export async function resumeFreshBootstrapInTransaction(tx: RuntimeTx, userId: string, runId: string, goalId?: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${userId}`}, 0))::text`
    const identity = await tx.agentRun.findFirst({ where: { id: runId, userId }, select: { novelId: true, taskRootId: true } })
    if (!identity?.taskRootId || await tx.agentExecutionState.findUnique({ where: { taskRootId: identity.taskRootId } })) return null
    await lockNovelActiveScope(tx, identity.novelId)
    const { run, root, admission, goalSource } = await assertUnstartedFreshBootstrap(tx, userId, runId)
    if (goalSource) {
      const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: goalSource.binding.goalId } })
      if (goalId !== goal.id || goal.userId !== userId || goal.status !== 'active' || goal.currentRevision !== 1
        || goal.pendingRevision !== null || goal.currentRunId !== runId || goal.phase !== 'executing' || !goal.activeSince) {
        return runtimeError('GOAL_RESUME_REQUIRED', '请使用原目标的继续操作。')
      }
    } else if (goalId) return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '缺少目标原始初始化准入。')
    if (goalSource) {
      // The genuine goal resume still holds the old, paused run/epoch here.
      // Check manuscript identity now; recheck the live goal fence after its
      // original binding/status CAS below, inside this same transaction.
      await (await import('./manuscript-scope.js')).assertAgentManuscriptRevisionCurrent(tx, { userId, runId, novelId: run.novelId })
    } else await assertAgentManuscriptCurrent(tx, { userId, runId, novelId: run.novelId })
    const latest = await tx.agentRun.findFirst({ where: { sessionId: run.sessionId, ...MAIN_RUN_FILTER }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })
    if (latest?.id !== runId) return runtimeError('STALE_RESUME_TARGET', '当前会话已有后续任务，不能恢复旧初始化。')
    if (root.status !== 'paused' || run.status !== 'paused') return runtimeError('RUN_NOT_PAUSED', '仅本次暂停的新任务初始化可继续。')
    const held = await tx.agentRunLease.findUnique({ where: { runId } })
    if (!held || held.enabled || !goalSource && (held.ownerId || held.claimId || held.expiresAt)) return runtimeError('RUNTIME_STATE_CONFLICT', '初始化暂停的原所有权尚未完整撤销，不能恢复。')
    if (held.epoch >= 9223372036854775807n) return runtimeError('RUNTIME_EPOCH_EXHAUSTED', '执行代次超限，需要核对。')
    const pause = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: root.id, runId,
      type: { in: ['execution.bootstrap.paused', 'run.paused'] } }, orderBy: { sequence: 'desc' } })
    const initialPause = bootstrapPauseSchema.safeParse(pause?.payload)
    const userStop = z.object({ reason: z.literal('user_stop'), runIds: z.array(z.string()) }).strict().safeParse(pause?.payload)
    if (!pause || !(pause.type === 'execution.bootstrap.paused' && pause.eventKey === `bootstrap-pause:${pause.id}`
      && initialPause.success && initialPause.data.admissionId === admission.id && initialPause.data.inputHash === root.inputHash
      || pause.type === 'run.paused' && pause.eventKey === `pause:${pause.id}` && userStop.success && userStop.data.runIds.includes(runId))) {
      return runtimeError('STALE_RESUME_TARGET', '缺少本次初始化的真实暂停记录。')
    }
    if (await tx.agentRun.count({ where: { sessionId: run.sessionId, status: { in: ['queued', 'running', 'awaiting_approval'] }, ...MAIN_RUN_FILTER } })) {
      return runtimeError('RUN_IN_PROGRESS', '当前会话已有任务执行。')
    }
    const { env } = await import('../../config/env.js')
    if (await tx.agentRun.count({ where: { userId, status: { in: ['queued', 'running', 'awaiting_approval'] }, ...MAIN_RUN_FILTER } }) >= env.agentUserMaxConcurrent) {
      return runtimeError('RUN_LIMIT', '同时进行的任务数已达上限。')
    }
    await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'active' } })
    const resumed = await tx.agentRun.update({ where: { id: runId }, data: { status: 'queued', errorMessage: null, finishedAt: null } })
    await tx.agentRunLease.update({ where: { runId }, data: { enabled: true, ownerId: null, claimId: null, expiresAt: null } })
    if (goalSource) {
      const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: goalSource.binding.goalId } })
      await tx.agentGoalExecution.update({ where: { runId }, data: { epoch: goal.epoch } })
      await assertAgentManuscriptCurrent(tx, { userId, runId, novelId: run.novelId })
    }
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId, type: 'execution.bootstrap.resumed',
      eventKey: `bootstrap-resume:${pause.id}`, payload: { pauseId: pause.id, admissionId: admission.id, inputHash: root.inputHash } } })
    return resumed
}

/** Isolated so admission-only fixtures can stop at this execution boundary.
 * Production never falls back to the legacy loop after a native admission. */
export async function dispatchFreshDurableRun(userId: string, runId: string) {
  try {
    const { initializePersistedLoopRun, executePersistedLoopRun } = await import('./run-service.js')
    await runtimeTransaction(async tx => {
      const source = await readFreshBootstrapAdmission(tx, userId, runId)
      if (!await tx.agentExecutionState.findUnique({ where: { taskRootId: source.root.id } })) await assertUnstartedFreshBootstrap(tx, userId, runId)
    })
    const run = await prisma.agentRun.findFirstOrThrow({ where: { id: runId, userId } })
    if (run.status !== 'queued') return
    await initializePersistedLoopRun(userId, runId)
    await executePersistedLoopRun(userId, runId)
  } catch (error) {
    const { DataAccessError } = await import('../prisma.js')
    const code = error instanceof DataAccessError ? error.code : 'RUNTIME_BOOTSTRAP_UNAVAILABLE'
    await pauseFreshBootstrap(userId, runId, code).catch(() => console.error('[agent-loop] 初始化状态等待数据库核对', { runId }))
    console.error('[agent-loop] 持久任务等待恢复', { runId, code })
  }
}
