// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as baseRender, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { NovelImportChapterDto, NovelImportPreviewSummary, NovelImportReportDto } from '../../shared/contracts/novel-import-preview'
import ImportDialog from '../../src/features/studio/components/ImportDialog'
import { ImportStructuredEditor } from '../../src/features/studio/components/import-structured-editor'
import { ImportIntegrityReport } from '../../src/features/studio/components/import-integrity-report'
import { ImportAiSuggestions } from '../../src/features/studio/components/import-ai-suggestions'
import { ImportDialogShell } from '../../src/features/studio/components/import-dialog-shell'
import { ImportBodyViewer } from '../../src/features/studio/components/import-body-viewer'
import { importPreviewApi, type ImportStructureEdit } from '../../src/features/studio/import-preview-api'
import { novelImportApi } from '../../src/features/studio/import-api'
import { importSuggestionsApi, validateImportBoundaries } from '../../src/features/studio/import-suggestions-api'
import { importStructureFromSummary, splitImportSegments } from '../../src/features/studio/lib/import-structure'
import { importRawCursor } from '../../src/features/studio/lib/import-body'
import { safeImportArtifactUrl } from '../../src/features/studio/lib/import-artifact'
import { ToastProvider } from '../../src/components/ui/Toast'

// ImportDialog 使用 useToast（成功提示），测试统一包 ToastProvider；rerender 会沿用同一 wrapper。
const render = (ui: Parameters<typeof baseRender>[0], options?: Parameters<typeof baseRender>[1]) => baseRender(ui, { wrapper: ToastProvider, ...options })

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const hash = 'a'.repeat(64), expiry = '2099-01-01T00:00:00Z'
const contents = ['第一段\r\n第二段🙂\n尾\n\n', '未读取也必须保留的正文\n末尾', '最后一章\n']
const summary: NovelImportPreviewSummary = { manifestRevision: 1, manifestHash: hash, sourceHash: hash, parserVersion: '2', sourceChars: contents.join('').length, metadata: { title: '识别标题' }, metadataSelection: {}, warnings: [], partialImport: false, volumes: [{ title: '正文卷', chapters: contents.map((content, chapterIndex) => ({ title: `第${chapterIndex + 1}章`, source: { filename: '原稿.txt' }, volumeIndex: 0, chapterIndex, contentHash: hash, characters: content.length, nonEmpty: true })) }] }
const report: NovelImportReportDto = { manifestRevision: 1, manifestHash: hash, reportHash: hash, sourceHash: hash, partialImport: false, items: [{ id: 'file-1', kind: 'file', source: '原稿.txt', status: 'native', excludable: false }], issues: [], decisions: [], artifacts: [] }
const chapterDto = (index: number, revision = 1): NovelImportChapterDto => ({ ...summary.volumes[0].chapters[index], content: contents[index], manifestRevision: revision, manifestHash: hash })
const job = { jobId: 'job-a', novelId: 'a', status: 'ready' as const, jobVersion: 1, manifestRevision: 1, manifestHash: hash, sourceHash: hash, targetHash: hash, errorCode: null, expiresAt: expiry, receipt: null }
function previewClient() {
  return { summary: vi.fn().mockResolvedValue(summary), report: vi.fn().mockResolvedValue(report), chapter: vi.fn().mockImplementation(async (_n, _j, revision, _v, index) => chapterDto(index, revision)), structure: vi.fn().mockResolvedValue(summary), review: vi.fn().mockResolvedValue(summary) } satisfies typeof importPreviewApi
}
async function clickArmed(name: string | RegExp) {
  const target = await screen.findByRole('button', { name })
  await waitFor(() => expect((target as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(target)
}
function dialogFixture() {
  const client = { ...novelImportApi, capabilities: vi.fn().mockResolvedValue({ enabled: true, restoreEnabled: false, overwriteEnabled: true, aiEnabled: false, sourceBytes: 50000, formats: [], limitations: [] }), list: vi.fn().mockResolvedValue([job]), preflight: vi.fn().mockResolvedValue({ intentId: 'intent', targetHash: hash, volumeCount: 0, chapterCount: 0, nonEmptyChapterCount: 0, overwriteRequired: false, confirmationStep: 0, expiresAt: expiry }), rebase: vi.fn().mockResolvedValue(job), preview: vi.fn(), confirm: vi.fn(), commit: vi.fn() }
  const modern = previewClient()
  const props = { open: true, novelId: 'a', novelTitle: '作品A', modelSelection: { kind: 'basic' as const }, beforeImport: vi.fn().mockResolvedValue(true), onClose: vi.fn(), onImported: vi.fn(), client, previewClient: modern }
  return { props, client, modern }
}

describe('revision-bound on-demand preview', () => {
  it('splits an oversized loaded chapter into complete ranges without losing the last tail or sending body writes', async () => {
    const content = '字'.repeat(200050) + '最后尾巴\n'
    const large = { ...summary, volumes: [{ title: '大卷', chapters: [{ ...summary.volumes[0].chapters[0], characters: content.length }] }] }
    const modern = previewClient()
    modern.chapter.mockResolvedValue({ ...chapterDto(0), content, characters: content.length })
    let latest: ImportStructureEdit | undefined
    function Harness() {
      const [draft, setDraft] = useState<ImportStructureEdit>({ expectedManifestRevision: 1, manifestHash: hash, volumes: importStructureFromSummary(large) })
      return <ImportStructuredEditor novelId="a" jobId="j" summary={large} draft={draft} disabled={false} dirty aiEnabled={false} currentMetadata={{ title: '作品' }} client={modern} onChange={next => { latest = next; setDraft(next) }} />
    }
    render(<Harness />)
    await screen.findByLabelText('原文正文')
    const split = () => {
      fireEvent.change(screen.getByLabelText('跳转字符位置'), { target: { value: '100000' } })
      fireEvent.click(screen.getByRole('button', { name: '定位拆分光标' }))
      fireEvent.click(screen.getByRole('button', { name: '在光标处拆分为两章' }))
    }
    split()
    fireEvent.click(screen.getByRole('button', { name: /^2\./ }))
    await screen.findByLabelText('原文正文')
    split()
    expect(latest!.volumes[0].chapters).toHaveLength(3)
    const materialized = latest!.volumes[0].chapters.map(chapter => chapter.segments.map(segment => content.slice(segment.start, segment.end)).join(''))
    expect(materialized.join('')).toBe(content)
    expect(materialized[2]).toBe('字'.repeat(50) + '最后尾巴\n')
    expect(JSON.stringify(latest)).not.toContain('"content":')
    expect(modern.chapter).toHaveBeenCalledTimes(1)
    expect(modern.structure).not.toHaveBeenCalled()
  })
  it('loads only selected bodies and saves untouched unread chapters as references, never empty content', async () => {
    const { props, client, modern } = dialogFixture()
    render(<ImportDialog {...props} />)
    await clickArmed(/任务 job-a/)
    await screen.findByLabelText('原文正文')
    expect(client.preview).not.toHaveBeenCalled()
    expect(modern.chapter).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('章名'), { target: { value: '改名首章' } })
    expect((screen.getByRole('button', { name: '导入 1 卷 3 章' }) as HTMLButtonElement).disabled).toBe(true)
    await clickArmed('保存预览调整')
    await waitFor(() => expect(modern.structure).toHaveBeenCalledTimes(1))
    const payload = modern.structure.mock.calls[0][2] as ImportStructureEdit
    expect(payload.volumes[0].chapters[0].title).toBe('改名首章')
    expect(payload.volumes[0].chapters[1].segments).toEqual([{ volumeIndex: 0, chapterIndex: 1, start: 0, end: contents[1].length }])
    expect(JSON.stringify(payload)).not.toContain('"content":')
    expect(modern.chapter.mock.calls.some(call => call[4] === 1)).toBe(false)
    expect(client.confirm).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('allows read-only history navigation but disables editing, with no late body from another selection', async () => {
    const modern = previewClient()
    let resolveFirst!: (value: NovelImportChapterDto) => void
    modern.chapter.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    const onChange = vi.fn()
    render(<ImportStructuredEditor novelId="a" jobId="job-a" summary={summary} draft={{ expectedManifestRevision: 1, manifestHash: hash, volumes: importStructureFromSummary(summary) }} disabled dirty={false} aiEnabled={false} currentMetadata={{ title: '作品' }} onChange={onChange} client={modern} />)
    expect((screen.getByLabelText('章名') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^2\. 第2章/ }))
    await screen.findByLabelText('原文正文')
    expect((screen.getByLabelText('原文正文') as HTMLTextAreaElement).value).toBe(contents[1])
    await act(async () => { resolveFirst(chapterDto(0)) })
    expect((screen.getByLabelText('原文正文') as HTMLTextAreaElement).value).toBe(contents[1])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects mismatched body versions instead of presenting or applying stale content', async () => {
    const modern = previewClient()
    modern.chapter.mockResolvedValue(chapterDto(0, 99))
    render(<ImportStructuredEditor novelId="a" jobId="job-a" summary={summary} draft={{ expectedManifestRevision: 1, manifestHash: hash, volumes: importStructureFromSummary(summary) }} disabled={false} dirty={false} aiEnabled={false} currentMetadata={{ title: '作品' }} onChange={vi.fn()} client={modern} />)
    expect((await screen.findByRole('alert')).textContent).toContain('版本不匹配')
    expect(screen.queryByLabelText('原文正文')).toBeNull()
  })

  it('splits exact source ranges, including CRLF, and guarantees concatenation across segment boundaries', () => {
    const segments = [{ volumeIndex: 0, chapterIndex: 0, start: 2, end: 8 }, { volumeIndex: 0, chapterIndex: 1, start: 0, end: 10 }]
    const split = splitImportSegments(segments, 9)!
    const materialize = (refs: typeof segments) => refs.map(ref => contents[ref.chapterIndex].slice(ref.start, ref.end)).join('')
    expect(materialize(split[0]) + materialize(split[1])).toBe(materialize(segments))
    expect(split[1][0].start).toBe(3)
    expect(importRawCursor('前\r\n后\r尾', 3)).toBe(4)
  })

  it('renders only a bounded window of a huge chapter and can reach the final tail without truncation', () => {
    const content = '字'.repeat(200050) + '🙂末尾\r\n\n'
    const onCursor = vi.fn()
    render(<ImportBodyViewer content={content} onCursor={onCursor} />)
    expect((screen.getByLabelText('原文正文') as HTMLTextAreaElement).value.length).toBe(20000)
    fireEvent.change(screen.getByLabelText('跳转字符位置'), { target: { value: String(content.length) } })
    fireEvent.click(screen.getByRole('button', { name: '定位拆分光标' }))
    expect(onCursor).toHaveBeenLastCalledWith(content.length)
    expect((screen.getByLabelText('原文正文') as HTMLTextAreaElement).value.endsWith('🙂末尾\n\n')).toBe(true)
  })

  it('uses summary nonEmpty and completeness gates, not positive character count, before import', async () => {
    const { props, modern, client } = dialogFixture()
    modern.summary.mockResolvedValue({ ...summary, volumes: [{ title: '卷', chapters: summary.volumes[0].chapters.map(chapter => ({ ...chapter, nonEmpty: false })) }] })
    render(<ImportDialog {...props} />)
    await clickArmed(/任务 job-a/)
    await screen.findByLabelText('原文正文')
    expect((screen.getByRole('button', { name: '导入 1 卷 3 章' }) as HTMLButtonElement).disabled).toBe(true)
    expect(client.commit).not.toHaveBeenCalled()
  })
})

describe('source review and AI approval', () => {
  const failedReport: NovelImportReportDto = { ...report, items: [{ id: 'p1', kind: 'page', source: '书.pdf', page: 1, status: 'failed', excludable: true }], issues: [{ id: 'i1', code: 'PAGE_FAILED', message: '第1页未能读取', itemIds: ['p1'], resolution: 'exclude', blocking: true, resolved: false }] }
  it('bounds both source and issue DOM lists while keeping the final problem reachable', () => {
    const many = { ...failedReport, items: Array.from({ length: 101 }, (_, index) => ({ ...failedReport.items[0], id: `p${index}`, source: `文件${index}` })), issues: Array.from({ length: 101 }, (_, index) => ({ ...failedReport.issues[0], id: `i${index}`, message: `问题${index}` })) }
    render(<ImportIntegrityReport novelId="a" jobId="j" report={many} disabled onReview={vi.fn()} />)
    expect(screen.getAllByRole('article')).toHaveLength(30)
    expect(screen.queryByText(/问题100/)).toBeNull()
    for (let page = 0; page < 3; page++) fireEvent.click(screen.getByRole('button', { name: '下一页问题' }))
    expect(screen.getByText(/问题100/)).toBeTruthy()
    expect(screen.queryByText(/阻断：问题0 /)).toBeNull()
  })
  it('requires an exclusion reason and independent confirmation bound to report and manifest hashes', async () => {
    const onReview = vi.fn().mockResolvedValue(undefined)
    render(<ImportIntegrityReport novelId="a" jobId="j" report={failedReport} disabled={false} onReview={onReview} />)
    fireEvent.change(screen.getByLabelText('处理「p1」'), { target: { value: 'exclude' } })
    expect((screen.getByRole('button', { name: '确认 1 项来源处理' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('理由「p1」'), { target: { value: '此页为广告，明确不导入' } })
    fireEvent.click(screen.getByRole('button', { name: '确认 1 项来源处理' }))
    await screen.findByRole('dialog', { name: '确认来源核对与排除？' })
    expect(onReview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回核对' }))
    expect(onReview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认 1 项来源处理' }))
    await clickArmed('记录决定并更新预览')
    expect(onReview).toHaveBeenCalledWith({ expectedManifestRevision: 1, manifestHash: hash, reportHash: hash, decisions: [{ itemId: 'p1', action: 'exclude', reason: '此页为广告，明确不导入' }] })
    expect(screen.getByText(/阻断：第1页未能读取/)).toBeTruthy()
  })

  it('only accepts exact owned artifact URLs and never external or another job image paths', () => {
    const artifact = { id: 'image', source: '原图', sha256: hash, bytes: 1, mediaType: 'image/png' as const, width: 1, height: 1, coverCandidate: false, url: '/api/novels/a/imports/j/artifacts/image' }
    expect(safeImportArtifactUrl('a', 'j', artifact)).toContain('/api/novels/a/imports/j/artifacts/image')
    for (const url of ['https://evil.test/image', '/api/novels/b/imports/j/artifacts/image', '/api/novels/a/imports/other/artifacts/image', 'C:/private.png']) expect(safeImportArtifactUrl('a', 'j', { ...artifact, url })).toBeNull()
  })

  it('quotes the job-bound model, charges only after human confirmation, and never auto-applies boundaries', async () => {
    const client = { ...importSuggestionsApi, quote: vi.fn().mockResolvedValue({ fingerprint: hash, modelName: '固定自定义模型', kind: 'custom', reasoningEffort: 'low', maxInputTokens: 8000, maxOutputTokens: 2000, notice: '供应商可能收费' }), request: vi.fn().mockResolvedValue({ id: 's', status: 'succeeded', result: { boundaries: [{ offset: 0, title: '首章' }, { offset: 3, title: '尾章' }], note: '只建议结构' } }), list: vi.fn().mockResolvedValue([]) }
    const onApply = vi.fn()
    function Nested() { const [open, setOpen] = useState(true); return open ? <ImportDialogShell title="导入工作台" description="作品" stage="workspace" onClose={() => setOpen(false)}><ImportAiSuggestions novelId="a" jobId="j" selection={{ manifestRevision: 1, manifestHash: hash, volumeIndex: 0, chapterIndex: 0 }} content={'首段\n尾段'} disabled={false} onApply={onApply} client={client} /></ImportDialogShell> : null }
    render(<Nested />)
    fireEvent.click(screen.getByRole('button', { name: '查看模型与费用' }))
    const modal = await screen.findByRole('dialog', { name: '确认 AI 结构分析费用？' })
    expect(within(modal).getByText(/固定自定义模型/)).toBeTruthy()
    expect(client.request).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: '导入工作台' })).toBeTruthy()
    expect(client.request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看模型与费用' }))
    await clickArmed('同意费用并请求建议')
    await screen.findByText('只建议结构')
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '应用这些边界（不改写正文）' }))
    expect(onApply).toHaveBeenCalledWith([{ offset: 0, title: '首章' }, { offset: 3, title: '尾章' }])
  })

  it('rejects malformed AI boundaries without discarding any source body', () => {
    expect(validateImportBoundaries('前\n后🙂', [{ offset: 0, title: '一' }, { offset: 2, title: '二' }])).toBe(true)
    for (const boundaries of [[], [{ offset: 1, title: '一' }], [{ offset: 0, title: '' }], [{ offset: 0, title: '一' }, { offset: 4, title: '二' }], [{ offset: 0, title: '一' }, { offset: 2, title: '二' }, { offset: 2, title: '三' }]]) expect(validateImportBoundaries('前\n后🙂', boundaries)).toBe(false)
  })

  it('does not resend a paid request after network failure and ignores records from another manifest', async () => {
    const selection = { manifestRevision: 1, manifestHash: hash, volumeIndex: 0, chapterIndex: 0 }
    const client = { ...importSuggestionsApi, quote: vi.fn().mockResolvedValue({ fingerprint: hash, modelName: 'basic', kind: 'basic', reasoningEffort: 'low', maxInputTokens: 8000, maxOutputTokens: 2000, notice: '按实际用量结算' }), request: vi.fn().mockRejectedValue(new Error('network lost')), list: vi.fn().mockResolvedValue([{ ...selection, manifestRevision: 9, id: 'wrong', status: 'succeeded', result: { boundaries: [{ offset: 0, title: '旧版本建议' }], note: '不要应用' } }]) }
    const onApply = vi.fn()
    render(<ImportAiSuggestions novelId="a" jobId="j" selection={selection} content="正文" disabled={false} onApply={onApply} client={client} />)
    fireEvent.click(screen.getByRole('button', { name: '查看模型与费用' }))
    await clickArmed('同意费用并请求建议')
    await screen.findByText('network lost')
    expect((screen.getByRole('button', { name: '查看模型与费用' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '查询建议记录' }))
    await screen.findByText(/尚未查询到结果/)
    expect(screen.queryByText('不要应用')).toBeNull()
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })
})
