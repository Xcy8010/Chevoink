import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { formatCreditAmount } from '@/features/account/credit-format'
import { AdminCard, AdminPageHeader, AdminPanelState } from '../AdminLayout'
import { formatTokens } from '../admin-shared'
import { getAdminTokenManagement } from '../api'
import SupplierBalances from '../components/SupplierBalances'
import AdminAnalytics from '../components/AdminAnalytics'

function formatCacheRate(hit: number | null, miss: number | null) {
  if (hit === null || miss === null) return '—'
  const total = hit + miss
  return total > 0 ? `${Math.round((hit / total) * 100)}%` : '—'
}

function formatCoverage(observed: number, prompt: number) {
  return prompt > 0 ? `${Math.min(100, Math.round((observed / prompt) * 100))}%` : '—'
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

export default function AdminTokenManagementPage() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today')
  const query = useQuery({ queryKey: ['admin', 'token-usage', period], queryFn: () => getAdminTokenManagement(period) })
  const data = query.data
  const maxTrend = useMemo(() => Math.max(1, ...(data?.trend?.map((item) => item.requestTokens + item.responseTokens) ?? [1])), [data?.trend])
  return (
    <div>
      <SupplierBalances />
      <AdminAnalytics scope="cost" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><AdminPageHeader title="Token 管理" description="按 UTC+8 统计模型输入/输出 Token、联网搜索和生图调用，并下钻到用户创作记录。" /><div className="flex shrink-0 rounded-lg border border-[var(--border-strong)] p-1">{([['today','本日'],['week','本周'],['month','本月']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => setPeriod(value)} className={`rounded-md px-3 py-1.5 text-xs ${period === value ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'}`}>{label}</button>)}</div></div>
      <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
        {data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
              {[
                ['总 Token', formatTokens(data.summary.totalTokens)],
                ['输入 Token', formatTokens(data.summary.requestTokens)],
                ['输出 Token', formatTokens(data.summary.responseTokens)],
                ['缓存命中率', `${formatCacheRate(data.summary.cacheHitTokens, data.summary.cacheMissTokens)} · 覆盖 ${formatCoverage(data.summary.cacheObservedTokens, data.summary.requestTokens)}`],
                ['使用用户', data.summary.users.toLocaleString('zh-CN')],
                ['联网搜索', data.summary.webSearchCalls.toLocaleString('zh-CN')],
                ['生图调用', data.summary.imageCalls.toLocaleString('zh-CN')],
              ].map(([label, value]) => (
                <AdminCard key={label}>
                  <p className="text-xs text-[var(--text-secondary)]">{label}</p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </AdminCard>
              ))}
            </div>

            {data.trend && data.trend.length > 0 ? <AdminCard><h2 className="text-sm font-semibold">输入 / 输出趋势</h2><div className="mt-5 flex h-36 items-end gap-2">{data.trend.map((item) => <div key={item.date} className="flex h-full min-w-0 flex-1 items-end gap-[2px]" title={`${item.date} · 输入 ${formatTokens(item.requestTokens)} · 输出 ${formatTokens(item.responseTokens)}`}><div className="flex-1 bg-slate-500" style={{ height: `${Math.max(2, item.requestTokens / maxTrend * 100)}%` }} /><div className="flex-1 bg-emerald-500" style={{ height: `${Math.max(2, item.responseTokens / maxTrend * 100)}%` }} /></div>)}</div><div className="mt-3 flex gap-4 text-xs text-[var(--text-secondary)]"><span><i className="mr-1 inline-block h-2 w-2 bg-slate-500" />输入</span><span><i className="mr-1 inline-block h-2 w-2 bg-emerald-500" />输出</span></div></AdminCard> : null}

            {data.models && data.models.length > 0 ? <AdminCard><h2 className="mb-3 text-sm font-semibold">模型用量</h2><div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">供应商 / 模型</th><th>档位</th><th>输入</th><th>输出</th><th>总量</th><th>缓存命中率</th><th>观测覆盖</th><th>请求</th></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.models.map((item) => <tr key={`${item.providerName ?? 'unknown'}:${item.modelName}:${item.modelTier}`}><td className="py-2.5"><p className="font-medium">{item.modelName}</p><p className="text-xs text-[var(--text-tertiary)]">{item.providerName ?? '未知供应商'}</p></td><td>{item.modelLabel}</td><td>{formatTokens(item.requestTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{formatTokens(item.totalTokens)}</td><td>{formatCacheRate(item.cacheHitTokens, item.cacheMissTokens)}</td><td>{formatCoverage(item.cacheObservedTokens, item.requestTokens)}</td><td>{item.requestCount.toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div></AdminCard> : null}

            {data.runs && data.runs.length > 0 ? <AdminCard><h2 className="mb-3 text-sm font-semibold">Agent 运行缓存明细</h2><p className="mb-3 text-xs text-[var(--text-secondary)]">主 Agent 与子 Agent 已按同一 Run 合并；轮数仅统计主 Agent，调用数包含收尾与子 Agent。</p><div className="overflow-x-auto"><table className="w-full min-w-[1020px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">开始时间</th><th>输入</th><th>输出</th><th>命中</th><th>未命中</th><th>命中率</th><th>观测覆盖</th><th>主轮数</th><th>调用数</th><th>费用</th></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.runs.map((item) => <tr key={item.runId}><td className="py-2.5">{formatDateTime(item.startedAt)}</td><td>{formatTokens(item.promptTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{formatTokens(item.hitTokens)}</td><td>{formatTokens(item.missTokens)}</td><td className="font-medium">{formatCacheRate(item.hitTokens, item.missTokens)}</td><td>{formatCoverage(item.cacheObservedTokens, item.promptTokens)}</td><td>{item.turns}</td><td>{item.requests}</td><td>{formatCreditAmount(item.chargedMilli / 1000)} Cr</td></tr>)}</tbody></table></div></AdminCard> : null}

            {data.runTurns && data.runTurns.length > 0 ? <AdminCard><h2 className="mb-3 text-sm font-semibold">最近 Agent 逐调用缓存明细</h2><p className="mb-3 text-xs text-[var(--text-secondary)]">“—”表示供应商未返回缓存数据；0% 表示已观测且本次没有命中。</p><div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">时间</th><th>范围</th><th>轮次</th><th>供应商 / 模型</th><th>输入</th><th>输出</th><th>命中</th><th>未命中</th><th>命中率</th><th>费用</th></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.runTurns.map((item) => <tr key={item.id}><td className="py-2.5">{formatDateTime(item.createdAt)}</td><td>{item.scope === 'subagent' ? '子 Agent' : '主 Agent'}</td><td>{item.turn ?? '收尾'}</td><td><p className="font-medium">{item.modelName}</p><p className="text-xs text-[var(--text-tertiary)]">{item.providerName ?? '未知供应商'}</p></td><td>{formatTokens(item.promptTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{item.hitTokens === null ? '—' : formatTokens(item.hitTokens)}</td><td>{item.missTokens === null ? '—' : formatTokens(item.missTokens)}</td><td className="font-medium">{formatCacheRate(item.hitTokens, item.missTokens)}</td><td>{formatCreditAmount(item.chargedMilli / 1000)} Cr</td></tr>)}</tbody></table></div></AdminCard> : null}

            <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">用量排行</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">用户</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>请求数</th><th>联网</th><th>生图</th><th /></tr></thead>
                  <tbody className="divide-y divide-[var(--border-default)]">
                    {data.users.map((item, index) => (
                      <tr key={item.user.id}>
                        <td className="py-2.5"><span className="mr-2 text-[var(--text-tertiary)]">{index + 1}</span>{item.user.nickname}</td>
                        <td>{formatTokens(item.requestTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{formatTokens(item.totalTokens)}</td><td>{item.requestCount}</td><td>{item.webSearchCalls}</td><td>{item.imageCalls}</td>
                        <td className="text-right"><Link className="text-xs underline" to={`/admin/users/${item.user.id}/creation-records`}>创作记录</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminCard>

            <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">高消耗动作</h2>
              <div className="space-y-2">
                {data.actions.slice(0, 20).map((item) => (
                  <div key={item.action} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 border-b border-[var(--border-subtle)] py-2 text-sm last:border-0">
                    <span className="truncate">{item.action}</span>
                    <span>{formatTokens(item.totalTokens)} · {item.requestCount} 次</span>
                    <span className="text-[var(--text-secondary)]">均 {formatTokens(item.averageTokens)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-5 text-[var(--text-secondary)]">
                长篇正文生成、多轮连续性/人类感检查、重复读取大段上下文通常是主要消耗。当前已通过检查结果复用、单轮自动修订、图谱空置才自动构建和工具参数容错减少无效重试，不缩减有效正文与质量检查。
              </p>
            </AdminCard>
          </div>
        ) : null}
      </AdminPanelState>
    </div>
  )
}
