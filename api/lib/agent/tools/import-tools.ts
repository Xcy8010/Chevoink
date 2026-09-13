import { z } from 'zod'
import { DataAccessError, prisma } from '../../prisma.js'
import { isManagedAttachmentOwnedBy, resolveManagedAttachmentPath } from '../../agent-attachment-storage.js'
import { defineTool } from './types.js'

const importArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), attachmentUrl: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal('status'), jobId: z.string().uuid() }).strict(),
])

/** Read-only handoff: attachment discovery and job status do not grant authority
 * to overwrite chapters. The human import UI owns both approval steps and the
 * final manifest-bound commit. No general-purpose confirmed boolean exists. */
export const novelImportTool = defineTool({
  name: 'novel_import',
  title: '一键导入',
  description: '用户要求把本轮上传的文件导入当前作品时，使用 prepare 并提供附件真实 URL，打开供用户核对的导入入口；用户必须在界面完成预览与确认，有章节时需要两次覆盖确认。本工具不写入章节、不调用识别模型、不代表导入已完成。缺少本轮文件先请用户上传，禁止猜地址。status 可查看已有导入任务。不要用其他写作工具绕过用户尚未确认或已拒绝的导入覆盖。',
  parameters: importArguments,
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  readOnly: true,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    if (process.env.NOVEL_IMPORT_ENABLED !== 'true') {
      throw new DataAccessError(503, 'IMPORT_NOT_ENABLED', '作品导入尚未开放，现有作品未作改动。')
    }
    const db = ctx.transaction ?? prisma
    const novel = await db.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { id: true } })
    if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
    if (args.action === 'status') {
      const job = await db.novelImportJob.findFirst({
        where: { id: args.jobId, userId: ctx.userId, novelId: ctx.novelId },
        select: { id: true, status: true, errorCode: true },
      })
      if (!job) return { outcome: 'failed', output: '未找到属于当前用户和作品的导入任务。', summary: '导入任务不存在' }
      const url = `/studio/novel/${encodeURIComponent(ctx.novelId)}?importJobId=${encodeURIComponent(job.id)}`
      const text = `导入任务状态：${job.status}${job.errorCode ? `；问题代码：${job.errorCode}` : ''}。${job.status === 'succeeded' ? '导入已提交，可查看报告。' : '尚未确认提交完成，不得声称章节已导入。'}`
      return { output: `${text}\n[查看导入任务](${url})`, summary: '查看导入进度', display: { kind: 'markdown', markdown: `${text}\n\n[查看导入任务](${url})` } }
    }
    const run = await db.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId }, select: { id: true } })
    if (!run) throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '文件必须来自当前作品任务的用户上传。')
    const original = await db.agentMessage.findFirst({ where: { runId: run.id, sessionId: ctx.sessionId, role: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
    const attachmentSchema = z.object({ type: z.literal('attachment'), kind: z.literal('file'),
      name: z.string().min(1).max(512), url: z.string().min(1).max(1024) })
    const attachment = (Array.isArray(original?.parts) ? original.parts : [])
      .map(part => attachmentSchema.safeParse(part)).find(result => result.success && result.data.url === args.attachmentUrl)
    if (!attachment?.success || !resolveManagedAttachmentPath(args.attachmentUrl)) {
      throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '未在本次原始用户消息中找到该文件，请重新上传后发起导入。')
    }
    if (!isManagedAttachmentOwnedBy(args.attachmentUrl, ctx.userId)) {
      if (args.attachmentUrl.slice('/api/uploads/agent-attachments/'.length).includes('/')) {
        throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '附件不属于当前用户，请重新上传。')
      }
      const grant = await db.legacyAgentAttachmentGrant.findUnique({ where: { url: args.attachmentUrl },
        select: { ownerUserId: true, revokedAt: true } })
      if (!grant || grant.ownerUserId !== ctx.userId || grant.revokedAt) {
        throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '附件归属尚未核验，请重新上传。')
      }
    }
    ctx.signal.throwIfAborted()
    const params = new URLSearchParams({ importRunId: ctx.runId, importAttachmentUrl: args.attachmentUrl })
    const url = `/studio/novel/${encodeURIComponent(ctx.novelId)}?${params}`
    const markdown = `已找到本轮上传文件。请打开导入面板，核对卷章与原文并确认导入；已有章节需要两次覆盖确认。\n\n[打开作品导入](${url})\n\n当前尚未写入章节，也未调用付费识别。`
    return { output: markdown, summary: '待用户核对并确认导入', display: { kind: 'markdown', markdown } }
  },
})
