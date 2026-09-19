import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedNovelImport } from '../../api/lib/novel-import/parsers/types.js'
import { createNovelImportPipeline } from '../../api/lib/novel-import/pipeline.js'
import { createIsolatedNovelImportParser } from '../../api/lib/novel-import/isolated-parser.js'
import { parseNovelImportFile } from '../../api/lib/novel-import/parser.js'
import * as converters from '../../api/lib/novel-import/parsers/isolated.js'
import { zipFiles } from './novel-import-parser.fixtures.js'
import { applySourceReview, applyStructureEdit, assertNovelImportPreviewComplete, canonicalPreviewHash, previewContentHash, previewReportDto, reportHash } from '../../api/lib/novel-import/preview.js'
import { novelImportReviewSchema, novelImportStructureSchema, type NovelImportDocumentReport, type NovelImportEvidencePreview } from '../../shared/contracts/novel-import-preview.js'

// Keep the real pipeline/router/report composition; only replace the Worker boundary.
vi.mock('../../api/lib/novel-import/isolated-parser.js', () => ({ createIsolatedNovelImportParser: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

const hash = 'a'.repeat(64)
function preview(): NovelImportEvidencePreview {
  const report: NovelImportDocumentReport = {
    version: 1, sourceId: 'source', sourceHash: hash, parserVersion: 'test', complete: false,
    items: [
      { id: 'root', kind: 'file', source: 'book.zip', status: 'native', excludable: false },
      { id: 'bad', kind: 'file', source: 'book.zip!/bad.txt', status: 'failed', excludable: true, parentId: 'root' },
      { id: 'good', kind: 'file', source: 'book.zip!/good.txt', status: 'native', excludable: true, parentId: 'root' },
    ],
    issues: [{ id: 'failed', code: 'IMPORT_MEMBER_FAILED', message: '文件解析不完整', blocking: true, itemIds: ['bad'], resolution: 'exclude' }],
  }
  return {
    manifestRevision: 1, manifestHash: hash, sourceHash: hash, parserVersion: 'test', sourceChars: 20,
    metadata: {}, metadataSelection: {}, warnings: [], report, reportHash: reportHash(report), decisions: [], artifacts: [],
    volumes: [{ title: '正文', chapters: [{ title: '第一章', content: '失败文件中的残存正文', source: { memberPath: 'book.zip!/bad.txt#char=0-11' } }] }],
    plans: [
      { title: '失败大纲', content: '不可导入的计划', source: { memberPath: 'book.zip!/bad.txt#char=12-19' } },
      { title: '保留大纲', content: '唯一有效的计划正文', source: { memberPath: 'book.zip!/good.txt#char=0-10' } },
    ],
    memories: [{ memoryType: 'characterCard', title: '失败人物设定', content: '不可遗留的记忆', source: { memberPath: 'book.zip!/bad.txt#char=20-27' } }],
  }
}
function decision(p: NovelImportEvidencePreview, itemId: string, action: 'exclude' | 'review' = 'exclude') {
  return novelImportReviewSchema.parse({ expectedManifestRevision: p.manifestRevision, manifestHash: p.manifestHash, reportHash: p.reportHash,
    decisions: [{ itemId, action, reason: '人工核验来源' }] })
}
function reviewablePreview(): NovelImportEvidencePreview {
  const p = preview()
  p.report!.items[1].status = 'needs_review'
  p.report!.issues = [{ id: 'quality', code: 'OCR_REVIEW_REQUIRED', message: '核对来源', blocking: true, itemIds: ['bad'], resolution: 'review' }]
  p.reportHash = reportHash(p.report!)
  return p
}

describe('source routing pipeline evidence', () => {
  it('本站导出ZIP保留规划和明确正文，封面只安全转码而不产生正文OCR阻断', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64')
    const converter = vi.spyOn(converters, 'runConverter').mockResolvedValue({ base64: png.toString('base64'), width: 1, height: 1 })
    const nativeParser = vi.fn().mockRejectedValue(new Error('cover must not invoke OCR'))
    vi.mocked(createIsolatedNovelImportParser).mockReturnValue((bytes, filename, options) => parseNovelImportFile(bytes, filename, { ...options, resources: true, nativeParser }))
    const result = await createNovelImportPipeline()(zipFiles({
      '书/正文/第一卷/第0001章 秘密计划.txt': '秘密计划\n\n真实章节正文',
      '书/规划/故事.txt': '规划逐字保留',
      '书/目录/目录.txt': '目录不作正文',
      '书/作品信息以及发布建议/作品信息.txt': '作品名称：原书\n简介：介绍\n作者：甲\n',
      '书/作品信息以及发布建议/发布建议.txt': '发布建议不作正文',
      '书/作品信息以及发布建议/封面.png': png,
    }), 'export.zip', { sourceId: 'source' })
    expect(converter).toHaveBeenCalledTimes(1)
    expect(nativeParser).not.toHaveBeenCalled()
    expect(result.parsed.volumes.flatMap(v => v.chapters)).toEqual([{ title: '秘密计划', content: '真实章节正文', source: 'export.zip!/书/正文/第一卷/第0001章 秘密计划.txt' }])
    expect(result.parsed.plans).toEqual([{ title: '故事', content: '规划逐字保留', source: 'export.zip!/书/规划/故事.txt' }])
    expect(result.report.items.filter(item => item.kind === 'block').map(item => item.text)).toEqual(expect.arrayContaining(['真实章节正文', '规划逐字保留']))
    expect(result.report.items.find(item => item.kind === 'image')).toMatchObject({ status: 'native', source: 'export.zip!/书/作品信息以及发布建议/封面.png' })
    expect(result.report.issues.filter(issue => issue.blocking).map(issue => issue.code)).toEqual(['IMPORT_IMAGE_STORAGE_REQUIRED'])
    expect(result.artifacts).toHaveLength(1)
  })

  it('导出ZIP的空正文与未知附件仍阻断，不因作品信息或规划而隐藏', async () => {
    vi.mocked(createIsolatedNovelImportParser).mockReturnValue((bytes, filename, options) => parseNovelImportFile(bytes, filename, { ...options, resources: true }))
    const result = await createNovelImportPipeline()(zipFiles({
      '书/正文/第一卷/第0001章 开篇.txt': '开篇\n\n',
      '书/规划/故事.txt': '规划内容',
      '书/作品信息以及发布建议/作品信息.txt': '作品名称：原书',
      '书/作品信息以及发布建议/未知附件.bin': '未知内容',
    }), 'export.zip', { sourceId: 'source' })
    expect(result.report.complete).toBe(false)
    expect(result.report.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_ARCHIVE_MEMBER_EMPTY', blocking: true }))
    expect(result.report.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_ARCHIVE_MEMBER_EXCLUDED', blocking: true }))
  })

  it('真实 ZIP 混合来源完整保留，失败成员不能假复核，只能明确排除', async () => {
    vi.mocked(createIsolatedNovelImportParser).mockReturnValue((bytes, filename, options) => parseNovelImportFile(bytes, filename, { ...options, resources: true }))
    const result = await createNovelImportPipeline()(zipFiles({
      '第一章 秘密计划.txt': '正文不可误分流。',
      '故事大纲.txt': '计划逐字保留。',
      '人物设定.txt': '记忆逐字保留。',
      'missing.rtf': 'unsupported fixture',
    }), 'book.zip', { sourceId: 'source' })
    expect(result.parsed.volumes.flatMap(v => v.chapters).map(c => c.title)).toEqual(['第一章 秘密计划'])
    expect(result.parsed.plans).toEqual([{ title: '故事大纲', content: '计划逐字保留。', source: 'book.zip!/故事大纲.txt' }])
    expect(result.parsed.memories).toEqual([{ title: '人物设定', content: '记忆逐字保留。', memoryType: 'characterCard', source: 'book.zip!/人物设定.txt' }])
    expect(result.report.items.filter(item => item.kind === 'block').map(item => item.text)).toEqual(expect.arrayContaining(['正文不可误分流。', '计划逐字保留。', '记忆逐字保留。']))
    const failed = result.report.items.find(item => item.source === 'book.zip!/missing.rtf')!
    expect(failed).toMatchObject({ status: 'failed', excludable: true })
    expect(result.report.issues.find(issue => issue.itemIds.includes(failed.id) && issue.blocking)?.resolution).toBe('exclude')
    const p: NovelImportEvidencePreview = {
      ...preview(), ...result.parsed, sourceHash: result.report.sourceHash, report: result.report, reportHash: reportHash(result.report),
      volumes: result.parsed.volumes.map(v => ({ ...v, chapters: v.chapters.map(c => ({ ...c, source: { memberPath: c.source } })) })),
      plans: result.parsed.plans?.map(item => ({ ...item, source: { memberPath: item.source } })),
      memories: result.parsed.memories?.map(item => ({ ...item, source: { memberPath: item.source } })),
    }
    expect(() => applySourceReview(p, decision(p, failed.id, 'review'))).toThrow(expect.objectContaining({ code: 'IMPORT_REVIEW_INVALID' }))
    expect(() => assertNovelImportPreviewComplete(p)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    const excluded = applySourceReview(p, decision(p, failed.id))
    expect(excluded.partialImport).toBe(true)
    expect(excluded.plans).toEqual(p.plans)
    expect(excluded.memories).toEqual(p.memories)
    expect(() => assertNovelImportPreviewComplete(excluded)).not.toThrow()
  })

  it.each([false, true])('报告保留路由前计划和记忆的完整正文（仅路由内容：%s）', async (routedOnly) => {
    const chapters = [
      { title: '故事大纲', content: '  计划正文😀\n不可丢失的尾行\n', source: 'book.md#char=0-25' },
      { title: '世界观', content: '设定正文\n最后一行', source: 'book.md#char=26-40' },
      ...(!routedOnly ? [{ title: '第一章', content: '章节正文', source: 'book.md#char=41-45' }] : []),
    ]
    const raw: ParsedNovelImport = { volumes: [{ title: '卷一', chapters }], metadata: {}, warnings: [], sourceChars: 45, parserVersion: 'test' }
    const parse = vi.fn<ReturnType<typeof createIsolatedNovelImportParser>>().mockResolvedValue(raw)
    vi.mocked(createIsolatedNovelImportParser).mockReturnValue(parse)
    const bytes = Buffer.from('synthetic import fixture')
    const result = await createNovelImportPipeline()(bytes, 'book.md', { sourceId: 'source' })
    expect(parse).toHaveBeenCalledTimes(1)
    expect(result.parsed.plans).toEqual([chapters[0]])
    expect(result.parsed.memories).toEqual([{ ...chapters[1], memoryType: 'worldbuilding' }])
    expect(result.parsed.volumes.flatMap(v => v.chapters)).toEqual(chapters.slice(2))
    expect(result.report.items.filter(item => item.kind === 'block').map(item => ({ source: item.source, text: item.text })))
      .toEqual(chapters.map(chapter => ({ source: chapter.source, text: chapter.content })))
    expect(result.report).toMatchObject({ complete: true, issues: [], sourceId: 'source', sourceHash: createHash('sha256').update(bytes).digest('hex'), parserVersion: result.parsed.parserVersion })
  })
})

describe('source exclusions across chapters, plans and memories', () => {
  it('排除失败文件同时移除正文、计划和记忆，仅剩有效计划也可导入', () => {
    const p = preview(); const before = structuredClone(p)
    expect(() => assertNovelImportPreviewComplete(p)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    const next = applySourceReview(p, decision(p, 'bad'))
    expect(next.volumes.flatMap(v => v.chapters)).toEqual([])
    expect(next.plans).toEqual([p.plans![1]])
    expect(next.memories).toEqual([])
    expect(next.partialImport).toBe(true)
    expect(next.decisions).toEqual([expect.objectContaining({ itemId: 'bad', action: 'exclude', sourceHash: hash, reportHash: p.reportHash, contentHash: previewContentHash(next) })])
    expect(previewReportDto(next).issues).toEqual([expect.objectContaining({ id: 'failed', resolved: true })])
    expect(next.report).toEqual(p.report)
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
    expect(p).toEqual(before)
  })

  it('最后一个计划被排除时拒绝空导入且不修改原预览', () => {
    const p = preview(); const next = applySourceReview(p, decision(p, 'bad')); const before = structuredClone(next)
    expect(() => applySourceReview(next, decision(next, 'good'))).toThrow(expect.objectContaining({ code: 'IMPORT_NO_BODY' }))
    expect(next).toEqual(before)
  })

  it('仅保留记忆同样是有效内容，真正空预览仍被拒绝', () => {
    const p = preview()
    p.memories!.push({ memoryType: 'worldbuilding', title: '保留设定', content: '有效设定', source: { filename: 'book.zip!/good.txt' } })
    p.plans = []
    const next = applySourceReview(p, decision(p, 'bad'))
    expect(next.memories).toEqual([p.memories![1]])
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
    expect(() => assertNovelImportPreviewComplete({ ...next, memories: [] })).toThrow(expect.objectContaining({ code: 'IMPORT_NO_BODY' }))
  })

  it.each(['plans', 'memories'] as const)('旧 %s 缺少 source 时排除失败并保留全部输入', (bucket) => {
    const p = preview()
    delete p[bucket]![0].source
    const before = structuredClone(p)
    expect(() => applySourceReview(p, decision(p, 'bad'))).toThrow(expect.objectContaining({ code: 'IMPORT_ROUTING_SOURCE_REQUIRED' }))
    expect(p).toEqual(before)
  })

  it('空来源对象不被当作可定位来源而静默保留', () => {
    const p = preview()
    p.plans![0].source = {}
    expect(() => applySourceReview(p, decision(p, 'bad'))).toThrow(expect.objectContaining({ code: 'IMPORT_ROUTING_SOURCE_REQUIRED' }))
  })

  it('page=1 的排除不误删 page=10 的计划和记忆', () => {
    const p = preview()
    p.report!.items[1] = { id: 'bad', kind: 'page', source: 'book.pdf#page=1', status: 'failed', excludable: true, parentId: 'root' }
    p.report!.items[2] = { id: 'good', kind: 'page', source: 'book.pdf#page=10', status: 'native', excludable: true, parentId: 'root' }
    p.reportHash = reportHash(p.report!)
    p.volumes = []
    p.plans = [1, 10].map(page => ({ title: `计划${page}`, content: '计划正文', source: { memberPath: `book.pdf#page=${page}#char=0-4` } }))
    p.memories = [1, 10].map(page => ({ memoryType: 'worldbuilding', title: `设定${page}`, content: '设定正文', source: { filename: `book.pdf#page=${page}&region=2` } }))
    const next = applySourceReview(p, decision(p, 'bad'))
    expect(next.plans).toEqual([p.plans[1]])
    expect(next.memories).toEqual([p.memories[1]])
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
  })
})

describe('routed preview hashes and persisted review compatibility', () => {
  it('无路由及旧无 source 路由继续使用 volumes 的 canonical hash', () => {
    const p = preview()
    expect(previewContentHash({ ...p, plans: undefined, memories: undefined })).toBe(canonicalPreviewHash(p.volumes))
    for (const entry of [...p.plans!, ...p.memories!]) delete entry.source
    expect(previewContentHash(p)).toBe(canonicalPreviewHash(p.volumes))
  })

  it('旧持久化 review 的 volumes hash 仍可通过完整性校验', () => {
    const p = reviewablePreview()
    for (const entry of [...p.plans!, ...p.memories!]) delete entry.source
    p.decisions = [{ itemId: 'bad', action: 'review', reason: '旧版已核验', sourceHash: p.sourceHash, reportHash: p.reportHash!, contentHash: canonicalPreviewHash(p.volumes), reviewedAt: '2026-09-18T00:00:00.000Z' }]
    expect(() => assertNovelImportPreviewComplete(p)).not.toThrow()
    expect(() => applySourceReview(p, decision(p, 'bad', 'review'))).not.toThrow()
  })

  it.each(['plans', 'memories'] as const)('新 hash 绑定 %s 的正文和来源，变更会使 review 失效', (bucket) => {
    const p = reviewablePreview(); const reviewed = applySourceReview(p, decision(p, 'bad', 'review'))
    expect(() => assertNovelImportPreviewComplete(reviewed)).not.toThrow()
    expect(previewContentHash(reviewed)).toBe(canonicalPreviewHash({ volumes: reviewed.volumes, plans: reviewed.plans, memories: reviewed.memories }))
    for (const field of ['content', 'source'] as const) {
      const changed = structuredClone(reviewed)
      if (field === 'content') changed[bucket]![0].content += '改动'
      else changed[bucket]![0].source = { memberPath: 'book.zip!/other.txt' }
      expect(previewContentHash(changed)).not.toBe(previewContentHash(reviewed))
      expect(() => assertNovelImportPreviewComplete(changed)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    }
  })
})
describe('plan-only structure metadata editing', () => {
  it('零卷计划预览可保存 metadata，保留来源、排除审计和计划正文', () => {
    const original = preview()
    const p = applySourceReview(original, decision(original, 'bad'))
    p.volumes = []
    const before = structuredClone(p)
    const metadataSelection = { title: '仅导入计划', summary: '计划说明', tags: ['计划'] }
    const input = novelImportStructureSchema.parse({ expectedManifestRevision: p.manifestRevision, manifestHash: p.manifestHash, volumes: [], metadataSelection })
    const next = applyStructureEdit(p, input)
    expect(next.volumes).toEqual([])
    expect(next.metadataSelection).toEqual(metadataSelection)
    expect(next.plans).toEqual(p.plans)
    expect(next.memories).toEqual([])
    expect(next.decisions).toEqual(p.decisions)
    expect(next.reportHash).toBe(p.reportHash)
    expect(() => assertNovelImportPreviewComplete(next)).not.toThrow()
    expect(p).toEqual(before)
  })

  it('允许零卷的 schema 不允许通过结构编辑删除已有正文', () => {
    const p = preview(); const before = structuredClone(p)
    const input = novelImportStructureSchema.parse({ expectedManifestRevision: p.manifestRevision, manifestHash: p.manifestHash, volumes: [], metadataSelection: { title: '不能丢正文' } })
    expect(() => applyStructureEdit(p, input)).toThrow(expect.objectContaining({ code: 'IMPORT_CONTENT_NOT_CONSERVED' }))
    expect(p).toEqual(before)
  })
})
