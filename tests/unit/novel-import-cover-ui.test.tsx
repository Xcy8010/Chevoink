// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { NovelImportArtifactDescriptor, NovelImportPreviewSummary, NovelImportReportDto } from '../../shared/contracts/novel-import-preview'
import { ImportCoverPicker } from '../../src/features/studio/components/import-cover-picker'
import { ImportStructuredEditor } from '../../src/features/studio/components/import-structured-editor'
import type { ImportStructureEdit } from '../../src/features/studio/import-preview-api'
import { importPreviewApi } from '../../src/features/studio/import-preview-api'

vi.mock('../../src/features/studio/components/import-artifact-viewer', () => ({ ImportArtifactViewer: ({ onClose }: { onClose: () => void }) => <button type="button" onClick={onClose}>关闭来源图片</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const hash = 'a'.repeat(64)
const cover: NovelImportArtifactDescriptor = { id: 'cover-a', source: '原稿/封面.png', sha256: hash, bytes: 3 * 1024 * 1024, mediaType: 'image/png', width: 900, height: 1200, coverCandidate: true, url: '/api/novels/a/imports/job/artifacts/cover-a' }
const summary: NovelImportPreviewSummary = { manifestRevision: 1, manifestHash: hash, sourceHash: hash, sourceChars: 0, parserVersion: '2', metadata: {}, metadataSelection: {}, warnings: [], artifacts: [cover], volumes: [{ title: '正文卷', chapters: [] }] }
const report: NovelImportReportDto = { manifestRevision: 1, manifestHash: hash, reportHash: hash, sourceHash: hash, partialImport: false, artifacts: [cover], issues: [], decisions: [], items: [{ id: 'image-item', kind: 'image', artifactId: cover.id, source: cover.source, status: 'native', excludable: true }] }

it('defaults to retaining the current cover and image viewing never authorizes replacement', () => {
  const onSelect = vi.fn()
  render(<ImportCoverPicker novelId="a" jobId="job" summary={summary} report={report} disabled={false} onSelect={onSelect} />)
  expect((screen.getByRole('radio', { name: /保留现有封面/ }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('radio', { name: /使用封面/ }) as HTMLInputElement).checked).toBe(false)
  expect(screen.getByText(/选中的图片将在点击.*一键导入.*后作为作品封面公开显示/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /查看候选/ }))
  expect(screen.getByRole('button', { name: '关闭来源图片' })).toBeTruthy()
  expect(onSelect).not.toHaveBeenCalled()
})

it('selects only the stable artifact ID and cancellation omits that field while preserving other metadata and body references', () => {
  const onChange = vi.fn()
  const client = { ...importPreviewApi, chapter: vi.fn() }
  function Harness() {
    const [draft, setDraft] = useState<ImportStructureEdit>({ expectedManifestRevision: 1, manifestHash: hash, metadataSelection: { title: '已选书名', tags: ['保留标签'] }, volumes: [{ title: '正文卷', chapters: [] }] })
    return <ImportStructuredEditor novelId="a" jobId="job" summary={summary} report={report} draft={draft} disabled={false} dirty={false} aiEnabled={false} currentMetadata={{ title: '原书名' }} client={client} onChange={next => { onChange(next); setDraft(next) }} />
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('radio', { name: /使用封面/ }))
  const selected = onChange.mock.calls[0][0] as ImportStructureEdit
  expect(selected.metadataSelection).toEqual({ title: '已选书名', tags: ['保留标签'], coverArtifactId: 'cover-a' })
  expect(selected.expectedManifestRevision).toBe(1)
  expect(selected.manifestHash).toBe(hash)
  expect(JSON.stringify(selected)).not.toContain('/artifacts/')
  fireEvent.click(screen.getByRole('radio', { name: /保留现有封面/ }))
  const cancelled = onChange.mock.calls[1][0] as ImportStructureEdit
  expect(cancelled.metadataSelection).toEqual({ title: '已选书名', tags: ['保留标签'] })
  expect(JSON.stringify(cancelled)).not.toContain('coverArtifactId')
  expect(cancelled.volumes).toBe(selected.volumes)
  expect(client.chapter).not.toHaveBeenCalled()
})

it('allows exactly 3 MiB but disables larger candidates without hiding their source', () => {
  const larger = { ...cover, id: 'large', source: '过大封面.png', bytes: cover.bytes + 1, url: '/api/novels/a/imports/job/artifacts/large' }
  render(<ImportCoverPicker novelId="a" jobId="job" summary={{ ...summary, artifacts: [cover, larger] }} report={report} disabled={false} onSelect={vi.fn()} />)
  expect((screen.getByRole('radio', { name: `使用封面：${cover.source}` }) as HTMLInputElement).disabled).toBe(false)
  expect((screen.getByRole('radio', { name: '使用封面：过大封面.png' }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText(/封面上限 3 MiB/)).toBeTruthy()
})

it.each(['excluded-parent', 'wrong-revision', 'wrong-job', 'missing-report', 'read-only'] as const)('blocks %s candidates and never changes selection', mode => {
  const candidate = mode === 'wrong-job' ? { ...cover, url: '/api/novels/a/imports/other/artifacts/cover-a' } : cover
  const evidence = mode === 'excluded-parent' ? { ...report, items: [{ ...report.items[0], parentId: 'parent' }, { id: 'parent', kind: 'file' as const, source: '原稿', status: 'excluded' as const, excludable: true }] } : mode === 'wrong-revision' ? { ...report, manifestRevision: 2 } : report
  const onSelect = vi.fn()
  render(<ImportCoverPicker novelId="a" jobId="job" summary={{ ...summary, artifacts: [candidate] }} report={mode === 'missing-report' ? undefined : evidence} disabled={mode === 'read-only'} onSelect={onSelect} />)
  const radio = screen.getByRole('radio', { name: /使用封面/ }) as HTMLInputElement
  expect(radio.disabled).toBe(true)
  fireEvent.click(radio)
  expect(onSelect).not.toHaveBeenCalled()
})
