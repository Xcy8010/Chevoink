import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  adaptNativeNovelImportResult as adapt, createNativeNovelImportParser,
  type NativeNovelImportOptions, type NativeNovelImportSource,
} from '../../api/lib/novel-import/native-parser.js'
import { DocumentWorkerError, WORKER_VERSION, type DocumentWorkerResult, type WorkerPage, type WorkerArtifact } from '../../workers/document-import/protocol.js'
import type { DocumentWorkerInput } from '../../api/lib/novel-import/worker-client.js'
import type { ParsedNovelImport } from '../../api/lib/novel-import/parser.js'
import { docx, paragraph, pdf } from './novel-import-parser.fixtures.js'

const source: NativeNovelImportSource = { filename: 'book.pdf', sourceId: 'src1', sourceHash: 'a'.repeat(64), format: 'pdf' }
const body = (parsed: ParsedNovelImport) => parsed.volumes.flatMap((volume) => volume.chapters).map((chapter) => chapter.content).join('')
const warning = (parsed: ParsedNovelImport, code: string) => parsed.warnings.find((warning) => warning.code === code)
function block(id: string, text = '第一章 开始\n原文\nFINAL_TAIL', options: Partial<WorkerPage['blocks'][number]> = {}): WorkerPage['blocks'][number] {
  return { id, method: 'native', text, bbox: [1, 1, 90, 20], confidence: null, regionId: null, duplicateOf: null, ...options }
}
function page(number = 1, options: Partial<WorkerPage> = {}): WorkerPage {
  return { page: number, width: 100, height: 100, state: 'native', warnings: [], regions: [], blocks: [block(`p${number}-b1`)], ...options }
}
function result(pages: WorkerPage[] = [page()], options: Partial<DocumentWorkerResult> = {}): DocumentWorkerResult {
  const counts = { native: 0, ocr: 0, needs_review: 0, failed: 0, verified_blank: 0 }
  for (const p of pages) counts[p.state]++
  const complete = pages.length > 0 && !counts.needs_review && !counts.failed && !counts.ocr
  return { version: WORKER_VERSION, requestId: 'req1', sourceId: source.sourceId, sourceHash: source.sourceHash,
    format: 'pdf', parserVersion: 'lo25.2-pymupdf1.25-tesseract5.5-prototype1',
    outcome: complete ? 'parsed' : 'needs_review', error: null, warnings: [], totalPages: pages.length,
    pages, artifacts: [], convertedArtifactId: null,
    coverage: { complete, processedPages: pages.length - counts.failed, counts }, ...options }
}
function artifact(bytes: Buffer, image = false): WorkerArtifact {
  return { id: image ? 'img1' : 'converted1', bytes, byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: image ? 'image/png' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ...(image ? { width: 1, height: 1 } : {}) }
}
function png() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64') }

describe('optional native result adapter: fake protocol, never Docker/native QA', () => {
  it('preserves extracted full text, paragraph spacing and original source identity per page', async () => {
    const long = '第一章 开始\n  原文\n\n' + '正文'.repeat(15_000) + 'FINAL_TAIL  '
    const native = result([page(1, { blocks: [block('a', long)] }), page(2, { blocks: [block('b', '第二章 收束\n第二页尾巴')] })])
    const before = structuredClone(native)
    const preview = await adapt(native, source)
    expect(body(preview.parsed)).toBe('  原文\n\n' + '正文'.repeat(15_000) + 'FINAL_TAIL  第二页尾巴')
    const chapters = preview.parsed.volumes[0].chapters
    expect(chapters[0].source).toContain(`book.pdf#source=src1&sha256=${source.sourceHash}&page=1`)
    expect(chapters[1].source).toContain('&page=2')
    expect(warning(preview.parsed, 'IMPORT_NATIVE_COVERAGE')?.blocking).toBe(false)
    expect(preview.parsed.parserVersion).toContain('native-adapter-1')
    expect(native).toEqual(before)
    expect(await adapt(native, source)).toEqual(preview)
  })

  it('sorts native-plus-appended-OCR by bbox, retains exact text and blocks order/recognition doubts', async () => {
    const native = result([page(1, { state: 'needs_review', blocks: [
      block('bottom', '原生底部', { bbox: [1, 50, 90, 70] }),
      block('top', 'OCR顶部', { method: 'ocr', bbox: [1, 1, 90, 20], confidence: 100 }),
    ] })])
    const { parsed } = await adapt(native, source)
    expect(body(parsed)).toBe('OCR顶部\n\n原生底部')
    expect(warning(parsed, 'IMPORT_NATIVE_READING_ORDER_REVIEW')?.blocking).toBe(true)
    expect(warning(parsed, 'IMPORT_NATIVE_OCR_REVIEW')?.blocking).toBe(true)
    expect(warning(parsed, 'IMPORT_NATIVE_INCOMPLETE_CONTENT')?.blocking).toBe(true)
  })

  it('excludes only duplicateOf OCR from assembly while returning all original duplicate evidence', async () => {
    const native = result([page(1, { state: 'needs_review', blocks: [block('original', '原文'), block('ocr', 'OCR可能有异文', { method: 'ocr', duplicateOf: 'original', confidence: 98 })] })])
    const preview = await adapt(native, source)
    expect(body(preview.parsed)).toBe('原文')
    expect(preview.native.pages[0].blocks[1].text).toBe('OCR可能有异文')
    expect(warning(preview.parsed, 'IMPORT_NATIVE_DUPLICATE_BLOCK_EXCLUDED')?.blocking).toBe(true)
    const unmarked = result([page(1, { state: 'needs_review', blocks: [block('one', '同文'), block('two', '同文', { method: 'ocr' })] })])
    expect(body((await adapt(unmarked, source)).parsed)).toBe('同文\n\n同文')
  })

  it('blocks overlapping/multicolumn native blocks even if worker coverage is complete', async () => {
    const native = result([page(1, { blocks: [block('left', '左栏', { bbox: [1, 1, 40, 90] }), block('right', '右栏', { bbox: [50, 1, 90, 90] })] })])
    const { parsed } = await adapt(native, source)
    expect(body(parsed)).toContain('左栏\n\n右栏')
    expect(warning(parsed, 'IMPORT_NATIVE_READING_ORDER_REVIEW')?.blocking).toBe(true)
  })

  it('keeps partial text from failed pages and retains later pages with blocking coverage', async () => {
    const native = result([page(), page(2, { state: 'failed', blocks: [block('failed', '仍可读取的部分')], warnings: ['IMPORT_OCR_FAILED'] }), page(3, { blocks: [block('last', '最后一页尾巴')] })])
    const { parsed } = await adapt(native, source)
    expect(body(parsed)).toContain('仍可读取的部分')
    expect(body(parsed)).toContain('最后一页尾巴')
    expect(warning(parsed, 'IMPORT_NATIVE_PAGE_FAILED')).toMatchObject({ blocking: true, source: expect.stringContaining('&page=2') })
    expect(warning(parsed, 'IMPORT_NATIVE_COVERAGE')?.message).toContain('失败 1 页')
  })

  it('blocks failed/doubtful image regions and null artifact references', async () => {
    const native = result([page(1, { state: 'needs_review', regions: [{ id: 'r1', bbox: [1, 20, 90, 80], status: 'failed', artifactId: null, warnings: ['IMPORT_OCR_FAILED'] }] })])
    const { parsed } = await adapt(native, source)
    expect(warning(parsed, 'IMPORT_NATIVE_REGION_FAILED')?.source).toContain('&page=1&region=r1')
    expect(warning(parsed, 'IMPORT_NATIVE_REGION_IMAGE_MISSING')?.blocking).toBe(true)
  })

  it('forwards checked image bytes but does not claim private storage/viewability', async () => {
    const image = artifact(png(), true)
    const preview = await adapt(result([page()], { artifacts: [image] }), source)
    expect(Buffer.from(preview.native.artifacts[0].bytes)).toEqual(png())
    expect(warning(preview.parsed, 'IMPORT_NATIVE_ARTIFACT_UNSTORED')?.blocking).toBe(true)
  })

  it('handles unknown totals and returned worker failures as incomplete diagnostics, not zero-page success', async () => {
    const native = result([], { totalPages: null, outcome: 'failed', error: 'IMPORT_PARSE_FAILED' })
    const { parsed } = await adapt(native, source)
    expect(parsed.volumes).toEqual([])
    for (const code of ['IMPORT_PARSE_FAILED', 'IMPORT_NATIVE_COVERAGE_UNKNOWN', 'IMPORT_NATIVE_INCOMPLETE_CONTENT', 'IMPORT_NO_BODY']) expect(warning(parsed, code)?.blocking).toBe(true)
  })

  it('preserves verified-blank outcomes without inventing body, but requires chapter-boundary review for page fragments', async () => {
    const native = result([page(1, { state: 'verified_blank', blocks: [] }), page(2, { blocks: [block('plain', '续页正文')] })])
    const { parsed } = await adapt(native, source)
    expect(body(parsed)).toBe('续页正文')
    expect(warning(parsed, 'IMPORT_NATIVE_VERIFIED_BLANK')?.blocking).toBe(false)
    expect(warning(parsed, 'IMPORT_NATIVE_PAGE_BOUNDARIES_REVIEW')?.blocking).toBe(true)
  })

  it.each(['sourceId', 'sourceHash', 'format'] as const)('rejects mismatched %s instead of relabelling another source', async (key) => {
    const native = result()
    if (key === 'sourceId') native.sourceId = 'other'
    else if (key === 'sourceHash') native.sourceHash = 'b'.repeat(64)
    else native.format = 'image'
    await expect(adapt(native, source)).rejects.toMatchObject({ code: 'IMPORT_PROTOCOL_INVALID' })
  })

  it('rejects missing pages, forged coverage, dangling duplicates and modified artifact bytes', async () => {
    const mutations: Array<(native: DocumentWorkerResult) => void> = [
      (native) => { native.totalPages = 2 }, (native) => { native.coverage.counts.native = 2 },
      (native) => { native.pages[0].blocks[0].duplicateOf = 'missing' },
      (native) => { const a = artifact(png(), true); a.bytes[25] ^= 1; native.artifacts.push(a) },
    ]
    for (const mutate of mutations) { const native = result(); mutate(native); await expect(adapt(native, source)).rejects.toMatchObject({ code: 'IMPORT_PROTOCOL_INVALID' }) }
  })

  it('enforces aggregate text budget before schema cloning/assembly, without truncation', async () => {
    const pages = Array.from({ length: 51 }, (_, i) => page(i + 1, { blocks: [block(`b${i}`, 'x'.repeat(100_000))] }))
    await expect(adapt(result(pages), source)).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  })

  it('feeds a verified DOC converted artifact to existing isolated DOCX parsing, never recursive DOC', async () => {
    const converted = artifact(docx(paragraph('第一章 开始', 'Heading1') + paragraph('DOC原文\nFINAL_TAIL'), { 'word/media/unsupported.png': png() }))
    const native = result([], { format: 'doc', outcome: 'converted', totalPages: null, warnings: ['IMPORT_DOC_FIDELITY_REVIEW'], artifacts: [converted], convertedArtifactId: converted.id })
    const preview = await adapt(native, { ...source, filename: 'original.doc', format: 'doc' })
    expect(body(preview.parsed)).toContain('DOC原文\nFINAL_TAIL')
    expect(preview.parsed.volumes[0].chapters[0].source).toContain(`original.doc#source=src1&sha256=${source.sourceHash}&converted=converted1`)
    for (const code of ['IMPORT_DOC_CONVERSION_REVIEW', 'IMPORT_DOC_FIDELITY_REVIEW', 'IMPORT_DOCX_UNSUPPORTED_CONTENT', 'IMPORT_NATIVE_INCOMPLETE_CONTENT']) expect(warning(preview.parsed, code)?.blocking).toBe(true)
    expect(Buffer.from(preview.native.artifacts[0].bytes)).toEqual(converted.bytes)
  }, 25_000)

  it('honors abort before any mapping or converted DOCX parsing', async () => {
    await expect(adapt(result(), source, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })
})

describe('trusted native worker injection remains feature OFF by default', () => {
  it('does not invoke a worker without explicit enablement and injection', async () => {
    const worker = { run: vi.fn() }
    for (const config of [{}, { worker }, { enabled: true }]) await expect(createNativeNovelImportParser(config)(pdf(['x']), 'book.pdf', { sourceId: 'src1' })).rejects.toMatchObject({ code: 'IMPORT_NATIVE_DISABLED' })
    expect(worker.run).not.toHaveBeenCalled()
  })

  it('passes only bounded trusted protocol options and snapshots bytes/hash before awaiting', async () => {
    const bytes = pdf(['first'])
    const original = Buffer.from(bytes)
    let supplied: DocumentWorkerInput | undefined
    const worker = { run: vi.fn(async (input: DocumentWorkerInput) => {
      supplied = input
      await new Promise<void>((resolve) => setImmediate(resolve))
      return result([page()], { sourceId: input.sourceId, sourceHash: input.sourceHash })
    }) }
    const parse = createNativeNovelImportParser({ enabled: true, worker })
    const promise = parse(bytes, 'book.pdf', { sourceId: 'upload-1', ocrLanguages: 'eng', timeoutMs: 1000 })
    bytes.fill(0)
    const preview = await promise
    expect(Buffer.from(supplied!.bytes)).toEqual(original)
    expect(supplied!.sourceHash).toBe(createHash('sha256').update(original).digest('hex'))
    expect(supplied!.ocrLanguages).toBe('eng')
    expect(Object.keys(supplied!).sort()).toEqual(['bytes', 'format', 'ocrLanguages', 'signal', 'sourceHash', 'sourceId', 'timeoutMs'].sort())
    expect(preview.parsed.volumes[0].chapters[0].source).toContain('source=upload-1')
  })

  it('rejects request command injection and unsupported formats before worker invocation', async () => {
    const worker = { run: vi.fn() }
    const parse = createNativeNovelImportParser({ enabled: true, worker })
    await expect(parse(pdf(['x']), 'book.pdf', { sourceId: '../command' })).rejects.toMatchObject({ code: 'IMPORT_PROTOCOL_INVALID' })
    await expect(parse(pdf(['x']), 'book.pdf', { sourceId: 'src1', ocrLanguages: 'eng;sh' as NativeNovelImportOptions['ocrLanguages'] })).rejects.toMatchObject({ code: 'IMPORT_PROTOCOL_INVALID' })
    await expect(parse(docx(paragraph('x')), 'book.docx', { sourceId: 'src1' })).rejects.toMatchObject({ code: 'IMPORT_UNSUPPORTED_FORMAT' })
    expect(worker.run).not.toHaveBeenCalled()
  })

  it('rejects late worker completion after cancellation and propagates abort', async () => {
    const controller = new AbortController()
    let supplied: DocumentWorkerInput | undefined
    let complete: ((value: DocumentWorkerResult) => void) | undefined
    const worker = { run: vi.fn((input: DocumentWorkerInput) => { supplied = input; return new Promise<DocumentWorkerResult>((resolve) => { complete = resolve }) }) }
    const pending = createNativeNovelImportParser({ enabled: true, worker })(pdf(['x']), 'book.pdf', { sourceId: 'src1', signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    controller.abort()
    await rejected
    expect(supplied!.signal!.aborted).toBe(true)
    complete!(result([page()], { sourceHash: supplied!.sourceHash }))
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('has a watchdog even when the injected worker ignores its signal', async () => {
    vi.useFakeTimers()
    try {
      const worker = { run: vi.fn(() => new Promise<DocumentWorkerResult>(() => {})) }
      const pending = createNativeNovelImportParser({ enabled: true, worker })(pdf(['x']), 'book.pdf', { sourceId: 'src1', timeoutMs: 1000 })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'IMPORT_DEADLINE_EXCEEDED' })
      await vi.advanceTimersByTimeAsync(1001)
      await rejected
    } finally { vi.useRealTimers() }
  })

  it('preserves stable worker failures, redacts unexpected errors and never falls back', async () => {
    for (const error of [new DocumentWorkerError('IMPORT_WORKER_UNAVAILABLE'), new Error('secret /host/private/path')]) {
      const worker = { run: vi.fn(async () => { throw error }) }
      const pending = createNativeNovelImportParser({ enabled: true, worker })(pdf(['x']), 'book.pdf', { sourceId: 'src1' })
      await expect(pending).rejects.toMatchObject({ code: error instanceof DocumentWorkerError ? 'IMPORT_WORKER_UNAVAILABLE' : 'IMPORT_NATIVE_WORKER_FAILED', message: expect.not.stringContaining('/host/private') })
      expect(worker.run).toHaveBeenCalledTimes(1)
    }
  })
})
