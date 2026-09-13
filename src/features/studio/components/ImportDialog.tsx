import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, Upload } from 'lucide-react'
import type { NovelImportCapabilities, NovelImportJobStatus, NovelImportModelSelection, NovelImportPreflight, NovelImportPreview, NovelImportReceipt } from '../../../../shared/contracts/novel-import.js'
import { novelImportApi, type NovelImportClient } from '../import-api'
import { canSaveImportPreview, canSubmitImport, importPreviewCounts } from '../lib/import-preview'
import { ImportDialogShell } from './import-dialog-shell'
import { ImportPreviewEditor } from './import-preview-editor'
import { importErrorMessage, importStatusLabel } from '../lib/import-labels'
import { fetchImportOriginal, importSourceUrl } from '../lib/import-source-download'
import { triggerBlobDownload } from '../lib/export-download'

export type ImportDialogProps = {
  open: boolean
  novelId: string
  novelTitle: string
  currentMetadata?: { title: string; summary?: string; tags?: string[] }
  /** The composer CURRENT selection, never the newest enabled custom model. */
  modelSelection: NovelImportModelSelection
  /** Untrusted handoff hint; server must revalidate owner, run and source before copying. */
  agentAttachment?: { url: string; runId: string }
  /** Status handoff: view only until a fresh human confirmation flow is requested. */
  initialJobId?: string
  /** Flush local editor text and await persistence; false blocks import and preserves draft. */
  beforeImport: () => Promise<boolean>
  onClose: () => void
  /** Refresh studio tree/metadata/chapter caches in this novel; navigate using firstChapterId. */
  onImported: (receipt: NovelImportReceipt) => void | Promise<void>
  onRestored?: (receipt: NovelImportReceipt) => void | Promise<void>
  onViewChapter?: (chapterId: string) => void
  client?: NovelImportClient
}

const button = 'rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40'
const primary = `${button} bg-[var(--surface-contrast)] text-[var(--text-contrast)]`
type Stage = 'loading' | 'first' | 'second' | 'workspace' | 'leave' | 'cancel' | 'restore' | 'reparse'
const previewStatuses = new Set(['ready', 'needs_review', 'awaiting_confirmation'])
const terminalStatuses = new Set(['succeeded', 'cancelled', 'expired', 'failed'])
const formats = ['zip', 'txt', 'md', 'pdf', 'doc', 'docx']

export default function ImportDialog(props: ImportDialogProps) {
  // Identity fencing also covers A → B → A and close/reopen during an old request.
  return props.open ? <ImportDialogSession key={`${props.novelId}:${props.initialJobId ?? ''}`} {...props} /> : null
}

function ImportDialogSession(props: ImportDialogProps) {
  const { novelId, novelTitle, client = novelImportApi } = props
  const [stage, setStage] = useState<Stage>('loading')
  const [capabilities, setCapabilities] = useState<NovelImportCapabilities | null>(null)
  const [intent, setIntent] = useState<NovelImportPreflight | null>(null)
  const [jobs, setJobs] = useState<NovelImportJobStatus[]>([])
  const [job, setJob] = useState<NovelImportJobStatus | null>(null)
  const [preview, setPreview] = useState<NovelImportPreview | null>(null)
  const [dirty, setDirty] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [manualEncoding, setManualEncoding] = useState(false)
  const [encoding, setEncoding] = useState('utf-8')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [armed, setArmed] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [restored, setRestored] = useState(false)
  const [restoreApproval, setRestoreApproval] = useState<Awaited<ReturnType<NovelImportClient['restorePreview']>> | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const latest = useRef(props)
  latest.current = props
  const epoch = useRef(0)
  const lock = useRef(false)
  const delivered = useRef<string | null>(null)

  useEffect(() => {
    setArmed(false)
    const timer = window.setTimeout(() => setArmed(true), 450)
    return () => window.clearTimeout(timer)
  }, [stage])

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

  const acceptStatus = useCallback(async (next: NovelImportJobStatus, alive: () => boolean) => {
    if (!alive()) return
    if (next.novelId !== novelId) throw new Error('导入任务不属于当前作品，已停止。')
    setJob(next)
    if (previewStatuses.has(next.status)) {
      const manifest = await client.preview(novelId, next.jobId)
      if (!alive()) return
      setPreview(manifest); setDirty(false)
    }
    if (next.status === 'succeeded' && next.receipt && delivered.current !== next.jobId) {
      if (next.receipt.novelId !== novelId) throw new Error('导入回执与当前作品不匹配。')
      await latest.current.onImported(next.receipt)
      if (alive()) delivered.current = next.jobId
    }
  }, [client, novelId])

  const initialize = useCallback(() => run('正在保存当前草稿并检查导入条件', async alive => {
    if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未能保存。请先保存或处理待审变更，草稿仍保留，导入已阻止。')
    if (!alive()) return
    const capability = await client.capabilities(novelId)
    if (!alive()) return
    setCapabilities(capability)
    if (latest.current.initialJobId) {
      const existing = await client.status(novelId, latest.current.initialJobId)
      if (!alive()) return
      setStage('workspace')
      await acceptStatus(existing, alive)
      return
    }
    if (!capability.enabled) throw new Error('服务器尚未开放一键导入，当前作品未修改。')
    const history = await client.list(novelId)
    if (!alive()) return
    setJobs(history.filter(item => item.novelId === novelId))
    const check = await client.preflight(novelId)
    if (!alive()) return
    setIntent(check)
    if (check.chapterCount > 0 && !capability.overwriteEnabled) throw new Error('服务器尚未开放已有章节的覆盖导入（包括空白章节）。')
    setStage(check.chapterCount > 0 ? 'first' : 'workspace')
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
      setStage(step === 1 ? 'second' : 'workspace')
    })
  }
  const selectFile = (files: FileList | File[]) => {
    if (busy || dirty || job && !terminalStatuses.has(job.status)) return
    if (files.length === 0) return // Native picker cancellation leaves previous choice intact.
    if (files.length !== 1) { setError('一次请选择一个主文件；多文件可打包为 ZIP。'); return }
    const next = files[0]
    const extension = next.name.split('.').pop()?.toLowerCase()
    const capability = capabilities?.formats.find(item => item.extension.replace(/^\./, '').toLowerCase() === extension)
    if (!extension || !formats.includes(extension) || !capability?.enabled) { setError(capability?.reason || '当前服务器未开放此格式，请选择已开放的格式。'); return }
    if (!next.size) { setError('文件为空，请选择含有原文正文的文件。'); return }
    if (!capabilities || next.size > capabilities.sourceBytes) { setError('文件超过服务器上传上限，请拆分后再试。'); return }
    setFile(next); setError(''); setJob(null); setPreview(null); setRestored(false); setManualEncoding(false); setEncoding('utf-8')
  }
  const upload = () => {
    if ((!file && !props.agentAttachment) || !intent || !capabilities?.enabled) return
    void run('正在创建任务并上传文件', async alive => {
      if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('覆盖入场确认已过期，请点击“重新检查覆盖条件”。')
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
    if (!armed || !intent || !capabilities?.enabled || !job || !preview || dirty || uncertain || !canSubmitImport(preview) || !previewStatuses.has(job.status)) return
    void run('正在确认并提交导入，请勿重复操作', async alive => {
      if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未保存，导入已阻止。')
      if (!alive()) return
      const grant = await client.confirm(novelId, job, preview)
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
    if (!intent || item.novelId !== novelId) return
    const next = ['succeeded', 'cancelled', 'expired', 'parsing'].includes(item.status) ? await client.status(novelId, item.jobId) : await client.rebase(novelId, item.jobId, intent.intentId)
    if (!alive()) return
    setPreview(null); setFile(null); setRestored(false)
    await acceptStatus(next, alive)
  })
  const recheck = () => void run('正在重新核对当前作品', async alive => {
    if (dirty) throw new Error('请先保存预览调整，再重新核对覆盖条件。')
    if (!await latest.current.beforeImport()) throw new Error('请先保存当前编辑内容。')
    if (!alive()) return
    const next = await client.preflight(novelId)
    if (!alive()) return
    if (next.chapterCount > 0 && !capabilities?.overwriteEnabled) throw new Error('服务器尚未开放已有章节的覆盖导入（包括空白章节）。')
    setIntent(next); setStage(next.chapterCount > 0 ? 'first' : 'workspace')
    if (job) { setJobs(items => [job, ...items.filter(item => item.jobId !== job.jobId)]); setJob(null); setPreview(null) }
  })

  let title = '一键导入'
  let body: ReactNode
  let footer: ReactNode
  const back = <button data-import-safe-focus type="button" className={button} onClick={close}>稍后继续</button>
  if (stage === 'first' || stage === 'second') {
    const first = stage === 'first'
    title = first ? '是否覆盖当前作品章节？' : '再次确认覆盖'
    body = <div className="space-y-4 text-sm leading-7">
      <p>《{novelTitle}》已有 {intent?.volumeCount} 卷 {intent?.chapterCount} 章，其中 {intent?.nonEmptyChapterCount} 章有正文。导入将替换当前创作区卷章；确认前不会删除内容。</p>
      {!first && <><p>这里只确认进入覆盖导入流程，不会立即删除旧章节。解析完成后仍需确认实际文件与卷章预览。</p><p>{capabilities?.restoreEnabled ? '旧稿恢复范围及有效期以服务端回执为准。' : '当前服务器尚未开放恢复功能，不能承诺可直接恢复。'}已有发布、待审与运行任务可能阻止导入。新正文不会自动发布，旧审查不能应用到新章。</p>{capabilities?.limitations.map(item => <p key={item}>{item}</p>)}</>}
    </div>
    footer = <><button key={`${stage}-cancel`} data-import-safe-focus type="button" className={button} disabled={!first && !!busy} onClick={first ? close : recheck}>{first ? '取消' : '返回'}</button>{error && <button type="button" className={button} disabled={!!busy} onClick={recheck}>重新检查覆盖条件</button>}<button key={`${stage}-confirm`} type="button" className={primary} disabled={!!busy || !armed} onClick={event => { if (event.detail <= 1) confirmEntry(first ? 1 : 2) }}>{first ? '是，继续' : '确认并选择文件'}</button></>
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
    body = <p>将恢复《{novelTitle}》导入前的卷章及本次导入修改的元数据，导入后的章节将退出当前目录。若已有新编辑，服务器将拒绝恢复，避免丢失改动。恢复授权有效期：{restoreApproval?.expiresAt}。</p>
    footer = <><button data-import-safe-focus type="button" className={button} onClick={() => setStage('workspace')}>返回</button><button type="button" className={primary} disabled={!!busy || !armed || !restoreApproval} onClick={() => job && restoreApproval && void run('正在恢复导入前版本', async alive => {
      if (!await latest.current.beforeImport()) throw new Error('当前编辑内容未保存，恢复已阻止。')
      if (!alive()) return
      const receipt = await client.restore(novelId, job.jobId, restoreApproval)
      if (!alive()) return
      if (receipt.novelId !== novelId) throw new Error('恢复回执作品不匹配。')
      setRestored(true); setStage('workspace')
      await latest.current.onRestored?.(receipt)
    })}>确认恢复</button></>
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
    body = <p>正在保存草稿并取得服务器真实章节数量。检查失败不会按空作品处理。</p>
    footer = <>{back}{!busy && <button type="button" className={button} onClick={() => void initialize()}>重试检查</button>}</>
  } else {
    const counts = preview ? importPreviewCounts(preview.volumes) : null
    const receipt = job?.receipt
    body = <div className="space-y-4">
      <p className="text-xs text-[var(--text-secondary)]">选择文件 → 检查文件 → 解析内容 → 预览与调整 → 确认导入</p>
      {capabilities?.retainsEmptyVolumes && intent?.chapterCount === 0 && intent.volumeCount > 0 && <p className="rounded-lg bg-[var(--surface-muted)] p-3 text-sm">当前 {intent.volumeCount} 个空卷将原样保留，不归档、不删除。导入卷排在原有空卷之后{preview ? `，完成后共 ${intent.volumeCount + preview.volumes.length} 卷` : ''}。</p>}
      <section className="space-y-2 rounded-xl bg-[var(--surface-muted)] p-3 text-sm" aria-label="服务器格式能力">
        <p>一次一个文件，上限 {((capabilities?.sourceBytes ?? 0) / 1024 / 1024).toFixed(0)} MiB；至少一章非空原文正文。</p>
        {formats.map(extension => { const item = capabilities?.formats.find(format => format.extension.replace(/^\./, '').toLowerCase() === extension); return <p key={extension}>.{extension}：{item?.enabled ? '已开放' : '未开放'}{item?.reason ? ` · ${item.reason}` : ''}</p> })}
        {capabilities?.limitations.map(item => <p key={item}>{item}</p>)}
        <p>当前只运行确定性解析，不自动调用 AI。AI 结构分析、视觉识别及预算授权尚未开放；遇到疑难内容请人工核对，不会伪报零费用或自动改用付费模型。</p>
        <p>本次模型选择：{props.modelSelection.kind === 'custom' ? `自定义模型 ${props.modelSelection.customModelId}（不替换为其他模型）` : '内置基础模型 basic / low'}。当前解析不调用该模型。</p>
      </section>
      {!job && jobs.length > 0 && <section aria-label="可恢复任务" className="space-y-2"><h3 className="text-sm font-medium">当前作品的服务端任务</h3>{jobs.map(item => <button type="button" key={item.jobId} className={`${button} block w-full break-all text-left`} disabled={!!busy} onClick={() => resume(item)}>继续 / 查看任务 {item.jobId} · {importStatusLabel(item.status)}</button>)}</section>}
      {!job && props.agentAttachment && !file && <section className="rounded-xl border border-[var(--border-subtle)] p-3 text-sm"><p>Agent 交接的待导入附件（尚未导入）</p><p className="break-all">{props.agentAttachment.url}</p><p>仅在你点击上传后由服务器核验附件归属与任务 {props.agentAttachment.runId}。不访问外部网址、不读取本地路径、不自动提交。</p></section>}
      {(!job || terminalStatuses.has(job.status)) && !receipt && <div onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); selectFile(event.dataTransfer.files) }} className="rounded-xl border-2 border-dashed border-[var(--border-subtle)] p-5 text-center">
        <Upload className="mx-auto mb-2 h-6 w-6" /><p className="text-sm">拖放文件到此处，或使用系统文件选择器</p>
        <input ref={picker} type="file" aria-label="选择导入文件" accept=".zip,.txt,.md,.pdf,.doc,.docx" className="sr-only" disabled={!!busy} onChange={event => { if (event.target.files) selectFile(event.target.files); event.target.value = '' }} />
        <button type="button" className={`${button} mt-3`} disabled={!!busy} onClick={() => picker.current?.click()}>{file ? '重新选择文件' : '选择文件'}</button>
        {file && <p className="mt-2 break-all text-sm">{file.name} · {(file.size / 1024).toFixed(1)} KiB</p>}
      </div>}
      {job && <section aria-live="polite" className="space-y-2 text-sm"><p className="break-all">持久任务 {job.jobId} · {restored ? '已恢复导入前版本' : importStatusLabel(job.status)}</p><p>任务保留至 {job.expiresAt}；收起后可从此作品重新打开。</p>{job.errorCode && <><p role="alert">{importErrorMessage(job.errorCode)}</p><details><summary className="min-h-11 cursor-pointer py-3">技术详情（联系支持时提供）</summary><p className="break-all">错误码：{job.errorCode}</p></details></>}{job.sourceHash && <a className={`${button} inline-flex min-h-11 items-center`} href={importSourceUrl(novelId, job.jobId)} download aria-disabled={!!busy} onClick={event => { event.preventDefault(); if (!busy) void run('正在校验并下载原文件', async alive => { const original = await fetchImportOriginal(novelId, job.jobId); if (alive()) triggerBlobDownload(original.blob, original.filename) }) }}>下载原文件</a>}{uncertain && <p role="alert">提交结果尚需核对。请查询服务器状态，不要新建任务重复导入。</p>}</section>}
      {job && ['uploaded', 'failed', 'ready', 'needs_review', 'awaiting_confirmation'].includes(job.status) && <fieldset disabled={!!busy || !intent || uncertain} className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-3 text-sm"><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={manualEncoding} onChange={event => setManualEncoding(event.target.checked)} />手动指定文本编码（已知编码或解析提示时使用）</label>{manualEncoding ? <label className="block">文本编码<select className="ml-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3" value={encoding} onChange={event => setEncoding(event.target.value)}>{['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label> : <p className="text-xs text-[var(--text-secondary)]">默认使用服务器检测或任务已确认的编码；选择编码不会自动启动解析。</p>}{previewStatuses.has(job.status) && manualEncoding && <button type="button" className={button} disabled={dirty || !capabilities?.enabled} onClick={() => setStage('reparse')}>按所选编码重新解析</button>}{dirty && manualEncoding && <p className="text-xs">请先保存预览调整，再选择是否重建预览。</p>}</fieldset>}
      {preview && !receipt && <><p className="text-sm">{intent ? `当前作品：${intent.volumeCount} 卷 ${intent.chapterCount} 章` : '当前为任务只读查看；提交前请重新检查覆盖条件'} → 待导入：{preview.volumes.length} 卷 {counts?.chapters} 章。</p><ImportPreviewEditor preview={preview} disabled={!!busy || uncertain || !intent || !capabilities?.enabled} currentMetadata={props.currentMetadata ?? { title: novelTitle }} onChange={next => { setPreview(next); setDirty(true) }} /><p role="status" className="text-xs">{dirty ? '预览调整未保存；保存后才能提交。' : `预览版本 ${preview.manifestRevision} 已保存。`}</p></>}
      {receipt && <section className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4"><h3 className="font-semibold">{restored ? '恢复完成' : '导入完成'}</h3><p>{receipt.volumeCount} 卷 {receipt.chapterCount} 章 · {receipt.wordCount} 字。备份保留至：{receipt.restoreExpiresAt}</p>{!capabilities?.restoreEnabled && <p className="text-sm">恢复功能尚未开放，备份回执不代表现在可直接恢复。</p>}{!restored && props.onViewChapter && <button type="button" className={button} onClick={() => props.onViewChapter?.(receipt.firstChapterId)}>查看首章</button>}{error && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在刷新创作区', async alive => { await latest.current.onImported(receipt); if (alive()) delivered.current = receipt.jobId })}>刷新创作区</button>}<details><summary className="min-h-11 cursor-pointer py-3">查看导入报告</summary><p className="break-all text-sm">任务：{receipt.jobId}；备份：{receipt.backupId}；目标校验：{receipt.targetHash}。</p><p className="text-sm">此回执仅说明卷章提交结果，不代表 OCR 或逐页完整性验收通过。</p></details>{capabilities?.restoreEnabled && props.onRestored && !restored && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在检查恢复条件', async alive => { const approval = await client.restorePreview(novelId, receipt.jobId); if (alive()) { setRestoreApproval(approval); setStage('restore') } })}>恢复导入前版本</button>}</section>}
    </div>
    footer = <>{back}
      {!receipt && <button type="button" className={button} disabled={!!busy || dirty || uncertain || !capabilities?.enabled} onClick={recheck}>重新检查覆盖条件</button>}
      {job && !receipt && <button type="button" className={button} disabled={!!busy || dirty} onClick={refreshStatus}>查询任务状态</button>}
      {job && !terminalStatuses.has(job.status) && !uncertain && <button type="button" className={button} disabled={!!busy} onClick={() => setStage('cancel')}>取消任务</button>}
      {!job && <button type="button" className={primary} disabled={!!busy || (!file && !props.agentAttachment)} onClick={upload}>上传并检查文件</button>}
      {job?.status === 'uploaded' && <button type="button" className={primary} disabled={!!busy || !intent || !capabilities?.enabled} onClick={() => void run('正在解析原文内容（不调用 AI）', async alive => { const next = await client.analyze(novelId, job.jobId, manualEncoding ? encoding : undefined); await acceptStatus(next, alive) })}>开始确定性解析</button>}
      {job?.status === 'failed' && <button type="button" className={primary} disabled={!!busy || !intent || !capabilities?.enabled} onClick={() => void run('正在重试确定性解析（不调用 AI）', async alive => { const next = await client.retry(novelId, job.jobId, manualEncoding ? encoding : undefined); await acceptStatus(next, alive) })}>重试确定性解析</button>}
      {preview && !receipt && dirty && <button type="button" className={primary} disabled={!!busy || !canSaveImportPreview(preview)} onClick={() => void run('正在保存预览调整', savePreview)}>保存预览调整</button>}
      {preview && !receipt && <button type="button" className={primary} disabled={!!busy || dirty || uncertain || !armed || !intent || !capabilities?.enabled || !canSubmitImport(preview)} onClick={event => { if (event.detail <= 1) submit() }}>{intent && intent.chapterCount > 0 ? '确认覆盖并导入' : '导入'} {preview.volumes.length} 卷 {counts?.chapters} 章</button>}
    </>
  }
  return <ImportDialogShell title={title} description={`目标作品：《${novelTitle}》 · 原文导入，不生成缺失正文`} stage={stage} onClose={stage === 'leave' ? () => setStage('workspace') : close} footer={footer}>
    {busy && <p role="status" className="mb-3 flex items-center gap-2 text-sm"><LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />{busy}</p>}
    {error && <p role="alert" className="mb-3 break-words rounded-lg bg-rose-500/10 p-3 text-sm text-rose-600">{error}</p>}
    {body}
  </ImportDialogShell>
}
