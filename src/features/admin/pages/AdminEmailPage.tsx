import { useId, useState, type FormEvent } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { requestJson } from '@/app/api-client'
import { Mail, Layers, History, ChevronRight, ChevronDown, ArrowLeft } from 'lucide-react'
import { type EmailLibraryEntry } from '../../../../shared/contracts/email-library'
import { TemplateLibrary, MailProof } from './EmailTemplateEditor'
import { returnMail, invitation, defaultReturn, resolvedDate } from './email-composer'
import { CampaignSettings } from './EmailCampaignSettings'
import './admin-email.css'
import Button from '@/components/ui/Button'
import {
  ADMIN_EMAIL_BATCH_LIMIT, type AdminEmailBatch, type AdminEmailBatchDetail, type AdminEmailCandidate,
  type AdminEmailExclusion, type AdminEmailInfo, type AdminEmailMode, type AdminEmailPreviewCandidates, type AdminEmailRecipientState, type AdminEmailSelection,
} from '../../../../shared/contracts/admin-email'
import { AdminCard, AdminPageHeader } from '../AdminLayout'
import { formatDateTime, useAdminSession } from '../admin-shared'

const endpoint = '/api/admin/email'
const field = 'w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2 text-sm'
const labels: Record<AdminEmailRecipientState, string> = {
  preview: '预览', queued: '排队中', sending: '发送中', accepted: 'SES 已受理', deferred: '延迟投递',
  delivered: '已送达', rejected: '拒绝', bounced: '退信', unknown: '待核对', skipped: '已跳过', cancelled: '已停止',
}
const exclusions: Record<AdminEmailExclusion, string> = {
  missing_user: '账号不存在', banned: '已封禁', unverified_email: '无已验证邮箱', no_permission: '缺少订阅许可',
  unsubscribed: '已退订', hard_bounce: '曾硬退信', complained: '曾投诉', duplicate_email: '重复邮箱',
  outside_send_scope: '不在本地试发地址范围',
}
const reasons: Record<string, string> = {
  ...exclusions, provider_rejected: 'SES 拒绝请求', provider_unknown: 'SES 返回结果未知',
  provider_dropped: 'SES 丢弃该邮件', provider_bounced: '收件服务商退信',
  email_changed: '已更换邮箱', template_changed: '模板已变化', worker_interrupted: '发送过程中断',
  status_window_expired: '状态查询窗口已过', admin_cancelled: '管理员停止排队',
}
const blockers = { empty: '没有合格收件人。', batch_limit: '合格人数超过单批上限，请缩小范围或改用抽样。', sample_size: '合格人数少于抽样人数，请修改人数。' }
const pendingStates = ['queued', 'sending', 'accepted', 'deferred'] as const
const post = (body: object) => ({ method: 'POST', body: JSON.stringify(body) })

type Filters = Extract<AdminEmailSelection, { mode: 'filter' }>['filters']
type CandidatePage = { hasNextPage: boolean; items: AdminEmailCandidate[] }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作暂时不可用。'
}

function PreviewCandidateList({ batchId, batchKey }: { batchId: string; batchKey: QueryKey }) {
  const [page, setPage] = useState(1)
  const query = useQuery({
    queryKey: [...batchKey, 'candidates', page],
    queryFn: () => requestJson<AdminEmailPreviewCandidates>(`${endpoint}/batches/${batchId}/candidates?page=${page}`),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const data = query.data
  const canGoBack = page > 1 && !query.isFetching
  const canGoNext = !!data?.hasNextPage && !query.isFetching
  return <>
    {query.isError && <div role="alert" className="flex flex-wrap items-center gap-3">
      <span>候选名单读取失败。{errorMessage(query.error)}</span>
      <button type="button" className="mail-secondary" onClick={() => void query.refetch()}>重试</button>
    </div>}
    {query.isPending && <p role="status">正在读取候选名单…</p>}
    {data && <>
      {data.reconstructed && <p className="mb-2 text-xs text-[var(--text-secondary)]">这份旧预览按原筛选条件和当前账号资料重建。候选人、昵称、人数和排除原因可能已变化，下方可查看原预览选中名单。</p>}
      {data.items.length ? <ul aria-label="候选名单" aria-busy={query.isFetching} className="divide-y divide-[var(--border-subtle)]">
        {data.items.map((candidate, index) => <li key={`${candidate.id}-${index}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm">
          <span className="min-w-0"><span className="break-all font-medium">{candidate.nickname}</span><span className="ml-2 inline-block break-all text-[var(--text-secondary)]">{candidate.maskedEmail ?? '无邮箱记录'}</span></span>
          <span className={candidate.selected ? 'font-medium text-[var(--mail-accent)]' : 'text-[var(--text-secondary)]'}>
            {candidate.exclusion ? `${candidate.selected && data.reconstructed ? '原已选中 · 当前' : '已排除 · '}${exclusions[candidate.exclusion]}`
              : candidate.selected ? '已选中' : '合格，未选中'}
          </span>
        </li>)}
      </ul> : <p className="py-2">没有候选用户。</p>}
    </>}
    {(page > 1 || data?.hasNextPage) && <nav aria-label="候选名单分页" className="mail-actions mail-candidate-pager">
      <button type="button" className="mail-secondary" aria-disabled={!canGoBack} onClick={() => { if (canGoBack) setPage(page - 1) }}>上一页</button>
      <span aria-live="polite" className="text-sm text-[var(--text-secondary)]">第 {data?.page ?? page} 页</span>
      <button type="button" className="mail-secondary" aria-disabled={!canGoNext} onClick={() => { if (canGoNext) setPage(page + 1) }}>下一页</button>
    </nav>}
  </>
}

function EmailBatchDetails({ batch, batchKey }: { batch: AdminEmailBatchDetail; batchKey: QueryKey }) {
  const [showCandidates, setShowCandidates] = useState(false)
  const panelId = useId()
  const recipientList = batch.recipients.length > 0 ? <ul className="divide-y divide-[var(--border-subtle)]" aria-label="收件名单">
      {batch.recipients.map(recipient => <li key={recipient.userId} className="py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="min-w-0 break-all">{recipient.nickname} · {recipient.maskedEmail}</span>
          <span>{labels[recipient.state]}{recipient.reason ? ` · ${reasons[recipient.reason] ?? '见处理状态'}` : ''}</span>
        </div>
        {(recipient.providerMessageId || recipient.providerRequestId || recipient.attemptedAt) && <p className="mt-1 break-all text-xs text-[var(--text-secondary)]">
          {[recipient.attemptedAt ? formatDateTime(recipient.attemptedAt) : null,
            recipient.providerMessageId, recipient.providerRequestId].filter(Boolean).join(' · ')}
        </p>}
      </li>)}
    </ul> : null
  return <>
    {batch.state === 'preview' ? <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <button type="button" aria-expanded={showCandidates} aria-controls={panelId} onClick={() => setShowCandidates(!showCandidates)}
          className="mail-candidate-toggle">候选 {batch.candidateCount} 人 <ChevronDown size={14} aria-hidden="true" className={showCandidates ? 'rotate-180' : undefined}/></button>
        <span>合格 {batch.eligibleCount} 人</span><span>选中 {batch.recipientCount} 人</span>
      </div>
      <div id={panelId} hidden={!showCandidates} className="border-y border-[var(--border-subtle)] py-2 text-sm">
        {showCandidates && <PreviewCandidateList batchId={batch.id} batchKey={batchKey}/>}
      </div>
    </> : <p className="text-sm">{batch.state === 'cancelled' ? '排队已停止' : '已确认'} · {batch.recipientCount} 人</p>}
    {batch.state === 'preview' && <>
      <dl className="space-y-1 text-sm">
        <div><dt className="inline font-medium">发件人 </dt><dd className="inline break-all">{batch.template.from}</dd></div>
        <div><dt className="inline font-medium">回复地址 </dt><dd className="inline break-all">{batch.template.replyTo}</dd></div>
        <div><dt className="inline font-medium">主题 </dt><dd className="inline">{batch.template.subject}</dd></div>
      </dl>
      {batch.customTemplate ? <details><summary>查看完整邮件</summary><MailProof template={batch.customTemplate} values={batch.customTemplate.values}/></details>
        : batch.campaign && batch.mode === 'tencent' ? <details><summary>查看已审核邮件</summary><MailProof template={{
          ...returnMail, subject: batch.template.subject, body: batch.template.sampleBody,
        }} values={{}}/></details>
        : batch.campaign ? <details><summary>查看完整邮件</summary><MailProof template={returnMail} values={{
          max_credits:String(batch.campaign.maxCredits),workspace_path:'return-reward',
          expires_at:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(
            batch.campaign.deadline.mode==='fixed'?new Date(batch.campaign.deadline.at):new Date(Date.parse(batch.createdAt)+batch.campaign.deadline.days*86400000))+'（北京时间）'
        }}/></details> : <p className="rounded-md bg-[var(--surface-muted)] p-3 text-sm whitespace-pre-wrap break-words">{batch.template.sampleBody}</p>}
      {!!Object.keys(batch.exclusions).length && <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {Object.entries(batch.exclusions).map(([reason, count]) => <li key={reason}>{reasons[reason]} {count}</li>)}
      </ul>}
      {batch.blocker && <p role="status" className="text-sm">{blockers[batch.blocker]}</p>}
    </>}
    {batch.state !== 'preview' && <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="各状态人数">
      {Object.entries(batch.progress).map(([state, count]) => <li key={state}>{labels[state as AdminEmailRecipientState]} {count}</li>)}
    </ul>}
    {batch.state === 'preview' && showCandidates && recipientList
      ? <details><summary>原预览选中名单（{batch.recipientCount} 人）</summary>{recipientList}</details>
      : recipientList}
  </>
}

export default function AdminEmailPage() {
  const { admin } = useAdminSession()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [view,setView] = useState<'content'|'audience'|'review'|'library'|'history'>(()=>params.get('batch')?'review':'content')
  const [templateId,setTemplateId] = useState(returnMail.id)
  const [reward,setReward] = useState(defaultReturn)
  const [variables,setVariables] = useState<Record<string,string>>({})
  const [addresses,setAddresses] = useState('')
  const [problem,setProblem] = useState('')
  const [segmentName,setSegmentName] = useState('')
  const [mode, setMode] = useState<AdminEmailSelection['mode']>('manual')
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Record<string, AdminEmailCandidate>>({})
  const [filters, setFilters] = useState<Filters>({})
  const [sampleSize, setSampleSize] = useState(10)
  const [weighting, setWeighting] = useState<'equal' | 'recent_activity'>('equal')
  const [formChanged, setFormChanged] = useState(false)
  const batchId = params.get('batch')
  const adminScope = ['admin', 'directed-email', admin?.id] as const

  function setBatchId(id: string | null) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      if (id) next.set('batch', id)
      else next.delete('batch')
      return next
    }, { replace: true })
  }

  const settings = useQuery({
    queryKey: [...adminScope, 'settings'],
    queryFn: () => requestJson<AdminEmailInfo>(`${endpoint}/settings`),
    enabled: !!admin?.isSuperAdmin, retry: false,
  })
  const ready = !!admin?.isSuperAdmin && settings.isSuccess
  const deliveryMode = settings.data?.mode
  const library = useQuery({queryKey:[...adminScope,'templates'],enabled:ready,retry:false,queryFn:()=>requestJson<{items:EmailLibraryEntry[]}>(endpoint+'/templates')})
  const templates=[returnMail, invitation, ...(library.data?.items ?? [])]
  const activeTemplate=templates.find(t=>t.id===templateId) ?? returnMail
  type Segment = {id:string;name:string;filters:Filters}
  const segments=useQuery({queryKey:[...adminScope,'segments'],enabled:ready,retry:false,queryFn:()=>requestJson<{items:Segment[]}>(endpoint+'/segments')})
  const saveSegment=useMutation({mutationFn:()=>requestJson(endpoint+'/segments',post({name:segmentName.trim(),filters})),onSuccess:()=>{setSegmentName('');void segments.refetch()}})
  const campaign = templateId === returnMail.id ? {
    maxCredits:Number(reward.credits),deadline:reward.kind==='relative'?{mode:'relative' as const,days:Number(reward.days)}:{mode:'fixed' as const,at:Number.isFinite(resolvedDate(reward,new Date()).getTime())?resolvedDate(reward,new Date()).toISOString():''},workspacePath:reward.path,
  }:undefined
  const customTemplate = templateId !== 0 && templateId!==returnMail.id ? {...activeTemplate,values:variables}:undefined
  const purpose = campaign ? 'creator_return' : customTemplate ? 'custom_notification' : 'tester_invitation'
  const cacheScope = [...adminScope, deliveryMode] as const
  const batchKey = (id: string | null) => [...cacheScope, 'batch', id] as const
  const listKey = [...cacheScope, 'batches'] as const
  const candidates = useQuery({
    queryKey: [...cacheScope, 'candidates', purpose, search, page],
    queryFn: () => requestJson<CandidatePage>(`${endpoint}/candidates?${new URLSearchParams({ search, page: String(page), purpose })}`),
    enabled: ready && mode === 'manual',
  })
  const history = useQuery({
    queryKey: listKey, queryFn: () => requestJson<{ items: AdminEmailBatch[] }>(`${endpoint}/batches`), enabled: ready,
  })
  const batch = useQuery({
    queryKey: batchKey(batchId),
    queryFn: () => requestJson<AdminEmailBatchDetail>(`${endpoint}/batches/${encodeURIComponent(batchId ?? '')}`),
    enabled: ready && !!batchId,
    refetchInterval: query => pendingStates.some(state => !!query.state.data?.progress[state]) ? 2_000 : false,
  })

  function showBatch(data: AdminEmailBatchDetail) {
    client.setQueryData(batchKey(data.id), data)
    setFormChanged(false)
    setView('review')
    setBatchId(data.id)
  }

  const preview = useMutation({
    mutationFn: (input: { mode: AdminEmailMode; selection: AdminEmailSelection; replaces?: string; campaign?: typeof campaign; customTemplate?: typeof customTemplate }) =>
      requestJson<AdminEmailBatchDetail>(`${endpoint}/previews`, post(input)),
    onSuccess: showBatch,
  })
  const confirm = useMutation({
    mutationFn: (snapshot: AdminEmailBatchDetail) => requestJson<AdminEmailBatchDetail>(
      `${endpoint}/batches/${snapshot.id}/confirm`, post({ mode: snapshot.mode, previewHash: snapshot.previewHash }),
    ),
    onSuccess(data) {
      showBatch(data)
      void client.invalidateQueries({ queryKey: listKey })
    },
  })
  const cancel = useMutation({
    mutationFn: (id: string) => requestJson<AdminEmailBatchDetail>(`${endpoint}/batches/${id}/cancel`, post({})),
    onSuccess(data) {
      showBatch(data)
      void client.invalidateQueries({ queryKey: listKey })
    },
  })

  const busy = preview.isPending || confirm.isPending || cancel.isPending
  const snapshot = batch.data
  const isPreview = snapshot?.state === 'preview'
  const canReplace = isPreview && !snapshot.replacedById
  const previewExpired = isPreview && Date.parse(snapshot.expiresAt) <= Date.now()
  const selectedCount = Object.keys(selected).length

  function clearPreview() {
    setProblem('')
    if (isPreview) setFormChanged(true)
    preview.reset()
    confirm.reset()
  }

  function updateFilter(update: Partial<Filters>) {
    clearPreview()
    setFilters(previous => ({ ...previous, ...update }))
  }

  function toggleCandidate(candidate: AdminEmailCandidate) {
    clearPreview()
    setSelected(previous => {
      const next = { ...previous }
      if (next[candidate.id]) delete next[candidate.id]
      else next[candidate.id] = candidate
      return next
    })
  }

  function searchCandidates() {
    setSearch(draftSearch.trim())
    setPage(1)
  }

  function generatePreview(event: FormEvent) {
    event.preventDefault()
    if (!deliveryMode) return
    confirm.reset()
    const emails = [...new Set(addresses.toLowerCase().split(/[\s,;，；]+/u).filter(Boolean))]
    if (mode==='emails' && (!emails.length || emails.length>100 || emails.some(address=>!/^\S+@[^\s@]+\.[^\s@]+$/.test(address)))) {
      setProblem('请填写有效的邮箱地址，每批最多 100 个。'); return
    }
    const selection = mode==='emails' ? {mode,emails} : mode === 'manual' ? { mode, userIds: Object.keys(selected) }
      : mode === 'filter' ? { mode, filters } : { mode, filters, size: sampleSize, weighting }
    preview.mutate({ mode: deliveryMode, selection, campaign, customTemplate, replaces: canReplace ? snapshot.id : undefined })
  }

  function chooseTemplate(item:EmailLibraryEntry) {
    clearPreview();setBatchId(null);setSelected({});setVariables({});setTemplateId(item.id);setView('content')
  }
  return <div className="admin-email">
    <header className="mail-page-head"><div><AdminPageHeader title="定向邮件"/></div><span className="mail-mode">{deliveryMode==='mock'?'模拟 SES': deliveryMode==='tencent'?'腾讯云 SES':'读取配置'}</span></header>
    {settings.isError && <p role="alert">{errorMessage(settings.error)}</p>}
    {admin && !admin.isSuperAdmin && <p>定向邮件仅限超级管理员。</p>}
    {settings.isPending && admin?.isSuperAdmin && <p role="status">正在读取邮件配置…</p>}
    {ready && <>
      <nav className="mail-tabs" aria-label="邮件管理">
        <button aria-current={!['library','history'].includes(view)?'page':undefined} onClick={()=>setView('content')}><Mail size={16}/>编写邮件</button>
        <button aria-current={view==='library'?'page':undefined} onClick={()=>setView('library')}><Layers size={16}/>模板库</button>
        <button aria-current={view==='history'?'page':undefined} onClick={()=>setView('history')}><History size={16}/>发送记录</button>
      </nav>
      {!['library','history'].includes(view) && <nav className="mail-steps" aria-label="编写步骤">{(['content','audience','review'] as const).map((item,index)=><span key={item}><button aria-label={'步骤 '+(index+1)+' · '+['设置内容','选择收件人','核对发送'][index]} disabled={item==='review'?!batchId:item==='audience'&&view==='content'} aria-current={view===item?'step':undefined} onClick={()=>setView(item)}>{['设置内容','选择收件人','核对发送'][index]}</button>{index<2 && <ChevronRight size={14}/>}</span>)}</nav>}
      {view==='library' && <TemplateLibrary items={templates} choose={chooseTemplate} loading={library.isLoading} error={library.isError?errorMessage(library.error):undefined} save={async item=>{await requestJson(endpoint+'/templates',post(item));await library.refetch()}}/>}
      {view==='content' && <CampaignSettings templates={templates} selected={activeTemplate} choose={id=>chooseTemplate(templates.find(t=>t.id===id)!)} fields={reward} update={v=>{clearPreview();setReward(v)}} values={variables} change={v=>{clearPreview();setVariables(v)}} next={()=>{
        if(campaign && (!/^studio(?:\/novel\/[a-z\d_-]+)?$/i.test(reward.path) || (reward.kind==='fixed' && !(resolvedDate(reward,new Date()).getTime()>Date.now())))){setProblem('请核对创作入口和未来的截止时间。');return}
        setProblem('');setView('audience')
      }}/>}
      {view==='audience' && <section className="mail-sheet mail-recipients"><header className="mail-heading"><h2>收件人</h2><small>{activeTemplate.name}</small></header>
        <form onSubmit={generatePreview}>
          <fieldset className="space-y-3" disabled={busy}>
            <label className="block text-sm">选择方式
              <select className={field} value={mode} onChange={event => {
                clearPreview()
                setMode(event.target.value as AdminEmailSelection['mode'])
              }}>
                <option value="manual">手选账号</option><option value="emails">自定义邮箱</option>
                <option value="filter">条件筛选</option>
                <option value="sample">加权抽样</option>
              </select>
            </label>
            {mode === 'emails' ? <label className="mail-addresses">自定义收件邮箱<textarea rows={5} placeholder="每行一个邮箱，也可用逗号分隔" value={addresses} onChange={e=>{clearPreview();setAddresses(e.target.value)}}/><small>{campaign ? '正式回归邮件发给已验证邮箱，自动排除退订和拒收的账号。' : '正式发送按已绑定邮箱匹配账号，并核对活动许可。'}模拟模式可以预演独立地址。</small></label> : mode === 'manual' ? <>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-44 flex-1 text-sm">搜索账号
                  <input type="search" maxLength={100} className={field} value={draftSearch} onChange={event => setDraftSearch(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); searchCandidates() } }} placeholder="账号 ID、昵称或邮箱" />
                </label>
                <Button type="button" onClick={searchCandidates}>搜索</Button>
              </div>
              <p className="text-sm">已选 {selectedCount} / {ADMIN_EMAIL_BATCH_LIMIT}</p>
              {!!selectedCount && <ul className="flex flex-wrap gap-1" aria-label="已选账号">
                {Object.values(selected).map(candidate => <li key={candidate.id}>
                  <Button size="sm" type="button" variant="ghost" aria-label={`移除 ${candidate.nickname}`} onClick={() => toggleCandidate(candidate)}>{candidate.nickname} ×</Button>
                </li>)}
              </ul>}
              {candidates.isPending && <p role="status">正在查询账号…</p>}
              {candidates.isError && <p role="alert">{errorMessage(candidates.error)}</p>}
              {candidates.data && <>
                {candidates.data.items.length === 0 && <p>没有匹配的账号。</p>}
                <div className="divide-y divide-[var(--border-subtle)]">
                  {candidates.data.items.map(candidate => <label key={candidate.id} className="flex items-center gap-2 py-2 text-sm">
                    <input type="checkbox" checked={!!selected[candidate.id]}
                      disabled={!selected[candidate.id] && (!!candidate.exclusion || selectedCount >= ADMIN_EMAIL_BATCH_LIMIT)}
                      onChange={() => toggleCandidate(candidate)} />
                    <span className="break-all">{candidate.nickname} · {candidate.maskedEmail ?? '无绑定邮箱'}{candidate.exclusion ? ` · ${exclusions[candidate.exclusion]}` : ''}</span>
                  </label>)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
                  <span className="text-sm">第 {page} 页</span>
                  <Button type="button" disabled={!candidates.data.hasNextPage} onClick={() => setPage(page + 1)}>下一页</Button>
                </div>
              </>}
            </> : <div className="grid gap-3 sm:grid-cols-2">
              <div className="mail-tags sm:col-span-2"><small>分群标签</small>{[
                {name:'沉默老用户',filters:{registeredBefore:new Date(Date.now()-90*86400000).toISOString().slice(0,10),inactiveForDays:30}},
                {name:'浅尝创作',filters:{minCreations:1,maxCreations:3}},
                {name:'近期活跃',filters:{activeWithinDays:7}}, ...(segments.data?.items ?? []),
              ].map((tag,index)=><button type="button" key={index} className="mail-chip" onClick={()=>updateFilter(tag.filters)}>{tag.name}</button>)}</div>
              <label className="text-sm">账号角色
                <select className={field} value={filters.role ?? ''} onChange={event => updateFilter({ role: (event.target.value || undefined) as Filters['role'] })}>
                  <option value="">全部</option><option value="user">普通用户</option><option value="author">作者</option><option value="admin">管理员</option>
                </select>
              </label>
              <label className="text-sm">测试员资格
                <select className={field} value={filters.tester ?? ''} onChange={event => updateFilter({ tester: (event.target.value || undefined) as Filters['tester'] })}>
                  <option value="">全部</option><option value="effective">有效测试员</option><option value="other">其他账号</option>
                </select>
              </label>
              <label className="text-sm">注册日期起点（北京时间）
                <input type="date" className={field} value={filters.registeredSince ?? ''} onChange={event => updateFilter({ registeredSince: event.target.value || undefined })} />
              </label>
              <label className="text-sm">最近活跃天数
                <input type="number" min={1} max={365} className={field} value={filters.activeWithinDays ?? ''}
                  onChange={event => updateFilter({ activeWithinDays: event.target.value === '' ? undefined : Number(event.target.value) })} />
              </label>
              <label>注册日期上限（含当日）<input type="date" className={field} value={filters.registeredBefore ?? ''} onChange={e=>updateFilter({registeredBefore:e.target.value||undefined})}/></label>
              <label>至少未活跃天数<input type="number" min={1} className={field} value={filters.inactiveForDays ?? ''} onChange={e=>updateFilter({inactiveForDays:e.target.value?Number(e.target.value):undefined})}/></label>
              {(['minCreations','maxCreations'] as const).map((key,index)=><label key={key}>{index?'最多完成创作次数':'最少完成创作次数'}<input className={field} type="number" min={0} value={filters[key]??''} onChange={e=>updateFilter({[key]:e.target.value?Number(e.target.value):undefined})}/></label>)}
              <div className="mail-actions sm:col-span-2"><input aria-label="自定义分群标签名称" placeholder="自定义分群标签名称" maxLength={48} value={segmentName} onChange={e=>setSegmentName(e.target.value)}/><button type="button" className="mail-secondary" disabled={!segmentName.trim()||saveSegment.isPending} onClick={()=>saveSegment.mutate()}>保存当前条件</button><button type="button" className="mail-secondary" onClick={()=>{clearPreview();setFilters({})}}>清空条件</button></div>
              {saveSegment.isError && <p role="alert">{errorMessage(saveSegment.error)}</p>}{segments.isError && <p role="alert">{errorMessage(segments.error)}</p>}
              {mode === 'sample' && <>
                <label className="text-sm">抽样人数
                  <input type="number" required min={1} max={ADMIN_EMAIL_BATCH_LIMIT} className={field} value={sampleSize || ''} onChange={event => {
                    clearPreview()
                    setSampleSize(Number(event.target.value))
                  }} />
                </label>
                <label className="text-sm">抽样权重
                  <select className={field} value={weighting} onChange={event => {
                    clearPreview()
                    setWeighting(event.target.value as 'equal' | 'recent_activity')
                  }}><option value="equal">等权</option><option value="recent_activity">偏向近期活跃</option></select>
                </label>
              </>}
            </div>}
            <div className="mail-actions"><button className="mail-secondary" type="button" onClick={()=>setView('content')}><ArrowLeft size={15}/>返回内容</button><Button type="submit" variant="primary" disabled={mode === 'manual' && !selectedCount}>
              {preview.isPending ? '正在生成…' : '生成发送预览'}
            </Button></div>
          </fieldset>
        </form>
        {preview.isError && <p className="mt-3 text-sm" role="alert">{errorMessage(preview.error)}</p>}
      </section>}
      {view==='review' && batchId && <AdminCard className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{isPreview ? '发送预览' : '投递回执'}</h2>
          {snapshot && !isPreview && <Button type="button" disabled={batch.isFetching} onClick={() => void batch.refetch()}>刷新回执</Button>}
        </div>
        {batch.isPending && <p role="status">正在读取批次…</p>}
        {batch.isError && <p role="alert">{errorMessage(batch.error)}</p>}
        {snapshot && <>
          <EmailBatchDetails key={snapshot.id} batch={snapshot} batchKey={batchKey(snapshot.id)} />
          {snapshot.replacedById && <div className="flex flex-wrap items-center gap-2">
            <p role="status">此预览已被替换。</p>
            <Button type="button" disabled={busy} onClick={() => {
              setFormChanged(false)
              setBatchId(snapshot.replacedById)
            }}>查看替换后的预览</Button>
          </div>}
          {previewExpired && !snapshot.replacedById && <p role="status">预览已过期。</p>}
          {isPreview && formChanged && <p role="status">选择条件已修改，请重新生成预览。</p>}
          {canReplace && !formChanged && snapshot.selection.mode === 'sample' && <Button type="button" disabled={busy}
            onClick={() => { confirm.reset(); preview.mutate({ mode: snapshot.mode, selection: snapshot.selection, campaign: snapshot.campaign, customTemplate:snapshot.customTemplate, replaces: snapshot.id }) }}>重新抽样并预览</Button>}
          {canReplace && !snapshot.blocker && !formChanged && !previewExpired && <Button type="button" variant="primary" disabled={busy}
            onClick={() => confirm.mutate(snapshot)}>{confirm.isPending ? '正在确认…'
                : `确认${snapshot.mode === 'tencent' ? '真实' : '模拟'}发送给 ${snapshot.recipientCount} 人`}</Button>}
          {snapshot.state === 'confirmed' && !!snapshot.progress.queued && <Button type="button" disabled={busy}
            onClick={() => cancel.mutate(snapshot.id)}>停止剩余排队</Button>}
        </>}
        {(confirm.isError || cancel.isError) && <p role="alert">{errorMessage(confirm.error ?? cancel.error)}</p>}
      </AdminCard>}
      {view==='history' && <AdminCard>
        <h2 className="mb-3 font-semibold">最近批次</h2>
        {history.isPending && <p role="status">正在读取批次…</p>}
        {history.isError && <p role="alert">{errorMessage(history.error)}</p>}
        {history.data && !history.data.items.length && <p>暂无已确认批次。</p>}
        <ul className="divide-y divide-[var(--border-subtle)]">
          {history.data?.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span>{formatDateTime(item.createdAt)} · {item.recipientCount} 人{item.state === 'cancelled' ? ' · 排队已停止' : ''}</span>
            <Button type="button" disabled={busy} onClick={() => { confirm.reset(); cancel.reset(); setFormChanged(false); setView('review');setBatchId(item.id) }}>查看回执</Button>
          </li>)}
        </ul>
      </AdminCard>}
      {problem && <p role="alert">{problem}</p>}
    </>}
  </div>
}
