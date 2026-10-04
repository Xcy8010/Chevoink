import { z } from 'zod'

import type { AgentMessagePart, AgentSubtaskRole } from '../../../../shared/contracts/index.js'
import { getModelTierRuntime } from '../../credits.js'
import { prisma } from '../../prisma.js'
import { defineTool, type ToolContext } from './types.js'
import { agentModelSelectionSchema, type AgentModelSelection } from '../../../../shared/contracts/agent-model-assignments.js'
import { assignedTaskModel } from '../model-assignment-context.js'
import { admitAssignedModel } from '../model-assignments.js'

/**
 * 子 Agent 调用工具（codex/Zcode 模式）：
 * - subagent_run：按 id 调用已定义的子 Agent（目录在主 run 系统提示里），同步内嵌执行
 * - subagent_delegate：目录里没有合适的子 Agent 时，即时创建定义并内嵌执行（同名复用，不重复建）
 * 两者都不新开任务窗口：子 Agent 在父 run 上下文内嵌执行，报告交回主 Agent 审查整合。
 */

/** 子 Agent 定义落库时的 token 预算占位（仅供统计参考；实际执行上限由 runner 固定 ceiling 决定） */
const SUBAGENT_DEFAULT_TOKEN_BUDGET = 16_000

const roleEnum = z.enum(['research', 'continuity', 'quality', 'lore'])

const subagentRunSchema = z.object({
  model: agentModelSelectionSchema.optional().describe('本次子 Agent 模型与思考强度；不指定时继承当前默认，指定模型但省略强度时使用所选模型配置的默认思考强度。'),
  subagentId: z.string().trim().min(1).max(80).describe('要调用的子 Agent 定义 id（见系统提示中的子 Agent 目录）'),
  task: z.string().trim().min(1).max(12_000).describe('交给子 Agent 的具体任务目标与必要上下文，需自包含（子 Agent 看不到本轮对话历史）'),
})

const subagentDelegateSchema = z.object({
  model: agentModelSelectionSchema.optional().describe('本次子 Agent 模型与思考强度；省略则继承当前默认。'),
  name: z.string().trim().min(1).max(160).describe('子 Agent 名称（同名同作品会复用已有定义）'),
  role: roleEnum.describe('专业角色：research 调研 / continuity 一致性 / quality 质量 / lore 设定'),
  triggerCondition: z.string().trim().min(1).max(1_000).describe('什么情况下应该调用这个子 Agent（会写入定义，供后续主控参考）'),
  prompt: z.string().trim().min(1).max(12_000).describe('子 Agent 的职责边界与工作要求（会写入定义）'),
  task: z.string().trim().min(1).max(12_000).describe('本次交给它的具体任务目标与必要上下文'),
})

/** 子 Agent 执行模式映射（与旧独立会话架构一致：调研走规划模式，其余走审查模式） */
const roleMode: Record<AgentSubtaskRole, 'plan' | 'review'> = { research: 'plan', continuity: 'review', quality: 'review', lore: 'review' }

type SubagentDefinition = { id: string; name: string; role: string; triggerCondition: string; prompt: string; enabled: boolean }

/** 内嵌执行一个子 Agent 定义：落调用记录 → 跑精简循环 → 回写结果 → 组装观察与展示载荷 */
async function executeSubagentDefinition(
  ctx: ToolContext,
  definition: SubagentDefinition,
  task: string,
  model?: AgentModelSelection,
): Promise<{ output: string; summary: string; extraParts: AgentMessagePart[] | undefined; ok: boolean; durationMs: number; report: string; steps: number }> {
  const { runSubagentInline, checkSubagentConcurrency } = await import('../subagent-runner.js')
  const startedAt = Date.now()
  ctx.signal.throwIfAborted()
  const selected = model ? await admitAssignedModel(ctx.userId, model)
    : await assignedTaskModel(ctx.userId, ctx.novelId, 'subagent', ctx.modelAssignments, true)
  const modelRuntime = selected?.runtime ?? ctx.modelRuntime ?? await getModelTierRuntime('speed', ctx.userId, null, 'high')

  // 并发闸：超过全局上限时拒绝本次调用（错误即观察，让主 Agent 稍后重试）
  if (!(await checkSubagentConcurrency(ctx.userId))) {
    return {
      output: '子 Agent 并发已达上限。请先等待已有子 Agent 完成后再调用，或把任务拆分到后续轮次。',
      summary: '子 Agent 并发受限',
      extraParts: undefined,
      ok: false,
      durationMs: Date.now() - startedAt,
      report: '',
      steps: 0,
    }
  }

  const subtaskRun = await prisma.agentSubtaskRun.create({
    data: {
      subtaskId: definition.id,
      parentRunId: ctx.runId,
      userId: ctx.userId,
      novelId: ctx.novelId,
      chapterId: ctx.chapterId,
      task: task.slice(0, 12_000),
      status: 'running',
      startedAt: new Date(),
    },
  })

  try {
    // 模型与计费跟随主 run：主 run 用什么模型（含自定义模型），子 Agent 就用什么模型；
    // 内置档按倍率扣 credits，custom 档消耗用户自己的模型 token。主 run 未注入时回退内置极速档。
    const sessionPolicy = await prisma.agentSession.findUnique({ where: { id: ctx.sessionId }, select: { toolPolicy: true, sandboxMode: true } })
    const result = await runSubagentInline({
      // 归属标记：所属 subagent_run 工具调用的 callId，前端据此把内部工具卡片分组进子 Agent 容器
      subagentCallId: ctx.callId,
      subtaskRunId: subtaskRun.id,
      name: definition.name,
      role: definition.role,
      triggerCondition: definition.triggerCondition,
      prompt: definition.prompt,
      task,
      mode: roleMode[definition.role as AgentSubtaskRole] ?? 'review',
      parentRunId: ctx.runId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      novelId: ctx.novelId,
      chapterId: ctx.chapterId,
      messageId: ctx.messageId ?? '',
      modelRuntime,
      bus: { emit: (event) => ctx.emit(event) },
      toolContextBase: ctx,
      sessionPolicy,
    })

    const durationMs = Date.now() - startedAt
    await prisma.agentSubtaskRun.update({
      where: { id: subtaskRun.id },
      data: {
        status: result.ok ? 'succeeded' : 'failed',
        resultSummary: result.report.slice(0, 4000) || null,
        steps: { turns: result.turns, toolCalls: result.toolCallCount, denied: result.denied } as unknown as object,
        usage: result.usage as unknown as object,
        finishedAt: new Date(),
      },
    }).catch((error: unknown) => console.error('[subagent-tools] 调用记录回写失败', subtaskRun.id, error))

    const statusLine = result.ok
      ? `子 Agent 已完成（${result.turns} 轮，${result.toolCallCount} 次工具调用）。`
      : result.denied
        ? '子 Agent 因部分写操作被作者拒绝而未完全完成，报告仅反映已批准的部分。'
        : '子 Agent 执行未完全成功，请仔细核验以下报告与工作区实际状态。'
    const reviewInstruction = [
      statusLine,
      '—— 子 Agent 工作报告（开始）——',
      result.report,
      '—— 子 Agent 工作报告（结束）——',
      '主 Agent 审查要求：核对报告与工作区实际状态是否一致；发现遗漏、错误或风格不符时直接修正或补充执行；完成后用自己的话向作者简要汇报（不要原样粘贴报告全文，除非作者要求细节）。',
    ].join('\n')

    return {
      output: reviewInstruction,
      summary: `子 Agent · ${definition.name}${result.ok ? ' 完成' : ' 未完全完成'}（${result.toolCallCount} 次工具调用）`,
      extraParts: result.extraParts,
      ok: result.ok,
      durationMs,
      report: result.report,
      steps: result.toolCallCount,
    }
  } catch (error) {
    await prisma.agentSubtaskRun.update({
      where: { id: subtaskRun.id },
      data: { status: 'failed', resultSummary: error instanceof Error ? error.message.slice(0, 4000) : '执行异常', finishedAt: new Date() },
    }).catch(() => {})
    throw error
  }
}

/** 组装 subagentReport 展示载荷 */
function buildReportDisplay(args: {
  subagentRunId: string
  name: string
  role: string
  triggerCondition: string
  ok: boolean
  durationMs: number
  report: string
  steps: number
}) {
  return {
    kind: 'subagentReport' as const,
    subagentRunId: args.subagentRunId,
    subagentName: args.name,
    role: args.role,
    triggerCondition: args.triggerCondition,
    status: args.ok ? ('success' as const) : ('failed' as const),
    report: args.report,
    steps: args.steps,
    durationMs: args.durationMs,
  }
}

export const subAgentRunTool = defineTool({
  name: 'subagent_run',
  title: '调用子 Agent',
  description: '把边界清晰、可独立完成的任务同步交给一个已定义的子 Agent 内嵌执行（不新开任务窗口）。子 Agent 会自主使用工具完成任务并返回工作报告；你收到报告后必须审查核验，再向作者汇报。任务命中触发条件，或作者本轮手动指定该子 Agent 且职责适用时调用；没有作者指定的简单任务不要拆分，也不要为同一任务重复调用。',
  parameters: subagentRunSchema,
  permission: { plan: 'ask', build: 'ask', review: 'ask' },
  readOnly: false,
  async execute(ctx, args) {
    const subtask = await prisma.agentSubtask.findFirst({
      where: { id: args.subagentId, userId: ctx.userId, novelId: ctx.novelId },
      select: { id: true, name: true, role: true, triggerCondition: true, prompt: true, enabled: true },
    })
    if (!subtask) {
      return { output: `子 Agent 定义 ${args.subagentId} 不存在或不属于当前作品。请核对系统提示中的子 Agent 目录后重试。`, summary: '子 Agent 不存在' }
    }
    if (!subtask.enabled) {
      return { output: `子 Agent「${subtask.name}」已停用。请在创作区子 Agent 管理面板启用后再调用，或改用 subagent_delegate 即时委派。`, summary: '子 Agent 已停用' }
    }
    const result = await executeSubagentDefinition(ctx, subtask, args.task, args.model)
    return {
      output: result.output,
      summary: result.summary,
      display: buildReportDisplay({ subagentRunId: subtask.id, name: subtask.name, role: subtask.role, triggerCondition: subtask.triggerCondition, ok: result.ok, durationMs: result.durationMs, report: result.report, steps: result.steps }),
      extraParts: result.extraParts,
    }
  },
})

export const subAgentDelegateTool = defineTool({
  name: 'subagent_delegate',
  title: '委派新子 Agent',
  description: '当子 Agent 目录里没有合适的具名子 Agent、但任务确实适合委派时使用：创建一个新的子 Agent 定义并立即内嵌执行本次任务（不新开任务窗口）。同名同作品会复用已有定义，不会重复创建。创建后它会进入子 Agent 目录，可在管理面板启用/停用。',
  parameters: subagentDelegateSchema,
  permission: { plan: 'ask', build: 'ask', review: 'ask' },
  readOnly: false,
  async execute(ctx, args) {
    // 同名同作品复用：避免模型多轮委派产生重复定义
    const existing = await prisma.agentSubtask.findFirst({
      where: { userId: ctx.userId, novelId: ctx.novelId, name: args.name.trim().slice(0, 160) },
      select: { id: true, name: true, role: true, triggerCondition: true, prompt: true, enabled: true },
    })
    let definition: SubagentDefinition
    let created = false
    if (existing) {
      definition = existing
    } else {
      const record = await prisma.agentSubtask.create({
        data: {
          userId: ctx.userId,
          novelId: ctx.novelId,
          name: args.name.trim().slice(0, 160),
          role: args.role,
          triggerCondition: args.triggerCondition.trim(),
          callableBy: 'main_and_subagents',
          prompt: args.prompt.trim(),
          tokenBudget: SUBAGENT_DEFAULT_TOKEN_BUDGET,
          status: 'ready',
          enabled: true,
        },
        select: { id: true, name: true, role: true, triggerCondition: true, prompt: true, enabled: true },
      })
      definition = record
      created = true
    }
    if (!definition.enabled) {
      return { output: `子 Agent「${definition.name}」已存在但处于停用状态，本次未执行。请在管理面板启用后再试。`, summary: '子 Agent 已停用' }
    }
    const result = await executeSubagentDefinition(ctx, definition, args.task, args.model)
    const prefix = created ? `已创建子 Agent「${definition.name}」并完成执行。` : `复用已有子 Agent「${definition.name}」完成执行。`
    return {
      output: `${prefix}${result.output}`,
      summary: result.summary,
      display: buildReportDisplay({ subagentRunId: definition.id, name: definition.name, role: definition.role, triggerCondition: definition.triggerCondition, ok: result.ok, durationMs: result.durationMs, report: result.report, steps: result.steps }),
      extraParts: result.extraParts,
    }
  },
})
