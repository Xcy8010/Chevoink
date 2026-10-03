import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { StartAgentLoopRunRequest } from '../../../shared/contracts/index.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { lockGoalSession, type GoalTx } from './goal-store.js'
import { isCurrentTaskGoalConsent, readHumanAdmission } from './goal-activation-authority.js'
import { lockOwnedRun, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { readExecutionFrame } from './runtime-state.js'
import type { AgentRun } from '@prisma/client'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const goalConsentSchema = z.object({ version: z.literal(1), sourceRunId: z.string(), sourceRootId: z.string(),
  sourceMessageId: z.string(), sourceRequestHash: hash, sourceSpecHash: hash, sourceMessageHash: hash,
  consentMessageId: z.string(), consentHash: hash, consumed: z.boolean(), enabled: z.boolean() }).strict()

/** Resolve a resumed attempt through its immutable root and actual resume
 * receipt. The original human admission never migrates to a different root. */
export async function readGoalConsentSourceRun(tx: GoalTx, run: AgentRun) {
  if (!run.taskRootId) return run
  const root = await tx.agentTaskRoot.findFirst({ where: { id: run.taskRootId, userId: run.userId, sessionId: run.sessionId, novelId: run.novelId } })
  const message = root ? await tx.agentMessage.findFirst({ where: { id: root.sourceMessageId, sessionId: run.sessionId, role: 'user' } }) : null
  const source = message ? await tx.agentRun.findFirst({ where: { id: message.runId, taskRootId: run.taskRootId, userId: run.userId, sessionId: run.sessionId, novelId: run.novelId } }) : null
  const spec = taskSpecSchema.safeParse(run.taskSpec)
  if (!root || !message || !source || !spec.success || source.engine !== 'loop' || source.agentType !== 'writingOrchestrator'
    || root.inputHash !== runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
    || runtimeJson(root.requestSnapshot).hash !== runtimeJson(message.parts).hash) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '原任务根缺少可核验的作者来源。')
  const { runId: _attempt, ...immutableSpec } = spec.data
  void _attempt
  if (runtimeJson(JSON.parse(JSON.stringify(immutableSpec))).hash !== runtimeJson(root.specSnapshot).hash) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '继续任务不属于原任务范围。')
  if (run.id !== source.id) {
    const resumed = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: root.id, runId: run.id, type: 'run.resume.queued' } })
    const proof = z.object({ sourceRunId: z.string(), runId: z.literal(run.id), pauseEventId: z.string(), revision: z.number().int().nonnegative(), snapshotHash: hash, configurationHash: hash }).strict().safeParse(resumed?.payload)
    const prior = proof.success ? await tx.agentRun.findFirst({ where: { id: proof.data.sourceRunId, taskRootId: root.id, userId: run.userId, sessionId: run.sessionId, novelId: run.novelId } }) : null
    const pause = proof.success ? await tx.agentExecutionOutbox.findUnique({ where: { id: proof.data.pauseEventId } }) : null
    const payload = pause?.payload as Record<string, unknown> | undefined
    if (!resumed || !proof.success || !prior || !pause || pause.taskRootId !== root.id || pause.type !== 'run.paused'
      || pause.eventKey !== `pause:${pause.id}` || resumed.eventKey !== `resume:${pause.id}` || resumed.sequence <= pause.sequence
      || !Array.isArray(payload?.runIds) || !payload.runIds.includes(prior.id)) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '缺少同一原任务的作者继续回执。')
    const frame = await readExecutionFrame(tx, root.id, proof.data.revision)
    if (frame.snapshotHash !== proof.data.snapshotHash) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '原任务继续位置不一致。')
  }
  return source
}

/** Admission is already under user/novel locks. Bind only the latest live task;
 * no history search, role-based authority, or new task/model options. */
export async function bindCurrentTaskGoalConsent(tx: GoalTx, userId: string, input: StartAgentLoopRunRequest) {
  if (!isCurrentTaskGoalConsent(input.prompt) || input.attachments?.length) return null
  const session = await lockGoalSession(tx, userId, input.sessionId)
  const source = await tx.agentRun.findFirst({ where: { userId, sessionId: session.id, novelId: input.novelId, engine: 'loop' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!source || session.spawnedFromSessionId || source.agentType !== 'writingOrchestrator'
    || !['queued', 'running', 'awaiting_approval'].includes(source.status)) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '当前没有可关联的进行中任务，请说明要完成的任务。')
  await lockOwnedRun(tx, userId, source.id)
  if (source.taskRootId) await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${source.taskRootId} FOR UPDATE`
  const fresh = await tx.agentRun.findUniqueOrThrow({ where: { id: source.id } })
  const originalRun = await readGoalConsentSourceRun(tx, fresh)
  const author = readHumanAdmission(originalRun.startRequest), spec = taskSpecSchema.safeParse(originalRun.taskSpec)
  const original = await tx.agentMessage.findFirst({ where: { runId: originalRun.id, sessionId: session.id, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (!author || !spec.success || !original || !['queued', 'running', 'awaiting_approval'].includes(fresh.status)
    || spec.data.scope.novelId !== input.novelId || isCurrentTaskGoalConsent(author.request.prompt)) {
    throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '原任务缺少可核验的作者范围，未启用目标模式。')
  }
  const sourceParts = [{ type: 'text', text: author.request.prompt }, ...(author.request.attachments ?? []).map(part => ({
    type: 'attachment', kind: part.kind, name: part.name, url: part.url, size: part.size,
  }))]
  if (runtimeJson(original.parts).hash !== runtimeJson(JSON.parse(JSON.stringify(sourceParts))).hash) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '原任务消息不一致，未启用目标模式。')
  if (fresh.taskRootId) {
    const root = await tx.agentTaskRoot.findFirst({ where: { id: fresh.taskRootId, userId, sessionId: session.id, novelId: input.novelId } })
    if (!root || root.sourceMessageId !== original.id || root.id !== spec.data.id
      || root.inputHash !== runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
      || runtimeJson(root.requestSnapshot).hash !== runtimeJson(original.parts).hash) throw new DataAccessError(409, 'GOAL_SOURCE_REQUIRED', '原任务根不一致，未启用目标模式。')
  }
  const consentMessageId = randomUUID(), parts = [{ type: 'text', text: input.prompt }]
  await tx.agentMessage.create({ data: { id: consentMessageId, runId: originalRun.id, sessionId: session.id, role: 'user', parts } })
  return goalConsentSchema.parse({ version: 1, sourceRunId: originalRun.id, sourceRootId: source.taskRootId ?? spec.data.id,
    sourceMessageId: original.id, sourceRequestHash: author.grant.requestHash, sourceSpecHash: runtimeJson(originalRun.taskSpec).hash,
    sourceMessageHash: runtimeJson(original.parts).hash, consentMessageId, consentHash: runtimeJson(parts).hash, consumed: false, enabled: false })
}

export async function readCurrentTaskGoalConsent(tx: GoalTx, scope: { userId: string; sessionId: string; novelId: string; runId: string }, requireConsumed = true) {
  const rows = await tx.agentQueuedRequest.findMany({ where: { userId: scope.userId, sessionId: scope.sessionId,
    status: { in: ['held', 'consented'] }, payload: { path: ['goalConsent', 'sourceRunId'], equals: scope.runId } }, orderBy: { sequence: 'asc' } })
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>, parsed = goalConsentSchema.safeParse(payload.goalConsent)
    const author = readHumanAdmission(payload)
    if (!parsed.success || !author || author.request.novelId !== scope.novelId || !isCurrentTaskGoalConsent(author.request.prompt)
      || author.request.attachments?.length || parsed.data.sourceRunId !== scope.runId) throw new DataAccessError(409, 'GOAL_ACTIVATION_SOURCE_INVALID', '目标模式请求来源损坏，请重新处理。')
    if (requireConsumed && !parsed.data.consumed) continue
    if (!requireConsumed && parsed.data.enabled) continue
    const message = await tx.agentMessage.findFirst({ where: { id: parsed.data.consentMessageId, runId: scope.runId, sessionId: scope.sessionId, role: 'user' } })
    if (!message || runtimeJson(message.parts).hash !== parsed.data.consentHash
      || runtimeJson(message.parts).hash !== runtimeJson([{ type: 'text', text: author.request.prompt }]).hash) throw new DataAccessError(409, 'GOAL_ACTIVATION_SOURCE_INVALID', '目标模式请求与作者消息不一致。')
    return { row, consent: parsed.data, message, author }
  }
  return null
}

export async function consumeLegacyGoalConsent(scope: { userId: string; sessionId: string; novelId: string; runId: string }) {
  return runtimeTransaction(async tx => {
    await lockGoalSession(tx, scope.userId, scope.sessionId)
    const run = await lockOwnedRun(tx, scope.userId, scope.runId)
    if (!['queued', 'running', 'awaiting_approval'].includes(run.status)) return null
    const item = await readCurrentTaskGoalConsent(tx, scope, false)
    if (!item || item.consent.enabled) return null
    await tx.agentQueuedRequest.update({ where: { id: item.row.id }, data: { payload: runtimeJson({ ...item.row.payload as object,
      goalConsent: { ...item.consent, consumed: true } }).value, error: '已交给当前任务，等待启用目标模式。' } })
    return { id: item.message.id, prompt: item.author.request.prompt }
  })
}

/** Does not consume prepared requests or split a native call/result batch. */
export async function consumeDurableGoalConsent(token: RunLeaseToken) {
  return withRunLease(token, async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: token.runId } })
    // Existing goal_auto/steering roots may have a system source. Without a
    // held journal for this exact immutable root this protocol is inapplicable.
    if (!await tx.agentQueuedRequest.count({ where: { userId: token.userId, sessionId: run.sessionId, status: 'held',
      payload: { path: ['goalConsent', 'sourceRootId'], equals: token.taskRootId } } })) return false
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    if (current.frame.state.phase !== 'idle') return false
    const messages = current.frame.state.messages
    let index = messages.length - 1
    while (index >= 0 && messages[index].role === 'tool') index--
    const assistant = messages[index]
    if (assistant?.role === 'assistant' && assistant.toolCalls?.some(call => !messages.slice(index + 1).some(message => message.role === 'tool' && message.toolCallId === call.id))) return false
    const source = await readGoalConsentSourceRun(tx, run)
    const item = await readCurrentTaskGoalConsent(tx, { ...token, runId: source.id, sessionId: run.sessionId, novelId: run.novelId }, false)
    if (!item || item.consent.consumed) return false
    const next = await saveExecutionStateInTransaction(tx, token, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...messages, { role: 'user', content: item.author.request.prompt }] } })
    await tx.agentQueuedRequest.update({ where: { id: item.row.id }, data: { payload: runtimeJson({ ...item.row.payload as object,
      goalConsent: { ...item.consent, consumed: true } }).value, error: '已交给当前任务，等待启用目标模式。' } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
      eventKey: `goal-consent:${item.row.id}`, type: 'goal.consent.consumed', payload: { requestId: item.row.id,
        messageId: item.message.id, consentHash: item.consent.consentHash, sourceRevision: current.frame.revision,
        sourceHash: current.frame.snapshotHash, revision: next.revision, snapshotHash: next.snapshotHash } } })
    return true
  })
}
