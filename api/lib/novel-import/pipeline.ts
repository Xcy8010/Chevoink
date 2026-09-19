import { createHash } from 'node:crypto'
import { createIsolatedNovelImportParser, type IsolatedNovelImportParserConfig } from './isolated-parser.js'
import { IMPORT_RESOURCE_LIMITS, type ImportDocumentItem, type ImportDocumentIssue, type ImportDocumentReport, type ImportImage } from './document-types.js'
import { routeImportContent } from './content-routing.js'
import { checkImportImages, stableImportId } from './parsers/images.js'
import { hasUnsafeControls, limit, NOVEL_IMPORT_LIMITS } from './parsers/limits.js'
import { NovelImportParseError, type ParsedNovelImport } from './parsers/types.js'

export type NovelImportPipelineResult = { parsed: ParsedNovelImport; report: ImportDocumentReport; artifacts: ImportImage[] }
export type NovelImportPipelineOptions = { sourceId: string; sourceHash?: string; encoding?: string; signal?: AbortSignal;
  /** Absolute persisted job deadline in Unix milliseconds; retries must reuse it. */
  deadlineAt?: number }
export type NovelImportPipelineConfig = { native?: { enabled: boolean; worker: NonNullable<IsolatedNovelImportParserConfig['nativeWorker']> } }

// Exhaustive allowlist of reviewable quality/structure issues. Resource failures, missing
// content, unknown parser warnings, unsupported objects and corruption cannot be reviewed away.
const REVIEW_CODES = new Set(['IMPORT_STRUCTURE_FALLBACK', 'IMPORT_NATIVE_OCR_REVIEW',
  'IMPORT_NATIVE_READING_ORDER_REVIEW', 'IMPORT_NATIVE_DUPLICATE_BLOCK_EXCLUDED', 'IMPORT_NATIVE_PAGE_BOUNDARIES_REVIEW',
  'IMPORT_NATIVE_PAGE_REVIEW', 'IMPORT_NATIVE_REGION_REVIEW', 'IMPORT_DOC_CONVERSION_REVIEW',
  'DOC_CONVERSION_REQUIRES_DOCX_PARSER', 'DOC_FIDELITY_REVIEW_REQUIRED',
  'OCR_REVIEW_REQUIRED', 'OCR_LOW_CONFIDENCE', 'OCR_EMPTY_UNCLASSIFIED_IMAGE',
  'ROTATED_PAGE_REVIEW_REQUIRED', 'READING_ORDER_REVIEW_REQUIRED', 'IMPORT_IMAGE_REVIEW_REQUIRED',
  'IMPORT_IMAGE_TEXT_PLACEMENT_REVIEW', 'IMPORT_NATIVE_COVERAGE', 'IMPORT_NATIVE_INCOMPLETE_CONTENT'])
const HARD_CODES = new Set(['IMPORT_LIMIT_EXCEEDED', 'IMPORT_ARCHIVE_UNSAFE', 'IMPORT_PROTOCOL_INVALID',
  'IMPORT_NATIVE_COVERAGE_UNKNOWN', 'IMPORT_ENCODING_AMBIGUOUS', 'IMPORT_CHAPTER_TOO_LARGE', 'IMPORT_NO_BODY',
  'IMPORT_IMAGE_STORAGE_REQUIRED'])

/** Conservative source hierarchy; delimiters matter (page=1 must never match page=10). */
export function importSourceContains(parent: string, child: string) {
  return child === parent || ['#', '&', '!/'].some(delimiter => child.startsWith(parent + delimiter))
}

export function buildNovelImportReport(parsed: ParsedNovelImport, filename: string, sourceId: string, sourceHash: string): ImportDocumentReport {
  const items = new Map<string, ImportDocumentItem>()
  const sources = new Map<string, ImportDocumentItem[]>()
  const add = (item: ImportDocumentItem) => {
    limit(item.source.length <= 4096 && !hasUnsafeControls(item.source), '来源标识超出安全限制。')
    const existing = items.get(item.id)
    if (existing && existing.source !== item.source) throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '来源标识发生冲突。')
    items.set(item.id, item)
    const siblings = sources.get(item.source) ?? []
    const prior = siblings.findIndex(value => value.id === item.id)
    if (prior >= 0) siblings[prior] = item
    else siblings.push(item)
    sources.set(item.source, siblings)
    limit(items.size <= IMPORT_RESOURCE_LIMITS.items, '来源清单超过安全数量。')
  }
  const rootId = stableImportId('file', filename)
  add({ id: rootId, kind: 'file', source: filename, status: 'native', excludable: false })
  for (const item of parsed.evidence?.items ?? []) add({ ...item, ...(item.id === rootId ? { excludable: false } : {}) })
  // Pure text/DOCX have character/member provenance, not fictitious PDF page numbers.
  for (const chapter of [...parsed.volumes.flatMap(volume => volume.chapters), ...(parsed.plans ?? []), ...(parsed.memories ?? [])]) {
    if (!chapter.source) throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '解析内容缺少来源标识。')
    const pageMatch = /(?:#|&)page=(\d+)(?=$|[#&])/.exec(chapter.source)
    if (pageMatch) {
      const pageSource = chapter.source.slice(0, pageMatch.index + pageMatch[0].length)
      const id = stableImportId('page', pageSource)
      if (!items.has(id)) add({ id, kind: 'page', source: pageSource, parentId: rootId, status: 'needs_review', page: Number(pageMatch[1]), excludable: true })
    }
    // Native blocks already preserve ALL original and duplicate text; do not duplicate it.
    if (!pageMatch) {
      add({ id: stableImportId('block', chapter.source), kind: 'block', source: chapter.source, status: 'native',
        parentId: rootId, excludable: true, text: chapter.content })
    }
  }
  for (const image of parsed.images ?? []) add({ id: image.id, kind: 'image', source: image.source,
    parentId: rootId, status: items.get(image.id)?.status === 'native' ? 'native' : 'needs_review', excludable: true, artifactId: image.id })
  // Failed pure-PDF pages / failed ZIP members must exist even when no chapter was returned.
  for (const warning of parsed.warnings) {
    if (!warning.source) continue
    const pageMatch = /(?:#|&)page=(\d+)(?=$|[#&])/.exec(warning.source)
    const source = pageMatch ? warning.source.slice(0, pageMatch.index + pageMatch[0].length) : warning.source
    if (sources.has(source)) continue
    const failure = /FAILED|MISSING|UNSUPPORTED|VISION_REQUIRED/.test(warning.code)
    add({ id: stableImportId(pageMatch ? 'page' : 'file', source), kind: pageMatch ? 'page' : 'file', source,
      parentId: rootId, excludable: !HARD_CODES.has(warning.code), status: failure ? 'failed' : 'needs_review',
      ...(pageMatch ? { page: Number(pageMatch[1]) } : {}) })
  }
  const all = [...items.values()]
  const pagesAndRegions = all.filter(item => item.kind === 'page' || item.kind === 'region')
  let issueReferences = 0
  // Chapter length is recomputed from the edited manifest by the service. It is not an
  // immutable source-loss issue; otherwise a correct split could never resolve it.
  const issues: ImportDocumentIssue[] = parsed.warnings.filter(warning => warning.code !== 'IMPORT_CHAPTER_TOO_LARGE').map((warning, index) => {
    const source = warning.source ?? filename
    // Bind to the most specific existing source. Broad native summary warnings additionally
    // bind descendants, so one reviewed page cannot clear failures on another page.
    let bound = sources.get(source) ?? []
    if (!bound.length) {
      // Source length <=4096: indexed ancestor lookup avoids warnings*100k-block scans.
      for (let i = source.length - 1; i >= 0; i--) {
        if (source[i] !== '#' && source[i] !== '&' && source.slice(i, i + 2) !== '!/') continue
        const ancestor = sources.get(source.slice(0, i))
        if (ancestor) { bound = ancestor; break }
      }
    }
    if (/COVERAGE|INCOMPLETE_CONTENT/.test(warning.code)) {
      const descendants = pagesAndRegions.filter(item => importSourceContains(source, item.source))
      if (descendants.length) bound = descendants
    }
    const failed = bound.some(item => item.status === 'failed')
    issueReferences += bound.length
    limit(issueReferences <= 220_000, '完整性问题引用超过安全数量。')
    const resolution = !warning.blocking ? 'none' : HARD_CODES.has(warning.code) ? 'none' :
      !failed && REVIEW_CODES.has(warning.code) ? 'review' : bound.length && bound.every(item => item.excludable) ? 'exclude' : 'none'
    return { id: stableImportId('issue', `${index}:${warning.code}:${source}`), code: warning.code, message: warning.message,
      blocking: warning.blocking, itemIds: bound.map(item => item.id), resolution }
  })
  return { version: 1, sourceId, sourceHash, parserVersion: parsed.parserVersion, items: all, issues,
    complete: !issues.some(issue => issue.blocking) && !all.some(item => item.status === 'failed' || item.status === 'needs_review') }
}

/** Business-facing composition: deterministic by default, native DOC/PDF (including ZIP
 * members) only with a trusted injected sandbox. No database, model or network operation.
 * Caller must privately persist artifacts+immutable report under the claimed job epoch,
 * and enforce persisted human review decisions before final approval/commit. */
export function createNovelImportPipeline(config: NovelImportPipelineConfig = {}) {
  return async (buffer: Buffer, filename: string, options: NovelImportPipelineOptions): Promise<NovelImportPipelineResult> => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.sourceId)) throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '来源标识无效。')
    const bytes = Buffer.from(buffer)
    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    if (options.sourceHash !== undefined && options.sourceHash !== sourceHash) throw new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '来源内容校验不匹配。')
    const maximum = config.native?.enabled ? NOVEL_IMPORT_LIMITS.nativeDurationMs : NOVEL_IMPORT_LIMITS.durationMs
    const remaining = options.deadlineAt === undefined ? maximum : Math.min(maximum, options.deadlineAt - Date.now())
    if (!Number.isFinite(remaining) || remaining <= 0) throw new NovelImportParseError('IMPORT_DEADLINE_EXCEEDED', '解析任务已到达持久截止时间，请新建任务。')
    const parse = createIsolatedNovelImportParser({ resources: true, timeoutMs: Math.floor(remaining),
      ...(config.native?.enabled ? { nativeWorker: config.native.worker } : {}) })
    const raw = await parse(bytes, filename, { encoding: options.encoding, signal: options.signal })
    raw.parserVersion += '+document-pipeline-2'
    // 分类不能改变来源覆盖范围：报告必须包含分流前的计划、记忆和章节。
    const parsed = routeImportContent(raw)
    const artifacts = parsed.images ?? []
    checkImportImages(artifacts)
    // Persisting the resource bytes is mandatory, not a quality issue a human may waive.
    // The preview service may remove only this machine-check after proving every descriptor
    // is hash-verified in owned private storage. Never remove OCR/image review warnings.
    if (artifacts.length) parsed.warnings.push({ code: 'IMPORT_IMAGE_STORAGE_REQUIRED', message: '图片资源须保存到本任务的私有存储后才能导入。', source: filename, blocking: true })
    const report = buildNovelImportReport({ ...raw, warnings: parsed.warnings }, filename, options.sourceId, sourceHash)
    if (options.signal?.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
    return { parsed, report, artifacts }
  }
}

export const parseNovelImportDocument = createNovelImportPipeline()
