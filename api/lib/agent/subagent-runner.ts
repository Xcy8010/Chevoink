import type { AgentExecutionMode, AgentMessagePart, AgentStreamEventBody, AgentTokenUsage } from '../../../shared/contracts/index.js'
import { recoverAgentProtocolToolCalls, stripAgentProtocolArtifacts } from '../../../shared/agent-output.js'
import { chatWithTools, type ChatMessage } from '../ai-service.js'
import { getModelTierRuntime } from '../credits.js'
import { env } from '../../config/env.js'
import { prisma } from '../prisma.js'
import { applySessionToolPolicy, getAgentDefinition, getToolsForAgent } from './agents.js'
import { resolveAgent2FeatureFlags } from '../agent2-feature-flags.js'
import { handleToolCall } from './loop.js'
import { toOpenAITools } from './tools/registry.js'
import type { ToolContext } from './tools/types.js'
import { intersectToolAuthority, snapshotToolAuthority } from './tool-authority.js'
import {
  collapseEarlyToolRounds,
  compactEarlyToolPayloads,
  estimateChatMessagesTokens,
  estimateToolDefinitionTokens,
  resolveAgentContextBudget,
} from './context-budget.js'

/**
 * 子 Agent 内嵌执行引擎（codex/Zcode 模式）：
 * 主 run 通过 subagent_run / subagent_delegate 工具同步调用子 Agent，子 Agent 在父 run
 * 上下文内跑一个精简工具循环——不建独立会话、不建独立 run、不新开任务窗口。
 * - 事件与工具卡片带 subagentCallId 归属标记，前端嵌套分组进子 Agent 容器
 * - 写操作沿用会话工具策略与审批闸，审批透传到父 run（waitForApproval keyed by 父 runId）
 * - 结束后返回纯文本工作报告，由主 Agent 审查整合后再向作者汇报
 * - 每次调用落一条 agent_subtask_runs，供管理面板查看调用历史与统计
 */

const SUBAGENT_MAX_TURNS = Math.min(env.agentMaxTurns, 24)
/** 全局并发上限：所有用户同时内嵌执行的子 Agent 数（主 Agent 本身也可以并行跑多个 run） */
const SUBAGENT_CONCURRENCY_LIMIT = 8
/** 单个子 Agent 的固定 token 上限（防死循环兑底）：不再暴露给模型/用户配置，避免无限轮询烧 token */
const SUBAGENT_TOKEN_CEILING = 16_000

export type SubagentInlineParams = {
  /** 归属标记：所属 subagent_run 工具调用的 callId */
  subagentCallId: string
  /** agent_subtask_runs 记录 id（调用前已创建） */
  subtaskRunId: string
  name: string
  role: string
  triggerCondition: string
  /** 定义职责说明（模板 prompt） */
  prompt: string
  /** 本次交给子 Agent 的具体任务 */
  task: string
  mode: AgentExecutionMode
  /** 父 run 上下文：审批、额度、事件总线都挂在父 run 上 */
  parentRunId: string
  sessionId: string
  userId: string
  novelId: string
  chapterId: string | null
  messageId: string
  modelRuntime: Awaited<ReturnType<typeof getModelTierRuntime>>
  /** 最小事件接口：主 run 传入 RunEventBus，工具层用 ctx.emit 包装（结构兼容） */
  bus: { emit: (event: AgentStreamEventBody) => void }
  /** 父 run 的 ToolContext；子执行覆写 mode/callId，并收窄服务端工具授权。 */
  toolContextBase: ToolContext
  sessionPolicy: { toolPolicy: unknown; sandboxMode: string } | null
}

export type SubagentInlineResult = {
  ok: boolean
  /** 因审批拒绝/超时未能完成任务 */
  denied: boolean
  /** 纯文本工作报告（写给主 Agent 审查） */
  report: string
  /** 执行轮数 */
  turns: number
  toolCallCount: number
  usage: AgentTokenUsage
  /** 内部工具调用卡片：随父消息落库与直播（带 subagentCallId 归属标记） */
  extraParts: AgentMessagePart[]
}

function addUsage(total: AgentTokenUsage, delta: AgentTokenUsage) {
  total.promptTokens += delta.promptTokens
  total.completionTokens += delta.completionTokens
  total.totalTokens += delta.totalTokens
}

/** 组装子 Agent 精简循环的初始消息：身份 + 职责边界 + 纪律，再接任务指令 */
function buildSubagentMessages(params: SubagentInlineParams): ChatMessage[] {
  const definition = getAgentDefinition(params.role)
  const systemPrompt = [
    `你是「${params.name}」，写作主控 Agent 内嵌调用的专业子 Agent（角色：${definition.title}）。`,
    `你的职责边界：${params.prompt}`,
    `主控的调用依据（触发条件）：${params.triggerCondition}`,
    '执行纪律：',
    '- 你没有向作者提问的信道：不要尝试使用 ask_user（不在你的工具列表里），用合理默认假设继续执行，并在报告中说明假设；',
    '- 不要尝试维护待办清单（todo_write 不在你的工具列表里），直接推进工作；',
    '- 中间轮次正文保持为空，只通过工具调用推进；',
    '- 结束时输出一段纯文本完整工作报告：已完成什么、关键结论或改动明细、依据与数据来源、风险与未尽事项。报告写给主 Agent 审查整合用，不要寒暄，不要向作者提问。',
  ].join('\n')
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请执行以下任务：\n${params.task}\n\n完成后输出完整工作报告。` },
  ]
}

/** 执行子 Agent 精简工具循环，返回报告与内部工具卡片 */
export async function runSubagentInline(params: SubagentInlineParams): Promise<SubagentInlineResult> {
  // Legacy/corrupt stored definitions must not fall back to the unrestricted orchestrator.
  if (!['research', 'continuity', 'quality', 'lore'].includes(params.role)) {
    return {
      ok: false, denied: true, report: '子 Agent 角色无效，未启动；不能回退为主控角色。',
      turns: 0, toolCallCount: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, extraParts: [],
    }
  }
  const parentAuthority = params.toolContextBase.toolAuthority
  if (!parentAuthority) {
    return {
      ok: false, denied: true, report: '父任务授权快照缺失，子 Agent 未启动；请由主任务重新核验授权。',
      turns: 0, toolCallCount: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, extraParts: [],
    }
  }
  const definition = getAgentDefinition(params.role)
  const featureFlags = resolveAgent2FeatureFlags(params.userId)
  const scopedTools = getToolsForAgent(definition, params.mode, featureFlags)
  const sandboxMode = params.sessionPolicy?.sandboxMode === 'read_only' || params.sessionPolicy?.sandboxMode === 'full_access'
    ? params.sessionPolicy.sandboxMode
    : 'workspace'
  // 写操作沿用父会话策略：策略为 ask 的工具在子 Agent 内触发审批，透传到父 run 由作者批复
  const tools = intersectToolAuthority(
    applySessionToolPolicy(scopedTools, params.mode, params.sessionPolicy?.toolPolicy, sandboxMode),
    params.mode,
    parentAuthority,
  )
  const toolAuthority = snapshotToolAuthority(tools, params.mode)
  const openAITools = toOpenAITools(tools)

  const messages = buildSubagentMessages(params)
  const contextBudget = resolveAgentContextBudget(params.modelRuntime.contextWindowTokens ?? env.agentContextWindowTokens, env.aiTextMaxOutputTokens)
  const prepareContextForRequest = (requestTools = openAITools): boolean => {
    const toolTokens = estimateToolDefinitionTokens(requestTools)
    let requestTokens = estimateChatMessagesTokens(messages) + toolTokens
    if (requestTokens >= contextBudget.compactAtTokens) {
      compactEarlyToolPayloads(messages)
      requestTokens = estimateChatMessagesTokens(messages) + toolTokens
    }
    if (requestTokens > contextBudget.hardRequestTokens) {
      collapseEarlyToolRounds(messages)
      requestTokens = estimateChatMessagesTokens(messages) + toolTokens
    }
    return requestTokens <= contextBudget.hardRequestTokens
  }
  const usage: AgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const extraParts: AgentMessagePart[] = []
  // 防死循环兑底：单个子 Agent 的 token 消耗固定钳在 ceiling 内（轮次上限 + 并发闸之外再加一道总量闸），
  // 超过后强制无工具总结收尾，避免反复调用工具持续消耗用户 credits/自定义模型 token
  const budget = Math.min(env.agentRunTokenBudget, SUBAGENT_TOKEN_CEILING)
  let turns = 0
  let toolCallCount = 0
  let report = ''
  let denied = false

  const emitProgress = (step: number, message: string) => {
    params.bus.emit({ type: 'subagent.progress', messageId: params.messageId, callId: params.subagentCallId, step, message })
  }

  emitProgress(0, `「${params.name}」已接收任务，开始工作`)

  try {
    while (turns < SUBAGENT_MAX_TURNS) {
      turns += 1
      emitProgress(turns, `「${params.name}」第 ${turns} 轮：分析任务并选择工具`)
      if (!prepareContextForRequest()) {
        report = '子 Agent 上下文已达到当前模型的安全窗口上限。已完成的工具结果均已保存，主 Agent 可重新读取工作区状态后继续。'
        break
      }

      const result = await chatWithTools({
        messages,
        tools: openAITools,
        model: params.modelRuntime.modelName ?? definition.model,
        providerBaseUrl: params.modelRuntime.baseUrl,
        providerApiKey: params.modelRuntime.apiKey,
        provider: params.modelRuntime.provider,
        reasoningEffort: params.modelRuntime.reasoningEffort,
        reasoningParameterMode: params.modelRuntime.reasoningParameterMode,
        thinkingEnabled: params.modelRuntime.thinkingEnabled,
        outputTokenParameter: params.modelRuntime.outputTokenParameter,
        temperature: 0.6,
        signal: params.toolContextBase.signal,
        usageLog: {
          userId: params.userId,
          action: 'agentSubagentTurn',
          novelId: params.novelId,
          chapterId: params.chapterId,
          targetType: 'agentSubtaskRun',
          targetId: params.subtaskRunId,
          agentRunId: params.parentRunId,
          turn: turns,
          modelTier: params.modelRuntime.tier,
          multiplierBps: params.modelRuntime.multiplierBps,
        },
      })
      addUsage(usage, result.usage)

      const recoveredToolCalls = result.toolCalls.length === 0
        ? recoverAgentProtocolToolCalls(result.content).map((call, index) => ({
            id: `subagent_${params.subtaskRunId}_${turns}_${index}`,
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

      if (effectiveToolCalls.length === 0) {
        // 无工具调用的轮次即最终报告
        report = stripAgentProtocolArtifacts(result.content).trim()
        break
      }

      emitProgress(turns, `「${params.name}」执行中：${effectiveToolCalls.length} 个工具调用`)

      for (const call of effectiveToolCalls) {
        if (params.toolContextBase.signal.aborted) {
          throw new DOMException('subagent aborted', 'AbortError')
        }
        const outcome = await handleToolCall(
          call,
          tools,
          { ...params.toolContextBase, mode: params.mode, toolAuthority, callId: call.id },
          params.bus,
          params.messageId,
          params.parentRunId,
          { callId: params.subagentCallId },
        )
        toolCallCount += 1
        extraParts.push(outcome.part)
        if (outcome.part.status === 'denied') denied = true
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.observation })
      }

      if (usage.totalTokens >= budget) {
        // 预算用尽：带着已有上下文做一次无工具总结，避免静默截断
        emitProgress(turns, `「${params.name}」预算已用尽，正在总结`)
        if (!prepareContextForRequest([])) {
          report = '子 Agent 已达到 token 预算与上下文安全上限；已执行的工具结果均已保存，请主 Agent 核验后继续。'
          break
        }
        const wrapUp = await chatWithTools({
          messages,
          tools: [],
          model: params.modelRuntime.modelName ?? definition.model,
          providerBaseUrl: params.modelRuntime.baseUrl,
          providerApiKey: params.modelRuntime.apiKey,
          provider: params.modelRuntime.provider,
          reasoningEffort: params.modelRuntime.reasoningEffort,
          reasoningParameterMode: params.modelRuntime.reasoningParameterMode,
          thinkingEnabled: params.modelRuntime.thinkingEnabled,
          outputTokenParameter: params.modelRuntime.outputTokenParameter,
          temperature: 0.6,
          signal: params.toolContextBase.signal,
          usageLog: {
            userId: params.userId,
            action: 'agentSubagentTurn',
            novelId: params.novelId,
            chapterId: params.chapterId,
            targetType: 'agentSubtaskRun',
            targetId: params.subtaskRunId,
            agentRunId: params.parentRunId,
            turn: null,
            modelTier: params.modelRuntime.tier,
            multiplierBps: params.modelRuntime.multiplierBps,
          },
        })
        addUsage(usage, wrapUp.usage)
        report = stripAgentProtocolArtifacts(wrapUp.content).trim()
        messages.push({ role: 'assistant', content: report || null })
        break
      }
    }

    if (turns >= SUBAGENT_MAX_TURNS && !report) {
      report = `子 Agent 已达最大轮次上限（${SUBAGENT_MAX_TURNS} 轮），未能产出最终报告。已执行的 ${toolCallCount} 次工具调用的结果保留在工作区，可由主 Agent 直接核验。`
    }
    if (!report) report = '子 Agent 未产出文本报告。'

    emitProgress(turns + 1, `「${params.name}」执行完成，报告已交给主 Agent 审查`)

    return { ok: !denied, denied, report, turns, toolCallCount, usage, extraParts }
  } catch (error) {
    // 用户停止（父 run 暂停）原样上抛，由父 run 统一收尾；其余错误转为失败报告（错误即观察）
    if (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))) throw error
    const message = error instanceof Error ? error.message : String(error)
    console.error('[subagent-runner] 内嵌执行异常', params.subtaskRunId, error)
    return {
      ok: false,
      denied,
      report: `子 Agent 执行过程中发生异常：${message}。已完成的部分可能不完整，请主 Agent 核验工作区状态后再决定是否重试。`,
      turns,
      toolCallCount,
      usage,
      extraParts,
    }
  }
}

/** 全局并发校验：超出上限时拒绝本次调用（错误即观察，不炸 run） */
export async function checkSubagentConcurrency(userId: string): Promise<boolean> {
  const running = await prisma.agentSubtaskRun.count({ where: { userId, status: 'running' } })
  return running < SUBAGENT_CONCURRENCY_LIMIT
}
