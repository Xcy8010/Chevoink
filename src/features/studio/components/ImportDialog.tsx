import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, Upload } from 'lucide-react'
import { useToast } from '@/components/ui/toast-context'
import type { NovelImportCapabilities, NovelImportJobStatus, NovelImportModelSelection, NovelImportPreflight, NovelImportPreview, NovelImportReceipt, NovelImportStatus } from '../../../../shared/contracts/novel-import.js'
import { novelImportApi, type NovelImportClient } from '../import-api'
import { canSaveImportPreview, canSubmitImport, importPreviewCounts } from '../lib/import-preview'
import { ImportDialogShell } from './import-dialog-shell'
import { ImportPreviewEditor } from './import-preview-editor'
import { importErrorMessage, importStatusLabel } from '../lib/import-labels'
import { fetchImportOriginal, importSourceUrl } from '../lib/import-source-download'
import { triggerBlobDownload } from '../lib/export-download'
import type { ImportAgentAttachment } from '../lib/import-handoff'
import type { NovelImportPreviewSummary, NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import { importPreviewApi, type ImportReviewEdit, type ImportStructureEdit } from '../import-preview-api'
import { importStructureFromSummary } from '../lib/import-structure'
import { ImportStructuredEditor } from './import-structured-editor'
import { ImportIntegrityReport } from './import-integrity-report'

export type ImportDialogProps = {
  open: boolean
  novelId: string
  novelTitle: string
  currentMetadata?: { title: string; summary?: string; tags?: string[] }
  /** The composer CURRENT selection, never the newest enabled custom model. */
  modelSelection: NovelImportModelSelection
  /** Untrusted handoff hint; server must revalidate owner, run and source before copying. */
  agentAttachment?: ImportAgentAttachment
  /** 一键入口选择的文件：自动跑完上传/解析/提交，不再要求人工预览步骤。 */
  autoFile?: File | null
  /** Status handoff: view only until a fresh human confirmation flow is requested. */
  initialJobId?: string
  initialView?: 'history'
  /** Flush local editor text and await persistence; false blocks import and preserves draft. */
  beforeImport: () => Promise<boolean>
  onClose: () => void
  /** Refresh studio tree/metadata/chapter caches in this novel; navigate using firstChapterId. */
  onImported: (receipt: NovelImportReceipt) => void | Promise<void>
  onRestored?: (receipt: NovelImportReceipt) => void | Promise<void>
  onViewChapter?: (chapterId: string) => void
  client?: NovelImportClient
  previewClient?: typeof importPreviewApi
}

const button = 'rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40'
const primary = `${button} bg-[var(--surface-contrast)] text-[var(--text-contrast)]`
type Stage = 'loading' | 'history' | 'first' | 'second' | 'workspace' | 'auto' | 'leave' | 'cancel' | 'restore' | 'reparse'
const previewStatuses = new Set(['ready', 'needs_review', 'awaiting_confirmation'])
const terminalStatuses = new Set(['succeeded', 'cancelled', 'expired', 'failed'])
const formats = ['zip', 'txt', 'md', 'pdf', 'doc', 'docx']
/** 一键导入起跑前需要顶替的本作品未完结任务状态。 */
const liveStatuses = new Set<NovelImportStatus>(['uploading', 'uploaded', 'parsing', 'needs_review', 'ready', 'awaiting_confirmation'])

function canSubmitSummary(summary: NovelImportPreviewSummary, report: NovelImportReportDto | null) {
  const routedExtra = Boolean(summary.plans?.length || summary.memories?.length)
  return !!report && report.manifestRevision === summary.manifestRevision && report.manifestHash === summary.manifestHash && report.sourceHash === summary.sourceHash
    && !report.issues.some(issue => issue.blocking && !issue.resolved) && !summary.warnings.some(warning => warning.blocking)
    && (routedExtra || summary.volumes.some(volume => volume.chapters.some(chapter => chapter.nonEmpty)))
    && summary.volumes.every(volume => volume.title.trim() && volume.chapters.every(chapter => chapter.title.trim() && chapter.characters <= 100000))
}

/** 自动管线遇到必须人工处理的解析结果时回落到手动核对，不算失败。 */
class AutoImportFallback extends Error {}
const wait = (ms: number) => new Promise(resolve => { window.setTimeout(resolve, ms) })
function validateImportFile(next: File, caps: NovelImportCapabilities | null) {
  const extension = next.name.split('.').pop()?.toLowerCase()
  const capability = caps?.formats.find(item => item.extension.replace(/^\./, '').toLowerCase() === extension)
  if (!extension || !formats.includes(extension) || !capability?.enabled) return `服务器尚未开放 .${extension ?? ''} 格式导入。`
  if (!next.size) return '文件为空，请选择含有原文正文的文件。'
  if (!caps || next.size > caps.sourceBytes) return '文件超过服务器上传上限，请拆分后再试。'
  return ''
}

export default function ImportDialog(props: ImportDialogProps) {
  // Identity fencing also covers A → B → A and close/reopen during an old request.
  return props.open ? <ImportDialogSession key={`${props.novelId}:${props.initialJobId ?? props.initialView ?? ''}`} {...props} /> : null
}

function ImportDialogSession(props: ImportDialogProps) {
  const { novelId, novelTitle, client = novelImportApi } = props
  const previewClient = props.previewClient ?? (client === novelImportApi ? importPreviewApi : undefined)
  const [stage, setStage] = useState<Stage>('loading')
  const [capabilities, setCapabilities] = useState<NovelImportCapabilities | null>(null)
  const [intent, setIntent] = useState<NovelImportPreflight | null>(null)
  const [jobs, setJobs] = useState<NovelImportJobStatus[]>([])
  const [job, setJob] = useState<NovelImportJobStatus | null>(null)
  const [preview, setPreview] = useState<NovelImportPreview | null>(null)
  const [summary, setSummary] = useState<NovelImportPreviewSummary | null>(null)
  const [structure, setStructure] = useState<ImportStructureEdit | null>(null)
  const [report, setReport] = useState<NovelImportReportDto | null>(null)
  const [dirty, setDirty] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [manualEncoding, setManualEncoding] = useState(false)
  const [encoding, setEncoding] = useState('utf-8')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [armed, setArmed] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [restored, setRestored] = useState(false)
  const [restoreUncertain, setRestoreUncertain] = useState(false)
  const restorePending = useRef(false)
  const [autoStep, setAutoStep] = useState('')
  const [autoNonce, setAutoNonce] = useState(0)
  const [autoProgress, setAutoProgress] = useState(0)
  const autoTarget = useRef(0)
  const toast = useToast()
  const [restoreApproval, setRestoreApproval] = useState<Awaited<ReturnType<NovelImportClient['restorePreview']>> | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const latest = useRef(props)
  latest.current = props
  const epoch = useRef(0)
  const lock = useRef(false)
  const delivered = useRef<string | null>(null)
  const adoptSummary = (next: NovelImportPreviewSummary) => {
    setSummary(next); setStructure({ expectedManifestRevision: next.manifestRevision, manifestHash: next.manifestHash, volumes: importStructureFromSummary(next), metadataSelection: next.metadataSelection }); setDirty(false)
  }

  useEffect(() => {
    setArmed(false)
    const timer = window.setTimeout(() => setArmed(true), 450)
    return () => window.clearTimeout(timer)
  }, [stage])
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])

  const run = useCallback(async (label: string, action: (alive: () => boolean) => Promise<void>) => {
    if (lock.current) return
    const owner = epoch.current
    const alive = () => owner === epoch.current && latest.current.novelId === novelId
    lock.current = true
    setBusy(label); setError('')
    try { await action(alive) }
    catch (failure) { if (alive()) setError(failure instanceof Error ? failure.message : '导入请求失败，请稍后重试。') }
    finally { if (alive()) { lock.current = false; setBusy('') } }
  }, [novelId])

  const acceptStatus = useCallback(async (next: NovelImportJobStatus, alive: () => boolean, notify = true) => {
    if (!alive()) return
    if (next.novelId !== novelId) throw new Error('导入任务不属于当前作品，已停止。')
    setJob(next)
    if (!previewStatuses.has(next.status) && next.status !== 'succeeded') { setPreview(null); setSummary(null); setStructure(null); setReport(null) }
    if (next.restore?.status === 'restored' && next.restore.receipt) {
      if (next.restore.receipt.novelId !== novelId || next.restore.receipt.jobId !== next.jobId) throw new Error('恢复回执与当前任务不匹配。')
      setRestored(true); setRestoreUncertain(false); restorePending.current = false; setStage('workspace')
      if (previewClient) { const evidence = await previewClient.report(novelId, next.jobId); if (!alive()) return; setReport(evidence) }
      if (notify) await latest.current.onRestored?.(next.restore.receipt)
      return
    }
    if (previewStatuses.has(next.status)) {
      if (previewClient) {
        const [manifest, evidence] = await Promise.all([previewClient.summary(novelId, next.jobId), previewClient.report(novelId, next.jobId)])
        if (!alive()) return
        if (manifest.manifestRevision !== evidence.manifestRevision || manifest.manifestHash !== evidence.manifestHash) throw new Error('目录与完整性报告版本不一致，请重新查询任务。')
        adoptSummary(manifest); setReport(evidence); setPreview(null)
      } else {
        const manifest = await client.preview(novelId, next.jobId)
        if (!alive()) return
        setPreview(manifest); setDirty(false)
      }
    }
    if (next.status === 'succeeded' && previewClient) { const evidence = await previewClient.report(novelId, next.jobId); if (!alive()) return; setReport(evidence) }
    if (notify && !restorePending.current && next.status === 'succeeded' && next.receipt && delivered.current !== next.jobId) {
      if (next.receipt.novelId !== novelId) throw new Error('导入回执与当前作品不匹配。')
      await latest.current.onImported(next.receipt)
      if (alive()) delivered.current = next.jobId
    }
  }, [client, novelId, previewClient])

  const initialize = useCallback(() => run('正在保存当前草稿并检查导入条件', async alive => {
    const capability = await client.capabilities(novelId)
    if (!alive()) return
    setCapabilities(capability)
    if (latest.current.initialJobId) {
      const existing = await client.status(novelId, latest.current.initialJobId)
      if (!alive()) return
      setStage('workspace')
      await acceptStatus(existing, alive, false)
      return
    }
    const history = await client.list(novelId)
    if (!alive()) return
    setJobs(history.filter(item => item.novelId === novelId))
    if (latest.current.initialView === 'history') { setStage('history'); return }
    if (!capability.enabled) throw new Error('服务器尚未开放一键导入，当前作品未修改。')
    if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未能保存。请先保存或处理待审变更，草稿仍保留，导入已阻止。')
    if (!alive()) return
    const attachment = latest.current.agentAttachment
    const check = await client.preflight(novelId, attachment?.callId ? { runId: attachment.runId, callId: attachment.callId } : undefined)
    if (!alive()) return
    setIntent(check)
    if (check.chapterCount > 0 && !capability.overwriteEnabled) throw new Error('服务器尚未开放已有章节的覆盖导入（包括空白章节）。')
    if (latest.current.autoFile) {
      const problem = validateImportFile(latest.current.autoFile, capability)
      if (problem) throw new Error(problem)
    }
    const automatic = Boolean(latest.current.autoFile)
    setStage(check.chapterCount > 0 ? 'first' : automatic ? 'auto' : 'workspace')
  }), [acceptStatus, client, novelId, run])

  useEffect(() => {
    // Deferral avoids duplicate preflight side effects in StrictMode's probe mount.
    const owner = epoch.current
    const timer = window.setTimeout(() => { void initialize() }, 0)
    return () => { window.clearTimeout(timer); epoch.current = owner + 1; lock.current = false }
  }, [initialize])

  useEffect(() => {
    if (stage !== 'workspace' || busy || dirty || error || job?.status !== 'parsing') return
    const timer = window.setTimeout(() => { void run('正在查询解析进度', async alive => {
      const next = await client.status(novelId, job.jobId)
      await acceptStatus(next, alive)
    }) }, 2500)
    return () => window.clearTimeout(timer)
  }, [acceptStatus, busy, client, dirty, error, job, novelId, run, stage])

  const close = () => {
    if (dirty) { setStage('leave'); return }
    latest.current.onClose()
  }
  const confirmEntry = (step: 1 | 2) => {
    if (!armed || !intent || (step === 1 ? stage !== 'first' : stage !== 'second')) return
    void run('正在记录覆盖确认', async alive => {
      const next = await client.confirmIntent(novelId, intent, step)
      if (!alive()) return
      setIntent(next)
      setStage(step === 1 ? 'second' : latest.current.autoFile ? 'auto' : 'workspace')
    })
  }
  const selectFile = (files: FileList | File[]) => {
    if (busy || dirty || job && !terminalStatuses.has(job.status)) return
    if (files.length === 0) return // Native picker cancellation leaves previous choice intact.
    if (files.length !== 1) { setError('一次请选择一个主文件；多文件可打包为 ZIP。'); return }
    const next = files[0]
    const problem = validateImportFile(next, capabilities)
    if (problem) { setError(problem); return }
    setFile(next); setError(''); setJob(null); setPreview(null); setRestored(false); setManualEncoding(false); setEncoding('utf-8')
    setSummary(null); setStructure(null); setReport(null)
  }
  const upload = () => {
    if ((!file && !props.agentAttachment) || !intent || !capabilities?.enabled) return
    void run('正在创建任务并上传文件', async alive => {
      if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('覆盖入场确认已过期，请点击“重新检查”。')
      const next = await client.create(novelId, intent.intentId, latest.current.modelSelection)
      if (!alive()) return
      if (next.novelId !== novelId) throw new Error('任务作品不匹配。')
      setJob(next); setPreview(null)
      const uploaded = file
        ? await client.upload(novelId, next.jobId, file)
        : await client.attachment(novelId, next.jobId, props.agentAttachment!)
      if (alive()) setJob(uploaded)
    })
  }
  const savePreview = async (alive: () => boolean) => {
    if (job && summary && structure && previewClient) {
      const next = await previewClient.structure(novelId, job.jobId, structure)
      if (!alive()) return
      adoptSummary(next)
      const evidence = await previewClient.report(novelId, job.jobId)
      if (alive()) setReport(evidence)
      return
    }
    if (!job || !preview) throw new Error('没有可保存的原文预览。')
    const next = await client.edit(novelId, job.jobId, { expectedManifestRevision: preview.manifestRevision, volumes: preview.volumes, metadataSelection: preview.metadataSelection })
    if (alive()) { setPreview(next); setDirty(false) }
  }
  const refreshStatus = () => job && void run('正在核对服务器任务状态', async alive => {
    const next = await client.status(novelId, job.jobId)
    await acceptStatus(next, alive)
    if (alive()) setUncertain(false)
  })
  const submit = () => {
    const manifest = summary ?? preview
    if (!armed || !intent || !capabilities?.enabled || !job || !manifest || dirty || uncertain || !(summary ? canSubmitSummary(summary, report) : canSubmitImport(preview)) || !previewStatuses.has(job.status)) return
    void run('正在确认并提交导入，请勿重复操作', async alive => {
      if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未保存，导入已阻止。')
      if (!alive()) return
      const grant = await client.confirm(novelId, job, manifest)
      if (!alive()) return
      setUncertain(true)
      const receipt = await client.commit(novelId, job.jobId, grant.approvalId, `novel-import:${job.jobId}`)
      if (!alive()) return
      if (receipt.novelId !== novelId || receipt.jobId !== job.jobId) throw new Error('导入回执与当前任务不匹配，请查询服务器状态。')
      setJob({ ...job, status: 'succeeded', receipt }); setUncertain(false)
      await latest.current.onImported(receipt)
      if (alive()) delivered.current = job.jobId
    })
  }
  const resume = (item: NovelImportJobStatus) => void run('正在恢复持久导入任务', async alive => {
    if (item.novelId !== novelId) return
    const viewOnly = stage === 'history' || !intent || !capabilities?.enabled
    const next = viewOnly || ['succeeded', 'cancelled', 'expired', 'parsing'].includes(item.status) ? await client.status(novelId, item.jobId) : await client.rebase(novelId, item.jobId, intent!.intentId)
    if (!alive()) return
    setPreview(null); setFile(null); setRestored(false)
    setSummary(null); setStructure(null); setReport(null)
    if (viewOnly) setIntent(null)
    setStage('workspace')
    await acceptStatus(next, alive, false)
  })
  const showHistory = () => void run('正在读取导入记录', async alive => {
    if (dirty || uncertain || restoreUncertain) throw new Error('请先保存预览或核对未知提交结果，再查看其他任务。')
    const history = await client.list(novelId)
    if (!alive()) return
    setJobs(history.filter(item => item.novelId === novelId)); setIntent(null); setJob(null); setPreview(null); setStage('history')
    setSummary(null); setStructure(null); setReport(null)
  })
  const recheck = () => void run('正在重新核对当前作品', async alive => {
    if (dirty) throw new Error('请先保存预览调整，再重新核对覆盖条件。')
    if (!await latest.current.beforeImport()) throw new Error('请先保存当前编辑内容。')
    if (!alive()) return
    const attachment = latest.current.agentAttachment
    const next = await client.preflight(novelId, attachment?.callId ? { runId: attachment.runId, callId: attachment.callId } : undefined)
    if (!alive()) return
    if (next.chapterCount > 0 && !capabilities?.overwriteEnabled) throw new Error('服务器尚未开放已有章节的覆盖导入（包括空白章节）。')
    setIntent(next); setStage(next.chapterCount > 0 ? 'first' : 'workspace')
    if (job) { setJobs(items => [job, ...items.filter(item => item.jobId !== job.jobId)]); setJob(null); setPreview(null) }
    setSummary(null); setStructure(null); setReport(null)
  })

  const autoPipeline = async (alive: () => boolean) => {
    const source = latest.current.autoFile ?? null
    const attachment = !source ? latest.current.agentAttachment ?? null : null
    if (!source && !attachment) throw new Error('没有可导入的文件。')
    if (!intent || !capabilities?.enabled) throw new Error('导入条件未就绪，请重试。')
    if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('覆盖确认已过期，请点击重试重新核对。')
    setAutoStep('正在创建任务并上传文件…')
    autoTarget.current = 15
    // 顶替旧任务：本作品若有未完结导入任务先逐个取消，避免创建闸拒绝（服务端同作品自动取消为双保险）。
    const history = await client.list(novelId)
    if (!alive()) return
    for (const item of history.filter(entry => entry.novelId === novelId && liveStatuses.has(entry.status))) {
      try { await client.cancel(novelId, item.jobId) } catch { /* 服务端创建闸会自动取消同作品任务，这里失败可忽略。 */ }
      if (!alive()) return
    }
    const created = await client.create(novelId, intent.intentId, latest.current.modelSelection)
    if (!alive()) return
    if (created.novelId !== novelId) throw new Error('任务作品不匹配。')
    setJob(created)
    const uploaded = source ? await client.upload(novelId, created.jobId, source) : await client.attachment(novelId, created.jobId, attachment!)
    if (!alive()) return
    setJob(uploaded)
    setAutoStep('正在解析原文…')
    autoTarget.current = 35
    let next = uploaded.status === 'uploaded' ? await client.analyze(novelId, created.jobId, undefined) : uploaded
    if (!alive()) return
    setJob(next)
    for (let guard = 0; !previewStatuses.has(next.status) && !terminalStatuses.has(next.status); guard++) {
      if (guard > 240) throw new Error('解析时间过长，请稍后在导入记录中查看结果。')
      await wait(2500)
      if (!alive()) return
      next = await client.status(novelId, created.jobId)
      if (!alive()) return
      setJob(next)
    }
    if (next.status === 'failed') throw new Error(importErrorMessage(next.errorCode ?? 'IMPORT_PARSE_FAILED'))
    if (!previewStatuses.has(next.status)) throw new Error(`任务已${importStatusLabel(next.status)}，未导入任何内容。`)
    if (!previewClient) throw new AutoImportFallback('当前环境不支持自动核对，已切换到手动核对。')
    setAutoStep('正在核对解析结果…')
    autoTarget.current = 60
    let [summaryNow, reportNow] = await Promise.all([previewClient.summary(novelId, next.jobId), previewClient.report(novelId, next.jobId)])
    if (!alive()) return
    adoptSummary(summaryNow); setReport(reportNow)
    // 自动解决全部会导致提交闸失败的项：failed→exclude、未复核 needs_review→review、未解决 blocking issue 的 itemIds 同理；review 提交后重拉一次核对。
    for (let round = 0; round < 2; round++) {
      const statusById = new Map(reportNow.items.map(item => [item.id, item.status]))
      const decisions = new Map<string, ImportReviewEdit['decisions'][number]>()
      for (const item of reportNow.items) if (item.status === 'failed' || (item.status === 'needs_review' && !reportNow.decisions.some(decision => decision.itemId === item.id))) {
        decisions.set(item.id, { itemId: item.id, action: item.excludable && item.status === 'failed' ? 'exclude' : 'review', reason: item.status === 'failed' ? '一键导入自动核对：该部分无法识别，已排除。' : '一键导入自动核对：确认保留该部分原文。' })
      }
      for (const issue of reportNow.issues.filter(issue => issue.blocking && !issue.resolved)) {
        for (const itemId of issue.itemIds) if (!decisions.has(itemId)) {
          decisions.set(itemId, { itemId, action: statusById.get(itemId) === 'failed' ? 'exclude' : 'review', reason: '一键导入自动核对：确认保留该部分原文。' })
        }
      }
      if (decisions.size === 0) break
      setAutoStep('正在自动核对来源…')
      summaryNow = await previewClient.review(novelId, next.jobId, { expectedManifestRevision: summaryNow.manifestRevision, manifestHash: summaryNow.manifestHash, reportHash: reportNow.reportHash, decisions: [...decisions.values()] })
      if (!alive()) return
      adoptSummary(summaryNow)
      reportNow = await previewClient.report(novelId, next.jobId)
      if (!alive()) return
      setReport(reportNow)
    }
    if (reportNow.issues.some(issue => issue.blocking && !issue.resolved)) throw new Error(reportNow.issues.find(issue => issue.blocking && !issue.resolved)!.message)
    if (!canSubmitSummary(summaryNow, reportNow)) throw new Error('解析结果缺少可导入内容：没有非空章节，也没有识别到计划或设定。')
    setAutoStep('正在提交导入…')
    autoTarget.current = 85
    if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未保存，导入已阻止。')
    if (!alive()) return
    const grant = await client.confirm(novelId, next, summaryNow)
    if (!alive()) return
    const receipt = await client.commit(novelId, next.jobId, grant.approvalId, `novel-import:${next.jobId}`)
    if (!alive()) return
    if (receipt.novelId !== novelId || receipt.jobId !== next.jobId) throw new Error('导入回执与当前任务不匹配，请查询服务器状态。')
    setJob({ ...next, status: 'succeeded', receipt })
    autoTarget.current = 100
    await latest.current.onImported(receipt)
    if (!alive()) return
    delivered.current = next.jobId
    const extras = [receipt.planCount ? `${receipt.planCount} 份计划` : '', receipt.memoryCount ? `${receipt.memoryCount} 条创作记忆` : ''].filter(Boolean).join(' · ')
    toast.success(`导入完成：${receipt.volumeCount} 卷 ${receipt.chapterCount} 章 · ${receipt.wordCount} 字${extras ? ` · ${extras}` : ''}。`)
    latest.current.onClose()
  }
  const pipelineRef = useRef(autoPipeline)
  pipelineRef.current = autoPipeline
  useEffect(() => {
    if (stage !== 'auto') return
    // 延迟一个宏任务启动：进入 auto 常由覆盖确认的 run 触发，需等它释放互斥锁；同时避免 StrictMode 双调用重复起跑。
    const timer = window.setTimeout(() => {
      void run('正在导入', async alive => {
        try { await pipelineRef.current(alive) }
        catch (failure) {
          if (!alive()) return
          if (failure instanceof AutoImportFallback) { setStage('workspace'); setError(failure.message); return }
          throw failure
        }
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [stage, autoNonce, run])

  useEffect(() => {
    // 伪进度条：每 160ms 向当前阶段目标平滑逼近，阶段目标由 autoPipeline 推进（15→35→60→85→100）。
    if (stage !== 'auto') { autoTarget.current = 0; setAutoProgress(0); return }
    const timer = window.setInterval(() => {
      setAutoProgress(value => value >= autoTarget.current ? value : Math.min(autoTarget.current, value + Math.max(0.4, (autoTarget.current - value) * 0.08)))
    }, 160)
    return () => window.clearInterval(timer)
  }, [stage, autoNonce])

  let title = '一键导入'
  let body: ReactNode
  let footer: ReactNode
  const back = <button data-import-safe-focus type="button" className={button} onClick={close}>稍后继续</button>
  if (stage === 'history') {
    title = '导入记录与恢复'
    body = <section className="space-y-3" aria-label="可恢复任务">{jobs.length === 0 && <p>当前作品没有导入记录。</p>}{jobs.map(item => <button type="button" key={item.jobId} className={`${button} block w-full break-all text-left`} disabled={!!busy} onClick={() => resume(item)}>{importStatusLabel(item.status)} · 任务 {item.jobId.slice(0, 8)}</button>)}</section>
    footer = <>{back}<button type="button" className={button} disabled={!!busy} onClick={showHistory}>刷新导入记录</button>{capabilities?.enabled && <button type="button" className={primary} disabled={!!busy} onClick={recheck}>准备新的导入</button>}</>
  } else if (stage === 'first' || stage === 'second') {
    const first = stage === 'first'
    title = first ? '是否覆盖当前作品章节？' : '再次确认覆盖'
    body = <div className="space-y-4 text-sm leading-7">
      <p>《{novelTitle}》已有 {intent?.volumeCount} 卷 {intent?.chapterCount} 章，其中 {intent?.nonEmptyChapterCount} 章有正文。导入将替换当前创作区卷章；确认前不会删除内容。</p>
      {!first && <p>此步骤仅确认进入覆盖导入流程，不会立即删除旧章节；解析完成后仍需核对文件与卷章预览，再确认导入。已发布或待审内容可能阻止导入，导入的新章节不会自动发布。</p>}
    </div>
    footer = <><button key={`${stage}-cancel`} data-import-safe-focus type="button" className={button} disabled={!first && !!busy} onClick={first ? close : recheck}>{first ? '取消' : '返回'}</button>{error && <button type="button" className={button} disabled={!!busy} onClick={recheck}>重新检查覆盖条件</button>}<button key={`${stage}-confirm`} type="button" className={primary} disabled={!!busy || !armed} onClick={event => { if (event.detail <= 1) confirmEntry(first ? 1 : 2) }}>{first ? '是，继续' : '确认并选择文件'}</button></>
  } else if (stage === 'auto') {
    body = <div className="flex flex-col items-center gap-4 py-12">
      <LoaderCircle aria-label="正在导入" className="h-9 w-9 motion-safe:animate-spin" />
      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-[var(--surface-muted)]" aria-hidden="true">
        <div className="h-full rounded-full bg-[var(--surface-contrast)] transition-[width] duration-200 ease-out" style={{ width: `${autoProgress}%` }} />
      </div>
      <p role="status" className="text-sm text-[var(--text-secondary)]">{autoStep || '正在准备导入…'}（{Math.floor(autoProgress)}%）</p>
      {file && <p className="max-w-full truncate text-xs text-[var(--text-tertiary)]">{file.name}</p>}
    </div>
    footer = error ? <><button data-import-safe-focus type="button" className={button} onClick={close}>关闭</button><button type="button" className={primary} disabled={!!busy} onClick={() => { setError(''); setAutoNonce(value => value + 1) }}>重试</button></> : back
  } else if (stage === 'leave') {
    title = '预览调整尚未保存'
    body = <p>关闭前可保存调整以便稍后继续。放弃只丢弃本次未保存的预览编辑，不会取消服务端任务或改动原作品。</p>
    footer = <><button data-import-safe-focus type="button" className={button} disabled={!!busy} onClick={() => setStage('workspace')}>返回编辑</button><button type="button" className={button} disabled={!!busy || !armed} onClick={() => latest.current.onClose()}>放弃调整并收起</button><button type="button" className={primary} disabled={!!busy} onClick={() => void run('正在保存预览', async alive => { await savePreview(alive); if (alive()) latest.current.onClose() })}>保存并收起</button></>
  } else if (stage === 'cancel') {
    title = '取消导入任务？'
    body = <p>取消任务将停止后续处理，未提交时不改动作品。若提交已经完成，将如实显示完成结果，不能把收起当作取消成功。</p>
    footer = <><button data-import-safe-focus type="button" className={button} onClick={() => setStage('workspace')}>返回</button><button type="button" className={primary} disabled={!!busy || !armed} onClick={() => job && void run('正在取消任务', async alive => { const next = await client.cancel(novelId, job.jobId); if (!alive()) return; setDirty(false); setPreview(null); await acceptStatus(next, alive); if (alive()) setStage('workspace') })}>确认取消任务</button></>
  } else if (stage === 'restore') {
    title = '恢复导入前版本？'
    body = <div className="space-y-3 text-sm"><p>将恢复《{novelTitle}》导入前的卷章及本次导入修改的元数据，导入后的章节将退出当前目录。若已有新编辑，服务器将拒绝恢复，避免丢失改动。</p>{restoreApproval && <><p>当前 {restoreApproval.current.volumes} 卷 {restoreApproval.current.chapters} 章 → 恢复为 {restoreApproval.before.volumes} 卷 {restoreApproval.before.chapters} 章。</p><p>回退元数据：{restoreApproval.metadataKeys.map(key => ({ title: '书名', summary: '简介', tags: '标签', tagNames: '标签', coverUrl: '封面', coverAssetId: '封面', coverArtifactId: '封面' })[key] ?? key).join('、') || '不更改'}。备份保留至 {restoreApproval.backupExpiresAt}。</p>{!restoreApproval.canRestore && <p role="alert">{restoreApproval.reason ? importErrorMessage(restoreApproval.reason) : '当前备份无法恢复，请核对新编辑或联系支持。'}</p>}</>}</div>
    footer = <><button data-import-safe-focus type="button" className={button} onClick={() => setStage('workspace')}>返回</button><button type="button" className={primary} disabled={!!busy || !armed || !restoreApproval?.canRestore || restoreUncertain} onClick={event => { if (event.detail > 1) return; if (job && restoreApproval) void run('正在恢复导入前版本', async alive => {
      if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未保存，恢复已阻止。')
      if (!alive()) return
      const approval = await client.restoreConfirm(novelId, job.jobId, restoreApproval.currentTargetHash)
      if (!alive()) return
      setRestoreUncertain(true); restorePending.current = true
      const receipt = await client.restore(novelId, job.jobId, approval)
      if (!alive()) return
      if (receipt.novelId !== novelId || receipt.jobId !== job.jobId) throw new Error('恢复回执作品不匹配。')
      setRestored(true); setRestoreUncertain(false); restorePending.current = false; setStage('workspace')
      setJob({ ...job, restore: { status: 'restored', expiresAt: receipt.restoreExpiresAt, restoredAt: receipt.restoredAt, errorCode: null, receipt } })
      await latest.current.onRestored?.(receipt)
    }) }}>确认恢复</button>{restoreUncertain && <button type="button" className={button} disabled={!!busy} onClick={refreshStatus}>查询恢复结果</button>}</>
  } else if (stage === 'reparse') {
    title = '按所选编码重建预览？'
    body = <p>将按 {encoding.toUpperCase()} 重新解析原文件。已保存的卷章调整将由新预览替换，旧提交授权失效；原作品不变，不调用 AI。若要保留本次调整，请返回。</p>
    footer = <><button data-import-safe-focus type="button" className={button} onClick={() => setStage('workspace')}>返回</button><button type="button" className={primary} disabled={!!busy || !armed || dirty || !manualEncoding} onClick={() => job && void run('正在按所选编码重新解析', async alive => {
      const next = await client.analyze(novelId, job.jobId, encoding)
      if (!alive()) return
      setPreview(null); setDirty(false); setStage('workspace')
      await acceptStatus(next, alive)
    })}>确认重建预览</button></>
  } else if (stage === 'loading') {
    body = <p>正在保存草稿并检查导入条件…</p>
    footer = <>{back}{!busy && error && <button type="button" className={button} onClick={() => void initialize()}>重试</button>}</>
  } else {
    const counts = summary ? { chapters: (structure?.volumes ?? summary.volumes).reduce((total, volume) => total + volume.chapters.length, 0) } : preview ? importPreviewCounts(preview.volumes) : null
    const receipt = job?.receipt
    body = <div className="space-y-4">
      {(job?.source || file) && <section aria-label="导入来源文件" className="min-w-0 rounded-lg border border-[var(--border-subtle)] p-3 text-sm"><p className="break-all">原文件：{job?.source?.filename ?? file?.name} · {((job?.source?.bytes ?? file?.size ?? 0) / 1024).toFixed(1)} KiB</p><p className="text-xs text-[var(--text-tertiary)]">{job?.sourceHash ? '已上传' : '待上传'}</p></section>}
      {restored && job?.restore?.receipt && <p role="status">已恢复 {job.restore.receipt.restoredVolumeCount} 卷 {job.restore.receipt.restoredChapterCount} 章。</p>}
      {!job && jobs.length > 0 && <section aria-label="可恢复任务" className="space-y-2"><h3 className="text-sm font-medium">未完成的导入</h3>{jobs.map(item => <button type="button" key={item.jobId} className={`${button} block w-full break-all text-left`} disabled={!!busy} onClick={() => resume(item)}>{importStatusLabel(item.status)} · 任务 {item.jobId.slice(0, 8)}</button>)}</section>}
      {!job && props.agentAttachment && !file && <section className="rounded-xl border border-[var(--border-subtle)] p-3 text-sm"><p>Agent 交接的待导入附件（尚未导入）</p><p className="break-all">{props.agentAttachment.url}</p><p className="text-xs text-[var(--text-tertiary)]">点击上传后由服务器核验附件归属，不会自动导入。</p></section>}
      {(!job || terminalStatuses.has(job.status)) && !receipt && <div onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); selectFile(event.dataTransfer.files) }} className="rounded-xl border-2 border-dashed border-[var(--border-subtle)] p-5 text-center">
        <Upload className="mx-auto mb-2 h-6 w-6" /><p className="text-sm">拖放文件到此处，或使用系统文件选择器</p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">支持 {formats.filter(extension => capabilities?.formats.some(format => format.extension.replace(/^\./, '').toLowerCase() === extension && format.enabled)).map(extension => `.${extension}`).join(' ')} · 单文件不超过 {((capabilities?.sourceBytes ?? 0) / 1024 / 1024).toFixed(0)} MiB</p>
        <input ref={picker} type="file" aria-label="选择导入文件" accept=".zip,.txt,.md,.pdf,.doc,.docx" className="sr-only" disabled={!!busy} onChange={event => { if (event.target.files) selectFile(event.target.files); event.target.value = '' }} />
        <button type="button" className={`${button} mt-3`} disabled={!!busy} onClick={() => picker.current?.click()}>{file ? '重新选择文件' : '选择文件'}</button>
      </div>}
      {job && <section aria-live="polite" className="space-y-2 text-sm"><p className="break-all">任务 {job.jobId.slice(0, 8)} · {restored ? '已恢复导入前版本' : importStatusLabel(job.status)}</p><p>任务保留至 {job.expiresAt}。</p>{job.errorCode && <><p role="alert">{importErrorMessage(job.errorCode)}</p><details><summary className="min-h-11 cursor-pointer py-3">技术详情（联系支持时提供）</summary><p className="break-all">错误码：{job.errorCode}</p></details></>}{job.sourceHash && <a className={`${button} inline-flex min-h-11 items-center`} href={importSourceUrl(novelId, job.jobId)} download aria-disabled={!!busy} onClick={event => { event.preventDefault(); if (!busy) void run('正在校验并下载原文件', async alive => { const original = await fetchImportOriginal(novelId, job.jobId); if (alive()) triggerBlobDownload(original.blob, original.filename) }) }}>下载原文件</a>}{uncertain && <p role="alert">提交结果尚需核对。请查询服务器状态，不要新建任务重复导入。</p>}</section>}
      {job && ['uploaded', 'failed', 'ready', 'needs_review', 'awaiting_confirmation'].includes(job.status) && <fieldset disabled={!!busy || !intent || uncertain} className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-3 text-sm"><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={manualEncoding} onChange={event => setManualEncoding(event.target.checked)} />手动指定文本编码（已知编码或解析提示时使用）</label>{manualEncoding ? <label className="block">文本编码<select className="ml-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3" value={encoding} onChange={event => setEncoding(event.target.value)}>{['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label> : <p className="text-xs text-[var(--text-secondary)]">默认使用服务器检测或任务已确认的编码；选择编码不会自动启动解析。</p>}{previewStatuses.has(job.status) && manualEncoding && <button type="button" className={button} disabled={dirty || !capabilities?.enabled} onClick={() => setStage('reparse')}>按所选编码重新解析</button>}{dirty && manualEncoding && <p className="text-xs">请先保存预览调整，再选择是否重建预览。</p>}</fieldset>}
      {preview && !receipt && <><p className="text-sm">{intent ? `当前作品：${intent.volumeCount} 卷 ${intent.chapterCount} 章` : '当前为只读查看'} → 待导入：{preview.volumes.length} 卷 {counts?.chapters} 章。</p><ImportPreviewEditor preview={preview} disabled={!!busy || uncertain || !intent || !capabilities?.enabled} currentMetadata={props.currentMetadata ?? { title: novelTitle }} onChange={next => { setPreview(next); setDirty(true) }} /><p role="status" className="text-xs">{dirty ? '预览调整未保存；保存后才能提交。' : `预览版本 ${preview.manifestRevision} 已保存。`}</p></>}
      {summary && structure && job && previewClient && !receipt && <><p className="text-sm">{intent ? `当前作品：${intent.volumeCount} 卷 ${intent.chapterCount} 章` : '只读查看'} → 待导入 {structure.volumes.length} 卷 {counts?.chapters} 章。</p><ImportStructuredEditor key={job.jobId} novelId={novelId} jobId={job.jobId} summary={summary} report={report ?? undefined} draft={structure} disabled={!!busy || uncertain || !intent || !capabilities?.enabled} dirty={dirty} aiEnabled={capabilities?.aiEnabled === true} currentMetadata={props.currentMetadata ?? { title: novelTitle }} client={previewClient} onChange={next => { setStructure(next); setDirty(true) }} /><p role="status">{dirty ? '预览调整未保存；保存后才能提交。' : `预览版本 ${summary.manifestRevision} 已保存。`}</p>{summary.warnings.map((warning, index) => <p key={index} className="text-sm">{warning.blocking ? '阻断' : '注意'}：{warning.message}</p>)}</>}
      {report && job && previewClient && <ImportIntegrityReport key={`${job.jobId}:${report.manifestRevision}:${report.reportHash}`} novelId={novelId} jobId={job.jobId} report={report} disabled={!!busy || dirty || uncertain || !!receipt || !intent || !capabilities?.enabled} onReview={edit => run('正在记录来源核对决定', async alive => {
        if (dirty || !intent || !capabilities?.enabled || receipt) throw new Error('当前不能修改来源决定，请先保存预览并重新检查条件。')
        const next = await previewClient.review(novelId, job.jobId, edit)
        if (!alive()) return
        adoptSummary(next)
        const evidence = await previewClient.report(novelId, job.jobId)
        if (alive()) setReport(evidence)
      })} />}
      {receipt && <section className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4"><h3 className="font-semibold">{restored ? '恢复完成' : receipt.partialImport ? '部分导入完成' : '导入完成'}</h3><p>{receipt.volumeCount} 卷 {receipt.chapterCount} 章 · {receipt.wordCount} 字。备份保留至：{receipt.restoreExpiresAt}</p>{!capabilities?.restoreEnabled && <p className="text-sm">恢复功能尚未开放，备份回执不代表现在可直接恢复。</p>}{!restored && props.onViewChapter && <button type="button" className={button} onClick={() => props.onViewChapter?.(receipt.firstChapterId)}>查看首章</button>}{error && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在刷新创作区', async alive => { if (restored && job?.restore?.receipt) await latest.current.onRestored?.(job.restore.receipt); else if (!restorePending.current) await latest.current.onImported(receipt); if (alive()) delivered.current = receipt.jobId })}>刷新创作区</button>}<details><summary className="min-h-11 cursor-pointer py-3">查看导入报告</summary><p className="break-all text-sm">任务：{receipt.jobId}；备份：{receipt.backupId}；目标校验：{receipt.targetHash}。</p></details>{capabilities?.restoreEnabled && props.onRestored && !restored && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在检查恢复条件', async alive => { const approval = await client.restorePreview(novelId, receipt.jobId); if (alive()) { setRestoreApproval(approval); setStage('restore') } })}>恢复导入前版本</button>}</section>}
    </div>
    footer = <>{back}
      {restoreUncertain && <><p role="alert">恢复结果未知，请查询服务器状态；不会自动重复恢复。</p><button type="button" className={button} disabled={!!busy} onClick={refreshStatus}>查询恢复结果</button></>}
      {(!intent || error) && !receipt && !restoreUncertain && <button type="button" className={button} disabled={!!busy || dirty || uncertain} onClick={recheck}>重新检查</button>}
      {job && !receipt && uncertain && <button type="button" className={button} disabled={!!busy || dirty} onClick={refreshStatus}>查询任务状态</button>}
      {job && !terminalStatuses.has(job.status) && !uncertain && <button type="button" className={button} disabled={!!busy} onClick={() => setStage('cancel')}>取消任务</button>}
      {!job && <button type="button" className={primary} disabled={!!busy || (!file && !props.agentAttachment)} onClick={upload}>上传并检查文件</button>}
      {job?.status === 'uploaded' && <button type="button" className={primary} disabled={!!busy || !intent || !capabilities?.enabled} onClick={() => void run('正在解析原文内容（不调用 AI）', async alive => { const next = await client.analyze(novelId, job.jobId, manualEncoding ? encoding : undefined); await acceptStatus(next, alive) })}>开始确定性解析</button>}
      {job?.status === 'failed' && <button type="button" className={primary} disabled={!!busy || !intent || !capabilities?.enabled} onClick={() => void run('正在重试确定性解析（不调用 AI）', async alive => { const next = await client.retry(novelId, job.jobId, manualEncoding ? encoding : undefined); await acceptStatus(next, alive) })}>重试确定性解析</button>}
      {preview && !receipt && dirty && <button type="button" className={primary} disabled={!!busy || !canSaveImportPreview(preview)} onClick={() => void run('正在保存预览调整', savePreview)}>保存预览调整</button>}
      {preview && !receipt && <button type="button" className={primary} disabled={!!busy || dirty || uncertain || !armed || !intent || !capabilities?.enabled || !canSubmitImport(preview)} onClick={event => { if (event.detail <= 1) submit() }}>{intent && intent.chapterCount > 0 ? '确认覆盖并导入' : '导入'} {preview.volumes.length} 卷 {counts?.chapters} 章</button>}
      {summary && structure && !receipt && <>{dirty && <button type="button" className={primary} disabled={!!busy || !structure.volumes.every(volume => volume.title.trim() && volume.chapters.every(chapter => chapter.title.trim()))} onClick={() => void run('正在保存预览调整', savePreview)}>保存预览调整</button>}<button type="button" className={primary} disabled={!!busy || dirty || uncertain || !armed || !intent || !capabilities?.enabled || !canSubmitSummary(summary, report)} onClick={event => { if (event.detail <= 1) submit() }}>{summary.partialImport ? '部分导入：' : ''}{intent && intent.chapterCount > 0 ? '确认覆盖并导入' : '导入'} {structure.volumes.length} 卷 {counts?.chapters} 章</button></>}
    </>
  }
  return <ImportDialogShell title={title} description={`目标作品：《${novelTitle}》 · 原文导入，不生成缺失正文`} stage={stage} onClose={stage === 'leave' ? () => setStage('workspace') : close} footer={footer}>
    {props.agentAttachment && <p className="mb-3 text-xs">收起面板不会取消 Agent 等待。尚未创建导入任务时，可回到 Agent 停止任务；已创建后可使用“取消任务”停止后续处理。</p>}
    {busy && <p role="status" className="mb-3 flex items-center gap-2 text-sm"><LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />{busy}</p>}
    {error && <p role="alert" className="mb-3 break-words rounded-lg bg-rose-500/10 p-3 text-sm text-rose-600">{error}</p>}
    {body}
  </ImportDialogShell>
}
