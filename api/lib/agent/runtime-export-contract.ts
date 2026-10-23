import { z } from 'zod'
import { tokenPriceSchema } from '../billing/token-price.js'
import { exportFilePointerSchema, exportIdentitySchema, EXPORT_ZIP_BYTES, readExportFile } from '../export-private-storage.js'
import { type NovelExportSnapshot } from '../export-service.js'
import { auxiliaryRouteSchema } from './runtime-auxiliary-call.js'
import { runtimeError, runtimeJson } from './runtime-common.js'

export const publishAdviceValueSchema = z.object({ channel: z.enum(['男频', '女频']), mainCategory: z.string(), themeTags: z.array(z.string()), roleTags: z.array(z.string()),
  plotTags: z.array(z.string()), contentPlotTags: z.array(z.string()), contentRoleTags: z.array(z.string()), contentEmotionTags: z.array(z.string()),
  contentWorldviewTags: z.array(z.string()), protagonists: z.array(z.string()), summary: z.string() }).strict()
export const publishAdviceInputSchema = z.object({ novelId: z.string(), title: z.string(), summary: z.string(), genre: z.string(), tags: z.array(z.string()), sampleText: z.string().max(1500) }).strict()
export const exportSnapshotSchema = z.object({ entries: z.array(z.object({ path: z.string(), data: z.string() }).strict()).max(65535),
  fileName: z.string(), summary: z.string(), zipStamp: z.object({ time: z.number().int().min(0).max(65535), date: z.number().int().min(0).max(65535) }).strict(),
  advice: z.object({ path: z.string(), title: z.string(), fingerprint: z.string(), input: publishAdviceInputSchema, cached: publishAdviceValueSchema.nullable() }).strict().nullable() }).strict()
export const exportSourceSchema = z.object({ version: z.literal(1), novelId: z.string(), capturedAt: z.string().datetime(), snapshot: exportSnapshotSchema }).strict()
export const exportAdviceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('omitted') }).strict(),
  z.object({ kind: z.literal('cached'), advice: publishAdviceValueSchema }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.string() }).strict(),
  z.object({ kind: z.literal('generate'), input: publishAdviceInputSchema, system: z.string(), content: z.string(), route: auxiliaryRouteSchema, price: tokenPriceSchema }).strict(),
])
export const exportWorkSchema = z.object({ version: z.literal(1), novelId: z.string(), exportId: z.string().uuid(), identity: exportIdentitySchema,
  source: exportFilePointerSchema, advice: exportAdviceSchema, fileName: z.string(), summary: z.string() }).strict()
export type ExportWork = z.infer<typeof exportWorkSchema>
const safePath = (value: string) => !!value && Buffer.byteLength(value, 'utf8') <= 65535 && !value.startsWith('/') && !/[\\\p{Cc}]/u.test(value)
  && value.split('/').every(part => !!part && part !== '.' && part !== '..')

/** Explicit technical budget, checked before optional advice dispatch. No
 * manuscript truncation, Zip64 guessing or large payload in operation JSON. */
export function assertExportCapacity(snapshot: NovelExportSnapshot) {
  let bytes = 22
  const paths = new Set<string>()
  for (const entry of snapshot.entries) {
    const name = Buffer.byteLength(entry.path, 'utf8')
    if (paths.has(entry.path) || !safePath(entry.path)
      || Buffer.from(entry.data, 'base64').toString('base64') !== entry.data) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出条目无效，未截取或覆盖内容。')
    paths.add(entry.path); bytes += 76 + name * 2 + Buffer.byteLength(entry.data, 'base64')
  }
  // Advice is bounded by the existing provider result budget; reserve it before
  // spending rather than discovering a full output disk after a model request.
  if (snapshot.advice) {
    if (!safePath(snapshot.advice.path) || paths.has(snapshot.advice.path)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原发布建议文件路径无效。')
    bytes += 2 * 1024 * 1024 + 76 + 2 * Buffer.byteLength(snapshot.advice.path, 'utf8')
  }
  if (snapshot.entries.length + Number(!!snapshot.advice) > 65535 || bytes > EXPORT_ZIP_BYTES) return runtimeError('RUNTIME_PAYLOAD_TOO_LARGE', '导出超过单包技术上限，请明确选择章节范围；本次没有截取稿件或请求模型。')
}

export async function readExportSource(work: ExportWork) {
  const saved = await readExportFile(work.identity, 'source', work.source)
  if (!saved) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原导出快照缺失，未重读当前稿件。')
  const source = parseExportSource(saved.body)
  if (source.novelId !== work.novelId || source.snapshot.fileName !== work.fileName || source.snapshot.summary !== work.summary) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出快照与父操作不一致。')
  const advice = work.advice, original = source.snapshot.advice
  if ((!original) !== (advice.kind === 'omitted') || original?.cached && advice.kind !== 'cached'
    || original && advice.kind === 'cached' && (!original.cached || runtimeJson(original.cached).hash !== runtimeJson(advice.advice).hash)
    || original && advice.kind === 'generate' && (original.cached !== null || runtimeJson(original.input).hash !== runtimeJson(advice.input).hash)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出建议分支已变化。')
  assertExportCapacity(source.snapshot)
  return source
}

export function parseExportSource(body: Uint8Array) {
  try { return exportSourceSchema.parse(JSON.parse(Buffer.from(body).toString('utf8'))) }
  catch { return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出快照格式无效，未重读当前稿件。') }
}

export const exportPublicationSchema = z.object({ version: z.literal(1), userId: z.string(), taskRootId: z.string(), parentOperationId: z.string(), parentInputHash: z.string(),
  exportId: z.string().uuid(), zip: exportFilePointerSchema, fileName: z.string(), summary: z.string(), publishedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  advice: z.discriminatedUnion('kind', [z.object({ kind: z.literal('ready'), advice: publishAdviceValueSchema }).strict(), z.object({ kind: z.enum(['unavailable', 'credits_exhausted']) }).strict()]) }).strict()
export const EXPORT_TTL_MS = 15 * 60 * 1000
