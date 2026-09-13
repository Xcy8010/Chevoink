import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { createNovelImportPipeline, importSourceContains, parseNovelImportDocument } from '../../../api/lib/novel-import/pipeline.js'
import { docx, paragraph, zipFiles } from '../../../tests/unit/novel-import-parser.fixtures.js'
import type { DocumentWorkerInput } from '../../../api/lib/novel-import/worker-client.js'
import { WORKER_VERSION, type DocumentWorkerResult } from '../protocol.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const source = { sourceId: 'job_source' }
const body = (value: Awaited<ReturnType<typeof parseNovelImportDocument>>) => value.parsed.volumes.flatMap(v => v.chapters).map(c => c.content).join('')
async function image() { return sharp({ create: { width: 20, height: 30, channels: 3, background: '#fff' } }).jpeg().toBuffer() }
function native(input: DocumentWorkerInput): DocumentWorkerResult {
  return { version: WORKER_VERSION, requestId: 'request', sourceId: input.sourceId, sourceHash: input.sourceHash, format: input.format,
    parserVersion: 'lo25.2-pymupdf1.25-tesseract5.5-prototype1', outcome: 'needs_review', error: null, warnings: [], totalPages: 2,
    pages: [{ page: 1, width: 100, height: 100, state: 'native', warnings: [], regions: [], blocks: [{ id: 'p1b1', method: 'native',
      text: '第一章 原生\n正文尾巴', bbox: [1, 1, 90, 20], confidence: null, regionId: null, duplicateOf: null }] },
    { page: 2, width: 0, height: 0, state: 'failed', warnings: ['IMPORT_OCR_FAILED'], regions: [], blocks: [] }],
    artifacts: [], convertedArtifactId: null, coverage: { complete: false, processedPages: 1,
      counts: { native: 1, ocr: 0, needs_review: 0, failed: 1, verified_blank: 0 } } }
}

describe('business parser pipeline (real isolated Node + synthetic native protocol)', () => {
  it('preserves text and deterministically binds report to original source bytes', async () => {
    const bytes = Buffer.from('第一章 起点\n原文\n\n最后一行')
    const result = await parseNovelImportDocument(bytes, '书.txt', { ...source, sourceHash: hash(bytes) })
    expect(body(result)).toBe('原文\n\n最后一行')
    expect(result.report.sourceHash).toBe(hash(bytes)); expect(result.artifacts).toEqual([])
    expect(await parseNovelImportDocument(bytes, '书.txt', source)).toEqual(result)
    await expect(parseNovelImportDocument(bytes, '书.txt', { ...source, sourceHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'IMPORT_PROTOCOL_INVALID' })
  })
  it('keeps private canonical ZIP image candidates and does not invent cover metadata', async () => {
    const result = await parseNovelImportDocument(zipFiles({ '第一章.txt': '第一章\n正文', 'cover.jpg': await image() }), '书.zip', source)
    expect(result.artifacts).toHaveLength(1)
    const artifact = result.artifacts[0]
    expect(artifact).toMatchObject({ mediaType: 'image/png', coverCandidate: true, source: '书.zip!/cover.jpg' })
    expect((await sharp(artifact.bytes).metadata()).format).toBe('png')
    expect(result.parsed.metadata).not.toHaveProperty('cover')
    expect(result.report.issues.find(i => i.code === 'IMPORT_IMAGE_STORAGE_REQUIRED')).toMatchObject({ blocking: true, resolution: 'none' })
    expect(result.report.items.some(i => i.artifactId === artifact.id)).toBe(true)
  })
  it('retains DOCX media including unplaced images as explicit review candidates', async () => {
    const bytes = docx(paragraph('第一章', 'Heading1') + paragraph('原文'), { 'word/media/cover.jpg': await image() })
    const result = await parseNovelImportDocument(bytes, '书.docx', source)
    expect(body(result)).toContain('原文'); expect(result.artifacts[0].source).toBe('书.docx!/word/media/cover.jpg')
    expect(result.report.issues.some(i => i.code === 'IMPORT_IMAGE_REVIEW_REQUIRED' && i.blocking)).toBe(true)
  })
  it('binds the real inline Word image marker to the canonical private artifact', async () => {
    const drawing = '<w:p><w:r><w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    const result = await parseNovelImportDocument(docx(paragraph('图片前') + drawing + paragraph('图片后'), {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.jpg"/></Relationships>',
      'word/media/image.jpg': await image(),
    }), 'inline.docx', source)
    expect(body(result)).toContain(`[图片来源：${result.artifacts[0].id}]`)
    expect(body(result).indexOf('图片前')).toBeLessThan(body(result).indexOf(result.artifacts[0].id))
    expect(body(result).indexOf('图片后')).toBeGreaterThan(body(result).indexOf(result.artifacts[0].id))
    expect(result.parsed.warnings.some(w => w.code === 'IMPORT_DOCX_IMAGE_UNSUPPORTED')).toBe(false)
  })
  it('rejects unsafe image containers without making network calls or declaring success', async () => {
    const result = await parseNovelImportDocument(zipFiles({ '章.txt': '第一章\n正文', 'cover.jpg': '<svg href="https://attacker.invalid"/>' }), '书.zip', source)
    expect(result.artifacts).toEqual([])
    expect(result.report.items.find(i => i.source === '书.zip!/cover.jpg')?.status).toBe('failed')
    expect(result.report.complete).toBe(false)
  })
  it('routes ZIP PDF through the injected sandbox, preserves failed pages, never reviews failure away', async () => {
    const run = vi.fn(async (input: DocumentWorkerInput) => native(input))
    const parse = createNovelImportPipeline({ native: { enabled: true, worker: { run } } })
    const result = await parse(zipFiles({ '第一卷/扫描.pdf': '%PDF-1.4 synthetic opaque' }), '书.zip', source)
    expect(run).toHaveBeenCalledOnce(); expect(body(result)).toContain('正文尾巴')
    const failed = result.report.items.find(i => i.kind === 'page' && i.page === 2)!
    expect(failed).toMatchObject({ status: 'failed', excludable: true })
    expect(result.report.issues.filter(i => i.itemIds.includes(failed.id)).every(i => i.resolution !== 'review')).toBe(true)
    expect(result.report.items.find(i => i.kind === 'block')?.text).toContain('第一章')
  })
  it('native false never invokes a supplied client and DOC fails closed', async () => {
    const run = vi.fn()
    const parse = createNovelImportPipeline({ native: { enabled: false, worker: { run } } })
    await expect(parse(Buffer.from('fake DOC'), '书.doc', source)).rejects.toMatchObject({ code: 'IMPORT_UNSUPPORTED_FORMAT' })
    expect(run).not.toHaveBeenCalled()
  })
  it('rejects cancelled dispatch before native execution', async () => {
    const run = vi.fn(); const controller = new AbortController(); controller.abort()
    const parse = createNovelImportPipeline({ native: { enabled: true, worker: { run } } })
    await expect(parse(Buffer.from('%PDF-1.4'), '书.pdf', { ...source, signal: controller.signal })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(run).not.toHaveBeenCalled()
  })
  it('source prefixes distinguish page/member boundaries', () => {
    expect(importSourceContains('x#page=1', 'x#page=10#char=0-5')).toBe(false)
    expect(importSourceContains('x#page=1', 'x#page=1#char=0-5')).toBe(true)
    expect(importSourceContains('x!/a.txt', 'x!/a.txt2')).toBe(false)
  })
  it('large-chapter limits remain editable, not permanent source-loss issues', async () => {
    const content = '文'.repeat(210_000)
    const result = await parseNovelImportDocument(Buffer.from(`第一章\n${content}`), '大章.txt', source)
    expect(body(result)).toBe(content)
    expect(result.parsed.warnings.some(w => w.code === 'IMPORT_CHAPTER_TOO_LARGE')).toBe(true)
    expect(result.report.issues.some(i => i.code === 'IMPORT_CHAPTER_TOO_LARGE')).toBe(false)
    const split = [content.slice(0, 70_000), content.slice(70_000, 140_000), content.slice(140_000)]
    expect(split.every(part => part.length <= 100_000)).toBe(true)
    expect(split.join('')).toBe(result.report.items.find(i => i.kind === 'block')!.text)
  })
  it('DOCX image OCR is visible and unassigned, never replaces native paragraphs', async () => {
    const run = vi.fn(async (input: DocumentWorkerInput): Promise<DocumentWorkerResult> => {
      const result = native(input)
      result.totalPages = 1; result.pages = result.pages.slice(0, 1)
      result.pages[0].state = 'needs_review'; result.pages[0].blocks[0].method = 'ocr'
      result.pages[0].blocks[0].text = '图片里的原文'; result.pages[0].blocks[0].confidence = 95
      result.coverage.counts = { native: 0, ocr: 0, needs_review: 1, failed: 0, verified_blank: 0 }
      return result
    })
    const parse = createNovelImportPipeline({ native: { enabled: true, worker: { run } } })
    const result = await parse(docx(paragraph('原生段落'), { 'word/media/scan.jpg': await image() }), '书.docx', source)
    expect(run.mock.calls[0][0].format).toBe('image')
    expect(body(result)).toContain('原生段落'); expect(body(result)).toContain('图片里的原文')
    expect(result.parsed.volumes.some(v => v.title === '图片正文（待归章）')).toBe(true)
    expect(result.report.issues.some(i => i.code === 'IMPORT_IMAGE_TEXT_PLACEMENT_REVIEW' && i.blocking)).toBe(true)
    expect(result.artifacts).toHaveLength(1)
  })
})
