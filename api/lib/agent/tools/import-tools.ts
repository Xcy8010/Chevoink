import { z } from 'zod'
import { DataAccessError, prisma } from '../../prisma.js'
import { isManagedAttachmentOwnedBy, resolveManagedAttachmentPath } from '../../agent-attachment-storage.js'
import { defineTool } from './types.js'
import type { ToolContext } from './types.js'
import { getNovelImportStatus } from '../../novel-import-service.js'

export const novelImportArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), attachmentUrl: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal('status'), jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('commit'), jobId: z.string().uuid() }).strict(),
])

/** Only the durable adapter performs workflow effects. Human HTTP capabilities
 * remain the sole source of intent confirmations and manifest-bound approval. */
export const novelImportTool = defineTool({
  name: 'novel_import',
  title: '一键导入',
  description: '把本轮用户上传的原文件导入当前作品：prepare 使用附件真实 URL 打开人类导入面板；普通对话交付导入入口后等待作者操作，持久任务保存等待位置；已有章节必须先两次独立覆盖确认，再核对具体预览。status 查询任务；commit 只接受 jobId，并仅消费服务端已有、未过期且绑定原文/预览/目标的真实人类批准，不能用 confirmed、通用工具允许或模型参数批准。等待期间不轮询模型、不调用其他写工具绕过确认。仅真实成功回执代表导入完成，不自动发布、不调用付费识别。',
  parameters: novelImportArguments,
  permission: { plan: 'deny', build: 'allow', review: 'deny' },
  readOnly: false,
  dangerous: true,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    if (args.action !== 'status' && process.env.NOVEL_IMPORT_ENABLED !== 'true') {
      throw new DataAccessError(503, 'IMPORT_NOT_ENABLED', '作品导入尚未开放，现有作品未作改动。')
    }
    const db = ctx.transaction ?? prisma
    const novel = await db.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { id: true } })
    if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
    if (args.action === 'status') {
      const job = await getNovelImportStatus({ userId: ctx.userId, novelId: ctx.novelId }, args.jobId)
      const url = `/studio/novel/${encodeURIComponent(ctx.novelId)}?importJobId=${encodeURIComponent(job.jobId)}`
      const text = `导入任务状态：${job.status}${job.errorCode ? `；问题代码：${job.errorCode}` : ''}。${job.status === 'succeeded' && job.receipt ? '导入已提交，可查看报告。' : '尚未确认提交完成，不得声称章节已导入。'}`
      return { output: `${text}\n[查看导入任务](${url})`, summary: '查看导入进度', display: { kind: 'markdown', markdown: `${text}\n\n[查看导入任务](${url})` } }
    }
    if (args.action === 'prepare') {
      await assertOriginalImportAttachment(ctx, args.attachmentUrl)
      // Legacy runs finish this tool with a human handoff. Deliberately omit
      // callId: this is an ordinary human import, never a durable write exemption.
      const url = `/studio/novel/${encodeURIComponent(ctx.novelId)}?${new URLSearchParams({ importRunId: ctx.runId, importAttachmentUrl: args.attachmentUrl })}`
      const markdown = `[选择内容并导入](${url})`
      return { output: `已准备本次上传文件的导入入口，作者可直接选择内容并确认。尚未写入作品；不要手工重写文件内容、反复轮询或声称导入完成。\n${markdown}`, summary: '导入文件已准备，等待选择内容', display: { kind: 'markdown', markdown } }
    }
    // Legacy callers cannot consume human approval as a durable write exemption.
    throw new DataAccessError(409, 'IMPORT_DURABLE_RUNTIME_REQUIRED', '请从支持持久等待的主任务导入，或直接打开作品导入面板；尚未写入章节。')
  },
})

export async function assertOriginalImportAttachment(ctx: ToolContext, attachmentUrl: string) {
    const db = ctx.transaction ?? prisma
    const run = await db.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId }, select: { id: true } })
    if (!run) throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '文件必须来自当前作品任务的用户上传。')
    const original = await db.agentMessage.findFirst({ where: { runId: run.id, sessionId: ctx.sessionId, role: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
    const attachmentSchema = z.object({ type: z.literal('attachment'), kind: z.literal('file'),
      name: z.string().min(1).max(255), url: z.string().min(1).max(1024) })
    const attachment = (Array.isArray(original?.parts) ? original.parts : [])
      .map(part => attachmentSchema.safeParse(part)).find(result => result.success && result.data.url === attachmentUrl)
    if (!attachment?.success || !resolveManagedAttachmentPath(attachmentUrl)) {
      throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '未在本次原始用户消息中找到该文件，请重新上传后发起导入。')
    }
    if (!isManagedAttachmentOwnedBy(attachmentUrl, ctx.userId)) {
      if (attachmentUrl.slice('/api/uploads/agent-attachments/'.length).includes('/')) {
        throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '附件不属于当前用户，请重新上传。')
      }
      const grant = await db.legacyAgentAttachmentGrant.findUnique({ where: { url: attachmentUrl },
        select: { ownerUserId: true, revokedAt: true } })
      if (!grant || grant.ownerUserId !== ctx.userId || grant.revokedAt) {
        throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '附件归属尚未核验，请重新上传。')
      }
    }
    ctx.signal.throwIfAborted()
    return attachment.data
}
