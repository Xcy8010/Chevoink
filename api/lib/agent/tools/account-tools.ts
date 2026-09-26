import { z } from 'zod'
import { getCreditSummary } from '../../credits.js'
import { prisma, DataAccessError } from '../../prisma.js'
import { defineTool } from './types.js'

const permission = { plan: 'allow', build: 'allow', review: 'allow' } as const
export const accountCreditsTool = defineTool({
  name: 'account_credits', title: '查看 Credits 余额',
  description: '用户询问额度时，读取当前登录用户的 Credits 余额、可用额度、预留额度和重置时间，不修改额度。',
  parameters: z.object({}).strict(), permission, readOnly: true,
  async execute(ctx) {
    ctx.signal.throwIfAborted()
    const { models: _models, ...account } = await getCreditSummary(ctx.userId, ctx.transaction ?? prisma)
    return { output: JSON.stringify(account), summary: '已读取当前账户额度' }
  },
})
export const accountCreditHistoryTool = defineTool({
  name: 'account_credit_history', title: '查看 Credits 使用记录',
  description: '分页查看当前登录用户的 Credits 收支记录，负数为支出、正数为入账；cursor 使用上一页返回的 nextCursor。',
  parameters: z.object({ cursor: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(50).default(20) }), permission, readOnly: true,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const db = ctx.transaction ?? prisma
    const cursor = args.cursor ? await db.creditLedgerEntry.findFirst({ where: { id: args.cursor, userId: ctx.userId }, select: { id: true, createdAt: true } }) : null
    if (args.cursor && !cursor) throw new DataAccessError(404, 'TOOL_READ_NOT_FOUND', '记录游标不存在或不属于当前账户，请从第一页查询。')
    const entries = await db.creditLedgerEntry.findMany({
      where: { userId: ctx.userId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: args.limit,
      select: { id: true, deltaMilli: true, kind: true, sourceType: true, modelTier: true, requestTokens: true, responseTokens: true, createdAt: true },
    })
    return { output: JSON.stringify({ entries: entries.map(({ deltaMilli, ...item }) => ({ ...item, credits: deltaMilli / 1000 })), nextCursor: entries.length === args.limit ? entries.at(-1)!.id : null }), summary: `读取 ${entries.length} 条额度记录` }
  },
})
export const accountNovelsTool = defineTool({
  name: 'account_novels', title: '查看我的作品',
  description: '分页查看当前用户拥有的作品名称、状态、字数和章节数。仅返回元信息，不读取其他作品正文，也不切换当前任务作品。',
  parameters: z.object({ offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(20) }), permission, readOnly: true,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const items = await (ctx.transaction ?? prisma).novel.findMany({ where: { authorId: ctx.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: args.offset, take: args.limit,
      select: { id: true, title: true, displayTitle: true, status: true, wordCount: true, chapterCount: true, updatedAt: true } })
    return { output: JSON.stringify({ items, nextOffset: items.length === args.limit ? args.offset + items.length : null }), summary: `读取 ${items.length} 部作品` }
  },
})
export const sessionRenameTool = defineTool({
  name: 'session_rename', title: '重命名任务窗口',
  description: '仅在用户明确要求改名时，修改当前任务窗口名称。不会更改作品名，不接受其他用户或其他窗口的 ID。',
  parameters: z.object({ title: z.string().trim().min(1).max(160) }).strict(),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const result = await (ctx.transaction ?? prisma).agentSession.updateMany({
      where: { id: ctx.sessionId, userId: ctx.userId, novelId: ctx.novelId }, data: { title: args.title },
    })
    if (!result.count) throw new DataAccessError(404, 'TOOL_READ_NOT_FOUND', '当前任务窗口不存在或无权修改。')
    return { output: `当前任务窗口已重命名为「${args.title}」。`, summary: `任务窗口：${args.title}`, display: { kind: 'sessionRename', sessionId: ctx.sessionId, title: args.title } }
  },
})
