import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, Upload } from 'lucide-react'
import type { NovelImportCapabilities, NovelImportJobStatus, NovelImportModelSelection, NovelImportPreflight, NovelImportPreview, NovelImportReceipt, NovelImportStatus } from '../../../../shared/contracts/novel-import.js'
import { novelImportApi, type NovelImportClient } from '../import-api'
import { canSubmitImport, importPreviewCounts } from '../lib/import-preview'
import { ImportDialogShell } from './import-dialog-shell'
import { ImportPreviewEditor } from './import-preview-editor'
import { importErrorMessage, importStatusLabel } from '../lib/import-labels'
import { fetchImportOriginal, importSourceUrl } from '../lib/import-source-download'
import { triggerBlobDownload } from '../lib/export-download'
import type { ImportAgentAttachment } from '../lib/import-handoff'
import type { NovelImportPreviewSummary, NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import { importPreviewApi, type ImportSelectionEdit } from '../import-preview-api'
import { planImportAutoReview } from '../lib/import-auto-review'
import { ImportContentSelection, defaultImportSelection, hasImportSelection } from './import-content-selection'
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
  /** 一键入口文件：自动解析后停在预览，最终写入始终由用户确认。 */
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
type Stage = 'loading' | 'history' | 'workspace' | 'auto' | 'cancel' | 'restore' | 'reparse'
const previewStatuses = new Set(['ready', 'needs_review', 'awaiting_confirmation'])
const terminalStatuses = new Set(['succeeded', 'cancelled', 'expired', 'failed'])
const formats = ['zip', 'txt', 'md', 'pdf', 'doc', 'docx']
/** Existing jobs must be resumed or explicitly cancelled, never silently replaced. */
const liveStatuses = new Set<NovelImportStatus>(['uploading', 'uploaded', 'parsing', 'needs_review', 'ready', 'awaiting_confirmation'])

function canSubmitSummary(summary: NovelImportPreviewSummary, report: NovelImportReportDto | null) {
  const routedExtra = Boolean(summary.plans?.length || summary.memories?.length || Object.keys(summary.metadataSelection).length)
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
  const [report, setReport] = useState<NovelImportReportDto | null>(null)
  const [selection, setSelection] = useState<ImportSelectionEdit | null>(null)
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
  const [autoProgress, setAutoProgress] = useState(0)
  const autoTarget = useRef(0)
  const [restoreApproval, setRestoreApproval] = useState<Awaited<ReturnType<NovelImportClient['restorePreview']>> | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const latest = useRef(props)
  latest.current = props
  const epoch = useRef(0)
  const lock = useRef(false)
  const delivered = useRef<string | null>(null)
  const adoptSummary = (next: NovelImportPreviewSummary) => {
    setSelection(defaultImportSelection(next)); setSummary(next); setDirty(false)
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

  const acceptStatus = useCallback(async (next: NovelImportJobStatus, alive: () => boolean, notify = true, pendingSelection?: ImportSelectionEdit) => {
    if (!alive()) return
    if (next.novelId !== novelId) throw new Error('导入任务不属于当前作品，已停止。')
    setJob(next)
    if (!previewStatuses.has(next.status) && next.status !== 'succeeded') { setPreview(null); setSummary(null); setReport(null) }
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
        if (manifest.manifestRevision !== evidence.manifestRevision || manifest.manifestHash !== evidence.manifestHash || manifest.sourceHash !== evidence.sourceHash) throw new Error('目录与完整性报告版本不一致，请重新查询任务。')
        adoptSummary(manifest); setReport(evidence); setPreview(null)
        if (pendingSelection) {
          if (pendingSelection.expectedManifestRevision === manifest.manifestRevision && pendingSelection.manifestHash === manifest.manifestHash) setSelection(pendingSelection)
          else {
            setSelection({ ...defaultImportSelection(manifest), chapters: [], plans: [], memories: [], metadataSelection: {} })
            setError('已核对服务器预览，版本发生变化。请重新勾选要导入的内容后继续。')
          }
          setDirty(true)
        }
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
    if (check.chapterCount > 0 && !capability.overwriteEnabled) throw new Error('服务器尚未开放已有章节的合并导入（包括标题匹配后的归档重建）。')
    if (latest.current.autoFile) {
      const problem = validateImportFile(latest.current.autoFile, capability)
      if (problem) throw new Error(problem)
    }
    const automatic = Boolean(latest.current.autoFile)
    setStage(automatic ? 'auto' : 'workspace')
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

  const close = () => { if (lock.current && busy === '正在导入所选内容') return; latest.current.onClose() }
  const selectFile = (files: FileList | File[]) => {
    if (busy || dirty || job && !terminalStatuses.has(job.status)) return
    if (files.length === 0) return // Native picker cancellation leaves previous choice intact.
    if (files.length !== 1) { setError('一次请选择一个主文件；多文件可打包为 ZIP。'); return }
    const next = files[0]
    const problem = validateImportFile(next, capabilities)
    if (problem) { setError(problem); return }
    setFile(next); setError(''); setJob(null); setPreview(null); setRestored(false); setManualEncoding(false); setEncoding('utf-8')
    setSummary(null); setReport(null)
  }
  const upload = () => {
    if (job || uncertain || (!file && !props.agentAttachment) || !intent || !capabilities?.enabled) return
    void run('正在创建任务并上传文件', async alive => {
      if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('覆盖入场确认已过期，请点击“重新检查”。')
      const history = await client.list(novelId)
      if (!alive()) return
      setJobs(history.filter(item => item.novelId === novelId))
      if (history.some(item => item.novelId === novelId && liveStatuses.has(item.status))) throw new Error('当前作品已有未完成导入，请恢复该任务；不会自动取消其他任务。')
      setUncertain(true)
      const next = await client.create(novelId, intent.intentId, latest.current.modelSelection)
      if (!alive()) return
      if (next.novelId !== novelId) throw new Error('任务作品不匹配。')
      setJob(next); setPreview(null); setUncertain(false)
      const uploaded = file
        ? await client.upload(novelId, next.jobId, file)
        : await client.attachment(novelId, next.jobId, props.agentAttachment!)
      if (!alive()) return
      setJob(uploaded)
      if (uploaded.status === 'uploaded') await acceptStatus(await client.analyze(novelId, next.jobId), alive)
    })
  }
  const refreshStatus = () => job && void run('正在核对服务器任务状态', async alive => {
    const next = await client.status(novelId, job.jobId)
    await acceptStatus(next, alive, true, uncertain ? selection ?? undefined : undefined)
    if (alive()) setUncertain(false)
  })
  const submit = () => {
    if (!armed || !capabilities?.enabled || !job || !(summary || preview)) return
    if (uncertain) { refreshStatus(); return }
    if (summary && !hasImportSelection(selection)) { setError('请至少选择一项要导入的内容。'); return }
    void run('正在导入所选内容', async alive => {
      if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未保存，导入已阻止。')
      if (!alive()) return
      let currentJob = job
      let currentIntent = intent
      let rebind = !currentIntent || Date.parse(currentIntent.expiresAt) <= Date.now()
      if (rebind) {
        const attachment = latest.current.agentAttachment
        currentIntent = await client.preflight(novelId, attachment?.callId ? { runId: attachment.runId, callId: attachment.callId } : undefined)
        if (!alive()) return
      }
      if (!currentIntent) throw new Error('导入条件未就绪，请稍后重试。')
      if (currentIntent.overwriteRequired && currentIntent.confirmationStep !== 2) {
        currentIntent = await client.confirmSelectionIntent(novelId, currentIntent)
        if (!alive()) return
        rebind = true
      }
      if (rebind) {
        currentJob = await client.rebase(novelId, job.jobId, currentIntent.intentId)
        if (!alive()) return
      }
      setIntent(currentIntent); setJob(currentJob)
      let manifest: NovelImportPreviewSummary | NovelImportPreview = summary ?? preview!
      if (summary && selection && previewClient) {
        // A lost selection response must be reconciled before indices can be reused.
        setUncertain(true)
        manifest = await previewClient.selection(novelId, job.jobId, selection)
        if (!alive()) return
        adoptSummary(manifest)
        const evidence = await previewClient.report(novelId, job.jobId)
        if (!alive()) return
        setReport(evidence)
        currentJob = await client.status(novelId, job.jobId)
        if (!alive()) return
        setJob(currentJob); setUncertain(false)
        if (!canSubmitSummary(manifest, evidence)) throw new Error(evidence.issues.find(issue => issue.blocking && !issue.resolved)?.message ?? '所选内容尚不能导入，请展开下方问题详情处理。')
      } else if (preview) {
        if (dirty) {
          setUncertain(true)
          manifest = await client.edit(novelId, job.jobId, { expectedManifestRevision: preview.manifestRevision, volumes: preview.volumes, metadataSelection: preview.metadataSelection })
          if (!alive()) return
          setPreview(manifest); setDirty(false); setUncertain(false)
        }
        if (!canSubmitImport(manifest as NovelImportPreview)) throw new Error('所选内容尚不能导入，请处理下方来源问题。')
      }
      if (!previewStatuses.has(currentJob.status)) throw new Error('任务状态已变化，请查询任务状态后继续。')
      const grant = await client.confirm(novelId, currentJob, manifest)
      if (!alive()) return
      setUncertain(true)
      const receipt = await client.commit(novelId, job.jobId, grant.approvalId, `novel-import:${job.jobId}`)
      if (!alive()) return
      if (receipt.novelId !== novelId || receipt.jobId !== job.jobId) throw new Error('导入回执与当前任务不匹配，请查询服务器状态。')
      setJob({ ...currentJob, status: 'succeeded', receipt }); setUncertain(false)
      await latest.current.onImported(receipt)
      if (alive()) { delivered.current = job.jobId; latest.current.onClose() }
    })
  }
  const resume = (item: NovelImportJobStatus) => void run('正在恢复持久导入任务', async alive => {
    if (item.novelId !== novelId) return
    const next = await client.status(novelId, item.jobId)
    if (!alive()) return
    setPreview(null); setFile(null); setRestored(false)
    setSummary(null); setReport(null)
    setIntent(null)
    setStage('workspace')
    await acceptStatus(next, alive, false)
  })
  const showHistory = () => void run('正在读取导入记录', async alive => {
    if (dirty || uncertain || restoreUncertain) throw new Error('请先保存预览或核对未知提交结果，再查看其他任务。')
    const history = await client.list(novelId)
    if (!alive()) return
    setJobs(history.filter(item => item.novelId === novelId)); setIntent(null); setJob(null); setPreview(null); setStage('history')
    setSummary(null); setReport(null)
  })
  const recheck = () => void run('正在重新核对当前作品', async alive => {
    if (!await latest.current.beforeImport()) throw new Error('请先保存当前编辑内容。')
    if (!alive()) return
    const attachment = latest.current.agentAttachment
    const next = await client.preflight(novelId, attachment?.callId ? { runId: attachment.runId, callId: attachment.callId } : undefined)
    if (!alive()) return
    if (next.chapterCount > 0 && !capabilities?.overwriteEnabled) throw new Error('服务器尚未开放已有章节的合并导入（包括标题匹配后的归档重建）。')
    setIntent(next); setStage('workspace')
    if (job && next.chapterCount === 0) await acceptStatus(await client.rebase(novelId, job.jobId, next.intentId), alive, true, selection ?? undefined)
  })

  const autoPipeline = async (alive: () => boolean) => {
    const source = latest.current.autoFile ?? null
    const attachment = !source ? latest.current.agentAttachment ?? null : null
    if (!source && !attachment) throw new Error('没有可导入的文件。')
    if (!intent || !capabilities?.enabled) throw new Error('导入条件未就绪，请重试。')
    if (job || uncertain) throw new AutoImportFallback('请在预览中继续当前任务，不会重新创建任务。')
    if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('覆盖确认已过期，请点击“重新检查”重新核对。')
    setFile(source)
    setAutoStep('正在创建任务并上传文件…')
    autoTarget.current = 15
    // Do not invoke create when it could replace another active task.
    const history = await client.list(novelId)
    if (!alive()) return
    setJobs(history.filter(item => item.novelId === novelId))
    if (history.some(item => item.novelId === novelId && liveStatuses.has(item.status))) throw new AutoImportFallback('当前作品已有未完成导入，请恢复该任务；不会自动取消其他任务。')
    setUncertain(true)
    const created = await client.create(novelId, intent.intentId, latest.current.modelSelection)
    if (!alive()) return
    if (created.novelId !== novelId) throw new Error('任务作品不匹配。')
    setJob(created); setUncertain(false)
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
    if (summaryNow.manifestRevision !== reportNow.manifestRevision || summaryNow.manifestHash !== reportNow.manifestHash || summaryNow.sourceHash !== reportNow.sourceHash) throw new AutoImportFallback('目录与来源报告版本不一致，请查询任务状态后继续。')
    const plan = planImportAutoReview(reportNow)
    if (plan.reason) throw new AutoImportFallback(plan.reason)
    if (plan.decisions.length) {
      setAutoStep('正在记录缺失或失败来源的排除…')
      summaryNow = await previewClient.review(novelId, next.jobId, { expectedManifestRevision: summaryNow.manifestRevision, manifestHash: summaryNow.manifestHash, reportHash: reportNow.reportHash, decisions: plan.decisions })
      if (!alive()) return
      adoptSummary(summaryNow)
      reportNow = await previewClient.report(novelId, next.jobId)
      if (!alive()) return
      setReport(reportNow)
    }
    if (plan.decisions.length || summaryNow.partialImport || reportNow.partialImport || reportNow.decisions.some(decision => decision.action === 'exclude')) throw new AutoImportFallback('已停止自动提交：存在排除来源。请核对预览中的已排除来源及保留内容，再明确确认部分导入。')
    if (reportNow.issues.some(issue => issue.blocking && !issue.resolved)) throw new AutoImportFallback(`仍有未解决问题：${reportNow.issues.find(issue => issue.blocking && !issue.resolved)!.message}。请在预览中处理。`)
    if (!canSubmitSummary(summaryNow, reportNow) && !Object.keys(summaryNow.metadata).length && !summaryNow.artifacts?.some(item => item.coverCandidate)) throw new Error('文件中没有识别到可导入内容，请检查原文件。')
    setAutoStep(''); setStage('workspace')
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
          setStage('workspace'); setAutoStep('')
          if (failure instanceof AutoImportFallback) { setError(failure.message); return }
          throw failure
        }
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [stage, run])

  useEffect(() => {
    // 仅展示解析阶段的估计进度；结束后转入预览，不代表已经写入作品。
    if (stage !== 'auto') { autoTarget.current = 0; setAutoProgress(0); return }
    const timer = window.setInterval(() => {
      setAutoProgress(value => value >= autoTarget.current ? value : Math.min(autoTarget.current, value + Math.max(0.4, (autoTarget.current - value) * 0.08)))
    }, 160)
    return () => window.clearInterval(timer)
  }, [stage])

  let title = '一键导入'
  let body: ReactNode
  let footer: ReactNode
  const back = <button data-import-safe-focus type="button" className={button} disabled={busy === '正在导入所选内容'} onClick={close}>取消</button>
  if (stage === 'history') {
    title = '导入记录与恢复'
    body = <section className="space-y-3" aria-label="可恢复任务">{jobs.length === 0 && <p>当前作品没有导入记录。</p>}{jobs.map(item => <button type="button" key={item.jobId} className={`${button} block w-full break-all text-left`} disabled={!!busy} onClick={() => resume(item)}>{importStatusLabel(item.status)} · 任务 {item.jobId.slice(0, 8)}</button>)}</section>
    footer = <>{back}<button type="button" className={button} disabled={!!busy} onClick={showHistory}>刷新导入记录</button>{capabilities?.enabled && <button type="button" className={primary} disabled={!!busy} onClick={recheck}>准备新的导入</button>}</>
  } else if (stage === 'auto') {
    body = <div className="flex flex-col items-center gap-4 py-12">
      <LoaderCircle aria-label="正在导入" className="h-9 w-9 motion-safe:animate-spin" />
      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-[var(--surface-muted)]" aria-hidden="true">
        <div className="h-full rounded-full bg-[var(--surface-contrast)] transition-[width] duration-200 ease-out" style={{ width: `${autoProgress}%` }} />
      </div>
      <p role="status" className="text-sm text-[var(--text-secondary)]">{autoStep || '正在准备导入…'}（{Math.floor(autoProgress)}%）</p>
      {file && <p className="max-w-full truncate text-xs text-[var(--text-tertiary)]">{file.name}</p>}
    </div>
    footer = back
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
    title = manualEncoding ? '按所选编码重建预览？' : '重新解析原文件？'
    body = <p>将按{manualEncoding ? ` ${encoding.toUpperCase()} ` : '服务器检测或任务已确认的编码'}重新解析原文件。已保存的卷章调整将由新预览替换，旧提交授权失效；原作品不变，不调用 AI。若要保留本次调整，请返回。</p>
    footer = <><button data-import-safe-focus type="button" className={button} onClick={() => setStage('workspace')}>返回</button><button type="button" className={primary} disabled={!!busy || !armed || dirty} onClick={() => job && void run('正在重新解析原文件', async alive => {
      const next = await client.analyze(novelId, job.jobId, manualEncoding ? encoding : undefined, true)
      if (!alive()) return
      setPreview(null); setDirty(false); setStage('workspace')
      await acceptStatus(next, alive)
    })}>确认重建预览</button></>
  } else if (stage === 'loading') {
    body = <p>正在保存草稿并检查导入条件…</p>
    footer = <>{back}{!busy && error && <button type="button" className={button} onClick={() => void initialize()}>重试</button>}</>
  } else {
    const counts = summary ? { chapters: summary.volumes.reduce((total, volume) => total + volume.chapters.length, 0) } : preview ? importPreviewCounts(preview.volumes) : null
    const receipt = job?.receipt
    body = <div className="space-y-4">

      {(job?.source || file) && <section aria-label="导入来源文件" className="min-w-0 rounded-lg border border-[var(--border-subtle)] p-3 text-sm"><p className="break-all">原文件：{job?.source?.filename ?? file?.name} · {((job?.source?.bytes ?? file?.size ?? 0) / 1024).toFixed(1)} KiB</p><p className="text-xs text-[var(--text-tertiary)]">{job?.sourceHash ? '已上传' : '待上传'}</p></section>}
      {job?.status === 'parsing' && <p role="status" className="text-sm">正在解析文件，请稍候…</p>}
      {job?.status === 'failed' && <p role="alert" className="text-sm">{importErrorMessage(job.errorCode ?? 'IMPORT_PARSE_FAILED')} 点击一键导入可重试原任务。</p>}
      {uncertain && <p role="status" className="text-sm">上次操作结果尚未确认。点击一键导入将先核对状态，避免重复导入。</p>}
      {restored && job?.restore?.receipt && <p role="status">已恢复 {job.restore.receipt.restoredVolumeCount} 卷 {job.restore.receipt.restoredChapterCount} 章。</p>}
      {!job && jobs.length > 0 && <section aria-label="可恢复任务" className="space-y-2"><h3 className="text-sm font-medium">未完成的导入</h3>{jobs.map(item => <button type="button" key={item.jobId} className={`${button} block w-full break-all text-left`} disabled={!!busy} onClick={() => resume(item)}>{importStatusLabel(item.status)} · 任务 {item.jobId.slice(0, 8)}</button>)}</section>}
      {!job && props.agentAttachment && !file && <section className="rounded-xl border border-[var(--border-subtle)] p-3 text-sm"><p>Agent 交接的待导入附件（尚未导入）</p><p className="break-all">{props.agentAttachment.url}</p><p className="text-xs text-[var(--text-tertiary)]">点击上传后由服务器核验附件归属，不会自动导入。</p></section>}
      {(!job || terminalStatuses.has(job.status)) && !receipt && <div onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); selectFile(event.dataTransfer.files) }} className="rounded-xl border-2 border-dashed border-[var(--border-subtle)] p-5 text-center">
        <Upload className="mx-auto mb-2 h-6 w-6" /><p className="text-sm">拖放文件到此处，或使用系统文件选择器</p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">支持 {formats.filter(extension => capabilities?.formats.some(format => format.extension.replace(/^\./, '').toLowerCase() === extension && format.enabled)).map(extension => `.${extension}`).join(' ')} · 单文件不超过 {((capabilities?.sourceBytes ?? 0) / 1024 / 1024).toFixed(0)} MiB</p>
        <input ref={picker} type="file" aria-label="选择导入文件" accept=".zip,.txt,.md,.pdf,.doc,.docx" className="sr-only" disabled={!!busy} onChange={event => { if (event.target.files) selectFile(event.target.files); event.target.value = '' }} />
        <button type="button" className={`${button} mt-3`} disabled={!!busy} onClick={() => picker.current?.click()}>{file ? '重新选择文件' : '选择文件'}</button>
      </div>}
      {preview && !receipt && <><p className="text-sm">{intent ? `当前作品：${intent.volumeCount} 卷 ${intent.chapterCount} 章` : '当前为只读查看'} → 待导入：{preview.volumes.length} 卷 {counts?.chapters} 章。</p><ImportPreviewEditor preview={preview} disabled={!!busy || uncertain || !intent || !capabilities?.enabled} currentMetadata={props.currentMetadata ?? { title: novelTitle }} onChange={next => { setPreview(next); setDirty(true) }} /><p role="status" className="text-xs">{dirty ? '点击一键导入将应用当前选择。' : '请选择要导入的内容。'}</p></>}
      {summary && selection && job && !receipt && <ImportContentSelection novelId={novelId} jobId={job.jobId} summary={summary} report={report} value={selection} disabled={!!busy || uncertain || !capabilities?.enabled} onChange={next => { setSelection(next); setDirty(true) }} />}
      {summary?.partialImport && !receipt && <p className="text-sm text-[var(--text-secondary)]">本次仅导入保留的内容，已排除的来源不会导入。</p>}
      {report?.issues.some(issue => issue.blocking && !issue.resolved) && !receipt && <p role="status" className="rounded-lg bg-amber-500/10 p-3 text-sm">部分来源需要处理：{report.issues.find(issue => issue.blocking && !issue.resolved)?.message}。请展开下方详情处理，或重新解析原文件。</p>}
      {receipt && <section className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4"><h3 className="font-semibold">{restored ? '恢复完成' : receipt.partialImport ? '部分导入完成' : '导入完成'}</h3><p>{receipt.volumeCount} 卷 {receipt.chapterCount} 章 · {receipt.wordCount} 字。备份保留至：{receipt.restoreExpiresAt}</p>{!capabilities?.restoreEnabled && <p className="text-sm">恢复功能尚未开放，备份回执不代表现在可直接恢复。</p>}{!restored && receipt.firstChapterId && props.onViewChapter && <button type="button" className={button} onClick={() => props.onViewChapter?.(receipt.firstChapterId)}>查看首章</button>}{error && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在刷新创作区', async alive => { if (restored && job?.restore?.receipt) await latest.current.onRestored?.(job.restore.receipt); else if (!restorePending.current) await latest.current.onImported(receipt); if (alive()) delivered.current = receipt.jobId })}>刷新创作区</button>}<details><summary className="min-h-11 cursor-pointer py-3">查看导入报告</summary><p className="break-all text-sm">任务：{receipt.jobId}；备份：{receipt.backupId}；目标校验：{receipt.targetHash}。</p></details>{capabilities?.restoreEnabled && props.onRestored && !restored && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在检查恢复条件', async alive => { const approval = await client.restorePreview(novelId, receipt.jobId); if (alive()) { setRestoreApproval(approval); setStage('restore') } })}>恢复导入前版本</button>}</section>}
    </div>
    body = <>{body}{!receipt && <details className="mt-3 text-sm"><summary className="cursor-pointer py-2 text-[var(--text-secondary)]">遇到问题？查看详情</summary><div className="space-y-4 py-2">
      {job && <section aria-live="polite" className="space-y-2 text-sm"><p className="break-all">任务 {job.jobId.slice(0, 8)} · {restored ? '已恢复导入前版本' : importStatusLabel(job.status)}</p><p>任务保留至 {job.expiresAt}。</p>{job.errorCode && <><p role="alert">{importErrorMessage(job.errorCode)}</p><details><summary className="min-h-11 cursor-pointer py-3">技术详情（联系支持时提供）</summary><p className="break-all">错误码：{job.errorCode}</p></details></>}{job.sourceHash && <a className={`${button} inline-flex min-h-11 items-center`} href={importSourceUrl(novelId, job.jobId)} download aria-disabled={!!busy} onClick={event => { event.preventDefault(); if (!busy) void run('正在校验并下载原文件', async alive => { const original = await fetchImportOriginal(novelId, job.jobId); if (alive()) triggerBlobDownload(original.blob, original.filename) }) }}>下载原文件</a>}{uncertain && <p role="alert">提交结果尚需核对。请查询服务器状态，不要新建任务重复导入。</p>}</section>}
      {job && ['uploaded', 'failed', 'ready', 'needs_review', 'awaiting_confirmation'].includes(job.status) && <fieldset disabled={!!busy || !intent || uncertain} className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-3 text-sm"><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={manualEncoding} onChange={event => setManualEncoding(event.target.checked)} />手动指定文本编码（已知编码或解析提示时使用）</label>{manualEncoding ? <label className="block">文本编码<select className="ml-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3" value={encoding} onChange={event => setEncoding(event.target.value)}>{['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label> : <p className="text-xs text-[var(--text-secondary)]">默认使用服务器检测或任务已确认的编码；选择编码不会自动启动解析。</p>}{previewStatuses.has(job.status) && <button type="button" className={button} disabled={dirty || !capabilities?.enabled} onClick={() => setStage('reparse')}>{manualEncoding ? '按所选编码重新解析' : '重新解析原文件'}</button>}{dirty && manualEncoding && <p className="text-xs">点击导入会保存当前选择；也可取消后重新打开。</p>}</fieldset>}
      {report && job && previewClient && <ImportIntegrityReport key={`${job.jobId}:${report.manifestRevision}:${report.reportHash}`} novelId={novelId} jobId={job.jobId} report={report} disabled={!!busy || dirty || uncertain || !!receipt || !intent || !capabilities?.enabled} onReview={edit => run('正在记录来源核对决定', async alive => {
        if (dirty || !intent || !capabilities?.enabled || receipt) throw new Error('当前不能修改来源决定，请先保存预览并重新检查条件。')
        const next = await previewClient.review(novelId, job.jobId, edit)
        if (!alive()) return
        adoptSummary(next)
        const evidence = await previewClient.report(novelId, job.jobId)
        if (alive()) setReport(evidence)
      })} />}

      {restoreUncertain && <><p role="alert">恢复结果未知，请查询服务器状态；不会自动重复恢复。</p><button type="button" className={button} disabled={!!busy} onClick={refreshStatus}>查询恢复结果</button></>}
      {(!intent || error) && !receipt && !restoreUncertain && <button type="button" className={button} disabled={!!busy || uncertain} onClick={recheck}>重新检查</button>}
      {job && !receipt && <button type="button" className={button} disabled={!!busy || (dirty && !uncertain)} onClick={refreshStatus}>查询任务状态</button>}
      {!job && uncertain && <p role="alert">创建任务结果未知，已阻止重复创建。请收起面板后从导入记录核对原任务，不要重新上传。</p>}
      {job && !terminalStatuses.has(job.status) && !uncertain && <button type="button" className={button} disabled={!!busy} onClick={() => setStage('cancel')}>取消任务</button>}
      {!job && <button type="button" className={primary} disabled={!!busy || uncertain || (!file && !props.agentAttachment)} onClick={upload}>上传并检查文件</button>}
      {job?.status === 'uploading' && (file || props.agentAttachment) && <button type="button" className={button} disabled={!!busy || uncertain} onClick={() => void run('正在核对并继续原任务上传', async alive => {
        const current = await client.status(novelId, job.jobId)
        if (!alive()) return
        if (current.status !== 'uploading') { await acceptStatus(current, alive); return }
        const uploaded = file ? await client.upload(novelId, job.jobId, file) : await client.attachment(novelId, job.jobId, props.agentAttachment!)
        await acceptStatus(uploaded, alive)
      })}>继续原任务上传</button>}
      {job?.status === 'uploaded' && <button type="button" className={primary} disabled={!!busy || !intent || !capabilities?.enabled} onClick={() => void run('正在解析原文内容（不调用 AI）', async alive => { const next = await client.analyze(novelId, job.jobId, manualEncoding ? encoding : undefined); await acceptStatus(next, alive) })}>开始确定性解析</button>}
      {job?.status === 'failed' && <button type="button" className={primary} disabled={!!busy || !intent || !capabilities?.enabled} onClick={() => void run('正在重试确定性解析（不调用 AI）', async alive => { const next = await client.retry(novelId, job.jobId, manualEncoding ? encoding : undefined); await acceptStatus(next, alive) })}>重试确定性解析</button>}
    </div></details>}</>
    footer = <>{back}{!receipt && <button type="button" className={primary} disabled={!!busy || !armed || !capabilities?.enabled || (summary ? !hasImportSelection(selection) : !preview && !file && !props.agentAttachment && !job)} onClick={event => {
      if (event.detail > 1) return
      if (summary || preview) submit()
      else if (!job) upload()
      else if (job.status === 'uploaded' || job.status === 'failed') void run('正在解析原文件', async alive => { await acceptStatus(await (job.status === 'failed' ? client.retry : client.analyze)(novelId, job.jobId, manualEncoding ? encoding : undefined), alive) })
      else refreshStatus()
    }}>{busy ? '正在处理…' : '一键导入'}</button>}</>

  }
  return <ImportDialogShell title={title} description={`目标作品：《${novelTitle}》`} compact={stage === 'workspace' && !!summary} stage={stage} onClose={close} footer={footer}>
    {props.agentAttachment && <p className="mb-3 text-xs">收起面板不会取消 Agent 等待。尚未创建导入任务时，可回到 Agent 停止任务；已创建后可使用“取消任务”停止后续处理。</p>}
    {busy && <p role="status" className="mb-3 flex items-center gap-2 text-sm"><LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />{busy}</p>}
    {error && <p role="alert" className="mb-3 break-words rounded-lg bg-rose-500/10 p-3 text-sm text-rose-600">{error}</p>}
    {body}
  </ImportDialogShell>
}
