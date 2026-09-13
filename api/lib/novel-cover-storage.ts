import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { env } from '../config/env.js'
import { transcodeCoverImage } from './image-transcode.js'
import { DataAccessError } from './prisma.js'

const MANAGED_NOVEL_COVER_PREFIX = '/api/uploads/novel-covers/'
const MAX_NOVEL_COVER_BYTES = 3 * 1024 * 1024
/** 远程封面下载时限：生图 CDN 跨境较慢，放宽到 60s */
const REMOTE_COVER_FETCH_TIMEOUT_MS = 60000
const REMOTE_COVER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const MIME_TO_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const

type SupportedNovelCoverMimeType = keyof typeof MIME_TO_EXTENSION

function getUploadsRoot() {
  return env.appEnv === 'production'
    ? path.resolve(process.cwd(), '..', '..', 'shared', 'uploads')
    : path.resolve(process.cwd(), '.local-storage', 'uploads')
}

function getNovelCoverDirectory() {
  return path.join(getUploadsRoot(), 'novel-covers')
}

function parseNovelCoverDataUrl(dataUrl: string): {
  mimeType: SupportedNovelCoverMimeType
  buffer: Buffer
} {
  const normalized = dataUrl.trim()
  const matched = normalized.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)

  if (!matched) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '作品封面仅支持 PNG、JPG 或 WebP 图片。')
  }

  const mimeType = matched[1] as SupportedNovelCoverMimeType
  const buffer = Buffer.from(matched[2], 'base64')

  if (!buffer.length) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '作品封面图片不能为空。')
  }

  if (buffer.byteLength > MAX_NOVEL_COVER_BYTES) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '作品封面图片不能超过 3MB。')
  }

  return { mimeType, buffer }
}

export async function storeNovelCoverDataUrl(dataUrl: string): Promise<string> {
  const { mimeType, buffer } = parseNovelCoverDataUrl(dataUrl)
  return writeCoverBuffer(mimeType, buffer)
}

/** Import outbox only: promote an explicitly selected, ALREADY COMMITTED PNG.
 * Content-addressed writes make retries/crashes bounded and idempotent. This
 * never fetches a URL, invokes a model, or exposes an unselected private image. */
export async function storeImportedNovelCoverDataUrl(dataUrl: string): Promise<string> {
  const { mimeType, buffer } = parseNovelCoverDataUrl(dataUrl)
  if (mimeType !== 'image/png' || buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new DataAccessError(409, 'IMPORT_COVER_INVALID', '导入封面不是已验证的 PNG 图片。')
  const directory = getNovelCoverDirectory()
  await mkdir(directory, { recursive: true })
  if (await realpath(directory) !== directory) throw new DataAccessError(503, 'IMPORT_COVER_STORAGE_UNSAFE', '封面存储目录不可用。')
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const filename = `${sha256}.png`
  const target = path.join(directory, filename)
  const temporary = path.join(directory, `.${sha256}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o644)
    try { await handle.writeFile(buffer); await handle.sync() } finally { await handle.close() }
    // Atomic publish after fsync: a crash cannot leave a partial public cover.
    await link(temporary, target)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    if (await realpath(target) !== target) throw new DataAccessError(503, 'IMPORT_COVER_STORAGE_UNSAFE', '封面文件路径不可用。')
    const handle = await open(target, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== buffer.length) throw new DataAccessError(409, 'IMPORT_COVER_INVALID', '封面持久资源校验失败。')
      const existing = Buffer.alloc(buffer.length + 1)
      let length = 0
      while (length < existing.length) {
        const read = await handle.read(existing, length, existing.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length !== buffer.length || !existing.subarray(0, length).equals(buffer)) throw new DataAccessError(409, 'IMPORT_COVER_INVALID', '封面持久资源校验失败。')
    } finally { await handle.close() }
  } finally { await unlink(temporary).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }) }
  return `${MANAGED_NOVEL_COVER_PREFIX}${filename}`
}

/** 魔数嗅探远程封面格式：CDN 常回 application/octet-stream，不能信 Content-Type */
function sniffRemoteCoverMime(buffer: Buffer): SupportedNovelCoverMimeType | null {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** 下载远程封面（生图服务直链）并落盘为本站静态地址；失败抛错由调用方降级保留原 URL */
export async function storeNovelCoverFromRemoteUrl(remoteUrl: string): Promise<string> {
  const response = await fetch(remoteUrl, {
    signal: AbortSignal.timeout(REMOTE_COVER_FETCH_TIMEOUT_MS),
    headers: { 'user-agent': REMOTE_COVER_USER_AGENT },
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`远程封面下载失败：HTTP ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  if (!buffer.byteLength || buffer.byteLength > MAX_NOVEL_COVER_BYTES) {
    throw new Error('远程封面为空或超过 3MB。')
  }

  const mimeType = sniffRemoteCoverMime(buffer)
  if (!mimeType) {
    throw new Error('远程封面不是支持的 png/jpg/webp 图片。')
  }

  return writeCoverBuffer(mimeType, buffer)
}

async function writeCoverBuffer(
  mimeType: SupportedNovelCoverMimeType,
  buffer: Buffer,
): Promise<string> {
  const coverDirectory = getNovelCoverDirectory()

  await mkdir(coverDirectory, { recursive: true })

  // 优先 sharp 转 WebP + 缩略图；失败时降级原样落盘
  const transcoded = await transcodeCoverImage(buffer)
  if (transcoded) {
    const filename = `${randomUUID()}.webp`
    await writeFile(path.join(coverDirectory, filename), transcoded.main)
    await writeFile(path.join(coverDirectory, filename.replace(/\.webp$/, '.thumb.webp')), transcoded.thumb)
    return `${MANAGED_NOVEL_COVER_PREFIX}${filename}`
  }

  const extension = MIME_TO_EXTENSION[mimeType]
  const filename = `${randomUUID()}.${extension}`
  await writeFile(path.join(coverDirectory, filename), buffer)

  return `${MANAGED_NOVEL_COVER_PREFIX}${filename}`
}

/** 一键导出用：托管封面 URL 读回原始字节；非托管地址或读盘失败返回 null 由调用方降级 */
export async function readNovelCoverBuffer(
  coverUrl: string | null,
): Promise<{ buffer: Buffer; extension: string } | null> {
  if (!coverUrl || !coverUrl.startsWith(MANAGED_NOVEL_COVER_PREFIX)) {
    return null
  }

  const filename = path.basename(decodeURIComponent(coverUrl.slice(MANAGED_NOVEL_COVER_PREFIX.length)).split('?')[0])

  // 防路径穿越：只允许 uuid 风格的单层文件名
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/i.test(filename) || filename.includes('..')) {
    return null
  }

  try {
    const buffer = await readFile(path.join(getNovelCoverDirectory(), filename))
    const extension = filename.split('.').pop()?.toLowerCase() ?? 'jpg'
    return { buffer, extension }
  } catch {
    return null
  }
}
