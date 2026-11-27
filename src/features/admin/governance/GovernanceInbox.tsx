import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import { caseStatuses, formatReportReasons, reportReasons, usageCategories, type CaseRow, type CaseDetails, type CaseStatus } from '../../../../shared/contracts/governance-cases'
import { control, action, post, errorText } from '@/features/governance/common'
import CaseProgressForm from './CaseProgressForm'
import ManualUsageCase from './ManualUsageCase'
import { AdminLoading } from '../AdminLoading'

const labels: Record<string, string> = {
  post: '帖子',
  novel: '作品',
  profile: '个人主页',
  comment: '评论',
  message: '私信',
  platform: '平台',
  restriction: '账号限制',
  legacy: '历史封禁',
  warning: '安全提醒',
  observe: '观察',
  review: '需要复核',
  urgent: '紧急复核',
}
const kindLabels: Record<string, string> = { report: '举报投诉', appeal: '申诉', usage: '异常使用' }
function caseReason(item: CaseRow) {
  if (item.kind === 'report') return formatReportReasons(item.category)
  return usageCategories[item.category as keyof typeof usageCategories] ?? labels[item.category] ?? item.category
}

function CaseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useQueryClient(),
    q = useQuery({
      queryKey: ['governance', 'case', id],
      queryFn: () => requestJson<CaseDetails>('/api/admin/governance/cases/' + encodeURIComponent(id)),
      refetchOnWindowFocus: false,
    })
  const [next, setNext] = useState<CaseStatus>('investigating'),
    [reason, setReason] = useState(''),
    [related, setRelated] = useState(''),
    [events, setEvents] = useState<string[]>([]),
    [expires, setExpires] = useState(''),
    [retention, setRetention] = useState('')
  const c = q.data,
    appeal = c?.kind === 'appeal'
  const m = useMutation({
    mutationFn: () =>
      post('/api/admin/governance/' + (appeal ? 'appeals' : 'reports') + '/' + encodeURIComponent(id), {
        status: next,
        reason,
        relatedId: next === 'linked' ? related : undefined,
        invalidEventIds: ['corrected', 'adjusted', 'lifted'].includes(next) ? events : undefined,
        expiresAt: next === 'adjusted' && expires ? new Date(expires).toISOString() : undefined,
        retainUntil: retention ? new Date(retention).toISOString() : undefined,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['governance'] })
      setReason('')
    },
  })
  const choices: CaseStatus[] = appeal
    ? [
        'investigating',
        'maintained',
        ...(c?.safetyEvents?.length ? ['corrected' as const] : []),
        ...(c?.targetKind === 'restriction' ? ['adjusted' as const, 'lifted' as const] : []),
      ]
    : ['investigating', 'upheld', 'dismissed', 'linked']
  return (
    <section id="governance-case-detail" tabIndex={-1}
      className="min-w-0 space-y-3 rounded-xl border border-[var(--border-subtle)] p-4"
      aria-label="案件详情"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">案件详情</h2>
        <button type="button" className={action} onClick={onClose}>
          关闭
        </button>
      </div>
      {q.isLoading ? (
        <AdminLoading label="正在读取案件详情…"/>
      ) : q.isError ? (
        <p role="alert">{errorText(q.error)}</p>
      ) : (
        c && (
          <>
            <p className="break-all">
              {c.id} · {caseStatuses[c.status]}
            </p>
            <p>
              {labels[c.targetKind]} · {c.targetId}
            </p>
            <p>
              受理截止 {new Date(c.acknowledgeBy).toLocaleString()} ·{' '}
              {c.feedbackBy ? '反馈截止 ' + new Date(c.feedbackBy).toLocaleString() : '等待补充材料'}
            </p>
            {c.publicProgress && <p>{c.publicProgress}</p>}
            {['investigating', 'pending'].includes(c.status) && (
              <CaseProgressForm
                item={c}
                onSaved={() => {
                  void client.invalidateQueries({ queryKey: ['governance'] })
                }}
              />
            )}
            <p>
              {caseReason(c)}
            </p>
            {c.snapshot && (
              <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3">
                {c.snapshot}
              </blockquote>
            )}
            {c.statement && <p className="whitespace-pre-wrap break-words">{c.statement}</p>}
            {c.conclusion && <p><strong>处理结论</strong> · {c.conclusion}</p>}
            {c.subjectId && (
              <Link
                className="underline"
                to={
                  '/admin/governance/restrictions?' +
                  new URLSearchParams({ userId: c.subjectId, sourceId: c.id }).toString()
                }
                state={{ reason: [caseReason(c), c.statement].filter(Boolean).join(' · ') }}
              >
                查看或处理账号限制
              </Link>
            )}
            {c.targetKind === 'novel' && (
              <Link className="ml-2 underline" to={'/admin/novels/' + encodeURIComponent(c.targetId)}>
                作品管理
              </Link>
            )}
            {['pending', 'investigating'].includes(c.status) && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  m.mutate()
                }}
              >
                <label>
                  处理结果
                  <select
                    className={control}
                    value={next}
                    onChange={(e) => setNext(e.target.value as CaseStatus)}
                  >
                    {choices.map((k) => (
                      <option key={k} value={k} disabled={k === c.status}>
                        {caseStatuses[k]}
                      </option>
                    ))}
                  </select>
                </label>
                {next === 'linked' && (
                  <label>
                    同一目标的主案件编号
                    <input
                      required
                      className={control}
                      value={related}
                      onChange={(e) => setRelated(e.target.value)}
                    />
                  </label>
                )}
                {next === 'adjusted' && (
                  <label>
                    调整后的限制截止时间
                    <input
                      required
                      type="datetime-local"
                      className={control}
                      value={expires}
                      onChange={(e) => setExpires(e.target.value)}
                    />
                  </label>
                )}
                {['corrected', 'adjusted', 'lifted'].includes(next) && Boolean(c.safetyEvents?.length) && (
                  <fieldset className="space-y-1">
                    <legend>经独立复核认定有误的关联事件</legend>
                    {c.safetyEvents.map((event) => (
                      <label key={event.id} className="block break-all">
                        <input
                          type="checkbox"
                          checked={events.includes(event.id)}
                          onChange={(e) =>
                            setEvents((current) =>
                              e.target.checked
                                ? [...current, event.id]
                                : current.filter((id) => id !== event.id),
                            )
                          }
                        />{' '}
                        {event.category} · {event.id}
                      </label>
                    ))}
                  </fieldset>
                )}
                <label>
                  {appeal ? '告知申诉人的结论及依据' : '内部处理依据'}
                  <textarea
                    className={control}
                    rows={3}
                    maxLength={4000}
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                {['upheld', 'dismissed', 'maintained', 'corrected', 'adjusted', 'lifted'].includes(next) && (
                  <label>
                    需依法继续保留证据时填写截止日期，否则结案后清理
                    <input
                      className={control}
                      type="datetime-local"
                      value={retention}
                      onChange={(e) => setRetention(e.target.value)}
                    />
                  </label>
                )}
                <button
                  className={action}
                  disabled={m.isPending || next === c.status || (next === 'corrected' && !events.length)}
                >
                  {m.isPending ? '处理中…' : '确认处理'}
                </button>
              </form>
            )}
            {m.isError && <p role="alert">{errorText(m.error)}</p>}
            {m.isSuccess && <p role="status">已记录处理结果。</p>}
            <details>
              <summary>处理历史</summary>
              {c.events.map((e) => (
                <p key={e.id}>
                  {new Date(e.createdAt).toLocaleString()} ·{' '}
                  {e.result ? caseStatuses[e.result as CaseStatus] : e.action} {e.reason}
                </p>
              ))}
            </details>
          </>
        )
      )}
    </section>
  )
}
export function GovernanceInbox({ kind }: { kind?: 'report' | 'appeal' | 'usage' }) {
  const [params, setParams] = useSearchParams()
  const client = useQueryClient()
  const selected = params.get('case') ?? ''
  const filters = new URLSearchParams()
  if (kind) filters.set('kind', kind)
  for (const key of ['status', 'target', 'category', 'userId', 'after', 'cursor', 'overdue']) {
    const value = params.get(key)
    if (!value) continue
    const dayStart = key === 'after' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00+08:00') : NaN
    filters.set(key, Number.isFinite(dayStart) ? new Date(dayStart).toISOString() : value)
  }
  const filterKey = filters.toString()
  const q = useQuery({
    queryKey: ['governance', 'list', filterKey],
    queryFn: ({ signal }) => requestJson<{ items: CaseRow[]; next: string | null }>('/api/admin/governance/cases?' + filterKey, { signal }),
  })
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (key !== 'case') next.delete('case')
    if (key !== 'cursor' && key !== 'case') next.delete('cursor')
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: key !== 'case' })
  }
  useEffect(() => {
    if (selected && window.matchMedia?.('(max-width: 1023px)').matches) {
      document.getElementById('governance-case-detail')?.focus()
    }
  }, [selected])
  const targets = kind === 'report' ? ['post','novel','profile','comment','message','platform']
    : kind === 'appeal' ? ['restriction','legacy','warning'] : kind === 'usage' ? ['observe','review','urgent'] : Object.keys(labels)
  const statuses: (keyof typeof caseStatuses)[] = kind === 'appeal' ? ['pending','investigating','maintained','adjusted','lifted','corrected']
    : kind ? ['pending','investigating','upheld','dismissed','linked'] : Object.keys(caseStatuses) as (keyof typeof caseStatuses)[]
  const hasFilters = ['status','target','category','userId','after','overdue'].some(key => params.has(key))
  return <section aria-label="案件队列" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="案件类型" className="flex flex-wrap gap-1">
        {([['', '全部案件',''],['reports','举报投诉','report'],['appeals','申诉','appeal'],['usage','异常使用','usage']] as const).map(([path,label,key]) =>
          <Link key={label} aria-current={(kind ?? '') === key ? 'page' : undefined} to={'/admin/governance' + (path ? '/' + path : '')}
            className={'rounded-full px-3 py-2 text-sm ' + ((kind ?? '') === key ? 'bg-[var(--surface-muted)] font-semibold' : 'text-[var(--text-secondary)]')}>{label}</Link>)}
      </nav>
      {kind === 'usage' && <ManualUsageCase onCreated={() => void client.invalidateQueries({ queryKey: ['governance'] })}/>}
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-36 text-xs text-[var(--text-secondary)]">案件状态<select className={control} value={params.get('status') ?? ''} onChange={e => change('status', e.target.value)}>
        <option value="">全部状态</option>{statuses.map(s => <option key={s} value={s}>{caseStatuses[s]}</option>)}</select></label>
      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={params.get('overdue') === 'true'} onChange={e => change('overdue', e.target.checked ? 'true' : '')}/>仅看逾期</label>
      <details className="min-w-48"><summary className="cursor-pointer py-2">更多筛选</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label>对象<select className={control} value={params.get('target') ?? ''} onChange={e => change('target',e.target.value)}><option value="">全部</option>{targets.map(v => <option key={v} value={v}>{labels[v]}</option>)}</select></label>
          {kind !== 'appeal' && <label>案件理由<select className={control} value={params.get('category') ?? ''} onChange={e => change('category',e.target.value)}><option value="">全部</option>{Object.entries(kind === 'usage' ? usageCategories : kind === 'report' ? reportReasons : {...reportReasons,...usageCategories}).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>}
          <label>被调查账号<input className={control} value={params.get('userId') ?? ''} onChange={e => change('userId', e.target.value)}/></label>
          <label>提交日期起<input type="date" className={control} value={params.get('after') ?? ''} onChange={e => change('after',e.target.value)}/></label>
        </div></details>
      {hasFilters && <button type="button" className="py-2 text-sm underline" onClick={() => setParams({})}>清除筛选</button>}
    </div>
    <div className={selected ? 'grid items-start gap-4 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]' : ''}>
      <section aria-label="案件列表" className="min-w-0 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)]">
        {q.isPending ? <AdminLoading label="正在读取案件…"/> : q.isError ? <p role="alert" className="p-5">{errorText(q.error)} <button className="underline" onClick={() => void q.refetch()}>重试</button></p> : !q.data.items.length ? <p className="p-6 text-[var(--text-secondary)]">暂无符合条件的案件。</p> :
          q.data.items.map(c => <button key={c.id} aria-pressed={selected === c.id} onClick={() => change('case',c.id)} className={'flex w-full items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-3.5 text-left last:border-0 hover:bg-[var(--surface-muted)] ' + (selected === c.id ? 'bg-[var(--surface-muted)]' : '')}>
            <span className="min-w-0"><strong className="block break-words">{caseReason(c)}</strong>
              <span className="mt-1 block truncate text-xs text-[var(--text-secondary)]">{kindLabels[c.kind]} · {labels[c.targetKind]} · {c.id}</span></span>
            <span className="shrink-0 text-right"><span className="block">{caseStatuses[c.status]}</span><time className="text-xs text-[var(--text-secondary)]">{new Date(c.createdAt).toLocaleDateString('zh-CN')}</time></span>
          </button>)}
      </section>
      {selected && <CaseDetail key={selected} id={selected} onClose={() => change('case','')}/>}
    </div>
    <div className="flex gap-2">{params.has('cursor') && <button className={action} onClick={() => change('cursor','')}>返回首页</button>}
      {q.data?.next && <button className={action} onClick={() => change('cursor',q.data.next!)}>下一页</button>}</div>
  </section>
}
