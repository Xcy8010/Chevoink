import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import Button from '@/components/ui/Button'
import { AdminCard, StatusPill } from '../AdminLayout'
import { getAdminYunshuOperations } from '../api'
import type { AdminYunshuOperations as Payload, AdminYunshuOperationsQuery, AdminYunshuAuxState } from '../../../../shared/contracts/admin-yunshu-usage.js'

const titles = { records: '云枢调用记录', health: '云枢健康观测', cost: '云枢成本与余额' }
const states = { unconfigured:'未配置', ready:'已更新', partial:'部分覆盖', stale:'旧快照', error:'读取失败' }
const kinds = { all:'全部记录', consume:'消费日志', error:'错误日志', refund:'退款日志' }
const auxLabels: Record<AdminYunshuAuxState,string> = { not_requested:'未读取',unconfigured:'未配置',ready:'已更新',stale:'旧快照',error:'读取失败' }
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '尚未取得'
const count = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN')
const decimal = (value: string) => { const [integer,fraction] = value.split('.'); return integer.replace(/\B(?=(\d{3})+(?!\d))/g,',') + (fraction === undefined ? '' : `.${fraction}`) }
function quota(converted: string | null, raw: string | null, display: Payload['cost']['display']) {
  if (converted !== null && (display.state === 'ready' || display.state === 'stale')) {
    const unit = display.type === 'USD' || display.type === 'CNY' ? display.type : display.type === 'CUSTOM' ? display.symbol ?? '自定义单位' : '网关额度单位'
    return `${decimal(converted)} ${unit}`
  }
  return raw === null ? '—' : `${decimal(raw)} 网关额度单位（换算未知）`
}

export default function AdminYunshuOperations({ period, view }: Pick<AdminYunshuOperationsQuery,'period'|'view'>) {
  const [page,setPage] = useState(1)
  const [kind,setKind] = useState<AdminYunshuOperationsQuery['kind']>('all')
  const [foreground,setForeground] = useState(() => document.visibilityState !== 'hidden' && document.hasFocus())
  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden' && document.hasFocus())
    window.addEventListener('focus',update); window.addEventListener('blur',update); document.addEventListener('visibilitychange',update)
    return () => { window.removeEventListener('focus',update); window.removeEventListener('blur',update); document.removeEventListener('visibilitychange',update) }
  },[])
  const query = useQuery({queryKey:['admin','yunshu-operations',period,view,page,kind],queryFn:({signal})=>getAdminYunshuOperations({period,view,page,pageSize:20,kind},signal),retry:false,staleTime:60_000,refetchInterval:foreground?60_000:false,refetchIntervalInBackground:false})
  const data = query.data
  const state = query.isError ? data?.observedAt ? 'stale' : 'error' : data?.state
  const failure = !query.isError && (state === 'error' || state === 'stale') ? data?.message : null
  const health = data?.health
  return <section aria-label={titles[view]} className="mb-5 space-y-4">
    <AdminCard><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{titles[view]}</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">云枢管理日志 · 已配置的平台令牌 · 部分覆盖 · UTC+8</p></div><Button size="sm" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={15} className={query.isFetching?'animate-spin':''}/>{query.isFetching?'更新中…':'刷新云枢数据'}</Button></div>
      {query.isPending ? <p role="status" className="py-8 text-center text-sm">正在读取云枢数据…</p> : <>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]"><StatusPill tone={state==='error'?'danger':state==='stale'?'warning':'neutral'}>{state?states[state]:'读取失败'}</StatusPill><span>更新时间：{time(data?.observedAt??null)}</span>{data?<><span>来源 {data.sources.verified} / {data.sources.configured}</span>{data.sources.unresolved>0?<span>{data.sources.unresolved} 项未核实</span>:null}{!data.paginationComplete&&state!=='unconfigured'?<span>上游分页未完成</span>:null}</>:null}</div>
        {state==='error'||state==='stale'?<p role="alert" className="mt-4 text-sm text-[var(--color-error)]">{failure || '云枢数据暂不可用。'}{state==='stale'?' 以下保留上次成功快照。':''}</p>:null}
        {state==='unconfigured'?<p role="status" className="mt-4 text-sm">尚未配置云枢管理读取凭据。</p>:null}
        {state==='partial'&&data?.message?<p className="mt-3 text-xs text-[var(--text-secondary)]">{data.message}</p>:null}
        {data?.observedAt?<details className="mt-2 text-xs text-[var(--text-secondary)]"><summary className="min-h-11 cursor-pointer py-3">统计期间</summary>{time(data.window.from)} — {time(data.window.to)}</details>:null}
      </>}
    </AdminCard>
    {view==='records'?<AdminCard><label className="mb-4 flex flex-wrap items-center gap-3 text-sm">记录类型<select aria-label="云枢记录类型" value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setPage(1)}} className="min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3">{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {data?.observedAt&&data.records.items.length ? <>
        <ul className="space-y-3 md:hidden">{data.records.items.map(row=><li key={row.id} className="rounded-xl border border-[var(--border-default)] p-3"><div className="flex flex-wrap justify-between gap-2"><strong className="break-all">{row.modelName}</strong><StatusPill tone={row.kind==='error'?'danger':'neutral'}>{kinds[row.kind]}</StatusPill></div><p className="mt-2 text-xs text-[var(--text-secondary)]">{time(row.createdAt)} · {row.group??'未返回分组'}</p><dl className="mt-3 grid grid-cols-2 gap-3 text-sm">{[['输入 / 输出',`${count(row.requestTokens)} / ${count(row.responseTokens)}`],['耗时',row.durationMs===null?'—':`${count(row.durationMs)} ms`],['网关额度',row.quota===null?'—':decimal(row.quota)],['流式结果',row.streamOutcome==='ok'?'已知成功':row.streamOutcome==='error'?'已知失败':'未知']].map(([label,value])=><div key={label}><dt className="text-xs text-[var(--text-secondary)]">{label}</dt><dd className="break-all">{value}</dd></div>)}</dl>{row.requestId?<p className="mt-3 break-all text-xs">请求 {row.requestId}</p>:null}</li>)}</ul>
        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[920px] text-left text-sm"><caption className="sr-only">云枢调用明细</caption><thead><tr>{['时间 / 请求','模型 / 分组','类型','输入 / 输出','耗时','网关额度','流式结果'].map(title=><th key={title}>{title}</th>)}</tr></thead><tbody>{data.records.items.map(row=><tr key={row.id}><td><p>{time(row.createdAt)}</p><p className="max-w-52 break-all text-xs text-[var(--text-tertiary)]">{row.requestId??'请求编号未返回'}</p></td><td><p className="break-all">{row.modelName}</p><p className="text-xs text-[var(--text-tertiary)]">{row.group??'未返回分组'}</p></td><td>{kinds[row.kind]}</td><td>{count(row.requestTokens)} / {count(row.responseTokens)}</td><td>{row.durationMs===null?'—':`${count(row.durationMs)} ms`}</td><td>{row.quota===null?'—':decimal(row.quota)}</td><td>{row.streamOutcome==='ok'?'已知成功':row.streamOutcome==='error'?'已知失败':'未知'}</td></tr>)}</tbody></table></div>
      </>:data?.observedAt?<p role="status" className="py-8 text-center text-sm">该筛选范围暂无云枢调用记录。</p>:null}
      {data?.observedAt?<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><p>已观测 {data.records.totalObserved} 条 · 筛选 {data.records.total} 条 · 第 {data.records.page} / {Math.max(1,data.records.totalPages)} 页</p><div className="flex gap-2"><Button disabled={data.records.page<=1||query.isFetching} onClick={()=>setPage(data.records.page-1)}>上一页</Button><Button disabled={!data.records.hasMore||query.isFetching} onClick={()=>setPage(data.records.page+1)}>下一页</Button></div></div>:null}
    </AdminCard>:null}
    {view==='health'&&data?<>
      <AdminCard><h3 className="font-semibold">云枢状态接口</h3><p className="mt-2 text-sm">{data.cost.display.state==='ready'?'状态接口可读取':auxLabels[data.cost.display.state]}</p>{data.cost.display.message?<p className="mt-2 text-xs text-[var(--text-secondary)]">{data.cost.display.message}</p>:null}<p className="mt-2 text-xs text-[var(--text-tertiary)]">更新时间：{time(data.cost.display.observedAt)} · 接口可读取不代表所有模型可用。</p></AdminCard>
      {data.observedAt&&health?<AdminCard><h3 className="font-semibold">{health.observation==='no_samples'?'该范围无日志样本':health.observation==='attention'?'范围内有错误记录':'已有日志观测样本'}</h3><p className="mt-2 text-xs text-[var(--text-secondary)]">日志样本统计，不代表实时主动探测；消费记录不等同已核实的成功响应。</p><dl className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">{[['消费记录',health.consumeCount],['错误记录',health.errorCount],['退款记录',health.refundCount],['流式已知成功',health.streamSuccessCount],['流式已知失败',health.streamErrorCount],['流式结果未知',health.unknownOutcomeCount]].map(([label,value])=><div key={label}><dt className="text-xs text-[var(--text-secondary)]">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd></div>)}</dl><dl className="mt-6 grid grid-cols-2 gap-4"><div><dt className="text-xs text-[var(--text-secondary)]">记录耗时 P50</dt><dd>{health.p50Ms===null?'—':`${count(health.p50Ms)} ms`}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">记录耗时 P95</dt><dd>{health.p95Ms===null?'—':`${count(health.p95Ms)} ms`}</dd></div></dl><p className="mt-4 text-xs text-[var(--text-tertiary)]">耗时样本 {health.durationSamples} 条 · 最近样本 {time(health.lastSampleAt)}</p></AdminCard>:null}
    </>:null}
    {view==='cost'&&data?<>
      <AdminCard><h3 className="font-semibold">云枢实际扣费</h3><dl className="mt-4 grid gap-5 sm:grid-cols-3">{[['扣费',data.cost.display.deduction,data.cost.deductionQuota],['退款',data.cost.display.refund,data.cost.refundQuota],['净额',data.cost.display.net,data.cost.netQuota]].map(([label,converted,raw])=><div key={label}><dt className="text-sm text-[var(--text-secondary)]">{label}</dt><dd className="mt-2 break-all text-xl font-semibold tabular-nums">{quota(converted,raw,data.cost.display)}</dd></div>)}</dl><p className="mt-4 text-xs text-[var(--text-secondary)]">扣费待核 {data.cost.unknownDeductionCount} 条 · 退款待核 {data.cost.unknownRefundCount} 条 · {auxLabels[data.cost.display.state]}</p>{data.cost.display.message?<p className="mt-2 text-xs text-[var(--text-secondary)]">{data.cost.display.message}</p>:null}</AdminCard>
      <AdminCard><div className="flex flex-wrap justify-between gap-3"><h3 className="font-semibold">云枢管理账号余额</h3><StatusPill tone={data.balance.state==='error'?'danger':data.balance.state==='stale'?'warning':'neutral'}>{auxLabels[data.balance.state]}</StatusPill></div><dl className="mt-4 grid gap-5 sm:grid-cols-2"><div><dt className="text-sm text-[var(--text-secondary)]">剩余额度</dt><dd className="mt-2 break-all text-xl font-semibold tabular-nums">{quota(data.balance.displayRemaining,data.balance.remainingQuota,data.cost.display)}</dd></div><div><dt className="text-sm text-[var(--text-secondary)]">账号累计已用</dt><dd className="mt-2 break-all text-xl font-semibold tabular-nums">{quota(data.balance.displayUsed,data.balance.usedQuota,data.cost.display)}</dd></div></dl>{data.balance.message?<p className="mt-3 text-xs text-[var(--text-secondary)]">{data.balance.message}</p>:null}<p className="mt-3 text-xs text-[var(--text-tertiary)]">更新时间：{time(data.balance.observedAt)} · 管理账号范围，与上方所选期间及平台令牌范围不同。</p></AdminCard>
    </>:null}
  </section>
}
