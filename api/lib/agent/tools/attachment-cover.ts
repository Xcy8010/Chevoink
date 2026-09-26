import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { readAuthorizedAgentAttachment } from '../../agent-attachment-storage.js'
import { storeImportedNovelCoverDataUrl } from '../../novel-cover-storage.js'
import { DataAccessError, prisma } from '../../prisma.js'
import type { ToolContext } from './types.js'

/** Private attachment -> validated, content-addressed cover. Never fetch URLs. */
export async function prepareAttachmentCover(ctx: ToolContext, url: string) {
  ctx.signal.throwIfAborted()
  const db = ctx.transaction ?? prisma
  const [novel, message] = await Promise.all([
    db.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { id: true } }),
    db.agentMessage.findFirst({ where: { sessionId: ctx.sessionId, role: 'user', run: { userId: ctx.userId, novelId: ctx.novelId },
      parts: { array_contains: [{ type: 'attachment', kind: 'image', url }] } }, select: { id: true } }),
  ])
  if (!novel || !message) throw new DataAccessError(403, 'COVER_ATTACHMENT_SCOPE', '请选择当前任务中由你上传的图片附件。')
  const bytes = await readAuthorizedAgentAttachment(url, ctx.userId)
  if (bytes.length > 8 * 1024 * 1024) throw new DataAccessError(413, 'COVER_ATTACHMENT_SIZE', '封面图片不能超过 8MB。')
  let png: Buffer
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 })
    const metadata = await image.metadata()
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('unsupported')
    png = await image.rotate().resize(900, 1200, { fit: 'cover' }).flatten({ background: '#ffffff' }).png({ compressionLevel: 9 }).toBuffer()
  } catch {
    throw new DataAccessError(400, 'COVER_ATTACHMENT_INVALID', '图片无法作为封面，请上传有效的 PNG、JPG 或 WebP 静态图片。')
  }
  ctx.signal.throwIfAborted()
  const imageUrl = await storeImportedNovelCoverDataUrl(`data:image/png;base64,${png.toString('base64')}`)
  ctx.signal.throwIfAborted()
  const id = createHash('sha256').update(ctx.userId).update('\0').update(ctx.novelId).update('\0').update(png).digest('hex')
  return { id, imageUrl, width: 900, height: 1200 }
}
