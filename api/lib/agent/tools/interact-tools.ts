import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { formatAgentQuestionOption, type AgentQuestionOption, type AgentQuestionPrompt } from '../../../../shared/contracts/agent-events.js'
import { agentQuestionOptionSchema, agentQuestionPromptsSchema } from '../../../../shared/contracts/schemas.js'

import { env } from '../../../config/env.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { recordWritingClarification } from '../writing-clarification.js'
import { waitForQuestionAnswer } from '../permissions.js'
import { defineTool } from './types.js'

export const QUESTION_TIMEOUT_NOTICE = '提问已超时，本轮已结束。已保存的内容会保留。'
export const QUESTION_CANCELLED_NOTICE = '提问已取消，本轮已结束。已保存的内容会保留。'
export const DIRECTION_PURPOSE_REQUIRED = '当前是在确认新作品的故事方向。请以 purpose=novel_direction 重新提交问题；本次问题未发送给作者。'
export const QUESTION_OPTION_LIMIT = 3

/**
 * 交互类工具（plan/13 §4.3 扩展）：ask_user 向作者提问。
 * 与审批同构的挂起-唤醒模式：循环停在工具内等待作者作答，
 * 前端渲染专门的提问卡片（候选选项 + 自定义输入），POST questions 路由唤醒。
 */

export const legacyAskUserParameters = z.object({
  purpose: z.literal('novel_direction').optional().describe('仅在询问作者要采用哪个方向来初始化当前空作品时设为 novel_direction。'),
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
export const previousBatchAskUserParameters = legacyAskUserParameters.extend({ questions: z.array(z.object({
  question: z.string().min(1).max(500).refine(value => Boolean(value.trim())),
  options: z.array(z.object({ label: z.string().min(1).max(60).refine(value => Boolean(value.trim())), detail: z.string().max(200).optional() }))
    .min(2).max(4).describe('首项为推荐选项，界面会显示推荐标记。作者可自行输入回答，无需提供其他选项。'),
})).min(1).max(3).optional()
  .describe('一次向作者确认 1–3 个相关问题。使用 questions 时无需另传 question 或 options。') })
const askUserParameters = previousBatchAskUserParameters.extend({
  options: legacyAskUserParameters.shape.options.element.extend({ coverAssetId: agentQuestionOptionSchema.shape.coverAssetId })
    .array().min(2).max(4).describe('提供 2–3 个选项，把推荐方案排在首位。界面另有自定义回答入口。'),
  questions: agentQuestionPromptsSchema.optional().describe('一次向作者确认 1–3 个相关问题。使用 questions 时无需另传 question 或 options。'),
})

export async function checkQuestionCoverOptions(db: Pick<Prisma.TransactionClient, 'coverAsset'>,
  scope: { userId: string; novelId: string }, question: { options: AgentQuestionOption[]; questions?: AgentQuestionPrompt[] }) {
  const ids = new Set<string>()
  for (const { options } of question.questions ?? [question]) {
    if (!options.some(option => option.coverAssetId)) continue
    const answers = options.map(formatAgentQuestionOption)
    if (options.some((option, index) => option.coverAssetId && answers.indexOf(answers[index]) !== answers.lastIndexOf(answers[index]))) return {
      code: 'QUESTION_COVER_AMBIGUOUS', output: '含封面的同一题各选项需有不同的名称或说明，以便确认作者选的是哪一项。',
    }
    for (const option of options) if (option.coverAssetId) ids.add(option.coverAssetId)
  }
  if (ids.size) {
    const assets = await db.coverAsset.findMany({ where: { id: { in: [...ids] }, ownerUserId: scope.userId, novelId: scope.novelId }, select: { id: true } })
    if (assets.length !== ids.size) return { code: 'QUESTION_COVER_UNAVAILABLE',
      output: '提问中的封面候选不属于当前作品或已不可用。请使用当前作品现有候选的 coverAssetId。' }
  }
  return null
}

export function formatAuthorQuestionAnswer(options: readonly AgentQuestionOption[], answer: string): string {
  const matches = options.filter(option => formatAgentQuestionOption(option) === answer)
  const coverAssetId = matches.length === 1 ? matches[0].coverAssetId : undefined
  return `作者的回答：${answer}${coverAssetId ? `\n作者选择的封面候选 coverAssetId：${coverAssetId}` : ''}`
}

export function formatAuthorQuestionAnswers(questions: readonly AgentQuestionPrompt[], answers: readonly string[]): string {
  return questions.map(({ question, options }, index) => `${index + 1}. ${question}\n${formatAuthorQuestionAnswer(options, answers[index])}`).join('\n\n')
}

/** 校验前兜底修复：Agent 构造 options 时最常见的小毛病在此收口，避免一次提问因选项格式被打成「参数校验失败」。
 * 逐项修复：options 缺失/为空时补默认选项；元素是字符串时升级为 {label}；detail 为 null 时剔除；
 * 数量超 4 个截断、不足 2 个补齐；label 超 60 字截断；顶层 null 剔除。只改形态，不改语义。 */
function coerceAskUserArgs(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { question: '', options: [] }
  }
  const record = raw as Record<string, unknown>
  if (record.questions !== undefined) {
    const first = Array.isArray(record.questions) ? record.questions[0] : undefined
    return { question: first?.question, options: first?.options, questions: record.questions,
      ...(record.purpose !== undefined ? { purpose: record.purpose } : {}) }
  }
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
        return { label, ...(detail ? { detail } : {}), ...(obj.coverAssetId === undefined ? {} : { coverAssetId: obj.coverAssetId }) }
      }
      return null
    })
    .filter((item): item is { label: string; detail?: string } => item !== null && item.label.length > 0)
  while (normalized.length < 2) {
    normalized.push({ label: `继续方案 ${normalized.length + 1}` })
  }
  return { question, options: normalized, ...(record.purpose !== undefined ? { purpose: record.purpose } : {}) }
}

export const askUserTool = defineTool({
  name: 'ask_user',
  title: '向作者提问',
  description:
    '仅当现有请求与上下文仍有影响执行的具体冲突、确实缺少目标，或作者明确要求亲自决定时，用本工具提问并等待回答。已绑定章节的明确修改、整章重写或保存请求直接执行，不重复确认相同目标；普通人物表达、文风、段落组织等创作细节按已知意图自行处理。先核对本轮章节绑定、同聊天真实作者已明确的目标与已有回答。每题提供 2–3 个候选选项，作者也可以自行输入答案。单题传 question 和 options，多题用 questions 一次提交最多三题；需要作者确认方向或章节目标时，把决定该目标的问题放在首题。封面选项填写当前作品候选的 coverAssetId，选项文字可说明画面，允许作者选择暂不应用；根据确认用 cover_apply 应用已有 ID。拿到回答后修订既有产物（如 plan_save 带 planId）。禁止把问题和选项写在回复正文里让作者"回复数字选择"——那样任务已经结束，作者的回答无法接上。',
  parameters: askUserParameters,
  coerceArgs: coerceAskUserArgs,
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  readOnly: true,
  async execute(ctx, args) {
    const { question, options, questions } = args
    if ((questions ?? [args]).some(prompt => prompt.options.length > QUESTION_OPTION_LIMIT)) {
      return { outcome: 'failed', failureCode: 'TOOL_SCHEMA_INVALID', summary: '提问未发送', output: '每题请提供 2–3 个候选选项，作者另有自定义回答入口。' }
    }
    const coverFailure = await checkQuestionCoverOptions(prisma, ctx, args)
    if (coverFailure) return { outcome: 'failed', failureCode: coverFailure.code, summary: '提问未发送', output: coverFailure.output }
    const display = { kind: 'question' as const, question, options, ...(questions ? { questions } : {}) }
    // 挂起等待作者回答（复用审批超时时长）；期间 run 标记为 awaiting_approval 供前端展示等待态
    const waiting = await prisma.agentRun.updateMany({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId,
      status: { in: ['queued', 'running'] } }, data: { status: 'awaiting_approval' } })
    if (waiting.count !== 1) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行已停止，未发起新提问。')

    const { setGoalRunPhase } = await import('../goal-runtime.js')
    await setGoalRunPhase(ctx.userId, ctx.runId, 'awaiting_input')
    const pending = waitForQuestionAnswer(
      ctx.runId,
      ctx.callId,
      env.agentApprovalTimeoutMs,
      ctx.signal,
      questions?.length,
    )
    if (!ctx.signal.aborted) ctx.publishQuestion?.()
    const result = await pending

    ctx.signal.throwIfAborted()
    const resumed = await prisma.agentRun.updateMany({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId,
      status: 'awaiting_approval' }, data: { status: 'running' } })
    if (resumed.count !== 1) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '提问后执行已停止，回答没有恢复旧任务。')
    if (result.cancelled) await setGoalRunPhase(ctx.userId, ctx.runId, 'awaiting_input', 'GOAL_QUESTION_CANCELLED')
    else await setGoalRunPhase(ctx.userId, ctx.runId, 'executing')

    if (result.answer === null) {
      const reason = result.timedOut ? '作者长时间未回答' : '本次提问已取消'
      return {
        output: result.cancelled ? QUESTION_CANCELLED_NOTICE : result.timedOut ? QUESTION_TIMEOUT_NOTICE : `${reason}。未回答不等于同意，不选择依赖该回答的方向或扩大授权。`,
        summary: result.cancelled ? '作者已取消提问' : result.timedOut ? '提问超时，未获回答' : '提问未获回答',
        ...(result.timedOut ? { questionTimedOut: true as const } : {}),
        ...(result.cancelled ? { questionCancelled: true as const } : {}),
        display: {
          ...display,
          unanswered: true,
          ...(result.cancelled ? { cancelled: true as const } : {}),
        },
      }
    }

    ctx.signal.throwIfAborted()
    const { answer, answers } = result
    const clarification = await prisma.$transaction(tx => recordWritingClarification(tx, ctx,
      { callId: ctx.callId, question, options, answer, source: 'legacy_question' }))
    ctx.authorQuestionAnswers?.set(ctx.callId, { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, question: question + '\n' + options.map(option => option.label + ' ' + (option.detail ?? '')).join('\n'), answer, purpose: args.purpose })
    const output = questions && answers ? formatAuthorQuestionAnswers(questions, answers) : formatAuthorQuestionAnswer(options, answer)
    return {
      ...(clarification ? { semanticTransition: clarification } : {}),
      output: `${output}${clarification ? '\n已补全原请求缺失的目标或原文范围；继续原任务，保留原有检查、权限与预算。' : ''}`,
      summary: answers ? `作者已回答 ${answers.length} 个问题` : `作者已回答：${answer.slice(0, 40)}${answer.length > 40 ? '…' : ''}`,
      display: {
        ...display,
        answer,
        ...(answers ? { answers } : {}),
        ...(clarification ? { scopeResolution: 'accepted' as const } : {}),
      },
    }
  },
})
