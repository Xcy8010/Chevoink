// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NovelImportArtifactDescriptor, NovelImportDocumentReport, NovelImportEvidencePreview, NovelImportReportDto, NovelImportPreviewSummary } from '../../shared/contracts/novel-import-preview.js'
import { ImportCoverPicker } from '../../src/features/studio/components/import-cover-picker'
import { safeImportArtifactUrl } from '../../src/features/studio/lib/import-artifact'
import { applyContentSelection, assertNovelImportPreviewComplete, refreshPreviewWarnings, reportHash } from '../../api/lib/novel-import/preview.js'
import { finalizeStoredImageReport } from '../../api/lib/novel-import/preview-storage.js'

vi.mock('../../src/features/studio/components/import-artifact-viewer', () => ({ ImportArtifactViewer: ({ onClose }: { onClose: () => void }) => <button type="button" onClick={onClose}>关闭来源图片</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const hash = 'a'.repeat(64)
const sourceHash = 'b'.repeat(64)
const storageId = '123e4567-e89b-12d3-a456-426614174000'
const logicalId = 'image_cover_logical'
const coverSource = '作品.zip!/作品信息以及发布建议/封面.webp'
const optionalExportCoverReason = '用户未选择本站导出封面；该图片与全部保留内容来源独立，不导入其图片或 OCR 内容。'

function artifact(overrides: Partial<NovelImportArtifactDescriptor> = {}): NovelImportArtifactDescriptor {
  return { id: logicalId, storageArtifactId: storageId, source: coverSource, sha256: hash, bytes: 512, mediaType: 'image/png', width: 2, height: 2, coverCandidate: true,
    url: `/api/novels/novel-a/imports/job-a/artifacts/${storageId}`, ...overrides }
}

function report(overrides: Partial<NovelImportDocumentReport> = {}): NovelImportDocumentReport {
  return { version: 1, sourceId: 'source-a', sourceHash, parserVersion: 'zip+document-pipeline-2', complete: false,
    items: [
      { id: 'root', kind: 'file', source: '作品.zip', status: 'native', excludable: false },
      { id: 'chapter-file', kind: 'file', source: '作品.zip!/正文/第一卷/第一章.txt', status: 'native', excludable: true },
      { id: 'cover-file', kind: 'file', source: coverSource, status: 'native', excludable: true },
      { id: 'cover-item', kind: 'image', source: coverSource, status: 'native', excludable: true, artifactId: logicalId },
    ],
    issues: [{ id: 'storage', code: 'IMPORT_IMAGE_STORAGE_REQUIRED', message: '图片资源须保存到私有存储。', blocking: true, itemIds: ['cover-item'], resolution: 'none' }], ...overrides }
}

function preview(options: { finalized?: boolean; artifacts?: NovelImportArtifactDescriptor[]; report?: NovelImportDocumentReport; parserVersion?: string } = {}): NovelImportEvidencePreview {
  const currentReport = options.report ?? report(options.parserVersion ? { parserVersion: options.parserVersion } : {})
  const currentArtifacts = options.artifacts ?? [artifact()]
  const value: NovelImportEvidencePreview = {
    manifestRevision: 1, manifestHash: hash, sourceHash, parserVersion: currentReport.parserVersion, sourceChars: 2,
    metadata: { title: '导入作品' }, metadataSelection: { title: '导入作品' }, warnings: [], partialImport: false,
    volumes: [{ title: '正文', chapters: [{ title: '第一章', content: '正文', source: { memberPath: '作品.zip!/正文/第一卷/第一章.txt' } }] }],
    artifacts: currentArtifacts, report: currentReport, reportHash: reportHash(currentReport), decisions: [],
  }
  return options.finalized ? { ...value, report: finalizeStoredImageReport(currentReport, currentArtifacts), reportHash: reportHash(finalizeStoredImageReport(currentReport, currentArtifacts)) } : value
}

function summaryFrom(value: NovelImportEvidencePreview): NovelImportPreviewSummary {
  return { ...value, volumes: value.volumes.map((volume, volumeIndex) => ({ title: volume.title, chapters: volume.chapters.map((chapter, chapterIndex) => ({ title: chapter.title, source: chapter.source, volumeIndex, chapterIndex, contentHash: hash, characters: chapter.content.length, nonEmpty: true })) })) }
}

function reportDto(value: NovelImportEvidencePreview): NovelImportReportDto {
  const report = value.report!
  return { manifestRevision: value.manifestRevision, manifestHash: value.manifestHash, sourceHash: value.sourceHash, reportHash: value.reportHash!, partialImport: false,
    items: report.items.map(({ text: _text, ...item }) => item), issues: [], decisions: [], artifacts: value.artifacts ?? [] }
}

describe('import image storage completeness and scoped artifacts', () => {
  it('accepts a logical image id with a distinct persisted UUID URL and keeps legacy UUID previews readable', () => {
    const current = artifact()
    expect(safeImportArtifactUrl('novel-a', 'job-a', current)).toContain(`/artifacts/${storageId}`)
    expect(safeImportArtifactUrl('novel-a', 'job-a', { ...current, storageArtifactId: undefined })).toContain(`/artifacts/${storageId}`)
    for (const url of [
      `https://evil.test/api/novels/novel-a/imports/job-a/artifacts/${storageId}`,
      `/api/novels/other/imports/job-a/artifacts/${storageId}`,
      `/api/novels/novel-a/imports/other/artifacts/${storageId}`,
      `/api/novels/novel-a/imports/job-a/artifacts/${storageId}?download=1`,
      `/api/novels/novel-a/imports/job-a/artifacts/${storageId}/extra`,
    ]) expect(safeImportArtifactUrl('novel-a', 'job-a', { ...current, url })).toBeNull()
    expect(safeImportArtifactUrl('novel-a', 'job-a', { ...current, storageArtifactId: 'different-uuid' })).toBeNull()
  })

  it('finalizes a persisted image report by removing only the storage requirement', () => {
    const initial = report()
    const finalized = finalizeStoredImageReport(initial, [artifact()])
    expect(finalized.complete).toBe(true)
    expect(finalized.issues).toEqual([])
    expect(finalized.items.find(item => item.id === 'cover-item')).toMatchObject({ artifactId: logicalId, status: 'native' })

    const quality = finalizeStoredImageReport({ ...initial, items: initial.items.map(item => item.id === 'cover-item' ? { ...item, status: 'ocr' as const } : item) }, [artifact()])
    expect(quality.complete).toBe(true)
    const failed = finalizeStoredImageReport({ ...initial, items: initial.items.map(item => item.id === 'cover-item' ? { ...item, status: 'failed' as const } : item) }, [artifact()])
    expect(failed.complete).toBe(false)
    const blocked = finalizeStoredImageReport({ ...initial, issues: [...initial.issues, { id: 'hard', code: 'IMPORT_IMAGE_INVALID', message: '坏图', blocking: true, itemIds: ['cover-item'], resolution: 'none' }] }, [artifact()])
    expect(blocked.complete).toBe(false)
  })

  it('rejects missing artifact references while finalizing', () => {
    expect(() => finalizeStoredImageReport(report(), [])).toThrow(expect.objectContaining({ code: 'IMPORT_IMAGE_INVALID' }))
  })

  it('requires explicit verified pipeline-2 image storage for a historical incomplete report', () => {
    const current = preview()
    expect(() => assertNovelImportPreviewComplete(current)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    expect(() => assertNovelImportPreviewComplete(current, { verifiedImageStorage: true })).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))

    const historical = preview({ finalized: true })
    historical.report = { ...historical.report!, complete: false }
    historical.reportHash = reportHash(historical.report)
    expect(() => assertNovelImportPreviewComplete(historical)).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    expect(() => assertNovelImportPreviewComplete(historical, { verifiedImageStorage: true })).not.toThrow()
  })

  it('does not treat unknown versions, missing evidence, failed items, or review items as verified image storage', () => {
    const finalized = preview({ finalized: true })
    finalized.report = { ...finalized.report!, complete: false }
    finalized.reportHash = reportHash(finalized.report)
    const unknownVersion = { ...finalized, parserVersion: 'zip+document-pipeline-1', report: { ...finalized.report!, parserVersion: 'zip+document-pipeline-1' } }
    unknownVersion.reportHash = reportHash(unknownVersion.report!)
    expect(() => assertNovelImportPreviewComplete(unknownVersion, { verifiedImageStorage: true })).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))

    expect(() => assertNovelImportPreviewComplete({ ...finalized, artifacts: [] }, { verifiedImageStorage: true })).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    const missingSource = { ...finalized, report: { ...finalized.report!, items: finalized.report!.items.map(item => item.id === 'cover-item' ? { ...item, source: 'other.webp' } : item) } }
    missingSource.reportHash = reportHash(missingSource.report!)
    expect(() => assertNovelImportPreviewComplete(missingSource, { verifiedImageStorage: true })).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    for (const status of ['failed', 'needs_review'] as const) {
      const unresolved = { ...finalized, report: { ...finalized.report!, complete: false, items: finalized.report!.items.map(item => item.id === 'cover-item' ? { ...item, status } : item) } }
      unresolved.reportHash = reportHash(unresolved.report!)
      expect(() => assertNovelImportPreviewComplete(unresolved, { verifiedImageStorage: true })).toThrow(expect.objectContaining({ code: 'IMPORT_INCOMPLETE_CONTENT' }))
    }
  })

  it('does not generate an exclusion for an unselected native export cover', () => {
    const current = preview({ finalized: true })
    const next = applyContentSelection(current, { expectedManifestRevision: 1, manifestHash: hash, chapters: [{ volumeIndex: 0, chapterIndex: 0 }], plans: [], memories: [], metadataSelection: { title: '导入作品' } })
    expect(next.decisions).toEqual([])
    expect(next.contentExclusions ?? []).toEqual([])
    expect(refreshPreviewWarnings(next).warnings.some(warning => warning.blocking)).toBe(false)
  })

  it('removes only the exact historical native-cover auto-exclusion when that cover is selected', () => {
    const current = preview({ finalized: true })
    const reportHashValue = current.reportHash!
    const decision = (overrides: Partial<NonNullable<NovelImportEvidencePreview['decisions']>[number]> = {}) => ({
      itemId: 'cover-file', action: 'exclude' as const, reason: optionalExportCoverReason,
      sourceHash: current.sourceHash, reportHash: reportHashValue, contentHash: '', reviewedAt: '2026-09-19T00:00:00.000Z', ...overrides,
    })
    current.decisions = [
      decision(),
      decision({ reportHash: 'c'.repeat(64) }),
      { ...decision({ itemId: 'chapter-file' }), reason: '人工排除章节' },
    ]

    const next = applyContentSelection(current, {
      expectedManifestRevision: 1, manifestHash: hash,
      chapters: [{ volumeIndex: 0, chapterIndex: 0 }], plans: [], memories: [],
      metadataSelection: { title: '导入作品', coverArtifactId: logicalId },
    })

    expect(next.decisions).toEqual([
      expect.objectContaining({ itemId: 'cover-file', reason: optionalExportCoverReason, reportHash: 'c'.repeat(64) }),
      expect.objectContaining({ itemId: 'chapter-file', reason: '人工排除章节' }),
    ])
  })

  it('keeps a manually reasoned native-cover exclusion when the cover is not selected', () => {
    const current = preview({ finalized: true })
    current.decisions = [{ itemId: 'cover-file', action: 'exclude', reason: '人工排除：不需要这个文件。', sourceHash: current.sourceHash, reportHash: current.reportHash!, contentHash: '', reviewedAt: '2026-09-19T00:00:00.000Z' }]
    const next = applyContentSelection(current, { expectedManifestRevision: 1, manifestHash: hash, chapters: [{ volumeIndex: 0, chapterIndex: 0 }], plans: [], memories: [], metadataSelection: { title: '导入作品' } })
    expect(next.decisions).toEqual([expect.objectContaining({ itemId: 'cover-file', reason: '人工排除：不需要这个文件。' })])
  })
})

describe('ImportCoverPicker logical and persisted artifact ids', () => {
  it.each([true, false])('keeps the cover radio selectable for %s storageArtifactId', hasStorageId => {
    const current = artifact(hasStorageId ? {} : { storageArtifactId: undefined, url: `/api/novels/novel-a/imports/job-a/artifacts/${storageId}` })
    const value = preview({ artifacts: [current], report: report() })
    const onSelect = vi.fn()
    render(<ImportCoverPicker novelId="novel-a" jobId="job-a" summary={summaryFrom(value)} report={reportDto(value)} selectedId={undefined} disabled={false} onSelect={onSelect} />)
    const radio = screen.getByRole('radio', { name: `使用封面：${coverSource}` }) as HTMLInputElement
    expect(radio.disabled).toBe(false)
    fireEvent.click(radio)
    expect(onSelect).toHaveBeenCalledWith(logicalId)
  })
})
