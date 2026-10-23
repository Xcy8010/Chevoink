import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { runtimeError } from './runtime-common.js'

// Separate from import staging/GC and all public/static directories. Files are
// provider evidence: no TTL or opportunistic deletion of completed responses.
export const IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024
const headerSchema = z.object({ version: z.literal(1), ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
  attemptId: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), httpStatus: z.number().int().min(100).max(599) }).strict()
export type ImageResponseIdentity = { userId: string; attemptId: string; requestHash: string }
export const imageBlobSchema = z.object({ storageKey: z.string().regex(/^[a-f0-9]{64}\.blob$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(IMAGE_RESPONSE_BYTES + 1024),
  httpStatus: z.number().int().min(100).max(599) }).strict()
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const sealMagic = Buffer.from('CINKIM01')
const key = (identity: ImageResponseIdentity) => `${digest(`${identity.userId}:${identity.attemptId}`)}.blob`
const header = (identity: ImageResponseIdentity, httpStatus: number) => headerSchema.parse({ version: 1,
  ownerHash: digest(identity.userId), attemptId: identity.attemptId, requestHash: identity.requestHash, httpStatus })

async function filename(storageKey: string) {
  if (!/^[a-f0-9]{64}\.blob$/.test(storageKey)) return runtimeError('RUNTIME_RECEIPT_INVALID', '图片响应存储身份无效。')
  const root = path.resolve(process.env.AGENT_IMAGE_RESPONSE_DIR || (process.env.APP_ENV === 'production'
    ? path.resolve(process.cwd(), '..', '..', 'shared', 'private-agent-image-responses') : path.resolve(process.cwd(), '..', 'private-agent-image-responses')))
  if (root.split(path.sep).some(part => /^(public|uploads|private-novel-imports)$/i.test(part))) return runtimeError('RUNTIME_STORAGE_UNSAFE', '图片响应私有存储配置不可用。')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (await realpath(root) !== root) return runtimeError('RUNTIME_STORAGE_UNSAFE', '图片响应私有存储配置不可用。')
  const rootStat = await stat(root)
  if (!rootStat.isDirectory() || process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0) return runtimeError('RUNTIME_STORAGE_UNSAFE', '图片响应私有目录权限不可用。')
  return path.join(root, storageKey)
}

/** Detect an already unavailable private disk before committing paid dispatch.
 * This grants no network right and cannot promise future disk capacity. */
async function prepareStorage(identity: ImageResponseIdentity) {
  const probe = `${await filename(key(identity))}.${randomUUID()}.probe`
  const handle = await open(probe, 'wx', 0o600)
  try { await handle.sync() }
  finally { await handle.close(); await unlink(probe) }
}

/** DB-owned identity only. An atomically published file can repair a lost DB
 * result write; partial .part files are never accepted as completed responses. */
async function readResponse(identity: ImageResponseIdentity, expected?: z.infer<typeof imageBlobSchema>) {
  const target = await filename(key(identity))
  let handle
  try {
    if (await realpath(target) !== target) return runtimeError('RUNTIME_STORAGE_UNSAFE', '图片响应存储路径无效。')
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (!expected && error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const file = await handle.stat(), size = file.size
    if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) return runtimeError('RUNTIME_STORAGE_UNSAFE', '图片原响应文件权限不可用。')
    if (!file.isFile() || size < 48 || size > IMAGE_RESPONSE_BYTES + 1024) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '图片原响应大小无效。')
    const chunks: Buffer[] = []; let bytes = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, IMAGE_RESPONSE_BYTES + 1025 - bytes))
      const result = await handle.read(chunk, 0, chunk.length, null)
      if (!result.bytesRead) break
      chunks.push(chunk.subarray(0, result.bytesRead)); bytes += result.bytesRead
      if (bytes > IMAGE_RESPONSE_BYTES + 1024) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '图片原响应超过大小上限。')
    }
    const buffer = Buffer.concat(chunks, bytes), separator = buffer.indexOf(10)
    if (separator < 0 || separator > 1024) return runtimeError('RUNTIME_RECEIPT_INVALID', '图片原响应不完整。')
    const saved = headerSchema.parse(JSON.parse(buffer.subarray(0, separator).toString('utf8')))
    if (JSON.stringify(saved) !== JSON.stringify(header(identity, saved.httpStatus))) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '图片原响应不属于原请求。')
    const pointer = imageBlobSchema.parse({ storageKey: key(identity), sha256: digest(buffer), bytes, httpStatus: saved.httpStatus })
    const body = buffer.subarray(separator + 1, buffer.length - 48), seal = buffer.subarray(buffer.length - 48)
    if (!seal.subarray(0, 8).equals(sealMagic) || seal.readBigUInt64BE(40) !== BigInt(body.length)
      || seal.subarray(8, 40).toString('hex') !== digest(body)) return runtimeError('RUNTIME_RECEIPT_INVALID', '图片原响应缺少完整校验封记。')
    if (expected && JSON.stringify(imageBlobSchema.parse(expected)) !== JSON.stringify(pointer)) return runtimeError('RUNTIME_RECEIPT_INVALID', '图片原响应校验失败。')
    return { pointer, body: body.toString('utf8') }
  } finally { await handle.close() }
}

async function storeResponse(identity: ImageResponseIdentity, httpStatus: number, stream: AsyncIterable<Uint8Array>) {
  const target = await filename(key(identity)), temporary = `${target}.${randomUUID()}.part`
  const handle = await open(temporary, 'wx', 0o600)
  const bodyHash = createHash('sha256'), fileHash = createHash('sha256'), prefix = Buffer.from(`${JSON.stringify(header(identity, httpStatus))}\n`)
  let bytes = 0
  try {
    await handle.writeFile(prefix); fileHash.update(prefix)
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      if (bytes > IMAGE_RESPONSE_BYTES) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '图片原响应超过大小上限，已保留未知调用状态。')
      bodyHash.update(chunk); fileHash.update(chunk)
      await handle.writeFile(chunk)
    }
    const seal = Buffer.alloc(48); sealMagic.copy(seal); bodyHash.digest().copy(seal, 8); seal.writeBigUInt64BE(BigInt(bytes), 40)
    await handle.writeFile(seal); fileHash.update(seal)
    await handle.sync()
    await handle.close()
    // Exclusive publication: neither an old completed response nor another
    // attempt can be overwritten, even after an uncertain result commit.
    const expected = imageBlobSchema.parse({ storageKey: key(identity), sha256: fileHash.digest('hex'), bytes: prefix.length + bytes + seal.length, httpStatus })
    try { await link(temporary, target) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      await readImageResponse(identity, expected)
    }
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined) // Only this unpublished temp.
  }
  const saved = await readImageResponse(identity)
  if (!saved) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '图片响应已写入但尚未核实。')
  return saved
}

function storageFailure(error: unknown): never {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('RUNTIME_')) throw error
  if (error instanceof z.ZodError || error instanceof SyntaxError) return runtimeError('RUNTIME_RECEIPT_INVALID', '图片原响应格式校验失败。')
  return runtimeError('RUNTIME_STORAGE_UNAVAILABLE', '图片响应私有存储暂不可用，原调用状态保留。')
}
export async function prepareImageResponseStorage(identity: ImageResponseIdentity) {
  try { await prepareStorage(identity) } catch (error) { return storageFailure(error) }
}
export async function readImageResponse(identity: ImageResponseIdentity, expected?: z.infer<typeof imageBlobSchema>) {
  try { return await readResponse(identity, expected) } catch (error) { return storageFailure(error) }
}
export async function storeImageResponse(identity: ImageResponseIdentity, httpStatus: number, stream: AsyncIterable<Uint8Array>) {
  try { return await storeResponse(identity, httpStatus, stream) } catch (error) { return storageFailure(error) }
}
