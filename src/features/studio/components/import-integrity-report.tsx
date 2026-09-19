import { useEffect, useMemo, useState } from 'react'
import type { NovelImportArtifactDescriptor, NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import type { ImportReviewEdit } from '../import-preview-api'
import { ImportDialogShell } from './import-dialog-shell'
import { ImportArtifactViewer } from './import-artifact-viewer'
import { canHumanReviewImportItem } from '../lib/import-auto-review'

const button = 'min-h-11 min-w-11 rounded-lg border border-[var(--border-subtle)] px-3 text-sm disabled:opacity-40'
const labels = { native: '原生文字', ocr: 'OCR 识别', needs_review: '待人工核对', failed: '处理失败', verified_blank: '确认空白', excluded: '已排除' }
export function ImportIntegrityReport({ novelId, jobId, report, disabled, onReview }: {
  novelId: string; jobId: string; report: NovelImportReportDto; disabled: boolean; onReview: (edit: ImportReviewEdit) => Promise<void>
}) {
  const [page, setPage] = useState(0), [kind, setKind] = useState(report.decisions.some(item => item.action === 'exclude') ? 'excluded' : 'all')
  const [issuePage, setIssuePage] = useState(0)
  const [selected, setSelected] = useState<ImportReviewEdit['decisions']>([])
  const [confirm, setConfirm] = useState(false), [armed, setArmed] = useState(false)
  const [image, setImage] = useState<NovelImportArtifactDescriptor | null>(null)
  useEffect(() => { setArmed(false); const timer = setTimeout(() => setArmed(true), 450); return () => clearTimeout(timer) }, [confirm])
  const excludedIds = useMemo(() => new Set(report.decisions.filter(item => item.action === 'exclude').map(item => item.itemId)), [report.decisions])
  const items = useMemo(() => report.items.filter(item => kind === 'all' || (kind === 'excluded' ? excludedIds.has(item.id) || item.status === 'excluded' : item.kind === kind)), [kind, report.items, excludedIds])
  const pages = useMemo(() => report.items.filter(item => item.kind === 'page'), [report.items])
  const fileCount = useMemo(() => report.items.filter(item => item.kind === 'file').length, [report.items])
  const pageCounts = useMemo(() => pages.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts }, {} as Record<string, number>), [pages])
  const issuesByItem = useMemo(() => {
    const index = new Map<string, NovelImportReportDto['issues']>()
    for (const issue of report.issues) for (const id of issue.itemIds) { const list = index.get(id) ?? []; list.push(issue); index.set(id, list) }
    return index
  }, [report.issues])
  const change = (itemId: string, field: 'action' | 'reason', value: string) => setSelected(current => {
    if (field === 'action' && !value) return current.filter(item => item.itemId !== itemId)
    const old = current.find(item => item.itemId === itemId) ?? { itemId, action: 'review' as const, reason: '' }
    return [...current.filter(item => item.itemId !== itemId), { ...old, [field]: value } as ImportReviewEdit['decisions'][number]]
  })
  return <section className="min-w-0 space-y-3 rounded-xl border border-[var(--border-subtle)] p-3" aria-label="完整性报告">
    <h3 className="font-semibold">来源完整性报告</h3>
    <p className="text-sm">{report.partialImport || excludedIds.size ? `部分导入：已记录 ${excludedIds.size} 项来源排除（含自动排除）。请核对下方“已排除来源”列表及理由后再确认导入；不代表整份原稿完整导入。` : '未标记部分导入；仍须处理所有阻断项。'}处理覆盖率不等于 OCR 文字准确率。</p>
    <p className="text-sm">共 {fileCount} 个文件成员，{pages.length} 页。{Object.entries(pageCounts).map(([status, count]) => `${labels[status as keyof typeof labels] ?? '未知状态'} ${count} 页`).join('；')}</p>
    <p className="text-xs">页状态互斥计数；图像/区域单独列出。不含页码的文件不伪造页数。重复疑点、失败成员和未处理页不会静默隐藏。</p>
    {report.issues.slice(issuePage * 30, issuePage * 30 + 30).map(issue => <p key={issue.id} className="break-words text-sm">{issue.resolved ? '已处理' : issue.blocking ? '阻断' : '注意'}：{issue.message} <span className="text-xs">（{issue.code}）</span></p>)}
    {report.issues.length > 30 && <div className="flex items-center gap-2"><button type="button" className={button} disabled={!issuePage} onClick={() => setIssuePage(issuePage - 1)}>上一页问题</button><span>问题 {issuePage + 1}/{Math.ceil(report.issues.length / 30)}</span><button type="button" className={button} disabled={(issuePage + 1) * 30 >= report.issues.length} onClick={() => setIssuePage(issuePage + 1)}>下一页问题</button></div>}
    <label className="block text-sm">筛选来源类型<select className="ml-2 min-h-11 rounded border bg-[var(--surface-default)] px-2" value={kind} onChange={event => { setKind(event.target.value); setPage(0) }}>{[['all', '全部'], ['excluded', '已排除来源'], ['file', '文件成员'], ['page', '页面'], ['block', '正文块'], ['region', '区域'], ['image', '图片']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <div className="max-h-[60dvh] space-y-3 overflow-y-auto">{items.slice(page * 30, page * 30 + 30).map(item => {
      const decision = selected.find(entry => entry.itemId === item.id)
      const saved = report.decisions.find(entry => entry.itemId === item.id)
      const canReview = canHumanReviewImportItem(item, issuesByItem.get(item.id) ?? [])
      const artifact = report.artifacts.find(entry => entry.id === item.artifactId)
      return <article key={item.id} className="min-w-0 space-y-2 rounded-lg bg-[var(--surface-muted)] p-3 text-sm">
        <p className="break-all">{item.source}{item.page ? ` · 第 ${item.page} 页` : ''} · {labels[item.status] ?? '未知状态，需核对'}</p>
        <p className="break-all text-xs">来源编号：{item.id}{item.characters !== undefined ? ` · ${item.characters} 字符` : ''}{item.duplicateOf ? ` · 疑似重复来源 ${item.duplicateOf}` : ''}</p>
        {artifact && <button type="button" className={button} onClick={() => setImage(artifact)}>查看来源图片</button>}
        {saved && <p className="whitespace-pre-wrap break-words text-xs">已记录：{saved.action === 'exclude' ? '排除' : '人工核对'} · {saved.reason} · {saved.reviewedAt}</p>}
        {(item.excludable || canReview) && !saved && <fieldset disabled={disabled} className="space-y-2"><label>处理「{item.id}」<select className="ml-2 min-h-11 max-w-full rounded border bg-[var(--surface-default)] px-2" value={decision?.action ?? ''} onChange={event => change(item.id, 'action', event.target.value)}><option value="">保持原状</option>{canReview && <option value="review">我已对照原文核对</option>}{item.excludable && <option value="exclude">明确排除此来源</option>}</select></label>{decision && <label className="block">理由「{item.id}」<textarea className="mt-1 min-h-20 w-full rounded border bg-[var(--surface-default)] p-2" maxLength={1000} value={decision.reason} onChange={event => change(item.id, 'reason', event.target.value)} /></label>}</fieldset>}
      </article>
    })}</div>
    {items.length > 30 && <div className="flex items-center gap-2"><button type="button" className={button} disabled={!page} onClick={() => setPage(page - 1)}>上一页来源</button><span>{page + 1}/{Math.ceil(items.length / 30)}</span><button type="button" className={button} disabled={(page + 1) * 30 >= items.length} onClick={() => setPage(page + 1)}>下一页来源</button></div>}
    {selected.length > 0 && <button type="button" className={button} disabled={disabled || selected.some(item => !item.reason.trim())} onClick={() => setConfirm(true)}>确认 {selected.length} 项来源处理</button>}
    {confirm && <ImportDialogShell title="确认来源核对与排除？" description="本操作会更新服务端预览版本及完整性结果，不会提交作品。" stage="source-review" onClose={() => setConfirm(false)} footer={<><button data-import-safe-focus type="button" className={button} onClick={() => setConfirm(false)}>返回核对</button><button type="button" className={button} disabled={disabled || !armed || !selected.length || selected.some(item => !item.reason.trim())} onClick={event => {
      if (event.detail > 1 || !armed) return
      setConfirm(false)
      void onReview({ expectedManifestRevision: report.manifestRevision, manifestHash: report.manifestHash, reportHash: report.reportHash, decisions: selected }).catch(() => { /* Parent keeps the actionable service error; decisions remain for correction. */ })
    }}>记录决定并更新预览</button></>}><div className="space-y-3 text-sm"><p>排除 {selected.filter(item => item.action === 'exclude').length} 项，人工核对 {selected.filter(item => item.action === 'review').length} 项。排除的正文不会导入，原文件仍保留；结果将明确标记为部分导入。当前不提供撤销决定，需重新解析原文件重建预览。</p>{selected.map(item => <p key={item.itemId} className="break-words">{item.itemId}：{item.action === 'exclude' ? '排除' : '人工核对'} · {item.reason}</p>)}</div></ImportDialogShell>}
    {image && <ImportArtifactViewer novelId={novelId} jobId={jobId} artifact={image} onClose={() => setImage(null)} />}
  </section>
}
