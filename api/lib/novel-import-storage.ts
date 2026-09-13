import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { NOVEL_IMPORT_LIMITS } from '../../shared/contracts/novel-import.js'
import { DataAccessError } from './prisma.js'

// Never mount this directory with express.static. Ownership is resolved in DB first.
function rootDirectory(): string {
  const fallback = process.env.APP_ENV === 'production'
    ? path.resolve(process.cwd(), '..', '..', 'shared', 'private-novel-imports')
    : path.resolve(process.cwd(), '..', 'private-novel-imports')
  const root = path.resolve(process.env.NOVEL_IMPORT_STORAGE_DIR || fallback)
  if (root.split(path.sep).some(part => /^(uploads|public)$/i.test(part))) throw new DataAccessError(503, 'IMPORT_STORAGE_UNSAFE', '导入私有存储配置不可用。')
  return root
}
export function importBytesHash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }

async function resolveKey(key: string): Promise<string> {
  if (!/^[a-f0-9-]{36}\.blob$/.test(key)) throw new DataAccessError(400, 'IMPORT_SOURCE_INVALID', '来源标识无效。')
  const root = rootDirectory()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const realRoot = await realpath(root)
  if (realRoot !== root || realRoot.split(path.sep).some(part => /^(uploads|public)$/i.test(part))) throw new DataAccessError(503, 'IMPORT_STORAGE_UNSAFE', '导入私有存储配置不可用。')
  return path.join(realRoot, key)
}

export function validateImportFilename(filename: string): string {
  if (!filename || filename.length > 255 || /[\\/:]/.test(filename) || [...filename].some(char => char.charCodeAt(0) < 32) || filename === '.' || filename === '..') throw new DataAccessError(400, 'IMPORT_SOURCE_INVALID', '文件名无效。')
  if (!/\.(txt|md|zip|pdf|docx|doc)$/i.test(filename)) throw new DataAccessError(400, 'IMPORT_UNSUPPORTED_FORMAT', '请选择 TXT、MD、ZIP、PDF 或 Word 文件。')
  return filename
}

/** Bounded, immutable upload. No supplied path or hash is trusted. */
export async function storeImportStream(stream: AsyncIterable<Uint8Array>, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
  const storageKey = `${randomUUID()}.blob`
  const filename = await resolveKey(storageKey)
  const handle = await open(filename, 'wx', 0o600)
  const digest = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of stream) {
      options.signal?.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > (options.maxBytes ?? NOVEL_IMPORT_LIMITS.sourceBytes)) throw new DataAccessError(413, 'IMPORT_LIMIT_EXCEEDED', '文件超过导入大小上限。')
      digest.update(chunk)
      await handle.writeFile(chunk)
    }
    options.signal?.throwIfAborted()
    if (!bytes) throw new DataAccessError(400, 'IMPORT_NO_BODY', '文件为空。')
    await handle.sync()
    return { storageKey, sha256: digest.digest('hex'), bytes }
  } catch (error) {
    await handle.close()
    await unlink(filename).catch(() => undefined)
    throw error
  } finally { await handle.close().catch(() => undefined) }
}

export async function storeImportJson(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  return storeImportStream((async function* () { yield bytes })(), { maxBytes: 32 * 1024 * 1024 })
}

/** Call only with a DB-owned key. Check integrity on every read; do not expose paths. */
export async function readImportBlob(storageKey: string, expectedHash: string, maxBytes: number = NOVEL_IMPORT_LIMITS.sourceBytes): Promise<Buffer> {
  const filename = await resolveKey(storageKey)
  if (await realpath(filename) !== filename) throw new DataAccessError(409, 'IMPORT_SOURCE_INVALID', '来源校验失败。')
  const handle = await open(filename, 'r')
  try {
    if ((await handle.stat()).size > maxBytes) throw new DataAccessError(413, 'IMPORT_LIMIT_EXCEEDED', '来源超过大小上限。')
    const chunks: Buffer[] = []
    let length = 0
    while (length <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length))
      const result = await handle.read(chunk, 0, chunk.length, null)
      if (!result.bytesRead) break
      chunks.push(chunk.subarray(0, result.bytesRead)); length += result.bytesRead
    }
    const bytes = Buffer.concat(chunks, length)
    if (bytes.length > maxBytes || importBytesHash(bytes) !== expectedHash) throw new DataAccessError(409, 'IMPORT_SOURCE_CHANGED', '来源校验失败，请重新上传。')
    return bytes
  } finally { await handle.close() }
}

/** Only used for an unpublished, unreferenced blob created by this operation. */
export async function discardImportBlob(storageKey: string): Promise<void> { await unlink(await resolveKey(storageKey)).catch(() => undefined) }

/** Maintenance must retain its durable queue entry on every error except ENOENT. */
export async function deleteUnreferencedImportBlob(storageKey: string): Promise<void> {
  try { await unlink(await resolveKey(storageKey)) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
}
