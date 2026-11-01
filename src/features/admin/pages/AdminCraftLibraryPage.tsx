import { useAdminQueryState } from '../admin-query-state'
import { AdminRowActions } from './AdminPageControls'
import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenCheck, FileInput, ShieldCheck, Trash2 } from 'lucide-react'

import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import type {
  AdminCorpusSourceRow,
  CorpusSourceCreate,
} from '../../../../shared/contracts/index.js'
import {
  createAdminCorpusSource,
  importAdminCorpusDocument,
  listAdminCorpusSources,
  revokeAdminCorpusSource,
  verifyAdminCorpusSource,
} from '../api'
import { AdminCard, AdminPageHeader, AdminPanelState, AdminSectionTabs, StatusPill } from '../AdminLayout'
import { formatDateTime, useAdminSession } from '../admin-shared'

const inputClass = 'h-10 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm outline-none focus:border-[var(--text-primary)]'
const textareaClass = 'w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--text-primary)]'
const SOURCE_CLASS_LABELS = {
  internal: '平台自研', public_domain: '公版', permissive: '宽松许可', licensed: '商业授权',
  author_private: '作者私有', platform_opt_in: '平台主动授权',
} as const
const STATUS_LABELS = { pending: '待审批', approved: '已批准', rejected: '已拒绝', expired: '已过期', revoked: '已撤权' } as const

type SourceForm = Omit<CorpusSourceCreate, 'sourceUrl' | 'expiresAt'> & { sourceUrl: string; expiresAt: string }

const initialSourceForm: SourceForm = {
  name: '',
  sourceClass: 'public_domain',
  rightsHolder: '',
  sourceUrl: '',
  license: 'Public Domain',
  commercialUse: false,
  redistribution: false,
  modification: false,
  rawStorageAllowed: false,
  indexAllowed: false,
  expiresAt: '',
  evidence: '',
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback
}

function statusTone(status: AdminCorpusSourceRow['rightsStatus']): 'neutral' | 'success' | 'danger' | 'warning' {
  if (status === 'approved') return 'success'
  if (status === 'rejected' || status === 'revoked' || status === 'expired') return 'danger'
  return 'warning'
}

export default function AdminCraftLibraryPage() {
  const [status, setStatus] = useAdminQueryState('status', 'pending')
  const { admin } = useAdminSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [sourceForm, setSourceForm] = useState<SourceForm>(initialSourceForm)
  const [review, setReview] = useState<{ sourceId: string; decision: 'approved' | 'rejected' } | null>(null)
  const [auditNote, setAuditNote] = useState('')
  const [importSourceId, setImportSourceId] = useState<string | null>(null)
  const [documentForm, setDocumentForm] = useState({ title: '', authorName: '', content: '' })
  const [revokeSourceId, setRevokeSourceId] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const query = useQuery({ queryKey: ['admin', 'craft', 'sources'], queryFn: listAdminCorpusSources })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'craft', 'sources'] })

  const createMutation = useMutation({
    mutationFn: () => createAdminCorpusSource({
      ...sourceForm,
      sourceUrl: sourceForm.sourceUrl.trim() || undefined,
      expiresAt: sourceForm.expiresAt ? new Date(`${sourceForm.expiresAt}T23:59:59.999Z`).toISOString() : undefined,
    }),
    onSuccess: async () => {
      await refresh()
      setSourceForm(initialSourceForm)
      setCreateOpen(false)
      toast.success('来源已登记，必须单独审批后才能进入生产索引。')
    },
    onError: (error) => toast.error(errorMessage(error, '来源登记失败。')),
  })
  const reviewMutation = useMutation({
    mutationFn: () => verifyAdminCorpusSource(review!.sourceId, { decision: review!.decision, auditNote: auditNote.trim() }),
    onSuccess: async () => {
      await refresh()
      setReview(null)
      setAuditNote('')
      toast.success('权利审批结论已记录。')
    },
    onError: (error) => toast.error(errorMessage(error, '审批失败。')),
  })
  const importMutation = useMutation({
    mutationFn: () => importAdminCorpusDocument(importSourceId!, {
      title: documentForm.title.trim(),
      authorName: documentForm.authorName.trim() || undefined,
      content: documentForm.content.trim(),
      metadata: {},
    }),
    onSuccess: async (result) => {
      await refresh()
      setImportSourceId(null)
      setDocumentForm({ title: '', authorName: '', content: '' })
      toast.success(`文档已受控导入并拆分为 ${result.document.passageCount} 个检索段。`)
    },
    onError: (error) => toast.error(errorMessage(error, '文档导入失败。')),
  })
  const revokeMutation = useMutation({
    mutationFn: () => revokeAdminCorpusSource(revokeSourceId!, revokeReason.trim()),
    onSuccess: async () => {
      await refresh()
      setRevokeSourceId(null)
      setRevokeReason('')
      toast.success('来源已撤权，原文、画像和派生索引已清理并生成删除回执。')
    },
    onError: (error) => toast.error(errorMessage(error, '撤权失败。')),
  })

  const allSources = query.data?.sources ?? []
  const sources = allSources.filter(source => status === 'all' || source.rightsStatus === status)
  const state = query.isLoading ? 'loading' : query.isError ? 'error' : sources.length === 0 ? 'empty' : 'ready'

  function submitSource(event: FormEvent) {
    event.preventDefault()
    createMutation.mutate()
  }

  return <div>
    <AdminPageHeader
      title="合法文笔库"
      description="生产语料先登记权利、再独立审批、最后受控导入。Agent 仅召回抽象技法卡与统计画像，不返回第三方原文。"
      extra={
        <div className="flex items-center gap-2">
          {admin?.isSuperAdmin ? <Button variant="primary" onClick={() => setCreateOpen((open) => !open)}>{createOpen ? '收起登记' : '登记来源'}</Button> : null}
        </div>
      }
    />

    <AdminSectionTabs tabs={[{id:'pending',label:'待审批'},{id:'approved',label:'已批准'},{id:'rejected',label:'已拒绝'},{id:'revoked',label:'已撤权'},{id:'expired',label:'已过期'},{id:'all',label:'全部'}]} value={status} onChange={setStatus} label="来源审核状态" />
    <details className="mb-4"><summary className="min-h-11 cursor-pointer py-3 text-sm">授权、导入与撤权规则</summary><AdminCard>
      <div className="grid gap-3 text-sm md:grid-cols-3">
        <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" /><div><p className="font-medium">权利先行</p><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">商业使用、原文存储、索引许可分别记录；缺少任一必要授权即硬阻断。</p></div></div>
        <div className="flex gap-3"><BookOpenCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-500" /><div><p className="font-medium">只学技法</p><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">运行时只提供结构化技法和统计特征，不提供可逆引用，也不克隆在世作者。</p></div></div>
        <div className="flex gap-3"><Trash2 className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" /><div><p className="font-medium">可撤回删除</p><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">撤权会停用来源、清理原文和派生数据，并保留不可逆哈希回执。</p></div></div>
      </div>
    </AdminCard></details>

    {createOpen && admin?.isSuperAdmin ? <AdminCard className="mb-4">
      <form onSubmit={submitSource} className="space-y-4">
        <div><h2 className="font-medium">登记新来源</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">登记不会自动批准，也不会写入索引。</p></div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs">来源名称<input required className={`${inputClass} mt-1`} value={sourceForm.name} onChange={(event) => setSourceForm((form) => ({ ...form, name: event.target.value }))} /></label>
          <label className="text-xs">来源类型<select className={`${inputClass} mt-1`} value={sourceForm.sourceClass} onChange={(event) => setSourceForm((form) => ({ ...form, sourceClass: event.target.value as SourceForm['sourceClass'] }))}><option value="public_domain">公版</option><option value="permissive">宽松许可</option><option value="licensed">商业授权</option><option value="platform_opt_in">平台主动授权</option><option value="internal">平台自研</option></select></label>
          <label className="text-xs">权利人<input required className={`${inputClass} mt-1`} value={sourceForm.rightsHolder} onChange={(event) => setSourceForm((form) => ({ ...form, rightsHolder: event.target.value }))} /></label>
          <label className="text-xs">许可名称<input required className={`${inputClass} mt-1`} value={sourceForm.license} onChange={(event) => setSourceForm((form) => ({ ...form, license: event.target.value }))} /></label>
          <label className="text-xs">证据链接（可选）<input type="url" className={`${inputClass} mt-1`} value={sourceForm.sourceUrl} onChange={(event) => setSourceForm((form) => ({ ...form, sourceUrl: event.target.value }))} /></label>
          <label className="text-xs">授权到期日（留空为长期）<input type="date" className={`${inputClass} mt-1`} value={sourceForm.expiresAt} onChange={(event) => setSourceForm((form) => ({ ...form, expiresAt: event.target.value }))} /></label>
        </div>
        <fieldset className="grid gap-2 rounded-lg border border-[var(--border-default)] p-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
          {([
            ['commercialUse', '允许商业使用'], ['redistribution', '允许再分发'], ['modification', '允许改编'],
            ['rawStorageAllowed', '允许原文存储'], ['indexAllowed', '允许生产索引'],
          ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={sourceForm[key]} onChange={(event) => setSourceForm((form) => ({ ...form, [key]: event.target.checked }))} />{label}</label>)}
        </fieldset>
        <label className="block text-xs">权利证据与范围说明<textarea required rows={4} className={`${textareaClass} mt-1`} value={sourceForm.evidence} onChange={(event) => setSourceForm((form) => ({ ...form, evidence: event.target.value }))} /></label>
        <Button type="submit" variant="primary" disabled={createMutation.isPending}>{createMutation.isPending ? '登记中…' : '仅登记，等待独立审批'}</Button>
      </form>
    </AdminCard> : null}

    <AdminPanelState state={state}>
      <div className="space-y-3">
        {sources.map((source) => {
          const canImport = source.rightsStatus === 'approved' && source.commercialUse && source.rawStorageAllowed && source.indexAllowed
          return <AdminCard key={source.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{source.name}</h2><StatusPill tone={statusTone(source.rightsStatus)}>{STATUS_LABELS[source.rightsStatus]}</StatusPill><StatusPill>{SOURCE_CLASS_LABELS[source.sourceClass]}</StatusPill></div><p className="mt-1 text-xs text-[var(--text-secondary)]">{source.rightsHolder} · {source.license}</p></div>
              <div className="text-right text-xs text-[var(--text-secondary)]"><p>{source._count.documents} 文档 · {source._count.techniqueCards} 技法卡 · {source._count.styleProfiles} 画像</p><p className="mt-1">审批：{formatDateTime(source.auditedAt)}</p></div>
            </div>
            <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm">授权链与审核详情</summary>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)]">
              <span>商业使用 {source.commercialUse ? '✓' : '×'}</span><span>原文存储 {source.rawStorageAllowed ? '✓' : '×'}</span><span>生产索引 {source.indexAllowed ? '✓' : '×'}</span><span>再分发 {source.redistribution ? '✓' : '×'}</span><span>改编 {source.modification ? '✓' : '×'}</span>
            </div>
            <p className="mt-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">权利证据：{source.rightsEvidence}</p>
            {source.auditNote ? <p className="mt-3 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">审计说明：{source.auditNote}</p> : null}
            {source.sourceUrl ? <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs underline underline-offset-4">查看权利证据</a> : null}
            </details>
            {admin?.isSuperAdmin && source.id !== 'builtin.agent3.craft.v1' ? <AdminRowActions label="来源操作"><div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-3">
              {source.rightsStatus !== 'revoked' ? <><Button size="sm" onClick={() => { setReview({ sourceId: source.id, decision: 'approved' }); setAuditNote('') }}>批准</Button><Button size="sm" onClick={() => { setReview({ sourceId: source.id, decision: 'rejected' }); setAuditNote('') }}>拒绝</Button></> : null}
              {canImport ? <Button size="sm" onClick={() => setImportSourceId(source.id)}><FileInput className="h-4 w-4" />受控导入文档</Button> : null}
              {source.rightsStatus !== 'revoked' ? <Button size="sm" className="text-[var(--color-error)]" onClick={() => { setRevokeSourceId(source.id); setRevokeReason('') }}>撤权并清理</Button> : null}
            </div></AdminRowActions> : null}
            {review?.sourceId === source.id ? <div className="mt-3 rounded-lg border border-[var(--border-default)] p-3"><p className="text-sm font-medium">{review.decision === 'approved' ? '批准来源' : '拒绝来源'}</p><textarea autoFocus rows={3} className={`${textareaClass} mt-2`} placeholder="填写可审计的审批依据" value={auditNote} onChange={(event) => setAuditNote(event.target.value)} /><div className="mt-2 flex gap-2"><Button size="sm" variant="primary" disabled={!auditNote.trim() || reviewMutation.isPending} onClick={() => reviewMutation.mutate()}>确认</Button><Button size="sm" onClick={() => setReview(null)}>取消</Button></div></div> : null}
            {importSourceId === source.id ? <div className="mt-3 rounded-lg border border-[var(--border-default)] p-3"><p className="text-sm font-medium">受控导入合法原文</p><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">仅在来源已批准且明确允许商业使用、原文存储和索引时可执行。正文不会直接提供给 Agent。</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><input className={inputClass} placeholder="文档标题" value={documentForm.title} onChange={(event) => setDocumentForm((form) => ({ ...form, title: event.target.value }))} /><input className={inputClass} placeholder="作者/权利人署名（可选）" value={documentForm.authorName} onChange={(event) => setDocumentForm((form) => ({ ...form, authorName: event.target.value }))} /></div><textarea rows={8} className={`${textareaClass} mt-3`} placeholder="粘贴已确认有权存储和索引的正文，至少 200 字" value={documentForm.content} onChange={(event) => setDocumentForm((form) => ({ ...form, content: event.target.value }))} /><div className="mt-2 flex gap-2"><Button size="sm" variant="primary" disabled={!documentForm.title.trim() || documentForm.content.trim().length < 200 || importMutation.isPending} onClick={() => importMutation.mutate()}>确认导入</Button><Button size="sm" onClick={() => setImportSourceId(null)}>取消</Button></div></div> : null}
            {revokeSourceId === source.id ? <div className="mt-3 rounded-lg border border-[var(--color-error)]/40 p-3"><p className="text-sm font-medium text-[var(--color-error)]">撤权将删除原文、画像和派生索引</p><textarea autoFocus rows={3} className={`${textareaClass} mt-2`} placeholder="填写撤权原因" value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} /><div className="mt-2 flex gap-2"><Button size="sm" variant="primary" className="bg-[var(--color-error)] text-white hover:bg-[var(--color-error)]" disabled={!revokeReason.trim() || revokeMutation.isPending} onClick={() => revokeMutation.mutate()}>确认撤权</Button><Button size="sm" onClick={() => setRevokeSourceId(null)}>取消</Button></div></div> : null}
          </AdminCard>
        })}
      </div>
    </AdminPanelState>
  </div>
}
