import { createHash } from 'node:crypto'
import { z } from 'zod'

export const WORKER_VERSION = 'document-import/1'
export const WORKER_LIMITS = Object.freeze({
  inputBytes: 50 * 1024 * 1024, responseBytes: 64 * 1024 * 1024,
  artifactBytes: 32 * 1024 * 1024, imageBytes: 4 * 1024 * 1024,
  artifacts: 128, pixels: 20_000_000, pages: 1000, regions: 64,
  textChars: 5_000_000, pageTextChars: 100_000, blocks: 100_000,
  taskMs: 30 * 60 * 1000, nativeMs: 120_000, ocrMs: 60_000,
})
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const bbox = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(([x0, y0, x1, y1]) => x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0)
export const workerRequestSchema = z.object({
  version: z.literal(WORKER_VERSION), requestId: id, sourceId: id, sourceHash: hash,
  format: z.enum(['doc', 'pdf', 'image']),
  timeoutMs: z.number().int().min(1000).max(WORKER_LIMITS.taskMs),
  ocrLanguages: z.enum(['chi_sim+eng', 'chi_tra+eng', 'eng']),
}).strict()
export type WorkerRequest = z.infer<typeof workerRequestSchema>
export const workerErrorSchema = z.enum([
  'IMPORT_PROTOCOL_INVALID', 'FILE_TYPE_MISMATCH', 'IMPORT_LIMIT_EXCEEDED',
  'IMPORT_PASSWORD_REQUIRED', 'IMPORT_CONVERT_FAILED', 'IMPORT_PARSE_FAILED',
  'IMPORT_OCR_FAILED', 'IMPORT_DEADLINE_EXCEEDED', 'IMPORT_CANCELLED',
  'IMPORT_WORKER_UNAVAILABLE', 'IMPORT_SANDBOX_REQUIRED', 'IMPORT_CLEANUP_FAILED',
])
export type WorkerErrorCode = z.infer<typeof workerErrorSchema>
export class DocumentWorkerError extends Error {
  constructor(public readonly code: WorkerErrorCode) { super(code); this.name = 'DocumentWorkerError' }
}
const warning = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)
const artifactSchema = z.object({
  id, mediaType: z.enum(['image/png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  sha256: hash, byteLength: z.number().int().positive().max(WORKER_LIMITS.artifactBytes),
  base64: z.string().max(Math.ceil(WORKER_LIMITS.artifactBytes / 3) * 4),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
}).strict()
const blockSchema = z.object({
  id, method: z.enum(['native', 'ocr']), text: z.string().max(WORKER_LIMITS.pageTextChars), bbox,
  confidence: z.number().min(0).max(100).nullable(), regionId: id.nullable(),
  duplicateOf: id.nullable(),
}).strict()
const regionSchema = z.object({
  id, bbox, status: z.enum(['ocr', 'needs_review', 'failed']),
  artifactId: id.nullable(), warnings: z.array(warning).max(32),
}).strict()
export const pageStates = ['native', 'ocr', 'needs_review', 'failed', 'verified_blank'] as const
const pageSchema = z.object({
  page: z.number().int().min(1).max(WORKER_LIMITS.pages),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
  state: z.enum(pageStates), warnings: z.array(warning).max(32),
  blocks: z.array(blockSchema).max(10_000), regions: z.array(regionSchema).max(WORKER_LIMITS.regions),
}).strict()
export const workerResponseSchema = z.object({
  version: z.literal(WORKER_VERSION), requestId: id, sourceId: id, sourceHash: hash,
  format: z.enum(['doc', 'pdf', 'image']), parserVersion: z.literal('lo25.2-pymupdf1.25-tesseract5.5-prototype1'),
  outcome: z.enum(['converted', 'parsed', 'needs_review', 'failed']),
  error: workerErrorSchema.nullable(), warnings: z.array(warning).max(32),
  totalPages: z.number().int().min(0).max(WORKER_LIMITS.pages).nullable(),
  pages: z.array(pageSchema).max(WORKER_LIMITS.pages),
  artifacts: z.array(artifactSchema).max(WORKER_LIMITS.artifacts),
  convertedArtifactId: id.nullable(),
  coverage: z.object({ complete: z.boolean(), processedPages: z.number().int().nonnegative(),
    counts: z.object({ native: z.number().int().nonnegative(), ocr: z.number().int().nonnegative(),
      needs_review: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
      verified_blank: z.number().int().nonnegative() }).strict(),
  }).strict(),
}).strict()
export type WorkerResponse = z.infer<typeof workerResponseSchema>
export type WorkerPage = WorkerResponse['pages'][number]
export type WorkerArtifact = Omit<WorkerResponse['artifacts'][number], 'base64'> & { bytes: Uint8Array }
export type DocumentWorkerResult = Omit<WorkerResponse, 'artifacts'> & { artifacts: WorkerArtifact[] }

/** Treat even sandbox output as untrusted. No filename, URL or executable is accepted. */
export function decodeWorkerResponse(raw: Uint8Array, request: WorkerRequest): DocumentWorkerResult {
  const invalid = () => { throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID') }
  if (raw.byteLength > WORKER_LIMITS.responseBytes) return invalid()
  let result: WorkerResponse
  try { result = workerResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))) }
  catch { return invalid() }
  if (result.requestId !== request.requestId || result.sourceId !== request.sourceId ||
      result.sourceHash !== request.sourceHash || result.format !== request.format) return invalid()
  const artifacts: WorkerArtifact[] = []
  const artifactIds = new Set<string>()
  let artifactBytes = 0
  for (const a of result.artifacts) {
    if (artifactIds.has(a.id) || a.base64.length % 4 !== 0) return invalid()
    const bytes = Buffer.from(a.base64, 'base64')
    artifactBytes += bytes.length
    if (bytes.length !== a.byteLength || bytes.toString('base64') !== a.base64 ||
        createHash('sha256').update(bytes).digest('hex') !== a.sha256 || artifactBytes > WORKER_LIMITS.artifactBytes) return invalid()
    if (a.mediaType === 'image/png') {
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR' || !a.width || !a.height ||
          a.width !== bytes.readUInt32BE(16) || a.height !== bytes.readUInt32BE(20) ||
          a.width * a.height > WORKER_LIMITS.pixels || bytes.length > WORKER_LIMITS.imageBytes) return invalid()
    } else if (!bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) || a.width || a.height) return invalid()
    artifactIds.add(a.id)
    const { base64: _base64, ...metadata } = a
    artifacts.push({ ...metadata, bytes })
  }
  const counts = { native: 0, ocr: 0, needs_review: 0, failed: 0, verified_blank: 0 }
  let chars = 0; let blocks = 0
  const globalIds = new Set<string>()
  for (const [i, page] of result.pages.entries()) {
    if (page.page !== i + 1) return invalid()
    counts[page.state]++
    const regionIds = new Set(page.regions.map(r => r.id))
    const nativeIds = new Set(page.blocks.filter(b => b.method === 'native').map(b => b.id))
    for (const item of [...page.blocks, ...page.regions]) {
      if (globalIds.has(item.id) || item.bbox[2] > page.width + 1 || item.bbox[3] > page.height + 1) return invalid()
      globalIds.add(item.id)
    }
    for (const r of page.regions) if (r.artifactId && !artifactIds.has(r.artifactId)) return invalid()
    for (const b of page.blocks) {
      chars += b.text.length; blocks++
      if ((b.regionId && !regionIds.has(b.regionId)) || (b.duplicateOf && (b.method !== 'ocr' || !nativeIds.has(b.duplicateOf)))) return invalid()
    }
    if (page.blocks.reduce((sum, b) => sum + b.text.length, 0) > WORKER_LIMITS.pageTextChars) return invalid()
    if (page.state === 'verified_blank' && (page.blocks.length || page.regions.length || page.warnings.length)) return invalid()
    if (page.state === 'native' && (page.regions.length || page.warnings.length || !page.blocks.length || page.blocks.some(b => b.method !== 'native'))) return invalid()
    // Prototype OCR is never auto-approved, even with a high recognizer confidence.
    if (page.state === 'ocr') return invalid()
  }
  if (chars > WORKER_LIMITS.textChars || blocks > WORKER_LIMITS.blocks ||
      pageStates.some(s => counts[s] !== result.coverage.counts[s]) ||
      result.coverage.processedPages !== result.pages.length - counts.failed ||
      (result.totalPages !== null && result.pages.length !== result.totalPages) ||
      (result.totalPages === null && result.pages.length > 0)) return invalid()
  const complete = request.format !== 'doc' && result.totalPages !== null && result.totalPages > 0 &&
    !result.error && !result.warnings.length && !counts.failed && !counts.needs_review
  if (result.coverage.complete !== complete ||
      (result.outcome === 'parsed' && !complete) || (result.outcome === 'needs_review' && complete) || (result.outcome === 'failed' && !result.error) ||
      (result.outcome !== 'failed' && result.error)) return invalid()
  if (result.outcome === 'converted') {
    if (request.format !== 'doc' || result.totalPages !== null || result.pages.length || result.coverage.complete ||
        !result.convertedArtifactId || !artifacts.some(a => a.id === result.convertedArtifactId && a.mediaType.endsWith('document'))) return invalid()
  } else if (result.convertedArtifactId) return invalid()
  if (request.format !== 'doc' && artifacts.some(a => a.mediaType !== 'image/png')) return invalid()
  if (request.format === 'doc' && (result.pages.length || result.totalPages !== null ||
      (result.outcome !== 'converted' && result.outcome !== 'failed'))) return invalid()
  if (request.format === 'image' && result.totalPages !== null && result.totalPages !== 1) return invalid()
  return { ...result, artifacts }
}
