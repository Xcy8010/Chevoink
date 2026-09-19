// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportDialog, { type ImportDialogProps } from '../../src/features/studio/components/ImportDialog'
import type { NovelImportClient } from '../../src/features/studio/import-api'
import type { NovelImportJobStatus, NovelImportPreflight, NovelImportPreview, NovelImportReceipt } from '../../shared/contracts/novel-import'
import type { NovelImportPreviewSummary, NovelImportReportDto } from '../../shared/contracts/novel-import-preview'
import { canSubmitImport, IMPORT_MERGE_DELIMITER, importChapterMergeIssue, importModelSelection, mergeImportChapters, moveImportChapter, reorderImportItem, splitImportChapter } from '../../src/features/studio/lib/import-preview'
import { ImportPreviewEditor } from '../../src/features/studio/components/import-preview-editor'
import { clearImportHandoff, readImportHandoff, readImportJobId } from '../../src/features/studio/lib/import-handoff'
import { ToastProvider } from '../../src/components/ui/Toast'
import { StrictMode } from 'react'

// ImportDialog 使用 useToast（成功提示），测试统一包 ToastProvider；rerender 会沿用同一 wrapper。
const render = (ui: Parameters<typeof baseRender>[0], options?: Parameters<typeof baseRender>[1]) => baseRender(ui, { wrapper: ToastProvider, ...options })

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const expiry = '2099-01-01T00:00:00.000Z'
const hash = 'a'.repeat(64)
const check: NovelImportPreflight = { intentId: 'intent', targetHash: hash, chapterCount: 1, volumeCount: 1, nonEmptyChapterCount: 0, overwriteRequired: true, confirmationStep: 0, expiresAt: expiry }
const status: NovelImportJobStatus = { jobId: 'job-a', novelId: 'a', status: 'ready', jobVersion: 1, manifestRevision: 1, manifestHash: hash, sourceHash: hash, targetHash: hash, errorCode: null, expiresAt: expiry, receipt: null }
const preview: NovelImportPreview = { manifestRevision: 1, manifestHash: hash, sourceHash: hash, parserVersion: '1', sourceChars: 4, volumes: [{ title: '正文卷', chapters: [{ title: '原章', content: '原文正文', source: { filename: '小说.txt' } }] }], metadata: { title: '识别书名', summary: '识别简介', tags: ['标签'] }, metadataSelection: {}, warnings: [] }
const receipt: NovelImportReceipt = { jobId: 'job-a', novelId: 'a', backupId: 'backup', volumeCount: 1, chapterCount: 1, wordCount: 4, firstChapterId: 'new-chapter', targetHash: hash, restoreExpiresAt: expiry }
const selectionHash = 'b'.repeat(64)
const selectionSummary: NovelImportPreviewSummary = {
  manifestRevision: 1, manifestHash: hash, sourceHash: hash, parserVersion: '1', sourceChars: 20,
  metadata: { title: '识别书名', summary: '识别简介', tags: ['标签'] }, metadataSelection: {}, warnings: [],
  volumes: [{ title: '正文卷', chapters: [
    { title: '第一章', source: { filename: '小说.txt' }, volumeIndex: 0, chapterIndex: 0, contentHash: hash, characters: 4, nonEmpty: true },
    { title: '第二章', source: { filename: '小说.txt' }, volumeIndex: 0, chapterIndex: 1, contentHash: hash, characters: 4, nonEmpty: true },
  ] }],
  plans: [{ title: '计划一', content: '计划一内容', source: { filename: '计划.txt' } }, { title: '计划二', content: '计划二内容', source: { filename: '计划.txt' } }],
  memories: [{ title: '记忆一', content: '记忆一内容', memoryType: 'characterCard', source: { filename: '人物.txt' } }, { title: '记忆二', content: '记忆二内容', memoryType: 'worldbuilding', source: { filename: '世界.txt' } }],
}
const selectionReport: NovelImportReportDto = { manifestRevision: 1, manifestHash: hash, reportHash: hash, sourceHash: hash, partialImport: false, items: [], issues: [], decisions: [], artifacts: [] }

function selectionPreviewClient(initial: NovelImportPreviewSummary = selectionSummary, updated: NovelImportPreviewSummary = selectionSummary) {
  const nextReport = { ...selectionReport, manifestRevision: updated.manifestRevision, manifestHash: updated.manifestHash, sourceHash: updated.sourceHash }
  return {
    summary: vi.fn().mockResolvedValue(initial),
    report: vi.fn().mockResolvedValueOnce(selectionReport).mockResolvedValue(nextReport),
    selection: vi.fn().mockResolvedValue(updated),
    chapter: vi.fn(), structure: vi.fn(), review: vi.fn(),
  } as unknown as ImportDialogProps['previewClient']
}

function fixture(overrides: Partial<ImportDialogProps> = {}) {
  const client: NovelImportClient = {
    capabilities: vi.fn().mockResolvedValue({ enabled: true, overwriteEnabled: true, aiEnabled: false, sourceBytes: 10000, formats: ['zip', 'txt', 'md', 'pdf', 'doc', 'docx'].map(extension => ({ extension, enabled: extension !== 'doc', reason: extension === 'doc' ? '转换器未开放' : undefined })), limitations: ['公开章节覆盖暂未开放'] }),
    list: vi.fn().mockResolvedValue([]), preflight: vi.fn().mockResolvedValue(check),
    confirmIntent: vi.fn().mockImplementation(async (_novelId, _intent, step) => ({ ...check, confirmationStep: step })),
    confirmSelectionIntent: vi.fn().mockResolvedValue({ ...check, confirmationStep: 2 }),
    create: vi.fn().mockResolvedValue({ ...status, status: 'uploading' }),
    upload: vi.fn().mockResolvedValue({ ...status, status: 'uploaded' }),
    attachment: vi.fn().mockResolvedValue({ ...status, status: 'uploaded' }),
    analyze: vi.fn().mockResolvedValue(status), retry: vi.fn().mockResolvedValue(status), status: vi.fn().mockResolvedValue(status),
    preview: vi.fn().mockResolvedValue(preview), edit: vi.fn().mockResolvedValue({ ...preview, manifestRevision: 2 }),
    rebase: vi.fn().mockResolvedValue(status), confirm: vi.fn().mockResolvedValue({ approvalId: 'approval', expiresAt: expiry }),
    commit: vi.fn().mockResolvedValue(receipt), cancel: vi.fn().mockResolvedValue({ ...status, status: 'cancelled' }),
    restorePreview: vi.fn().mockResolvedValue({ canRestore: true, currentTargetHash: hash, backupExpiresAt: expiry, before: { volumes: 2, chapters: 3 }, current: { volumes: 1, chapters: 1 }, metadataKeys: ['title'], restoredAt: null, receipt: null }),
    restoreConfirm: vi.fn().mockResolvedValue({ restoreApprovalId: 'restore', targetHash: hash, expiresAt: expiry }),
    restore: vi.fn().mockResolvedValue({ ...receipt, restored: true, restoredAt: '2026-09-14T00:00:00Z', restoredTargetHash: hash, restoredVolumeCount: 2, restoredChapterCount: 3 }),
  }
  const props: ImportDialogProps = { open: true, novelId: 'a', novelTitle: '作品 A', modelSelection: { kind: 'custom', customModelId: 'selected-not-newest' }, beforeImport: vi.fn().mockResolvedValue(true), onClose: vi.fn(), onImported: vi.fn(), client, ...overrides }
  return { client, props }
}
async function armedClick(name: string | RegExp) {
  const target = await screen.findByRole('button', { name })
  await waitFor(() => expect((target as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(target)
}
async function uploadAndParse() {
  fireEvent.change(screen.getByLabelText('选择导入文件'), { target: { files: [new File(['原文正文'], '小说.txt', { type: 'text/plain' })] } })
  await armedClick('上传并检查文件')
  await waitFor(() => expect(screen.queryByLabelText('原文正文') ?? screen.queryByText('选择要导入的内容')).toBeTruthy())
}

describe('import confirmations and ownership', () => {
  it('reads history while import is off without saving drafts or preparing a new intent', async () => {
    const { props, client } = fixture({ initialView: 'history' })
    const caps = await client.capabilities('a')
    vi.mocked(client.capabilities).mockResolvedValue({ ...caps, enabled: false })
    vi.mocked(client.list).mockResolvedValue([{ ...status, status: 'succeeded', receipt }, { ...status, novelId: 'b', jobId: 'other' }])
    vi.mocked(client.status).mockResolvedValue({ ...status, status: 'succeeded', receipt, source: { filename: '完整原稿.zip', bytes: 2048 } })
    render(<ImportDialog {...props} />)
    await screen.findByRole('dialog', { name: '导入记录与恢复' })
    expect(screen.queryByText(/other/)).toBeNull()
    await armedClick(/任务 job-a/)
    await screen.findByText('导入完成')
    expect(screen.getByText(/原文件：完整原稿\.zip/)).toBeTruthy()
    expect(props.beforeImport).not.toHaveBeenCalled()
    expect(props.onImported).not.toHaveBeenCalled()
    expect(client.preflight).not.toHaveBeenCalled()
    expect(client.create).not.toHaveBeenCalled()
  })

  it('restores a read-only history job through the current intent on one-click import', async () => {
    const { props, client } = fixture({ initialView: 'history' })
    vi.mocked(client.list).mockResolvedValue([status])
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByRole('dialog', { name: '导入记录与恢复' })
    await armedClick(/任务 job-a/)
    await screen.findByLabelText('原文正文')
    expect(client.rebase).not.toHaveBeenCalled()
    await armedClick('一键导入')
    await waitFor(() => expect(client.rebase).toHaveBeenCalledWith('a', 'job-a', 'intent'))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('restores only after a separate impact confirmation and prevents duplicate dispatch', async () => {
    const { props, client } = fixture({ initialJobId: status.jobId, onRestored: vi.fn() })
    vi.mocked(client.capabilities).mockResolvedValue({ ...await client.capabilities('a'), enabled: false, restoreEnabled: true })
    vi.mocked(client.status).mockResolvedValue({ ...status, status: 'succeeded', receipt })
    render(<ImportDialog {...props} />)
    await armedClick('恢复导入前版本')
    await screen.findByRole('dialog', { name: '恢复导入前版本？' })
    expect(screen.getByText(/当前 1 卷 1 章 → 恢复为 2 卷 3 章/)).toBeTruthy()
    expect(client.restoreConfirm).not.toHaveBeenCalled()
    await armedClick('确认恢复')
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }), { detail: 2 })
    await screen.findByText('恢复完成')
    expect(client.restoreConfirm).toHaveBeenCalledTimes(1)
    expect(client.restoreConfirm).toHaveBeenCalledWith('a', 'job-a', hash)
    expect(client.restore).toHaveBeenCalledTimes(1)
    expect(props.onRestored).toHaveBeenCalledTimes(1)
    expect(client.preflight).not.toHaveBeenCalled()
  })

  it('keeps restoration unknown after a lost response until the durable restore receipt is read', async () => {
    const { props, client } = fixture({ initialJobId: status.jobId, onRestored: vi.fn() })
    vi.mocked(client.capabilities).mockResolvedValue({ ...await client.capabilities('a'), restoreEnabled: true })
    vi.mocked(client.status).mockResolvedValue({ ...status, status: 'succeeded', receipt })
    const restoredReceipt = await client.restore('a', 'job-a', { restoreApprovalId: 'restore', targetHash: hash })
    vi.mocked(client.restore).mockClear().mockRejectedValue(new Error('network lost'))
    render(<ImportDialog {...props} />)
    await armedClick('恢复导入前版本'); await armedClick('确认恢复')
    await screen.findByText('network lost')
    expect((screen.getByRole('button', { name: '确认恢复' }) as HTMLButtonElement).disabled).toBe(true)
    vi.mocked(client.status).mockResolvedValue({ ...status, status: 'succeeded', receipt, restore: { status: 'restored', receipt: restoredReceipt, expiresAt: expiry, restoredAt: restoredReceipt.restoredAt, errorCode: null } })
    await armedClick('查询恢复结果')
    await screen.findByText('恢复完成')
    expect(client.restore).toHaveBeenCalledTimes(1)
    expect(props.onRestored).toHaveBeenCalledTimes(1)
    expect(props.onImported).not.toHaveBeenCalled()
  })

  it('defers overwrite authorization until the final one-click submit, not parsing', async () => {
    const { props, client } = fixture()
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件')
    expect(client.confirmSelectionIntent).not.toHaveBeenCalled()
    await uploadAndParse()
    expect(client.confirmSelectionIntent).not.toHaveBeenCalled()
    await armedClick('一键导入')
    expect(client.confirmSelectionIntent).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('cancel/Escape closes the selection panel without uploading or writing', async () => {
    const { props, client } = fixture()
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    const view = render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(document.activeElement).toBe(trigger)
    expect(client.create).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
    trigger.remove()
  })

  it('rechecking obtains a new intent instead of replaying a stale selection authorization', async () => {
    const { props, client } = fixture({ initialJobId: status.jobId })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('原文正文')
    vi.mocked(client.preflight).mockResolvedValueOnce({ ...check, intentId: 'new-intent' })
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    await armedClick('重新检查')
    expect(client.preflight).toHaveBeenLastCalledWith('a', undefined)
    expect(client.confirmSelectionIntent).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('blocks entry when editor preservation fails or preflight fails', async () => {
    const { props, client } = fixture({ beforeImport: vi.fn().mockResolvedValue(false) })
    render(<ImportDialog {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain('未能保存')
    expect(client.preflight).not.toHaveBeenCalled()
    expect(client.create).not.toHaveBeenCalled()
  })

  it('hides file selection when server gate is off, without creating an intent', async () => {
    const { props, client } = fixture()
    vi.mocked(client.capabilities).mockResolvedValue({ enabled: false, overwriteEnabled: false, overwriteVerified: false, restoreEnabled: false, retainsEmptyVolumes: true, sourceBytes: 10, aiEnabled: false, formats: [], limitations: [] })
    render(<ImportDialog {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain('尚未开放')
    expect(client.preflight).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('选择导入文件')).toBeNull()
  })

  it('ignores stale preflight after A → B, including its subsequent mutation chain', async () => {
    const { props, client } = fixture()
    let resolveA!: (value: NovelImportPreflight) => void
    vi.mocked(client.preflight).mockImplementation(novel => novel === 'a' ? new Promise(resolve => { resolveA = resolve }) : Promise.resolve({ ...check, chapterCount: 0, overwriteRequired: false }))
    const view = render(<ImportDialog {...props} />)
    await waitFor(() => expect(client.preflight).toHaveBeenCalledWith('a', undefined))
    view.rerender(<ImportDialog {...props} novelId="b" novelTitle="作品 B" />)
    await screen.findByLabelText('选择导入文件')
    await act(async () => { resolveA(check) })
    expect(screen.getByRole('dialog').textContent).toContain('作品 B')
    expect(screen.queryByRole('button', { name: '是，继续' })).toBeNull()
    expect(client.confirmIntent).not.toHaveBeenCalled()
  })

  it('requires a file and nonempty original body; optional metadata stays unchanged', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(client.preview).mockResolvedValue({ ...preview, volumes: [{ title: '正文卷', chapters: [{ ...preview.volumes[0].chapters[0], content: ' \n ' }] }] })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件')
    expect((screen.getByRole('button', { name: '上传并检查文件' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('选择导入文件'), { target: { files: [new File([], '空.txt')] } })
    expect(screen.getByRole('alert').textContent).toContain('文件为空')
    expect(client.create).not.toHaveBeenCalled()
    await uploadAndParse()
    expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(true)
    for (const checkbox of screen.getAllByRole('checkbox')) expect((checkbox as HTMLInputElement).checked).toBe(false)
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('passes exact selected custom model and raw File, and commits at most once', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件')
    await uploadAndParse()
    expect(client.create).toHaveBeenCalledWith('a', 'intent', { kind: 'custom', customModelId: 'selected-not-newest' })
    expect(client.upload).toHaveBeenCalledWith('a', 'job-a', expect.any(File))
    await waitFor(() => expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(false))
    const submit = screen.getByRole('button', { name: '一键导入' })
    fireEvent.click(submit); fireEvent.click(submit)
    await screen.findByText('导入完成')
    expect(client.confirm).toHaveBeenCalledTimes(1)
    expect(client.commit).toHaveBeenCalledTimes(1)
    expect(client.commit).toHaveBeenCalledWith('a', 'job-a', 'approval', 'novel-import:job-a')
    expect(props.onImported).toHaveBeenCalledWith(receipt)
  })

  it('keeps only explicitly selected chapter/plan/memory indices and confirms the returned revision', async () => {
    const updated = { ...selectionSummary, manifestRevision: 2, manifestHash: selectionHash, metadataSelection: { title: '识别书名' } }
    const { props, client } = fixture({ previewClient: selectionPreviewClient(selectionSummary, updated) })
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    const footer = screen.getByRole('dialog').querySelector('footer')!
    expect([...footer.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['取消', '一键导入'])
    fireEvent.click(screen.getByRole('checkbox', { name: /章节正文/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /创作计划/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /创作记忆/ }))
    fireEvent.click(screen.getByText('选择具体章节'))
    fireEvent.click(screen.getByRole('checkbox', { name: '第二章' }))
    fireEvent.click(screen.getByText('选择具体计划'))
    fireEvent.click(screen.getByRole('checkbox', { name: '计划二' }))
    fireEvent.click(screen.getByText('选择具体记忆'))
    fireEvent.click(screen.getByRole('checkbox', { name: '记忆一' }))
    await armedClick('一键导入')
    const previewClient = props.previewClient!
    expect(previewClient.selection).toHaveBeenCalledWith('a', 'job-a', {
      expectedManifestRevision: 1, manifestHash: hash,
      chapters: [{ volumeIndex: 0, chapterIndex: 1 }], plans: [1], memories: [0], metadataSelection: {},
    })
    await waitFor(() => expect(client.confirm).toHaveBeenCalledWith('a', expect.objectContaining({ manifestRevision: 1 }), expect.objectContaining({ manifestRevision: 2, manifestHash: selectionHash })))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('enables metadata-only selection while keeping an empty selection disabled', async () => {
    const metadataOnly = { ...selectionSummary, volumes: [], plans: undefined, memories: undefined }
    const updated = { ...metadataOnly, manifestRevision: 2, manifestHash: selectionHash, metadataSelection: { title: '识别书名' } }
    const { props } = fixture({ previewClient: selectionPreviewClient(metadataOnly, updated) })
    vi.mocked(props.client!.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    const submit = screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /作品信息/ }))
    await waitFor(() => expect(submit.disabled).toBe(false))
  })

  it('does not confirm or commit when saving an explicit selection fails', async () => {
    const { props, client } = fixture({ previewClient: selectionPreviewClient() })
    vi.mocked(props.previewClient!.selection).mockRejectedValue(new Error('selection rejected'))
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse(); await armedClick('一键导入')
    await screen.findByText('selection rejected')
    expect(client.confirm).not.toHaveBeenCalled()
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('keeps a partial selection after an unknown selection response when the server revision is unchanged', async () => {
    const updated = { ...selectionSummary, manifestRevision: 2, manifestHash: selectionHash }
    const { props, client } = fixture({ previewClient: selectionPreviewClient() })
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(props.previewClient!.selection).mockRejectedValueOnce(new Error('selection timeout')).mockResolvedValue(updated)
    vi.mocked(client.status).mockResolvedValueOnce(status).mockResolvedValue({ ...status, manifestRevision: 1, manifestHash: hash })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    fireEvent.click(screen.getByRole('checkbox', { name: /章节正文/ }))
    fireEvent.click(screen.getByText('选择具体章节'))
    fireEvent.click(screen.getByRole('checkbox', { name: '第二章' }))
    await armedClick('一键导入')
    await screen.findByText('selection timeout')
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    await armedClick('查询任务状态')
    await waitFor(() => expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(false))
    const previewClient = props.previewClient!
    vi.mocked(previewClient.report).mockResolvedValue({ ...selectionReport, manifestRevision: 2, manifestHash: selectionHash })
    await armedClick('一键导入')
    expect(previewClient.selection).toHaveBeenNthCalledWith(2, 'a', 'job-a', expect.objectContaining({ chapters: [{ volumeIndex: 0, chapterIndex: 1 }] }))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
  })

  it('rechecks a dirty selection against a changed target and keeps the explicit indices', async () => {
    const { props, client } = fixture({ initialJobId: status.jobId, previewClient: selectionPreviewClient() })
    vi.mocked(client.preflight).mockResolvedValue({ ...check, intentId: 'new-intent', targetHash: 'c'.repeat(64), chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByRole('group', { name: '选择导入内容' })
    fireEvent.click(screen.getByRole('checkbox', { name: /章节正文/ }))
    fireEvent.click(screen.getByText('选择具体章节'))
    fireEvent.click(screen.getByRole('checkbox', { name: '第二章' }))
    await armedClick('重新检查')
    await waitFor(() => expect(client.rebase).toHaveBeenLastCalledWith('a', 'job-a', 'new-intent'))
    expect((screen.getByRole('checkbox', { name: '第二章' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: '第一章' }) as HTMLInputElement).checked).toBe(false)
  })

  it('clears a partial selection when an unknown response is followed by a new server revision', async () => {
    const updated = { ...selectionSummary, manifestRevision: 2, manifestHash: selectionHash }
    const { props, client } = fixture({ previewClient: selectionPreviewClient(selectionSummary, updated) })
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(props.previewClient!.selection).mockRejectedValue(new Error('selection timeout'))
    vi.mocked(props.previewClient!.summary).mockReset().mockResolvedValueOnce(selectionSummary).mockResolvedValue(updated)
    vi.mocked(client.status).mockResolvedValueOnce(status).mockResolvedValue({ ...status, manifestRevision: 2, manifestHash: selectionHash })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    fireEvent.click(screen.getByRole('checkbox', { name: /章节正文/ }))
    fireEvent.click(screen.getByText('选择具体章节'))
    fireEvent.click(screen.getByRole('checkbox', { name: '第二章' }))
    await armedClick('一键导入')
    await screen.findByText('selection timeout')
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    await armedClick('查询任务状态')
    await screen.findByText(/版本发生变化/)
    expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(true)
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('never commits a late grant after switching novels', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    let grant!: (value: { approvalId: string; expiresAt: string }) => void
    vi.mocked(client.confirm).mockImplementation(() => new Promise(resolve => { grant = resolve }))
    const view = render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse(); await armedClick('一键导入')
    await waitFor(() => expect(client.confirm).toHaveBeenCalledTimes(1))
    view.rerender(<ImportDialog {...props} novelId="b" novelTitle="作品 B" />)
    await act(async () => { grant({ approvalId: 'stale', expiresAt: expiry }) })
    expect(client.commit).not.toHaveBeenCalled()
    expect(props.onImported).not.toHaveBeenCalled()
  })

  it('agent attachment hints still require explicit source selection', async () => {
    const attachment = { url: '/api/uploads/agent-attachments/user/book.txt', runId: 'run' }
    const { props, client } = fixture({ agentAttachment: attachment })
    render(<ImportDialog {...props} />)
    await screen.findByText(/Agent 交接的待导入附件/)
    expect(client.attachment).not.toHaveBeenCalled()
    await armedClick('上传并检查文件')
    await waitFor(() => expect(client.attachment).toHaveBeenCalledWith('a', 'job-a', attachment))
    expect(client.analyze).toHaveBeenCalledTimes(1)
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('StrictMode does not issue two preflights or create jobs on initial render', async () => {
    const { props, client } = fixture()
    render(<StrictMode><ImportDialog {...props} /></StrictMode>)
    await screen.findByLabelText('选择导入文件')
    expect(client.preflight).toHaveBeenCalledTimes(1)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('traps focus and ignores IME Enter/Escape without confirming', async () => {
    const { props, client } = fixture()
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件')
    const confirm = screen.getByRole('button', { name: '取消' })
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(confirm)
    fireEvent.compositionStart(confirm)
    fireEvent.keyDown(confirm, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyDown(confirm, { key: 'Escape', isComposing: true })
    expect(client.confirmSelectionIntent).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.compositionEnd(confirm)
  })

  it('preserves picker selection when native picker cancels, and discloses unavailable DOC', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    const picker = await screen.findByLabelText('选择导入文件')
    fireEvent.change(picker, { target: { files: [new File(['正文'], '旧书.txt')] } })
    fireEvent.change(picker, { target: { files: [] } })
    expect(screen.getByText(/旧书.txt/)).toBeTruthy()
    fireEvent.change(picker, { target: { files: [new File(['DOC'], '旧书.doc')] } })
    expect(screen.getByRole('alert').textContent).toContain('服务器尚未开放 .doc 格式导入')
    expect(client.create).not.toHaveBeenCalled()
  })

  it('persists legacy preview edits with the current revision before one-click import', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    fireEvent.change(screen.getByLabelText('章名'), { target: { value: '新章名' } })
    await armedClick('一键导入')
    await waitFor(() => expect(client.edit).toHaveBeenCalledWith('a', 'job-a', expect.objectContaining({ expectedManifestRevision: 1, metadataSelection: {}, volumes: [{ title: '正文卷', chapters: [{ ...preview.volumes[0].chapters[0], title: '新章名' }] }] })))
    await waitFor(() => expect(client.confirm).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
    expect(props.onImported).toHaveBeenCalledWith(receipt)
  })

  it('routes native hardware-back cancellation directly to close', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    fireEvent.change(screen.getByLabelText('章名'), { target: { value: '尚未保存' } })
    const dialog = document.querySelector('dialog[open][data-native-back-dismiss]')!
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('cancels only after an explicit task-cancel confirmation', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }))
    expect(client.cancel).not.toHaveBeenCalled()
    await armedClick('确认取消任务')
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith('a', 'job-a'))
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('queries unknown commit result before permitting further submissions', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(client.commit).mockRejectedValue(new Error('network lost'))
    vi.mocked(client.status).mockResolvedValue({ ...status, status: 'succeeded', receipt })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse(); await armedClick('一键导入')
    await screen.findByText('network lost')
    expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    fireEvent.click(screen.getByRole('button', { name: '查询任务状态' }))
    await screen.findByText('导入完成')
    expect(client.commit).toHaveBeenCalledTimes(1)
    expect(props.onImported).toHaveBeenCalledTimes(1)
  })

  it('loads persisted current-novel jobs and rebases through current intent', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(client.list).mockResolvedValue([status, { ...status, jobId: 'private-other', novelId: 'b' }])
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件')
    expect(screen.queryByText(/private-other/)).toBeNull()
    await armedClick(/任务 job-a/)
    await screen.findByLabelText('原文正文')
    expect(client.rebase).not.toHaveBeenCalled()
    await armedClick('一键导入')
    await waitFor(() => expect(client.rebase).toHaveBeenCalledWith('a', 'job-a', 'intent'))
    expect(client.create).not.toHaveBeenCalled()
  })

  it('status handoff reads a scoped existing job without issuing a new intent', async () => {
    const { props, client } = fixture({ initialJobId: status.jobId })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('原文正文')
    expect(client.status).toHaveBeenCalledWith('a', status.jobId)
    expect(client.preflight).not.toHaveBeenCalled()
    expect(client.create).not.toHaveBeenCalled()
    await waitFor(() => expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByLabelText('章名') as HTMLInputElement).matches(':disabled')).toBe(true)
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => expect(client.preflight).toHaveBeenCalledTimes(1))
    expect(client.preflight).toHaveBeenCalledTimes(1)
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('status view rejects cross-novel results without loading their preview', async () => {
    const { props, client } = fixture({ initialJobId: status.jobId })
    vi.mocked(client.status).mockResolvedValue({ ...status, novelId: 'b' })
    render(<ImportDialog {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain('不属于当前作品')
    expect(client.preview).not.toHaveBeenCalled()
    expect(props.onImported).not.toHaveBeenCalled()
  })

  it('splits oversized preview at the textarea cursor, saves partial progress and preserves the final tail', async () => {
    const content = `${'字'.repeat(100050)}末尾\n\n`
    const oversized: NovelImportPreview = { ...preview, sourceChars: content.length, volumes: [{ title: '正文卷', chapters: [{ ...preview.volumes[0].chapters[0], content }] }], warnings: [{ code: 'IMPORT_CHAPTER_TOO_LARGE', message: '请拆分超长章', blocking: true }] }
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(client.preview).mockResolvedValue(oversized)
    vi.mocked(client.edit).mockImplementation(async (_novel, _job, edit) => ({ ...oversized, volumes: edit.volumes, metadataSelection: edit.metadataSelection ?? {}, manifestRevision: edit.expectedManifestRevision + 1, warnings: edit.volumes.some(v => v.chapters.some(c => c.content.length > 100000)) ? oversized.warnings : [] }))
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    const split = async () => {
      fireEvent.change(screen.getByLabelText('跳转字符位置'), { target: { value: '50000' } })
      fireEvent.click(screen.getByRole('button', { name: '定位拆分光标' }))
      await armedClick('在光标处拆分为两章')
      await armedClick('一键导入')
      await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
    }
    await split()
    const finalEdit = vi.mocked(client.edit).mock.calls[0][2]
    expect(finalEdit.volumes[0].chapters.map(c => c.content).join('')).toBe(content)
    expect(finalEdit.volumes[0].chapters[1].content).toBe(`${'字'.repeat(50050)}末尾\n\n`)
    expect(finalEdit.volumes[0].chapters.every(c => c.source.filename === '小说.txt')).toBe(true)
    expect(client.analyze).toHaveBeenCalledTimes(1)
    expect(client.commit).toHaveBeenCalledTimes(1)
  })

  it('merges adjacent same-source bodies exactly and saves against the current revision before permitting import', async () => {
    const first = { ...preview.volumes[0].chapters[0], content: ' 开头🙂\n\n' }
    const second = { ...first, title: '第二章标题', content: '\n 后文\t末尾\n\n' }
    const mergedPreview = { ...preview, volumes: [{ title: '正文卷', chapters: [first, second] }] }
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(client.preview).mockResolvedValue(mergedPreview)
    vi.mocked(client.edit).mockImplementation(async (_novel, _job, edit) => ({ ...mergedPreview, volumes: edit.volumes, metadataSelection: edit.metadataSelection ?? {}, manifestRevision: edit.expectedManifestRevision + 1 }))
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    await waitFor(() => expect((screen.getByRole('button', { name: '一键导入' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByText(/合并分隔符：空字符串/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '与下一章合并（同来源）' }))
    expect((screen.getByLabelText('原文正文') as HTMLTextAreaElement).value).toBe(first.content + second.content)
    expect((screen.getByLabelText('章名') as HTMLInputElement).value).toBe(first.title)
    expect(client.edit).not.toHaveBeenCalled()
    await armedClick('一键导入')
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
    expect(client.edit).toHaveBeenCalledWith('a', 'job-a', expect.objectContaining({ expectedManifestRevision: 1, metadataSelection: {}, volumes: [{ title: '正文卷', chapters: [{ ...first, content: first.content + second.content }] }] }))
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1))
    expect(client.analyze).toHaveBeenCalledTimes(1)
    expect(client.confirm).toHaveBeenCalledTimes(1)
    expect(client.commit).toHaveBeenCalledTimes(1)
  })

  it.each(['cross-source', 'over-limit'] as const)('disables %s merging with an actionable explanation and no mutation', reason => {
    const first = preview.volumes[0].chapters[0]
    const second = { ...first, content: reason === 'over-limit' ? '字'.repeat(100000) : '另一章正文', source: { filename: reason === 'cross-source' ? '另一文件.txt' : first.source.filename } }
    const onChange = vi.fn()
    render(<ImportPreviewEditor preview={{ ...preview, volumes: [{ title: '正文卷', chapters: [first, second] }] }} onChange={onChange} disabled={false} currentMetadata={{ title: '作品' }} />)
    const merge = screen.getByRole('button', { name: '与下一章合并（同来源）' }) as HTMLButtonElement
    expect(merge.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain(reason === 'cross-source' ? '跨来源合并尚未开放' : '请保留分章，或先用光标拆分')
    fireEvent.click(merge)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('only sends explicit encoding after user selection, and retries failed encoding without creating a new job', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    vi.mocked(client.analyze).mockResolvedValue({ ...status, status: 'failed', errorCode: 'IMPORT_ENCODING_AMBIGUOUS' })
    render(<ImportDialog {...props} />)
    const picker = await screen.findByLabelText('选择导入文件')
    fireEvent.change(picker, { target: { files: [new File(['原文'], '小说.txt')] } })
    await armedClick('上传并检查文件')
    await screen.findByRole('button', { name: '重试确定性解析' })
    expect(screen.queryByRole('combobox', { name: '文本编码' })).toBeNull()
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    fireEvent.click(screen.getByRole('checkbox', { name: /手动指定文本编码/ }))
    fireEvent.change(screen.getByRole('combobox', { name: '文本编码' }), { target: { value: 'gb18030' } })
    expect(client.analyze).toHaveBeenCalledWith('a', 'job-a')
    expect(screen.getAllByRole('alert').some(item => item.textContent?.includes('文本编码需要确认'))).toBe(true)
    expect(screen.getByText('错误码：IMPORT_ENCODING_AMBIGUOUS')).toBeTruthy()
    await armedClick('重试确定性解析')
    await screen.findByLabelText('原文正文')
    expect(client.retry).toHaveBeenCalledWith('a', 'job-a', 'gb18030')
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(client.commit).not.toHaveBeenCalled()
  })

  it('requires a separate confirmation before explicit encoding rebuilds a ready preview', async () => {
    const { props, client } = fixture()
    vi.mocked(client.preflight).mockResolvedValue({ ...check, chapterCount: 0, overwriteRequired: false })
    render(<ImportDialog {...props} />)
    await screen.findByLabelText('选择导入文件'); await uploadAndParse()
    fireEvent.click(screen.getByText('遇到问题？查看详情'))
    fireEvent.click(screen.getByRole('checkbox', { name: /手动指定文本编码/ }))
    fireEvent.change(screen.getByRole('combobox', { name: '文本编码' }), { target: { value: 'utf-16be' } })
    fireEvent.click(screen.getByRole('button', { name: '按所选编码重新解析' }))
    expect(client.analyze).toHaveBeenCalledTimes(1)
    await screen.findByRole('dialog', { name: '按所选编码重建预览？' })
    await armedClick('确认重建预览')
    await waitFor(() => expect(client.analyze).toHaveBeenCalledTimes(2))
    expect(client.analyze).toHaveBeenLastCalledWith('a', 'job-a', 'utf-16be', true)
    expect(client.commit).not.toHaveBeenCalled()
  })
})

describe('preview and handoff invariants', () => {
  it('model routing never chooses an unrelated enabled custom model', () => {
    expect(importModelSelection('ultimate', 'unused')).toEqual({ kind: 'basic' })
    expect(importModelSelection('custom', 'selected')).toEqual({ kind: 'custom', customModelId: 'selected' })
    expect(() => importModelSelection('custom', null)).toThrow()
  })
  it('reordering/moving chapters preserves source and original body', () => {
    const next = moveImportChapter([...preview.volumes, { title: '第二卷', chapters: [] }], 0, 0, 1)
    expect(next[1].chapters[0]).toEqual(preview.volumes[0].chapters[0])
    expect(next[0].chapters).toHaveLength(0)
    expect(reorderImportItem(['a', 'b'], 0, 1)).toEqual(['b', 'a'])
    expect(canSubmitImport({ ...preview, warnings: [{ code: 'missing', message: 'missing body', blocking: true }] })).toBe(false)
    expect(canSubmitImport(null)).toBe(false)
  })

  it('bounds split titles and rejects edge offsets and surrogate-pair boundaries without altering text', () => {
    const volumes = [{ title: '卷', chapters: [{ title: '题'.repeat(128), content: '前🙂后\n', source: { memberPath: '卷/原章.txt' } }] }]
    const split = splitImportChapter(volumes, 0, 0, 3)
    expect(split[0].chapters.map(c => c.content).join('')).toBe('前🙂后\n')
    expect(split[0].chapters[1].title.length).toBeLessThanOrEqual(128)
    expect(split[0].chapters[1].source).toEqual(volumes[0].chapters[0].source)
    for (const offset of [0, 2, 5, -1, 1.5]) expect(splitImportChapter(volumes, 0, 0, offset)).toBe(volumes)
  })
  it('merges only the adjacent pair without normalizing whitespace or changing provenance, title or other chapters', () => {
    const source = { filename: '原书.zip', memberPath: '卷/正文.txt', page: 1, start: 0, end: 20 }
    const first = { title: '题'.repeat(128), content: ' \r\n前🙂\t', source }
    const second = { title: '不插入正文的标题', content: '\n\r\n 后\u0000尾\n\n', source: { end: 20, start: 0, page: 1, memberPath: '卷/正文.txt', filename: '原书.zip' } }
    const neighbor = { title: '邻章', content: '不变', source }
    const volumes = [{ title: '卷', chapters: [neighbor, first, second, neighbor] }, { title: '另一卷', chapters: [neighbor] }]
    const snapshot = structuredClone(volumes)
    const result = mergeImportChapters(volumes, 0, 1)
    expect(IMPORT_MERGE_DELIMITER).toBe('')
    expect(result.error).toBeNull()
    expect(result.volumes[0].chapters).toEqual([neighbor, { ...first, content: first.content + second.content }, neighbor])
    expect(result.volumes[0].chapters[1].source).toBe(source)
    expect(result.volumes[1]).toBe(volumes[1])
    expect(volumes).toEqual(snapshot)
  })

  it.each(['filename', 'memberPath', 'page', 'start', 'end'] as const)('blocks differing source %s rather than forging merged provenance', key => {
    const source = { filename: '原书.zip', memberPath: '卷/正文.txt', page: 1, start: 0, end: 20 }
    const other = { ...source, [key]: typeof source[key] === 'number' ? 99 : '另一来源' }
    const volumes = [{ title: '卷', chapters: [{ title: '一', content: '前', source }, { title: '二', content: '后', source: other }] }]
    const result = mergeImportChapters(volumes, 0, 0)
    expect(result.volumes).toBe(volumes)
    expect(result.error).toContain('跨来源合并尚未开放')
  })

  it('blocks missing provenance and cannot merge across volume boundaries or invalid selections', () => {
    const chapter = { title: '章', content: '正文', source: {} }
    const volumes = [{ title: '一卷', chapters: [chapter, chapter] }, { title: '二卷', chapters: [chapter] }]
    expect(importChapterMergeIssue(volumes, 0, 0)).toContain('来源信息不同或不完整')
    for (const [volume, index] of [[0, 1], [1, 0], [-1, 0], [0, -1], [0, 0.5], [9, 0]]) {
      const result = mergeImportChapters(volumes, volume, index)
      expect(result.volumes).toBe(volumes)
      expect(result.error).toContain('仅支持同卷相邻章节')
    }
  })

  it('allows exactly 100k characters but rejects 100001 without dropping the final tail', () => {
    const source = { filename: '小说.txt' }
    const volumes = [{ title: '卷', chapters: [{ title: '一', content: '字'.repeat(99995), source }, { title: '二', content: '🙂尾\n\n', source }] }]
    const allowed = mergeImportChapters(volumes, 0, 0)
    expect(allowed.error).toBeNull()
    expect(allowed.volumes[0].chapters[0].content).toBe(volumes[0].chapters.map(c => c.content).join(''))
    expect(allowed.volumes[0].chapters[0].content.length).toBe(100000)
    const oversized = [{ ...volumes[0], chapters: [volumes[0].chapters[0], { ...volumes[0].chapters[1], content: '🙂尾\n\n末' }] }]
    const blocked = mergeImportChapters(oversized, 0, 0)
    expect(blocked.volumes).toBe(oversized)
    expect(blocked.error).toContain('100001')
    expect(blocked.error).toContain('不会截断正文')
    expect(blocked.error).toContain('先用光标拆分')
  })

  it('accepts managed hints only and does not drop unrelated query state', () => {
    const params = new URLSearchParams({ session: 'session', importRunId: 'run', importAttachmentUrl: '/api/uploads/agent-attachments/u/book.txt' })
    expect(readImportHandoff(params)?.runId).toBe('run')
    expect(clearImportHandoff(params).toString()).toBe('session=session')
    for (const bad of ['C:\\private\\book.txt', 'https://example.com/book.txt', '//evil.test/file', '/api/uploads/agent-attachments/../file']) {
      params.set('importAttachmentUrl', bad)
      expect(readImportHandoff(params)).toBeNull()
    }
    params.set('importJobId', '11111111-2222-4333-8444-555555555555')
    expect(readImportJobId(params)).toBe('11111111-2222-4333-8444-555555555555')
    expect(clearImportHandoff(params).toString()).toBe('session=session')
    params.set('importJobId', '../another-novel')
    expect(readImportJobId(params)).toBeNull()
  })
})
