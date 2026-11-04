import { useAdminQueryState } from '../admin-query-state'
import { useQuery } from '@tanstack/react-query'

import { Link } from 'react-router-dom'

import { formatCreditAmount } from '@/features/account/credit-format'
import { AdminCard, AdminPageHeader, AdminPanelState, AdminSectionTabs } from '../AdminLayout'
import { formatTokens } from '../admin-shared'
import { getAdminTokenManagement } from '../api'
import SupplierBalances from '../components/SupplierBalances'
import { AdminCallRecords, AdminLocalHealth } from '../components/AdminOperationsLists'
import AdminIntegrationStatus from '../components/AdminIntegrationStatus'
import AdminAnalytics from '../components/AdminAnalytics'
import TrendLineChart from '../components/TrendLineChart'

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
  const [periodValue, setPeriod] = useAdminQueryState('period', 'today')
  const period = periodValue === 'week' || periodValue === 'month' ? periodValue : 'today'
  const [tab, setTab] = useAdminQueryState('tab', 'usage')
  const query = useQuery({ queryKey: ['admin', 'token-usage', period], queryFn: () => getAdminTokenManagement(period), enabled: tab === 'usage' })
  const data = query.data
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><AdminPageHeader title="用量与运行" description="按 UTC+8 统计模型输入/输出 Token、联网搜索和生图调用，并下钻到用户创作记录。" /><div className="flex shrink-0 rounded-lg border border-[var(--border-strong)] p-1">{([['today','本日'],['week','本周'],['month','本月']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => setPeriod(value)} className={`rounded-md px-3 py-1.5 text-xs ${period === value ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'}`}>{label}</button>)}</div></div>
      <AdminSectionTabs tabs={[{id:'usage',label:'用量'},{id:'calls',label:'调用记录'},{id:'health',label:'健康'},{id:'cost',label:'成本与余额'}]} value={tab} onChange={setTab} label="用量与运行分区" />
      <p className="mb-4 text-sm text-[var(--text-secondary)]">数据来源：墨域本地用量记录 · UTC+8 · 缺失数据保持未知，云枢扣款尚未对账。</p>
      {tab === 'cost' ? <><AdminIntegrationStatus /><AdminCard className="mb-4"><h2 className="font-semibold">云枢扣款</h2><p className="mt-2 text-sm text-[var(--text-secondary)]">未接入对账。以下供应商余额与公开价估算均不代表云枢实际扣款。</p></AdminCard><SupplierBalances /><AdminAnalytics scope="cost" period={period === 'today' ? 'day' : period} /></> : null}
      {tab === 'health' ? <AdminLocalHealth /> : null}
      {tab === 'calls' ? <AdminCallRecords /> : null}
      {tab === 'usage' ? <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
        {data ? (
          <div className="space-y-4">
            {tab === 'usage' ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
            </div> : null}

            {tab === 'usage' && data.trend ? <AdminCard><h2 className="mb-5 text-sm font-semibold">输入 / 输出趋势</h2><TrendLineChart label="Token 输入输出趋势" labels={data.trend.map(item => item.date.slice(5))} series={[{label:'输入 Token',values:data.trend.map(item=>item.requestTokens)},{label:'输出 Token',values:data.trend.map(item=>item.responseTokens)}]} /></AdminCard> : null}

            {tab === 'usage' && data.models && data.models.length > 0 ? <AdminCard><h2 className="mb-3 text-sm font-semibold">模型用量</h2><ul className="space-y-3 md:hidden">{data.models.map(item => <li key={`${item.providerName}:${item.modelName}:${item.modelTier}`} className="rounded-xl border border-[var(--border-default)] p-3"><h3 className="break-all font-semibold">{item.modelName}</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{item.providerName ?? '未知供应商'} · {item.modelLabel}</p><dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--text-secondary)]">输入 / 输出</dt><dd>{formatTokens(item.requestTokens)} / {formatTokens(item.responseTokens)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">请求 / 总 Token</dt><dd>{item.requestCount} / {formatTokens(item.totalTokens)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">缓存命中率</dt><dd>{formatCacheRate(item.cacheHitTokens, item.cacheMissTokens)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">观测覆盖</dt><dd>{formatCoverage(item.cacheObservedTokens, item.requestTokens)}</dd></div></dl></li>)}</ul><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[920px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">供应商 / 模型</th><th>档位</th><th>输入</th><th>输出</th><th>总量</th><th>缓存命中率</th><th>观测覆盖</th><th>请求</th></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.models.map((item) => <tr key={`${item.providerName ?? 'unknown'}:${item.modelName}:${item.modelTier}`}><td className="py-2.5"><p className="font-medium">{item.modelName}</p><p className="text-xs text-[var(--text-tertiary)]">{item.providerName ?? '未知供应商'}</p></td><td>{item.modelLabel}</td><td>{formatTokens(item.requestTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{formatTokens(item.totalTokens)}</td><td>{formatCacheRate(item.cacheHitTokens, item.cacheMissTokens)}</td><td>{formatCoverage(item.cacheObservedTokens, item.requestTokens)}</td><td>{item.requestCount.toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div></AdminCard> : null}

            <details><summary className="min-h-11 cursor-pointer py-3 text-sm">最近运行与调用的缓存明细</summary>
            {tab === 'usage' && data.runs && data.runs.length > 0 ? <AdminCard><h2 className="mb-3 text-sm font-semibold">Agent 运行缓存明细</h2><p className="mb-3 text-xs text-[var(--text-secondary)]">主 Agent 与子 Agent 已按同一 Run 合并；轮数仅统计主 Agent，调用数包含收尾与子 Agent。</p><ul className="space-y-3 md:hidden">{data.runs.map(item => <li key={item.runId} className="rounded-xl border border-[var(--border-default)] p-3"><p className="font-medium">{formatDateTime(item.startedAt)}</p><p className="mt-2 text-sm">输入 {formatTokens(item.promptTokens)} · 输出 {formatTokens(item.responseTokens)}</p><p className="mt-1 text-sm">{item.turns} 主轮 · {item.requests} 调用 · {formatCreditAmount(item.chargedMilli / 1000)} 本地 Credits</p><details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm">缓存观测详情</summary><p className="text-sm">命中 {formatTokens(item.hitTokens)} · 未命中 {formatTokens(item.missTokens)} · 命中率 {formatCacheRate(item.hitTokens, item.missTokens)} · 覆盖 {formatCoverage(item.cacheObservedTokens, item.promptTokens)}</p></details></li>)}</ul><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[1020px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">开始时间</th><th>输入</th><th>输出</th><th>命中</th><th>未命中</th><th>命中率</th><th>观测覆盖</th><th>主轮数</th><th>调用数</th><th>本地 Credits</th></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.runs.map((item) => <tr key={item.runId}><td className="py-2.5">{formatDateTime(item.startedAt)}</td><td>{formatTokens(item.promptTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{formatTokens(item.hitTokens)}</td><td>{formatTokens(item.missTokens)}</td><td className="font-medium">{formatCacheRate(item.hitTokens, item.missTokens)}</td><td>{formatCoverage(item.cacheObservedTokens, item.promptTokens)}</td><td>{item.turns}</td><td>{item.requests}</td><td>{formatCreditAmount(item.chargedMilli / 1000)} Cr</td></tr>)}</tbody></table></div></AdminCard> : null}

            {tab === 'usage' && data.runTurns && data.runTurns.length > 0 ? <AdminCard><h2 className="mb-3 text-sm font-semibold">最近 Agent 逐调用缓存明细</h2><p className="mb-3 text-xs text-[var(--text-secondary)]">“—”表示供应商未返回缓存数据；0% 表示已观测且本次没有命中。</p><ul className="space-y-3 md:hidden">{data.runTurns.map(item => <li key={item.id} className="rounded-xl border border-[var(--border-default)] p-3"><p className="break-all font-semibold">{item.modelName}</p><p className="mt-1 text-sm text-[var(--text-secondary)]">{item.providerName ?? '未知供应商'} · {formatDateTime(item.createdAt)}</p><p className="mt-2 text-sm">{item.scope === 'subagent' ? '子 Agent' : '主 Agent'} · {item.turn ?? '收尾'} 轮 · {formatCreditAmount(item.chargedMilli / 1000)} 本地 Credits</p><p className="mt-1 text-sm">输入 {formatTokens(item.promptTokens)} · 输出 {formatTokens(item.responseTokens)}</p><details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm">缓存观测详情</summary><p className="text-sm">命中 {item.hitTokens === null ? '—' : formatTokens(item.hitTokens)} · 未命中 {item.missTokens === null ? '—' : formatTokens(item.missTokens)} · 命中率 {formatCacheRate(item.hitTokens, item.missTokens)}</p></details></li>)}</ul><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[1080px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2">时间</th><th>范围</th><th>轮次</th><th>供应商 / 模型</th><th>输入</th><th>输出</th><th>命中</th><th>未命中</th><th>命中率</th><th>本地 Credits</th></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.runTurns.map((item) => <tr key={item.id}><td className="py-2.5">{formatDateTime(item.createdAt)}</td><td>{item.scope === 'subagent' ? '子 Agent' : '主 Agent'}</td><td>{item.turn ?? '收尾'}</td><td><p className="font-medium">{item.modelName}</p><p className="text-xs text-[var(--text-tertiary)]">{item.providerName ?? '未知供应商'}</p></td><td>{formatTokens(item.promptTokens)}</td><td>{formatTokens(item.responseTokens)}</td><td>{item.hitTokens === null ? '—' : formatTokens(item.hitTokens)}</td><td>{item.missTokens === null ? '—' : formatTokens(item.missTokens)}</td><td className="font-medium">{formatCacheRate(item.hitTokens, item.missTokens)}</td><td>{formatCreditAmount(item.chargedMilli / 1000)} Cr</td></tr>)}</tbody></table></div></AdminCard> : null}

            </details>
            {tab === 'usage' ? <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">用量排行</h2>
              <ul className="space-y-3 md:hidden">{data.users.map((item,index) => <li key={item.user.id} className="rounded-xl border border-[var(--border-default)] p-3"><p className="font-semibold">{index + 1}. {item.user.nickname}</p><p className="mt-2 text-sm">输入 {formatTokens(item.requestTokens)} · 输出 {formatTokens(item.responseTokens)} · 总量 {formatTokens(item.totalTokens)}</p><p className="mt-1 text-sm text-[var(--text-secondary)]">{item.requestCount} 请求 · 联网 {item.webSearchCalls} · 生图 {item.imageCalls}</p><Link className="mt-2 inline-flex min-h-11 items-center text-sm underline" to={`/admin/users/${item.user.id}/creation-records`}>创作记录</Link></li>)}</ul><div className="hidden overflow-x-auto md:block">
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
            </AdminCard> : null}

            {tab === 'usage' ? <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">高消耗动作</h2>
              <div className="space-y-2">
                {data.actions.slice(0, 20).map((item) => (
                  <div key={item.action} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-4 border-b border-[var(--border-subtle)] py-2 text-sm last:border-0">
                    <span className="truncate">{item.action}</span>
                    <span>{formatTokens(item.totalTokens)} · {item.requestCount} 次</span>
                    <span className="col-span-2 text-[var(--text-secondary)] sm:col-span-1">均 {formatTokens(item.averageTokens)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-5 text-[var(--text-secondary)]">
                长篇正文生成、多轮连续性/人类感检查、重复读取大段上下文通常是主要消耗。当前已通过检查结果复用、单轮自动修订、图谱空置才自动构建和工具参数容错减少无效重试，不缩减有效正文与质量检查。
              </p>
            </AdminCard> : null}
          </div>
        ) : null}
      </AdminPanelState> : null}
    </div>
  )
}
