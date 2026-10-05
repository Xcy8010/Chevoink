import { z } from 'zod'

import { env } from '../../../config/env.js'
import { prisma } from '../../prisma.js'
import { assertQuestionWritingScope } from '../writing-scope.js'
import { consumeQuestionBudget, waitForQuestionAnswer } from '../permissions.js'
import { defineTool } from './types.js'

/**
 * 交互类工具（plan/13 §4.3 扩展）：ask_user 向作者提问。
 * 与审批同构的挂起-唤醒模式：循环停在工具内等待作者作答，
 * 前端渲染专门的提问卡片（候选选项 + 自定义输入），POST questions 路由唤醒。
 */

const askUserParameters = z.object({
  question: z
    .string()
    .min(1)
    .max(500)
    .describe('向作者提出的问题，一句话说清楚需要确认什么'),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(60).describe('选项短标题（一眼可选）'),
        detail: z.string().max(200).optional().describe('选项补充说明，可选'),
      }),
    )
    .min(2)
    .max(4)
    .describe('给作者的候选方向（2-4 个），必须把你最推荐的方案排在第一位（界面会给首项标记「推荐」，选项文本里不要自己写“推荐”字样）。界面还会额外提供自定义输入框，无需专门加“其他”选项'),
})

/** 校验前兜底修复：Agent 构造 options 时最常见的小毛病在此收口，避免一次提问因选项格式被打成「参数校验失败」。
 * 逐项修复：options 缺失/为空时补默认选项；元素是字符串时升级为 {label}；detail 为 null 时剔除；
 * 数量超 4 个截断、不足 2 个补齐；label 超 60 字截断；顶层 null 剔除。只改形态，不改语义。 */
function coerceAskUserArgs(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { question: '', options: [] }
  }
  const record = raw as Record<string, unknown>
  const question =
    typeof record.question === 'string' ? record.question.trim().slice(0, 500) : String(record.question ?? '').slice(0, 500)
  let options = Array.isArray(record.options) ? record.options : []
  if (options.length === 0) {
    options = [{ label: '是的，按此继续' }, { label: '我有补充' }]
  }
  const normalized = options
    .slice(0, 4)
    .map((item) => {
      if (typeof item === 'string') {
        return { label: item.trim().slice(0, 60) }
      }
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 60) : String(obj.label ?? '').trim().slice(0, 60)
        const detail = obj.detail === null ? undefined : typeof obj.detail === 'string' ? obj.detail.trim().slice(0, 200) : undefined
        return { label, ...(detail ? { detail } : {}) }
      }
      return null
    })
    .filter((item): item is { label: string; detail?: string } => item !== null && item.label.length > 0)
  while (normalized.length < 2) {
    normalized.push({ label: `继续方案 ${normalized.length + 1}` })
  }
  return { question, options: normalized }
}

export const askUserTool = defineTool({
  name: 'ask_user',
  title: '向作者提问',
  description:
    '当任务的关键意图不明确（如剧情走向、篇幅、风格、人物取舍）时，用本工具向作者提问并等待回答，再基于回答继续执行。提供 2-4 个候选选项帮助作者快速决策，作者也可以自行输入答案。一次任务最多提问 3 次，尽量把相关的不确定点合并成一次提问；拿到回答后应修订既有产物（如 plan_save 带 planId）而不是重新生成。禁止把问题和选项写在回复正文里让作者"回复数字选择"——那样任务已经结束，作者的回答无法接上。',
  parameters: askUserParameters,
  coerceArgs: coerceAskUserArgs,
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  readOnly: true,
  async execute(ctx, args) {
    await prisma.$transaction(tx => assertQuestionWritingScope(tx, ctx, args.question, args.options))
    // 提问预算：超出额度直接回填，不再挂起，防止反复追问
    if (!consumeQuestionBudget(ctx.runId)) {
      return {
        output:
          '本次任务的提问次数已用完（每次任务最多 3 次）。请基于已有回答与上下文选择最合理的方案直接完成任务，不要再提问；已有产物走修订而不是重新生成。',
        summary: '提问预算已用尽',
      }
    }

    // 挂起等待作者回答（复用审批超时时长）；期间 run 标记为 awaiting_approval 供前端展示等待态
    await prisma.agentRun
      .update({ where: { id: ctx.runId }, data: { status: 'awaiting_approval' } })
      .catch(() => {})

    const { setGoalRunPhase } = await import('../goal-runtime.js')
    await setGoalRunPhase(ctx.userId, ctx.runId, 'awaiting_input')
    const result = await waitForQuestionAnswer(
      ctx.runId,
      ctx.callId,
      env.agentApprovalTimeoutMs,
      ctx.signal,
    )

    const goalContext = (await import('../goal-context.js')).currentGoalExecution()
    if (result.answer === null && goalContext) {
      return (await import('../goal-store.js')).goalError('GOAL_AUTHOR_INPUT_REQUIRED', '目标等待作者回答，未选择默认方向继续。')
    }
    if (!ctx.signal.aborted) await setGoalRunPhase(ctx.userId, ctx.runId, 'executing')
    await prisma.agentRun
      .update({ where: { id: ctx.runId }, data: { status: 'running' } })
      .catch(() => {})

    if (result.answer === null) {
      const reason = result.timedOut ? '作者长时间未回答' : '本次提问已取消'
      return {
        output: `${reason}。请基于已有信息选择最合理的默认方案继续完成任务，并在最终说明中简要交代你的假设。不要再重复提问。`,
        summary: '提问未获回答',
        display: {
          kind: 'question',
          question: args.question,
          options: args.options,
          unanswered: true,
        },
      }
    }

    return {
      output: `作者的回答：${result.answer}`,
      summary: `作者已回答：${result.answer.slice(0, 40)}${result.answer.length > 40 ? '…' : ''}`,
      display: {
        kind: 'question',
        question: args.question,
        options: args.options,
        answer: result.answer,
      },
    }
  },
})
