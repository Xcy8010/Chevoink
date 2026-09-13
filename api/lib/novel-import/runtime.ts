import { createNovelImportPipeline, parseNovelImportDocument, type NovelImportPipelineOptions } from './pipeline.js'
import { createDocumentImportWorker, DocumentWorkerError, type DocumentWorkerHealth } from './worker-client.js'
import { NovelImportParseError } from './parsers/types.js'

export type DocumentImportReadiness = { enabled: boolean; configured: boolean; ready: boolean;
  checkedAt?: string; parserVersion?: string; code?: string }
type Runtime = { key: string; worker: ReturnType<typeof createDocumentImportWorker>;
  parse: ReturnType<typeof createNovelImportPipeline>; checkedAt: number; health?: DocumentWorkerHealth;
  probe?: Promise<DocumentImportReadiness>; busy: number }
let runtime: Runtime | undefined

function configuration(): Runtime | undefined {
  if (process.env.NOVEL_IMPORT_NATIVE_ENABLED !== 'true') return undefined
  const image = process.env.DOCUMENT_IMPORT_WORKER_IMAGE
  const stagingRoot = process.env.DOCUMENT_IMPORT_WORKER_STAGING_ROOT
  if (!image || !stagingRoot) throw new DocumentWorkerError('IMPORT_WORKER_UNAVAILABLE')
  const key = JSON.stringify([image, stagingRoot])
  if (runtime?.key === key) return runtime
  // Config changes must not start a second client while the old one owns native work.
  if (runtime?.busy || runtime?.probe) throw new DocumentWorkerError('IMPORT_WORKER_UNAVAILABLE')
  const worker = createDocumentImportWorker({ image, stagingRoot })
  runtime = { key, worker, parse: createNovelImportPipeline({ native: { enabled: true, worker } }), checkedAt: 0, busy: 0 }
  return runtime
}

/** Readiness is based on a real bounded native probe, never just an environment flag.
 * Internal command/capability cache only; do not expose a public worker health endpoint.
 * No host paths, credentials or user source in DTO. */
export async function getDocumentImportReadiness(): Promise<DocumentImportReadiness> {
  if (process.env.NOVEL_IMPORT_NATIVE_ENABLED !== 'true') return { enabled: false, configured: false, ready: false }
  let current: Runtime
  try { current = configuration()! }
  catch (error) { return { enabled: true, configured: false, ready: false, code: error instanceof DocumentWorkerError ? error.code : 'IMPORT_WORKER_UNAVAILABLE' } }
  const ready = (): DocumentImportReadiness => ({ enabled: true, configured: true, ready: true,
    checkedAt: new Date(current.checkedAt).toISOString(), parserVersion: current.health!.parserVersion })
  if (current.health && (current.busy || Date.now() - current.checkedAt < 60_000)) return ready()
  if (current.probe) return current.probe
  current.probe = current.worker.health().then(health => {
    current.health = health; current.checkedAt = Date.now(); return ready()
  }, error => {
    current.health = undefined; current.checkedAt = Date.now()
    return { enabled: true, configured: true, ready: false, checkedAt: new Date(current.checkedAt).toISOString(),
      code: error instanceof DocumentWorkerError ? error.code : 'IMPORT_WORKER_UNAVAILABLE' }
  }).finally(() => { current.probe = undefined })
  return current.probe
}

/** Service runParse entry: keeps its durable lease/epoch/signal semantics. No DB/AI here. */
export async function parseConfiguredNovelImportDocument(buffer: Buffer, filename: string, options: NovelImportPipelineOptions) {
  if (options.signal?.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= Date.now()))
    throw new NovelImportParseError('IMPORT_DEADLINE_EXCEEDED', '解析任务已到达持久截止时间。')
  if (/\.(?:txt|md)$/i.test(filename)) return parseNovelImportDocument(buffer, filename, options)
  const current = configuration()
  if (!current) return parseNovelImportDocument(buffer, filename, options)
  const readiness = await getDocumentImportReadiness()
  if (options.signal?.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
  if (!readiness.ready) throw new NovelImportParseError(readiness.code ?? 'IMPORT_WORKER_UNAVAILABLE', '隔离文档工作器未就绪，请稍后重试。')
  if (current.busy) throw new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', '文档工作器正在处理其他任务，请稍后重新解析；已上传原文件仍保留。')
  current.busy++
  try { return await current.parse(buffer, filename, options) }
  finally { current.busy-- }
}
