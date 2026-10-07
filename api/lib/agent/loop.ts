import { observeLegacyContentProgress, observeRequiredResult, observeSemanticTransition, observeSemanticReadProgress, observeWritingWorkflowMilestone, nextStagnantBatch } from './semantic-progress.js'
import { freezeWritingScope, readCompletedWritingDelivery, readSavedWritingPresentation, assertCompletedWritingDelivery } from './writing-scope.js'
import { readPersistedWritingWorkflowMilestones } from './story-compiler.js'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { MAIN_RUN_FILTER } from './runtime-child.js'

import { containsAgentProtocolInvocation, recoverAgentProtocolToolCalls, stripAgentProtocolArtifacts } from '../../../shared/agent-output.js'
import type {
  AgentExecutionMode,
  AgentMessagePart,
  AgentStreamEventBody,
  AgentAttachmentMeta,
  AgentTodoItem,
  AgentTokenUsage,
  AgentToolDraft,
  CreativeFreedom,
  StoryCompilerMode,
  CreditModelTier,
} from '../../../shared/contracts/index.js'
import { env } from '../../config/env.js'
import { chatWithTools, type ChatMessage, type ToolCallRequest } from '../ai-service.js'
import { DataAccessError, prisma } from '../prisma.js'
import { withGoalEffects, withGoalExecutionContext } from './goal-context.js'
import { readGoalExecution } from './goal-fence.js'
import { getModelTierRuntime } from '../credits.js'
import { readManagedImageDataUrl } from '../agent-attachment-storage.js'
import { applySessionToolPolicy, getAgentDefinition, getToolsForAgent, type AgentDefinition } from './agents.js'
import { deregisterActiveRun, registerActiveRun } from './active-runs.js'
import { clearRunBaselines, getLastTouchedChapter } from './baseline.js'
import { assembleContext, insertSubagentCatalog } from './context.js'
import { captureUserDirectives, compactSessionContext } from './context-engine.js'
import { syncNovelMemoryProjection } from './story-memory.js'
import { resolveAgent2FeatureFlags } from '../agent2-feature-flags.js'
import { createRunEventBus, disposeRunEventBus, type RunEventBus } from './events.js'
import {
  cancelAllQuestions,
  grantAlwaysAllow,
  hasAlwaysAllow,
  rejectAllApprovals,
  waitForApproval,
} from './permissions.js'
import { toOpenAITools } from './tools/registry.js'
import { intersectToolAuthority, snapshotToolAuthority, restrictToolsToTask } from './tool-authority.js'
import { assertTaskAuthorizationRuntimeReady } from './task-authorization.js'
import { assertLegacyRuntimeCompatible, startLegacyRuntimeRun } from './runtime-identity.js'
import { normalizeToolInput, validateToolInput } from './tools/input-validation.js'
import { loadSessionTodoItems, renderTodoItems, cancelTaskTodoItems } from './tools/todo-tools.js'
import { parseToolArgsTolerant } from './tool-argument-parser.js'
import { getTaskRunIds } from './task-lineage.js'
import type { AgentTool, ToolContext } from './tools/types.js'
import { ORCHESTRATION_TOOL_NAMES, assertOrchestrationResumeGuard, buildOrchestrationResumeNote } from './tools/task-orchestration-tools.js'
import { createVisibleTextStreamer, humanizeAgentVisibleText } from './visible-text.js'
import { toolSignature, ToolAdmissionGuard } from './tool-signature.js'
import { createEmptyResponseGuard, createProtocolRecoveryGuard, isContinuationRequest, isExplicitAuthorEnd, hasAuthorEnded, promisesFurtherAction, requiresNextChapterDelivery } from './completion-guard.js'
import { toolFailureRecovery, toolRecoveryKey } from './tool-failure-recovery.js'
import { findToolRestriction, isLocalToolFailure, isInputScopedFailure, restoreToolRestriction, toolFailureInputHash, toolRestrictionTarget, type ToolRestriction } from './tool-local-failure.js'
import { readLimitedWritingDelivery, assertLimitedWritingDelivery, limitedReviewDependency, type LimitedWritingDelivery } from './writing-delivery-limitations.js'
import { readChapterReviewReadiness, probeChapterReviewRevision } from './chapter-review-guard.js'
import { nextMergedReviewReminder, nextReviewDispatch } from './review-dispatch.js'
import { activeChapterScope } from '../data/internal.js'
import { createRepeatDetector } from './repeat-detect.js'
import {
  savedRunUsageSchema,
  recoverLegacyRunUsage,
  recoverRunElapsedMs,
  type RunCheckpointState,
  type PendingReviewCall,
} from './checkpoint.js'
import { COMPATIBILITY_TOKEN_LIMIT, untilCompletionControl } from './execution-control.js'
import { autoNameSession } from './session-title.js'
import { withModelAssignmentContext, updateModelAssignmentContext } from './model-assignment-context.js'
import { buildTaskSpec, narrowLegacyResearchTask, narrowLegacyConversationTask } from './task-spec.js'
import { buildSkillExecutionDigest, routeSkills, type SkillPhase } from './skills/index.js'
import { resolveEnabledRuntimeSkills } from './skills/service.js'
import { nextSkillPhase, phaseIntent, phaseSignals } from './skills/lifecycle.js'
import { recordSkillLoads } from './skills/receipts.js'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/index.js'
import {
  collapseEarlyToolRounds,
  compactEarlyToolPayloads,
  estimateChatMessagesTokens,
  estimateToolDefinitionTokens,
  resolveAgentContextBudget,
  releaseCompletedReasoning,
} from './context-budget.js'

/**
 * Agent Loop 执行内核（plan/13 §4.3）。
 * while 循环：LLM → tool_calls → 执行 → tool 消息回填 → 再 LLM，直到 finishReason !== 'tool_calls'。
 * - 错误即观察：工具失败不中断 run，错误信息回填给模型自愈
 * - 审批暂停-恢复：'ask' 工具挂起循环等待前端批复，超时视为拒绝
 * - 完成条件与无进展保护，单次请求保持上下文与输出上限
 * 进行中 run 的登记表（activeRuns Map 及查询/停止函数）已拆至 active-runs.ts。
 */

export type ExecuteAgentRunParams = {
  /** Dedicated server goal activation resume; no manual budget grant. */
  activationResume?: { goalId: string; epoch: bigint }
  toolAuthorityCeiling?: import('./tool-authority.js').ToolAuthority
  /** Only a scheduler-admitted goal execution may use a system admission message. */
  internalGoalContinuation?: boolean
  goalSteering?: import('../../../shared/contracts/index.js').StartAgentLoopRunRequest
  /** Server-created original message, committed with new-run admission. */
  admittedMessageId?: string
  runId: string
  sessionId: string
  userId: string
  novelId: string
  chapterId: string | null
  mode: AgentExecutionMode
  prompt: string
  selection?: { text: string; start?: number; end?: number } | null
  /** 本轮附带附件元数据：持久化为用户消息 attachment parts 并注入上下文 */
  attachments?: AgentAttachmentMeta[]
  agentType?: string
  creativeFreedom?: CreativeFreedom
  qualityMode?: StoryCompilerMode
  /** 从 paused 恢复：历史含本 run 已持久化的消息，prompt 换成续跑指令 */
  resume?: boolean
  /** Server-owned journal high water mark, never accepted from model/user input. */
  eventStartSeq?: number
  modelTier?: CreditModelTier
  customModelId?: string | null
  reasoningEffort?: import('../../../shared/contracts/index.js').ModelReasoningEffort
  tokenBudget?: number
  /** 作者在输入框里手动指定本轮要用的技能 id。 */
  pinnedSkillIds?: string[]
  pinnedSubagentId?: string
  modelAssignments?: import('../../../shared/contracts/agent-model-assignments.js').FrozenModelAssignments
}

const emptyUsage = (): AgentTokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })

/** One tracker per request: retain reported partial usage on interruption,
 * then include only the remaining delta when the complete result arrives. */
function trackRequestUsage(total: AgentTokenUsage) {
  let observed = emptyUsage()
  return (value: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }) => {
    const promptTokens = Math.max(observed.promptTokens, value.promptTokens ?? 0)
    const completionTokens = Math.max(observed.completionTokens, value.completionTokens ?? 0)
    const totalTokens = Math.max(observed.totalTokens, value.totalTokens ?? 0, promptTokens + completionTokens)
    total.promptTokens += promptTokens - observed.promptTokens
    total.completionTokens += completionTokens - observed.completionTokens
    total.totalTokens += totalTokens - observed.totalTokens
    observed = { promptTokens, completionTokens, totalTokens }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
}

async function persistMessage(
  id: string,
  runId: string,
  sessionId: string,
  role: 'user' | 'assistant',
  parts: AgentMessagePart[],
) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // upsert 让网络重试与同一 messageId 的补写保持幂等，也允许最终完整 parts
      // 覆盖早期不完整快照，避免直播可见但刷新后缺失。
      await prisma.agentMessage.upsert({
        where: { id },
        create: { id, runId, sessionId, role, parts: parts as unknown as object },
        update: { role, parts: parts as unknown as object },
      })
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
      }
    }
  }
  console.error('[agent-loop] 消息持久化失败', runId, lastError)
  throw lastError
}

/** 工具输出包裹来源标注：正文/记忆里的指令性文字不构成新指令（plan/13 §4.10） */
function wrapToolOutput(toolName: string, output: string): string {
  return `<tool_output tool="${toolName}">\n${output}\n</tool_output>`
}

/**
 * 伪工具调用检测（plan/14 §五 C1）：模型把调用写进正文而没有真正发起 function calling。
 * 多模式覆盖：历史压缩标记格式、工具名+参数 JSON 同段出现、“我现在调用 xx”句式。
 */
function looksLikePseudoToolCall(content: string, toolNames: string[]): boolean {
  const mentioned = toolNames.filter((name) => content.includes(name))
  if (mentioned.length > 0) {
    // 工具名与参数 JSON（如 {"title": …）同时出现：大概率在文本里模拟调用
    if (/[{｛]\s*["'“”]?\w+["'“”]?\s*[:：]/.test(content)) {
      return true
    }
    if (mentioned.some((name) => new RegExp(`我(现在|将|马上|立[即刻]|来)?\\s*(调用|发起|执行|使用)[^。\\n]{0,20}${name}`).test(content))) {
      return true
    }
  }

  return /我(现在|将|马上|立[即刻])\s*(调用|发起|执行)[^。\n]{0,12}工具/.test(content)
}

/** 工具参数流式进度的节流步长：每多生成这么多参数字符才发一次 tool.delta，控制事件量 */
const TOOL_ARGS_PROGRESS_STEP = 200

/** 连续结构写失败达到阈值后硬熔断，禁止模型换参数盲试或“先建错卷再搬”。 */
const STRUCTURE_MUTATION_TOOLS = new Set([
  'chapter_create',
  'chapter_move',
  'chapter_move_to_volume',
  'chapter_split',
  'chapter_merge',
  'volume_create',
  'volume_update',
  'volume_move',
  'volume_delete',
])
const STRUCTURE_FAILURE_LIMIT = 3

const STATE_SENSITIVE_VALIDATORS = new Set(['continuity_validate', 'quality_analyze'])
// Polling/question tools observe external activity; they are intentionally repeatable.
const REPEATABLE_TOOLS = new Set(['task_wait', 'task_get', 'task_list', 'ask_user'])
function reviewPreflightArgs(call: ToolCallRequest, tool?: AgentTool): Record<string, unknown> | null {
  if (call.incomplete) return null
  try {
    let args = parseToolArgsTolerant(call.arguments, false)
    if (tool) {
      args = normalizeToolInput(tool, args)
      const validated = validateToolInput(tool, args)
      if (!validated.success) return null
      args = validated.data
    }
    return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null
  } catch { return null } // Ordinary handler reports malformed parameters.
}

/** 瘦身时保留最近 N 条工具输出不动：近期结果是当前决策的主要依据 */
const CONTEXT_SLIM_KEEP_RECENT_TOOL_OUTPUTS = 8

type ToolCallOutcome = {
  workflowMilestone?: import('./semantic-progress.js').WritingWorkflowMilestone
  failureCode?: string
  reviewStopReason?: string
  providerFailure?: boolean
  providerFailureCode?: string
  recoveryCode?: string
  argumentFailure?: boolean
  observation: string
  requiredResult?: { targetId: string; contentHash: string }
  semanticTransition?: { targetId: string; beforeHash: string; afterHash: string }
  observedChapterRange?: import('./semantic-progress.js').ChapterReadEvidence
  part: Extract<AgentMessagePart, { type: 'tool-call' }>
  /** 附属分部：子 Agent 内嵌执行产生的内部工具调用卡片，随父消息一并落库与直播 */
  extraParts?: AgentMessagePart[]
}

export { parseToolArgsTolerant } from './tool-argument-parser.js'

/** 从尚未闭合的工具 JSON 中读取已生成的字符串字段，用于编辑器实时预览。 */
function readStreamingJsonString(raw: string, key: string): string | undefined {
  const marker = new RegExp(`"${key}"\\s*:\\s*"`, 'g')
  let match: RegExpExecArray | null = null
  let latest: RegExpExecArray | null = null
  while ((match = marker.exec(raw))) latest = match
  if (!latest) return undefined
  let value = ''
  for (let index = latest.index + latest[0].length; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '"') return value
    if (char !== '\\') { value += char; continue }
    const escaped = raw[++index]
    if (escaped === undefined) break
    if (escaped === 'n') value += '\n'
    else if (escaped === 'r') value += '\r'
    else if (escaped === 't') value += '\t'
    else if (escaped === 'b') value += '\b'
    else if (escaped === 'f') value += '\f'
    else if (escaped === 'u') {
      const code = raw.slice(index + 1, index + 5)
      if (/^[0-9a-f]{4}$/i.test(code)) { value += String.fromCharCode(Number.parseInt(code, 16)); index += 4 }
      else break
    } else value += escaped
  }
  return value
}

function extractStreamingToolDraft(toolName: string, raw: string): AgentToolDraft | undefined {
  const chapterContentKey = toolName === 'chapter_edit_range' ? 'newText' : 'content'
  if (['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range'].includes(toolName)) {
    const content = readStreamingJsonString(raw, chapterContentKey)
    if (content === undefined) return undefined
    return { kind: 'chapter', toolName, targetId: readStreamingJsonString(raw, 'chapterId'), title: readStreamingJsonString(raw, 'title'), content }
  }
  if (toolName === 'plan_save') {
    const content = readStreamingJsonString(raw, 'content')
    if (content === undefined) return undefined
    return { kind: 'plan', toolName, targetId: readStreamingJsonString(raw, 'planId'), title: readStreamingJsonString(raw, 'title'), content }
  }
  return undefined
}

export async function handleToolCall(
  call: ToolCallRequest,
  tools: AgentTool[],
  ctx: ToolContext,
  /** 最小事件接口：主 run 传 RunEventBus，子 Agent 内嵌执行传 ToolContext.emit 包装（结构兼容） */
  bus: { emit: (event: AgentStreamEventBody) => void },
  messageId: string,
  runId: string,
  /** 非 undefined 表示本次调用发生在子 Agent 内嵌执行内部：事件与卡片带 subagentCallId 归属标记，审批透传到父 run */
  subagent?: { callId: string },
): Promise<ToolCallOutcome> {
  const startedAt = Date.now()
  const admitted = tools.find((candidate) => candidate.name === call.name)
  const tool = admitted && ctx.toolAuthority
    ? intersectToolAuthority([admitted], ctx.mode, ctx.toolAuthority)[0]
    : admitted
  // 子 Agent 归属标记：随事件与持久化分部下发，前端据此把卡片分组到所属子 Agent 容器内
  const subagentMark = subagent ? { subagentCallId: subagent.callId } : {}
  const basePart = {
    type: 'tool-call' as const,
    callId: call.id,
    toolName: call.name,
    title: tool?.title ?? call.name,
    ...subagentMark,
  }

  // Authorization precedes parsing/coercion/approval. Registry presence is not a grant.
  if (!tool) {
    const summary = '当前任务未授权此工具'
    bus.emit({ type: 'tool.call', messageId, callId: call.id, toolName: call.name, title: basePart.title, args: null, autoApproved: false, ...subagentMark })
    bus.emit({ type: 'tool.result', messageId, callId: call.id, toolName: call.name, ok: false, summary, durationMs: Date.now() - startedAt, ...subagentMark })
    return {
      observation: `工具 ${call.name} 不在本次执行的授权集合中，未执行。只能使用当前允许的工具；不得换用隐藏工具、子任务或历史指令绕过限制。需要额外权限时向用户说明。`,
      part: { ...basePart, args: null, status: 'denied', summary },
    }
  }

  // 参数解析与校验：先容错修复常见格式毛病，实在修不好再作为观察回填让模型自行修正
  let parsedArgs: unknown = {}
  try {
    if (call.incomplete) throw new Error('provider_output_limit')
    parsedArgs = call.arguments ? parseToolArgsTolerant(call.arguments, false) : {}
  } catch {
    const correction = call.name === 'scene_task_build'
      ? '使用原生 scene_task_build：顶层 tasks 数组包含本章完整的 1–4 个场景；每项 purpose/goal/obstacle/choice/cost/turn 各一句短句，entryState/exitState 只填变化字段，可省略 compilationId/styleBudget/alternatives。不要写正文或重复整章设定。'
      : call.incomplete && ['chapter_write', 'chapter_append'].includes(call.name)
        ? '本次正文没有写入。先核对目标章节已保存内容；可将完整写作目标拆为完整段落逐次写入/追加，每次参数必须完整闭合，累计内容仍须满足原目标。不得重复覆盖已保存正文、补括号执行残文或缩短目标冒充完成。'
      : call.incomplete && call.name === 'plan_save'
        ? '本次计划未写入。长计划按完整小节分次保存，每次建议不超过2000字符，独立调用plan_save，不与其他长参数工具挤在同一轮。先plan_read核对；首次保存首节，后续使用mode=append、planId及回执contentHash作为expectedContentHash。保留完整规划目标，逐节完成；不能补括号执行残文，也不能将首节当整份计划完成。'
      : '使用该工具公布的 JSON Schema；字符串换行写成 \\n，键名与字符串使用双引号，不要输出 Markdown 或另一层工具调用信封。'
    const observation = `工具 ${call.name} 未执行。${call.incomplete ? '供应商明确返回 length，参数生成未完成，不能补齐括号后冒充完整操作。' : 'JSON 语法无法安全解析；不能仅凭格式错误推断网络截断。'}接收参数共 ${call.arguments.length} 字符。${correction}请修正后重试，不重复发送相同损坏参数。`
    console.warn('[agent-tool-arguments]', { runId, tool: call.name, chars: call.arguments.length, incomplete: Boolean(call.incomplete) })
    bus.emit({ type: 'tool.call', messageId, callId: call.id, toolName: call.name, title: basePart.title, args: null, ...subagentMark })
    bus.emit({
      type: 'tool.result',
      messageId,
      callId: call.id,
      toolName: call.name,
      ok: false,
      summary: call.incomplete ? '模型输出达上限，参数未完成' : '参数解析失败',
      failureCode: call.incomplete ? 'TOOL_ARGUMENTS_INCOMPLETE' : 'TOOL_ARGUMENTS_INVALID',
      durationMs: Date.now() - startedAt,
      ...subagentMark,
    })
    return { observation, argumentFailure: true, part: { ...basePart, args: null, status: 'failed', summary: call.incomplete ? '模型输出达上限，参数未完成' : '参数解析失败' } }
  }

  // 先统一修复兼容网关常见的二次包装、字符串化 JSON、参数列表与顶层 null，
  // 再交给复杂工具做字段级语义归一化。
  let coercionFailed = false
  try {
    parsedArgs = normalizeToolInput(tool, parsedArgs)
  } catch {
    // A normalizer failure is a rejected invocation, not an unclosed running card.
    // Do not expose exception text (which may include private payloads).
    coercionFailed = true
    parsedArgs = null
  }

  // 审批预判（与下方执行前判定同一公式）：提前给事件流打标，供前端与审计识别自动批准的工具调用
  const autoApproved =
    (env.agentAutoApprove && !tool?.alwaysConfirm) ||
    tool === undefined ||
    tool.permission[ctx.mode] !== 'ask' ||
    (hasAlwaysAllow(ctx.sessionId, tool.name) && !tool.dangerous)

  bus.emit({ type: 'tool.call', messageId, callId: call.id, toolName: call.name, title: basePart.title, args: parsedArgs, autoApproved, ...subagentMark })

  let failureCode: string | undefined
  let invalidFields: string[] | undefined
  const fail = (summary: string, observation: string, status: 'failed' | 'denied'): ToolCallOutcome => {
    bus.emit({
      type: 'tool.result',
      messageId,
      callId: call.id,
      toolName: call.name,
      ok: false,
      summary,
      failureCode,
      invalidFields,
      durationMs: Date.now() - startedAt,
      ...subagentMark,
    })
    return { observation, failureCode, part: { ...basePart, args: parsedArgs, status, summary },
      ...(['CONTINUITY_CHECK_LIMIT', 'CONTINUITY_CHECK_BUDGET_EXCEEDED', 'REVIEW_AUTOMATION_STOPPED', 'REPAIR_NOT_AUTHORIZED'].includes(failureCode ?? '')
        ? { reviewStopReason: observation } : {}) }
  }

  const permission = tool.permission[ctx.mode]

  if (coercionFailed) {
    failureCode = 'TOOL_NORMALIZATION_FAILED'
    return fail('参数归一化失败', `工具 ${call.name} 的参数无法安全归一化，本次未执行。历史摘要、_contextCompacted 与嵌套对象占位符不是可执行参数，不要解包或重发摘要；请回读真实目标并按已公布的参数结构重新构建完整参数。`, 'failed')
  }

  if (permission === 'deny') {
    return fail(
      '当前模式禁止',
      `工具 ${call.name} 在 ${ctx.mode} 模式下被禁止。请改用只读工具，或提示用户切换模式。`,
      'denied',
    )
  }

  const validated = validateToolInput(tool, parsedArgs)

  if (!validated.success) {
    failureCode = 'TOOL_SCHEMA_INVALID'
    invalidFields = validated.error.issues.slice(0, 8).map(issue => issue.path.map(String).join('.').slice(0, 120) || '(root)')
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；')
    // 附带当前章节 ID：缺 chapterId 是最高发的校验失败，直接喂给模型避免它盲猜或多耗一轮去查
    const chapterHint = call.name !== 'chapter_create' && ctx.chapterId ? `作者当前正在编辑的章节 chapterId=${ctx.chapterId}。` : ''
    return fail('参数校验失败', `工具 ${call.name} 参数校验失败：${issues}。${chapterHint}本次调用完全没有执行，请补齐/修正参数后立即重新发起同一个工具调用，绝对禁止放弃重试或改在回复正文里完成该操作。`, 'failed')
  }

  // 协作作用域约束：检查派生授权和目标归属，不拦截无关章节写入。
  const orchestrationBlock = await assertOrchestrationResumeGuard(runId, ctx.sessionId, tool.name, validated.data)
  if (orchestrationBlock) {
    return fail('续跑协作约束', orchestrationBlock, 'failed')
  }

  // 审批：'ask' 且未被会话级“总是允许”覆盖时，挂起等待前端批复；
  // 全权限开关（默认开）短路审批：产品决策为 agent 自主判断所有动作，翻 env 可回退
  const needAsk =
    permission === 'ask' &&
    (tool.alwaysConfirm || !env.agentAutoApprove) &&
    !(hasAlwaysAllow(ctx.sessionId, tool.name) && !tool.dangerous && !tool.alwaysConfirm)

  if (needAsk) {
    const expiresAt = new Date(Date.now() + env.agentApprovalTimeoutMs).toISOString()
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'awaiting_approval' } }).catch(() => {})
    bus.emit({
      type: 'permission.ask',
      callId: call.id,
      toolName: tool.name,
      title: tool.title,
      args: validated.data,
      allowAlways: !tool.dangerous && !tool.alwaysConfirm,
      expiresAt,
    })

    const { setGoalRunPhase } = await import('./goal-runtime.js')
    await setGoalRunPhase(ctx.userId, runId, 'awaiting_approval')
    const decision = await waitForApproval(runId, call.id, tool.name, env.agentApprovalTimeoutMs, ctx.signal)
    if (!ctx.signal.aborted) await setGoalRunPhase(ctx.userId, runId, 'executing')
    bus.emit({ type: 'permission.resolved', callId: call.id, approved: decision.approved })
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } }).catch(() => {})

    if (!decision.approved) {
      const reason = decision.timedOut ? '审批超时，视为拒绝' : '用户拒绝了本次操作'
      return fail(reason, `${reason}：工具 ${call.name} 未执行。请尊重用户决定，换一种方式完成任务或直接说明情况。`, 'denied')
    }

    if (decision.alwaysAllow && !tool.dangerous && !tool.alwaysConfirm) {
      grantAlwaysAllow(ctx.sessionId, tool.name)
    }
  }

  // 高危工具审计（发布/归档/删除类）：未经用户挂起审批即执行时在服务端日志留痕，供事后核查
  if (!needAsk && tool.dangerous) {
    console.warn('[agent-loop] 高危工具自动批准执行', { runId, userId: ctx.userId, novelId: ctx.novelId, toolName: tool.name })
  }

  try {
    const goalContext = await readGoalExecution(ctx.userId, ctx.runId)
    const result = await withGoalExecutionContext(goalContext, () => withGoalEffects(() => tool.execute({ ...ctx, inlineChild: Boolean(subagent) }, validated.data)))
    failureCode = result.failureCode ?? 'TOOL_EXECUTION_REJECTED'
    if (result.outcome === 'failed') {
      failureCode = result.failureCode ?? 'TOOL_EXECUTION_REJECTED'
      const recovery = toolFailureRecovery(failureCode)
      return { ...fail(result.summary ?? recovery?.label ?? '执行未完成', wrapToolOutput(tool.name,
        result.output + (recovery ? `\n${recovery.guidance}` : '')), 'failed'), ...(recovery ? { recoveryCode: failureCode } : {}) }
    }
    const durationMs = Date.now() - startedAt
    const summary = result.summary ?? `${tool.title}完成`

    bus.emit({
      type: 'tool.result',
      messageId,
      callId: call.id,
      toolName: call.name,
      ok: true,
      summary,
      display: result.display,
      durationMs,
      ...subagentMark,
    })

    return {
      observation: wrapToolOutput(tool.name, result.output),
      workflowMilestone: ctx.inlineChild ? undefined : result.workflowMilestone,
      requiredResult: result.requiredResult,
      semanticTransition: result.semanticTransition,
      observedChapterRange: result.observedChapterRange,
      part: {
        ...basePart,
        args: validated.data,
        status: 'success',
        summary,
        display: result.display,
        durationMs,
        // 写操作快照随消息落库，供「回退到本轮对话前」逆序恢复
        snapshot: result.snapshot,
      },
    }
  } catch (error) {
    failureCode = error instanceof DataAccessError ? error.code : 'UNEXPECTED_TOOL_ERROR'
    if (ctx.signal.aborted) return fail('已中断', '用户已请求暂停，停止后续执行；已保存内容保留。', 'failed')
    if (error instanceof DataAccessError && error.code.startsWith('CREDITS_')) {
      // 自定义档与 0 倍率免费档的主模型调用不占用平台 Credits：额度类失败只让该工具失败，不终止整个 run。
      const textModel = ctx.modelRuntime?.tier === 'custom' ? '作者已启用的自定义文本模型'
        : ctx.modelRuntime?.multiplierBps === 0 ? '当前免费模型' : null
      if (textModel && ['CREDITS_EXHAUSTED', 'CREDITS_SETTLEMENT_PENDING', 'CREDITS_RESERVED', 'CREDITS_PROVIDER_UNSTABLE'].includes(error.code)) {
        return fail('平台付费能力暂不可用', `${error.message} 本工具未完成，不要重复调用；继续使用${textModel}完成其余工作。图片生成、联网搜索仍需平台 Credits，不能声称已完成这些操作。`, 'failed')
      }
      throw error
    }
    if (error instanceof DataAccessError && (error.code.startsWith('WEB_READ_') || error.code === 'RESEARCH_NO_PROGRESS')) {
      // Access/quality refusals are not successful reads or permission to bypass the gate.
      const labels: Record<string, string> = {
        WEB_READ_BLOCKED: '网站要求验证或限制访问', WEB_READ_NOT_FOUND: '页面不存在或已删除',
        WEB_READ_INSUFFICIENT: '未取得足够可读内容', WEB_READ_GARBLED: '正文乱码，无法可靠读取',
        WEB_READ_BUDGET: '页面获取预算已用尽', RESEARCH_NO_PROGRESS: '连续读取失败，已停止联网',
        WEB_READ_RATE_LIMITED: '网站限流，请稍后重试', WEB_READ_PARSE_ERROR: '页面结构解析失败',
      }
      return fail(labels[error.code] ?? '网页读取未完成', error.message, 'failed')
    }
    // 错误即观察：不中断 run，把错误回填给模型自行重试或换路
    if (error instanceof DataAccessError && error.code.startsWith('AI_')) {
      const label = error.code === 'AI_PROVIDER_QUOTA_EXCEEDED' ? '供应商模型额度已耗尽'
        : error.code === 'AI_QUALITY_NON_THINKING_UNSUPPORTED' ? '此模型尚无法关闭检查思考'
        : error.code === 'AI_PROVIDER_TIMEOUT' ? '模型网关超时'
        : error.code === 'AI_PROVIDER_OUTPUT_LIMIT' ? '模型输出达到上限，检查未完成'
        : error.code === 'AI_PROVIDER_INCOMPLETE' ? '模型输出中断，检查未完成'
        : error.code === 'AI_PROVIDER_EMPTY_RESPONSE' ? '模型未返回有效内容'
        : error.code === 'AI_PROVIDER_TRANSPORT' ? '模型连接中断，结果未确认'
        : error.code === 'AI_PROVIDER_INVALID_RESPONSE' ? '模型响应格式异常' : '模型服务异常'
      console.warn('[agent-tool-provider]', { runId, tool: call.name, code: error.code, durationMs: Date.now() - startedAt })
      const guidance = error.code === 'AI_PROVIDER_QUOTA_EXCEEDED' ? error.message
        : error.code === 'AI_QUALITY_NON_THINKING_UNSUPPORTED'
        ? `${error.message} 本次未发送检查模型请求；不要重试同一配置或修改正文来绕过，检查仍未完成。`
        : error.code === 'AI_PROVIDER_OUTPUT_LIMIT'
        ? '输出预算已达上限，不要原样重复付费调用；保留进度并报告检查未完成，不能将截断报告当作通过。'
        : ['AI_PROVIDER_TRANSPORT', 'AI_PROVIDER_INCOMPLETE', 'AI_PROVIDER_TIMEOUT'].includes(error.code)
          ? '原调用结果尚未确认，先核对原调用与已保存状态；保留进度并报告检查未完成，不要盲目重发未知付费请求。'
        : '最多重试一次，仍失败则保留进度并报告阻塞。'
      return { ...fail(label, `工具 ${call.name} 未完成：${label}（${error.code}）。这是模型响应故障，不是正文质量结论；不要修改正文或重建编译来绕过。${guidance}`, 'failed'), providerFailure: true, providerFailureCode: error.code }
    }
    console.warn('[agent-tool-failure]', { runId, tool: call.name, code: error instanceof DataAccessError ? error.code : 'UNEXPECTED_TOOL_ERROR', durationMs: Date.now() - startedAt })
    if (error instanceof DataAccessError && ['REVIEW_AUTOMATION_STOPPED', 'REPAIR_NOT_AUTHORIZED'].includes(error.code)) {
      return fail('自动修订已停止', error.message, 'failed')
    }
    if (error instanceof DataAccessError && ['RUNTIME_SCOPE_MISMATCH', 'RUNTIME_PARENT_LEASE_LOST'].includes(error.code)) {
      return fail('原任务状态或授权不匹配', `工具 ${call.name} 未执行（${error.code}）：${error.message} 停止后续写入并核对原任务状态和授权；不得调整参数重试、换工具绕过或自行恢复权限。`, 'failed')
    }
    const recovery = error instanceof DataAccessError ? toolFailureRecovery(error.code) : undefined
    if (recovery && error instanceof DataAccessError) return {
      ...fail(recovery.label, `工具 ${call.name} 未完成（${error.code}）：${error.message} ${recovery.guidance}`, 'failed'),
      recoveryCode: error.code,
    }
    const message = error instanceof DataAccessError ? error.message : '内部执行异常，本次操作未确认完成；请核对已保存状态，不要盲目重复写入'
    return fail('执行失败', `工具 ${call.name} 执行失败：${message}。可以调整参数重试，或换用其他工具。`, 'failed')
  }
}

async function finalizeLegacyRun(
  runId: string,
  bus: RunEventBus,
  status: 'succeeded' | 'failed' | 'cancelled' | 'paused',
  usage: AgentTokenUsage,
  currentTurn: number,
  outputSummary: string,
  errorMessage?: string,
  allowContextSideEffects = true,
  checkpoint?: RunCheckpointState,
  authorEnded?: { fulfilled: boolean; todoItems?: AgentTodoItem[] },
  writingDelivery?: { messageId: string; subject: { userId: string; novelId: string; runId: string }; expected: NonNullable<Awaited<ReturnType<typeof readCompletedWritingDelivery>>>; signal: AbortSignal; parts?: AgentMessagePart[]; replaceCandidate?: boolean },
  withFailureNotice = false,
  limitedDelivery?: { subject: { userId: string; novelId: string; runId: string }; expected: LimitedWritingDelivery; signal: AbortSignal; messageId: string },
  pauseReason: 'user_stop' | 'needs_input' = 'user_stop',
) {
  // 事件协议用 succeeded，DB 枚举用 completed
  const dbStatus = status === 'succeeded' ? 'completed' : status
  // Only callers without an existing explanation request this server notice.
  // It is published with the confirmed failure, never ahead of its transaction.
  const failureNotice = status === 'failed' && withFailureNotice && errorMessage
    ? { messageId: randomUUID(), text: errorMessage } : undefined

  const terminalBody = status === 'paused'
    ? { type: 'run.paused' as const, reason: pauseReason }
    : { type: 'run.finished' as const, status, usage, artifacts: [], outputSummary, ...(authorEnded ? { authorEnded } : {}), ...(limitedDelivery ? { outcome: limitedDelivery.expected.outcome } : {}) }
  let goalFenced = false
  const committed = await bus.commitTerminal(terminalBody, async tx => {
    if (limitedDelivery) {
      await assertLimitedWritingDelivery(tx, limitedDelivery.subject, limitedDelivery.expected)
      limitedDelivery.signal.throwIfAborted()
      const owner = await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { sessionId: true } })
      await tx.agentMessage.create({ data: { id: limitedDelivery.messageId, runId, sessionId: owner.sessionId, role: 'assistant',
        parts: [{ type: 'text', text: limitedDelivery.expected.text }] } })
    }
    if (writingDelivery) {
      await assertCompletedWritingDelivery(tx, writingDelivery.subject, writingDelivery.expected)
      writingDelivery.signal.throwIfAborted()
      const sessionId = (await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { sessionId: true } })).sessionId
      const existing = await tx.agentMessage.findUnique({ where: { id: writingDelivery.messageId } })
      if (existing && (existing.runId !== runId || existing.sessionId !== sessionId || existing.role !== 'assistant')) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '交付消息不属于本任务。')
      const parts = (writingDelivery.parts ?? (existing?.parts as unknown as AgentMessagePart[] | undefined) ?? []).filter(part => part.type !== 'text')
      const displayedParts = JSON.parse(JSON.stringify([...parts, { type: 'text' as const, text: writingDelivery.expected.text }])) as Prisma.InputJsonValue
      await tx.agentMessage.upsert({ where: { id: writingDelivery.messageId }, create: { id: writingDelivery.messageId, runId, sessionId,
        role: 'assistant', parts: displayedParts }, update: { parts: displayedParts } })
    }
    const owner = await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { userId: true, sessionId: true } })
    await (await import('./goal-fence.js')).assertRunGoalFence(tx, owner.userId, runId)
    if (failureNotice) await tx.agentMessage.create({ data: {
      id: failureNotice.messageId, runId, sessionId: owner.sessionId, role: 'assistant',
      parts: [{ type: 'text', text: failureNotice.text }],
    } })
    return tx.agentRun.update({
      where: { id: runId, runtimeProtocolVersion: 0, taskRootId: null },
      data: {
        status: dbStatus,
        outputSummary: outputSummary || null,
        errorMessage: errorMessage ?? null,
        usage: { ...usage, ...(checkpoint ? { checkpoint } : {}), ...(limitedDelivery ? { outcome: limitedDelivery.expected.outcome, deliveryProof: limitedDelivery.expected } : {}), ...(authorEnded ? { authorEnded: { fulfilled: authorEnded.fulfilled, ...(authorEnded.todoItems ? { todoItems: authorEnded.todoItems.map(item => ({ ...item })) } : {}) } } : {}) },
        currentTurn,
        finishedAt: status === 'paused' ? null : new Date(),
      },
      select: { userId: true, sessionId: true, novelId: true, taskSpec: true },
    })
  }, writingDelivery ? [...(writingDelivery.replaceCandidate ? [] : [{ type: 'message.start' as const, messageId: writingDelivery.messageId, role: 'assistant' as const }]),
    { type: 'text.final', messageId: writingDelivery.messageId, text: writingDelivery.expected.text, asReasoning: false }] : failureNotice ? [
    { type: 'message.start', messageId: failureNotice.messageId, role: 'assistant' },
    { type: 'text.final', messageId: failureNotice.messageId, text: failureNotice.text, asReasoning: false },
  ] : limitedDelivery ? [
    { type: 'message.start', messageId: limitedDelivery.messageId, role: 'assistant' },
    { type: 'text.final', messageId: limitedDelivery.messageId, text: limitedDelivery.expected.text, asReasoning: false },
  ] : [])
    .catch((error) => {
      if ((writingDelivery || limitedDelivery) && (isAbortError(error) || error instanceof DataAccessError && error.code === 'WRITING_DELIVERY_STALE')) throw error
      if (error instanceof DataAccessError && error.code === 'GOAL_EXECUTION_FENCED') {
        goalFenced = true
        return null
      }
      // R01/R09：不确定的提交结果不得重试或改写终态；但错误详情必须保留，
      // 否则只能靠事后推断（如事务超时/连接抖动），无法定位卡死原因。
      console.error('[agent-loop] run 状态落库未确认', { runId, requestedStatus: dbStatus,
        reason: error instanceof Error ? error.message : String(error) })
      return null
    })
  const finalizedRun = committed?.result

  if (finalizedRun) await (await import('./goal-runtime.js')).noteGoalRunFinished(finalizedRun.userId, runId).catch(error => {
    if (!(error instanceof DataAccessError && error.code === 'GOAL_EXECUTION_FENCED')) {
      console.error('[agent-goal] 活动时间待同步', { runId })
    }
  })

  const goalExecution = finalizedRun ? await readGoalExecution(finalizedRun.userId, runId) : undefined
  // Goal tools/commit receipts own their memory work. Starting a separate
  // paid graph rebuild after publishing the run's terminal event would escape
  // its budget/activity/cancellation boundary.
  if (status !== 'paused' && finalizedRun && allowContextSideEffects && !goalExecution) {
    await Promise.all([
      compactSessionContext(finalizedRun.userId, finalizedRun.sessionId, false).catch((error) => {
        console.error('[agent-loop] 对话结束后自动整理上下文失败', runId, error)
      }),
      taskSpecSchema.safeParse(finalizedRun.taskSpec).data?.intent === 'research_analysis' ? Promise.resolve() : syncNovelMemoryProjection(finalizedRun.userId, finalizedRun.novelId).catch((error) => {
        console.error('[agent-loop] 对话结束后自动更新作品记忆失败', runId, error)
      }),
    ])
  }

  if (!finalizedRun && !goalFenced) {
    // R01/R09: a DB failure is not proof of either completion or rollback.
    // Preserve saved messages, stop the local executor, and report uncertainty;
    // do not fabricate run.finished or retry finalization as a different status.
    bus.emit({ type: 'error', code: 'run_status_unconfirmed', recoverable: false,
      message: '任务执行已停止，但最终状态尚未确认。已保存内容保留，请稍后刷新核对；不要重复发送同一任务。' })
  } else {
    committed?.publish()
  }

  rejectAllApprovals(runId)
  cancelAllQuestions(runId)
  if (finalizedRun && status !== 'paused') {
    clearRunBaselines(runId)
  }
  deregisterActiveRun(runId)
  try {
    await disposeRunEventBus(runId)
  } catch {
    // A failed notification journal is not a second business failure. The bus
    // retains its pending batch for recovery; do not re-enter finalize or emit
    // another terminal event on the now-sealed bus.
    console.error('[agent-loop] 终态事件仍待持久化', { runId, status })
  }
}

/** 启动（或续跑）一次 Agent Loop run：异步执行，调用方不等待 */
export async function executeAgentRun(params: ExecuteAgentRunParams): Promise<void> {
  return withModelAssignmentContext({ userId: params.userId, novelId: params.novelId, frozen: params.modelAssignments }, () => executeAgentRunImpl(params))
}
async function executeAgentRunImpl(params: ExecuteAgentRunParams): Promise<void> {
  const runId = params.runId
  const agent: AgentDefinition = getAgentDefinition(params.agentType ?? 'orchestrator')
  const controller = new AbortController()
  const bus = createRunEventBus(runId, params.eventStartSeq ?? 0)

  registerActiveRun(runId, { controller, bus, sessionId: params.sessionId, userId: params.userId })

  const usage = emptyUsage()
  let turn = 0

  // —— plan/18 防护状态（全部 run 级内存滑窗，不跨 run）——
  // P2 墙钟：总帽防无限烧 credits；空转帽防低速空转。审批/提问等待发生在工具执行内部，
  // 工具返回即刷新活动钟，天然排除挂起期误杀
  let runStartedAt = Date.now()
  let executionStartedAt = Date.now()
  let priorExecutionMs = 0
  let inheritedExecutionMs = 0
  const recoverExecution = (record: { startedAt?: Date | null; currentTurn?: number;
    events?: Array<{ type: string; createdAt: Date }> }, stoppedAt: number) => {
    if (!record.startedAt) {
      if (!record.currentTurn) return 0
      throw new DataAccessError(409, 'RUN_TIME_UNCONFIRMED', '原任务执行时间记录缺失，未重置预算或启动付费请求。')
    }
    const elapsed = recoverRunElapsedMs(record.startedAt.getTime(), stoppedAt,
      (record.events ?? []).map(event => ({ type: event.type, at: event.createdAt.getTime() })))
    if (elapsed === null) throw new DataAccessError(409, 'RUN_TIME_UNCONFIRMED', '原任务执行时间记录不一致，未重置预算或启动付费请求。')
    return elapsed
  }
  let lastActivityAt = Date.now()
  // P0 重复签名滑窗：只记成功执行；失败后同签名正当重试不计次
  const admission = new ToolAdmissionGuard()
  const progressSignatures = new Set<string>()
  let blockedRepeat = 0
  let stagnantBatches = 0
  const argumentFailures = new Map<string, number>()
  const toolProviderFailures = new Map<string, number>()
  const recoveryFailures = new Map<string, number>()
  const automaticReviewAttempts = new Set<string>()
  const pendingReviews = new Map<string, PendingReviewCall>()
  const toolRestrictions: ToolRestriction[] = []
  let inputProtocolRecovery: RunCheckpointState['inputProtocolRecovery']
  let compatibilityReadTargets: Set<string> | null = null
  const restrictTool = (action: string, args: unknown, code: string, reason: string) => {
    const target = toolRestrictionTarget(args, getLastTouchedChapter(runId) ?? params.chapterId)
    const inputHash = isInputScopedFailure(code) ? toolFailureInputHash(action, args) : undefined
    const writers = ['chapter_edit_range', 'chapter_write', 'chapter_append']
    for (const name of !inputHash && writers.includes(action) ? writers : [action]) {
      if (!toolRestrictions.some(item => item.action === name && item.target === target && item.inputHash === inputHash)) toolRestrictions.push({ action: name, target, code, reason, ...(inputHash ? { inputHash } : {}) })
    }
  }
  const restoreReviewEvidence = (checkpoint: RunCheckpointState) => {
    inputProtocolRecovery ??= checkpoint.inputProtocolRecovery
    const oldAnchors = (checkpoint.toolRestrictions ?? []).filter(item => item.code === 'CHAPTER_ANCHOR_CONFLICT' && !item.inputHash && item.target)
    if (params.resume && checkpoint.version === 2 && checkpoint.stagnantBatches >= 4 && !inputProtocolRecovery && oldAnchors.length) {
      inputProtocolRecovery = { protocol: 2, key: toolFailureInputHash('legacy-anchor-input-recovery', oldAnchors) }
      compatibilityReadTargets = new Set(oldAnchors.map(item => item.target!))
    }
    for (const saved of checkpoint.toolRestrictions ?? []) {
      const item = restoreToolRestriction(saved)
      if (!toolRestrictions.some(prior => prior.action === item.action && prior.target === item.target && prior.inputHash === item.inputHash)) toolRestrictions.push(item)
    }
    checkpoint.reviewAttempts?.forEach(key => automaticReviewAttempts.add(key))
    checkpoint.pendingReviews?.forEach(call => pendingReviews.set(`${call.compilationId ?? call.chapterId}:${call.toolName}`, call))
  }
  // 非空时本轮工具执行完立即走 wrap-up（P0 第 4 次同签名 / P1 干预模式二次命中）
  let forceWrapUpReason: string | null = null
  let forceWrapUpLocal = false
  // P1 信道重复检测：正文+思考共用一个检测器，观察/干预由 env.agentRepeatGuardMode 决定
  const repeatDetector = createRepeatDetector()
  let repeatReminderSent = false
  // P4 检查点自动续跑状态
  let resumeCount = 0
  let compactionCount = 0
  // 保留旧检查点中的手动续跑计数，仅用于历史记账；不会授予或限制累计任务预算。
  let manualResumeCount = 0
  let writeProgressCount = 0
  let checkpointWriteBaseline = 0
  let readProgressCount = 0
  let checkpointReadBaseline = 0
  let inheritedTokens = 0
  let inheritedTurns = 0
  let maxTurns = 1 // Storage compatibility only; never used to stop execution.
  let runTokenBudget = COMPATIBILITY_TOKEN_LIMIT // Storage compatibility only.
  let checkpointRestored = !params.resume
  let reviewHandoffCount = 0
  const restoreSavedUsage = async (stored: { usage: unknown; currentTurn: number }, id: string) => {
    if (stored.usage !== null) return savedRunUsageSchema.safeParse(stored.usage)
    const receipts = await prisma.aiUsageLog.findMany({
      where: { userId: params.userId, targetType: 'agentRun', targetId: id },
      select: { turn: true, requestTokens: true, responseTokens: true },
    })
    return savedRunUsageSchema.safeParse(recoverLegacyRunUsage(stored.currentTurn, receipts))
  }
  let checkpointOrigin: 'system_default' | 'unknown_legacy' = 'system_default'
  const checkpointSnapshot = (): RunCheckpointState => ({
    version: 2, controlPolicy: 'until_completion', origin: checkpointOrigin, stagnantBatches,
    activeExecutionMs: priorExecutionMs + Math.max(0, Date.now() - executionStartedAt), runStartedAt, resumeCount, compactionCount, maxTurns, tokenBudget: runTokenBudget,
    writeProgress: writeProgressCount, writeBaseline: checkpointWriteBaseline,
    readProgress: readProgressCount, readBaseline: checkpointReadBaseline,
    progressSignatures: [...progressSignatures],
    ...(automaticReviewAttempts.size ? { reviewAttempts: [...automaticReviewAttempts] } : {}),
    ...(pendingReviews.size ? { pendingReviews: [...pendingReviews.values()] } : {}),
    ...(toolRestrictions.length ? { toolRestrictions } : {}),
    ...(inputProtocolRecovery ? { inputProtocolRecovery } : {}),
    inheritedTokens, inheritedTurns, inheritedExecutionMs, manualResumeCount,
    ...(reviewHandoffCount > 0 ? { reviewHandoffCount } : {}),
  })
  const persistCheckpoint = () => prisma.agentRun.update({
    where: { id: runId, userId: params.userId, runtimeProtocolVersion: 0, taskRootId: null },
    data: { currentTurn: turn, usage: { ...usage, checkpoint: checkpointSnapshot() } },
  })
  const finalizeRun = (...args: Parameters<typeof finalizeLegacyRun>) => {
    args[8] = checkpointSnapshot()
    return finalizeLegacyRun(...args)
  }
  const finalizeFailedWithNotice = (reason: string) => finalizeRun(
    runId, bus, 'failed', usage, turn, '', reason, true, undefined, undefined, undefined, true,
  )
  const restoreCheckpointLimits = (checkpoint: RunCheckpointState) => {
    restoreReviewEvidence(checkpoint)
    runStartedAt = Math.min(runStartedAt, checkpoint.runStartedAt)
    resumeCount = checkpoint.resumeCount
    compactionCount = checkpoint.compactionCount
    manualResumeCount = checkpoint.manualResumeCount
    reviewHandoffCount = Math.max(reviewHandoffCount, checkpoint.reviewHandoffCount ?? 0)
    checkpointOrigin = checkpoint.version === 2 ? checkpoint.origin : 'unknown_legacy'
    stagnantBatches = checkpoint.version === 2 ? checkpoint.stagnantBatches : 0
    // Preserve historical stored values and counts; the effective policy is separate.
    maxTurns = checkpoint.maxTurns
    runTokenBudget = checkpoint.tokenBudget
    writeProgressCount = checkpoint.writeProgress
    checkpointWriteBaseline = checkpoint.writeBaseline
    readProgressCount = checkpoint.readProgress
    checkpointReadBaseline = checkpoint.readBaseline
    checkpoint.progressSignatures.forEach(signature => progressSignatures.add(signature))
  }

  // 进行中的轮次缓冲：中止/崩溃时当前轮消息还没走到轮末落库点，
  // 不兜底补偿的话作者刷新后会丢掉整个进行中轮次（只看到上一轮为止的进度）
  let liveTurn: { messageId: string; parts: AgentMessagePart[]; streamedText: string; streamedReasoning: string } | null = null
  const flushLiveTurn = async () => {
    const live = liveTurn
    if (!live) return
    const fallbackParts: AgentMessagePart[] = []
    if (live.streamedReasoning.trim()) fallbackParts.push({ type: 'reasoning', text: humanizeAgentVisibleText(live.streamedReasoning) })
    if (live.streamedText.trim()) fallbackParts.push({ type: 'text', text: humanizeAgentVisibleText(live.streamedText) })
    // 优先用正式组装的 parts（含工具卡片）；模型流式中断、parts 尚未组装时退化为已流式原文
    const partsToSave = live.parts.length > 0 ? live.parts : fallbackParts
    if (partsToSave.length === 0) return
    // 已走到轮末正常落库的轮次不能重复写入：先按主键查一次再补
    const exists = await prisma.agentMessage
      .findUnique({ where: { id: live.messageId }, select: { id: true } })
      .catch(() => null)
    if (exists) return
    await persistMessage(live.messageId, runId, params.sessionId, 'assistant', partsToSave).catch(() => {})
  }

  // 预算/续跑边界停止原因落库为可见消息：此前只写 errorMessage，会话里看不到原因，
  // 作者只能反复盲点「继续」（线上反馈误判为限流）。停止时给一条可读、可执行的说明。
  const announceStopReason = async (text: string) => {
    const messageId = randomUUID()
    bus.emit({ type: 'message.start', messageId, role: 'assistant' })
    bus.emit({ type: 'text.delta', messageId, delta: text })
    bus.emit({ type: 'text.final', messageId, text, asReasoning: false })
    await persistMessage(messageId, runId, params.sessionId, 'assistant', [{ type: 'text', text }]).catch(() => {})
  }

  try {
    const storedRun = await startLegacyRuntimeRun(params.userId, runId, Boolean(params.resume), params.activationResume)
    assertLegacyRuntimeCompatible(storedRun)
    executionStartedAt = Date.now()
    if (params.resume) {
      const saved = await restoreSavedUsage(storedRun, runId)
      if (!saved.success) throw new Error('运行预算记录无法核实，已停止续跑；原记录保留，不能重置预算后继续。')
      priorExecutionMs = recoverExecution(storedRun, executionStartedAt)
      usage.promptTokens = saved.data.promptTokens
      usage.completionTokens = saved.data.completionTokens
      usage.totalTokens = saved.data.totalTokens
      turn = storedRun.currentTurn
      runStartedAt = storedRun.startedAt?.getTime() ?? runStartedAt
      const checkpoint = saved.data.checkpoint
      if (checkpoint) {
        inheritedTokens = checkpoint.inheritedTokens
        inheritedTurns = checkpoint.inheritedTurns
        inheritedExecutionMs = checkpoint.inheritedExecutionMs ?? 0
        priorExecutionMs += inheritedExecutionMs
        restoreCheckpointLimits(checkpoint)
      }
      // Historical runs keep their known consumption, without inventing earned slices.
      checkpointRestored = true
    }
    let modelRuntime = await getModelTierRuntime(params.modelTier ?? 'speed', params.userId, params.customModelId, params.reasoningEffort)
    let runtimeModelName = modelRuntime.modelName ?? agent.model
    assertTaskAuthorizationRuntimeReady(storedRun.taskSpec, { userId: params.userId, sessionId: params.sessionId, novelId: params.novelId })
    await prisma.agentSession.update({
      where: { id: params.sessionId },
      data: { lastRunAt: new Date() },
    }).catch(() => {})

    bus.emit({
      type: 'run.started',
      agent: { type: agent.type, title: agent.title, model: modelRuntime.tier },
      mode: params.mode,
      title: params.prompt.slice(0, 80),
    })

    const prompt = params.prompt
    // 附件以 additive attachment parts 随用户消息持久化：气泡缩略图回显 + 历史压缩可见
    const attachmentParts: AgentMessagePart[] = (params.attachments ?? []).map((attachment) => ({
      type: 'attachment',
      kind: attachment.kind,
      name: attachment.name,
      url: attachment.url,
      size: attachment.size,
    }))
    const userMessageId = params.admittedMessageId ?? randomUUID()
    const userParts: AgentMessagePart[] = [
      { type: 'text', text: prompt },
      ...attachmentParts,
    ]
    if (params.admittedMessageId) {
      const goalExecution = params.internalGoalContinuation ? await readGoalExecution(params.userId, runId) : undefined
      if (params.internalGoalContinuation && !goalExecution) throw new DataAccessError(409, 'GOAL_SCOPE_MISMATCH', '自动接续缺少目标归属。')
      const admitted = await prisma.agentMessage.findFirst({ where: { id: userMessageId, runId, sessionId: params.sessionId,
        role: params.internalGoalContinuation ? 'system' : 'user' }, select: { parts: true } })
      const { runtimeJson } = await import('./runtime-common.js')
      if (params.resume || !admitted || runtimeJson(admitted.parts).hash !== runtimeJson(JSON.parse(JSON.stringify(userParts))).hash) {
        throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '原始请求与已保存消息不一致，不能覆盖或猜测任务。')
      }
    } else if (!params.resume) await persistMessage(userMessageId, runId, params.sessionId, 'user', userParts)

    const ownedGoalExecution = await readGoalExecution(params.userId, runId)
    const continuingTask = Boolean(params.resume || params.internalGoalContinuation) || (!ownedGoalExecution && isContinuationRequest(params.prompt))
    // Typed “continue” starts a new run but must retain the original task scope/constraints.
    const previousTask = !ownedGoalExecution && !params.resume && continuingTask && !storedRun.taskSpec
      ? await prisma.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId: params.sessionId, userId: params.userId, novelId: params.novelId, id: { not: runId }, engine: 'loop' }, orderBy: { createdAt: 'desc' }, select: { id: true, taskSpec: true, taskRootId: true, runtimeProtocolVersion: true, usage: true, currentTurn: true, startedAt: true } })
      : null
    if (hasAuthorEnded(previousTask?.usage) || params.resume && hasAuthorEnded(storedRun.usage)) {
      const notice = '原任务已按作者要求结束，不能自动恢复剩余工作。如需继续创作，请发送明确的新任务；已有成果保留。'
      await announceStopReason(notice)
      await finalizeRun(runId, bus, 'cancelled', usage, turn, notice, undefined, true, undefined, { fulfilled: false })
      return
    }
    if (previousTask) assertLegacyRuntimeCompatible(previousTask)
    assertTaskAuthorizationRuntimeReady(previousTask?.taskSpec, { userId: params.userId, sessionId: params.sessionId, novelId: params.novelId })
    const parsedTaskSpec = taskSpecSchema.safeParse(storedRun.taskSpec ?? previousTask?.taskSpec)
    let contextPrompt = params.prompt
    if (previousTask && parsedTaskSpec.success && !params.resume) {
      // The typed-continue path must recover the same full request as the
      // resume button. Task goals and history summaries are deliberately short.
      const original = await prisma.agentMessage.findFirst({ where: {
        sessionId: params.sessionId, role: 'user', run: {
          ...MAIN_RUN_FILTER,
          userId: params.userId, novelId: params.novelId,
          taskSpec: { path: ['id'], equals: parsedTaskSpec.data.id },
        },
      }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
      const originalPrompt = Array.isArray(original?.parts) ? original.parts.flatMap(part =>
        part && typeof part === 'object' && !Array.isArray(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : ''
      if (!originalPrompt.trim() || isContinuationRequest(originalPrompt)) {
        throw new DataAccessError(409, 'RUN_INPUT_REQUIRED', '原任务缺少完整原始需求，不能根据历史摘要猜测继续；请重新说明任务，已保存成果保留。')
      }
      contextPrompt = `${originalPrompt}\n\n[用户本次要求] ${params.prompt}`
      // Sum local counters once per run, never cumulative snapshot totals. Do not
      // include unrelated tasks merely because they share a novel or session.
      const priorRuns = await prisma.agentRun.findMany({
        where: { ...MAIN_RUN_FILTER, sessionId: params.sessionId, userId: params.userId, novelId: params.novelId,
          id: { not: runId }, engine: 'loop', taskSpec: { path: ['id'], equals: parsedTaskSpec.data.id } },
        select: { id: true, status: true, usage: true, currentTurn: true, startedAt: true, finishedAt: true,
          events: { where: { type: { in: ['run.started', 'run.paused', 'run.finished'] } }, orderBy: { seq: 'asc' }, select: { type: true, createdAt: true } } },
      })
      if (!priorRuns.some(prior => prior.id === previousTask.id)) {
        throw new DataAccessError(409, 'TASK_AUTHORIZATION_BUDGET_UNCONFIRMED', '原任务预算链无法核实，不能创建新预算继续。')
      }
      for (const prior of priorRuns) {
        const saved = await restoreSavedUsage(prior, prior.id)
        if (!saved.success || ['queued', 'running', 'awaiting_approval'].includes(prior.status)) {
          throw new DataAccessError(409, 'TASK_AUTHORIZATION_BUDGET_UNCONFIRMED', '原任务仍在执行或累计预算记录无法核实，未启动重复执行。')
        }
        inheritedTokens += saved.data.totalTokens
        if (saved.data.checkpoint) restoreReviewEvidence(saved.data.checkpoint)
        inheritedTurns += prior.currentTurn
        const priorElapsed = recoverExecution(prior, executionStartedAt)
        priorExecutionMs += priorElapsed
        inheritedExecutionMs += priorElapsed
        if (prior.startedAt) runStartedAt = Math.min(runStartedAt, prior.startedAt.getTime())
      }
      const restoredPrior = await restoreSavedUsage(previousTask, previousTask.id)
      const priorCheckpoint = restoredPrior.success ? restoredPrior.data.checkpoint : undefined
      if (priorCheckpoint) restoreCheckpointLimits(priorCheckpoint)
    }
    if (params.resume && inheritedTurns > 0 && parsedTaskSpec.success) {
      // Older checkpoints did not store inherited time. Recompute from owned
      // run intervals; never treat the missing field as a fresh time budget.
      const preceding = await prisma.agentRun.findMany({ where: { ...MAIN_RUN_FILTER, userId: params.userId, sessionId: params.sessionId,
        novelId: params.novelId, id: { not: runId }, taskSpec: { path: ['id'], equals: parsedTaskSpec.data.id } },
        select: { startedAt: true, currentTurn: true, events: { where: { type: { in: ['run.started', 'run.paused', 'run.finished'] } },
          orderBy: { seq: 'asc' }, select: { type: true, createdAt: true } } } })
      const elapsed = preceding.reduce((total, previous) => total + recoverExecution(previous, executionStartedAt), 0)
      priorExecutionMs += Math.max(0, elapsed - inheritedExecutionMs)
      inheritedExecutionMs = Math.max(elapsed, inheritedExecutionMs)
    }
    let taskSpec: TaskSpec = parsedTaskSpec.success
      ? { ...parsedTaskSpec.data, runId }
      : buildTaskSpec({
          runId,
          novelId: params.novelId,
          chapterId: params.chapterId,
          prompt: params.prompt,
          selection: params.selection,
          creativeFreedom: params.creativeFreedom,
          qualityMode: params.qualityMode,
        })
    let taskSpecChanged = !parsedTaskSpec.success || Boolean(previousTask) || parsedTaskSpec.data.runId !== runId
    if ((params.resume || previousTask) && !params.activationResume) {
      const narrowed = narrowLegacyConversationTask(narrowLegacyResearchTask(taskSpec, contextPrompt), contextPrompt)
      taskSpecChanged ||= narrowed !== taskSpec
      taskSpec = narrowed
    }
    const protectsEarlierContent = taskSpec.postconditions.some((item) => item.code === 'EARLIER_CONTENT_UNCHANGED')
    if (protectsEarlierContent && (!continuingTask || !taskSpec.scope.chapterIds?.length)) {
      const existingChapters = await prisma.chapter.findMany({
        where: { novelId: params.novelId, authorId: params.userId },
        select: { id: true },
      })
      taskSpec = {
        ...taskSpec,
        scope: { ...taskSpec.scope, chapterIds: existingChapters.map((chapter) => chapter.id) },
      }
      taskSpecChanged = true
    }
    if (!parsedTaskSpec.success) taskSpec = await prisma.$transaction(tx => freezeWritingScope(tx,
      { userId: params.userId, novelId: params.novelId, runId }, taskSpec, contextPrompt))
    if (taskSpecChanged) {
      // Scope and inherited budget must become durable together, including if
      // execution is stopped before its first provider response.
      await prisma.agentRun.update({ where: { id: runId }, data: {
        taskSpec: taskSpec as unknown as object, usage: { ...usage, checkpoint: checkpointSnapshot() },
      } })
    } else await persistCheckpoint()
    if (pendingReviews.size) {
      throw new DataAccessError(409, 'REVIEW_PROVIDER_OUTCOME_UNCONFIRMED',
        '上次独立检查或其修订链仍有未确认的请求。正文、进度与原预算保留；请先核对原调用回执，系统不会因继续任务而重发未知付费请求，也未判定检查通过。')
    }
    if (params.resume || previousTask) {
      // Older executions saved prerequisites before those persisted transitions
      // had semantic receipts. Observe each verified task/target/phase once,
      // before a provider turn; restarting cannot mint another progress credit.
      const savedMilestones = await readPersistedWritingWorkflowMilestones({
        userId: params.userId, novelId: params.novelId, runId, taskSpec,
      })
      let recoveredWorkflowProgress = false
      for (const milestone of savedMilestones) {
        const action = milestone.phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build'
        recoveredWorkflowProgress = observeWritingWorkflowMilestone(progressSignatures, action, milestone,
          { userId: params.userId, novelId: params.novelId, runId, taskSpec }) || recoveredWorkflowProgress
      }
      if (recoveredWorkflowProgress) {
        stagnantBatches = nextStagnantBatch(stagnantBatches, true, false)
        await persistCheckpoint()
      }
    }
    if (!params.resume && taskSpec.intent !== 'research_analysis') {
      await withGoalExecutionContext(ownedGoalExecution, () => withGoalEffects(() => captureUserDirectives({
        userId: params.userId,
        novelId: params.novelId,
        sessionId: params.sessionId,
        chapterId: params.chapterId,
        sourceMessageId: userMessageId,
        taskSpec,
        prompt: params.prompt,
      })))
    }
    // 仅压缩已终态的旧 run；当前正在执行的消息永不进入检查点。
    await compactSessionContext(params.userId, params.sessionId, false).catch((error) => {
      console.error('[agent-loop] 自动上下文压缩失败，继续使用无损近期历史', runId, error)
    })

    // 首次对话且仍是默认标题时异步自动命名（仅一次，不阻塞循环）
    if (!params.resume && !ownedGoalExecution) {
      void autoNameSession({
        signal: controller.signal,
        modelRuntime,
        sessionId: params.sessionId,
        userId: params.userId,
        novelId: params.novelId,
        prompt: params.prompt,
      })
    }

    const imageAttachments = (params.attachments ?? []).filter((attachment) => attachment.kind === 'image')
    const directImageInputs = modelRuntime.visionEnabled
      ? await Promise.all(imageAttachments.map(async (attachment) => ({ attachment, dataUrl: await readManagedImageDataUrl(attachment.url, params.userId) })))
      : []
    const directVisionEnabled = imageAttachments.length > 0
      && directImageInputs.length === imageAttachments.length
      && directImageInputs.every((item) => Boolean(item.dataUrl))

    const assembledContext = await assembleContext({
      agent,
      mode: params.mode,
      sessionId: params.sessionId,
      runId,
      includeCurrentRunHistory: Boolean(params.resume),
      userId: params.userId,
      novelId: params.novelId,
      chapterId: params.chapterId,
      prompt: contextPrompt,
      selection: params.selection,
      attachments: params.attachments ?? [],
      visionEnabled: directVisionEnabled,
      taskSpec,
      modelTier: modelRuntime.tier,
      modelName: modelRuntime.modelName,
      contextWindowTokens: modelRuntime.contextWindowTokens,
      pinnedSkillIds: params.pinnedSkillIds ?? [],
    })
    const messages: ChatMessage[] = assembledContext.messages
    // The last assembled user message is the original goal input. Attach its
    // pixels before adding steering or orchestration messages to the tail.
    if (directVisionEnabled) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'user' || typeof message.content !== 'string') continue
        message.content = [
          { type: 'text', text: message.content },
          ...directImageInputs.flatMap((item) => item.dataUrl ? [{ type: 'image_url' as const, image_url: { url: item.dataUrl, detail: 'auto' as const } }] : []),
        ]
        break
      }
    }
    if (params.goalSteering && ownedGoalExecution) {
      messages.push(await (await import('./goal-steering-message.js')).buildGoalSteeringMessage(params.goalSteering, params.userId, Boolean(modelRuntime.visionEnabled)))
    }
    // 子 Agent 目录注入：主控据此按触发条件用 subagent_run 像调工具一样内嵌调用子 Agent（codex/Zcode 模式）
    if (agent.type === 'orchestrator') {
      const { renderSubagentCatalog } = await import('./productivity.js')
      const catalog = await renderSubagentCatalog(params.userId, params.novelId, params.pinnedSubagentId)
      insertSubagentCatalog(messages, catalog)
    }
    // 仅恢复指定任务的协作关系，禁止把同会话中旧任务的窗口重新激活。
    const orchestrationResumeNote = await buildOrchestrationResumeNote(params.sessionId, runId, continuingTask)
    if (orchestrationResumeNote) {
      messages.push({ role: 'user', content: orchestrationResumeNote })
    }

    if (assembledContext.skillRoute) {
      const skillRoute = assembledContext.skillRoute
      const candidates = skillRoute.candidates.map(({ skill, score, reasonCodes }) => ({
        id: skill.id,
        name: skill.name,
        version: skill.version,
        score: Math.round(score * 100) / 100,
        reasonCodes,
      }))
      const selected = skillRoute.selected.map((skill) => ({
        id: skill.id,
        name: skill.name,
        version: skill.version,
      }))
      // P0 可观测：selected 即本轮已完整注入的 Skill，而不是“可能会加载”的候选。
      await prisma.agentSkillRun.upsert({
        where: { runId },
        create: {
          runId,
          userId: params.userId,
          novelId: params.novelId,
          phase: skillRoute.phase,
          routerVersion: skillRoute.routerVersion,
          candidates,
          selected,
          loaded: selected,
          reasonCodes: skillRoute.reasonCodes,
          confidence: skillRoute.confidence,
          estimatedTokens: skillRoute.estimatedTokens,
        },
        update: {
          phase: skillRoute.phase,
          routerVersion: skillRoute.routerVersion,
          candidates,
          selected,
          reasonCodes: skillRoute.reasonCodes,
          confidence: skillRoute.confidence,
          estimatedTokens: skillRoute.estimatedTokens,
        },
      })
      await recordSkillLoads({ runId, userId: params.userId, novelId: params.novelId }, skillRoute.selected, skillRoute.phase, 'route')
      bus.emit({
        type: 'skill.route',
        phase: skillRoute.phase,
        candidates: candidates.map(({ id, name, version }) => ({ id, name, version })),
        selected,
        reasonCodes: skillRoute.reasonCodes,
        confidence: skillRoute.confidence,
        estimatedTokens: skillRoute.estimatedTokens,
        skippedReason: skillRoute.skippedReason,
      })
    }

    // Resolve each phase once per execution; keep only its active hint at the tail.
    // Multi-chapter cycles reuse it, and compaction must not silently lose it.
    const phaseDigests = new Map<SkillPhase, string>(assembledContext.skillRoute
      ? [[assembledContext.skillRoute.phase, buildSkillExecutionDigest(assembledContext.skillRoute, taskSpec.creativeFreedom)]] : [])
    let activeSkillHint: ChatMessage | null = null
    let pendingSkillPhase: SkillPhase | null = null
    const activateSkillDigest = (digest?: string) => {
      if (digest !== undefined) {
        if (activeSkillHint) {
          const index = messages.indexOf(activeSkillHint)
          if (index >= 0) messages.splice(index, 1)
        }
        activeSkillHint = digest ? { role: 'user', content: `[系统·创作阶段工作方法] 仅辅助既定任务，不新增任务或权限。\n${digest}` } : null
      }
      if (activeSkillHint && !messages.includes(activeSkillHint)) messages.push(activeSkillHint)
    }
    const refreshPhaseSkills = async () => {
      const phase = pendingSkillPhase
      pendingSkillPhase = null
      if (!assembledContext.skillRoute || controller.signal.aborted) return
      if (!phase) { activateSkillDigest(); return }
      const cached = phaseDigests.get(phase)
      if (cached !== undefined) { activateSkillDigest(cached); return }
      const catalog = await resolveEnabledRuntimeSkills(params.userId, params.novelId)
      if (controller.signal.aborted) throw new DOMException('run aborted', 'AbortError')
      const decision = routeSkills({ mode: params.mode, intent: phaseIntent(phase), phase,
        prompt: `${params.prompt}\n当前已验证工作阶段：${phaseSignals[phase] ?? phase}`,
        freedom: taskSpec.creativeFreedom, catalog, pinnedSkillIds: new Set(params.pinnedSkillIds ?? []) })
      const digest = decision.selected.length ? buildSkillExecutionDigest(decision, taskSpec.creativeFreedom) : ''
      phaseDigests.set(phase, digest)
      // Appended only between complete tool batches, never inside call/result pairs.
      activateSkillDigest(digest)
      if (!decision.selected.length) return
      await recordSkillLoads({ runId, userId: params.userId, novelId: params.novelId }, decision.selected, phase, 'phase')
      bus.emit({ type: 'skill.route', phase, candidates: decision.candidates.map(({ skill }) => ({ id: skill.id, name: skill.name, version: skill.version })),
        selected: decision.selected.map(({ id, name, version }) => ({ id, name, version })), reasonCodes: decision.reasonCodes,
        confidence: decision.confidence, estimatedTokens: decision.estimatedTokens })
    }

    const featureFlags = resolveAgent2FeatureFlags(params.userId)
    const sessionPolicy = await prisma.agentSession.findUnique({ where: { id: params.sessionId }, select: { toolPolicy: true, sandboxMode: true, spawnedFromSessionId: true } })
    const scopedTools = restrictToolsToTask(getToolsForAgent(agent, params.mode, featureFlags, { goalOwned: Boolean(ownedGoalExecution) }), taskSpec)
    // 派生窗口禁用跨任务编排：否则 b 再派生 e、e 再派生 f 会指数级打爆并发与额度，
    // 而且互相等待还会直接死锁；派生窗口的职责就是干完自己那一份并交回摘要
    const orchestrationScopedTools = sessionPolicy?.spawnedFromSessionId
      ? scopedTools.filter((tool) => !ORCHESTRATION_TOOL_NAMES.has(tool.name))
      : scopedTools
    const currentTools = applySessionToolPolicy(
      orchestrationScopedTools,
      params.mode,
      sessionPolicy?.toolPolicy,
      sessionPolicy?.sandboxMode === 'read_only' || sessionPolicy?.sandboxMode === 'full_access' ? sessionPolicy.sandboxMode : 'workspace',
    )
    const activationCeiling = ownedGoalExecution ? await prisma.$transaction(async tx => {
      const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: ownedGoalExecution.goalId } })
      return (await import('./goal-activation.js')).readGoalActivationToolCeiling(tx, goal)
    }) : null
    const ceiling = params.toolAuthorityCeiling ?? (activationCeiling ? new Map(activationCeiling) : null)
    const tools = ceiling ? intersectToolAuthority(currentTools, params.mode, ceiling) : currentTools
    const openAITools = toOpenAITools(tools, taskSpec.scope)
    const contextBudget = resolveAgentContextBudget(modelRuntime.contextWindowTokens ?? env.agentContextWindowTokens, env.aiTextMaxOutputTokens)

    /**
     * Provider-independent in-run compaction for DeepSeek, GLM and custom
     * OpenAI-compatible models. It counts tool schemas, tool arguments,
     * reasoning and multimodal placeholders instead of only visible text.
     */
    const prepareContextForRequest = (requestTools = openAITools, reason = 'turn') => {
      const toolDefinitionTokens = estimateToolDefinitionTokens(requestTools)
      const beforeTokens = estimateChatMessagesTokens(messages) + toolDefinitionTokens
      let afterTokens = beforeTokens
      let compactedToolArguments = 0
      let compactedToolOutputs = 0
      let collapsedToolRounds = 0

      if (beforeTokens >= contextBudget.compactAtTokens) {
        releaseCompletedReasoning(messages)
        const firstStage = compactEarlyToolPayloads(messages, CONTEXT_SLIM_KEEP_RECENT_TOOL_OUTPUTS)
        compactedToolArguments += firstStage.compactedToolArguments
        compactedToolOutputs += firstStage.compactedToolOutputs
        collapsedToolRounds += firstStage.collapsedToolRounds
        afterTokens = firstStage.afterTokens + toolDefinitionTokens
      }
      if (afterTokens > contextBudget.hardRequestTokens) {
        const secondStage = collapseEarlyToolRounds(messages, 1)
        collapsedToolRounds += secondStage.collapsedToolRounds
        afterTokens = secondStage.afterTokens + toolDefinitionTokens
      }
      if (compactedToolArguments > 0 || compactedToolOutputs > 0 || collapsedToolRounds > 0) {
        console.info('[agent-loop] 运行中上下文压缩', JSON.stringify({
          runId,
          turn,
          reason,
          modelTier: modelRuntime.tier,
          contextWindowTokens: contextBudget.contextWindowTokens,
          beforeTokens,
          afterTokens,
          compactedToolArguments,
          compactedToolOutputs,
          collapsedToolRounds,
        }))
      }
      return { beforeTokens, afterTokens, fits: afterTokens <= contextBudget.hardRequestTokens }
    }
    // plan/18：轮次片/预算片可被检查点续跑刷新，改 let；预算从「只能下调」改为 clamp 到硬顶（默认 500 万）

    const toolContext: ToolContext = {
      planContentHashes: new Map(),
      userId: params.userId,
      novelId: params.novelId,
      chapterId: params.chapterId,
      sessionId: params.sessionId,
      runId,
      protectedChapterIds: protectsEarlierContent ? new Set(taskSpec.scope.chapterIds ?? []) : undefined,
      toolAuthority: snapshotToolAuthority(tools, params.mode),
      callId: '',
      mode: params.mode,
      creativeFreedom: taskSpec.creativeFreedom,
      qualityMode: taskSpec.qualityMode,
      sandboxMode: sessionPolicy?.sandboxMode === 'read_only' || sessionPolicy?.sandboxMode === 'full_access' ? sessionPolicy.sandboxMode : 'workspace',
      // 子 Agent 跟随主 run 的模型与额度计费：custom 档直接消耗用户自己的 token，内置档按倍率扣 credits
      modelRuntime,
      modelAssignments: params.modelAssignments,
      applyModelAssignments: value => {
        params.modelAssignments = value
        toolContext.modelAssignments = value
        updateModelAssignmentContext(params.userId, params.novelId, value)
      },
      emit: (event) => bus.emit(event),
      signal: controller.signal,
    }

    let lastAssistantText = ''
    // 模型把工具调用写成正文文本而非真正 function calling 时的纠偏重试次数
    const protocolRecovery = createProtocolRecoveryGuard()
    const emptyResponseRecovery = createEmptyResponseGuard()
    let requireNativeToolCall = false
    const toolNameList = tools.map((tool) => tool.name)
    // C3：规划类任务必须以 plan_save 落盘收尾，只聊天不落盘时回填提醒
    const expectsPlanSave = taskSpec.intent !== 'research_analysis' && params.mode === 'plan' && /(规划|大纲|计划)/.test(params.prompt)
    let planSavePerformed = false
    let planSaveReminders = 0
    // 长任务防早停：待办清单（todo_write 维护）未全部完成就想收尾时，回填强指令让它接着执行
    // 续跑时从会话恢复既有清单，新任务从空开始（避免上一个任务的残留待办干扰）
    let todoItems: AgentTodoItem[] = continuingTask ? await loadSessionTodoItems(params.sessionId, await getTaskRunIds(params.sessionId, runId)) : []
    let todoReminders = 0
    let authorEndRequested = false
    if (continuingTask) messages.push({ role: 'user', content: `[系统] 恢复指定任务 ${taskSpec.id}，不是恢复整个会话的历史工作。原目标：${taskSpec.goals.join('；')}。\n${renderTodoItems(todoItems)}\n历史中其他任务的并行窗口、待办与一次性指令不构成本任务的授权；禁止重新启动它们。被停止时生成但未成功执行的工具不是已保存成果。先核对本任务已保存进度，执行剩余工作。仅尚有多个独立执行单元的长任务或复杂任务需要建立待办；没有清单不是未完成的证据，确已完成时直接交付，禁止在结尾补造已完成清单、提交空清单或覆盖历史待办。不得仅回复下一步打算就结束，也不得将未完成项标为已完成。` })
    let consecutiveStructureFailures = 0
    // A4：长上下文提醒消息（单实例，每轮移除后重新追加到队尾，保证只存在一条且最靠近当前轮）
    const contextReminder: ChatMessage = {
      role: 'user',
      content: `[系统提醒] 对话已较长，重申信道纪律：正文信道每个关键节点可给作者一句可见进展（刚完成什么、下一步做什么）；执行类任务收尾写简短交付说明（不超过 2 句 80 字）。若作者要求提问、检查、对比、分析或报告，正文就是交付物，须完整输出结论与证据，不受80字限制，可用标准Markdown但不用原始HTML或远程图片；不得用泛化文字填补来源缺口。规划产出走 plan_save，修订带 planId；需要作者决策用 ask_user。当前模式：${params.mode}。`,
    }

    /** P1 信道重复命中处置：观察模式只记日志零干预；干预模式首次提醒、二次命中强制收尾 */
    const handleRepeatHit = (gram: string | null): void => {
      if (!gram) return
      if (env.agentRepeatGuardMode !== 'enforce') {
        console.warn('[agent-loop] repeat-detector 命中（观察模式，不干预）', runId, JSON.stringify(gram))
        return
      }
      if (!repeatReminderSent) {
        repeatReminderSent = true
        messages.push({
          role: 'user',
          content: '[系统] 检测到信道正在重复输出同一段内容。立即停止复读，直接输出新内容或推进下一步动作。',
        })
        return
      }
      forceWrapUpReason = '信道重复输出同一段内容已终止（复读熔断）。'
    }

    const finishLimitedWritingIfAllowed = async (): Promise<boolean> => {
      if (pendingReviews.size || todoItems.some(item => (item.status === 'pending' || item.status === 'in_progress') && !limitedReviewDependency(item.content))) return false
      const subject = { userId: params.userId, novelId: params.novelId, runId }
      const expected = await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))
      if (!expected) return false
      controller.signal.throwIfAborted()
      await finalizeRun(runId, bus, 'succeeded', usage, turn, expected.outcome.summary, undefined, false,
        undefined, undefined, undefined, false, { subject, expected, signal: controller.signal, messageId: randomUUID() })
      return true
    }

    /** A local unavailable tool cannot manufacture whole-task failure. Work that
     * cannot yet be delivered is parked honestly, with its original obligations. */
    const wrapUpAndFinish = async (reasonText: string): Promise<void> => {
      if (forceWrapUpLocal && await finishLimitedWritingIfAllowed()) return
      const text = `${reasonText}已保存的内容保留，本次工作尚未完成。`
      const messageId = randomUUID()
      bus.emit({ type: 'message.start', messageId, role: 'assistant' })
      bus.emit({ type: 'text.final', messageId, text, asReasoning: false })
      await persistMessage(messageId, runId, params.sessionId, 'assistant', [{ type: 'text', text }])
      await finalizeRun(runId, bus, forceWrapUpLocal ? 'paused' : 'failed', usage, turn, text.slice(0, 300), reasonText, false,
        undefined, undefined, undefined, false, undefined, forceWrapUpLocal ? 'needs_input' : 'user_stop')
    }

    const finishPersistedWritingIfComplete = async (beforeFinish?: () => Promise<void>) => {
      let delivery = await prisma.$transaction(tx => readCompletedWritingDelivery(tx,
        { userId: params.userId, novelId: params.novelId, runId }))
      if (!delivery) return false
      controller.signal.throwIfAborted()
      await beforeFinish?.()
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await finalizeRun(runId, bus, 'succeeded', usage, turn, delivery.text.slice(0, 300), undefined, false, undefined, undefined,
            { messageId: randomUUID(), subject: { userId: params.userId, novelId: params.novelId, runId }, expected: delivery, signal: controller.signal })
          lastAssistantText = delivery.text
          return true
        } catch (error) {
          if (!(error instanceof DataAccessError) || error.code !== 'WRITING_DELIVERY_STALE' || attempt !== 0) throw error
          // A display withdrawal can change the capture while the chapter is
          // already complete. Re-read once without buying a formatting turn.
          delivery = await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId: params.userId, novelId: params.novelId, runId }))
          if (!delivery) return false
          controller.signal.throwIfAborted()
        }
      }
      return false
    }

    // Cumulative usage is accounting. Completion, cancellation and stagnation stop the loop.
    const seenGoalConsents = new Set<string>()
    if (taskSpec.controlPolicy !== 'until_completion') checkpointOrigin = 'unknown_legacy'
    const executionControl = untilCompletionControl(checkpointOrigin)
    while (executionControl.controlPolicy === 'until_completion') {
      if (controller.signal.aborted) throw new DOMException('run aborted', 'AbortError')
      if (await finishPersistedWritingIfComplete()) return
      const configurationChanges = await prisma.agentConfigurationChange.findMany({ where: { runId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
      if (configurationChanges.length) {
        const current = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
        if (!['running', 'awaiting_approval'].includes(current.status)) throw new DOMException('run stopped', 'AbortError')
        if (current.modelTier !== modelRuntime.tier || current.customModelId !== (params.customModelId ?? null) || current.reasoningEffort !== modelRuntime.reasoningEffort) {
          modelRuntime = await getModelTierRuntime(current.modelTier as CreditModelTier, params.userId, current.customModelId,
            current.reasoningEffort as import('../../../shared/contracts/index.js').ModelReasoningEffort)
          params.customModelId = current.customModelId
          runtimeModelName = modelRuntime.modelName ?? agent.model
          toolContext.modelRuntime = modelRuntime
        }
        const saved = configurationChanges.map(change => change.response as { creativeFreedom?: CreativeFreedom;
          modelAssignments?: import('../../../shared/contracts/agent-model-assignments.js').FrozenModelAssignments; configuration?: { creativeFreedom?: CreativeFreedom } })
        const assignments = saved.find(change => change.modelAssignments)?.modelAssignments
        if (assignments) toolContext.applyModelAssignments?.(assignments)
        const mode = saved.map(change => (change.configuration ?? change).creativeFreedom).find(Boolean)
        if (mode) {
          taskSpec = { ...taskSpec, creativeFreedom: mode }
          toolContext.creativeFreedom = mode
        }
      }
      if (!sessionPolicy?.spawnedFromSessionId && agent.type === 'orchestrator') {
        const changes = await (await import('./configuration-journal.js')).consumeLegacyConfigurationConsent(params.userId, runId)
        for (const change of changes) if (!seenGoalConsents.has(change.id)) {
          messages.push({ role: 'user', content: change.prompt })
          seenGoalConsents.add(change.id)
        }
        const consent = await (await import('./goal-consent.js')).consumeLegacyGoalConsent({ userId: params.userId,
          sessionId: params.sessionId, novelId: params.novelId, runId })
        if (consent && !seenGoalConsents.has(consent.id)) {
          messages.push({ role: 'user', content: consent.prompt })
          seenGoalConsents.add(consent.id)
        }
      }
      // Includes an explicitly resumed historical run. Reuse its confirmed
      // response/report evidence before purchasing another reasoning turn.
      if (toolRestrictions.some(item => item.action === 'quality_analyze' && item.code === 'QUALITY_REPORT_INCOMPLETE')
        && await finishLimitedWritingIfAllowed()) return
      turn += 1
      // Per-request deadlines and idle detection remain independent of cumulative usage.
      if (Date.now() - lastActivityAt > env.agentRunIdleMinutes * 60_000) {
        await wrapUpAndFinish(`任务已空转超过 ${env.agentRunIdleMinutes} 分钟没有任何进展输出。`)
        return
      }
      lastActivityAt = Date.now()

      await refreshPhaseSkills()
      // A4 长上下文防稀释：超过阈值后每轮把提醒刷新到队尾，拉回系统约束注意力
      const reminderIndex = messages.indexOf(contextReminder)
      if (reminderIndex >= 0) {
        messages.splice(reminderIndex, 1)
      }
      const estimatedRequestTokens = estimateChatMessagesTokens(messages) + estimateToolDefinitionTokens(openAITools)
      if (estimatedRequestTokens > contextBudget.warningTokens) {
        messages.push(contextReminder)
      }
      // 在发往供应商之前执行模型窗口感知的压缩；仍超限则安全收尾，不把必失败请求交给供应商。
      const requestBudget = prepareContextForRequest(openAITools, 'turn')
      if (!requestBudget.fits) {
        await wrapUpAndFinish('当前任务上下文已达到所选模型的安全窗口上限。')
        return
      }

      const messageId = randomUUID()
      bus.emit({ type: 'message.start', messageId, role: 'assistant' })
      // 登记本轮缓冲：流式正文/思考与轮末组装的 parts 都记在这里，供中止时补落库
      liveTurn = { messageId, parts: [], streamedText: '', streamedReasoning: '' }

      // Preview preparation immediately without announcing an admitted execution.
      // Only handleToolCall emits tool.call; unadmitted previews expire at the step boundary.
      const announcedToolNames = new Map<string, string>()
      const toolArgsProgress = new Map<string, { chars: number; lastEmitted: number }>()
      const streamingToolArgs = new Map<string, string>()
      // 可见信道流式清洗：正文/思考逐 token 清洗后只下发安全增量，尾部未完成标识符先扣留，
      // 从源头杜绝「先播英文、轮末再修正成中文」的二次闪变（作者明确不要二次修正观感）
      const visibleTextStreamer = createVisibleTextStreamer()
      const visibleReasoningStreamer = createVisibleTextStreamer()

      const observeTurnUsage = trackRequestUsage(usage)
      const result = await chatWithTools({
        freePromotion: modelRuntime.freePromotion,
        onUsage: observeTurnUsage,
        messages,
        tools: openAITools,
        ...(requireNativeToolCall && openAITools.length > 0 ? { toolChoice: 'required' as const } : {}),
        model: runtimeModelName,
        providerBaseUrl: modelRuntime.baseUrl,
        providerApiKey: modelRuntime.apiKey,
        provider: modelRuntime.provider,
        reasoningEffort: modelRuntime.reasoningEffort,
        reasoningParameterMode: modelRuntime.reasoningParameterMode,
        thinkingEnabled: modelRuntime.thinkingEnabled,
        outputTokenParameter: modelRuntime.outputTokenParameter,
        temperature: taskSpec.creativeFreedom === 'stable' ? 0.45 : taskSpec.creativeFreedom === 'bold' ? 0.85 : 0.65,
        onChunk: (chunk) => {
          if (chunk.type === 'text-delta') {
            // 正文与 reasoning 都逐 token 实时播出，但只播清洗后的安全增量；轮末由 text.final 统一结算整段
            if (liveTurn) liveTurn.streamedText += chunk.delta
            lastActivityAt = Date.now()
            const textIncrement = visibleTextStreamer.push(chunk.delta)
            if (textIncrement) {
              bus.emit({ type: 'text.delta', messageId, delta: textIncrement })
              // P1：对清洗后的可见增量做重复检测（避免英文协议残留干扰判定）
              handleRepeatHit(repeatDetector.push(textIncrement))
            }
          } else if (chunk.type === 'reasoning-delta') {
            if (liveTurn) liveTurn.streamedReasoning += chunk.delta
            lastActivityAt = Date.now()
            const reasoningIncrement = visibleReasoningStreamer.push(chunk.delta)
            if (reasoningIncrement) {
              bus.emit({ type: 'reasoning.delta', messageId, delta: reasoningIncrement })
              handleRepeatHit(repeatDetector.push(reasoningIncrement))
            }
          } else if (chunk.type === 'tool-call-start') {
            lastActivityAt = Date.now()
            if (chunk.id) {
              announcedToolNames.set(chunk.id, chunk.name)
              const tool = tools.find(candidate => candidate.name === chunk.name)
              if (tool) bus.emitTransient({ type: 'tool.delta', messageId, callId: chunk.id,
                toolName: tool.name, title: tool.title, argsChars: 0 })
            }
          } else if (chunk.type === 'tool-call-arguments-delta') {
            lastActivityAt = Date.now()
            if (chunk.id) {
              const progress = toolArgsProgress.get(chunk.id) ?? { chars: 0, lastEmitted: 0 }
              progress.chars += chunk.delta.length
              toolArgsProgress.set(chunk.id, progress)
              const rawArgs = `${streamingToolArgs.get(chunk.id) ?? ''}${chunk.delta}`
              streamingToolArgs.set(chunk.id, rawArgs)
              const toolName = announcedToolNames.get(chunk.id) ?? ''
              const tool = tools.find(candidate => candidate.name === toolName)
              const draft = extractStreamingToolDraft(toolName, rawArgs)
              if (draft || progress.chars - progress.lastEmitted >= TOOL_ARGS_PROGRESS_STEP) {
                progress.lastEmitted = progress.chars
                bus.emitTransient({ type: 'tool.delta', messageId, callId: chunk.id, argsChars: progress.chars,
                  ...(tool ? { toolName: tool.name, title: tool.title } : {}), ...(draft ? { draft } : {}) })
              }
            }
          }
        },
        signal: controller.signal,
        usageLog: {
          userId: params.userId,
          action: 'agentLoopTurn',
          novelId: params.novelId,
          chapterId: params.chapterId,
          targetType: 'agentRun',
          targetId: runId,
          agentRunId: runId,
          turn,
          modelTier: modelRuntime.tier,
          multiplierBps: modelRuntime.multiplierBps,
        },
      })

      observeTurnUsage(result.usage)
      await persistCheckpoint()

      const recoveredToolCalls = result.toolCalls.length === 0
        ? recoverAgentProtocolToolCalls(result.content).map((call, index) => ({
            id: `recovered_${messageId}_${index}`,
            name: call.name,
            arguments: call.arguments,
          }))
        : []
      const effectiveToolCalls = result.toolCalls.length > 0 ? [...result.toolCalls] : recoveredToolCalls
      let automaticReviewTriggered = false
      let mergedReviewReminder: string | undefined
      // A weak tool caller cannot skip the delivery assessments by returning
      // prose. These calls use the same original tool ceiling and ordinary
      // journal, approvals, billing and compiler counters as model calls.
      if (effectiveToolCalls.length === 0 && ['write', 'revise'].includes(taskSpec.intent)
        && params.mode === 'build' && !['conversation_only', 'proposal_only'].includes(taskSpec.writingPacing ?? '')
        && result.finishReason !== 'tool_calls' && !containsAgentProtocolInvocation(result.content)
        && !looksLikePseudoToolCall(result.content, toolNameList)) {
        const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, { userId: params.userId, novelId: params.novelId, runId }))
        const next = nextReviewDispatch(readiness, new Set(tools.map(tool => tool.name)), automaticReviewAttempts)
        if (next.kind === 'tool') {
          automaticReviewTriggered = true
          effectiveToolCalls.push({ id: `review_${messageId}`, name: next.tool.name, arguments: JSON.stringify(next.tool.args) })
        }
        else if (next.kind === 'blocked' || next.kind === 'limited') {
          if (next.kind === 'limited' && await finishLimitedWritingIfAllowed()) return
          forceWrapUpReason = next.reason
          forceWrapUpLocal = next.kind === 'limited' || Boolean(readiness?.requiredTools.some(item => findToolRestriction(toolRestrictions, item.name, item.args, readiness.chapterId)))
        }
        else if (readiness?.ready && toolContext.sandboxMode !== 'read_only'
          && !toolContext.inlineChild && !toolContext.protectedChapterIds?.has(readiness.chapterId)
          && (readiness.continuityErrorCount > 0 || (readiness.qualityCandidateCount ?? 0) > 0)) {
          const channel = await prisma.$transaction(tx => probeChapterReviewRevision(tx,
            { userId: params.userId, novelId: params.novelId, runId }, { id: readiness.chapterId, revision: readiness.revision }))
          const key = nextMergedReviewReminder(readiness, new Set(tools.map(tool => tool.name)), automaticReviewAttempts, channel.open)
          if (key) {
            automaticReviewAttempts.add(key)
            await persistCheckpoint()
            automaticReviewTriggered = true
            mergedReviewReminder = `[系统/只读状态] 当前 compilationId=${readiness.compilationId}、chapterId=${readiness.chapterId}、r${readiness.revision} 的检查已完成，仍有原授权范围内的意见待处理。核对当前正文和两类报告${readiness.qualityReportId ? `（质量报告 ${readiness.qualityReportId}）` : ''}；优先合并安全的事实与审美修改，也可分步调用 chapter_edit_range 或 chapter_write，不限一次调用。不能仅替换同义词后声称全部完成；不能安全修改的候选可用 retainedFindings 绑定原意见并写明具体原因，也可明确留置全部意见。普通编辑不增加付费自动修订或检查额度，不重放未知请求或改变原范围。完成实际修改后，在既有检查次数内复核最终版本，再提交终态。`
          }
        }
      }

      const reviewProgressText = mergedReviewReminder ? '正在核对检查意见的处理结果。' : '正文已保存，正在完成当前版本的必要检查。'

      messages.push({
        role: 'assistant',
        content: automaticReviewTriggered ? reviewProgressText : recoveredToolCalls.length > 0 ? null : (result.content || null),
        reasoning: result.reasoning || undefined,
        toolCalls: effectiveToolCalls.length > 0 ? effectiveToolCalls : undefined,
      })

      const cleanContent = automaticReviewTriggered ? reviewProgressText
        : humanizeAgentVisibleText(result.content ? stripAgentProtocolArtifacts(result.content) : '')

      // 主流 Agent 标准（Codex 等）：任务过程中的进展正文同样是对话正文信道，作者实时可见、刷新后仍在；
      // 只有模型原生 reasoning 才进思考信道，执行旁白不再改道思考区。
      // text.delta 已实时显示供应商原始流；无论最终是否有干净文本，都要发 text.final 做归一化，
      // 这样 DSML/乱码被清洗成空串时能立即从界面移除，而不是残留到刷新前。
      if (result.content || automaticReviewTriggered) bus.emit({ type: 'text.final', messageId, text: cleanContent, asReasoning: false })

      const parts: AgentMessagePart[] = []
      if (liveTurn) liveTurn.parts = parts
      if (result.reasoning) {
        // 思考信道作者可见：落库同样清洗，避免刷新后历史思考行里残留英文协议词汇
        parts.push({ type: 'reasoning', text: humanizeAgentVisibleText(result.reasoning) })
      }
      if (cleanContent) {
        parts.push({ type: 'text', text: cleanContent })
      }
      if (forceWrapUpReason && effectiveToolCalls.length === 0) {
        await persistMessage(messageId, runId, params.sessionId, 'assistant', parts.filter(part => part.type !== 'text'))
        bus.emit({ type: 'text.final', messageId, text: '', asReasoning: false })
        liveTurn = null
        await wrapUpAndFinish(forceWrapUpReason)
        return
      }

      if (mergedReviewReminder) {
        requireNativeToolCall = true
        await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
        bus.emit({ type: 'step.finish', turn, usage: result.usage })
        messages.push({ role: 'user', content: mergedReviewReminder })
        continue
      }

      const invalidToolProtocol =
        effectiveToolCalls.length === 0 &&
        (result.finishReason === 'tool_calls' || containsAgentProtocolInvocation(result.content) || looksLikePseudoToolCall(result.content, toolNameList))
      const protocolDecision = protocolRecovery.observe(effectiveToolCalls.length > 0, invalidToolProtocol)
      if (effectiveToolCalls.length > 0) requireNativeToolCall = false

      if (invalidToolProtocol) {
        // Do not feed an unsuccessful pseudo-call back as an assistant example.
        messages.pop()
        bus.emit({ type: 'text.final', messageId, text: '', asReasoning: false })
        const diagnosticParts = parts.filter((part) => part.type === 'reasoning')
        if (liveTurn) {
          liveTurn.parts = diagnosticParts
          liveTurn.streamedText = ''
        }
        console.warn('[agent-tool-protocol]', { runId, turn, finishReason: result.finishReason, decision: protocolDecision, contentChars: result.content.length })
        if (protocolDecision === 'retry') {
          requireNativeToolCall = true
          // 协议失败的执行叙述不能作为真实交付落库；只保留 reasoning 供展开排障。
          await persistMessage(messageId, runId, params.sessionId, 'assistant', diagnosticParts)
          bus.emit({ type: 'step.finish', turn, usage: result.usage })
          messages.push({
            role: 'user',
            content:
              '[系统/P0] 上次响应没有产生 API 原生 function call，该次操作未执行。历史工具记录不是调用语法。请通过本次请求提供的 tools 生成原生 tool_calls（含函数名和完整参数），不要在正文中描述或模拟调用。只重试尚未执行的操作，不重复已有真实工具回执的操作。',
          })
          continue
        }

        const failureText = '模型工具调用格式异常，已达到本轮纠错上限并安全停止。已完成操作保留，异常文本未执行；可继续任务，若再次出现请切换支持工具调用的模型。'
        bus.emit({ type: 'text.delta', messageId, delta: failureText })
        bus.emit({ type: 'text.final', messageId, text: failureText, asReasoning: false })
        await persistMessage(messageId, runId, params.sessionId, 'assistant', [{ type: 'text', text: failureText }])
        bus.emit({ type: 'step.finish', turn, usage: result.usage })
        await finalizeRun(runId, bus, 'failed', usage, turn, failureText, failureText)
        return
      }

      if (cleanContent) lastAssistantText = cleanContent

      const emptyDecision = emptyResponseRecovery.observe(cleanContent, effectiveToolCalls.length)
      if (emptyDecision !== 'continue') {
        // Preserve diagnosis, but do not replay unproductive reasoning into a
        // growing request. Model and reasoning settings remain unchanged.
        messages.pop()
        await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
        bus.emit({ type: 'step.finish', turn, usage: result.usage })
        console.warn('[agent-empty-response]', { runId, turn, finishReason: result.finishReason,
          reasoningChars: result.reasoning.length, completionTokens: result.usage.completionTokens, decision: emptyDecision })
        if (emptyDecision === 'stop') {
          const reason = result.finishReason === 'length'
            ? '模型连续两轮未返回正文或工具调用，本轮又达到单次输出上限；已停止重复消耗，任务未完成。已保存内容保留，请检查模型输出上限或选择合适的推理档位后再继续。'
            : '模型连续两轮未返回正文或工具调用，已停止重复消耗；任务未完成，已保存内容保留。请检查模型服务后再继续。'
          await finalizeFailedWithNotice(reason)
          return
        }
        requireNativeToolCall = true
        messages.push({ role: 'user', content: '[系统] 上轮只返回思考或空响应，没有正文和工具调用，不构成任何已完成工作。请直接执行原授权范围内一个必要的工具步骤，或给出有效答复；如受内容限制或缺少必要信息，请明确说明，不要继续长篇空转思考。' })
        continue
      }

      if (effectiveToolCalls.length === 0) {
        // C3：规划类任务未经 plan_save 落盘就想收尾，回填提醒（最多 2 次）防止全程只聊天不落盘
        if (expectsPlanSave && !planSavePerformed && planSaveReminders < 2) {
          planSaveReminders += 1
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
          bus.emit({ type: 'step.finish', turn, usage: result.usage })
          messages.push({
            role: 'user',
            content:
              '[系统] 规划模式的产出必须通过 plan_save 工具写入「计划」文件夹，目前尚未落盘。请立即调用 plan_save 保存完整计划（修订既有计划请带 planId），不要在正文里输出计划内容。',
          })
          continue
        }

        // 防早停：待办清单还有未完成项就想结束（典型症状：连写六章只写两章就问“要不要继续”），
        // 回填强指令让它接着执行下一条待办，最多拦截 4 次避免死循环
        const unfinishedTodos = todoItems.filter((item) => item.status === 'pending' || item.status === 'in_progress')
        const reportMinimum = taskSpec.intent === 'research_analysis'
          ? Math.max(0, ...taskSpec.expectedOutputs.filter(item => item.required).map(item => item.minimumChineseCharacters ?? 0)) : 0
        const report = taskSpec.intent === 'research_analysis' ? await (await import('./research-sources.js')).readResearchReportForDelivery({
          userId: params.userId, novelId: params.novelId, sessionId: params.sessionId, runId,
        }) : null
        const reportIncomplete = Boolean(report && report.chineseCharacters < reportMinimum)
        const reportReminder = reportIncomplete
          ? `\n本任务报告main已保存${report!.chineseCharacters}个汉字，要求至少${reportMinimum}个。先用research_report_read核对区块与revision，再用research_report_save只保存缺失或待修订区块；不得重写整份或凑字。来源读取失败时先核对搜索实际返回的URL、错误分类及页面真实链接，在既有预算内尝试可用来源，不编造地址、不重复请求已失败且未变化的来源。记录未取得的资料与受限原因，不能把简介或乱码当正文，也不能宣称已读全书；仅在确实需要用户提供信息时使用ask_user，不把上传小说作为排查404的前提。` : ''
        const nextChapterRequired = requiresNextChapterDelivery(taskSpec.goals)
        const chapterIncomplete = nextChapterRequired
          && !await (await import('./humanity-quality.js')).hasCommittedTaskChapter(prisma, params.userId, params.novelId, runId)
        if (toolRestrictions.length && !(nextChapterRequired && !chapterIncomplete) && !report?.content) {
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
          bus.emit({ type: 'step.finish', turn, usage: result.usage })
          forceWrapUpLocal = true
          await wrapUpAndFinish(`部分工具暂不可继续：${toolRestrictions.map(item => item.reason).filter((item, index, all) => all.indexOf(item) === index).join('；')}。`)
          return
        }
        const todoIncomplete = unfinishedTodos.length > 0 && !(nextChapterRequired && !chapterIncomplete && taskSpec.goals.length === 1)
        const otherPremature = chapterIncomplete || reportIncomplete || todoIncomplete || result.finishReason === 'length' || promisesFurtherAction(cleanContent) || (expectsPlanSave && !planSavePerformed)
        // A review denial already told the model to finish only authorized work
        // and report the remainder honestly. Afterwards a silent wrap-up is not
        // completion unless the requested next chapter is already committed.
        const reviewBlockedWrapUp = reviewHandoffCount > 0 && !(nextChapterRequired && !chapterIncomplete)
        const prematureFinish = otherPremature || reviewBlockedWrapUp
        if (reviewBlockedWrapUp && !otherPremature) {
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
          bus.emit({ type: 'step.finish', turn, usage: result.usage })
          await finalizeFailedWithNotice('本次修订已被安全检查停止，收尾不能当作任务完成；已保存的正文与报告保留，未判定检查通过。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
          return
        }
        if (prematureFinish && todoReminders < 4) {
          requireNativeToolCall = true
          todoReminders += 1
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
          bus.emit({ type: 'step.finish', turn, usage: result.usage })
          messages.push({
            role: 'user',
            content: `[系统] 当前回复尚不足以交付：仍有未完成待办、未落盘产出，或回复只说明了下一步动作/被截断。${chapterIncomplete ? '\n本任务要求写下一章，但本任务作用域内尚无完整正文及对应当前版本的章节终态。先用真实工具核对已有编译与正文：尚未建立则准备本章，已有则完成缺失步骤；不要重写已完成章节，不要引用历史工具记录冒充本次执行。' : ''}\n${renderTodoItems(unfinishedTodos)}${reportReminder}\n只在原授权范围内继续下一步，不重新规划已完成工作。有本任务既有清单时才更新真实完成进度；无清单且工作已完成时直接交付，不为结束任务补建空清单或已完成清单。无法完成的项保持未完成并说明阻塞，严禁假标 completed。需要作者决策时使用 ask_user。`,
          })
          continue
        }

        const savedPresentation = !prematureFinish && !report?.content ? await prisma.$transaction(tx => readSavedWritingPresentation(tx,
          { userId: params.userId, novelId: params.novelId, runId })) : null
        if (!prematureFinish && report?.content) {
          // Deliver the exact persisted report through the existing text UI;
          // a short model wrap-up cannot hide it or trigger paid regeneration.
          const evidence = report.evidence
          const evidenceNote = evidence && evidence.discoveredPages > 0
            ? `> 联网资料范围：发现 ${evidence.discoveredPages} 个来源，保存可读文章的来源 ${evidence.readablePages} 个，保存目录/简介的来源 ${evidence.metadataPages} 个，仍有读取失败记录的来源 ${evidence.failedSources} 个；报告引用 ${evidence.citedVersions} 个已保存页面版本。正文窗口按版本去重后共 ${evidence.providedCharacters ?? 0} 个 UTF-16 字符位置，表示工具已准备的内容范围，不等于已分析范围。各类来源可能重叠；这些数字不包含附件，不代表已读章节数或全书覆盖，未核实全书阅读完整性。\n\n` : ''
          const delivered = evidenceNote + humanizeAgentVisibleText(stripAgentProtocolArtifacts(report.content))
          for (let index = parts.length - 1; index >= 0; index -= 1) {
            if (parts[index].type === 'text') parts.splice(index, 1)
          }
          parts.push({ type: 'text', text: delivered })
          lastAssistantText = delivered
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
          bus.emit({ type: 'text.final', messageId, text: delivered, asReasoning: false })
        } else if (savedPresentation) {
          lastAssistantText = savedPresentation.text
        } else {
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
        }
        bus.emit({ type: 'step.finish', turn, usage: result.usage })
        await finalizeRun(runId, bus, prematureFinish ? 'failed' : 'succeeded', usage, turn, lastAssistantText.slice(0, 300), prematureFinish
          ? reviewBlockedWrapUp
            ? '修订被安全检查停止后连续多轮没有推进；已保存的正文与报告保留，未判定检查通过。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。'
            : '连续多轮没有推进剩余工作，已保存进度并安全停止；任务未完成。'
          : undefined,
          true, undefined, undefined, savedPresentation ? { messageId, subject: { userId: params.userId, novelId: params.novelId, runId }, expected: savedPresentation,
            signal: controller.signal, parts, replaceCandidate: true } : undefined)
        return
      }

      let reviewStopReason: string | undefined
      let batchProgress = false
      let compatibilityReadObserved = false
      for (let callIndex = 0; callIndex < effectiveToolCalls.length; callIndex += 1) {
        let call = effectiveToolCalls[callIndex]
        if (await finishPersistedWritingIfComplete(async () => {
          for (let index = parts.length - 1; index >= 0; index--) if (parts[index].type === 'text') parts.splice(index, 1)
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
          bus.emit({ type: 'text.final', messageId, text: '', asReasoning: false })
          liveTurn = null
        })) return
        if (controller.signal.aborted) {
          throw new DOMException('run aborted', 'AbortError')
        }
        const preflightTool = tools.find(tool => tool.name === call.name)
        const preflightArgs = reviewPreflightArgs(call, preflightTool)
        if (preflightTool && preflightArgs && preflightTool.parameters.safeParse(preflightArgs).success
          && call.name === 'chapter_bridge_commit') {
          const parsed = preflightArgs
          const compilationId = typeof parsed.compilationId === 'string' ? parsed.compilationId : undefined
          const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx,
            { userId: params.userId, novelId: params.novelId, runId }, compilationId))
          // Ordinary edits retain their original writing authority. Check the
          // final saved body at COMMIT, without discarding partial edits or
          // spending a fresh paid assessment between each fragment.
          if (readiness?.checksRequired) {
            const next = nextReviewDispatch(readiness, new Set(tools.map(tool => tool.name)), automaticReviewAttempts)
            if (next.kind === 'tool') {
              const required = { id: `review_${messageId}_${callIndex}_${randomUUID()}`, name: next.tool.name, arguments: JSON.stringify(next.tool.args) }
              effectiveToolCalls.splice(callIndex, 0, required)
              const note = '正在完成当前版本的必要检查，之后再核对修订与章节终态。'
              for (let index = parts.length - 1; index >= 0; index--) if (parts[index].type === 'text') parts.splice(index, 1)
              parts.push({ type: 'text', text: note })
              bus.emit({ type: 'text.final', messageId, text: note, asReasoning: false })
              call = required
            } else if (next.kind === 'blocked' || next.kind === 'limited') {
              const local = next.kind === 'limited' || readiness.requiredTools.some(item => findToolRestriction(toolRestrictions, item.name, item.args, readiness.chapterId))
              if (local) {
                restrictTool(call.name, parsed, 'REVIEW_DEPENDENCY_UNAVAILABLE', next.reason)
                messages.push({ role: 'tool', toolCallId: call.id, content: `[系统] ${next.reason} 此次未提交章节终态。继续本批其余可执行工作，不能声明检查通过。` })
                continue
              }
              forceWrapUpReason = next.reason
              forceWrapUpLocal = false
              break
            } else if (readiness?.ready && call.name === 'chapter_bridge_commit'
              && toolContext.sandboxMode !== 'read_only' && !toolContext.inlineChild
              && !toolContext.protectedChapterIds?.has(readiness.chapterId)
              && (readiness.continuityErrorCount > 0 || (readiness.qualityCandidateCount ?? 0) > 0)) {
              const available = new Set(tools.map(tool => tool.name))
              const channel = await prisma.$transaction(tx => probeChapterReviewRevision(tx,
                { userId: params.userId, novelId: params.novelId, runId }, { id: readiness.chapterId, revision: readiness.revision }))
              const key = nextMergedReviewReminder(readiness, available, automaticReviewAttempts, channel.open)
              const reader = tools.find(tool => tool.name === 'chapter_bridge_get')
              const readArgs = { compilationId: readiness.compilationId }
              if (key && reader?.readOnly && reader.parameters.safeParse(readArgs).success) {
                automaticReviewAttempts.add(key)
                await persistCheckpoint()
                const required = { id: `review_decision_${messageId}_${callIndex}`, name: reader.name, arguments: JSON.stringify(readArgs) }
                // An early commit is only a proposal. Read its current decision
                // state and ask for a new plan; never execute the stale remainder.
                effectiveToolCalls.splice(callIndex, effectiveToolCalls.length - callIndex, required)
                const note = '正在核对检查意见的处理结果，之后再提交章节终态。'
                for (let index = parts.length - 1; index >= 0; index--) if (parts[index].type === 'text') parts.splice(index, 1)
                parts.push({ type: 'text', text: note })
                bus.emit({ type: 'text.final', messageId, text: note, asReasoning: false })
                call = required
              }
            }
          }
        }
        const restricted = findToolRestriction(toolRestrictions, call.name,
          reviewPreflightArgs(call, tools.find(tool => tool.name === call.name)), getLastTouchedChapter(runId) ?? params.chapterId)
        if (restricted) {
          blockedRepeat += 1
          messages.push({ role: 'tool', toolCallId: call.id,
            content: restricted.inputHash ? `[系统] ${call.name} 的这组失败参数已停止重复提交，本次未执行。${restricted.reason}。根据具体错误纠正参数后，仍可在原授权及当前版本内继续；参数纠正不等于完成，不得扩大目标或预算。`
              : `[系统] 该目标的 ${call.name} 已因 ${restricted.code} 停止重复尝试，本次未执行、未产生新费用。原因：${restricted.reason}。继续其他已授权且不依赖此操作的工作；不要换工具绕过权限或把未完成项说成通过。` })
          continue
        }
        let reviewDispatch: PendingReviewCall | undefined
        if (STATE_SENSITIVE_VALIDATORS.has(call.name)) {
          const validator = tools.find(tool => tool.name === call.name)
          const args = reviewPreflightArgs(call, validator)
          const compilationId = args?.compilationId
          if (validator && args && validator.parameters.safeParse(args).success) {
            const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx,
              { userId: params.userId, novelId: params.novelId, runId }, typeof compilationId === 'string' ? compilationId : undefined))
            if (readiness && (typeof args.chapterId !== 'string' || args.chapterId === readiness.chapterId)) reviewDispatch = { compilationId: readiness.compilationId, chapterId: readiness.chapterId,
              revision: readiness.revision, toolName: call.name as PendingReviewCall['toolName'], callId: call.id }
            else if (typeof compilationId !== 'string') {
              const chapterId = typeof args.chapterId === 'string' ? args.chapterId : params.chapterId
              const chapter = chapterId ? await prisma.chapter.findFirst({ where: { id: chapterId, authorId: params.userId,
                ...activeChapterScope(params.novelId) }, select: { id: true, revision: true } }) : null
              if (chapter) reviewDispatch = { compilationId: null, chapterId: chapter.id, revision: chapter.revision,
                toolName: call.name as PendingReviewCall['toolName'], callId: call.id }
            }
          }
        }
        // Admit only fresh work. Cached calls never emit tool.call; repeated requests reuse
        // the previous observation. Four consecutive blocked calls trigger a bounded stop.
        const signature = toolSignature(call.name, call.arguments)
        const tool = tools.find(candidate => candidate.name === call.name)
        // Todo updates depend on their current snapshot; completion of newly-started
        // work must not be blocked by an identical call made against an older snapshot.
        const admissionSignature = reviewDispatch
          ? toolSignature(signature, JSON.stringify({ compilationId: reviewDispatch.compilationId, chapterId: reviewDispatch.chapterId, revision: reviewDispatch.revision }))
          : call.name === 'todo_write' ? toolSignature(signature, JSON.stringify(todoItems)) : signature
        const admissionKey = admission.key(admissionSignature, Boolean(tool?.readOnly) || STATE_SENSITIVE_VALIDATORS.has(call.name))
        const previousObservation = REPEATABLE_TOOLS.has(call.name) ? undefined : admission.previous(admissionKey)
        if (previousObservation !== undefined) {
          if (reviewDispatch) {
            // A stale prerequisite must not insert the same cached call forever.
            // Reuse is not a new current-version assessment; the next state read
            // must either be ready or stop under the persisted attempt bound.
            automaticReviewAttempts.add(`${reviewDispatch.compilationId}:${reviewDispatch.chapterId}:${reviewDispatch.revision}:${reviewDispatch.toolName}`)
          }
          blockedRepeat += 1
          const blockSummary = '相同状态下该工具与完整参数已成功执行，复用结果，未重复执行'
          // 产品口径：熔断拦截属服务端防空转保护，不是作者需要看到的「失败工具」——
          // 不发 tool.call/tool.result 事件、不落 part，会话与刷新后历史都不显示这张卡；
          // 模型侧仍通过 tool 消息收到换路提示，服务器日志保留可观测性。
          console.warn('[agent-loop] P0 重复签名熔断拦截：%s（tool=%s run=%s turn=%d）', blockSummary, call.name, runId, turn)
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: `[系统] 重复调用已拦截，本次没有执行。相同工具与参数在当前状态已成功执行，请使用以下既有结果推进下一项；不要重试未变化的目标。\n${previousObservation}`,
          })
          continue
        }
        if (reviewDispatch) {
          // Commit evidence BEFORE the handler can reserve/send a paid chain.
          // A crash leaves it pending across same-run and typed continuations.
          const attemptKey = `${reviewDispatch.compilationId}:${reviewDispatch.chapterId}:${reviewDispatch.revision}:${reviewDispatch.toolName}`
          const pendingKey = `${reviewDispatch.compilationId ?? reviewDispatch.chapterId}:${reviewDispatch.toolName}`
          const alreadyAttempted = automaticReviewAttempts.has(attemptKey)
          automaticReviewAttempts.add(attemptKey)
          pendingReviews.set(pendingKey, reviewDispatch)
          try { await persistCheckpoint() }
          catch (error) {
            // No handler has run, so this particular request was never sent.
            pendingReviews.delete(pendingKey)
            if (!alreadyAttempted) automaticReviewAttempts.delete(attemptKey)
            throw error
          }
        }
        const outcome = await handleToolCall(call, tools, { ...toolContext, callId: call.id, messageId }, bus, messageId, runId)
        if (reviewDispatch && (outcome.part.status === 'success' || ['AI_QUALITY_NON_THINKING_UNSUPPORTED', 'CONTINUITY_CHECK_LIMIT',
          'CONTINUITY_CHECK_BUDGET_EXCEEDED', 'QUALITY_REPORT_INCOMPLETE', 'QUALITY_EVIDENCE_UNLOCATED'].includes(outcome.failureCode ?? ''))) {
          pendingReviews.delete(`${reviewDispatch.compilationId ?? reviewDispatch.chapterId}:${reviewDispatch.toolName}`)
          await persistCheckpoint()
        }
        const localFailure = isLocalToolFailure(outcome.failureCode ?? outcome.recoveryCode)
        if (localFailure) {
          const code = outcome.failureCode ?? outcome.recoveryCode!
          restrictTool(call.name, outcome.part.args, code, outcome.observation)
          // Both public selectors address the same server-resolved assessment.
          // Retain both identities so switching chapterId/compilationId cannot
          // lose the local failure or dispatch another paid attempt.
          if (reviewDispatch) {
            restrictTool(call.name, { chapterId: reviewDispatch.chapterId }, code, outcome.observation)
            if (reviewDispatch.compilationId) restrictTool(call.name, { compilationId: reviewDispatch.compilationId }, code, outcome.observation)
          }
        }
        reviewStopReason = localFailure ? undefined : outcome.reviewStopReason ?? (taskSpec.intent === 'review'
          && outcome.recoveryCode === 'REVIEW_REPAIR_RECHECK_REQUIRED' ? outcome.observation : undefined)
        pendingSkillPhase = nextSkillPhase(call.name, outcome.part, taskSpec.intent, params.prompt) ?? pendingSkillPhase
        {
          if (outcome.part.status === 'success') toolProviderFailures.delete(call.name)
          else if (outcome.providerFailure && !localFailure) {
            const failures = (toolProviderFailures.get(call.name) ?? 0) + 1
            toolProviderFailures.set(call.name, failures)
            if (['AI_PROVIDER_QUOTA_EXCEEDED', 'AI_QUALITY_NON_THINKING_UNSUPPORTED', 'AI_PROVIDER_TRANSPORT', 'AI_PROVIDER_INCOMPLETE', 'AI_PROVIDER_TIMEOUT'].includes(outcome.providerFailureCode ?? '')) forceWrapUpReason = outcome.observation
            else if (outcome.providerFailureCode === 'AI_PROVIDER_OUTPUT_LIMIT') forceWrapUpReason = `${outcome.part.title}输出达到上限，检查未完成；已停止重复付费请求及后续提交。已保存内容与进度保留，不能将截断报告当作通过；需调整检查输出预算后再恢复。`
            else if (failures >= 2) forceWrapUpReason = `${outcome.part.title}连续两次模型响应失败，已停止重复请求。已保存内容与进度保留，该操作尚未完成；请稍后继续或检查模型服务。`
          }
        }
        if (outcome.part.status === 'success') argumentFailures.delete(call.name)
        else if (outcome.argumentFailure || ['参数解析失败', '参数校验失败', '参数归一化失败'].includes(outcome.part.summary ?? '')) {
          const failures = (argumentFailures.get(call.name) ?? 0) + 1
          argumentFailures.set(call.name, failures)
          if (failures >= 3) restrictTool(call.name, outcome.part.args, outcome.failureCode ?? 'INVALID_ARGUMENTS', '连续三次参数无效，该工具未完成；继续其他可执行工作。')
        }
        if (outcome.recoveryCode) {
          const key = toolRecoveryKey(call.name, outcome.recoveryCode, outcome.part.args, getLastTouchedChapter(runId) ?? params.chapterId)
          const failures = (recoveryFailures.get(key) ?? 0) + 1
          recoveryFailures.set(key, failures)
          if (failures >= 3) restrictTool(call.name, outcome.part.args, outcome.recoveryCode, `${outcome.part.title}在同一目标上三次遇到同一问题：${outcome.part.summary}。停止此工具链的无进展重试，继续其他可执行工作。`)
        }
        lastActivityAt = Date.now()
        // 滑窗更新：只记成功执行；失败不碰窗口（同签名重试不会被误杀）
        if (outcome.part.status === 'success') {
          const range = outcome.observedChapterRange
          if (compatibilityReadTargets && call.name === 'chapter_read' && range && compatibilityReadTargets.has(range.targetId)
            && /^[a-f0-9]{64}$/u.test(range.contentHash) && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
            && range.start >= 0 && range.end > range.start) compatibilityReadObserved = true
          const contentProgress = observeLegacyContentProgress(progressSignatures, outcome.part)
          const transition = outcome.semanticTransition
          const structureProgress = Boolean(transition && observeSemanticTransition(progressSignatures, `structure:${transition.targetId}`, transition.beforeHash, transition.afterHash))
          const durableProgress = contentProgress || structureProgress
          const requiredProgress = Boolean(outcome.requiredResult && observeRequiredResult(progressSignatures,
            `chapter:${outcome.requiredResult.targetId}`, outcome.requiredResult.contentHash))
          const readProgress = observeSemanticReadProgress(progressSignatures, call.name, outcome.observation, outcome.observedChapterRange)
          const workflowProgress = observeWritingWorkflowMilestone(progressSignatures, call.name, outcome.workflowMilestone,
            { userId: params.userId, novelId: params.novelId, runId, taskSpec })
          admission.record(admissionKey, outcome.observation, durableProgress || requiredProgress)
          if (durableProgress || requiredProgress || readProgress || workflowProgress) {
            batchProgress = true
            todoReminders = 0
            if (durableProgress || requiredProgress) recoveryFailures.clear()
            blockedRepeat = 0
            if (durableProgress || requiredProgress) writeProgressCount += 1
            if (readProgress) readProgressCount += 1
          }
        }
        if (call.name === 'plan_save' && outcome.part.status === 'success') {
          planSavePerformed = true
        }
        // 同步待办清单快照：防早停拦截与预算收尾都依赖它判断任务是否真的做完
        if (call.name === 'todo_write' && outcome.part.status === 'success' && outcome.part.display?.kind === 'todoList') {
          todoItems = outcome.part.display.items
        }
        if (STRUCTURE_MUTATION_TOOLS.has(call.name)) {
          if (outcome.part.status === 'success') {
            consecutiveStructureFailures = 0
          } else if (outcome.part.status === 'failed') {
            consecutiveStructureFailures += 1
            if (consecutiveStructureFailures >= STRUCTURE_FAILURE_LIMIT) {
              restrictTool(call.name, outcome.part.args, outcome.failureCode ?? 'STRUCTURE_RETRY_LIMIT', '结构操作连续失败，已隔离该目标的操作以免重复创建或错位；其他原授权工作可继续。')
            }
          }
        }
        if (call.name === 'ask_user' && outcome.part.status === 'success' && outcome.part.display?.kind === 'question'
          && !outcome.part.display.unanswered && outcome.part.display.answer && isExplicitAuthorEnd(outcome.part.display.answer, outcome.part.display.options)) {
          authorEndRequested = true
        }
        parts.push(outcome.part)
        // 子 Agent 内嵌执行产生的内部工具卡片随父消息一并直播与落库，刷新后仍可展开查看
        if (outcome.extraParts?.length) parts.push(...outcome.extraParts)
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.observation })
        if (forceWrapUpReason || authorEndRequested || reviewStopReason) {
          break
        }
      }

      // A circuit may skip the rest of a multi-call batch. Close the model protocol for
      // every unexecuted call before any wrap-up request; do not invent execution cards.
      for (const call of effectiveToolCalls) {
        if (!messages.some(message => message.role === 'tool' && message.toolCallId === call.id)) {
          messages.push({ role: 'tool', toolCallId: call.id, content: '[系统] 本轮安全保护已停止该调用，未执行。' })
        }
      }
      await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
      await persistCheckpoint()
      bus.emit({ type: 'step.finish', turn, usage: result.usage })

      // Finish the current batch first. A confirmed format-only assessment
      // limitation needs no paid model turn to rediscover the same blocked
      // COMMIT; the server proof still checks all independent obligations.
      if (!forceWrapUpReason && !authorEndRequested && !reviewStopReason
        && toolRestrictions.some(item => item.action === 'quality_analyze' && item.code === 'QUALITY_REPORT_INCOMPLETE')
        && await finishLimitedWritingIfAllowed()) return

      if (reviewStopReason) {
        // A review denial is never reported as a passed review, but a single
        // denial must not swallow a writing task either. An explicitly
        // requested review without its report ends immediately; a writing task
        // gets bounded safe-wrap-up steps to finish authorized work and then
        // ends with an explicit exit the author can act on.
        if (taskSpec.intent !== 'write') {
          await finalizeFailedWithNotice(`请求的检查或修订尚未完成：${reviewStopReason} 已保存的正文与报告保留；未将工具拒绝当作检查通过或任务完成。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。`)
          return
        }
        reviewHandoffCount += 1
        await persistCheckpoint()
        if (reviewHandoffCount <= 3) {
          messages.push({ role: 'user', content: `[系统] 本次检查或改稿工具未执行（安全收尾第 ${reviewHandoffCount}/3 次），具体原因：${reviewStopReason}\n正文仍保留，工具拒绝不等于整项任务失败，也不能宣称检查通过。禁止重试该改稿、换工具绕过或继续逐句修订；警告/旧意见不授予改稿权限。仅核对已保存进度，完成原请求内尚可执行的读取、场景状态与章节终态提交。只有实际提交成功才交付；仍被次数边界挡住时如实汇报剩余意见与阻塞原因，不再重复尝试本类改稿。` })
          continue
        }
        await finalizeFailedWithNotice(`本次工具未执行：${reviewStopReason} 已保存的正文与报告保留。连续安全收尾仍未完成授权范围内的任务；未重置次数或绕过限制，也未判定检查通过。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。`)
        return
      }

      if (authorEndRequested) {
        // This control decision comes only from the actual authenticated answer,
        // never from model prose, a todo completion claim or a historical reply.
        todoItems = await cancelTaskTodoItems(params.sessionId, await getTaskRunIds(params.sessionId, runId), '作者明确要求结束，剩余工作不再执行')
        const chapterRequired = requiresNextChapterDelivery(taskSpec.goals)
        const reportRequired = taskSpec.intent === 'research_analysis'
        const report = reportRequired ? await (await import('./research-sources.js')).readResearchReportForDelivery({
          userId: params.userId, novelId: params.novelId, sessionId: params.sessionId, runId,
        }) : null
        const reportMinimum = Math.max(0, ...taskSpec.expectedOutputs.filter(item => item.required).map(item => item.minimumChineseCharacters ?? 0))
        const fulfilled = chapterRequired
          ? await (await import('./humanity-quality.js')).hasCommittedTaskChapter(prisma, params.userId, params.novelId, runId)
          : reportRequired ? Boolean(report?.content && report.chineseCharacters >= reportMinimum)
            : expectsPlanSave && planSavePerformed
        const notice = fulfilled
          ? '本任务成果已保存并核验。已按作者要求结束，剩余待办不再执行，未将其标为完成。'
          : '已按作者要求结束，保留已保存内容。剩余工作不再执行，未将未完成成果标为完成。'
        const endMessageId = randomUUID()
        bus.emit({ type: 'message.start', messageId: endMessageId, role: 'assistant' })
        bus.emit({ type: 'text.final', messageId: endMessageId, text: notice, asReasoning: false })
        await persistMessage(endMessageId, runId, params.sessionId, 'assistant', [{ type: 'text', text: notice }])
        await finalizeRun(runId, bus, fulfilled ? 'succeeded' : 'cancelled', usage, turn, notice, undefined, true, undefined, { fulfilled, todoItems })
        return
      }

      const waitingForChild = effectiveToolCalls.some(call => ['task_wait', 'task_get', 'task_list'].includes(call.name))
        && await prisma.agentRun.count({ where: { userId: params.userId, novelId: params.novelId, OR: [{ session: { spawnedFromRunId: runId } }, { incomingChildGrant: { currentParentRunId: runId } }],
          status: { in: ['queued', 'running', 'awaiting_approval'] } } }) > 0
      stagnantBatches = nextStagnantBatch(stagnantBatches, batchProgress, waitingForChild)
      const compatibilityRead = compatibilityReadTargets !== null && compatibilityReadObserved
      compatibilityReadTargets = null
      if (compatibilityRead && !batchProgress) messages.push({ role: 'user', content: '[系统] 已核对旧定位失败目标的真实正文。输入协议兼容读取机会已持久记账，仅此一次；历史失败、检查次数和预算保留。下一步按当前正文纠正具体定位参数并执行原目标内修订，不要重复读取或照原失败参数重试。' })
      if (!forceWrapUpReason && (blockedRepeat >= 4 || stagnantBatches >= 4 && !compatibilityRead)) {
        forceWrapUpReason = '连续多轮没有推进原任务的内容或必需成果，已停止重复执行，进度保留。'
        forceWrapUpLocal = toolRestrictions.length > 0
      }

      // P0/P1 熔断收尾：结构熔断优先级更高（上方已 return），这里处理重复签名第 4 次/复读二次命中
      if (forceWrapUpReason) {
        const reason = forceWrapUpReason
        forceWrapUpReason = null
        await wrapUpAndFinish(reason)
        return
      }

    }

  } catch (error) {
    await (await import('./goal-service.js')).noteGoalResourceFailure(params.userId, runId, error).catch(() => {
      console.error('[agent-goal] 资源限制状态待恢复', { runId })
    })
    if (error instanceof DataAccessError && error.code === 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED') {
      // Admission did not succeed. In particular a rejected resume must not
      // overwrite another execution's status via the budget-restoration branch.
      bus.emit({ type: 'error', code: error.code.toLowerCase(), message: error.message, recoverable: false })
      deregisterActiveRun(runId)
      try { await disposeRunEventBus(runId) } catch { console.error('[agent-loop] 准入拒绝通知仍待持久化', { runId }) }
      return
    }
    if (!checkpointRestored) {
      // Never replace an unreadable saved budget with the zero-initialized local state.
      await prisma.agentRun.update({
        where: { id: runId, userId: params.userId, runtimeProtocolVersion: 0, taskRootId: null },
        data: { status: 'paused', errorMessage: '运行预算记录尚未核实，原记录保留。' },
      }).catch(() => {})
      bus.emit({ type: 'error', code: 'run_checkpoint_unconfirmed', recoverable: false,
        message: '运行预算记录尚未核实，已停止续跑并保留原记录。' })
      deregisterActiveRun(runId)
      try { await disposeRunEventBus(runId) } catch { console.error('[agent-loop] 预算核实通知仍待持久化', { runId }) }
      return
    }
    if (error instanceof DataAccessError && (error.code.startsWith('TASK_AUTHORIZATION_')
      || error.code === 'RUN_INPUT_REQUIRED' || error.code === 'RUN_INPUT_MISMATCH')) {
      bus.emit({ type: 'error', code: error.code.toLowerCase(), message: error.message, recoverable: false })
      // Admission failure must not compact/update world memory as a side effect of finalization.
      await finalizeRun(runId, bus, 'failed', usage, turn, '', error.message, false)
      return
    }
    if (isAbortError(error) || controller.signal.aborted) {
      // 先补落库进行中的轮次再收尾：否则刷新后作者会丢掉被停止那一轮的全部内容
      await flushLiveTurn()
      await finalizeRun(runId, bus, 'paused', usage, turn, '已被用户停止，可随时继续。')
      return
    }

    if (error instanceof DataAccessError && error.code.startsWith('CREDITS_')) {
      const messageId = randomUUID()
      const message = error.code === 'CREDITS_EXHAUSTED'
        ? '今日创作额度已用尽，任务已安全停止。邀请好友注册可获得额外额度。'
        : error.message
      bus.emit({ type: 'message.start', messageId, role: 'assistant' })
      bus.emit({ type: 'text.delta', messageId, delta: message })
      bus.emit({ type: 'text.final', messageId, text: message, asReasoning: false })
      await persistMessage(messageId, runId, params.sessionId, 'assistant', [{ type: 'text', text: message }])
      bus.emit({ type: 'error', code: error.code.toLowerCase(), message, recoverable: false })
      await flushLiveTurn()
      await finalizeRun(runId, bus, 'failed', usage, turn, message, message)
      return
    }
    if (error instanceof DataAccessError && ['AI_PROVIDER_QUOTA_EXCEEDED', 'REVIEW_PROVIDER_OUTCOME_UNCONFIRMED'].includes(error.code)) {
      await flushLiveTurn()
      // Supplier quota cannot be resolved by another billed summary or a
      // transient-limit retry. Finalize once with the original usage intact.
      await finalizeRun(runId, bus, 'failed', usage, turn, '', error.message, false, undefined, undefined, undefined, true)
      return
    }

    const message = error instanceof DataAccessError ? error.message : '任务执行遇到内部异常，已停止后续操作；已保存内容保留，请核对状态后再继续。'
    console.error('[agent-loop] run 执行异常', runId, error)
    await flushLiveTurn()
    await finalizeFailedWithNotice(message)
  }
}
