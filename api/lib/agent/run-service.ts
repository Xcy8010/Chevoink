import { readAuthorEnded } from './author-ended.js'
import { hasAuthorEnded } from './completion-guard.js'
import type { Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { startAgentLoopRunSchema } from '../../../shared/contracts/index.js'

import type { AgentRun as AgentRunRecord, Prisma } from '@prisma/client'

import type {
  AgentActionHandoff,
  AgentActionPlan,
  AgentActionResponse,
  AgentArtifact,
  AgentArtifactApplyStrategy,
  AgentExecutionAgent,
  AgentExecutionMode,
  AgentRouteDecision,
  AgentRuleBundle,
  AgentRun,
  AgentRunStatus,
  AgentSession,
  AgentSessionRunStatusPayload,
  AgentStoryMemoryDigest,
  AgentStreamEvent,
  AgentWorkspaceToolPolicy,
  CreateAgentSessionRequest,
  CreditModelTier,
  ModelReasoningEffort,
  ProjectMemoryEntry,
  StartAgentLoopRunRequest,
  StartAgentLoopRunResponse,
  UpdateAgentSessionRequest,
} from '../../../shared/contracts/index.js'
import { env } from '../../config/env.js'
import { assertManagedAttachmentsAccess } from '../agent-attachment-storage.js'
import { assertTaskAuthorizationRuntimeReady } from './task-authorization.js'
import { assertLegacyRuntimeCompatible } from './runtime-identity.js'
import { fenceLocallyStoppedLegacyRun, pauseDurableTask, pauseDurableTaskForAttention, pauseLegacyOrphanRun, recoverLegacyOrphanRun } from './runtime-lifecycle.js'
import { resumeDurableTask } from './runtime-resume.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { activeChapterScope } from '../data/internal.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { recoverRunElapsedMs, savedRunUsageSchema } from './checkpoint.js'
import { DataAccessError, prisma } from '../prisma.js'
import { assertCreditAccess, getModelTierRuntime } from '../credits.js'
import { getRunEventBus, loadPersistedEvents, prepareRunEventResume } from './events.js'
import {
  countActiveRunsByUser,
  getActiveRun,
  hasActiveRunInSession,
  stopAgentRun,
  stopActiveRunsInSession,
  registerActiveRun,
  deregisterActiveRun,
} from './active-runs.js'
import { acquireRunLease, releaseRunLease, withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { databaseNow, runtimeTransaction } from './runtime-common.js'
import { executeAgentRun } from './loop.js'
import { resolveApproval, resolveQuestionAnswer } from './permissions.js'
import { resolveDurableApproval } from './runtime-approval.js'
import { resolveDurableQuestion } from './runtime-question.js'
import { streamDurableRun } from './runtime-stream.js'
import { isDefaultSessionTitle } from './session-title.js'
import { withUserRunLock } from './run-lock.js'

/**
 * Agent Loop 新链路的路由服务层（plan/13 §4.9）。
 * 阶段 K：legacy 链路（agent-service.ts）已物理删除，本文件是 Agent 服务层唯一入口；
 * sessions CRUD 与历史回放自 legacy 迁入（行为原样保留，供任务窗口体系消费）。
 * 阶段 P3：计划产物拆至 plan-artifacts.ts、会话消息/删除/回滚拆至 session-messages.ts。
 */

export type StartLoopRunOptions = {
  /**
   * 并发额度作用域：interactive=作者手工发起（受 agentUserMaxConcurrent 约束）；
   * orchestration=task_spawn / task_send 拉起的跨任务编排，改用编排专用上限（主控 + 派生窗口）。
   * 分开的理由：不能为了并行编排而放宽普通交互的额度，否则手工连点就能把模型并发打满。
   */
  concurrencyScope?: 'interactive' | 'orchestration'
  queuedRequest?: { id: string; revision: number }
}

const durableProcessOwner = `api:${randomUUID()}`

// Internal profiles/budgets are not added to the public HTTP schema.
const persistedStartSchema = startAgentLoopRunSchema.extend({
  agentProfile: z.enum(['orchestrator', 'research', 'continuity', 'quality', 'lore']).optional(),
  tokenBudget: z.number().int().positive().optional(),
})

function readAdmittedStart(run: AgentRunRecord): StartAgentLoopRunRequest | undefined {
  if (run.startRequest == null) return undefined
  const parsed = persistedStartSchema.safeParse(run.startRequest)
  if (!parsed.success || parsed.data.sessionId !== run.sessionId || parsed.data.novelId !== run.novelId
    || (parsed.data.chapterId?.trim() || null) !== run.chapterId || parsed.data.mode !== (run.mode === 'act' ? 'build' : run.mode)) {
    throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '已保存的启动请求损坏或与任务范围不一致，不能从摘要猜测恢复。')
  }
  return parsed.data
}

/** Internal bootstrap, kept separate from public activation. It reuses the
 * existing context assembler and session policy; no reduced tool list or new
 * model-selected task objective is manufactured for the durable executor. */
export async function initializePersistedLoopRun(userId: string, runId: string, supplied?: StartAgentLoopRunRequest) {
  const { runtimeJson, runtimeTransaction, lockOwnedRun } = await import('./runtime-common.js')
  const { initializeDurableTask } = await import('./runtime-identity.js')
  const { initializeExecutionState, loadExecutionState } = await import('./runtime-state.js')
  const { buildTaskSpec } = await import('./task-spec.js')
  const { taskSpecSchema } = await import('../../../shared/contracts/task-spec-contracts.js')
  const { applySessionToolPolicy, getAgentDefinition, getToolsForAgent } = await import('./agents.js')
  const { resolveAgent2FeatureFlags } = await import('../agent2-feature-flags.js')
  const { assembleContext } = await import('./context.js')
  const { snapshotToolAuthority } = await import('./tool-authority.js')
  const { toOpenAITools } = await import('./tools/registry.js')
  const { executionContextReadTool } = await import('./tools/task-context-tools.js')
  const { ORCHESTRATION_TOOL_NAMES } = await import('./tools/task-orchestration-tools.js')
  const { modelRouteRevision } = await import('./runtime-model-cursor.js')
  const run = await findOwnedLoopRun(userId, runId)
  const admitted = readAdmittedStart(run)
  if (!admitted && !supplied) throw new DataAccessError(409, 'RUN_INPUT_REQUIRED', '旧任务缺少完整启动选项，不能自动补造。')
  if (admitted && supplied && runtimeJson(JSON.parse(JSON.stringify(persistedStartSchema.parse(supplied)))).hash !== runtimeJson(admitted).hash) {
    throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '不能用新的选区、附件或执行选项替换原请求。')
  }
  const input: StartAgentLoopRunRequest = admitted ?? JSON.parse(JSON.stringify(supplied))
  if (run.sessionId !== input.sessionId || run.novelId !== input.novelId || run.chapterId !== (input.chapterId?.trim() || null)
    || (run.mode === 'act' ? 'build' : run.mode) !== input.mode) throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '初始化范围与原任务不一致。')
  const original = await prisma.agentMessage.findFirst({ where: { runId, sessionId: run.sessionId, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const parts = [{ type: 'text', text: input.prompt }, ...(input.attachments ?? []).map(item => ({ type: 'attachment', kind: item.kind, name: item.name, url: item.url, size: item.size }))]
  if (!original || runtimeJson(original.parts).hash !== runtimeJson(JSON.parse(JSON.stringify(parts))).hash) throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '初始化必须使用已保存的完整原始请求。')
  if (run.runtimeProtocolVersion === 1 && run.taskRootId && await prisma.agentExecutionState.findUnique({ where: { taskRootId: run.taskRootId } })) return loadExecutionState(userId, runId)
  if (run.status !== 'queued') throw new DataAccessError(409, 'RUN_IN_PROGRESS', '不能重新初始化已启动任务。')
  await assertManagedAttachmentsAccess(input.attachments, userId)
  const runtime = await getModelTierRuntime(run.modelTier as import('../../../shared/contracts/index.js').CreditModelTier, userId, run.customModelId,
    run.reasoningEffort as import('../../../shared/contracts/index.js').ModelReasoningEffort)
  if (runtime.tier !== run.modelTier || run.customModelId) throw new DataAccessError(409, 'RUNTIME_MODEL_ADAPTER_REQUIRED', '原模型模式尚未接入持久执行，不能替换模型。')
  const agent = getAgentDefinition(input.agentProfile ?? 'orchestrator')
  // The gated durable runtime has no inline-subagent adapter yet; never silently discard an explicit selection.
  if (input.pinnedSubagentId) throw new DataAccessError(409, 'RUNTIME_SUBAGENT_ADAPTER_REQUIRED', '当前持久执行协议暂未接入手动子 Agent，请使用普通任务执行。')
  const session = await prisma.agentSession.findFirstOrThrow({ where: { id: run.sessionId, userId } })
  const scoped = getToolsForAgent(agent, input.mode, resolveAgent2FeatureFlags(userId))
    .filter(tool => !session.spawnedFromSessionId || !ORCHESTRATION_TOOL_NAMES.has(tool.name))
  const contextRead: import('./tools/types.js').AgentTool = { ...executionContextReadTool,
    execute: (ctx, args) => executionContextReadTool.execute(ctx, executionContextReadTool.parameters.parse(args)) }
  const tools = applySessionToolPolicy([...scoped, contextRead], input.mode, session.toolPolicy,
    session.sandboxMode === 'read_only' || session.sandboxMode === 'full_access' ? session.sandboxMode : 'workspace')
  const spec = await runtimeTransaction(async tx => {
    const current = await lockOwnedRun(tx, userId, runId)
    if (current.status !== 'queued') throw new DataAccessError(409, 'RUN_IN_PROGRESS', '初始化期间任务状态已变化。')
    if (current.taskSpec) return taskSpecSchema.parse(current.taskSpec)
    let task = buildTaskSpec({ runId, novelId: run.novelId, chapterId: run.chapterId, prompt: input.prompt, selection: input.selection,
      creativeFreedom: input.creativeFreedom, qualityMode: input.qualityMode })
    if (task.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED')) {
      const chapters = await tx.chapter.findMany({ where: { ...activeChapterScope(run.novelId), authorId: userId }, select: { id: true } })
      task = { ...task, scope: { ...task.scope, chapterIds: chapters.map(chapter => chapter.id) } }
    }
    await tx.agentRun.update({ where: { id: runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(task))).value } })
    return task
  })
  const assembled = await assembleContext({ agent, mode: input.mode, userId, sessionId: run.sessionId, runId, novelId: run.novelId, chapterId: run.chapterId,
    prompt: input.prompt, selection: input.selection, attachments: input.attachments, visionEnabled: false, taskSpec: spec,
    modelTier: runtime.tier, modelName: runtime.modelName, contextWindowTokens: runtime.contextWindowTokens, pinnedSkillIds: input.pinnedSkillIds })
  await initializeDurableTask({ userId, runId, sourceMessageId: original.id, tokenBudget: input.tokenBudget })
  const lease = await acquireRunLease({ userId, runId, ownerId: durableProcessOwner, claimId: randomUUID() })
  try {
    return await initializeExecutionState(lease, { configuration: { version: 1, mode: input.mode, agentType: agent.type,
      creativeFreedom: input.creativeFreedom ?? 'balanced', qualityMode: input.qualityMode ?? 'premium',
      model: { tier: runtime.tier, provider: runtime.provider, modelName: runtime.modelName ?? env.aiTextModel, customModelId: null,
        maxOutputTokens: env.aiTextMaxOutputTokens, contextWindowTokens: runtime.contextWindowTokens ?? env.agentContextWindowTokens,
        reasoningEffort: runtime.reasoningEffort, routeRevision: modelRouteRevision({ provider: runtime.provider, model: runtime.modelName ?? env.aiTextModel,
          endpoint: `${(runtime.baseUrl ?? env.aiTextBaseUrl).replace(/\/$/, '')}/chat/completions`, reasoningEffort: runtime.reasoningEffort }) },
      tools: toOpenAITools(tools), toolAuthority: [...snapshotToolAuthority(tools, input.mode)].map(([name, grant]) => ({ name, ...grant })),
      protectedChapterIds: spec.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED') ? spec.scope.chapterIds ?? [] : [],
      pinnedSkillVersions: (assembled.skillRoute?.selected ?? []).map(skill => ({ id: skill.id, version: skill.version })) },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: assembled.messages, successfulToolSignatures: [] } })
  } finally { await releaseRunLease(lease) }
}

/** Internal B0 dispatcher for an already initialized durable task. Does not
 * create an objective, rebuild messages, change grants, or fall back to loop.ts.
 * New task activation stays gated until bootstrap and all adapters land. */
export async function executePersistedLoopRun(userId: string, runId: string) {
  const run = await findOwnedLoopRun(userId, runId)
  return executeOwnedPersistedLoopRun(run)
}

// Resume already owns this DB record. Reserve synchronously before releasing
// the user admission lock, rather than leaving an extra asynchronous lookup gap.
async function executeOwnedPersistedLoopRun(run: AgentRunRecord) {
  const { userId, id: runId } = run
  if (run.runtimeProtocolVersion !== 1 || !run.taskRootId) throw new DataAccessError(409, 'RUNTIME_VERSION_MISMATCH', '仅能调度已初始化的持久任务。')
  if (getActiveRun(run.id) || hasActiveRunInSession(run.sessionId)) throw new DataAccessError(409, 'RUN_IN_PROGRESS', '该会话已有本地执行者。')
  // Recovery shares the existing resume limit. A restart must not dispatch all
  // discovered tasks at once and multiply the user's concurrent paid requests.
  if (countActiveRunsByUser(userId) >= env.agentUserMaxConcurrent) {
    throw new DataAccessError(409, 'RUN_LIMIT', `同时进行的任务数已达上限（${env.agentUserMaxConcurrent}），请稍后再试。`)
  }
  const controller = new AbortController()
  // No await between reservation check and registration. This uses the same
  // registry as legacy runs so stop and concurrency accounting remain shared.
  registerActiveRun(run.id, { controller, userId, sessionId: run.sessionId })
  let lease: RunLeaseToken | undefined
  let executionFailed = false
  let result: Awaited<ReturnType<typeof import('./runtime-executor.js').runReviewedDurableExecution>>
  let cleanupFailure: { error: unknown } | undefined
  try {
    lease = await acquireRunLease({ userId, runId: run.id, ownerId: durableProcessOwner, claimId: randomUUID() })
    controller.signal.throwIfAborted()
    await withRunLease(lease, async tx => {
      await assertAgentManuscriptCurrent(tx, { userId, novelId: run.novelId, runId: run.id })
      const state = await readExecutionStateInTransaction(tx, lease!.taskRootId)
      const initial = await readExecutionFrame(tx, lease!.taskRootId, 0)
      const originalPrompt = Array.isArray(state.originalRequest) ? state.originalRequest.flatMap(part =>
        part && typeof part === 'object' && !Array.isArray(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n').trim() : ''
      const authorMessage = initial.state.messages.filter(message => message.role === 'user').at(-1)
      const initialPrompt = typeof authorMessage?.content === 'string' ? authorMessage.content
        : authorMessage?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
      // assembleContext places the full request first, then optional selected
      // text/attachment sections. Validate the initial frame on resume too,
      // without treating newer model/tool messages as replacement instructions.
      if (!originalPrompt || !(initialPrompt === originalPrompt || initialPrompt.startsWith(`${originalPrompt}\n\n`))) {
        throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '初始上下文缺少本任务完整原始要求，不能用摘要或其他任务代替。')
      }
      const current = await tx.agentRun.findUniqueOrThrow({ where: { id: run.id } })
      await tx.agentRun.update({ where: { id: run.id }, data: { status: 'running', startedAt: current.startedAt ?? await databaseNow(tx), errorMessage: null } })
    })
    const { runReviewedDurableExecution } = await import('./runtime-executor.js')
    controller.signal.throwIfAborted()
    result = await runReviewedDurableExecution(lease, controller.signal)
  } catch (error) {
    executionFailed = true
    // Preserve the failed operation/cursor. Only the still-current owner may
    // close its run; an expired worker must never pause a replacement worker.
    if (lease && !controller.signal.aborted) {
      try {
        const { frame } = await withRunLease(lease, tx => readExecutionStateInTransaction(tx, lease!.taskRootId))
        await pauseDurableTaskForAttention(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, 'needs_input')
      } catch (pauseError) {
        // A database outage or lost lease cannot be repaired by an unfenced
        // status update. Retain the original failure for the caller/recovery.
        console.error('[agent-loop] 持久任务异常收尾未提交', { runId, code: pauseError instanceof DataAccessError ? pauseError.code : 'PAUSE_UNAVAILABLE' })
      }
    }
    throw error
  } finally {
    try {
      // The executor's own heartbeat has stopped before releasing ownership.
      // Errors remain errors; unknown provider outcomes are never re-dispatched here.
      if (lease) await releaseRunLease(lease)
    } catch (releaseError) {
      // A cleanup outage must not replace the actual provider/tool failure.
      // On an otherwise successful return, however, surface the cleanup failure.
      if (!executionFailed) cleanupFailure = { error: releaseError }
      else console.error('[agent-loop] 持久任务租约释放失败', { runId, code: releaseError instanceof DataAccessError ? releaseError.code : 'RELEASE_UNAVAILABLE' })
    } finally {
      if (getActiveRun(run.id)?.controller === controller) deregisterActiveRun(run.id)
    }
  }
  if (cleanupFailure) throw cleanupFailure.error
  return result
}

export async function startLoopRun(
  userId: string,
  input: StartAgentLoopRunRequest,
  options: StartLoopRunOptions = {},
): Promise<StartAgentLoopRunResponse> {
  return withUserRunLock(userId, () => startLoopRunLocked(userId, input, options))
}

/** Internal: caller must hold withUserRunLock. */
export async function startLoopRunLocked(
  userId: string,
  input: StartAgentLoopRunRequest,
  options: StartLoopRunOptions = {},
): Promise<StartAgentLoopRunResponse> {
  input = persistedStartSchema.parse(JSON.parse(JSON.stringify(input)))
  const session = await prisma.agentSession.findFirst({
    where: { id: input.sessionId, userId },
  })

  if (!session) {
    throw new DataAccessError(404, 'NOT_FOUND', '会话不存在或无权访问。')
  }

  if (session.novelId !== input.novelId) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '会话与作品不匹配。')
  }

  await assertManagedAttachmentsAccess(input.attachments, userId)

  const modelTier = input.modelTier ?? 'speed'
  if (input.pinnedSubagentId) {
    if (input.agentProfile && input.agentProfile !== 'orchestrator') throw new DataAccessError(400, 'SUBAGENT_NESTING_DENIED', '只有主 Agent 可以调用子 Agent。')
    if (session.sandboxMode === 'read_only') throw new DataAccessError(409, 'SUBAGENT_UNAVAILABLE', '当前只读模式不允许调用子 Agent，请先调整任务权限。')
    const { requireSelectedSubagent } = await import('./subagent-selection.js')
    await requireSelectedSubagent(userId, session.novelId, input.pinnedSubagentId)
  }
  await assertCreditAccess(userId, modelTier)
  const modelRuntime = await getModelTierRuntime(modelTier, userId, input.customModelId, input.reasoningEffort)

  // 同一 session 仅允许 1 个进行中的 run；单用户全局并发受 env 限制
  if (hasActiveRunInSession(session.id)) {
    throw new DataAccessError(409, 'RUN_IN_PROGRESS', '当前会话已有任务在执行，请先停止或等待完成。')
  }

  const concurrencyLimit = options.concurrencyScope === 'orchestration'
    ? Math.max(env.agentUserMaxConcurrent, env.agentOrchestrationMaxConcurrent)
    : env.agentUserMaxConcurrent

  if (countActiveRunsByUser(userId) >= concurrencyLimit) {
    throw new DataAccessError(409, 'RUN_LIMIT', `同时进行的任务数已达上限（${concurrencyLimit}），请稍后再试。`)
  }

  const chapterId = input.chapterId?.trim() || null

  if (chapterId) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, ...activeChapterScope(session.novelId), authorId: userId },
      select: { id: true },
    })
    if (!chapter) {
      // 独立错误码：前端据此丢弃失效 chapterId 重试；严禁与会话 404 共用 NOT_FOUND，
      // 否则前端会把「章节被回退删除」误判成「会话被删除」而清空整段对话
      throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '章节不存在或不属于该作品。')
    }
  }

  const agentType = input.agentProfile === 'research'
    ? 'storyPlanner'
    : input.agentProfile === 'continuity'
      ? 'continuityEditor'
      : input.agentProfile === 'quality'
        ? 'styleEditor'
        : input.agentProfile === 'lore'
          ? 'loreLibrarian'
          : 'writingOrchestrator'
  const runData: Prisma.AgentRunCreateArgs = {
    data: {
      sessionId: session.id,
      userId,
      novelId: session.novelId,
      chapterId,
      // DB 枚举 act ↔ 契约 build
      mode: input.mode === 'build' ? 'act' : input.mode,
      action: 'workspaceAgent',
      agentType,
      status: 'queued',
      engine: 'loop',
      inputSummary: input.prompt.slice(0, 300),
      startRequest: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue,
      modelTier,
      customModelId: modelTier === 'custom' ? input.customModelId : null,
      reasoningEffort: modelRuntime.reasoningEffort,
    },
  }
  // A queue claim and run creation commit together. A crash can never re-send
  // a claimed prompt; orphan recovery leaves that run visible for manual resume.
  const queuedRequest = options.queuedRequest
  const admittedMessageId = randomUUID()
  const admittedParts = [{ type: 'text', text: input.prompt }, ...(input.attachments ?? []).map(attachment => ({
    type: 'attachment', kind: attachment.kind, name: attachment.name, url: attachment.url, size: attachment.size,
  }))]
  const run = await prisma.$transaction(async tx => {
    // Queued/recovering runs may not yet have a local controller. Share the
    // durable resume admission lock and count saved work before creating more.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${userId}`}, 0))::text`
    await lockNovelActiveScope(tx, session.novelId)
    const manuscript = await tx.novel.findFirst({ where: { id: session.novelId, authorId: userId }, select: { manuscriptRevision: true } })
    if (!manuscript) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
    if (chapterId && !await tx.chapter.findFirst({ where: { id: chapterId, authorId: userId, ...activeChapterScope(session.novelId) }, select: { id: true } })) {
      throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '章节已归档或不属于当前稿件。')
    }
    const live = ['queued', 'running', 'awaiting_approval'] as const
    if (await tx.agentRun.count({ where: { sessionId: session.id, status: { in: [...live] } } })) {
      throw new DataAccessError(409, 'RUN_IN_PROGRESS', '当前会话已有任务在执行，请先停止或等待完成。')
    }
    if (await tx.agentRun.count({ where: { userId, status: { in: [...live] } } }) >= concurrencyLimit) {
      throw new DataAccessError(409, 'RUN_LIMIT', `同时进行的任务数已达上限（${concurrencyLimit}），请稍后再试。`)
    }
    if (queuedRequest) {
      const claimed = await tx.agentQueuedRequest.updateMany({
        where: { id: queuedRequest.id, userId, sessionId: session.id, status: 'pending', revision: queuedRequest.revision },
        data: { status: 'dispatched', revision: { increment: 1 }, error: null },
      })
      if (claimed.count !== 1) throw new DataAccessError(409, 'QUEUE_CHANGED', '待发需求已变更，请刷新。')
    }
    const created = await tx.agentRun.create({ ...runData, data: { ...runData.data, manuscriptRevision: manuscript.manuscriptRevision } })
    await tx.agentMessage.create({ data: { id: admittedMessageId, runId: created.id, sessionId: session.id, role: 'user', parts: admittedParts } })
    if (queuedRequest) await tx.agentQueuedRequest.update({ where: { id: queuedRequest.id }, data: { runId: created.id } })
    return created
  })

  void import('./writing-experiments.js').then(({ recordSevenDayContinuation }) => recordSevenDayContinuation(userId, session.novelId)).catch(() => {})

  // 异步执行循环，路由立即返回，前端连 stream 拿事件
  void executeAgentRun({
    runId: run.id,
    admittedMessageId,
    sessionId: session.id,
    userId,
    novelId: session.novelId,
    chapterId,
    mode: input.mode,
    prompt: input.prompt,
    selection: input.selection ?? null,
    attachments: input.attachments ?? [],
    creativeFreedom: input.creativeFreedom ?? 'balanced',
    qualityMode: input.qualityMode ?? 'premium',
    modelTier,
    customModelId: modelTier === 'custom' ? input.customModelId : null,
    reasoningEffort: modelRuntime.reasoningEffort,
    agentType: input.agentProfile ?? 'orchestrator',
    tokenBudget: input.tokenBudget,
    pinnedSkillIds: input.pinnedSkillIds ?? [],
    pinnedSubagentId: input.pinnedSubagentId,
  })

  return {
    runId: run.id,
    sessionId: session.id,
    status: 'running',
    streamUrl: `/api/agent/runs/${run.id}/stream`,
  }
}

async function findOwnedLoopRun(userId: string, runId: string) {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, userId },
  })

  if (!run) {
    throw new DataAccessError(404, 'NOT_FOUND', '任务不存在或无权访问。')
  }

  return run
}

/**
 * SSE 直推：live（订阅事件总线）与 replay（读 AgentRunEvent）统一为同一事件源。
 * 响应带 id: {seq}，客户端重连带 Last-Event-ID，从 seq+1 续传。
 */
export async function streamLoopRun(
  userId: string,
  runId: string,
  sinceSeq: number,
  res: Response,
): Promise<void> {
  const run = await findOwnedLoopRun(userId, runId)

  if (run.engine !== 'loop') {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '该任务不是循环引擎运行，请走旧版事件回放。')
  }

  if ((run.runtimeProtocolVersion ?? 0) !== 0) return streamDurableRun(userId, runId, sinceSeq, res)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const writeEvent = (event: AgentStreamEvent) => {
    res.write(`id: ${event.seq}\n`)
    res.write(`event: ${event.type}\n`)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    ;(res as Response & { flush?: () => void }).flush?.()
  }

  const bus = getRunEventBus(runId)

  if (bus) {
    // live：补发历史 + 实时订阅；终态事件后由客户端关闭，服务端兜底监听断开
    // 心跳注释行：等待审批/提问期间长时间无事件，防止 Nginx 空闲超时掰断 SSE
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n')
      ;(res as Response & { flush?: () => void }).flush?.()
    }, 20000)

    // subscribe 会同步补发内存历史。若历史已经包含终态，回调会在
    // unsubscribe 赋值前执行；旧写法会触发 TDZ ReferenceError，导致刚结束时
    // 连接直播偶发 500。用幂等 finish + replay 标记覆盖这条竞态。
    let unsubscribe: () => void = () => undefined
    let subscriptionReady = false
    let terminalDuringReplay = false
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      unsubscribe()
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
    }

    unsubscribe = bus.subscribe((event) => {
      writeEvent(event)
      if (event.type === 'run.finished' || event.type === 'run.paused' || (event.type === 'error' && !event.recoverable)) {
        if (subscriptionReady) finish()
        else terminalDuringReplay = true
      }
    }, sinceSeq)
    subscriptionReady = true
    if (terminalDuringReplay) finish()

    res.on('close', () => {
      finish()
    })
    return
  }

  // replay：run 已结束（或进程重启），从 DB 重放真实事件
  const events = await loadPersistedEvents(runId, sinceSeq)
  for (const event of events) {
    writeEvent(event)
  }

  // 进程重启后的孤儿/已收尾 run：持久化事件里可能永远没有终态事件，
  // 直播中的前端会无限重连并卡在“执行中”。按 DB 终态补发合成终态事件收尾。
  const hasTerminal = events.some(
    (event) => event.type === 'run.finished' || event.type === 'run.paused' || (event.type === 'error' && !event.recoverable),
  )
  if (!hasTerminal) {
    const latest = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true, outputSummary: true, usage: true } })
    const nextSeq = (events.length > 0 ? events[events.length - 1].seq : sinceSeq) + 1
    const base = { seq: nextSeq, runId, ts: new Date().toISOString() }
    if (latest?.status === 'paused') {
      writeEvent({ ...base, type: 'run.paused', reason: 'user_stop' })
    } else if (latest && ['completed', 'cancelled', 'failed'].includes(latest.status)) {
      const status = latest?.status === 'completed' ? 'succeeded' : latest?.status === 'cancelled' ? 'cancelled' : 'failed'
      const savedUsage = z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).safeParse(latest.usage)
      writeEvent({
        ...base,
        type: 'run.finished',
        status,
        usage: savedUsage.success ? savedUsage.data : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        artifacts: [],
        outputSummary: latest?.outputSummary ?? '',
        ...readAuthorEnded(latest.usage),
      })
    }
    // No local bus is not an execution verdict. For queued/running/approval
    // states leave the durable status intact; reconnect/startup recovery checks
    // its owner. Never synthesize failure just because this process has no bus.
  }
  res.end()
}

export async function resolveLoopRunApproval(
  userId: string,
  runId: string,
  callId: string,
  approved: boolean,
  alwaysAllow: boolean,
  approvalId?: string,
): Promise<{ resolved: boolean }> {
  const run = await findOwnedLoopRun(userId, runId)
  if ((run.runtimeProtocolVersion ?? 0) !== 0) {
    if (!approvalId) throw new DataAccessError(409, 'APPROVAL_ID_REQUIRED', '请刷新审批卡片后确认原审批请求。')
    return resolveDurableApproval({ userId, runId, requestId: approvalId, callId, approved, alwaysAllow })
  }

  const resolved = resolveApproval(runId, callId, approved, alwaysAllow)

  if (!resolved) {
    throw new DataAccessError(409, 'APPROVAL_NOT_PENDING', '该审批已处理或已超时。')
  }

  return { resolved: true }
}

/** 回答 ask_user 工具的挂起提问，唤醒循环继续执行 */
export async function resolveLoopRunQuestion(
  userId: string,
  runId: string,
  callId: string,
  answer: string,
  requestId?: string,
): Promise<{ resolved: boolean }> {
  const run = await findOwnedLoopRun(userId, runId)
  if (run.runtimeProtocolVersion > 0) {
    if (!requestId) throw new DataAccessError(409, 'QUESTION_REQUEST_REQUIRED', '请刷新原提问卡片后回答。')
    return resolveDurableQuestion({ userId, runId, callId, answer, requestId })
  }

  const resolved = resolveQuestionAnswer(runId, callId, answer)

  if (!resolved) {
    throw new DataAccessError(409, 'QUESTION_NOT_PENDING', '该提问已处理或已超时。')
  }

  return { resolved: true }
}

export async function stopLoopRun(userId: string, runId: string): Promise<{ stopped: boolean }> {
  const run = await findOwnedLoopRun(userId, runId)

  if (run.runtimeProtocolVersion !== 0 || run.taskRootId) {
    const paused = await pauseDurableTask(userId, runId)
    for (const id of paused.runIds) stopAgentRun(id)
    return { stopped: paused.stopped }
  }

  const stopped = stopAgentRun(runId)

  if (stopped && !(await fenceLocallyStoppedLegacyRun(userId, runId))) {
    const paused = await pauseDurableTask(userId, runId)
    for (const id of paused.runIds) stopAgentRun(id)
    return { stopped: true }
  }

  if (!stopped) {
    // 内存里没有活跃 run 但 DB 还停在进行中：进程重启（部署 reload/崩溃）遗留的孤儿任务，
    // 就地收尾为 paused 并补一条中断说明消息，避免用户永远无法暂停/看不到终止原因
    if (!(await pauseLegacyOrphanRun(userId, run.id))) {
      const paused = await pauseDurableTask(userId, run.id)
      for (const id of paused.runIds) stopAgentRun(id)
    }
    return { stopped: true }
  }

  return { stopped: true }
}

/**
 * 进程启动兜底：上一个进程被杀（部署 reload/崩溃）时遗留的进行中 run 无人收尾，
 * 前端会永远显示“执行中”、暂停接口报“任务不在运行中”。启动时统一标记为 failed，
 * 并在会话里补一条终止说明消息，让刷新后的对话结尾能看到终止原因。
 */
export async function recoverOrphanLoopRuns(): Promise<void> {
  try {
    const orphans = await prisma.agentRun.findMany({
      where: { engine: 'loop', runtimeProtocolVersion: 0, taskRootId: null, status: { in: ['queued', 'running', 'awaiting_approval'] } },
      select: { id: true, userId: true },
    })

    if (orphans.length === 0) {
      return
    }

    let recovered = 0
    for (const run of orphans) if (await recoverLegacyOrphanRun(run.userId, run.id)) recovered += 1
    console.log(`[agent-loop] 启动清理：${recovered} 个旧协议遗留任务已标记为中断`)
  } catch (error) {
    console.error('[agent-loop] 启动清理遗留任务失败', error)
  }
}

/** 续跑时的模型选择：跟随作者当前选择；缺省沿用原任务档位。 */
export type ContinueLoopRunModelSelection = {
  modelTier?: CreditModelTier
  customModelId?: string | null
  reasoningEffort?: ModelReasoningEffort
}

export async function continueLoopRun(
  userId: string,
  runId: string,
  model?: ContinueLoopRunModelSelection,
): Promise<StartAgentLoopRunResponse> {
  return withUserRunLock(userId, () => continueLoopRunLocked(userId, runId, model))
}

/** B0 recovery batch for existing durable tasks, separate from legacy cleanup.
 * Discovery is only a hint: the
 * dispatcher must acquire the original lease and revalidate the saved frame.
 * Unknown operations are reconciled/paused by that same executor, never reset. */
export async function recoverDurableLoopRuns() {
  const candidates = await runtimeTransaction(async tx => {
    const now = await databaseNow(tx)
    return tx.agentRunLease.findMany({
      where: { enabled: true, OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
        run: { engine: 'loop', runtimeProtocolVersion: 1, status: { in: ['queued', 'running'] },
          taskRoot: { is: { status: 'active', authorizationMode: 'legacy', executionState: { isNot: null } } } } },
      orderBy: [{ updatedAt: 'asc' }, { runId: 'asc' }], take: 32,
      select: { run: { select: { id: true, userId: true, sessionId: true } } },
    })
  })
  // In B0, waiting tasks remain registered with a heartbeat. A concurrent scan
  // may observe an old row, but cannot steal an active owner or resume a stop.
  return Promise.all(candidates.map(async ({ run }) => {
    if (getActiveRun(run.id) || hasActiveRunInSession(run.sessionId)) return { runId: run.id, status: 'skipped' as const }
    try {
      await executePersistedLoopRun(run.userId, run.id)
      return { runId: run.id, status: 'dispatched' as const }
    } catch (error) {
      const code = error instanceof DataAccessError ? error.code : 'RECOVERY_FAILED'
      if (!['RUN_IN_PROGRESS', 'RUN_LIMIT', 'RUNTIME_LEASE_BUSY', 'RUNTIME_LEASE_REVOKED', 'RUNTIME_NOT_ACTIVE'].includes(code)) {
        console.error('[agent-loop] 持久任务恢复未完成', { runId: run.id, code })
      }
      return { runId: run.id, status: 'not_dispatched' as const, code }
    }
  }))
}

async function continueLoopRunLocked(
  userId: string,
  runId: string,
  model?: ContinueLoopRunModelSelection,
): Promise<StartAgentLoopRunResponse> {
  const run = await findOwnedLoopRun(userId, runId)
  if (hasAuthorEnded(run.usage)) throw new DataAccessError(409, 'RUN_AUTHOR_ENDED', '原任务已按作者要求结束，请发送明确的新任务；已有成果保留。')
  await prisma.$transaction(tx => assertAgentManuscriptCurrent(tx, { userId, novelId: run.novelId, runId }))

  assertTaskAuthorizationRuntimeReady(run.taskSpec, { userId, sessionId: run.sessionId, novelId: run.novelId })
  if (run.runtimeProtocolVersion === 1 && run.taskRootId) {
    const admitted = readAdmittedStart(run)
    await assertManagedAttachmentsAccess(admitted?.attachments, userId)
    // Resume may only need to deliver/settle an already-paid result. The
    // provider adapter checks credits before any genuinely new paid request.
    const pause = await prisma.agentExecutionOutbox.findFirst({ where: { taskRootId: run.taskRootId, type: 'run.paused',
      payload: { path: ['runIds'], array_contains: [runId] } }, orderBy: { sequence: 'desc' }, select: { id: true } })
    if (!pause) throw new DataAccessError(409, 'STALE_RESUME_TARGET', '缺少本次任务的原暂停记录。')
    const resumed = await resumeDurableTask({ userId, runId, pauseEventId: pause.id })
    // The original saved frame is the only input. No assembleContext, new user
    // message, model/skill selection, or fresh budget is allowed on this path.
    if (!getActiveRun(resumed.run.id) && ['queued', 'running'].includes(resumed.run.status)) {
      void executeOwnedPersistedLoopRun(resumed.run).catch(error => {
        console.error('[agent-loop] 原任务续跑未完成', { runId: resumed.run.id, code: error instanceof DataAccessError ? error.code : 'RESUME_FAILED' })
      })
    }
    return { runId: resumed.run.id, sessionId: run.sessionId, status: resumed.run.status, streamUrl: `/api/agent/runs/${resumed.run.id}/stream` }
  }
  assertLegacyRuntimeCompatible(run)

  if (run.engine !== 'loop') {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '仅循环引擎任务支持续跑。')
  }

  if (run.status !== 'paused' && run.status !== 'failed') {
    throw new DataAccessError(409, 'RUN_NOT_PAUSED', '仅暂停或中断的任务可以继续。')
  }

  if (getActiveRun(runId) || hasActiveRunInSession(run.sessionId)) {
    throw new DataAccessError(409, 'RUN_IN_PROGRESS', '当前会话已有任务在执行。')
  }

  // 续跑与新建任务使用同一交互并发上限。否则作者可以同时继续多个已暂停
  // run，绕过 startLoopRun 的账户级并发保护并瞬间放大模型成本。
  if (countActiveRunsByUser(userId) >= env.agentUserMaxConcurrent) {
    throw new DataAccessError(409, 'RUN_LIMIT', `同时进行的任务数已达上限（${env.agentUserMaxConcurrent}），请稍后再试。`)
  }

  // 续跑跟随作者当前模型选择：0 余额用户换上 0 倍率免费档后必须能继续旧任务，
  // 不能被原收费档的额度闸门拦截；未提供选择时沿用原任务档位。
  const nextTier = (model?.modelTier ?? run.modelTier) as CreditModelTier
  const nextCustomModelId = nextTier === 'custom' ? model?.customModelId ?? run.customModelId ?? null : null
  if (nextTier === 'custom' && !nextCustomModelId) throw new DataAccessError(400, 'VALIDATION_ERROR', '请选择要使用的自定义模型。')
  const nextReasoningEffort = (model?.reasoningEffort ?? run.reasoningEffort) as ModelReasoningEffort
  await assertCreditAccess(userId, nextTier)
  await getModelTierRuntime(nextTier, userId, nextCustomModelId, nextReasoningEffort)

  // A stale tab must not revive an old task after the author has started a new one.
  const latest = await prisma.agentRun.findFirst({ where: { sessionId: run.sessionId }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  if (latest?.id !== run.id) {
    throw new DataAccessError(409, 'STALE_RESUME_TARGET', '当前会话已开始新任务，不能从旧入口续跑。请刷新后继续最新任务。')
  }
  const originalMessage = await prisma.agentMessage.findFirst({ where: { runId: run.id, sessionId: run.sessionId, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
  const queued = await prisma.agentQueuedRequest.findFirst({ where: { runId: run.id, userId }, select: { payload: true } })
  const savedInput = readAdmittedStart(run)
  const queuedParsed = !savedInput && queued ? persistedStartSchema.safeParse(queued.payload) : null
  if (queuedParsed && !queuedParsed.success) throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '原始排队请求已损坏，不能从摘要猜测恢复。')
  const queuedInput = savedInput ?? (queuedParsed?.success ? queuedParsed.data : undefined)
  const originalPrompt = Array.isArray(originalMessage?.parts)
    ? originalMessage.parts.flatMap(part => part && typeof part === 'object' && !Array.isArray(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
    : ''
  let eventStartSeq: number
  if (queuedInput && originalPrompt && originalPrompt !== queuedInput.prompt) {
    throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '原始消息与启动请求不一致，不能选择其一继续。')
  }
  if (queuedInput && (queuedInput.sessionId !== run.sessionId || queuedInput.novelId !== run.novelId
    || (queuedInput.chapterId?.trim() || null) !== run.chapterId || queuedInput.mode !== (run.mode === 'act' ? 'build' : run.mode))) {
    throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '原始请求不属于当前任务。')
  }
  const resumePrompt = originalPrompt || queuedInput?.prompt
  if (!resumePrompt?.trim()) throw new DataAccessError(409, 'RUN_INPUT_REQUIRED', '该历史任务缺少完整原始需求，无法安全继续。请在输入框重新说明本次任务；已保存内容不会改变。')
  await assertManagedAttachmentsAccess(queuedInput?.attachments, userId)
  try {
    eventStartSeq = await prepareRunEventResume(run.id)
  } catch {
    throw new DataAccessError(503, 'RUN_EVENTS_PENDING', '任务记录尚未完成同步，请稍后继续；不会重复启动任务。')
  }
  // Reject a genuinely exhausted execution before admitting another run or
  // generating a paid summary. Paused gaps come from the flushed event journal.
  if (run.startedAt) {
    const boundaries = await prisma.agentRunEvent.findMany({ where: { runId: run.id,
      type: { in: ['run.started', 'run.paused', 'run.finished'] } }, orderBy: { seq: 'asc' }, select: { type: true, createdAt: true } })
    const elapsed = recoverRunElapsedMs(run.startedAt.getTime(), Date.now(),
      boundaries.map(event => ({ type: event.type, at: event.createdAt.getTime() })))
    if (elapsed === null) throw new DataAccessError(409, 'RUN_TIME_UNCONFIRMED', '原任务执行时间记录不一致，未启动续跑。')
    const saved = savedRunUsageSchema.safeParse(run.usage)
    const minutes = saved.success && (saved.data.checkpoint?.resumeCount ?? 0) > 0
      ? env.agentRunWallClockLongMinutes : env.agentRunWallClockMinutes
    if (elapsed + (saved.success ? saved.data.checkpoint?.inheritedExecutionMs ?? 0 : 0) > minutes * 60_000) throw new DataAccessError(409, 'RUN_TIME_EXHAUSTED',
      `任务累计执行时长已达${minutes}分钟上限（已排除有记录的暂停等待时间）。未发起模型请求；已保存成果保留，重复继续不会增加预算。`)
  }
  // B0 still serializes service admissions with withUserRunLock. Include saved
  // queued/recovering work in the limit, not just controllers in this process.
  if (await prisma.agentRun.count({ where: { userId, status: { in: ['queued', 'running', 'awaiting_approval'] } } }) >= env.agentUserMaxConcurrent) {
    throw new DataAccessError(409, 'RUN_LIMIT', '同时进行的任务数已达上限，请稍后再试。')
  }
  // Persist a model change only after the exact target/input/time checks pass.
  if (nextTier !== run.modelTier || nextCustomModelId !== run.customModelId || nextReasoningEffort !== run.reasoningEffort) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { modelTier: nextTier, customModelId: nextCustomModelId, reasoningEffort: nextReasoningEffort } })
  }
  // No awaits between this second concurrency check and executeAgentRun's synchronous registration.
  if (getActiveRun(runId) || hasActiveRunInSession(run.sessionId)) {
    throw new DataAccessError(409, 'RUN_IN_PROGRESS', '当前会话已有任务在执行。')
  }
  if (countActiveRunsByUser(userId) >= env.agentUserMaxConcurrent) {
    throw new DataAccessError(409, 'RUN_LIMIT', '同时进行的任务数已达上限，请稍后再试。')
  }

  void executeAgentRun({
    runId: run.id,
    sessionId: run.sessionId,
    userId,
    novelId: run.novelId,
    chapterId: run.chapterId,
    mode: run.mode === 'act' ? 'build' : run.mode,
    prompt: resumePrompt,
    attachments: queuedInput?.attachments,
    selection: queuedInput?.selection,
    creativeFreedom: queuedInput?.creativeFreedom,
    qualityMode: queuedInput?.qualityMode,
    pinnedSkillIds: queuedInput?.pinnedSkillIds,
    pinnedSubagentId: queuedInput?.pinnedSubagentId,
    agentType: queuedInput?.agentProfile ?? 'orchestrator',
    tokenBudget: queuedInput?.tokenBudget,
    resume: true,
    eventStartSeq,
    modelTier: nextTier,
    customModelId: nextCustomModelId,
    reasoningEffort: nextReasoningEffort,
  })

  return {
    runId: run.id,
    sessionId: run.sessionId,
    status: 'running',
    streamUrl: `/api/agent/runs/${run.id}/stream`,
  }
}

// ---------------------------------------------------------------------------
// 阶段 K2：sessions CRUD 与历史回放（自 legacy agent-service.ts 迁入，行为原样保留）
// ---------------------------------------------------------------------------

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null
  }

  return typeof value === 'string' ? value : value.toISOString()
}

function asMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function asAgentActionPlan(value: unknown): AgentActionPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const plan = value as Record<string, unknown>
  if (
    (plan.mode !== 'plan' && plan.mode !== 'execute' && plan.mode !== 'review') ||
    typeof plan.summary !== 'string' ||
    !Array.isArray(plan.steps)
  ) {
    return null
  }

  return plan as unknown as AgentActionPlan
}

function asAgentWorkspaceToolPolicy(value: unknown): AgentWorkspaceToolPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const policy = value as Record<string, unknown>
  if (
    (policy.mode !== 'plan' && policy.mode !== 'build' && policy.mode !== 'review') ||
    !Array.isArray(policy.tools)
  ) {
    return null
  }

  return policy as unknown as AgentWorkspaceToolPolicy
}

function asAgentExecutionAgent(value: unknown): AgentExecutionAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Record<string, unknown>
  const validAgentType = [
    'writingOrchestrator',
    'storyPlanner',
    'draftWriter',
    'continuityEditor',
    'styleEditor',
    'loreLibrarian',
    'coverPromptAgent',
  ].includes(String(candidate.agentType))

  if (!validAgentType || (candidate.role !== 'primary' && candidate.role !== 'specialist')) {
    return null
  }

  if (typeof candidate.title !== 'string' || typeof candidate.description !== 'string') {
    return null
  }

  return candidate as unknown as AgentExecutionAgent
}

function buildExecutionAgent(agentType: AgentRun['agentType']): AgentExecutionAgent {
  switch (agentType) {
    case 'writingOrchestrator':
      return {
        agentType,
        role: 'primary',
        title: '主控 Agent',
        description: '负责理解当前指令、组织工作区上下文，并决定交给哪个专职代理处理。',
      }
    case 'storyPlanner':
      return {
        agentType,
        role: 'specialist',
        title: '剧情规划 Agent',
        description: '负责章节规划、结构拆解、书名与章节名提案等前置设计任务。',
      }
    case 'draftWriter':
      return {
        agentType,
        role: 'specialist',
        title: '正文写作 Agent',
        description: '负责起草正文、续写章节，并把可执行写作结果交回工作台。',
      }
    case 'continuityEditor':
      return {
        agentType,
        role: 'specialist',
        title: '连续性审阅 Agent',
        description: '负责检查设定冲突、时间线问题和章节之间的连续性。',
      }
    case 'styleEditor':
      return {
        agentType,
        role: 'specialist',
        title: '文风编辑 Agent',
        description: '负责改写、润色和局部表达优化，不直接承担全章规划。',
      }
    case 'loreLibrarian':
      return {
        agentType,
        role: 'specialist',
        title: '设定检索 Agent',
        description: '负责读取作品上下文、设定摘要和历史记忆，为当前任务补全背景。',
      }
    case 'coverPromptAgent':
      return {
        agentType,
        role: 'specialist',
        title: '封面提示词 Agent',
        description: '负责整理封面画面描述和视觉提示词，不介入正文写作接口。',
      }
  }
}

function asAgentRouteDecision(value: unknown): AgentRouteDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Record<string, unknown>
  const sourceAgent = asAgentExecutionAgent(candidate.sourceAgent)
  const targetAgent = asAgentExecutionAgent(candidate.targetAgent)

  if (!sourceAgent || !targetAgent) {
    return null
  }

  if (
    typeof candidate.task !== 'string' ||
    typeof candidate.intentLabel !== 'string' ||
    typeof candidate.summary !== 'string'
  ) {
    return null
  }

  return {
    sourceAgent,
    targetAgent,
    task: candidate.task,
    intentLabel: candidate.intentLabel,
    summary: candidate.summary,
    factors: Array.isArray(candidate.factors)
      ? candidate.factors.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

function asAgentRuleBundle(value: unknown): AgentRuleBundle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.summary !== 'string' || !Array.isArray(candidate.rules)) {
    return null
  }

  const rules = candidate.rules.filter((rule): rule is string => typeof rule === 'string')
  return {
    summary: candidate.summary,
    rules,
  }
}

function asAgentStoryMemoryDigest(value: unknown): AgentStoryMemoryDigest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.summary !== 'string' || !Array.isArray(candidate.items)) {
    return null
  }

  const items = candidate.items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }

    const entry = item as Record<string, unknown>
    if (
      typeof entry.title !== 'string' ||
      typeof entry.memoryType !== 'string' ||
      typeof entry.excerpt !== 'string'
    ) {
      return []
    }

    return [
      {
        title: entry.title,
        memoryType: entry.memoryType as ProjectMemoryEntry['memoryType'],
        excerpt: entry.excerpt,
      },
    ]
  })

  return {
    summary: candidate.summary,
    items,
  }
}

function asAgentActionHandoff(value: unknown): AgentActionHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentActionHandoff>
  if (
    (candidate.sourceMode !== 'plan' && candidate.sourceMode !== 'build' && candidate.sourceMode !== 'review') ||
    (candidate.targetMode !== 'plan' && candidate.targetMode !== 'build' && candidate.targetMode !== 'review') ||
    typeof candidate.title !== 'string' ||
    typeof candidate.summary !== 'string' ||
    typeof candidate.confirmLabel !== 'string'
  ) {
    return null
  }

  return candidate as AgentActionHandoff
}

function hydrateHandoffSource(
  handoff: AgentActionHandoff | null,
  runId: string,
  artifactId: string,
): AgentActionHandoff | null {
  if (!handoff) {
    return null
  }

  return {
    ...handoff,
    sourceRunId: handoff.sourceRunId ?? runId,
    sourceArtifactId: handoff.sourceArtifactId ?? artifactId,
  }
}

function defaultArtifactApplyStrategies(
  artifactType: AgentArtifact['artifactType'],
): AgentArtifactApplyStrategy[] {
  if (artifactType === 'chapterDraft') {
    return ['replaceChapterContent', 'appendChapterContent']
  }

  if (artifactType === 'chapterContinuation') {
    return ['appendChapterContent', 'replaceChapterContent']
  }

  if (artifactType === 'rewriteSelection' || artifactType === 'polishSelection') {
    return ['replaceChapterContent']
  }

  if (artifactType === 'chapterPlan' || artifactType === 'continuityReview') {
    return ['saveChapterSummary']
  }

  if (artifactType === 'coverPrompt') {
    return ['setNovelCoverPrompt']
  }

  return []
}

function resolveArtifactApplyStrategies(record: {
  artifactType: AgentArtifact['artifactType']
  metadata?: Record<string, unknown> | null
}): AgentArtifactApplyStrategy[] {
  const metadata = record.metadata ?? null

  if (Array.isArray(metadata?.availableApplyStrategies)) {
    return metadata.availableApplyStrategies.filter(
      (strategy): strategy is AgentArtifactApplyStrategy => typeof strategy === 'string',
    )
  }

  const task = typeof metadata?.workspaceTask === 'string' ? metadata.workspaceTask : null
  if (
    task === 'generate-novel-title' ||
    task === 'generate-chapter-titles' ||
    task === 'read-story-context' ||
    task === 'workspace-agent'
  ) {
    return []
  }

  return defaultArtifactApplyStrategies(record.artifactType)
}

export function toAgentSession(record: {
  id: string
  userId: string
  novelId: string
  title: string
  status: AgentSession['status']
  pinnedAt?: Date | string | null
  toolPolicy?: unknown
  sandboxMode?: string
  novel?: { title: string; displayTitle: string | null }
  lastRunAt?: Date | string | null
  forkedFromSessionId?: string | null
  forkedFromMessageId?: string | null
  forkedAt?: Date | string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}): AgentSession {
  return {
    id: record.id,
    userId: record.userId,
    novelId: record.novelId,
    title: record.title,
    status: record.status,
    pinnedAt: toIso(record.pinnedAt),
    toolPolicy: record.toolPolicy as AgentSession['toolPolicy'] ?? null,
    sandboxMode: record.sandboxMode === 'read_only' || record.sandboxMode === 'full_access' ? record.sandboxMode : 'workspace',
    novelTitle: record.novel?.displayTitle?.trim() || record.novel?.title,
    lastRunAt: toIso(record.lastRunAt),
    forkedFromSessionId: record.forkedFromSessionId ?? null,
    forkedFromMessageId: record.forkedFromMessageId ?? null,
    forkedAt: toIso(record.forkedAt),
    createdAt: toIso(record.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(record.updatedAt) ?? new Date().toISOString(),
  }
}


function toAgentRun(record: {
  id: string
  sessionId: string
  userId: string
  novelId: string
  chapterId?: string | null
  mode: AgentRun['mode']
  action: string | null
  agentType: AgentRun['agentType']
  status: AgentRun['status']
  inputSummary?: string | null
  outputSummary?: string | null
  errorMessage?: string | null
  startedAt?: Date | string | null
  finishedAt?: Date | string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
  usage?: unknown
}): AgentRun {
  return {
    id: record.id,
    sessionId: record.sessionId,
    userId: record.userId,
    novelId: record.novelId,
    chapterId: record.chapterId ?? null,
    mode: record.mode,
    // Prisma 枚举比契约宽（含 workspaceAgent），any 时代即原样透传，此处保持透传语义
    action: record.action as unknown as AgentRun['action'],
    agentType: record.agentType,
    status: record.status,
    inputSummary: record.inputSummary ?? null,
    outputSummary: record.outputSummary ?? null,
    ...readAuthorEnded(record.usage),
    errorMessage: record.errorMessage ?? null,
    startedAt: toIso(record.startedAt),
    finishedAt: toIso(record.finishedAt),
    createdAt: toIso(record.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(record.updatedAt) ?? new Date().toISOString(),
  }
}

function toAgentArtifact(record: {
  id: string
  runId: string
  artifactType: AgentArtifact['artifactType']
  title: string
  summary?: string | null
  content: string
  metadata?: unknown
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}): AgentArtifact {
  const metadata = asMetadataRecord(record.metadata)

  return {
    id: record.id,
    runId: record.runId,
    artifactType: record.artifactType,
    title: record.title,
    summary: record.summary ?? null,
    content: record.content,
    metadata,
    availableApplyStrategies: resolveArtifactApplyStrategies({
      artifactType: record.artifactType,
      metadata,
    }),
    createdAt: toIso(record.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(record.updatedAt) ?? new Date().toISOString(),
  }
}

function toProjectMemoryEntry(record: {
  id: string
  runId?: string | null
  novelId: string
  sourceChapterId?: string | null
  memoryType: ProjectMemoryEntry['memoryType']
  title: string
  content: string
  importance?: number | null
  embeddingRef?: string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}): ProjectMemoryEntry {
  return {
    id: record.id,
    runId: record.runId ?? null,
    novelId: record.novelId,
    sourceChapterId: record.sourceChapterId ?? null,
    memoryType: record.memoryType,
    title: record.title,
    content: record.content,
    importance: record.importance ?? 50,
    embeddingRef: record.embeddingRef ?? null,
    createdAt: toIso(record.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(record.updatedAt) ?? new Date().toISOString(),
  }
}

async function ensureOwnedNovel(userId: string, novelId: string) {
  const novel = await prisma.novel.findUnique({
    where: { id: novelId },
  })

  if (!novel) {
    throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '未找到作品。')
  }

  if (novel.authorId !== userId) {
    throw new DataAccessError(403, 'NOVEL_FORBIDDEN', '当前账号无权访问该作品。')
  }

  return novel
}

async function ensureOwnedSession(userId: string, sessionId: string) {
  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
  })

  if (!session) {
    throw new DataAccessError(404, 'AGENT_SESSION_NOT_FOUND', '未找到会话。')
  }

  if (session.userId !== userId) {
    throw new DataAccessError(403, 'AGENT_SESSION_FORBIDDEN', '当前账号无权访问该会话。')
  }

  return session
}

function buildAgentRunResultPayload(
  run: AgentRunRecord,
  artifacts: Awaited<ReturnType<typeof prisma.agentArtifact.findMany>>,
  memoryEntries: Awaited<ReturnType<typeof prisma.projectMemoryEntry.findMany>>,
): AgentActionResponse['data'] {
  const artifactItems = artifacts.map(toAgentArtifact)
  const memoryItems = memoryEntries.map(toProjectMemoryEntry)
  const firstArtifact = artifactItems[0] ?? null
  const executionMode =
    firstArtifact?.metadata && typeof firstArtifact.metadata === 'object'
      ? ((firstArtifact.metadata as Record<string, unknown>).executionMode as AgentExecutionMode | null | undefined) ?? null
      : null
  const activeAgent =
    asAgentExecutionAgent(firstArtifact?.metadata?.activeAgent) ?? buildExecutionAgent(run.agentType)
  const routeDecision = asAgentRouteDecision(firstArtifact?.metadata?.routeDecision)
  const ruleBundle = asAgentRuleBundle(firstArtifact?.metadata?.ruleBundle)
  const storyMemoryDigest = asAgentStoryMemoryDigest(firstArtifact?.metadata?.storyMemoryDigest)
  const actionPlan = asAgentActionPlan(firstArtifact?.metadata?.actionPlan)
  const toolPolicy = asAgentWorkspaceToolPolicy(firstArtifact?.metadata?.toolPolicy)
  const stepResults =
    firstArtifact?.metadata && typeof firstArtifact.metadata === 'object'
      ? ((firstArtifact.metadata as Record<string, unknown>).stepResults as AgentActionResponse['data']['stepResults']) ?? null
      : null
  const handoff = hydrateHandoffSource(
    asAgentActionHandoff(firstArtifact?.metadata?.handoff),
    run.id,
    firstArtifact?.id ?? '',
  )

  return {
    run: toAgentRun(run),
    artifacts: artifactItems,
    memoryEntries: memoryItems,
    artifact: firstArtifact,
    title: firstArtifact?.title ?? 'Agent 结果',
    content: firstArtifact?.content ?? '',
    summary: firstArtifact?.summary ?? null,
    artifactType: firstArtifact?.artifactType ?? null,
    activeAgent,
    routeDecision,
    ruleBundle,
    storyMemoryDigest,
    executionMode,
    actionPlan,
    stepResults,
    handoff,
    toolPolicy,
    stream: {
      liveUrl: `/api/agent/runs/${run.id}/stream`,
      replayUrl: `/api/agent/runs/${run.id}/stream`,
    },
    result: firstArtifact?.content ?? '',
    prompt: run.inputSummary ?? undefined,
    outline: firstArtifact?.artifactType === 'chapterPlan' ? firstArtifact.content : undefined,
  }
}

export async function listAgentSessionsData(userId: string, novelId?: string, options?: { query?: string; includeArchived?: boolean }) {
  const query = options?.query?.trim()
  const items = await prisma.agentSession.findMany({
    where: {
      userId,
      ...(novelId ? { novelId } : {}),
      ...(options?.includeArchived ? {} : { status: 'active' }),
      ...(query ? { OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { novel: { title: { contains: query, mode: 'insensitive' } } },
        { novel: { displayTitle: { contains: query, mode: 'insensitive' } } },
        // 对话正文以 run 摘要保存；把它纳入全局搜索，而不把整段消息 JSON 拉到前端。
        { runs: { some: { OR: [
          { inputSummary: { contains: query, mode: 'insensitive' } },
          { outputSummary: { contains: query, mode: 'insensitive' } },
        ] } } },
      ] } : {}),
    },
    include: { novel: { select: { title: true, displayTitle: true } } },
    orderBy: [{ pinnedAt: 'desc' }, { updatedAt: 'desc' }],
    take: 100,
  })

  // 空且未命名的会话不进入列表：只有产生过对话（lastRunAt）或已被命名的会话才保留展示
  const visible = items.filter((session) => session.lastRunAt || !isDefaultSessionTitle(session.title))

  return {
    items: visible.map(toAgentSession),
  }
}

export async function createAgentSessionData(userId: string, input: CreateAgentSessionRequest) {
  const novel = await ensureOwnedNovel(userId, input.novelId)

  const session = await prisma.agentSession.create({
    data: {
      userId,
      novelId: input.novelId,
      title: input.title?.trim() || `${novel.title} 写作会话`,
      status: 'active',
    },
  })

  return {
    session: toAgentSession(session),
  }
}

export async function updateAgentSessionData(
  userId: string,
  sessionId: string,
  input: UpdateAgentSessionRequest,
) {
  const session = await ensureOwnedSession(userId, sessionId)
  const nextTitle = input.title?.trim()

  const updatedSession = await prisma.agentSession.update({
    where: { id: session.id },
    data: {
      title: nextTitle ? nextTitle.slice(0, 160) : undefined,
      status: input.status,
      pinnedAt: input.pinned === undefined ? undefined : input.pinned ? new Date() : null,
      toolPolicy: input.toolPolicy as Prisma.InputJsonValue | undefined,
      sandboxMode: input.sandboxMode,
    },
  })

  return {
    session: toAgentSession(updatedSession),
  }
}

export async function deleteAgentSessionData(userId: string, sessionId: string) {
  return withUserRunLock(userId, () => deleteAgentSessionLocked(userId, sessionId))
}

async function deleteAgentSessionLocked(userId: string, sessionId: string) {
  const session = await ensureOwnedSession(userId, sessionId)

  // Authorization precedes cancellation. Revoke durable ownership before
  // deleting records, including tasks whose owner is not in this process.
  const durableRuns = await prisma.agentRun.findMany({ where: { sessionId: session.id, userId, runtimeProtocolVersion: 1,
    status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })
  for (const run of durableRuns) await pauseDurableTask(userId, run.id)
  stopActiveRunsInSession(session.id)

  await prisma.$transaction(async (tx) => {
    const runs = await tx.agentRun.findMany({
      where: { sessionId: session.id },
      select: { id: true },
    })
    const runIds = runs.map((run) => run.id)

    if (runIds.length > 0) {
      await tx.projectMemoryEntry.deleteMany({
        where: {
          runId: { in: runIds },
        },
      })

      await tx.agentArtifact.deleteMany({
        where: {
          runId: { in: runIds },
        },
      })

      await tx.agentRun.deleteMany({
        where: { sessionId: session.id },
      })
    }

    await tx.agentSession.delete({
      where: { id: session.id },
    })
  })

  return {
    sessionId: session.id,
    deleted: true as const,
  }
}

/** 分支副本最多携带的对话轮数：超长任务只带最近若干轮，避免一次复制打爆事务 */
const FORK_RUN_LIMIT = 400
/** 同名任务角标上限：够用且避免异常输入导致死循环 */
const FORK_SUFFIX_LIMIT = 99

/** 去掉标题尾部的「 (2)」角标，拿到分支族的基名 */
function stripForkSuffix(title: string): string {
  return title.replace(/\s*\(\d+\)\s*$/, '').trim() || title.trim()
}

/**
 * 生成分支标题：与源任务同名并追加角标，角标取该作品下同族任务的最大值 +1。
 * 例：「评估仓库类型」已有 (2)(3) 时，新分支为「评估仓库类型 (4)」。
 */
function nextForkTitle(baseTitle: string, siblingTitles: string[]): string {
  const base = stripForkSuffix(baseTitle)
  let maxIndex = 1
  for (const title of siblingTitles) {
    const trimmed = title.trim()
    if (stripForkSuffix(trimmed) !== base) continue
    const matched = /\((\d+)\)\s*$/.exec(trimmed)
    const index = matched ? Number(matched[1]) : 1
    if (Number.isFinite(index) && index > maxIndex) maxIndex = index
  }
  const nextIndex = Math.min(maxIndex + 1, FORK_SUFFIX_LIMIT)
  return `${base} (${nextIndex})`.slice(0, 160)
}

/** 运行中/待确认的 run 复制到分支后必须落终态，否则分支一打开就被判定为「有任务在跑」 */
function settledForkStatus(status: AgentRunRecord['status']): AgentRunRecord['status'] {
  return status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'cancelled'
}

/**
 * 从现有任务切出分支：新建一个同名带角标的任务，并把对话上下文（run + 消息）整份复制过去。
 * 传 fromMessageId 时只复制到该条对话为止，用于「从这条对话继续」的分叉。
 * 工件、记忆与事件流不复制：分支只承接对话上下文，写入产物仍归源任务，避免重复占用。
 */
export async function forkAgentSessionData(
  userId: string,
  sessionId: string,
  input?: { fromMessageId?: string; onCreated?: (tx: Prisma.TransactionClient, sessionId: string) => Promise<void> },
) {
  const session = await ensureOwnedSession(userId, sessionId)
  const fromMessageId = input?.fromMessageId?.trim() || undefined

  // 截断点：分支只带到这条对话（含），之后的对话不进副本
  let cutoff: Date | null = null
  if (fromMessageId) {
    const anchor = await prisma.agentMessage.findFirst({
      where: { id: fromMessageId, sessionId: session.id },
      select: { createdAt: true },
    })
    if (!anchor) throw new DataAccessError(404, 'AGENT_MESSAGE_NOT_FOUND', '这条对话已不存在，无法从它创建分支。')
    cutoff = anchor.createdAt
  }

  const siblings = await prisma.agentSession.findMany({
    where: { userId, novelId: session.novelId },
    select: { title: true },
    take: 200,
  })
  const title = nextForkTitle(session.title, siblings.map((item) => item.title))
  const forkedAt = new Date()

  const sourceRuns = await prisma.agentRun.findMany({
    where: { sessionId: session.id, ...(cutoff ? { createdAt: { lte: cutoff } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: FORK_RUN_LIMIT,
  })
  // 取的是最近 N 轮，写入前按时间正序还原，副本里的对话顺序与源任务一致
  sourceRuns.reverse()
  const sourceRunIds = sourceRuns.map((run) => run.id)
  const sourceMessages = sourceRunIds.length > 0
    ? await prisma.agentMessage.findMany({
        where: { runId: { in: sourceRunIds }, ...(cutoff ? { createdAt: { lte: cutoff } } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : []

  const forked = await prisma.$transaction(async (tx) => {
    const created = await tx.agentSession.create({
      data: {
        userId,
        novelId: session.novelId,
        title,
        status: 'active',
        toolPolicy: (session.toolPolicy ?? undefined) as Prisma.InputJsonValue | undefined,
        sandboxMode: session.sandboxMode,
        lastRunAt: session.lastRunAt,
        forkedFromSessionId: session.id,
        forkedFromMessageId: fromMessageId ?? null,
        forkedAt,
      },
    })

    const runIdMap = new Map<string, string>()
    for (const run of sourceRuns) {
      const copied = await tx.agentRun.create({
        data: {
          sessionId: created.id,
          userId,
          novelId: run.novelId,
          manuscriptRevision: run.manuscriptRevision,
          chapterId: run.chapterId,
          mode: run.mode,
          action: run.action,
          agentType: run.agentType,
          status: settledForkStatus(run.status),
          inputSummary: run.inputSummary,
          outputSummary: run.outputSummary,
          engine: run.engine,
          currentTurn: run.currentTurn,
          usage: (run.usage ?? undefined) as Prisma.InputJsonValue | undefined,
          taskSpec: (run.taskSpec ?? undefined) as Prisma.InputJsonValue | undefined,
          modelTier: run.modelTier,
          customModelId: run.customModelId,
          reasoningEffort: run.reasoningEffort,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          createdAt: run.createdAt,
        },
        select: { id: true },
      })
      runIdMap.set(run.id, copied.id)
    }

    // 消息保留原 createdAt：分支内新增对话必然晚于 forkedAt，前端据此收起「从聊天中继续」
    const messageRows = sourceMessages
      .map((message) => {
        const runId = runIdMap.get(message.runId)
        return runId
          ? { runId, sessionId: created.id, role: message.role, parts: message.parts as Prisma.InputJsonValue, createdAt: message.createdAt }
          : null
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
    if (messageRows.length > 0) await tx.agentMessage.createMany({ data: messageRows })

    await input?.onCreated?.(tx, created.id)
    return { created, runCount: runIdMap.size, messageCount: messageRows.length }
  })

  return {
    session: toAgentSession(forked.created),
    sourceSessionId: session.id,
    copiedRunCount: forked.runCount,
    copiedMessageCount: forked.messageCount,
  }
}

/** 任务窗口体系的历史回放：按 run 聚合产物与记忆，恢复历史计划/大纲等工件 */
export async function listAgentSessionHistoryData(userId: string, sessionId: string) {
  await ensureOwnedSession(userId, sessionId)

  const runs = await prisma.agentRun.findMany({
    where: {
      sessionId,
    },
    orderBy: [{ createdAt: 'asc' }],
  })

  if (runs.length === 0) {
    return {
      items: [],
    }
  }

  const runIds = runs.map((run) => run.id)
  const [artifacts, memoryEntries] = await prisma.$transaction([
    prisma.agentArtifact.findMany({
      where: {
        runId: {
          in: runIds,
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    }),
    prisma.projectMemoryEntry.findMany({
      where: {
        runId: {
          in: runIds,
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    }),
  ])

  const artifactMap = new Map<string, typeof artifacts>()
  for (const artifact of artifacts) {
    const existing = artifactMap.get(artifact.runId) ?? []
    existing.push(artifact)
    artifactMap.set(artifact.runId, existing)
  }

  const memoryMap = new Map<string, typeof memoryEntries>()
  for (const entry of memoryEntries) {
    if (!entry.runId) {
      continue
    }

    const existing = memoryMap.get(entry.runId) ?? []
    existing.push(entry)
    memoryMap.set(entry.runId, existing)
  }

  return {
    items: runs.map((run) =>
      buildAgentRunResultPayload(run, artifactMap.get(run.id) ?? [], memoryMap.get(run.id) ?? []),
    ),
  }
}

/** 侧栏任务窗口状态轮询：批量查询会话各自最新一条 run 的状态（30 天窗口内）。
 * awaiting_approval 同时覆盖权限审批与 ask_user 挂起；历史终态不在此回传——
 * 未读绿/红点由前端事件层实时记录，避免把几天前的旧完成误报为未读。 */
export async function listSessionRunStatuses(userId: string, sessionIds: string[]): Promise<AgentSessionRunStatusPayload> {
  const ids = [...new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, 50)
  if (ids.length === 0) return { statuses: {} }

  const owned = await prisma.agentSession.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  })
  if (owned.length === 0) return { statuses: {} }
  const ownedIds = owned.map((session) => session.id)

  const runs = await prisma.agentRun.findMany({
    where: {
      sessionId: { in: ownedIds },
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { id: true, sessionId: true, status: true, finishedAt: true, usage: true },
  })

  const statuses: AgentSessionRunStatusPayload['statuses'] = {}
  for (const id of ownedIds) statuses[id] = null
  for (const run of runs) {
    if (statuses[run.sessionId]) continue
    statuses[run.sessionId] = {
      runId: run.id,
      status: run.status as AgentRunStatus,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      ...readAuthorEnded(run.usage),
    }
  }
  return { statuses }
}
