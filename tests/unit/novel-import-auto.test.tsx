// @vitest-environment jsdom
import { cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportDialog, { type ImportDialogProps } from '../../src/features/studio/components/ImportDialog'
import type { NovelImportClient } from '../../src/features/studio/import-api'
import type { NovelImportJobStatus, NovelImportPreflight, NovelImportReceipt } from '../../shared/contracts/novel-import'
import type { NovelImportPreviewSummary, NovelImportReportDto, NovelImportReportIssue } from '../../shared/contracts/novel-import-preview'
import { ToastProvider } from '../../src/components/ui/Toast'

// 与 novel-import-ui.test.tsx 一致：ImportDialog 使用 useToast，测试统一包 ToastProvider。
const render = (ui: Parameters<typeof baseRender>[0], options?: Parameters<typeof baseRender>[1]) => baseRender(ui, { wrapper: ToastProvider, ...options })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const expiry = '2099-01-01T00:00:00.000Z'
const hash = 'a'.repeat(64)
const reportHash = 'b'.repeat(64)
// chapterCount 0：一键入口直接进入自动管线，无需覆盖确认。
const emptyCheck: NovelImportPreflight = { intentId: 'intent', targetHash: hash, chapterCount: 0, volumeCount: 0, nonEmptyChapterCount: 0, overwriteRequired: false, confirmationStep: 0, expiresAt: expiry }
// chapterCount 1：仍需服务端强制的两次覆盖确认后才自动导入。
const overwriteCheck: NovelImportPreflight = { intentId: 'intent', targetHash: hash, chapterCount: 1, volumeCount: 1, nonEmptyChapterCount: 1, overwriteRequired: true, confirmationStep: 0, expiresAt: expiry }
const status: NovelImportJobStatus = { jobId: 'job-a', novelId: 'a', status: 'ready', jobVersion: 1, manifestRevision: 1, manifestHash: hash, sourceHash: hash, targetHash: hash, errorCode: null, expiresAt: expiry, receipt: null }
const receipt: NovelImportReceipt = { jobId: 'job-a', novelId: 'a', backupId: 'backup', volumeCount: 1, chapterCount: 1, wordCount: 4, firstChapterId: 'new-chapter', targetHash: hash, restoreExpiresAt: expiry }
const summary: NovelImportPreviewSummary = {
  manifestRevision: 1, manifestHash: hash, sourceHash: hash, parserVersion: '1', sourceChars: 4,
  metadata: { title: '识别书名', summary: '识别简介', tags: ['标签'] }, metadataSelection: {}, warnings: [],
  volumes: [{ title: '正文卷', chapters: [{ title: '原章', source: { filename: '小说.txt' }, volumeIndex: 0, chapterIndex: 0, contentHash: hash, characters: 4, nonEmpty: true }] }],
}
const cleanReport: NovelImportReportDto = { manifestRevision: 1, manifestHash: hash, reportHash, sourceHash: hash, partialImport: false, items: [], issues: [], decisions: [], artifacts: [] }
const issue = (over: Partial<NovelImportReportIssue> & { resolved?: boolean } = {}): NovelImportReportIssue & { resolved: boolean } => ({ id: 'issue-1', code: 'OCR_LOW_CONFIDENCE', message: '低置信度片段', blocking: true, itemIds: ['i1'], resolution: 'review', resolved: false, ...over })

function clientFixture() {
  const client: NovelImportClient = {
    capabilities: vi.fn().mockResolvedValue({ enabled: true, overwriteEnabled: true, aiEnabled: false, sourceBytes: 10000, formats: ['zip', 'txt', 'md', 'pdf', 'doc', 'docx'].map(extension => ({ extension, enabled: extension !== 'doc', reason: extension === 'doc' ? '转换器未开放' : undefined })), limitations: [] }),
    list: vi.fn().mockResolvedValue([]), preflight: vi.fn().mockResolvedValue(emptyCheck),
    confirmIntent: vi.fn().mockImplementation(async (_novelId, _intent, step) => ({ ...overwriteCheck, confirmationStep: step })),
    create: vi.fn().mockResolvedValue({ ...status, status: 'uploading' }),
    upload: vi.fn().mockResolvedValue({ ...status, status: 'uploaded' }),
    attachment: vi.fn().mockResolvedValue({ ...status, status: 'uploaded' }),
    analyze: vi.fn().mockResolvedValue(status), retry: vi.fn().mockResolvedValue(status), status: vi.fn().mockResolvedValue(status),
    preview: vi.fn().mockResolvedValue(summary), edit: vi.fn().mockResolvedValue(summary),
    rebase: vi.fn().mockResolvedValue(status), confirm: vi.fn().mockResolvedValue({ approvalId: 'approval', expiresAt: expiry }),
    commit: vi.fn().mockResolvedValue(receipt), cancel: vi.fn().mockResolvedValue({ ...status, status: 'cancelled' }),
    restorePreview: vi.fn(), restoreConfirm: vi.fn(), restore: vi.fn(),
  } as unknown as NovelImportClient
  return client
}
function previewFixture(report: NovelImportReportDto = cleanReport) {
  return {
    summary: vi.fn().mockResolvedValue(summary),
    chapter: vi.fn().mockResolvedValue({}),
    report: vi.fn().mockResolvedValue(report),
    structure: vi.fn().mockResolvedValue(summary),
    review: vi.fn().mockResolvedValue(summary),
  }
}
function dialogProps(over: Partial<ImportDialogProps> = {}) {
  const client = clientFixture()
  const previewClient = previewFixture()
  const props: ImportDialogProps = {
    open: true, novelId: 'a', novelTitle: '作品 A', modelSelection: { kind: 'basic' },
    beforeImport: vi.fn().mockResolvedValue(true), onClose: vi.fn(), onImported: vi.fn(),
    client, previewClient: previewClient as unknown as ImportDialogProps['previewClient'],
    autoFile: new File(['原文正文'], '小说.txt', { type: 'text/plain' }), ...over,
  }
  return { client, previewClient, props }
}
async function armedClick(name: string | RegExp) {
  const target = await screen.findByRole('button', { name })
  await waitFor(() => expect((target as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(target)
}

describe('一键导入自动管线', () => {
  it('空作品选择文件后自动跑完上传/解析/提交，成功 toast 并关闭，不停在报告页', async () => {
    const { client, previewClient, props } = dialogProps()
    render(<ImportDialog {...props} />)
    await screen.findByText(/导入完成：1 卷 1 章 · 4 字/)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.upload).toHaveBeenCalledTimes(1)
    expect(client.analyze).toHaveBeenCalledTimes(1)
    expect(client.confirm).toHaveBeenCalledTimes(1)
    expect(client.commit).toHaveBeenCalledTimes(1)
    expect(client.confirmIntent).not.toHaveBeenCalled()
    // 自动核对读取了目录与完整性报告，但不要求用户手动确认报告
    expect(previewClient.summary).toHaveBeenCalled()
    expect(previewClient.report).toHaveBeenCalled()
    expect(props.onImported).toHaveBeenCalledWith(receipt)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('可自动核对的阻断项（resolution=review）自动提交来源确认后继续导入', async () => {
    const { client, previewClient, props } = dialogProps()
    const unresolved = { ...cleanReport, issues: [issue()] }
    const resolved = { ...cleanReport, issues: [issue({ resolved: true })] }
    vi.mocked(previewClient.report).mockResolvedValueOnce(unresolved).mockResolvedValueOnce(resolved)
    render(<ImportDialog {...props} />)
    await screen.findByText(/导入完成：1 卷 1 章 · 4 字/)
    expect(previewClient.review).toHaveBeenCalledTimes(1)
    const reviewArg = vi.mocked(previewClient.review).mock.calls[0][2]
    expect(reviewArg.decisions).toEqual([{ itemId: 'i1', action: 'review', reason: '一键导入自动核对：确认保留该部分原文。' }])
    expect(client.commit).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('无法自动处理的阻断项（resolution=exclude）回落手动核对，绝不自动提交', async () => {
    const { client, previewClient, props } = dialogProps()
    vi.mocked(previewClient.report).mockResolvedValue({ ...cleanReport, issues: [issue({ resolution: 'exclude' })] })
    render(<ImportDialog {...props} />)
    await screen.findByText(/已切换到手动核对/)
    expect(client.confirm).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    expect(props.onImported).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    // 回落到手动 workspace：展示手动提交入口（此时因未解决阻断项而禁用），用户可继续核对
    await screen.findByRole('button', { name: /导入 1 卷 1 章/ })
  })

  it('已有章节时保留服务端强制的两次覆盖确认，确认后再自动导入', async () => {
    const { client, props } = dialogProps()
    vi.mocked(client.preflight).mockResolvedValue(overwriteCheck)
    render(<ImportDialog {...props} />)
    await screen.findByRole('dialog', { name: '是否覆盖当前作品章节？' })
    expect(client.create).not.toHaveBeenCalled()
    await armedClick('是，继续')
    await screen.findByRole('dialog', { name: '再次确认覆盖' })
    await armedClick('确认并选择文件')
    await screen.findByText(/导入完成：1 卷 1 章 · 4 字/)
    expect(client.confirmIntent).toHaveBeenNthCalledWith(1, 'a', overwriteCheck, 1)
    expect(client.confirmIntent).toHaveBeenNthCalledWith(2, 'a', { ...overwriteCheck, confirmationStep: 1 }, 2)
    expect(client.commit).toHaveBeenCalledTimes(1)
    expect(props.onImported).toHaveBeenCalledWith(receipt)
  })
})
