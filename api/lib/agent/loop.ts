import { randomUUID } from 'node:crypto'

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
import { getModelTierRuntime } from '../credits.js'
import { readManagedImageDataUrl } from '../agent-attachment-storage.js'
import { applySessionToolPolicy, getAgentDefinition, getToolsForAgent, type AgentDefinition } from './agents.js'
import { deregisterActiveRun, registerActiveRun } from './active-runs.js'
import { clearRunBaselines } from './baseline.js'
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
import { createEmptyResponseGuard, createProtocolRecoveryGuard, hasDurableProgress, hasReadProgress, isContinuationRequest, isExplicitAuthorEnd, hasAuthorEnded, promisesFurtherAction, requiresNextChapterDelivery } from './completion-guard.js'
import { toolFailureRecovery } from './tool-failure-recovery.js'
import { createRepeatDetector } from './repeat-detect.js'
import {
  CHECKPOINT_BUDGET_SLICE,
  CHECKPOINT_MANUAL_RESUME_HARD_MAX,
  CHECKPOINT_MAX_RESUMES,
  CHECKPOINT_TURN_SLICE,
  evaluateCheckpoint,
  resolveManualResumeGrant,
  resolveRunTokenBudget,
  savedRunUsageSchema,
  recoverLegacyRunUsage,
  recoverRunElapsedMs,
  type RunCheckpointState,
} from './checkpoint.js'
import { autoNameSession } from './session-title.js'
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
} from './context-budget.js'

/**
 * Agent Loop 执行内核（plan/13 §4.3）。
 * while 循环：LLM → tool_calls → 执行 → tool 消息回填 → 再 LLM，直到 finishReason !== 'tool_calls'。
 * - 错误即观察：工具失败不中断 run，错误信息回填给模型自愈
 * - 审批暂停-恢复：'ask' 工具挂起循环等待前端批复，超时视为拒绝
 * - maxTurns + token 预算双保险防失控计费
 * 进行中 run 的登记表（activeRuns Map 及查询/停止函数）已拆至 active-runs.ts。
 */

export type ExecuteAgentRunParams = {
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

/** 瘦身时保留最近 N 条工具输出不动：近期结果是当前决策的主要依据 */
const CONTEXT_SLIM_KEEP_RECENT_TOOL_OUTPUTS = 8

type ToolCallOutcome = {
  providerFailure?: boolean
  providerFailureCode?: string
  recoveryCode?: string
  argumentFailure?: boolean
  observation: string
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

  const fail = (summary: string, observation: string, status: 'failed' | 'denied'): ToolCallOutcome => {
    bus.emit({
      type: 'tool.result',
      messageId,
      callId: call.id,
      toolName: call.name,
      ok: false,
      summary,
      durationMs: Date.now() - startedAt,
      ...subagentMark,
    })
    return { observation, part: { ...basePart, args: parsedArgs, status, summary } }
  }

  const permission = tool.permission[ctx.mode]

  if (coercionFailed) {
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
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；')
    // 附带当前章节 ID：缺 chapterId 是最高发的校验失败，直接喂给模型避免它盲猜或多耗一轮去查
    const chapterHint = ctx.chapterId ? `作者当前正在编辑的章节 chapterId=${ctx.chapterId}。` : ''
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

    const decision = await waitForApproval(runId, call.id, tool.name, env.agentApprovalTimeoutMs, ctx.signal)
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
    const result = await tool.execute(ctx, validated.data)
    if (result.outcome === 'failed') return fail(result.summary ?? '执行未完成', wrapToolOutput(tool.name, result.output), 'failed')
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
      const label = error.code === 'AI_PROVIDER_TIMEOUT' ? '模型网关超时'
        : error.code === 'AI_PROVIDER_OUTPUT_LIMIT' ? '模型输出达到上限，检查未完成'
        : error.code === 'AI_PROVIDER_INCOMPLETE' ? '模型输出中断，检查未完成'
        : error.code === 'AI_PROVIDER_INVALID_RESPONSE' ? '模型响应格式异常' : '模型服务异常'
      console.warn('[agent-tool-provider]', { runId, tool: call.name, code: error.code, durationMs: Date.now() - startedAt })
      const guidance = error.code === 'AI_PROVIDER_OUTPUT_LIMIT'
        ? '输出预算已达上限，不要原样重复付费调用；保留进度并报告检查未完成，不能将截断报告当作通过。'
        : '最多重试一次，仍失败则保留进度并报告阻塞。'
      return { ...fail(label, `工具 ${call.name} 未完成：${label}（${error.code}）。这是模型响应故障，不是正文质量结论；不要修改正文或重建编译来绕过。${guidance}`, 'failed'), providerFailure: true, providerFailureCode: error.code }
    }
    console.warn('[agent-tool-failure]', { runId, tool: call.name, code: error instanceof DataAccessError ? error.code : 'UNEXPECTED_TOOL_ERROR', durationMs: Date.now() - startedAt })
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
) {
  // 事件协议用 succeeded，DB 枚举用 completed
  const dbStatus = status === 'succeeded' ? 'completed' : status

  const terminalBody = status === 'paused'
    ? { type: 'run.paused' as const, reason: 'user_stop' as const }
    : { type: 'run.finished' as const, status, usage, artifacts: [], outputSummary, ...(authorEnded ? { authorEnded } : {}) }
  const committed = await bus.commitTerminal(terminalBody, tx => tx.agentRun.update({
      where: { id: runId, runtimeProtocolVersion: 0, taskRootId: null },
      data: {
        status: dbStatus,
        outputSummary: outputSummary || null,
        errorMessage: errorMessage ?? null,
        usage: { ...usage, ...(checkpoint ? { checkpoint } : {}), ...(authorEnded ? { authorEnded: { fulfilled: authorEnded.fulfilled, ...(authorEnded.todoItems ? { todoItems: authorEnded.todoItems.map(item => ({ ...item })) } : {}) } } : {}) },
        currentTurn,
        finishedAt: status === 'paused' ? null : new Date(),
      },
      select: { userId: true, sessionId: true, novelId: true, taskSpec: true },
    }))
    .catch(() => {
      console.error('[agent-loop] run 状态落库未确认', { runId, requestedStatus: dbStatus })
      return null
    })
  const finalizedRun = committed?.result

  if (status !== 'paused' && finalizedRun && allowContextSideEffects) {
    await Promise.all([
      compactSessionContext(finalizedRun.userId, finalizedRun.sessionId, false).catch((error) => {
        console.error('[agent-loop] 对话结束后自动整理上下文失败', runId, error)
      }),
      taskSpecSchema.safeParse(finalizedRun.taskSpec).data?.intent === 'research_analysis' ? Promise.resolve() : syncNovelMemoryProjection(finalizedRun.userId, finalizedRun.novelId).catch((error) => {
        console.error('[agent-loop] 对话结束后自动更新作品记忆失败', runId, error)
      }),
    ])
  }

  if (!finalizedRun) {
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
  const executionElapsedMs = () => priorExecutionMs + Math.max(0, Date.now() - executionStartedAt)
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
  const argumentFailures = new Map<string, number>()
  const toolProviderFailures = new Map<string, number>()
  const recoveryFailures = new Map<string, number>()
  // 非空时本轮工具执行完立即走 wrap-up（P0 第 4 次同签名 / P1 干预模式二次命中）
  let forceWrapUpReason: string | null = null
  // P1 信道重复检测：正文+思考共用一个检测器，观察/干预由 env.agentRepeatGuardMode 决定
  const repeatDetector = createRepeatDetector()
  let repeatReminderSent = false
  // P4 检查点自动续跑状态
  let resumeCount = 0
  let compactionCount = 0
  // 手动续跑（作者显式点击「继续」）在自动硬顶之上再授予的预算片计数；持久化在 checkpoint 里
  let manualResumeCount = 0
  let writeProgressCount = 0
  let checkpointWriteBaseline = 0
  let readProgressCount = 0
  let checkpointReadBaseline = 0
  let inheritedTokens = 0
  let inheritedTurns = 0
  const taskTokens = () => usage.totalTokens + inheritedTokens
  let maxTurns = env.agentMaxTurns
  let runTokenBudget = resolveRunTokenBudget(params.tokenBudget, env.agentRunTokenBudget, env.agentRunTokenBudgetCeiling)
  // 手动续跑名额：自动续跑在总硬顶上严格停止，作者显式「继续」可在硬顶之上再授予有限片。
  const manualResumeMax = Math.min(env.agentRunManualResumeMax, CHECKPOINT_MANUAL_RESUME_HARD_MAX)
  let checkpointRestored = !params.resume
  const restoreSavedUsage = async (stored: { usage: unknown; currentTurn: number }, id: string) => {
    if (stored.usage !== null) return savedRunUsageSchema.safeParse(stored.usage)
    const receipts = await prisma.aiUsageLog.findMany({
      where: { userId: params.userId, targetType: 'agentRun', targetId: id },
      select: { turn: true, requestTokens: true, responseTokens: true },
    })
    return savedRunUsageSchema.safeParse(recoverLegacyRunUsage(stored.currentTurn, receipts))
  }
  const checkpointSnapshot = (): RunCheckpointState => ({
    version: 1, runStartedAt, resumeCount, compactionCount, maxTurns, tokenBudget: runTokenBudget,
    writeProgress: writeProgressCount, writeBaseline: checkpointWriteBaseline,
    readProgress: readProgressCount, readBaseline: checkpointReadBaseline,
    progressSignatures: [...progressSignatures],
    inheritedTokens, inheritedTurns, inheritedExecutionMs, manualResumeCount,
  })
  const persistCheckpoint = () => prisma.agentRun.update({
    where: { id: runId, userId: params.userId, runtimeProtocolVersion: 0, taskRootId: null },
    data: { currentTurn: turn, usage: { ...usage, checkpoint: checkpointSnapshot() } },
  })
  const finalizeRun = (...args: Parameters<typeof finalizeLegacyRun>) => {
    args[8] = checkpointSnapshot()
    return finalizeLegacyRun(...args)
  }
  const restoreCheckpointLimits = (checkpoint: RunCheckpointState) => {
    runStartedAt = Math.min(runStartedAt, checkpoint.runStartedAt)
    resumeCount = checkpoint.resumeCount
    compactionCount = checkpoint.compactionCount
    manualResumeCount = checkpoint.manualResumeCount
    maxTurns = Math.min(checkpoint.maxTurns, env.agentMaxTurns + (resumeCount + manualResumeCount) * CHECKPOINT_TURN_SLICE)
    // 手动续跑获得的片在自动硬顶之上，恢复时不会超过已经授予过的总额度。
    // The granted slice starts at actual consumption (which may overshoot the
    // automatic ceiling by one response). Preserve that persisted grant exactly;
    // clamping to ceiling + slices silently removes part of an approved slice.
    runTokenBudget = manualResumeCount > 0 ? checkpoint.tokenBudget
      : Math.min(checkpoint.tokenBudget, env.agentRunTokenBudgetCeiling)
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
    const storedRun = await startLegacyRuntimeRun(params.userId, runId, Boolean(params.resume))
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
    const modelRuntime = await getModelTierRuntime(params.modelTier ?? 'speed', params.userId, params.customModelId, params.reasoningEffort)
    const runtimeModelName = modelRuntime.modelName ?? agent.model
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
      const admitted = await prisma.agentMessage.findFirst({ where: { id: userMessageId, runId, sessionId: params.sessionId, role: 'user' }, select: { parts: true } })
      const { runtimeJson } = await import('./runtime-common.js')
      if (params.resume || !admitted || runtimeJson(admitted.parts).hash !== runtimeJson(JSON.parse(JSON.stringify(userParts))).hash) {
        throw new DataAccessError(409, 'RUN_INPUT_MISMATCH', '原始请求与已保存消息不一致，不能覆盖或猜测任务。')
      }
    } else if (!params.resume) await persistMessage(userMessageId, runId, params.sessionId, 'user', userParts)

    const continuingTask = Boolean(params.resume) || isContinuationRequest(params.prompt)
    // Typed “continue” starts a new run but must retain the original task scope/constraints.
    const previousTask = !params.resume && continuingTask && !storedRun.taskSpec
      ? await prisma.agentRun.findFirst({ where: { sessionId: params.sessionId, userId: params.userId, novelId: params.novelId, id: { not: runId }, engine: 'loop' }, orderBy: { createdAt: 'desc' }, select: { id: true, taskSpec: true, taskRootId: true, runtimeProtocolVersion: true, usage: true, currentTurn: true, startedAt: true } })
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
        where: { sessionId: params.sessionId, userId: params.userId, novelId: params.novelId,
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
      const preceding = await prisma.agentRun.findMany({ where: { userId: params.userId, sessionId: params.sessionId,
        novelId: params.novelId, id: { not: runId }, taskSpec: { path: ['id'], equals: parsedTaskSpec.data.id } },
        select: { startedAt: true, currentTurn: true, events: { where: { type: { in: ['run.started', 'run.paused', 'run.finished'] } },
          orderBy: { seq: 'asc' }, select: { type: true, createdAt: true } } } })
      const elapsed = preceding.reduce((total, previous) => total + recoverExecution(previous, executionStartedAt), 0)
      priorExecutionMs += Math.max(0, elapsed - inheritedExecutionMs)
      inheritedExecutionMs = Math.max(elapsed, inheritedExecutionMs)
    }
    const initialTimeLimitMs = (resumeCount > 0 ? env.agentRunWallClockLongMinutes : env.agentRunWallClockMinutes) * 60_000
    if (executionElapsedMs() > initialTimeLimitMs) {
      const reason = `任务累计执行时长已达上限（${Math.round(initialTimeLimitMs / 60_000)} 分钟，已排除有记录的暂停等待时间）。已保存内容保留；重复点击继续不会增加时间预算。`
      await finalizeRun(runId, bus, 'failed', usage, turn, reason, reason, false)
      return
    }
    // 手动续跑（作者显式点击「继续」或输入继续指令）：自动检查点续跑受总 token 硬顶约束，
    // 但显式人工入口允许在硬顶之上再授予有限数量的预算片（plan/18「继续执行」手动入口），
    // 避免任务被自动硬顶永久死锁；片数上限持久化在 checkpoint 里，连点不能无限放大成本。
    if (params.resume || previousTask) {
      const grant = resolveManualResumeGrant({
        taskTokens: taskTokens(), runTokenBudget,
        turnsUsed: turn + inheritedTurns, maxTurns,
        manualResumeCount, maxManualResumes: manualResumeMax,
      })
      if (grant && !grant.granted) {
        const reason = `${grant.reason}。本任务累计消耗 ${taskTokens()} tokens（自动续跑总上限 ${env.agentRunTokenBudgetCeiling}）。已保存内容保留，未完成工作不会标记完成；请新建任务继续剩余工作。`
        await announceStopReason(reason)
        await finalizeRun(runId, bus, 'failed', usage, turn, reason, reason, false)
        return
      }
      if (grant?.granted) {
        manualResumeCount = grant.manualResumeCount
        runTokenBudget = grant.tokenBudget
        maxTurns = grant.maxTurns
        await announceStopReason(`手动续跑 ${manualResumeCount}/${manualResumeMax} · 累计消耗 ${(taskTokens() / 10_000).toFixed(0)} 万 tokens · 已授予新预算片（200 万） · 继续执行中`)
      }
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
    let taskSpecChanged = !parsedTaskSpec.success || Boolean(previousTask)
    if (params.resume || previousTask) {
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
    if (taskSpecChanged) {
      // Scope and inherited budget must become durable together, including if
      // execution is stopped before its first provider response.
      await prisma.agentRun.update({ where: { id: runId }, data: {
        taskSpec: taskSpec as unknown as object, usage: { ...usage, checkpoint: checkpointSnapshot() },
      } })
    } else await persistCheckpoint()
    if (!params.resume && taskSpec.intent !== 'research_analysis') {
      await captureUserDirectives({
        userId: params.userId,
        novelId: params.novelId,
        sessionId: params.sessionId,
        chapterId: params.chapterId,
        sourceMessageId: userMessageId,
        taskSpec,
        prompt: params.prompt,
      })
    }
    // 仅压缩已终态的旧 run；当前正在执行的消息永不进入检查点。
    await compactSessionContext(params.userId, params.sessionId, false).catch((error) => {
      console.error('[agent-loop] 自动上下文压缩失败，继续使用无损近期历史', runId, error)
    })

    // 首次对话且仍是默认标题时异步自动命名（仅一次，不阻塞循环）
    if (!params.resume) {
      void autoNameSession({
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
    const scopedTools = restrictToolsToTask(getToolsForAgent(agent, params.mode, featureFlags), taskSpec)
    // 派生窗口禁用跨任务编排：否则 b 再派生 e、e 再派生 f 会指数级打爆并发与额度，
    // 而且互相等待还会直接死锁；派生窗口的职责就是干完自己那一份并交回摘要
    const orchestrationScopedTools = sessionPolicy?.spawnedFromSessionId
      ? scopedTools.filter((tool) => !ORCHESTRATION_TOOL_NAMES.has(tool.name))
      : scopedTools
    const tools = applySessionToolPolicy(
      orchestrationScopedTools,
      params.mode,
      sessionPolicy?.toolPolicy,
      sessionPolicy?.sandboxMode === 'read_only' || sessionPolicy?.sandboxMode === 'full_access' ? sessionPolicy.sandboxMode : 'workspace',
    )
    const openAITools = toOpenAITools(tools)
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
        const firstStage = compactEarlyToolPayloads(messages, CONTEXT_SLIM_KEEP_RECENT_TOOL_OUTPUTS)
        compactedToolArguments += firstStage.compactedToolArguments
        compactedToolOutputs += firstStage.compactedToolOutputs
        collapsedToolRounds += firstStage.collapsedToolRounds
        afterTokens = firstStage.afterTokens + toolDefinitionTokens
      }
      if (afterTokens > contextBudget.hardRequestTokens) {
        const secondStage = collapseEarlyToolRounds(messages, CONTEXT_SLIM_KEEP_RECENT_TOOL_OUTPUTS)
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
      // 子 Agent 跟随主 run 的模型与额度计费：custom 档直接消耗用户自己的 token，内置档按倍率扣 credits
      modelRuntime,
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

    /** 统一收尾（plan/18）：预算耗尽/墙钟/空转/熔断都走这里——先让模型无工具总结进展，再按待办剩余定终态 */
    const wrapUpAndFinish = async (reasonText: string): Promise<void> => {
      const wrapMessageId = randomUUID()
      bus.emit({ type: 'message.start', messageId: wrapMessageId, role: 'assistant' })
      const wrapStreamer = createVisibleTextStreamer()
      messages.push({
        role: 'user',
        content: `[系统] ${reasonText}请立即停止调用工具，用一段话总结目前的进展与剩余工作。`,
      })
      const wrapBudget = prepareContextForRequest([], 'wrap-up')
      if (!wrapBudget.fits || taskTokens() >= runTokenBudget) {
        const fallbackText = `${reasonText}系统已停止继续请求，未把剩余工作标为完成。已完成的写入均已保存；可点击「继续执行」恢复剩余工作。`
        bus.emit({ type: 'text.delta', messageId: wrapMessageId, delta: fallbackText })
        bus.emit({ type: 'text.final', messageId: wrapMessageId, text: fallbackText, asReasoning: false })
        await persistMessage(wrapMessageId, runId, params.sessionId, 'assistant', [{ type: 'text', text: fallbackText }])
        await finalizeRun(runId, bus, 'failed', usage, turn, fallbackText.slice(0, 300), fallbackText)
        return
      }
      const observeWrapUsage = trackRequestUsage(usage)
      const wrapUp = await chatWithTools({
        onUsage: observeWrapUsage,
        messages,
        tools: [],
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
            const wrapUpIncrement = wrapStreamer.push(chunk.delta)
            if (wrapUpIncrement) bus.emit({ type: 'text.delta', messageId: wrapMessageId, delta: wrapUpIncrement })
          }
        },
        signal: controller.signal,
        usageLog: {
          userId: params.userId,
          action: 'agentLoopWrapUp',
          novelId: params.novelId,
          chapterId: params.chapterId,
          targetType: 'agentRun',
          targetId: runId,
          agentRunId: runId,
          turn: null,
          modelTier: modelRuntime.tier,
          multiplierBps: modelRuntime.multiplierBps,
        },
      })
      observeWrapUsage(wrapUp.usage)
      const cleanWrapUp = humanizeAgentVisibleText(stripAgentProtocolArtifacts(wrapUp.content))
      // 无论是否有干净文本都发 text.final：前端据此停掉收尾正文尾部的流式光标
      bus.emit({ type: 'text.final', messageId: wrapMessageId, text: cleanWrapUp, asReasoning: false })
      if (cleanWrapUp) {
        await persistMessage(wrapMessageId, runId, params.sessionId, 'assistant', [
          { type: 'text', text: cleanWrapUp },
        ])
      }
      // 待办未完成时以 failed 收尾：前端据此展示「继续执行」按钮，一键接着跑完剩余待办
      const todoLeft = todoItems.filter((item) => item.status === 'pending' || item.status === 'in_progress').length
      if (todoLeft > 0) {
        await finalizeRun(
          runId,
          bus,
          'failed',
          usage,
          turn,
          cleanWrapUp.slice(0, 300),
          `${reasonText}待办还剩 ${todoLeft} 项未完成。点击「继续执行」让 Agent 接着跑完。`,
        )
        return
      }
      await finalizeRun(runId, bus, 'failed', usage, turn, cleanWrapUp.slice(0, 300), reasonText)
    }

    /** 29 R08：未结束且有新写入/读取证据时才刷新预算片；保留次数、时间和总量硬顶。 */
    let checkpointDeniedReason = ''
    const checkpointStopMessage = () => {
      const base = `自动检查点未续跑：${checkpointDeniedReason || '运行预算边界未满足'}。任务累计消耗 ${taskTokens()} tokens（自动续跑总上限 ${env.agentRunTokenBudgetCeiling}）；已自动续跑 ${resumeCount} 次、手动续跑 ${manualResumeCount}/${manualResumeMax} 次。已保存内容保留，未完成工作不会标记完成。`
      if (checkpointDeniedReason === '已达长任务墙钟总帽') return `${base}任务累计执行时长已达上限，重复点击继续不会增加时间预算。`
      const remainingManual = Math.max(0, manualResumeMax - manualResumeCount)
      return remainingManual > 0
        ? `${base}点击「继续执行」可手动再授予一片 200 万 tokens 预算（本任务还剩 ${remainingManual} 次手动续跑机会）。`
        : `${base}本任务的自动与手动续跑机会均已用尽，请新建任务继续剩余工作。`
    }
    const tryCheckpointResume = async (trigger: 'budget' | 'turns'): Promise<boolean> => {
      const checkpoint = evaluateCheckpoint({
        todoLeft: todoItems.filter((item) => item.status === 'pending' || item.status === 'in_progress').length,
        // Every accepted terminal response returns before reaching this boundary.
        // A missing/completed checklist is not proof that pending tool work is done.
        taskPending: true,
        writeProgress: writeProgressCount,
        writeBaseline: checkpointWriteBaseline,
        readProgress: readProgressCount,
        readBaseline: checkpointReadBaseline,
        resumeCount,
        compactionCount,
        elapsedMs: executionElapsedMs(),
        longWallClockLimitMs: env.agentRunWallClockLongMinutes * 60_000,
        usedTokens: taskTokens(),
        tokenCeiling: env.agentRunTokenBudgetCeiling,
      })
      if (!checkpoint.ok) {
        checkpointDeniedReason = checkpoint.reason
        console.warn('[agent-checkpoint-denied]', JSON.stringify({ runId, trigger, reason: checkpoint.reason,
          usedTokens: taskTokens(), sliceLimit: runTokenBudget, tokenCeiling: env.agentRunTokenBudgetCeiling,
          resumeCount, compactionCount, writeProgressCount, checkpointWriteBaseline, readProgressCount, checkpointReadBaseline }))
        return false
      }
      resumeCount += 1
      compactionCount += 1
      checkpointWriteBaseline = writeProgressCount
      checkpointReadBaseline = readProgressCount
      runTokenBudget = Math.min(env.agentRunTokenBudgetCeiling, runTokenBudget + CHECKPOINT_BUDGET_SLICE)
      maxTurns += CHECKPOINT_TURN_SLICE
      await persistCheckpoint()
      // compaction：先压缩久远工具参数与输出；下一轮发送前再按真实 token 预算判断是否需要折叠完整工具轮。
      compactEarlyToolPayloads(messages, CONTEXT_SLIM_KEEP_RECENT_TOOL_OUTPUTS)
      const todoLeft = todoItems.filter((item) => item.status === 'pending' || item.status === 'in_progress').length
      const notice = `已到检查点 ${resumeCount}/${CHECKPOINT_MAX_RESUMES}（${trigger === 'budget' ? '预算片用尽' : '轮次片用尽'}） · 累计消耗 ${(taskTokens() / 10_000).toFixed(0)} 万 tokens · 剩余待办 ${todoLeft} 项 · 自动续跑中`
      // 检查点可见性：落库+直播的系统行，刷新后仍在（产品化参照 codex 的自动 compaction 提示）
      const noticeId = randomUUID()
      bus.emit({ type: 'message.start', messageId: noticeId, role: 'assistant' })
      bus.emit({ type: 'text.delta', messageId: noticeId, delta: notice })
      // 检查点行一次性写完：立即定稿，避免续跑期间光标在系统行尾部常闪
      bus.emit({ type: 'text.final', messageId: noticeId, text: notice, asReasoning: false })
      await persistMessage(noticeId, runId, params.sessionId, 'assistant', [{ type: 'text', text: notice }])
      messages.push({
        role: 'user',
        content: `[系统] ${notice}。上下文已压缩，按本任务目标、已保存产出与本任务已有待办核对进展，继续剩余工作。没有清单时不要为收尾补建清单；不要复述已完成工作、不要重新规划、不要询问作者是否继续。`,
      })
      return true
    }

    // 轮次片耗尽时在 while 条件里做检查点续跑（成功则 maxTurns 已刷新、继续循环），不可续跑才落入下方收尾
    while (turn + inheritedTurns < maxTurns || await tryCheckpointResume('turns')) {
      if (controller.signal.aborted) throw new DOMException('run aborted', 'AbortError')
      // Every request path, including no-tool/protocol retries, passes this budget gate.
      if (taskTokens() >= runTokenBudget && !(await tryCheckpointResume('budget'))) {
        const reason = checkpointStopMessage()
        await announceStopReason(reason)
        await finalizeRun(runId, bus, 'failed', usage, turn, reason, reason, false)
        return
      }
      turn += 1

      // P2 墙钟双条件：总帽（发生过自动续跑后切长任务帽，默认 60→180 分钟）+ 空转帽（默认 10 分钟）。
      // 空转判定只看轮边界：流式增量与工具完成都会刷新 lastActivityAt，模型/工具执行中不会误杀
      const wallClockLimitMs = (resumeCount > 0 ? env.agentRunWallClockLongMinutes : env.agentRunWallClockMinutes) * 60_000
      if (executionElapsedMs() > wallClockLimitMs) {
        // A hard limit cannot be fixed by asking the model to summarize again.
        // Keep the original budget and terminate without another paid request.
        const reason = `任务累计执行时长已达上限（${Math.round(wallClockLimitMs / 60_000)} 分钟，已排除有记录的暂停等待时间）。已保存内容保留；重复点击继续不会增加时间预算。`
        await finalizeRun(runId, bus, 'failed', usage, turn, reason, reason, false)
        return
      }
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
      const effectiveToolCalls = result.toolCalls.length > 0 ? result.toolCalls : recoveredToolCalls

      messages.push({
        role: 'assistant',
        content: recoveredToolCalls.length > 0 ? null : (result.content || null),
        reasoning: result.reasoning || undefined,
        toolCalls: effectiveToolCalls.length > 0 ? effectiveToolCalls : undefined,
      })

      const cleanContent = humanizeAgentVisibleText(result.content ? stripAgentProtocolArtifacts(result.content) : '')

      // 主流 Agent 标准（Codex 等）：任务过程中的进展正文同样是对话正文信道，作者实时可见、刷新后仍在；
      // 只有模型原生 reasoning 才进思考信道，执行旁白不再改道思考区。
      // text.delta 已实时显示供应商原始流；无论最终是否有干净文本，都要发 text.final 做归一化，
      // 这样 DSML/乱码被清洗成空串时能立即从界面移除，而不是残留到刷新前。
      if (result.content) bus.emit({ type: 'text.final', messageId, text: cleanContent, asReasoning: false })

      const parts: AgentMessagePart[] = []
      if (liveTurn) liveTurn.parts = parts
      if (result.reasoning) {
        // 思考信道作者可见：落库同样清洗，避免刷新后历史思考行里残留英文协议词汇
        parts.push({ type: 'reasoning', text: humanizeAgentVisibleText(result.reasoning) })
      }
      if (cleanContent) {
        parts.push({ type: 'text', text: cleanContent })
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
          await finalizeRun(runId, bus, 'failed', usage, turn, '', reason)
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
        const todoIncomplete = unfinishedTodos.length > 0 && !(nextChapterRequired && !chapterIncomplete && taskSpec.goals.length === 1)
        const prematureFinish = chapterIncomplete || reportIncomplete || todoIncomplete || result.finishReason === 'length' || promisesFurtherAction(cleanContent) || (expectsPlanSave && !planSavePerformed)
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
        } else {
          await persistMessage(messageId, runId, params.sessionId, 'assistant', parts)
        }
        bus.emit({ type: 'step.finish', turn, usage: result.usage })
        await finalizeRun(runId, bus, prematureFinish ? 'failed' : 'succeeded', usage, turn, lastAssistantText.slice(0, 300), prematureFinish ? '连续多轮没有推进剩余工作，已保存进度并安全停止；任务未完成。' : undefined)
        return
      }

      let structureCircuitTripped = false
      for (const call of effectiveToolCalls) {
        if (controller.signal.aborted) {
          throw new DOMException('run aborted', 'AbortError')
        }
        // Admit only fresh work. Cached calls never emit tool.call; repeated requests reuse
        // the previous observation. Four consecutive blocked calls trigger a bounded stop.
        const signature = toolSignature(call.name, call.arguments)
        const tool = tools.find(candidate => candidate.name === call.name)
        // Todo updates depend on their current snapshot; completion of newly-started
        // work must not be blocked by an identical call made against an older snapshot.
        const admissionSignature = call.name === 'todo_write' ? toolSignature(signature, JSON.stringify(todoItems)) : signature
        const admissionKey = admission.key(admissionSignature, Boolean(tool?.readOnly) || STATE_SENSITIVE_VALIDATORS.has(call.name))
        const previousObservation = REPEATABLE_TOOLS.has(call.name) ? undefined : admission.previous(admissionKey)
        if (previousObservation !== undefined) {
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
        const outcome = await handleToolCall(call, tools, { ...toolContext, callId: call.id, messageId }, bus, messageId, runId)
        pendingSkillPhase = nextSkillPhase(call.name, outcome.part, taskSpec.intent, params.prompt) ?? pendingSkillPhase
        {
          if (outcome.part.status === 'success') toolProviderFailures.delete(call.name)
          else if (outcome.providerFailure) {
            const failures = (toolProviderFailures.get(call.name) ?? 0) + 1
            toolProviderFailures.set(call.name, failures)
            if (outcome.providerFailureCode === 'AI_PROVIDER_OUTPUT_LIMIT') forceWrapUpReason = `${outcome.part.title}输出达到上限，检查未完成；已停止重复付费请求及后续提交。已保存内容与进度保留，不能将截断报告当作通过；需调整检查输出预算后再恢复。`
            else if (failures >= 2) forceWrapUpReason = `${outcome.part.title}连续两次模型响应失败，已停止重复请求。已保存内容与进度保留，该操作尚未完成；请稍后继续或检查模型服务。`
          }
        }
        if (outcome.part.status === 'success') argumentFailures.delete(call.name)
        else if (outcome.argumentFailure || ['参数解析失败', '参数校验失败', '参数归一化失败'].includes(outcome.part.summary ?? '')) {
          const failures = (argumentFailures.get(call.name) ?? 0) + 1
          argumentFailures.set(call.name, failures)
          if (failures >= 3) forceWrapUpReason = `工具 ${call.name} 连续三次参数无效，已停止重复消耗；已成功保存的内容保留，该工具未完成。`
        }
        if (outcome.recoveryCode) {
          const key = `${call.name}:${outcome.recoveryCode}:${signature}`
          const failures = (recoveryFailures.get(key) ?? 0) + 1
          recoveryFailures.set(key, failures)
          if (failures >= 3) forceWrapUpReason = `${outcome.part.title}反复遇到同一问题：${outcome.part.summary}。已停止相同参数重试，未绕过校验；请先核对目标和来源，已保存内容保留。`
        }
        lastActivityAt = Date.now()
        // 滑窗更新：只记成功执行；失败不碰窗口（同签名重试不会被误杀）
        if (outcome.part.status === 'success') {
          const durableProgress = hasDurableProgress(outcome.part, todoItems)
          const display = outcome.part.display
          const stateChanged = STATE_SENSITIVE_VALIDATORS.has(call.name) || display?.kind === 'chapterDiff' || display?.kind === 'planDiff'
            ? durableProgress
            : Boolean(tool && !tool.readOnly && !STATE_SENSITIVE_VALIDATORS.has(call.name) && !REPEATABLE_TOOLS.has(call.name) && call.name !== 'todo_write')
          admission.record(admissionKey, outcome.observation, stateChanged)
          const readProgress = Boolean(tool?.readOnly) && hasReadProgress(outcome.part)
          const progressKey = toolSignature(call.name, outcome.observation)
          if (!progressSignatures.has(progressKey)) {
            progressSignatures.add(progressKey)
            if (durableProgress || readProgress) todoReminders = 0
            if (durableProgress || readProgress) recoveryFailures.clear()
            // Checklist bookkeeping may reset a reminder, but is not new work
            // evidence and cannot renew the paid execution budget.
            if (durableProgress && display?.kind !== 'todoList') writeProgressCount += 1
            if (readProgress) readProgressCount += 1
          }
          blockedRepeat = 0
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
              structureCircuitTripped = true
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
        if (structureCircuitTripped || forceWrapUpReason || authorEndRequested) {
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

      if (blockedRepeat >= 4) forceWrapUpReason = '连续重复调用已拦截，且未产生新的工具进展（防空转循环）。'
      if (structureCircuitTripped) {
        const failureText = '卷章结构操作已连续失败 3 次，安全熔断已停止后续写入，避免重复建章、错卷和序号进一步漂移。请检查任务状态中的变更后重新发起。'
        const failureMessageId = randomUUID()
        bus.emit({ type: 'message.start', messageId: failureMessageId, role: 'assistant' })
        bus.emit({ type: 'text.delta', messageId: failureMessageId, delta: failureText })
        bus.emit({ type: 'text.final', messageId: failureMessageId, text: failureText, asReasoning: false })
        await persistMessage(failureMessageId, runId, params.sessionId, 'assistant', [{ type: 'text', text: failureText }])
        await finalizeRun(runId, bus, 'failed', usage, turn, failureText, failureText)
        return
      }

      // P0/P1 熔断收尾：结构熔断优先级更高（上方已 return），这里处理重复签名第 4 次/复读二次命中
      if (forceWrapUpReason) {
        const reason = forceWrapUpReason
        forceWrapUpReason = null
        await wrapUpAndFinish(reason)
        return
      }

      if (taskTokens() >= runTokenBudget) {
        // 预算片耗尽先检查任务进展，不能用是否建过待办来决定自动续跑。
        if (await tryCheckpointResume('budget')) continue
        const reason = checkpointStopMessage()
        await announceStopReason(reason)
        await finalizeRun(runId, bus, 'failed', usage, turn, reason, reason, false)
        return
      }
    }

    // 轮次上限（检查点续跑也不可用）：优雅收尾而非硬报错；停止原因落库为可见消息
    const turnLimitReason = checkpointStopMessage()
    await announceStopReason(turnLimitReason)
    await finalizeRun(runId, bus, 'failed', usage, turn, lastAssistantText.slice(0, 300), turnLimitReason)
  } catch (error) {
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

    const message = error instanceof DataAccessError ? error.message : '任务执行遇到内部异常，已停止后续操作；已保存内容保留，请核对状态后再继续。'
    console.error('[agent-loop] run 执行异常', runId, error)
    bus.emit({ type: 'error', code: 'loop_crashed', message, recoverable: false })
    await flushLiveTurn()
    await finalizeRun(runId, bus, 'failed', usage, turn, '', message)
  }
}
