import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import TrendLineChart from './TrendLineChart'
import type { AdminAnalyticsPayload, AdminAnalyticsPeriod } from '../../../../shared/contracts/admin-analytics.js'

const format = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
const rate = (success: number, failure: number) => success + failure ? `${(100 * success / (success + failure)).toFixed(1)}%` : '暂无样本'

export default function AdminAnalytics({ scope }: { scope: 'dashboard' | 'creation' | 'credits' | 'cost' }) {
  const [period, setPeriod] = useState<AdminAnalyticsPeriod>('day')
  const [expanded, setExpanded] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['admin', 'analytics', scope, period], queryFn: () => requestJson<AdminAnalyticsPayload>(`/api/admin/analytics?period=${period}&scope=${scope}`), staleTime: 60000 })
  const data = query.data
  const total = (key: string) => data?.metrics.find(metric => metric.key === key)?.total ?? 0
  return (
    <section className="mb-6 space-y-4" aria-label={scope === 'dashboard' ? '平台统计' : '创作统计'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl border border-[var(--border-default)] p-1" aria-label="统计粒度">
          {(['day', 'week', 'month'] as const).map((item, i) => <button key={item} type="button" aria-pressed={period === item} onClick={() => setPeriod(item)} className={`min-h-11 rounded-lg px-4 text-sm ${period === item ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)]' : 'text-[var(--text-secondary)]'}`}>{['日', '周', '月'][i]}</button>)}
        </div>
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} className="min-h-11 rounded-lg px-3 text-sm disabled:opacity-50">刷新统计</button>
      </div>
      <p className="text-xs leading-6 text-[var(--text-secondary)]">{period === 'day' ? '近 14 日' : period === 'week' ? '近 12 周（周一起）' : '近 12 月'} · UTC+8 · 数值为范围合计，当前周期尚未结束。点击卡片展开，切换日/周/月调整统计。</p>
      {query.isPending ? <p role="status">正在加载统计…</p> : query.isError ? <p role="alert">统计加载失败，请点击刷新重试。</p> : data ? <>
        {scope === 'creation' ? <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[var(--border-default)] p-4">执行成功率 <strong>{rate(total('completed'), total('failed'))}</strong><p className="mt-2 text-xs text-[var(--text-secondary)]">范围内发起执行的当前状态：完成 ÷（完成 + 失败）。暂停、待审批及进行中不计入分母；不是会话完成率。</p></div>
          <div className="rounded-xl border border-[var(--border-default)] p-4">工具成功率 <strong>{rate(total('toolSuccess'), total('toolFailed'))}</strong><p className="mt-2 text-xs text-[var(--text-secondary)]">成功 ÷ 已知结果。未成功含拒绝、保护性拦截，不等同系统故障。未知结果 {format(total('tools') - total('toolSuccess') - total('toolFailed'))} 次。</p></div>
        </div> : <p className="text-xs leading-6 text-[var(--text-secondary)]">作品按保留记录统计，发布按发布时间；邀请为已兑换的唯一受邀用户。Token 为已记录用量（不含未知部分），Credits 为调用计费毛额，未扣后续退款。</p>}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {data.metrics.map(metric => <div key={metric.key} className={`min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] ${expanded === metric.key ? 'sm:col-span-2 xl:col-span-4' : ''}`}>
            <button type="button" className="w-full rounded-xl p-4 text-left focus-visible:outline focus-visible:outline-2" aria-expanded={expanded === metric.key} onClick={() => setExpanded(expanded === metric.key ? null : metric.key)}>
              <span className="flex justify-between gap-2 text-sm">{metric.label}<span>{expanded === metric.key ? '收起' : '展开'}</span></span>
              <strong className="mt-2 block break-all text-2xl tabular-nums">{metric.unavailable ? '未核定' : format(metric.total)}</strong>
              {!metric.unavailable && <TrendLineChart labels={data.labels.map(label => period === 'month' ? label.slice(0, 7) : label.slice(5))} values={metric.values} />}
            </button>
            {expanded === metric.key ? <div className="max-h-72 overflow-auto border-t border-[var(--border-default)] p-4"><table className="w-full text-sm"><caption className="sr-only">{metric.label}分期数据</caption><thead><tr><th className="text-left">周期起始日（UTC+8）</th><th className="text-right">数量</th></tr></thead><tbody>{data.labels.map((label, i) => <tr key={label} className="border-t border-[var(--border-default)]"><td className="py-3">{label}</td><td className="text-right tabular-nums">{metric.unavailable ? '未核定' : format(metric.values[i])}</td></tr>)}</tbody></table></div> : null}
          </div>)}
        </div>
        {data.cost ? <div className="rounded-xl border border-[var(--border-default)] p-4 text-sm">
          <h2 className="font-semibold">内置模型人民币估算</h2>
          <p className="my-3 text-xs leading-6 text-[var(--text-secondary)]">按 2026-09-13 核对的公开价重估所选范围用量，不是历史账单，不扣资源包或优惠。DeepSeek 按用量记录时间判断峰谷；输入包含缓存，输出不重复加思考 Token。已核定 {data.cost.knownCalls} 次，缺价格或完整用量 {data.cost.unknownCalls} 次（未计入，不代表免费）。历史缺内置档位的记录无法归属，不计入。</p>
          <div className="mb-3 flex flex-wrap gap-4"><a className="underline" target="_blank" rel="noreferrer" href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/">DeepSeek 公开价格</a><a className="underline" target="_blank" rel="noreferrer" href="https://docs.bigmodel.cn/cn/guide/start/pricing">智谱公开价格／资源包查询</a></div>
          {scope === 'cost' ? data.cost.models.map(row => <div key={`${row.provider}:${row.model}`} className="flex flex-wrap justify-between gap-2 border-t border-[var(--border-default)] py-3"><span className="break-all">{row.provider} / {row.model}</span><span>{row.knownCalls ? `￥${format(row.estimated)}` : '未核定'} · 已核定 {row.knownCalls} / 未核定 {row.unknownCalls} 次</span></div>) : null}
        </div> : null}
        {scope === 'creation' ? <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4">
          <h2 className="font-semibold">工具未成功排行榜</h2>
          <p className="my-3 text-xs text-[var(--text-secondary)]">按未成功次数排序，最多 30 项。每行保留样本量；返回数不含尚未返回的调用。</p>
          {!data.tools.length ? <p className="py-6 text-center">该时段暂无工具返回</p> : <ol className="divide-y divide-[var(--border-default)]">{data.tools.map((tool, i) => <li key={tool.name} className="py-3"><div className="flex flex-wrap justify-between gap-2"><span className="break-all font-medium">{i + 1}. {tool.name}</span><span className="text-sm">成功率 {rate(tool.succeeded, tool.failed)}</span></div><div className="my-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]"><div className="h-full bg-[var(--color-error)]" style={{ width: `${tool.failed / (tool.calls || 1) * 100}%` }} /></div><p className="text-xs text-[var(--text-secondary)]">返回 {tool.calls} · 成功 {tool.succeeded} · 未成功 {tool.failed} · 未知 {tool.unknown}</p></li>)}</ol>}
        </div> : null}
        <p className="text-xs text-[var(--text-tertiary)]">快照时间：{new Date(data.to).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
      </> : null}
    </section>
  )
}
