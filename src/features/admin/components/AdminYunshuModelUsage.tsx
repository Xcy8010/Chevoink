import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import Button from '@/components/ui/Button'
import { AdminCard, StatusPill } from '../AdminLayout'
import { getAdminYunshuModelUsage } from '../api'
import { formatTokens } from '../admin-shared'
import type { AdminYunshuModelUsage } from '../../../../shared/contracts/admin-yunshu-usage.js'

type ModelRow = AdminYunshuModelUsage['models'][number]
const amount = (value: number | null) => value === null ? '—' : formatTokens(value)
const total = (row: ModelRow) => row.requestTokens === null || row.responseTokens === null ? null : row.requestTokens + row.responseTokens
const observedTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const states = { unconfigured: '未配置', ready: '已更新', partial: '部分覆盖', stale: '旧快照', error: '读取失败' } as const

export default function AdminYunshuModelUsage({ period }: { period: 'today' | 'week' | 'month' }) {
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden' && document.hasFocus())
  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden' && document.hasFocus())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update) }
  }, [])
  const query = useQuery({
    queryKey: ['admin', 'yunshu-model-usage', period],
    queryFn: ({ signal }) => getAdminYunshuModelUsage(period, signal),
    retry: false,
    staleTime: 60_000,
    refetchInterval: foreground ? 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  const data = query.data
  const state = query.isError ? data?.observedAt ? 'stale' : 'error' : data?.state
  const models = data?.models ?? []
  return <AdminCard className="mb-4"><section aria-label="云枢模型用量">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">模型用量</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">云枢管理日志 · 已配置的平台令牌 · 部分覆盖</p></div><Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} className={query.isFetching ? 'animate-spin' : ''} />{query.isFetching ? '更新中…' : '刷新模型用量'}</Button></div>
    {query.isPending ? <p role="status" className="py-8 text-center text-sm text-[var(--text-secondary)]">正在读取云枢模型用量…</p> : <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]"><StatusPill tone={state === 'error' ? 'danger' : state === 'stale' ? 'warning' : 'neutral'}>{state ? states[state] : '读取失败'}</StatusPill><span>更新时间：{data?.observedAt ? observedTime(data.observedAt) : '尚未取得'}</span>{data && <span>来源 {data.sources.verified} / {data.sources.configured}{data.sources.unresolved > 0 ? ` · ${data.sources.unresolved} 项未核实` : ''}</span>}{data && !data.paginationComplete && state !== 'unconfigured' && <span>分页未完成</span>}</div>
      {state === 'unconfigured' ? <p role="status" className="py-6 text-center text-sm text-[var(--text-secondary)]">尚未配置云枢管理读取凭据。</p> : null}
      {state === 'error' || state === 'stale' ? <p role="alert" className="mb-4 text-sm text-[var(--color-error)]">{state === 'stale' ? '更新失败，以下保留上次成功快照。' : '云枢模型用量读取失败，请刷新重试。'}</p> : null}
      {state === 'partial' && data?.message ? <p className="mb-4 text-xs text-[var(--text-secondary)]">{data.message}</p> : null}
      {!models.length && (state === 'ready' || state === 'partial') ? <p role="status" className="py-8 text-center text-sm text-[var(--text-secondary)]">该范围暂无云枢模型用量记录。</p> : null}
      {models.length > 0 ? <>
        <ul className="space-y-3 md:hidden">{models.map(row => <li key={JSON.stringify([row.modelName,row.group])} className="rounded-xl border border-[var(--border-default)] p-3"><h3 className="break-all font-semibold">{row.modelName}</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">{row.group ?? '未返回分组'}</p><dl className="mt-3 grid grid-cols-2 gap-3 text-sm">{[['输入 / 输出', `${amount(row.requestTokens)} / ${amount(row.responseTokens)}`],['总 Token',amount(total(row))],['缓存读取 / 写入',`${amount(row.cacheHitTokens)} / ${amount(row.cacheWriteTokens)}`],['请求 / 错误 / 退款',`${row.requestCount} / ${row.errorCount} / ${row.refundCount}`]].map(([name,value]) => <div key={name}><dt className="text-xs text-[var(--text-secondary)]">{name}</dt><dd className="tabular-nums">{value}</dd></div>)}</dl></li>)}</ul>
        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">云枢管理日志模型用量</caption><thead><tr>{['模型 / 分组','输入','输出','总 Token','缓存读取','缓存写入','请求','错误','退款'].map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{models.map(row => <tr key={JSON.stringify([row.modelName,row.group])}><td><p className="font-medium">{row.modelName}</p><p className="text-xs text-[var(--text-tertiary)]">{row.group ?? '未返回分组'}</p></td>{[row.requestTokens,row.responseTokens,total(row),row.cacheHitTokens,row.cacheWriteTokens].map((value,index) => <td key={index} className="tabular-nums">{amount(value)}</td>)}<td>{row.requestCount}</td><td>{row.errorCount}</td><td>{row.refundCount}</td></tr>)}</tbody></table></div>
      </> : null}
    </>}
  </section></AdminCard>
}
