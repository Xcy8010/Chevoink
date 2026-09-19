// @vitest-environment jsdom
import { cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportDialog, { type ImportDialogProps } from '../../src/features/studio/components/ImportDialog'
import { ImportIntegrityReport } from '../../src/features/studio/components/import-integrity-report'
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
    confirmSelectionIntent: vi.fn().mockResolvedValue({ ...overwriteCheck, confirmationStep: 2 }),
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
    selection: vi.fn().mockResolvedValue(summary),
    chapter: vi.fn().mockResolvedValue({ ...summary.volumes[0].chapters[0], content: '原文正文', manifestRevision: 1, manifestHash: hash }),
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
  it('人工控件不允许用 review 掩盖混合的缺失阻断项或 failed 状态', () => {
    const report: NovelImportReportDto = { ...cleanReport,
      items: [{ id: 'i1', kind: 'page', source: 's#1', status: 'native', excludable: true }, { id: 'i2', kind: 'page', source: 's#2', status: 'failed', excludable: true }],
      issues: [issue(), issue({ id: 'missing', resolution: 'exclude', resolved: true }), issue({ id: 'failed', itemIds: ['i2'] })],
    }
    render(<ImportIntegrityReport novelId="a" jobId="job-a" report={report} disabled={false} onReview={vi.fn()} />)
    expect(screen.queryByRole('option', { name: '我已对照原文核对' })).toBeNull()
    expect(screen.getAllByRole('option', { name: '明确排除此来源' })).toHaveLength(2)
  })

  it('一键解析完成后停在预览，只有最终人工确认才写入', async () => {
    const { client, previewClient, props } = dialogProps()
    render(<ImportDialog {...props} />)
    await screen.findByRole('button', { name: '一键导入' })
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.analyze).toHaveBeenCalledTimes(1)
    expect(previewClient.review).not.toHaveBeenCalled()
    expect(client.confirm).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(document.querySelector('[class*="animate-spin"]')).toBeNull())
    await armedClick('一键导入')
    await waitFor(() => expect(props.onImported).toHaveBeenCalledWith(receipt))
    expect(previewClient.selection).toHaveBeenCalledWith('a', 'job-a', expect.objectContaining({ expectedManifestRevision: 1, manifestHash: hash }))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('review 阻断项回预览，机器不代替人工核对', async () => {
    const { client, previewClient, props } = dialogProps()
    previewClient.report.mockResolvedValue({ ...cleanReport, items: [{ id: 'i1', kind: 'page', source: 's#1', status: 'needs_review', excludable: true }], issues: [issue()] })
    render(<ImportDialog {...props} />)
    await screen.findByText(/自动流程不会代替人工核对/)
    expect(previewClient.review).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('正在导入')).toBeNull()
    expect(screen.getByRole('option', { name: '我已对照原文核对' })).toBeTruthy()
  })

  it('缺失项只 exclude，展示排除列表并等待最终确认，不静默提交', async () => {
    const { client, previewClient, props } = dialogProps()
    const items: NovelImportReportDto['items'] = [{ id: 'i1', kind: 'page', source: '缺页.pdf#page=2', status: 'native', excludable: true }]
    const unresolved = { ...cleanReport, items, issues: [issue({ resolution: 'exclude' })] }
    const decisions: NovelImportReportDto['decisions'] = [{ itemId: 'i1', action: 'exclude', reason: '自动排除缺失来源', reviewedAt: expiry, sourceHash: hash, reportHash, contentHash: hash }]
    const resolved = { ...unresolved, partialImport: true, decisions, issues: [issue({ resolution: 'exclude', resolved: true })] }
    previewClient.report.mockResolvedValueOnce(unresolved).mockResolvedValue(resolved)
    previewClient.review.mockResolvedValue({ ...summary, partialImport: true })
    render(<ImportDialog {...props} />)
    await screen.findByText(/已停止自动提交/)
    expect(previewClient.review).toHaveBeenCalledWith('a', 'job-a', expect.objectContaining({
      expectedManifestRevision: 1, manifestHash: hash, reportHash,
      decisions: [expect.objectContaining({ itemId: 'i1', action: 'exclude' })],
    }))
    expect((screen.getByLabelText('筛选来源类型') as HTMLSelectElement).value).toBe('excluded')
    expect(screen.getByText(/缺页.pdf#page=2/)).toBeTruthy()
    expect(client.confirm).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    await armedClick('一键导入')
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('无来源定位时不发送 review，明确解释并停转圈', async () => {
    const { client, previewClient, props } = dialogProps()
    previewClient.report.mockResolvedValue({ ...cleanReport, issues: [issue({ resolution: 'exclude' })] })
    render(<ImportDialog {...props} />)
    await screen.findByText(/无法定位问题来源/)
    expect(previewClient.review).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('正在导入')).toBeNull()
    expect(screen.getByRole('button', { name: '查询任务状态' })).toBeTruthy()
  })

  it('服务异常后查询原任务恢复预览，不重新创建、解析或取消任务', async () => {
    const { client, previewClient, props } = dialogProps()
    previewClient.report.mockRejectedValueOnce(new Error('报告请求失败')).mockResolvedValue(cleanReport)
    render(<ImportDialog {...props} />)
    await screen.findByText('报告请求失败')
    expect(screen.queryByLabelText('正在导入')).toBeNull()
    await armedClick('查询任务状态')
    await screen.findByText('来源完整性报告')
    expect(client.status).toHaveBeenCalledWith('a', 'job-a')
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.analyze).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('解析失败仅重试原 job', async () => {
    const { client, props } = dialogProps()
    vi.mocked(client.analyze).mockResolvedValue({ ...status, status: 'failed', errorCode: 'IMPORT_PARSE_FAILED' })
    render(<ImportDialog {...props} />)
    await armedClick('重试确定性解析')
    await screen.findByText('来源完整性报告')
    expect(client.retry).toHaveBeenCalledWith('a', 'job-a', undefined)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
  })

  it('创建结果未知时阻止再次上传，不盲目新建任务', async () => {
    const { client, props } = dialogProps()
    vi.mocked(client.create).mockRejectedValue(new Error('网络中断'))
    render(<ImportDialog {...props} />)
    await screen.findByText(/创建任务结果未知/)
    expect((screen.getByRole('button', { name: '上传并检查文件' }) as HTMLButtonElement).disabled).toBe(true)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
  })

  it('已有未完成任务时不创建、不取消任何任务', async () => {
    const { client, props } = dialogProps()
    vi.mocked(client.list).mockResolvedValue([
      { ...status, jobId: 'old-live' },
      { ...status, jobId: 'other-novel', novelId: 'b' },
    ])
    render(<ImportDialog {...props} />)
    await screen.findByText(/当前作品已有未完成导入/)
    expect(client.cancel).not.toHaveBeenCalled()
    expect(client.create).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /old-live/ })).toBeTruthy()
  })

  it('合并语义只在最终一键导入前授权，解析阶段不写入作品', async () => {
    const { client, props } = dialogProps()
    vi.mocked(client.preflight).mockResolvedValue(overwriteCheck)
    render(<ImportDialog {...props} />)
    await screen.findByRole('button', { name: '一键导入' })
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.confirmSelectionIntent).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    await armedClick('一键导入')
    expect(client.confirmSelectionIntent).toHaveBeenCalledWith('a', expect.objectContaining({ intentId: 'intent' }))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('部分提交结果未知时只核对状态，不重复 commit', async () => {
    const { client, props } = dialogProps()
    vi.mocked(client.commit).mockRejectedValue(new Error('提交连接中断'))
    vi.mocked(client.status).mockResolvedValueOnce(status).mockResolvedValue({ ...status, status: 'succeeded', receipt })
    render(<ImportDialog {...props} />)
    await armedClick('一键导入')
    await screen.findByText('提交连接中断')
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    await armedClick('查询任务状态')
    await waitFor(() => expect(props.onImported).toHaveBeenCalledWith(receipt))
    expect(client.commit).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
  })

  it('空首章回执不显示查看首章', async () => {
    const { client, props } = dialogProps({ initialJobId: 'job-a', onViewChapter: vi.fn() })
    vi.mocked(client.status).mockResolvedValue({ ...status, status: 'succeeded', receipt: { ...receipt, chapterCount: 0, firstChapterId: '' } })
    render(<ImportDialog {...props} />)
    await screen.findByText('导入完成')
    expect(screen.queryByRole('button', { name: '查看首章' })).toBeNull()
  })

  it('计划/记忆-only 也停预览并展示实际原文，不自动写入', async () => {
    const { client, previewClient, props } = dialogProps()
    previewClient.summary.mockResolvedValue({ ...summary, volumes: [], plans: [{ title: '原文计划', content: '原文计划内容', source: { filename: '计划.txt' } }], memories: [{ title: '人物卡', content: '人物原文内容', memoryType: 'characterCard', source: { filename: '人物.txt' } }] })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入内容')
    expect(screen.getByRole('checkbox', { name: /创作计划/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /创作记忆/ })).toBeTruthy()
    expect(client.commit).not.toHaveBeenCalled()
    await armedClick('一键导入')
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('重新检查条件绑定原任务，不清空后新建', async () => {
    const { client, previewClient, props } = dialogProps()
    previewClient.report.mockRejectedValueOnce(new Error('报告暂不可用')).mockResolvedValue(cleanReport)
    render(<ImportDialog {...props} />)
    await screen.findByText('报告暂不可用')
    await armedClick('重新检查')
    await screen.findByText('来源完整性报告')
    expect(client.rebase).toHaveBeenCalledWith('a', 'job-a', 'intent')
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
  })

  it('旧来源报告可直接在原任务重新解析，不需伪选编码', async () => {
    const { client, previewClient, props } = dialogProps()
    previewClient.report.mockRejectedValueOnce(new Error('旧来源报告需重新解析')).mockResolvedValue(cleanReport)
    render(<ImportDialog {...props} />)
    await screen.findByText('旧来源报告需重新解析')
    await armedClick('重新解析原文件')
    await screen.findByRole('dialog', { name: '重新解析原文件？' })
    await armedClick('确认重建预览')
    await screen.findByText('来源完整性报告')
    expect(client.analyze).toHaveBeenLastCalledWith('a', 'job-a', undefined, true)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
  })

  it('关闭后迟到解析结果不发送来源决定或提交', async () => {
    const { client, previewClient, props } = dialogProps()
    let resolve!: (value: NovelImportJobStatus) => void
    vi.mocked(client.analyze).mockImplementation(() => new Promise(done => { resolve = done }))
    const view = render(<ImportDialog {...props} />)
    await waitFor(() => expect(client.analyze).toHaveBeenCalledTimes(1))
    view.unmount()
    resolve(status)
    await Promise.resolve()
    expect(previewClient.review).not.toHaveBeenCalled()
    expect(previewClient.summary).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
  })
})
