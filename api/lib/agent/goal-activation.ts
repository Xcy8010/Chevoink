import { z } from 'zod'
import type { AgentGoal } from '@prisma/client'
import { agentGoalExecutionOptionsSchema } from '../../../shared/contracts/agent-goal.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { env } from '../../config/env.js'
import { DataAccessError } from '../prisma.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { goalError, goalSnapshot, lockGoalSession, writeGoalEvent, type GoalTx } from './goal-store.js'
import { lockOwnedRun, runtimeJson, runtimeTransaction } from './runtime-common.js'
import type { ToolContext, ToolResult } from './tools/types.js'
import { readCurrentTaskGoalConsent, readGoalConsentSourceRun } from './goal-consent.js'

export const GOAL_ACTIVATION_PENDING = 'GOAL_ACTIVATION_PENDING'
export const activationAuthoritySchema = z.array(z.tuple([z.string(), z.object({ permission: z.enum(['allow', 'ask', 'deny']),
  alwaysConfirm: z.boolean(), dangerous: z.boolean() }).strict()]))
export const activationReceiptSchema = z.object({ version: z.literal(1), sourceRunId: z.string(), sourceRootId: z.string(),
  activationRunId: z.string(),
  sourceMessageId: z.string(), requestHash: z.string(), startHash: z.string(), specHash: z.string(), messageHash: z.string(),
  optionsHash: z.string(), authorityHash: z.string(), consentHash: z.string(), callId: z.string(),
  consentRequestId: z.string().nullable(), toolAuthority: activationAuthoritySchema, baselineBound: z.boolean() }).strict()

/** Callers acquire session/goal before run/root. Never call this from the
 * generic root-locked effect wrapper. New goals have no execution binding. */
export async function lockGoalActivationScope(tx: GoalTx, ctx: ToolContext) {
  const session = await lockGoalSession(tx, ctx.userId, ctx.sessionId)
  if (session.novelId !== ctx.novelId || session.spawnedFromSessionId || ctx.inlineChild) return goalError('GOAL_ACTIVATION_NOT_AUTHORIZED', '只有作者当前主任务可以启用目标模式。')
  const existing = await tx.agentGoal.findFirst({ where: { userId: ctx.userId, sessionId: ctx.sessionId, status: { notIn: ['completed', 'cancelled'] } } })
  if (existing) await tx.$queryRaw`SELECT id FROM agent_goals WHERE id = ${existing.id} FOR UPDATE`
  return existing
}

export async function readActivationSource(tx: GoalTx, ctx: Pick<ToolContext, 'userId' | 'runId' | 'sessionId' | 'novelId'>) {
  const currentRun = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, sessionId: ctx.sessionId, novelId: ctx.novelId } })
  if (!currentRun || currentRun.engine !== 'loop' || currentRun.agentType !== 'writingOrchestrator') return goalError('GOAL_ACTIVATION_NOT_AUTHORIZED', '当前执行没有作者目标模式授权。')
  const run = await readGoalConsentSourceRun(tx, currentRun)
  const admitted = readHumanAdmission(run.startRequest)
  const spec = taskSpecSchema.safeParse(run.taskSpec)
  const journal = admitted && !admitted.grant.objective ? await readCurrentTaskGoalConsent(tx, { ...ctx, runId: run.id }) : null
  const objective = admitted?.grant.objective ?? (journal ? admitted?.request.prompt : null)
  if (!admitted || !objective || !spec.success || spec.data.scope.novelId !== ctx.novelId
    || admitted.request.sessionId !== ctx.sessionId || admitted.request.novelId !== ctx.novelId
    || (admitted.request.chapterId?.trim() || null) !== run.chapterId
    || admitted.request.mode !== (run.mode === 'act' ? 'build' : run.mode)) return goalError('GOAL_ACTIVATION_NOT_AUTHORIZED', '需要作者明确要求启用目标模式并说明本次任务，不能从旧记录或摘要补造授权。')
  const sourceRootId = run.taskRootId ?? spec.data.id
  const original = await tx.agentMessage.findFirst({ where: { runId: run.id, sessionId: ctx.sessionId, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const parts = [{ type: 'text', text: admitted.request.prompt }, ...(admitted.request.attachments ?? []).map(item => ({
    type: 'attachment', kind: item.kind, name: item.name, url: item.url, size: item.size,
  }))]
  if (!original || runtimeJson(original.parts).hash !== runtimeJson(JSON.parse(JSON.stringify(parts))).hash) return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '原始任务记录不一致，未启用目标模式。')
  if (journal && (journal.consent.sourceRootId !== sourceRootId || journal.consent.sourceMessageId !== original.id
    || journal.consent.sourceRequestHash !== admitted.grant.requestHash || journal.consent.sourceSpecHash !== runtimeJson(run.taskSpec).hash
    || journal.consent.sourceMessageHash !== runtimeJson(original.parts).hash)) return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '目标模式请求与原任务范围不一致。')
  if (run.taskRootId) {
    const root = await tx.agentTaskRoot.findFirst({ where: { id: run.taskRootId, userId: ctx.userId, sessionId: ctx.sessionId, novelId: ctx.novelId } })
    if (!root || root.sourceMessageId !== original.id || runtimeJson(root.requestSnapshot).hash !== runtimeJson(original.parts).hash
      || root.inputHash !== runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
      || root.id !== spec.data.id) return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '原任务根与请求不一致，未启用目标模式。')
  }
  const options = agentGoalExecutionOptionsSchema.parse(admitted.request)
  const consentHash = journal ? runtimeJson({ ...journal.consent, consumed: false, enabled: false, requestHash: journal.author.grant.requestHash }).hash : runtimeJson(admitted.grant).hash
  return { run, currentRun, spec: spec.data, admitted, original, options, sourceRootId, objective, journal, consentHash }
}

export async function registerGoalActivationInTransaction(tx: GoalTx, ctx: ToolContext, existing: AgentGoal | null): Promise<ToolResult & { goalSnapshot: import('../../../shared/contracts/agent-goal.js').AgentGoalSnapshot }> {
  if (!env.agentGoalEnabled) return goalError('GOAL_DISABLED', '目标模式暂未开放。', 503)
  ctx.signal.throwIfAborted()
  if (ctx.inlineChild || !ctx.toolAuthority?.get('goal_enable') || ctx.toolAuthority.get('goal_enable')?.permission === 'deny') return goalError('GOAL_ACTIVATION_NOT_AUTHORIZED', '当前任务未授权启用目标模式。')
  if (existing) {
    const bound = await tx.agentGoalExecution.findUnique({ where: { runId: ctx.runId } })
    const pending = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: { goalId: existing.id, revision: 1, criterionId: 'activation-source' } } })
    const source = activationReceiptSchema.safeParse(pending?.receipt)
    if (bound?.goalId !== existing.id && (!source.success || source.data.activationRunId !== ctx.runId)) return goalError('GOAL_ACTIVATION_NOT_AUTHORIZED', '当前执行不属于这个目标。')
    if (source.success) {
      const extra = await readCurrentTaskGoalConsent(tx, { ...ctx, runId: source.data.sourceRunId }, false)
      if (extra?.consent.consumed && extra.consent.sourceRootId === source.data.sourceRootId
        && extra.consent.sourceRequestHash === source.data.requestHash && extra.consent.sourceSpecHash === source.data.specHash) {
        await tx.agentQueuedRequest.update({ where: { id: extra.row.id }, data: { status: 'consented', error: null,
          payload: runtimeJson({ ...extra.row.payload as object, goalConsent: { ...extra.consent, enabled: true } }).value } })
      }
    }
    const snapshot = await goalSnapshot(tx, existing)
    return { output: JSON.stringify({ goal: snapshot, alreadyEnabled: true }), summary: '当前任务已启用目标模式', goalSnapshot: snapshot }
  }
  const source = await readActivationSource(tx, ctx)
  if (!['queued', 'running', 'awaiting_approval'].includes(source.currentRun.status)) return goalError('GOAL_ACTIVATION_NOT_AUTHORIZED', '原执行已结束，不能从迟到的工具调用启用目标模式。')
  const authority = [...ctx.toolAuthority].map(([name, grant]) => [name, { permission: grant.permission,
    alwaysConfirm: grant.alwaysConfirm, dangerous: grant.dangerous }] as const)
  const receipt = runtimeJson({ version: 1, sourceRunId: source.run.id, activationRunId: ctx.runId, sourceRootId: source.sourceRootId, sourceMessageId: source.original.id,
    requestHash: source.admitted.grant.requestHash, startHash: runtimeJson(source.run.startRequest).hash,
    specHash: runtimeJson(source.run.taskSpec).hash, messageHash: runtimeJson(source.original.parts).hash,
    optionsHash: runtimeJson(source.options).hash, authorityHash: runtimeJson(authority).hash,
    consentHash: source.consentHash, consentRequestId: source.journal?.row.id ?? null, callId: ctx.callId, toolAuthority: authority, baselineBound: false })
  const requestId = `enable:${runtimeJson({ runId: source.run.id }).hash.slice(0, 56)}`
  const commandHash = runtimeJson({ sourceRunId: source.run.id, requestHash: source.admitted.grant.requestHash }).hash
  const previous = await tx.agentGoalCommand.findUnique({ where: { userId_requestId: { userId: ctx.userId, requestId } } })
  if (previous) return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '原目标登记已存在，不能重建或恢复目标。')
  const tokenCap = BigInt(Math.floor(env.agentRunTokenBudgetCeiling)), timeCap = BigInt(Math.floor(env.agentRunWallClockLongMinutes * 60_000))
  const goal = await tx.agentGoal.create({ data: { userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId,
    status: 'active', phase: 'reconciling', currentRunId: ctx.runId, activeSince: null, nextEligibleAt: null,
    reasonCode: GOAL_ACTIVATION_PENDING, executionOptions: runtimeJson(source.options).value,
    revisions: { create: { revision: 1, objective: source.objective, request: runtimeJson(source.options).value,
      authorityHash: receipt.hash, sourceActionId: requestId } },
    budget: { create: { tokenLimit: tokenCap, platformTokenCap: tokenCap, activeTimeLimitMs: timeCap, platformTimeCapMs: timeCap } },
    evidence: { create: [{ revision: 1, criterionId: 'author-objective', kind: 'objective', description: source.objective, receipt: {} },
      { revision: 1, criterionId: 'activation-source', kind: 'activation-source', description: '作者授权当前任务启用目标模式，等待原执行结算。', status: 'verified', receipt: receipt.value }] } } })
  const snapshot = await writeGoalEvent(tx, goal, 'goal.activation_pending')
  await tx.agentGoalCommand.create({ data: { userId: ctx.userId, requestId, requestHash: commandHash, response: runtimeJson(snapshot).value } })
  if (source.journal) await tx.agentQueuedRequest.update({ where: { id: source.journal.row.id }, data: {
    payload: runtimeJson({ ...source.journal.row.payload as object, goalConsent: { ...source.journal.consent, enabled: true } }).value,
    status: 'consented', error: null } })
  ctx.signal.throwIfAborted()
  return { output: JSON.stringify({ goal: snapshot, activation: 'pending', currentTaskContinues: true }), summary: '当前任务已启用目标模式', goalSnapshot: snapshot }
}

export async function enableCurrentRunGoal(ctx: ToolContext): Promise<ToolResult> {
  if (ctx.transaction) return goalError('GOAL_ACTIVATION_ADAPTER_REQUIRED', '启用目标模式必须使用专用事务适配。')
  try {
    const result = await runtimeTransaction(async tx => {
      const existing = await lockGoalActivationScope(tx, ctx)
      await lockOwnedRun(tx, ctx.userId, ctx.runId)
      return registerGoalActivationInTransaction(tx, ctx, existing)
    })
    ctx.emit({ type: 'goal.snapshot', snapshot: result.goalSnapshot })
    return result
  } catch (error) {
    if (!(error instanceof DataAccessError)) throw error
    return { outcome: 'failed', failureCode: error.code, output: error.message }
  }
}

export async function readGoalActivationReceipt(tx: GoalTx, goal: AgentGoal) {
  const evidence = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: { goalId: goal.id, revision: 1, criterionId: 'activation-source' } } })
  if (!evidence) return null
  const parsed = activationReceiptSchema.safeParse(evidence.receipt)
  if (!parsed.success) return goalError('GOAL_ACTIVATION_SOURCE_INVALID', '目标原执行回执损坏，需要作者处理。')
  return { evidence, receipt: parsed.data }
}

/** A human objective revision has its own native admission and TaskSpec. The
 * original ceiling applies only to activation revision 1 and its source chain. */
export async function readGoalActivationToolCeiling(tx: GoalTx, goal: AgentGoal) {
  if (goal.currentRevision !== 1) return null
  return (await readGoalActivationReceipt(tx, goal))?.receipt.toolAuthority ?? null
}
