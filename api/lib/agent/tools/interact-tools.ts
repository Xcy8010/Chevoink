import { z } from 'zod'

import { env } from '../../../config/env.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { recordWritingClarification } from '../writing-clarification.js'
import { waitForQuestionAnswer } from '../permissions.js'
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
    '仅当现有请求与上下文仍有影响执行的具体冲突、确实缺少目标，或作者明确要求亲自决定时，用本工具提问并等待回答。已绑定章节的明确修改、整章重写或保存请求直接执行，不重复确认相同目标；普通人物表达、文风、段落组织等创作细节按已知意图自行处理。先核对本轮章节绑定、同聊天真实作者已明确的目标与已有回答。提供 2-4 个候选选项，作者也可以自行输入答案。尽量合并相关问题，避免重复追问；拿到回答后修订既有产物（如 plan_save 带 planId）。禁止把问题和选项写在回复正文里让作者"回复数字选择"——那样任务已经结束，作者的回答无法接上。',
  parameters: askUserParameters,
  coerceArgs: coerceAskUserArgs,
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  readOnly: true,
  async execute(ctx, args) {
    // 挂起等待作者回答（复用审批超时时长）；期间 run 标记为 awaiting_approval 供前端展示等待态
    const waiting = await prisma.agentRun.updateMany({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId,
      status: { in: ['queued', 'running'] } }, data: { status: 'awaiting_approval' } })
    if (waiting.count !== 1) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行已停止，未发起新提问。')

    const { setGoalRunPhase } = await import('../goal-runtime.js')
    await setGoalRunPhase(ctx.userId, ctx.runId, 'awaiting_input')
    const result = await waitForQuestionAnswer(
      ctx.runId,
      ctx.callId,
      env.agentApprovalTimeoutMs,
      ctx.signal,
    )

    ctx.signal.throwIfAborted()
    const resumed = await prisma.agentRun.updateMany({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId,
      status: 'awaiting_approval' }, data: { status: 'running' } })
    if (resumed.count !== 1) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '提问后执行已停止，回答没有恢复旧任务。')
    await setGoalRunPhase(ctx.userId, ctx.runId, 'executing')

    if (result.answer === null) {
      const reason = result.timedOut ? '作者长时间未回答' : '本次提问已取消'
      return {
        output: `${reason}。未回答不等于同意，不选择依赖该回答的方向或扩大授权。只继续不依赖此决定且已获授权的工作；必要决定仍缺失时保留进度等待作者输入，不重复提问。`,
        summary: '提问未获回答',
        display: {
          kind: 'question',
          question: args.question,
          options: args.options,
          unanswered: true,
        },
      }
    }

    ctx.signal.throwIfAborted()
    const clarification = await prisma.$transaction(tx => recordWritingClarification(tx, ctx,
      { callId: ctx.callId, ...args, answer: result.answer!, source: 'legacy_question' }))
    ctx.authorQuestionAnswers?.set(ctx.callId, { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, question: args.question + '\n' + args.options.map(option => option.label + ' ' + (option.detail ?? '')).join('\n'), answer: result.answer })
    return {
      ...(clarification ? { semanticTransition: clarification } : {}),
      output: `作者的回答：${result.answer}${clarification ? '\n已补全原请求缺失的目标或原文范围；继续原任务，保留原有检查、权限与预算。' : ''}`,
      summary: `作者已回答：${result.answer.slice(0, 40)}${result.answer.length > 40 ? '…' : ''}`,
      display: {
        kind: 'question',
        question: args.question,
        options: args.options,
        answer: result.answer,
        ...(clarification ? { scopeResolution: 'accepted' as const } : {}),
      },
    }
  },
})
