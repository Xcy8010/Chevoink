import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { runtimeError } from './agent/runtime-common.js'

export const EXPORT_SOURCE_BYTES = 128 * 1024 * 1024
export const EXPORT_ZIP_BYTES = 96 * 1024 * 1024
const hex = z.string().regex(/^[a-f0-9]{64}$/)
export const exportIdentitySchema = z.object({ userId: z.string().min(1).max(64), taskRootId: z.string().min(1).max(64),
  operationKey: z.string().min(1).max(160), sourceHash: hex, argsHash: hex }).strict()
export type ExportFileIdentity = z.infer<typeof exportIdentitySchema>
const kindSchema = z.enum(['source', 'zip'])
type Kind = z.infer<typeof kindSchema>
const headerSchema = z.object({ version: z.literal(1), kind: z.enum(['source', 'zip']), ownerHash: hex, taskRootId: z.string(),
  operationKey: z.string(), sourceHash: hex, argsHash: hex }).strict()
export const exportFilePointerSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}\.(source|zip)$/), sha256: hex,
  bytes: z.number().int().positive().max(EXPORT_SOURCE_BYTES + 1024), bodyBytes: z.number().int().nonnegative().max(EXPORT_SOURCE_BYTES) }).strict()
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const maximum = (kind: Kind) => kind === 'source' ? EXPORT_SOURCE_BYTES : EXPORT_ZIP_BYTES
const key = (identity: ExportFileIdentity, kind: Kind) => `${digest(JSON.stringify({ ...exportIdentitySchema.parse(identity), kind }))}.${kind}`
const header = (identity: ExportFileIdentity, kind: Kind) => headerSchema.parse({ version: 1, kind, ownerHash: digest(identity.userId),
  taskRootId: identity.taskRootId, operationKey: identity.operationKey, sourceHash: identity.sourceHash, argsHash: identity.argsHash })
const sealMagic = Buffer.from('CINKEX01')

async function filename(identity: ExportFileIdentity, kind: Kind) {
  const root = path.resolve(process.env.AGENT_EXPORT_DIR || (process.env.APP_ENV === 'production'
    ? path.resolve(process.cwd(), '..', '..', 'shared', 'private-agent-exports') : path.resolve(process.cwd(), '..', 'private-agent-exports')))
  if (root.split(path.sep).some(part => /^(public|uploads|private-novel-imports|private-agent-image-responses)$/i.test(part))) return runtimeError('RUNTIME_STORAGE_UNSAFE', '导出私有存储配置不可用。')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (path.relative(root, await realpath(root)) !== '') return runtimeError('RUNTIME_STORAGE_UNSAFE', '导出私有存储路径不可用。')
  const metadata = await stat(root)
  if (!metadata.isDirectory() || process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) return runtimeError('RUNTIME_STORAGE_UNSAFE', '导出私有目录权限不可用。')
  return path.join(root, key(identity, kind))
}

async function load(identity: ExportFileIdentity, kind: Kind, expected?: z.infer<typeof exportFilePointerSchema>) {
  const target = await filename(identity, kind)
  let handle
  try {
    if (path.relative(target, await realpath(target)) !== '') return runtimeError('RUNTIME_STORAGE_UNSAFE', '导出私有文件路径不可用。')
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (!expected && error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const metadata = await handle.stat(), limit = maximum(kind) + 1024
    if (!metadata.isFile() || metadata.size > limit || metadata.size < 49) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件大小无效。')
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) return runtimeError('RUNTIME_STORAGE_UNSAFE', '原导出文件权限不可用。')
    const chunks: Buffer[] = []; let bytes = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - bytes)), result = await handle.read(chunk, 0, chunk.length, null)
      if (!result.bytesRead) break
      chunks.push(chunk.subarray(0, result.bytesRead)); bytes += result.bytesRead
      if (bytes > limit) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '原导出文件超过技术上限，未截取稿件。')
    }
    const buffer = Buffer.concat(chunks, bytes), separator = buffer.indexOf(10)
    if (separator < 0 || separator > 1024) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件不完整。')
    const saved = headerSchema.parse(JSON.parse(buffer.subarray(0, separator).toString('utf8')))
    if (JSON.stringify(saved) !== JSON.stringify(header(identity, kind))) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原导出文件不属于此任务。')
    const body = buffer.subarray(separator + 1, buffer.length - 48), seal = buffer.subarray(buffer.length - 48)
    if (body.length > maximum(kind)) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '原导出文件超过技术上限。')
    if (!seal.subarray(0, 8).equals(sealMagic) || seal.readBigUInt64BE(40) !== BigInt(body.length)
      || seal.subarray(8, 40).toString('hex') !== digest(body)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件完整性校验失败。')
    const pointer = exportFilePointerSchema.parse({ key: key(identity, kind), sha256: digest(buffer), bytes, bodyBytes: body.length })
    if (expected && JSON.stringify(pointer) !== JSON.stringify(exportFilePointerSchema.parse(expected))) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件与保存回执不一致。')
    return { pointer, body }
  } finally { await handle.close() }
}

async function store(identity: ExportFileIdentity, kind: Kind, body: Uint8Array) {
  if (body.byteLength > maximum(kind)) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '导出超过单对象技术上限，未截取稿件。')
  const target = await filename(identity, kind), temporary = `${target}.${randomUUID()}.part`
  const prefix = Buffer.from(`${JSON.stringify(header(identity, kind))}\n`), seal = Buffer.alloc(48)
  sealMagic.copy(seal); createHash('sha256').update(body).digest().copy(seal, 8); seal.writeBigUInt64BE(BigInt(body.byteLength), 40)
  const pointer = exportFilePointerSchema.parse({ key: key(identity, kind), sha256: createHash('sha256').update(prefix).update(body).update(seal).digest('hex'),
    bytes: prefix.length + body.byteLength + seal.length, bodyBytes: body.byteLength })
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(prefix); await handle.writeFile(body); await handle.writeFile(seal); await handle.sync(); await handle.close()
    try { await link(temporary, target) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      // An unpublished source has no paid work yet: the first complete capture
      // wins. A ZIP must instead reproduce the same original bytes exactly.
      await load(identity, kind, kind === 'zip' ? pointer : undefined)
    }
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined) // Only this call's unpublished temporary.
  }
  const saved = await load(identity, kind, kind === 'zip' ? pointer : undefined)
  if (!saved) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '导出文件发布结果尚未核实。')
  return saved
}

function failed(error: unknown): never {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('RUNTIME_')) throw error
  if (error instanceof z.ZodError || error instanceof SyntaxError) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件格式无效。')
  return runtimeError('RUNTIME_STORAGE_UNAVAILABLE', '导出私有存储暂不可用，原结果保留。')
}
export async function readExportFile(identity: ExportFileIdentity, kind: Kind, expected?: z.infer<typeof exportFilePointerSchema>) {
  try { return await load(exportIdentitySchema.parse(identity), kindSchema.parse(kind), expected) } catch (error) { return failed(error) }
}
export async function storeExportFile(identity: ExportFileIdentity, kind: Kind, body: Uint8Array) {
  try { return await store(exportIdentitySchema.parse(identity), kindSchema.parse(kind), body) } catch (error) { return failed(error) }
}
export async function prepareExportStorage(identity: ExportFileIdentity) {
  try {
    const probe = `${await filename(exportIdentitySchema.parse(identity), 'zip')}.${randomUUID()}.probe`
    const handle = await open(probe, 'wx', 0o600)
    try { await handle.sync() } finally { await handle.close(); await unlink(probe) }
  } catch (error) { return failed(error) }
}
