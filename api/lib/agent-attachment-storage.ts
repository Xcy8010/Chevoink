import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  AGENT_FILE_EXTENSIONS,
  MAX_AGENT_FILE_BYTES_DOC,
  MAX_AGENT_FILE_BYTES_PDF,
  MAX_AGENT_IMAGE_BYTES,
  type AgentAttachmentKind,
  type AgentAttachmentMeta,
} from '../../shared/contracts/agent-attachments.js'
import { env } from '../config/env.js'
import { transcodePostImage } from './image-transcode.js'
import { DataAccessError, prisma } from './prisma.js'

/**
 * Agent 对话附件存储（图片/文件）：克隆 post-image-storage 范式。
 * 附件 URL 被用户气泡与 view_image 卡片持久引用，永久保留不自动清理。
 */

export const MANAGED_AGENT_ATTACHMENT_PREFIX = '/api/uploads/agent-attachments/'

const MIME_TO_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const

type SupportedImageMimeType = keyof typeof MIME_TO_EXTENSION

export function getUploadsRootDirectory(): string {
  return env.appEnv === 'production'
    ? path.resolve(process.cwd(), '..', '..', 'shared', 'uploads')
    : path.resolve(process.cwd(), '.local-storage', 'uploads')
}

export function getAgentAttachmentDirectory(): string {
  return path.join(getUploadsRootDirectory(), 'agent-attachments')
}

/** URL → 磁盘绝对路径：兼容旧版单层文件，同时支持 userId/filename 隔离目录。 */
export function resolveManagedAttachmentPath(url: string): string | null {
  if (!url.startsWith(MANAGED_AGENT_ATTACHMENT_PREFIX)) {
    return null
  }
  const relative = url.slice(MANAGED_AGENT_ATTACHMENT_PREFIX.length)
  const segments = relative.split('/')
  if (
    (segments.length !== 1 && segments.length !== 2) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || path.basename(segment) !== segment || !/^[A-Za-z0-9_.-]+$/.test(segment))
  ) {
    return null
  }
  const root = getAgentAttachmentDirectory()
  const resolved = path.resolve(root, ...segments)
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null
}

/** Pure path ownership only. Legacy ownership requires an independently reviewed grant. */
export function isManagedAttachmentOwnedBy(url: string, userId: string): boolean {
  if (!resolveManagedAttachmentPath(url)) return false
  const relative = url.slice(MANAGED_AGENT_ATTACHMENT_PREFIX.length)
  const segments = relative.split('/').filter(Boolean)
  return segments.length === 2 && segments[0] === userId
}

export async function assertManagedAttachmentAccess(url: string, userId: string): Promise<{ diskPath: string; contentSha256: string | null }> {
  const diskPath = resolveManagedAttachmentPath(url)
  if (!diskPath || !userId) throw new DataAccessError(403, 'FORBIDDEN', '附件不存在或不属于当前用户。')
  if (isManagedAttachmentOwnedBy(url, userId)) return { diskPath, contentSha256: null }
  if (url.slice(MANAGED_AGENT_ATTACHMENT_PREFIX.length).includes('/')) {
    throw new DataAccessError(403, 'FORBIDDEN', '附件不存在或不属于当前用户。')
  }
  let grant
  try {
    grant = await prisma.legacyAgentAttachmentGrant.findUnique({ where: { url } })
  } catch {
    throw new DataAccessError(503, 'ATTACHMENT_ACCESS_UNAVAILABLE', '暂时无法核验附件归属，请稍后重试。')
  }
  if (!grant || grant.ownerUserId !== userId || grant.revokedAt) {
    throw new DataAccessError(403, 'FORBIDDEN', '历史附件归属尚未核验或无权访问，原文件仍保留。')
  }
  return { diskPath, contentSha256: grant.contentSha256 }
}

export async function assertManagedAttachmentsAccess(attachments: readonly Pick<AgentAttachmentMeta, 'url'>[] | undefined, userId: string): Promise<void> {
  for (const attachment of attachments ?? []) await assertManagedAttachmentAccess(attachment.url, userId)
}

/** Bounded local read shared by HTTP, tool calls and main-model vision inputs. */
export async function readAuthorizedAgentAttachment(url: string, userId: string): Promise<Buffer> {
  const access = await assertManagedAttachmentAccess(url, userId)
  try {
    const root = await realpath(getAgentAttachmentDirectory())
    const actual = await realpath(access.diskPath)
    // No symlink aliases, including links to another user's file within the root.
    if (actual !== path.join(root, path.relative(getAgentAttachmentDirectory(), access.diskPath))) {
      throw new DataAccessError(403, 'FORBIDDEN', '附件路径无效。')
    }
    const handle = await open(actual, 'r')
    try {
      const stat = await handle.stat()
      const limit = MAX_AGENT_FILE_BYTES_PDF
      if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new DataAccessError(413, 'ATTACHMENT_SIZE_INVALID', '附件体积无效。')
      // Read at most limit+1 even if a file grows after stat; no unbounded readFile.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size !== stat.size) throw new DataAccessError(409, 'ATTACHMENT_CHANGED', '附件内容已变化，需重新核验。')
      const result = buffer.subarray(0, size)
      if (access.contentSha256 && createHash('sha256').update(result).digest('hex') !== access.contentSha256) {
        throw new DataAccessError(409, 'ATTACHMENT_CHANGED', '历史附件内容与核验记录不一致。')
      }
      return result
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof DataAccessError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DataAccessError(404, 'ATTACHMENT_NOT_FOUND', '附件文件不存在或已失效。')
    throw new DataAccessError(503, 'ATTACHMENT_READ_UNAVAILABLE', '附件暂时无法读取，请稍后重试。')
  }
}

/** 仅供已声明视觉能力的主模型直传；仍复用本站托管前缀白名单，绝不接受任意路径或 URL。 */
export async function readManagedImageDataUrl(url: string, userId: string): Promise<string | null> {
  const diskPath = resolveManagedAttachmentPath(url)
  if (!diskPath) return null
  const extension = path.extname(diskPath).slice(1).toLowerCase()
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : null
  if (!mime) return null
  try {
    const buffer = await readAuthorizedAgentAttachment(url, userId)
    if (!buffer.length || buffer.byteLength > MAX_AGENT_IMAGE_BYTES) return null
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch (error) {
    if (error instanceof DataAccessError && error.code !== 'ATTACHMENT_NOT_FOUND') throw error
    return null
  }
}

function parseImageDataUrl(dataUrl: string): { mimeType: SupportedImageMimeType; buffer: Buffer } {
  const matched = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)

  if (!matched) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '参考图仅支持 PNG、JPG 或 WebP 图片。')
  }

  const mimeType = matched[1] as SupportedImageMimeType
  const buffer = Buffer.from(matched[2], 'base64')

  if (!buffer.length) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '参考图不能为空。')
  }

  if (buffer.byteLength > MAX_AGENT_IMAGE_BYTES) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '每张参考图不能超过 5MB。')
  }

  return { mimeType, buffer }
}

function parseFileDataUrl(dataUrl: string, name: string): { extension: string; buffer: Buffer } {
  const matched = dataUrl.trim().match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/)

  if (!matched) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '文件内容无效，请重新选择后上传。')
  }

  const buffer = Buffer.from(matched[1], 'base64')

  if (!buffer.length) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '文件不能为空。')
  }

  const extension = (path.extname(name).slice(1) || '').toLowerCase()

  if (!(AGENT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '文件仅支持 pdf、docx、txt、md、zip、doc 格式。')
  }

  const maxBytes = extension === 'pdf' ? MAX_AGENT_FILE_BYTES_PDF : MAX_AGENT_FILE_BYTES_DOC

  if (buffer.byteLength > maxBytes) {
    throw new DataAccessError(
      400,
      'VALIDATION_ERROR',
      extension === 'pdf' ? '单个 PDF 不能超过 10MB。' : '单个文件不能超过 5MB。',
    )
  }

  // Import-only containers stay opaque here: never unzip or launch a converter
  // in the chat upload process. The isolated import parser owns full validation.
  const validZip = buffer.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(buffer.readUInt32LE(0))
  const validDoc = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
  if ((extension === 'zip' && !validZip) || (extension === 'doc' && !validDoc)) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '文件头与 ZIP/DOC 格式不符，请选择有效的原文件。')
  }
  return { extension, buffer }
}

/** 单附件落盘：图片优先 sharp 转 WebP（失败降级原样），文件原样落盘；返回元数据供 run 请求携带 */
export async function storeAgentAttachment(input: {
  userId: string
  kind: AgentAttachmentKind
  name: string
  dataUrl: string
}): Promise<AgentAttachmentMeta> {
  if (!/^[A-Za-z0-9_-]+$/.test(input.userId)) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '用户标识无效。')
  }
  const directory = path.join(getAgentAttachmentDirectory(), input.userId)
  await mkdir(directory, { recursive: true })

  const id = randomUUID()

  if (input.kind === 'image') {
    const { mimeType, buffer } = parseImageDataUrl(input.dataUrl.trim())

    // 优先 sharp 转 WebP 压缩体积（视觉模型不需要原图体积）；失败时降级原样落盘
    const transcoded = await transcodePostImage(buffer)

    if (transcoded) {
      const filename = `${id}.webp`
      await writeFile(path.join(directory, filename), transcoded.main)
      return {
        id,
        kind: 'image',
        name: input.name,
        url: `${MANAGED_AGENT_ATTACHMENT_PREFIX}${input.userId}/${filename}`,
        size: transcoded.main.byteLength,
      }
    }

    const filename = `${id}.${MIME_TO_EXTENSION[mimeType]}`
    await writeFile(path.join(directory, filename), buffer)
    return {
      id,
      kind: 'image',
      name: input.name,
      url: `${MANAGED_AGENT_ATTACHMENT_PREFIX}${input.userId}/${filename}`,
      size: buffer.byteLength,
    }
  }

  const { extension, buffer } = parseFileDataUrl(input.dataUrl, input.name)
  const filename = `${id}.${extension}`
  await writeFile(path.join(directory, filename), buffer)

  return {
    id,
    kind: 'file',
    name: input.name,
    url: `${MANAGED_AGENT_ATTACHMENT_PREFIX}${input.userId}/${filename}`,
    size: buffer.byteLength,
  }
}
