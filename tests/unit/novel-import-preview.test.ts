import { describe, expect, it } from 'vitest'
import type { NovelImportDocumentReport, NovelImportEvidencePreview } from '../../shared/contracts/novel-import-preview.js'
import { novelImportReviewSchema, novelImportStructureSchema } from '../../shared/contracts/novel-import-preview.js'
import { applySourceReview, applyStructureEdit, assertLegacyContentConserved, assertNovelImportPreviewComplete, assertPreviewCoverSelection, canonicalPreviewHash, previewReportDto, refreshPreviewWarnings, reportHash } from '../../api/lib/novel-import/preview.js'

const hash = 'a'.repeat(64)
function preview(options: { failed?: boolean; review?: boolean } = {}): NovelImportEvidencePreview {
  const report: NovelImportDocumentReport = { version: 1, sourceId: 'source', sourceHash: hash, parserVersion: 'test', complete: !options.failed && !options.review,
    items: [{ id: 'file', kind: 'file', source: 'book.pdf', status: 'native', excludable: false },
      { id: 'page1', kind: 'page', source: 'book.pdf#page=1', status: options.review ? 'needs_review' : 'native', excludable: true, parentId: 'file', text: '原文甲😀乙\n' },
      { id: 'page10', kind: 'page', source: 'book.pdf#page=10', status: options.failed ? 'failed' : 'native', excludable: true, parentId: 'file' }],
    issues: options.failed ? [{ id: 'missing', code: 'IMPORT_PAGE_FAILED', message: '缺页', blocking: true, itemIds: ['page10'], resolution: 'exclude' }] : options.review ? [{ id: 'quality', code: 'OCR_REVIEW_REQUIRED', message: '核对原图', blocking: true, itemIds: ['page1'], resolution: 'review' }] : [] }
  return refreshPreviewWarnings({ manifestRevision: 1, manifestHash: hash, sourceHash: hash, parserVersion: 'test', sourceChars: 10, metadata: {}, metadataSelection: {}, warnings: [], report, reportHash: reportHash(report), artifacts: [], decisions: [], partialImport: false,
    volumes: [{ title: '正文', chapters: [{ title: '一', content: '原文甲😀乙\n', source: { memberPath: 'book.pdf#page=1#char=0-8' } }, { title: '十', content: '保留十', source: { memberPath: 'book.pdf#page=10#char=0-3' } }] }] })
}
function review(p: NovelImportEvidencePreview, itemId: string, action: 'review' | 'exclude') {
  return novelImportReviewSchema.parse({ expectedManifestRevision: p.manifestRevision, manifestHash: p.manifestHash, reportHash: p.reportHash, decisions: [{ itemId, action, reason: '用户逐页核验决定' }] })
}
function edit(p: NovelImportEvidencePreview, chapters: Array<{ title: string; segments: Array<{ volumeIndex: number; chapterIndex: number; start: number; end: number }> }>) {
  return novelImportStructureSchema.parse({ expectedManifestRevision: p.manifestRevision, manifestHash: p.manifestHash, volumes: [{ title: '新卷', chapters }] })
}
const segment = (chapterIndex: number, start: number, end: number) => ({ volumeIndex: 0, chapterIndex, start, end })
describe('durable import evidence and source-conserving editing', () => {
  it('accepts a complete immutable report and rejects missing reports', () => {
    expect(() => assertNovelImportPreviewComplete(preview())).not.toThrow()
    expect(() => assertNovelImportPreviewComplete({ ...preview(), report: undefined })).toThrow(/报告/)
  })
  it('cannot erase warnings to bypass a failed page', () => {
    const p = preview({ failed: true }); p.warnings = []
    expect(() => assertNovelImportPreviewComplete(p)).toThrow(/来源报告/)
  })
  it('cannot replace the immutable report under its old hash', () => {
    const p = preview({ failed: true }); p.report!.issues = []
    expect(() => assertNovelImportPreviewComplete(p)).toThrow(/报告/)
  })
  it('cannot mark missing content reviewed', () => {
    const p = preview({ failed: true })
    expect(() => applySourceReview(p, review(p, 'page10', 'review'))).toThrow(/缺失或失败/)
  })
  it('derives known aggregate coverage from excluded failed pages and individually resolved remaining pages', () => {
    const p = preview({ failed: true })
    p.report!.issues.push({ id: 'coverage', code: 'IMPORT_NATIVE_INCOMPLETE_CONTENT', message: '汇总', blocking: true, itemIds: ['page1', 'page10'], resolution: 'exclude' })
    p.reportHash = reportHash(p.report!)
    const next = applySourceReview(p, review(p, 'page10', 'exclude'))
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
    expect(next.volumes[0].chapters).toHaveLength(1)
    const unknown = structuredClone(p)
    unknown.report!.issues[1].code = 'IMPORT_UNKNOWN_COVERAGE'; unknown.reportHash = reportHash(unknown.report!)
    expect(() => assertNovelImportPreviewComplete(applySourceReview(unknown, review(unknown, 'page10', 'exclude')))).toThrow(/来源报告/)
  })
  it('only accepts explicit current, unexcluded cover candidates and never auto-selects an image', () => {
    const p = preview()
    const image = { id: 'image', source: 'book.pdf!/cover.png', sha256: hash, bytes: 100, width: 1, height: 1, mediaType: 'image/png' as const, coverCandidate: true, url: '/api/novels/n/imports/j/artifacts/image' }
    p.artifacts = [image]
    p.report!.items.push({ id: 'image', kind: 'image', source: image.source, artifactId: image.id, status: 'native', excludable: true })
    p.reportHash = reportHash(p.report!)
    expect(refreshPreviewWarnings(p).metadataSelection.coverArtifactId).toBeUndefined()
    p.metadataSelection.coverArtifactId = image.id
    expect(() => assertPreviewCoverSelection(p)).not.toThrow()
    const other = structuredClone(p); other.metadataSelection.coverArtifactId = 'foreign'
    expect(() => assertPreviewCoverSelection(other)).toThrow(/封面必须/)
    expect(() => applySourceReview(p, review(p, 'image', 'exclude'))).toThrow(/取消封面选择/)
    const notCandidate = structuredClone(p); notCandidate.artifacts![0].coverCandidate = false
    expect(() => assertPreviewCoverSelection(notCandidate)).toThrow(/封面必须/)
  })
  it('explicit exclusions remove only their own page, retain audit, and permit partial import', () => {
    const p = preview({ failed: true }); const result = applySourceReview(p, review(p, 'page10', 'exclude'))
    expect(result.volumes[0].chapters.map(c => c.title)).toEqual(['一'])
    expect(result.partialImport).toBe(true)
    expect(result.decisions?.[0]).toMatchObject({ itemId: 'page10', reportHash: p.reportHash, sourceHash: p.sourceHash, reason: '用户逐页核验决定' })
    expect(() => assertNovelImportPreviewComplete(result)).not.toThrow()
    expect(p.volumes[0].chapters).toHaveLength(2)
  })
  it('does not confuse page=1 and page=10', () => {
    const p = preview(); const result = applySourceReview(p, review(p, 'page1', 'exclude'))
    expect(result.volumes[0].chapters.map(c => c.title)).toEqual(['十'])
  })
  it('fails stale report, manifest revision, and manifest hash decisions', () => {
    const p = preview({ review: true }); const input = review(p, 'page1', 'review')
    for (const change of [{ reportHash: 'b'.repeat(64) }, { manifestHash: 'b'.repeat(64) }, { expectedManifestRevision: 2 }]) expect(() => applySourceReview(p, { ...input, ...change })).toThrow(/已变化/)
  })
  it('binds human quality review to the exact content structure', () => {
    const p = preview({ review: true }); const result = applySourceReview(p, review(p, 'page1', 'review'))
    expect(() => assertNovelImportPreviewComplete(result)).not.toThrow()
    result.volumes[0].chapters[0].title = '不同结构'
    expect(() => assertNovelImportPreviewComplete(result)).toThrow(/来源报告/)
  })
  it('disallows excluding the root or all remaining body', () => {
    const p = preview()
    expect(() => applySourceReview(p, review(p, 'file', 'exclude'))).toThrow(/不能直接排除/)
    const next = applySourceReview(p, review(p, 'page1', 'exclude'))
    expect(() => applySourceReview(next, review(next, 'page10', 'exclude'))).toThrow(/全部正文/)
  })
  it('rejects unknown and duplicate decisions and user warning fields', () => {
    const p = preview()
    expect(() => applySourceReview(p, review(p, 'missing', 'exclude'))).toThrow(/不存在/)
    const input = review(p, 'page1', 'exclude')
    expect(() => applySourceReview(p, { ...input, decisions: [...input.decisions, ...input.decisions] })).toThrow(/重复/)
    expect(novelImportReviewSchema.safeParse({ ...input, warnings: [] }).success).toBe(false)
  })
  it('partitions exact original text while splitting, reordering and renaming', () => {
    const p = preview(); const content = p.volumes[0].chapters[0].content
    const result = applyStructureEdit(p, edit(p, [{ title: '十先', segments: [segment(1, 0, 3)] }, { title: '后半', segments: [segment(0, 3, content.length)] }, { title: '前半', segments: [segment(0, 0, 3)] }]))
    expect(result.volumes[0].chapters.map(c => c.content)).toEqual(['保留十', content.slice(3), content.slice(0, 3)])
  })
  it('rejects any missing, duplicated, fabricated or invalid character range', () => {
    const p = preview(); const length = p.volumes[0].chapters[0].content.length
    for (const segments of [[segment(0, 1, length)], [segment(0, 0, length), segment(0, 0, 1)], [segment(0, 0, length + 1)], [segment(3, 0, length)]]) {
      expect(() => applyStructureEdit(p, edit(p, [{ title: '正文', segments }, { title: '十', segments: [segment(1, 0, 3)] }]))).toThrow()
    }
  })
  it('rejects surrogate-pair cuts and cross-source merges', () => {
    const p = preview(); const length = p.volumes[0].chapters[0].content.length
    expect(() => applyStructureEdit(p, edit(p, [{ title: '半字符', segments: [segment(0, 0, 4)] }, { title: '余下', segments: [segment(0, 4, length)] }, { title: '十', segments: [segment(1, 0, 3)] }]))).toThrow(/字符内部/)
    expect(() => applyStructureEdit(p, edit(p, [{ title: '跨页', segments: [segment(0, 0, length), segment(1, 0, 3)] }]))).toThrow(/同一来源/)
  })
  it('supports exact same-source merging with no added newline', () => {
    const p = preview(); p.volumes[0].chapters[1].source.memberPath = 'book.pdf#page=1#char=8-11'
    const result = applyStructureEdit(p, edit(p, [{ title: '合并', segments: [segment(0, 0, p.volumes[0].chapters[0].content.length), segment(1, 0, 3)] }]))
    expect(result.volumes[0].chapters[0].content).toBe('原文甲😀乙\n保留十')
  })
  it('clears review decisions on structure changes while preserving exclusions', () => {
    const p = preview({ review: true }); const reviewed = applySourceReview(p, review(p, 'page1', 'review'))
    const result = applyStructureEdit(reviewed, edit(reviewed, reviewed.volumes[0].chapters.map((c, i) => ({ title: c.title, segments: [segment(i, 0, c.content.length)] }))))
    expect(result.decisions).toEqual([])
    expect(result.warnings.some(w => w.blocking)).toBe(true)
  })
  it('full-body compatibility editor cannot rewrite, omit, or reassign source', () => {
    const p = preview()
    for (const mutation of [(copy: NovelImportEvidencePreview) => { copy.volumes[0].chapters[0].content += '添写' }, (copy: NovelImportEvidencePreview) => { copy.volumes[0].chapters.pop() }, (copy: NovelImportEvidencePreview) => { copy.volumes[0].chapters[0].source.memberPath = 'other.txt' }]) {
      const copy = structuredClone(p); mutation(copy)
      expect(() => assertLegacyContentConserved(p, copy.volumes)).toThrow(/正文|原文/)
    }
    expect(() => assertLegacyContentConserved(p, [{ title: '改卷', chapters: [...p.volumes[0].chapters].reverse() }])).not.toThrow()
  })
  it('report DTO never returns private original text and retains exact hashes', () => {
    const p = preview(); const dto = previewReportDto(p)
    expect(dto.items[1]).not.toHaveProperty('text')
    expect(dto.items[1].textHash).toMatch(/^[a-f0-9]{64}$/)
    expect(dto.reportHash).toBe(p.reportHash)
  })
  it('fails missing issue references and cyclic provenance', () => {
    const p = preview({ failed: true }); p.report!.issues[0].itemIds = ['foreign']; p.reportHash = reportHash(p.report!)
    expect(() => assertNovelImportPreviewComplete(p)).toThrow(/引用无效/)
    const cyclic = preview(); cyclic.report!.items[0].parentId = 'page1'; cyclic.reportHash = reportHash(cyclic.report!)
    expect(() => assertNovelImportPreviewComplete(cyclic)).toThrow(/层级引用/)
  })
  it('canonical hashing survives JSON hydrate property order without weakening values', () => {
    expect(canonicalPreviewHash({ a: 1, b: { x: 2, y: 3 } })).toBe(canonicalPreviewHash({ b: { y: 3, x: 2 }, a: 1 }))
    expect(canonicalPreviewHash({ a: 1 })).not.toBe(canonicalPreviewHash({ a: 2 }))
  })
})
