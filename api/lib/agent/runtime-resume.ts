import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { env } from '../../config/env.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { databaseNow, lockRunRoot, runtimeError, runtimeId, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { readTaskBudgetInTransaction, taskTurnLimit } from './runtime-budget.js'
import { durablePauseSchema } from './runtime-common.js'

const pausePayload = durablePauseSchema
const resumePayload = z.object({ sourceRunId: z.string(), runId: z.string(), pauseEventId: z.string(),
  revision: z.number().int().nonnegative(), snapshotHash: z.string(), configurationHash: z.string() }).strict()
const live = ['queued', 'running', 'awaiting_approval'] as const

/** Durable resume admission, shared by the service and recovery tests.
 * Caller supplies the exact original run/pause identity; an old tab cannot
 * authorize a later pause, task, or new objective.
 * This creates queued work, not a claim that an executor has started. */
export async function resumeDurableTask(input: { userId: string; runId: string; pauseEventId: string }) {
  const captured = { ...input }, resumedRunId = randomUUID(), eventId = randomUUID()
  runtimeId(captured.userId); runtimeId(captured.runId); runtimeId(captured.pauseEventId)
  const concurrencyLimit = env.agentUserMaxConcurrent
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1) runtimeError('RUNTIME_INPUT_INVALID', '任务并发策略无效。')
  return runtimeTransaction(async tx => {
    // Shared by durable resume admissions across processes; never hold over HTTP.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${captured.userId}`}, 0))::text`
    const { run, root } = await lockRunRoot(tx, captured.userId, captured.runId)
    await assertAgentManuscriptCurrent(tx, { userId: captured.userId, runId: run.id, novelId: run.novelId })
    if (root.authorizationMode !== 'legacy') runtimeError('TASK_AUTHORIZATION_NOT_ACTIVATED', '阶段授权执行器尚未接入，不能降级恢复。')
    const pause = await tx.agentExecutionOutbox.findUnique({ where: { id: captured.pauseEventId } })
    const parsedPause = pausePayload.safeParse(pause?.payload)
    const latestPause = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: root.id, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    if (!pause || pause.taskRootId !== root.id || pause.type !== 'run.paused' || latestPause?.id !== pause.id
      || pause.eventKey !== `pause:${pause.id}` || !parsedPause.success || !parsedPause.data.runIds.includes(run.id)) runtimeError('STALE_RESUME_TARGET', '继续请求不是当前任务本次暂停的授权。')
    const state = await readExecutionStateInTransaction(tx, root.id)
    if (parsedPause.success && parsedPause.data.reason !== 'user_stop') {
      const source = await readExecutionFrame(tx, root.id, parsedPause.data.sourceRevision)
      if (source.snapshotHash !== parsedPause.data.sourceHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '暂停判定的原执行位置损坏。')
    }
    const spec = taskSpecSchema.safeParse(state.originalSpec)
    if (!spec.success || spec.data.id !== root.id || spec.data.scope.novelId !== root.novelId) return runtimeError('RUNTIME_RECEIPT_INVALID', '原任务合同缺失或范围不一致。')
    const budget = await readTaskBudgetInTransaction(tx, root.id)
    if (state.frame.state.checkpointIndex !== budget.budget.checkpointCount
      || state.frame.state.turn > taskTurnLimit(budget.policy, budget.budget.checkpointCount)) runtimeError('RUNTIME_STATE_CONFLICT', '原执行位置与预算合同不一致。')
    const eventKey = `resume:${pause.id}`
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    const latestRun = await tx.agentRun.findFirst({ where: { sessionId: root.sessionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })
    if (existing) {
      const parsed = resumePayload.safeParse(existing.payload)
      if (!parsed.success || existing.taskRootId !== root.id || existing.type !== 'run.resume.queued'
        || parsed.data.sourceRunId !== run.id || parsed.data.pauseEventId !== pause.id || existing.runId !== parsed.data.runId
        || parsed.data.configurationHash !== state.head.configurationHash || existing.sequence <= pause.sequence) return runtimeError('RUNTIME_RECEIPT_INVALID', '原恢复准入回执不一致。')
      const originalFrame = await readExecutionFrame(tx, root.id, parsed.data.revision)
      if (originalFrame.snapshotHash !== parsed.data.snapshotHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原恢复位置摘要不一致。')
      const resumed = await tx.agentRun.findFirst({ where: { id: parsed.data.runId, taskRootId: root.id, userId: run.userId } })
      if (!resumed) return runtimeError('RUNTIME_RECEIPT_INVALID', '已准入的运行实例缺失，不能再建一个。')
      if (latestRun?.id !== resumed.id) runtimeError('STALE_RESUME_TARGET', '当前会话已有后续任务，旧恢复回执不能启动它。')
      return { run: resumed, taskRootId: root.id, replay: true as const }
    }
    if (root.status !== 'paused' || run.status !== 'paused' || state.frame.state.phase === 'completed') runtimeError('RUN_NOT_PAUSED', '仅本次已暂停且未完成的任务可恢复。')
    if (latestRun?.id !== run.id) runtimeError('STALE_RESUME_TARGET', '当前会话已有后续任务，请勿从旧入口恢复。')
    if (await tx.agentRun.count({ where: { sessionId: root.sessionId, status: { in: [...live] } } })) runtimeError('RUN_IN_PROGRESS', '当前会话已有任务执行。')
    if (await tx.agentRun.count({ where: { userId: run.userId, status: { in: [...live] } } }) >= concurrencyLimit) runtimeError('RUN_LIMIT', '同时进行的任务数已达上限。')
    // A pause is required to revoke every old owner; do not repair a corrupt fence
    // by silently granting another executable run.
    if (await tx.agentRunLease.count({ where: { run: { taskRootId: root.id }, enabled: true } })) runtimeError('RUNTIME_STATE_CONFLICT', '暂停的所有权撤销尚未完整，不能恢复。')
    const now = await databaseNow(tx)
    const resumed = await tx.agentRun.create({ data: { id: resumedRunId, userId: run.userId, sessionId: run.sessionId,
      novelId: run.novelId, manuscriptRevision: run.manuscriptRevision, chapterId: run.chapterId, engine: 'loop', mode: state.configuration.mode === 'build' ? 'act' : state.configuration.mode,
      action: run.action, agentType: run.agentType, status: 'queued', taskRootId: root.id, runtimeProtocolVersion: root.protocolVersion,
      taskSpec: runtimeJson({ ...spec.data, runId: resumedRunId }).value, currentTurn: state.frame.state.turn,
      ...(run.startRequest !== null ? { startRequest: runtimeJson(run.startRequest).value } : {}),
      // Make queued recovery discoverable in the admission transaction, even
      // if the process exits before the dispatcher first acquires its lease.
      executionLease: { create: {} },
      modelTier: state.configuration.model.tier, customModelId: state.configuration.model.customModelId,
      reasoningEffort: state.configuration.model.reasoningEffort, createdAt: now } })
    await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'active' } })
    await tx.agentExecutionOutbox.create({ data: { id: eventId, taskRootId: root.id, runId: resumed.id, eventKey, type: 'run.resume.queued',
      payload: { sourceRunId: run.id, runId: resumed.id, pauseEventId: pause.id, revision: state.frame.revision,
        snapshotHash: state.frame.snapshotHash, configurationHash: state.head.configurationHash } } })
    // Budget, original request/configuration and frames remain untouched. Zero
    // balance or unresolved usage does not erase results: provider admission still
    // controls new spending separately. This does not approve pending tool effects.
    return { run: resumed, taskRootId: root.id, replay: false as const }
  })
}
