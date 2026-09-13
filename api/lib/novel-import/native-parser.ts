import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  decodeWorkerResponse, DocumentWorkerError, WORKER_LIMITS, WORKER_VERSION,
  workerRequestSchema, workerResponseSchema, type DocumentWorkerResult, type WorkerPage,
} from '../../../workers/document-import/protocol.js'
import { NovelImportParseError, type ParsedNovelImport } from './parser.js'
import { createIsolatedNovelImportParser, parseNovelImportFileIsolated } from './isolated-parser.js'
import { stableImportId } from './parsers/images.js'
import { checkStructure, hasUnsafeControls, limit, NOVEL_IMPORT_LIMITS, ParseContext } from './parsers/limits.js'
import { parseText } from './parsers/text.js'
import { emptyImport } from './parsers/types.js'
import type { DocumentWorkerInput } from './worker-client.js'

export type NativeNovelImportSource = {
  filename: string
  sourceId: string
  sourceHash: string
  format: DocumentWorkerInput['format']
}
export type NativeNovelImportPreview = {
  parsed: ParsedNovelImport
  /** Retain this alongside the original source in private storage, not in an Agent reply.
   * Includes original block text, duplicateOf evidence, coordinates and artifact bytes.
   * Returning bytes is NOT proof that attachments have been stored or made viewable.
   */
  native: DocumentWorkerResult
}
export type NativeDocumentImportWorker = {
  run(input: DocumentWorkerInput): Promise<DocumentWorkerResult>
}
export type NativeNovelImportOptions = {
  sourceId: string
  signal?: AbortSignal
  timeoutMs?: number
  ocrLanguages?: DocumentWorkerInput['ocrLanguages']
}
export type NativeNovelImportParserConfig = {
  /** Trusted operator configuration only. Defaults OFF until real native/sandbox QA. */
  enabled?: boolean
  worker?: NativeDocumentImportWorker
}

const resultSchema = workerResponseSchema.extend({
  artifacts: z.array(workerResponseSchema.shape.artifacts.element.omit({ base64: true }).extend({
    bytes: z.instanceof(Uint8Array),
  })).max(WORKER_LIMITS.artifacts),
})

function sourceName(source: NativeNovelImportSource): string {
  if (!source.filename || source.filename.length > 2048 || hasUnsafeControls(source.filename)) {
    throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '原生解析来源文件名无效。')
  }
  return `${source.filename}#source=${source.sourceId}&sha256=${source.sourceHash}`
}

/** Reuses the worker's full integrity/coverage validator even for a fake/injected worker.
 * Coarse budgets run before schema cloning, base64 encoding or JSON serialization.
 */
function verifiedResult(input: DocumentWorkerResult, source: NativeNovelImportSource): DocumentWorkerResult {
  try {
    limit(Array.isArray(input.pages) && input.pages.length <= WORKER_LIMITS.pages &&
      Array.isArray(input.artifacts) && input.artifacts.length <= WORKER_LIMITS.artifacts,
    '原生解析页数或资源数超过限制。')
    let bytes = 0
    for (const artifact of input.artifacts) {
      if (!(artifact.bytes instanceof Uint8Array)) throw new Error('Invalid artifact bytes')
      bytes += artifact.bytes.byteLength
      limit(bytes <= WORKER_LIMITS.artifactBytes, '原生解析附件总量超过限制。')
    }
    let chars = 0
    let blocks = 0
    for (const page of input.pages) {
      limit(Array.isArray(page.blocks) && page.blocks.length <= 10_000 && Array.isArray(page.regions) && page.regions.length <= WORKER_LIMITS.regions, '原生解析页块数量超过限制。')
      blocks += page.blocks.length
      limit(blocks <= WORKER_LIMITS.blocks, '原生解析总块数超过限制。')
      for (const block of page.blocks) {
        if (typeof block.text !== 'string') throw new Error('Invalid block text')
        chars += block.text.length
        limit(chars <= WORKER_LIMITS.textChars, '原生解析原文超过 500 万字符。')
      }
    }
    const value = resultSchema.parse(input)
    const request = workerRequestSchema.parse({ version: WORKER_VERSION, requestId: value.requestId,
      sourceId: source.sourceId, sourceHash: source.sourceHash, format: source.format,
      timeoutMs: WORKER_LIMITS.nativeMs, ocrLanguages: 'chi_sim+eng' })
    const wire = Buffer.from(JSON.stringify({ ...value, artifacts: value.artifacts.map(({ bytes, ...artifact }) => ({
      ...artifact, base64: Buffer.from(bytes).toString('base64'),
    })) }))
    limit(wire.length <= WORKER_LIMITS.responseBytes, '原生解析结果超过协议大小限制。')
    return decodeWorkerResponse(wire, request)
  } catch (error) {
    if (error instanceof NovelImportParseError) throw error
    throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '原生解析结果的来源、资源或覆盖报告校验失败。')
  }
}

function addWarning(result: ParsedNovelImport, code: string, message: string, source: string, blocking = true) {
  result.warnings.push({ code, message, source, blocking })
  limit(result.warnings.length <= NOVEL_IMPORT_LIMITS.warnings, '原生解析警告数量超过安全限制。')
}

function pageText(page: WorkerPage, result: ParsedNovelImport, source: string): string {
  const original = page.blocks.filter((block) => !block.duplicateOf)
  const ordered = [...original].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] ||
    a.bbox[3] - b.bbox[3] || a.bbox[2] - b.bbox[2] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const reordered = ordered.some((block, index) => original[index] !== block)
  const adjacentColumnsOrOverlap = ordered.some((block, index) => {
    if (!index) return false
    const prior = ordered[index - 1]
    // Blocks with overlapping vertical ranges cannot safely establish a total reading order
    // just from y/x: they may be columns, overlapping OCR regions, or positioned dialogue.
    return Math.min(prior.bbox[3], block.bbox[3]) > Math.max(prior.bbox[1], block.bbox[1])
  })
  if (reordered || adjacentColumnsOrOverlap) addWarning(result, 'IMPORT_NATIVE_READING_ORDER_REVIEW', '已按页面坐标生成预览；块顺序变化、分栏或重叠可能影响阅读顺序，请对照原页。', source)
  for (const block of page.blocks) {
    if (block.duplicateOf) addWarning(result, 'IMPORT_NATIVE_DUPLICATE_BLOCK_EXCLUDED',
      `OCR 块 ${block.id} 按 duplicateOf=${block.duplicateOf} 从默认正文中排除；原始文字和依据保留在 native 结果中。`, `${source}&block=${block.id}`, true)
    if (block.method === 'ocr') addWarning(result, 'IMPORT_NATIVE_OCR_REVIEW', 'OCR 是待核验转录，置信度不能代替原文核对。', `${source}&block=${block.id}`)
  }
  // Preserve every non-duplicate block verbatim except newline normalization. No trimming,
  // fuzzy dedupe, OCR summarization or dropping native text from failed/review pages.
  return ordered.map((block) => block.text.replace(/\r\n?/g, '\n')).join('\n\n')
}

/** Maps a validated native result without running any worker or performing storage/network I/O.
 * The original result is returned for private persistence and provenance/duplicate inspection.
 * This helper does not enable the native feature or approve any import.
 */
export async function adaptNativeNovelImportResult(
  input: DocumentWorkerResult,
  source: NativeNovelImportSource,
  options: { signal?: AbortSignal; resources?: boolean } = {},
): Promise<NativeNovelImportPreview> {
  const context = new ParseContext(options.signal)
  await context.checkpoint()
  const origin = sourceName(source)
  const native = verifiedResult(input, source)
  let parsed = emptyImport()
  if (native.outcome === 'converted') {
    const artifact = native.artifacts.find((artifact) => artifact.id === native.convertedArtifactId)!
    // Protocol validation requires a DOC -> DOCX artifact here. Never dispatch .doc again.
    const parseConverted = options.resources ? createIsolatedNovelImportParser({ resources: true }) : parseNovelImportFileIsolated
    parsed = await parseConverted(Buffer.from(artifact.bytes), 'converted.docx', { signal: options.signal })
    const remap = (value: string) => `${origin}&converted=${artifact.id}${value.replace(/^converted\.docx/, '')}`
    for (const volume of parsed.volumes) for (const chapter of volume.chapters) chapter.source = remap(chapter.source)
    for (const warning of parsed.warnings) warning.source = warning.source ? remap(warning.source) : origin
    for (const image of parsed.images ?? []) {
      const priorId = image.id
      image.source = remap(image.source); image.id = stableImportId('image', image.source)
      for (const volume of parsed.volumes) for (const chapter of volume.chapters) {
        // Remap only generated image markers, never bare matching IDs in ordinary prose.
        chapter.content = chapter.content.split(`[图片来源：${priorId}]`).join(`[图片来源：${image.id}]`)
      }
    }
    addWarning(parsed, 'IMPORT_DOC_CONVERSION_REVIEW', 'DOC 已转换为 DOCX 并提取；转换不等于完整保真，请保留原 DOC、转换产物并核验正文与附件。', origin)
  } else {
    for (const page of native.pages) {
      await context.checkpoint()
      const pageSource = `${origin}&page=${page.page}`
      const assembled = pageText(page, parsed, pageSource)
      if (assembled.length) {
        const pageParsed = parseText(Buffer.from(assembled, 'utf8'), pageSource, context, false, 'utf8')
        parsed.sourceChars += pageParsed.sourceChars
        // Pages are explicit source boundaries, not proof of chapter boundaries. Keep page
        // slices separate so no page provenance is replaced by a book-level filename.
        const fallback = pageParsed.warnings.some((warning) => warning.code === 'IMPORT_STRUCTURE_FALLBACK')
        if (fallback) for (const volume of pageParsed.volumes) for (const chapter of volume.chapters) chapter.title = `第 ${page.page} 页（待分章）`
        for (const volume of pageParsed.volumes) {
          const previous = parsed.volumes[parsed.volumes.length - 1]
          if (previous && (volume.title === '正文卷' || volume.title === previous.title)) previous.chapters.push(...volume.chapters)
          else parsed.volumes.push(volume)
        }
        for (const warning of pageParsed.warnings) addWarning(parsed, warning.code, warning.message, warning.source ?? pageSource, warning.blocking)
        if (fallback && native.pages.length > 1) addWarning(parsed, 'IMPORT_NATIVE_PAGE_BOUNDARIES_REVIEW', '本页未识别章节标题，分页不等于分章；请确认续章或合并边界。', pageSource)
      }
      if (page.state === 'failed') addWarning(parsed, 'IMPORT_NATIVE_PAGE_FAILED', `第 ${page.page} 页处理失败；已返回的文字仍保留，不视为完整页面。`, pageSource)
      else if (page.state === 'needs_review') addWarning(parsed, 'IMPORT_NATIVE_PAGE_REVIEW', `第 ${page.page} 页存在识别或完整性疑点，需要核验。`, pageSource)
      else if (page.state === 'verified_blank') addWarning(parsed, 'IMPORT_NATIVE_VERIFIED_BLANK', `第 ${page.page} 页由 worker 标记为空白，未生成正文。`, pageSource, false)
      else if (!assembled.trim()) addWarning(parsed, 'IMPORT_NATIVE_PAGE_EMPTY', `第 ${page.page} 页未取得可读正文，不能据此认定为空白。`, pageSource)
      for (const code of page.warnings) addWarning(parsed, code, `原生页面警告：${code}。`, pageSource)
      for (const region of page.regions) {
        const regionSource = `${pageSource}&region=${region.id}`
        addWarning(parsed, region.status === 'failed' ? 'IMPORT_NATIVE_REGION_FAILED' : 'IMPORT_NATIVE_REGION_REVIEW', '页面图像区域需要核验；未识别内容不能被普通文字层覆盖。', regionSource)
        if (!region.artifactId) addWarning(parsed, 'IMPORT_NATIVE_REGION_IMAGE_MISSING', '区域没有可用图像产物，需重新处理或显式排除。', regionSource)
        for (const code of region.warnings) addWarning(parsed, code, `原生区域警告：${code}。`, regionSource)
      }
      checkStructure(parsed)
    }
  }
  for (const code of native.warnings) addWarning(parsed, code, `原生转换警告：${code}。`, origin)
  if (native.outcome === 'failed') addWarning(parsed, native.error ?? 'IMPORT_NATIVE_WORKER_FAILED', '原生处理失败；已取得的产物仅供诊断预览，不可视为完整导入。', origin)
  for (const artifact of native.artifacts) if (artifact.mediaType === 'image/png') {
    addWarning(parsed, 'IMPORT_NATIVE_ARTIFACT_UNSTORED', '图片字节已保留在 native.artifacts，但适配器未写入私有附件存储；尚不能作为可查看附件导入。', `${origin}&artifact=${artifact.id}`)
  }
  if (native.totalPages === null) addWarning(parsed, 'IMPORT_NATIVE_COVERAGE_UNKNOWN', '原生处理未提供可核对的总页数；未知不等于零页或完整。', origin)
  else {
    const counts = native.coverage.counts
    addWarning(parsed, 'IMPORT_NATIVE_COVERAGE', `共 ${native.totalPages} 页；原生 ${counts.native} 页，OCR ${counts.ocr} 页，待核 ${counts.needs_review} 页，失败 ${counts.failed} 页，确认空白 ${counts.verified_blank} 页。`, origin, !native.coverage.complete)
  }
  if (!native.coverage.complete) addWarning(parsed, 'IMPORT_NATIVE_INCOMPLETE_CONTENT', '原生覆盖报告未完成，不能默认提交完整导入。', origin)
  for (const volume of parsed.volumes) for (const chapter of volume.chapters) if (chapter.content.length > 100_000) {
    addWarning(parsed, 'IMPORT_CHAPTER_TOO_LARGE', '单章超过 10 万字符，请拆章；原文未截断。', chapter.source)
  }
  if (!parsed.volumes.some((volume) => volume.chapters.some((chapter) => chapter.content.trim()))) addWarning(parsed, 'IMPORT_NO_BODY', '没有非空正文，不能导入或覆盖作品。', origin)
  parsed.parserVersion = `${parsed.parserVersion}+native-adapter-1+${native.parserVersion}`
  checkStructure(parsed)
  context.check()
  return { parsed, native }
}

function nativeFormat(filename: string): DocumentWorkerInput['format'] {
  if (/\.doc$/i.test(filename)) return 'doc'
  if (/\.pdf$/i.test(filename)) return 'pdf'
  if (/\.(?:png|jpe?g)$/i.test(filename)) return 'image'
  throw new NovelImportParseError('IMPORT_UNSUPPORTED_FORMAT', '原生适配器仅处理 DOC、PDF 或本地图像；DOCX/TXT/MD 请使用确定性解析入口。')
}

/** Optional server-side integration. No commands, image names, paths or env switches are
 * accepted through per-file options; provide an already-configured worker from trusted code.
 * The original deterministic parser is unchanged and DOC remains unsupported there.
 */
export function createNativeNovelImportParser(config: NativeNovelImportParserConfig = {}) {
  const enabled = config.enabled === true
  const worker = config.worker
  return async (buffer: Buffer, filename: string, options: NativeNovelImportOptions): Promise<NativeNovelImportPreview> => {
    if (!enabled || !worker) throw new NovelImportParseError('IMPORT_NATIVE_DISABLED', '原生转换/OCR 功能默认关闭，真实环境验收前不得启用。')
    if (options.signal?.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
    limit(buffer.length > 0 && buffer.length <= WORKER_LIMITS.inputBytes, '原生解析源文件为空或超过 50 MiB。')
    const bytes = Buffer.from(buffer)
    const source: NativeNovelImportSource = { filename, sourceId: options.sourceId,
      sourceHash: createHash('sha256').update(bytes).digest('hex'), format: nativeFormat(filename) }
    sourceName(source)
    const request = workerRequestSchema.safeParse({ version: WORKER_VERSION, requestId: 'adapter',
      sourceId: source.sourceId, sourceHash: source.sourceHash, format: source.format,
      timeoutMs: options.timeoutMs ?? WORKER_LIMITS.nativeMs, ocrLanguages: options.ocrLanguages ?? 'chi_sim+eng' })
    if (!request.success) throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '原生解析来源或选项无效。')
    const controller = new AbortController()
    let rejectStop: ((error: Error) => void) | undefined
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject })
    const stop = (code: string) => {
      controller.abort()
      rejectStop?.(new NovelImportParseError(code, code === 'IMPORT_CANCELLED' ? '文档解析已取消。' : '原生解析超过截止时间。'))
    }
    const abort = () => stop('IMPORT_CANCELLED')
    const timer = setTimeout(() => stop('IMPORT_DEADLINE_EXCEEDED'), request.data.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (options.signal?.aborted) abort()
      const input: DocumentWorkerInput = { sourceId: source.sourceId, sourceHash: source.sourceHash,
        format: source.format, bytes, signal: controller.signal,
        timeoutMs: request.data.timeoutMs, ocrLanguages: request.data.ocrLanguages }
      const result = await Promise.race([worker.run(input), stopped])
      if (controller.signal.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
      return await Promise.race([adaptNativeNovelImportResult(result, source, { signal: controller.signal }), stopped])
    } catch (error) {
      if (error instanceof NovelImportParseError) throw error
      if (error instanceof DocumentWorkerError) throw new NovelImportParseError(error.code, '原生 worker 未完成处理，请检查功能配置或返回的错误码。')
      throw new NovelImportParseError('IMPORT_NATIVE_WORKER_FAILED', '原生 worker 调用失败，未使用本机转换或模型兜底。')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
}
