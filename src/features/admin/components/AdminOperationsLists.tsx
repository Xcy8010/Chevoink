import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { AdminCard, AdminPager, AdminPanelState, StatusPill } from '../AdminLayout'
import TextInput from './AdminTextInput'
import type { AdminOperationCallsPayload, AdminOperationRunsPayload, AdminOperationsContext, AdminOperationsHealthPayload } from '../../../../shared/contracts/admin-operations.js'

const SOURCE_LABELS = { provider_attempts: '供应商尝试', usage: '本地用量与账务', web_tools: '网页工具回执' }
const OUTCOME_LABELS = { success: '已记录成功', failure: '已记录失败', pending: '结果尚未返回', cancelled: '已取消', unknown: '能力结果未知' }
const RUN_LABELS: Record<string, string> = { queued: '排队中', running: '执行中', awaiting_approval: '待审批', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' }
const CALL_STATUS_LABELS: Record<string, Record<string, string>> = { provider_attempts: { prepared: '待派发', dispatched: '已派发', succeeded: '成功', failed: '失败', cancelled: '已取消', unknown: '结果待核' }, usage: { prepared: '待派发', pending_usage: '用量待核', observed: '用量已观测', pending_settlement: '结算待核', settled: '已结算', not_dispatched: '未派发' }, web_tools: { dispatched: '已派发', completed: '回执已完成', failed: '失败' } }
const FILTER_LABELS: Record<string, string> = { model: '模型 / 档位', provider: '供应商 / 渠道', runId: 'Run ID', taskId: '任务根 ID', user: '作者昵称 / ID' }
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
const tokens = (value: number | null) => value === null ? '未知' : value.toLocaleString('zh-CN')
type Kind = 'calls' | 'runs' | 'health'
function readQuery(params: URLSearchParams, kind: Kind) {
  const query = new URLSearchParams()
  const period = params.get('period')
  query.set('period', period === 'week' || period === 'month' ? period : 'today')
  const sourceValue = params.get('source')
  const source = sourceValue === 'usage' || sourceValue === 'web_tools' ? sourceValue : 'provider_attempts'
  if (kind !== 'runs') query.set('source', source)
  for (const key of ['model', 'provider', 'runId', 'taskId', 'status', ...(kind === 'runs' ? ['user'] : ['errorCategory'])]) {
    if (params.get(key)) query.set(key, params.get(key)!)
  }
  const from = params.get('opsFrom'), to = params.get('opsTo')
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value
  const invalidWindow = Boolean(from) !== Boolean(to) || Boolean(from && to && (!validDate(from) || !validDate(to) || from > to))
  if (from && to && !invalidWindow) {
    query.set('from', `${from}T00:00:00+08:00`)
    query.set('to', new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000).toISOString())
  }
  const pageKey = kind === 'runs' ? 'runPage' : 'callPage'
  const rawPage = params.get(pageKey) ?? '1'
  const page = /^\d+$/.test(rawPage) && Number(rawPage) > 0 && Number(rawPage) <= 1_000_000 ? Number(rawPage) : 1
  const rawSize = Number(params.get('opsPageSize') ?? 20)
  const pageSize = [10, 20, 50, 100].includes(rawSize) ? rawSize : 20
  if (kind !== 'health') { query.set('page', String(page)); query.set('pageSize', String(pageSize)) }
  return { query, pageKey, page, pageSize, invalidWindow, source }
}
function OperationsFilters({ kind }: { kind: Kind }) {
  const [params, setParams] = useSearchParams()
  const { source } = readQuery(params, kind)
  const statusLabels = kind === 'runs' ? RUN_LABELS : CALL_STATUS_LABELS[source]
  const fields = ['model', 'provider', 'runId', 'taskId', ...(kind === 'runs' ? ['user'] : [])]
  const saved = fields.map(key => params.get(key) ?? '').join('\u0000')
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(key => [key, params.get(key) ?? ''])))
  useEffect(() => { setDraft(Object.fromEntries(saved.split('\u0000').map((value, index) => [['model','provider','runId','taskId','user'][index], value]))) }, [saved])
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    next.delete('callPage'); next.delete('runPage')
    if (key === 'source') { next.delete('status'); next.delete('errorCategory'); if (value === 'web_tools') { next.delete('model'); next.delete('provider') } }
    setParams(next, { replace: true })
  }
  return <AdminCard className="mb-4 min-w-0"><div className="flex flex-wrap items-end gap-3">
    {kind === 'runs' ? <label className="text-sm">统计期间<select aria-label="统计期间" value={params.get('period') ?? 'today'} onChange={event => change('period', event.target.value)} className="mt-1 block min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3"><option value="today">本日</option><option value="week">本周</option><option value="month">本月</option></select></label> : null}
    {kind !== 'runs' ? <label className="text-sm">记录来源<select aria-label="记录来源" value={source} onChange={event => change('source', event.target.value)} className="mt-1 block min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3">{Object.entries(SOURCE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
    <label className="text-sm">{kind !== 'runs' && source === 'usage' ? '账务状态' : '记录状态'}<select aria-label="记录状态" value={params.get('status') ?? ''} onChange={event => change('status', event.target.value)} className="mt-1 block min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3"><option value="">全部状态</option>{params.get('status') && !statusLabels[params.get('status')!] ? <option value={params.get('status')!}>{params.get('status')}</option> : null}{Object.entries(statusLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {kind !== 'runs' ? <label className="text-sm">异常类别<select aria-label="异常类别" value={params.get('errorCategory') ?? ''} onChange={event => change('errorCategory', event.target.value)} className="mt-1 block min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3"><option value="">全部类别</option>{source === 'usage' ? <option value="billing_pending">账务待核</option> : <><option value="known_failure">已记录失败</option>{source === 'provider_attempts' ? <><option value="unknown_result">结果未知</option><option value="cancelled">已取消</option></> : null}</>}</select></label> : null}
    <details className="w-full"><summary className="min-h-11 cursor-pointer py-3 text-sm">更多筛选</summary><form className="space-y-3" onSubmit={event => { event.preventDefault(); const next = new URLSearchParams(params); for (const key of fields) { if (draft[key]?.trim()) next.set(key, draft[key].trim()); else next.delete(key) } next.delete('callPage'); next.delete('runPage'); setParams(next, { replace: true }) }}><div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{fields.filter(key => source !== 'web_tools' || kind === 'runs' || !['model','provider'].includes(key)).map(key => <label key={key} className="min-w-0 text-sm">{FILTER_LABELS[key]}<TextInput className="min-w-0" value={draft[key] ?? ''} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></label>)}<label className="min-w-0 text-sm">开始日期（UTC+8）<TextInput type="date" className="min-w-0" value={params.get('opsFrom') ?? ''} onChange={event => change('opsFrom', event.target.value)} /></label><label className="min-w-0 text-sm">结束日期（UTC+8）<TextInput type="date" className="min-w-0" value={params.get('opsTo') ?? ''} onChange={event => change('opsTo', event.target.value)} /></label></div><div className="flex flex-wrap gap-2"><Button type="submit">应用筛选</Button><Button onClick={() => { const next = new URLSearchParams(params); for (const key of [...fields,'status','errorCategory','opsFrom','opsTo','callPage','runPage']) next.delete(key); setParams(next, { replace: true }) }}>清空筛选</Button></div></form></details>
  </div></AdminCard>
}
function SourceContext({ data }: { data: AdminOperationsContext }) {
  return <div className="mb-4 min-w-0 text-sm text-[var(--text-secondary)]"><p>来源 {data.source} · UTC+8 · 快照 {time(data.snapshotAt)}</p><p className="mt-1">{time(data.window.from)} — {time(data.window.to)} · 按记录创建时间</p><details><summary className="min-h-11 cursor-pointer py-3">来源与覆盖范围</summary><ul className="list-inside list-disc space-y-2">{data.coverage.map(item => <li key={item}>{item}</li>)}</ul></details></div>
}
function useOperationsPage(kind: Kind) {
  const [params, setParams] = useSearchParams()
  const values = readQuery(params, kind)
  const setPage = (page: number) => { const next = new URLSearchParams(params); next.set(values.pageKey, String(page)); setParams(next, { replace: true }) }
  const setPageSize = (size: number) => { const next = new URLSearchParams(params); next.set('opsPageSize', String(size)); next.delete(values.pageKey); setParams(next, { replace: true }) }
  return { ...values, setPage, setPageSize }
}
export function AdminCallRecords() {
  const filter = useOperationsPage('calls')
  const query = useQuery({ queryKey: ['admin','operations','calls',filter.query.toString()], queryFn: () => requestJson<AdminOperationCallsPayload>(`/api/admin/operations/calls?${filter.query}`), enabled: !filter.invalidWindow })
  const data = query.data
  return <section aria-label="调用记录"><OperationsFilters kind="calls" />{filter.invalidWindow ? <p role="alert">请成对填写有效的起止日期。</p> : <AdminCard>{data ? <SourceContext data={data} /> : null}<AdminPanelState state={query.isPending ? 'loading' : query.isError ? 'error' : !data?.items.length ? 'empty' : 'ready'}><ul className="divide-y divide-[var(--border-default)]">{data?.items.map(item => <li key={item.id} className="min-w-0 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-all font-semibold">{item.model ?? item.action ?? '实际模型未记录'}</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{item.provider ?? '供应商未记录'} · {time(item.createdAt)}</p></div><StatusPill tone={item.outcome === 'failure' ? 'danger' : 'neutral'}>{OUTCOME_LABELS[item.outcome]}</StatusPill></div><div className="mt-3 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4"><p>{item.source === 'usage' ? '账务状态' : '回执状态'}：{item.status ? CALL_STATUS_LABELS[item.source][item.status] ?? item.status : '未知'}</p><p>输入 / 输出：{tokens(item.requestTokens)} / {tokens(item.responseTokens)}</p><p>记录耗时：{item.durationMs === null ? '未知' : `${Math.round(item.durationMs)} ms`}</p><p>本地已记 Credits：{item.chargedCreditsMilli === null ? '未知' : item.chargedCreditsMilli / 1000}</p></div><details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm">身份与缓存详情</summary><div className="space-y-2 break-all text-sm"><div>记录 ID：{item.id}</div><div>Run：{item.runId ?? '未记录'}</div><div>任务根：{item.taskId ?? '未记录'}</div><div>操作：{item.operationId ?? '未记录'}</div><div>缓存命中 / 未命中：{tokens(item.cacheHitTokens)} / {tokens(item.cacheMissTokens)}</div><div>用量来源 / 结算：{item.usageSource ?? '未知'} / {item.billingStatus ?? '未知'}</div></div>{item.runId ? <Link className="mt-2 inline-flex min-h-11 items-center underline" to={`/admin/creation-records?runId=${encodeURIComponent(item.runId)}`}>定位创作运行</Link> : null}</details></li>)}</ul></AdminPanelState>{data ? <AdminPager pagination={data.pagination} page={filter.page} pageSize={filter.pageSize} onPageChange={filter.setPage} onPageSizeChange={filter.setPageSize} /> : null}</AdminCard>}</section>
}
export function AdminRunRecords() {
  const filter = useOperationsPage('runs')
  const query = useQuery({ queryKey: ['admin','operations','runs',filter.query.toString()], queryFn: () => requestJson<AdminOperationRunsPayload>(`/api/admin/operations/runs?${filter.query}`), enabled: !filter.invalidWindow })
  const data = query.data
  return <section aria-label="任务执行记录"><OperationsFilters kind="runs" />{filter.invalidWindow ? <p role="alert">请成对填写有效的起止日期。</p> : <AdminCard>{data ? <SourceContext data={data} /> : null}<AdminPanelState state={query.isPending ? 'loading' : query.isError ? 'error' : !data?.items.length ? 'empty' : 'ready'}><ul className="divide-y divide-[var(--border-default)]">{data?.items.map(item => <li key={item.id} className="min-w-0 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold">{item.session.title}</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{item.user.nickname} · {time(item.createdAt)}</p></div><StatusPill tone={item.status === 'failed' ? 'danger' : 'neutral'}>{RUN_LABELS[item.status] ?? item.status}</StatusPill></div><p className="mt-3 text-sm">执行档位 {item.modelTier} · 动作 {item.action} · 自定义配置 {item.customModelId ?? '无'}</p><p className="mt-2 break-all text-sm text-[var(--text-secondary)]">Run {item.id} · 任务根 {item.taskId ?? '未记录'}</p><details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm">执行时间与详情入口</summary><p className="text-sm">开始 {item.startedAt ? time(item.startedAt) : '未开始'} · 结束 {item.finishedAt ? time(item.finishedAt) : '未结束'}</p><Link className="mt-2 inline-flex min-h-11 items-center text-sm underline" to={`/admin/users/${encodeURIComponent(item.user.id)}/creation-records`}>主动查看此作者的创作记录</Link></details></li>)}</ul></AdminPanelState>{data ? <AdminPager pagination={data.pagination} page={filter.page} pageSize={filter.pageSize} onPageChange={filter.setPage} onPageSizeChange={filter.setPageSize} /> : null}</AdminCard>}</section>
}
export function AdminLocalHealth() {
  const filter = useOperationsPage('health')
  const query = useQuery({ queryKey: ['admin','operations','health',filter.query.toString()], queryFn: () => requestJson<AdminOperationsHealthPayload>(`/api/admin/operations/health?${filter.query}`), enabled: !filter.invalidWindow })
  const data = query.data
  return <section aria-label="本地记录观测"><OperationsFilters kind="health" />{filter.invalidWindow ? <p role="alert">请成对填写有效的起止日期。</p> : <AdminCard><AdminPanelState state={query.isPending ? 'loading' : query.isError ? 'error' : 'ready'}>{data ? <><SourceContext data={data} /><h3 className="font-semibold">{data.observation === 'no_samples' ? '该范围无样本' : data.observation === 'attention' ? '范围内有已记录失败' : data.observation === 'observed' ? '已有执行结果样本' : '能力结果覆盖不足'}</h3><p className="mt-2 text-sm text-[var(--text-secondary)]">本地记录观测不等于实时连接健康或全云枢健康；未采集的流量不在分母内。</p><div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">{([['total','样本总数'],['success','已知成功'],['failure','已知失败'],['pending','进行中 / 待返回'],['cancelled','已取消'],['unknown','未知能力结果']] as const).map(([key,label]) => <div key={key} className="border-b border-[var(--border-default)] py-3"><p className="text-sm text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-xl font-semibold">{data.counts[key]}</p></div>)}</div><p className="mt-4 text-sm">最近样本：{data.lastSampleAt ? time(data.lastSampleAt) : '无样本'}</p><p className="mt-2 text-sm text-[var(--text-secondary)]">首字响应、P50/P95 与输出速度：未采集可靠样本，不以均值或总耗时替代。</p></> : null}</AdminPanelState></AdminCard>}</section>
}
