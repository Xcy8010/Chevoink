import { Router, json, type Request, type Response, type NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { novelImportCommitSchema, novelImportConfirmSchema, novelImportCreateSchema, novelImportIntentConfirmSchema, novelImportRestoreSchema, novelImportRestoreConfirmSchema } from '../../shared/contracts/novel-import.js'
import { analyzeNovelImport, attachNovelImportSource, authenticateNovelImportHuman, cancelNovelImport, commitNovelImport, confirmNovelImport, confirmNovelImportIntent, editNovelImportPreview, getNovelImportPreview, getNovelImportStatus, listNovelImports, novelImportCapabilities, preflightNovelImport, prepareNovelImport, previewNovelImportRestore, rebaseNovelImport, restoreNovelImport, uploadNovelImportSource, type NovelImportHuman } from '../lib/novel-import-service.js'
import { DataAccessError } from '../lib/prisma.js'
import { buildError, buildSuccess, createRequestId } from '../lib/http.js'
import { env } from '../config/env.js'
import { downloadNovelImportSource } from '../lib/novel-import-service.js'
import { importSuggestionQuoteSchema, importSuggestionSchema, listImportSuggestions, quoteImportSuggestion, requestImportSuggestion } from '../lib/novel-import/suggestions.js'
import { getNovelImportPreviewSummary, getNovelImportChapter, getNovelImportReport, downloadNovelImportImage, editNovelImportStructure, reviewNovelImportSources, getNovelImportRestorePreview, getNovelImportCapabilities } from '../lib/novel-import-service.js'

// Mount before a broad JSON parser to permit bounded full-preview edits without
// increasing the application's global JSON/Base64 limits. Raw uploads are streams.
const router = Router({ mergeParams: true })
router.use((req, res, next) => {
  try {
    res.locals.importHuman = authenticateNovelImportHuman(req)
    res.setHeader('Cache-Control', 'private, no-store')
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    const cancellation = req.method === 'POST' && /^\/[^/]+\/cancel$/.test(req.path)
    const restoration = req.method === 'POST' && /^\/[^/]+\/restore(?:-preview|-confirm)?$/.test(req.path)
    if (mutation && !cancellation && !restoration && !novelImportCapabilities().enabled) throw new DataAccessError(503, 'IMPORT_DISABLED', '作品导入尚未开放；仍可查看、下载原文件、取消任务或恢复已有导入。')
    // Cross-site script requests cannot mint approvals. JSON/raw content types
    // also prevent cross-site HTML forms from triggering mutation handlers.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site') throw new DataAccessError(403, 'IMPORT_APPROVAL_REQUIRED', '请从本站导入面板确认。')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin')
      if (origin) {
        let sameOrigin = false
        try { sameOrigin = origin === new URL(env.webUrl).origin } catch { /* Fail closed on invalid configured origin. */ }
        if (!sameOrigin) throw new DataAccessError(403, 'IMPORT_ORIGIN_INVALID', '请从本站导入面板操作。')
      }
      const rawUpload = req.method === 'PUT' && /^\/[^/]+\/source$/.test(req.path)
      if (!rawUpload && !req.is('application/json')) throw new DataAccessError(415, 'IMPORT_CONTENT_TYPE', '请使用 JSON 导入请求。')
    }
    next()
  } catch (error) { sendError(res, error) }
})
const smallJson = json({ limit: '16kb', strict: true, inflate: false })
const manifestJson = json({ limit: '32mb', strict: true, inflate: false })
const reviewJson = json({ limit: '2mb', strict: true, inflate: false })
router.use((req, res, next) => {
  // GET/download/raw source do not consume JSON at all. Only the manifest body
  // needs the large limit; every other mutation is bounded to 16 KiB.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || (req.method === 'PUT' && /^\/[^/]+\/source$/.test(req.path))) return next()
  if (req.method === 'POST' && /^\/[^/]+\/review$/.test(req.path)) return reviewJson(req, res, next)
  return (req.method === 'PATCH' && /^\/[^/]+\/(?:manifest|structure)$/.test(req.path) ? manifestJson : smallJson)(req, res, next)
})
router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 400
  res.status(status === 413 ? 413 : status === 415 ? 415 : 400).json(buildError(createRequestId(), status === 413 ? 'IMPORT_LIMIT_EXCEEDED' : 'IMPORT_INPUT_INVALID', '导入请求体无效或超过上限。'))
})
function sendError(res: Response, error: unknown) {
  const requestId = createRequestId()
  if (error instanceof DataAccessError) res.status(error.status).json(buildError(requestId, error.code, error.message))
  else if (error instanceof ZodError) res.status(400).json(buildError(requestId, 'IMPORT_INPUT_INVALID', '导入参数无效，请刷新后重试。'))
  else res.status(503).json(buildError(requestId, 'IMPORT_UNAVAILABLE', '导入服务暂时不可用，原作品未被此错误确认修改；请查询任务状态。'))
}
function route(fn: (req: Request, human: NovelImportHuman) => Promise<unknown> | unknown) {
  return (req: Request, res: Response) => {
    Promise.resolve().then(() => fn(req, res.locals.importHuman as NovelImportHuman)).then(data => res.json(buildSuccess(createRequestId(), data))).catch(error => sendError(res, error))
  }
}
const idSchema = z.string().uuid()
const id = (req: Request) => idSchema.parse(req.params.jobId)
router.get('/capabilities', route(() => getNovelImportCapabilities()))
router.get('/', route((_req, human) => listNovelImports(human)))
router.post('/preflight', route((req, human) => {
  const input = z.object({ origin: z.object({ runId: z.string().min(1).max(64), callId: z.string().min(1).max(255) }).strict().optional() }).strict().parse(req.body ?? {})
  return preflightNovelImport(human, input.origin)
}))
router.post('/intents/:intentId/confirm', route((req, human) => {
  const input = novelImportIntentConfirmSchema.parse(req.body)
  return confirmNovelImportIntent(human, idSchema.parse(req.params.intentId), input.step, input.targetHash)
}))
router.post('/', route((req, human) => {
  const input = novelImportCreateSchema.parse(req.body)
  return prepareNovelImport(human, input.intentId, input.modelSelection)
}))
router.get('/:jobId', route((req, human) => getNovelImportStatus(human, id(req))))
router.get('/:jobId/preview', route((req, human) => {
  const view = z.enum(['summary', 'full']).optional().parse(req.query.view)
  return view === 'summary' ? getNovelImportPreviewSummary(human, id(req)) : getNovelImportPreview(human, id(req))
}))
router.get('/:jobId/report', route((req, human) => getNovelImportReport(human, id(req))))
router.get('/:jobId/chapters/:volumeIndex/:chapterIndex', route((req, human) => {
  const ordinal = z.coerce.number().int().nonnegative().max(2000)
  return getNovelImportChapter(human, id(req), ordinal.parse(req.params.volumeIndex), ordinal.parse(req.params.chapterIndex), z.coerce.number().int().positive().parse(req.query.manifestRevision))
}))
router.patch('/:jobId/structure', route((req, human) => editNovelImportStructure(human, id(req), req.body)))
router.post('/:jobId/review', route((req, human) => reviewNovelImportSources(human, id(req), req.body)))
router.get('/:jobId/artifacts/:artifactId', (req, res) => {
  Promise.resolve().then(() => downloadNovelImportImage(res.locals.importHuman as NovelImportHuman, id(req), idSchema.parse(req.params.artifactId))).then(({ bytes }) => {
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Disposition', 'inline; filename="import-image.png"')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Content-Length', bytes.length)
    res.send(bytes)
  }).catch(error => sendError(res, error))
})
router.get('/:jobId/suggestions', route((req, human) => listImportSuggestions(human, id(req))))
router.post('/:jobId/suggestions/quote', route((req, human) => quoteImportSuggestion(human, id(req), importSuggestionQuoteSchema.parse(req.body))))
router.post('/:jobId/suggestions', route((req, human) => requestImportSuggestion(human, id(req), importSuggestionSchema.parse(req.body))))
router.get('/:jobId/source', (req, res) => {
  Promise.resolve().then(() => downloadNovelImportSource(res.locals.importHuman as NovelImportHuman, id(req))).then(source => {
    const encoded = encodeURIComponent(source.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="novel-import-source"; filename*=UTF-8''${encoded}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Length', source.bytes.length)
    res.send(source.bytes)
  }).catch(error => sendError(res, error))
})
router.put('/:jobId/source', route(async (req, human) => {
  if (!req.is('application/octet-stream') || (req.get('content-encoding') && req.get('content-encoding') !== 'identity')) throw new DataAccessError(415, 'IMPORT_CONTENT_TYPE', '请使用原始文件流上传。')
  const filename = z.string().min(1).max(255).parse(req.query.filename)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(); req.destroy() }, 120_000)
  const abort = () => controller.abort()
  req.once('aborted', abort)
  try { return await uploadNovelImportSource(human, id(req), filename, req, controller.signal) }
  finally { clearTimeout(timer); req.off('aborted', abort) }
}))
router.post('/:jobId/attachment', route((req, human) => attachNovelImportSource(human, id(req), z.object({ url: z.string().min(1).max(1024), runId: z.string().min(1).max(64) }).strict().parse(req.body))))
const analyzeSchema = z.object({ encoding: z.string().min(1).max(32).optional(), reparse: z.boolean().optional() }).strict()
router.post('/:jobId/analyze', route((req, human) => {
  const input = analyzeSchema.parse(req.body ?? {})
  return analyzeNovelImport(human, id(req), input.encoding, input.reparse)
}))
router.post('/:jobId/retry', route((req, human) => analyzeNovelImport(human, id(req), analyzeSchema.parse(req.body ?? {}).encoding)))
router.patch('/:jobId/manifest', route((req, human) => editNovelImportPreview(human, id(req), req.body)))
router.post('/:jobId/rebase', route((req, human) => rebaseNovelImport(human, id(req), z.object({ intentId: idSchema }).strict().parse(req.body).intentId)))
router.post('/:jobId/confirm', route((req, human) => confirmNovelImport(human, id(req), novelImportConfirmSchema.parse(req.body))))
router.post('/:jobId/commit', route((req, human) => commitNovelImport(human, id(req), novelImportCommitSchema.parse(req.body))))
router.post('/:jobId/cancel', route((req, human) => cancelNovelImport(human, id(req))))
router.get('/:jobId/restore-preview', route((req, human) => getNovelImportRestorePreview(human, id(req))))
router.post('/:jobId/restore-preview', route((req, human) => previewNovelImportRestore(human, id(req), novelImportRestoreConfirmSchema.parse(req.body).targetHash)))
router.post('/:jobId/restore-confirm', route((req, human) => previewNovelImportRestore(human, id(req), novelImportRestoreConfirmSchema.parse(req.body).targetHash)))
router.post('/:jobId/restore', route((req, human) => restoreNovelImport(human, id(req), novelImportRestoreSchema.parse(req.body))))
export default router
