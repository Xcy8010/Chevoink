import { describe, expect, it } from 'vitest'
import { applyContentSelection, assertNovelImportPreviewComplete, previewReportDto, reportHash } from '../../api/lib/novel-import/preview.js'
import { novelImportSelectionSchema, type NovelImportEvidencePreview } from '../../shared/contracts/novel-import-preview.js'

const hash = 'a'.repeat(64)
function preview(): NovelImportEvidencePreview {
  const report = { version: 1 as const, sourceId: 'source', sourceHash: hash, parserVersion: 'test', complete: true,
    items: [{ id: 'root', kind: 'file' as const, source: 'book.txt', status: 'native' as const, excludable: false }], issues: [] }
  return { manifestRevision: 2, manifestHash: hash, sourceHash: hash, parserVersion: 'test', sourceChars: 40,
    metadata: { title: '候选标题' }, metadataSelection: {}, warnings: [], report, reportHash: reportHash(report), decisions: [],
    volumes: [{ title: '卷一', chapters: [
      { title: '甲', content: ' 保留原文\n😀 ', source: { memberPath: 'book.txt#char=0-10' } },
      { title: '乙', content: '未选择章节', source: { memberPath: 'book.txt#char=10-20' } },
    ] }],
    plans: [{ title: '大纲甲', content: '选中计划', source: { memberPath: 'book.txt#char=20-24' } }, { title: '大纲乙', content: '未选计划' }],
    memories: [{ memoryType: 'worldbuilding', title: '设定', content: '未选记忆' }],
  }
}
const selection = (p: NovelImportEvidencePreview, chapters = [{ volumeIndex: 0, chapterIndex: 0 }], plans = [0], memories: number[] = []) => novelImportSelectionSchema.parse({ expectedManifestRevision: p.manifestRevision, manifestHash: p.manifestHash, chapters, plans, memories })

function legacyCoverPreview(): NovelImportEvidencePreview {
  const p = preview(), source = 'book.zip!/书/作品信息以及发布建议/封面.png'
  p.artifacts = [{ id: 'cover', source, sha256: hash, bytes: 100, mediaType: 'image/png', width: 1, height: 1, coverCandidate: true, url: '/private-artifact' }]
  p.report!.items.push(
    { id: 'body', kind: 'file', source: 'book.zip!/书/正文/卷/第0001章 甲.txt', status: 'native', excludable: true },
    { id: 'cover-file', kind: 'file', source, status: 'needs_review', excludable: true },
    { id: 'cover-image', kind: 'image', source, status: 'needs_review', excludable: true, artifactId: 'cover' },
  )
  p.report!.complete = false
  p.report!.issues.push({ id: 'ocr', code: 'OCR_REVIEW_REQUIRED', message: '旧封面 OCR 待核对', blocking: true, itemIds: ['cover-file', 'cover-image'], resolution: 'review' })
  p.reportHash = reportHash(p.report!)
  return p
}

describe('explicit import content selection', () => {
  it('逐字保留选中章节与计划，未选项有版本绑定审计，不伪造来源排除', () => {
    const p = preview(), before = structuredClone(p)
    const next = applyContentSelection(p, selection(p))
    expect(next.volumes[0].chapters).toEqual([p.volumes[0].chapters[0]])
    expect(next.plans).toEqual([p.plans![0]])
    expect(next.memories).toEqual([])
    expect(next.contentExclusions).toEqual([
      expect.objectContaining({ kind: 'chapter', title: '乙', manifestRevision: 2, manifestHash: hash, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ kind: 'plan', title: '大纲乙' }),
      expect.objectContaining({ kind: 'memory', title: '设定' }),
    ])
    expect(next.partialImport).toBe(true)
    expect(next.report).toEqual(p.report)
    expect(next.reportHash).toBe(p.reportHash)
    expect(next.decisions).toEqual([])
    expect(previewReportDto(next).contentExclusions).toEqual(next.contentExclusions)
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
    expect(p).toEqual(before)
  })

  it('请求数组不能重排原文，过滤掉空卷', () => {
    const p = preview()
    p.volumes.push({ title: '卷二', chapters: [{ title: '丙', content: '原文', source: { filename: 'other.txt' } }] })
    const next = applyContentSelection(p, selection(p, [{ volumeIndex: 0, chapterIndex: 1 }, { volumeIndex: 0, chapterIndex: 0 }], [], []))
    expect(next.volumes).toEqual([p.volumes[0]])
  })

  it.each(['stale', 'chapter', 'plan', 'memory', 'duplicate'] as const)('拒绝 %s 请求且不修改预览', kind => {
    const p = preview(), before = structuredClone(p), input = selection(p)
    if (kind === 'stale') input.expectedManifestRevision++
    if (kind === 'chapter') input.chapters[0].chapterIndex = 88
    if (kind === 'plan') input.plans = [88]
    if (kind === 'memory') input.memories = [88]
    if (kind === 'duplicate') input.chapters.push(input.chapters[0])
    expect(() => applyContentSelection(p, input)).toThrow(expect.objectContaining({ code: kind === 'stale' ? 'IMPORT_PREVIEW_CHANGED' : 'IMPORT_INPUT_INVALID' }))
    expect(p).toEqual(before)
  })

  it('全空选择拒绝；仅显式作品信息可导入', () => {
    const p = preview(), empty = selection(p, [], [], [])
    expect(() => applyContentSelection(p, empty)).toThrow(expect.objectContaining({ code: 'IMPORT_NO_BODY' }))
    const next = applyContentSelection(p, { ...empty, metadataSelection: { title: '新标题', tags: [] } })
    expect(next.volumes).toEqual([])
    expect(next.metadataSelection).toEqual({ title: '新标题', tags: [] })
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
  })

  it('取消选中全部正文也不能清除缺失内容硬阻断', () => {
    const p = preview()
    p.report!.complete = false
    p.report!.issues.push({ id: 'missing', code: 'IMPORT_NATIVE_COVERAGE_UNKNOWN', message: '缺页', blocking: true, itemIds: ['root'], resolution: 'none' })
    p.reportHash = reportHash(p.report!)
    const next = applyContentSelection(p, { ...selection(p, [], [], []), metadataSelection: { title: '仅信息' } })
    expect(next.warnings).toContainEqual(expect.objectContaining({ code: 'IMPORT_NATIVE_COVERAGE_UNKNOWN', blocking: true }))
    expect(() => assertNovelImportPreviewComplete(next)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
  })

  it('封面只能选择当前任务中存在的未排除资源', () => {
    const p = preview()
    expect(() => applyContentSelection(p, { ...selection(p), metadataSelection: { coverArtifactId: 'foreign' } })).toThrow(expect.objectContaining({ code: 'IMPORT_COVER_INVALID' }))
  })

  it('旧导出封面未选且与保留内容不相交时精确排除其文件，绝不伪造review', () => {
    const p = legacyCoverPreview()
    const next = applyContentSelection(p, selection(p))
    expect(next.decisions).toEqual([expect.objectContaining({ itemId: 'cover-file', action: 'exclude' })])
    expect(previewReportDto(next).issues[0].resolved).toBe(true)
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
  })

  it.each(['selected', 'shared', 'generic', 'unknown-source', 'hard-blocker'] as const)('封面 %s 条件不允许解除来源阻断', condition => {
    const p = legacyCoverPreview(), input = selection(p)
    if (condition === 'selected') input.metadataSelection = { coverArtifactId: 'cover' }
    if (condition === 'shared') p.volumes[0].chapters[0].source = { memberPath: `${p.artifacts![0].source}!/ocr.png#page=1` }
    if (condition === 'generic') {
      p.artifacts![0].source = 'book.zip!/scan.png'
      for (const item of p.report!.items.filter(item => item.id.startsWith('cover-'))) item.source = 'book.zip!/scan.png'
    }
    if (condition === 'unknown-source') delete p.plans![0].source
    if (condition === 'hard-blocker') p.report!.issues[0].resolution = 'none'
    p.reportHash = reportHash(p.report!)
    const next = applyContentSelection(p, input)
    expect(() => assertNovelImportPreviewComplete(next)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    expect(next.decisions?.some(decision => decision.action === 'review')).toBe(false)
    if (condition !== 'hard-blocker') expect(next.decisions).toEqual([])
  })
})
