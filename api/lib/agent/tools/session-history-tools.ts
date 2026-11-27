import { formatAgentTime } from '../context-time.js'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'

import type { AgentMessagePart } from '../../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { previousHistoryTask } from '../task-lineage.js'
import { defineTool, type ToolContext } from './types.js'

const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const
const SEARCH_SCAN_LIMIT = 1000
const historyScope = z.enum(['session', 'previous_task']).optional()

function visibleTranscript(parts: AgentMessagePart[]): string {
  return parts
    .flatMap((part) => {
      if (part.type === 'text') return [part.text]
      if (part.type === 'attachment') return [`[附件：${part.name}]`]
      if (part.type === 'tool-call') {
        const status = part.status === 'success' ? '完成' : part.status === 'failed' ? '失败' : part.status === 'denied' ? '拒绝' : '运行中'
        return [`[工具：${part.title || part.toolName}；${status}${part.summary ? `；${part.summary}` : ''}]`]
      }
      // reasoning 属于内部思考，不是作者可见的 Agent 输出，也不进入精确会话审计。
      return []
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

async function historyMessageScope({ userId, sessionId, runId }: ToolContext, scope: z.infer<typeof historyScope>, db: Prisma.TransactionClient) {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } })
  if (!session) throw new DataAccessError(404, 'TOOL_READ_NOT_FOUND', '当前会话不存在或无权访问。')
  if (scope !== 'previous_task') return { sessionId }
  const previous = await previousHistoryTask(userId, sessionId, runId, db)
  return { sessionId, runId: { in: previous.runIds } }
}

function roleLabel(role: string): string {
  return role === 'user' ? '作者' : 'Agent'
}

export const sessionHistorySearchTool = defineTool({
  name: 'session_history_search',
  title: '检索会话原文',
  description:
    '按需检索原始作者提示词与助手可见输出。追溯上一个任务用 scope=previous_task，全会话省略 scope。首条作者提示用 first_user_prompt，关键词用 keyword，近期用 recent。普通写作、续写、改稿与已有上下文足够时禁止调用。需完整原文再用 session_message_read。',
  parameters: z.object({
    mode: z.enum(['first_user_prompt', 'keyword', 'recent']),
    scope: historyScope,
    query: z.string().trim().max(200).optional(),
    role: z.enum(['user', 'assistant', 'all']).default('all'),
    limit: z.number().int().min(1).max(10).default(5),
  }).superRefine((value, ctx) => {
    if (value.mode === 'keyword' && !value.query) {
      ctx.addIssue({ code: 'custom', path: ['query'], message: '关键词检索必须提供 query。' })
    }
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    const previous = args.scope === 'previous_task'
    const where = await historyMessageScope(ctx, args.scope, db)
    const label = previous ? '上一个任务' : '当前会话'
    const roleWhere = args.mode === 'first_user_prompt'
      ? 'user'
      : args.role === 'all'
        ? undefined
        : args.role

    if (args.mode === 'first_user_prompt') {
      const record = await db.agentMessage.findFirst({
        where: { ...where, role: 'user' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, role: true, parts: true, createdAt: true },
      })
      if (!record) return { output: `${label}没有可用的作者提示词。` }
      const text = visibleTranscript(record.parts as unknown as AgentMessagePart[])
      return {
        output: `${label}第一条作者提示词（原始记录，未使用压缩摘要）：\nmessageId=${record.id}\n时间=${formatAgentTime(record.createdAt, ctx.clientTimeZone)}\n\n${text}`,
        summary: previous ? '读取了上一个任务的首条作者提示词' : '读取了会话首条作者提示词',
      }
    }

    const records = await db.agentMessage.findMany({
      where: { ...where, ...(roleWhere ? { role: roleWhere } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: args.mode === 'recent' ? args.limit : SEARCH_SCAN_LIMIT,
      select: { id: true, role: true, parts: true, createdAt: true },
    })
    const needle = args.query?.toLocaleLowerCase('zh-CN') ?? ''
    const matches = records
      .map((record) => ({ ...record, text: visibleTranscript(record.parts as unknown as AgentMessagePart[]) }))
      .filter((record) => args.mode === 'recent' || record.text.toLocaleLowerCase('zh-CN').includes(needle))
      .slice(0, args.limit)

    if (matches.length === 0) {
      return { output: args.mode === 'keyword' ? `${label}原始记录中未找到关键词“${args.query}”。` : `${label}没有符合条件的记录。` }
    }
    return {
      output: (previous ? '上一个任务的原始记录：\n' : '') + matches.map((record, index) => {
        const preview = record.text.length > 500 ? `${record.text.slice(0, 500)}…` : record.text
        return `${index + 1}. ${roleLabel(record.role)} · ${formatAgentTime(record.createdAt, ctx.clientTimeZone)}\nmessageId=${record.id}\n${preview}`
      }).join('\n\n'),
      summary: `定位到 ${matches.length} 条会话记录`,
    }
  },
})

export const sessionMessageReadTool = defineTool({
  name: 'session_message_read',
  title: '读取会话原文',
  description:
    '按检索得到的 messageId 和同一 scope 读取原文，可用 offset 分页。禁止为了“以防万一”批量读取整段会话。',
  parameters: z.object({
    messageId: z.string().trim().min(1),
    scope: historyScope,
    offset: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(500).max(16000).default(8000),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    const where = await historyMessageScope(ctx, args.scope, db)
    const record = await db.agentMessage.findFirst({
      where: { ...where, id: args.messageId },
      select: { id: true, role: true, parts: true, createdAt: true },
    })
    if (!record) return { output: args.scope === 'previous_task' ? '上一个任务中没有这条消息。' : '未找到该消息，可能已删除或不属于当前会话。', outcome: 'failed' as const }
    const text = visibleTranscript(record.parts as unknown as AgentMessagePart[])
    const content = text.slice(args.offset, args.offset + args.maxChars)
    const nextOffset = args.offset + content.length < text.length ? args.offset + content.length : null
    return {
      output: `${roleLabel(record.role)}原始消息 · ${formatAgentTime(record.createdAt, ctx.clientTimeZone)}\nmessageId=${record.id}\n字符范围=${args.offset}-${args.offset + content.length}/${text.length}${nextOffset == null ? '' : `\n下一页 offset=${nextOffset}`}\n\n${content}`,
      summary: `读取了${roleLabel(record.role)}消息原文`,
    }
  },
})
