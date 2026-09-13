import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import type { SupplierBalance } from '../../../../shared/contracts/supplier-balances.js'

export default function SupplierBalances() {
  const query = useQuery({ queryKey: ['admin', 'supplier-balances'], queryFn: () => requestJson<SupplierBalance[]>('/api/admin/supplier-balances'), staleTime: 60000, retry: false })
  return <section className="mb-5 rounded-xl border border-[var(--border-default)] p-4">
    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">内置模型 · 供应商剩余余额</h2><button type="button" className="min-h-11 px-3" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? '查询中…' : '刷新'}</button></div>
    <p className="my-3 text-xs text-[var(--text-secondary)]">相同供应商与凭据合并显示，缓存一分钟。余额与本平台成本分开；不合计不同账户或币种，不包含用户自定义模型。</p>
    {query.isError ? <p role="alert">查询失败，请重试。</p> : null}
    <div className="grid gap-3 sm:grid-cols-2">{query.data?.map((row, index) => <div key={index} className="min-w-0 rounded-lg bg-[var(--surface-default)] p-3">
      <h3 className="break-all font-medium">{row.provider}</h3><p className="my-2 text-xs text-[var(--text-secondary)]">{row.models.join('、')}</p>
      {row.status === 'ready' ? row.balances.map(balance => <div key={balance.currency}><strong>{balance.currency} {balance.total}</strong><p className="text-xs">充值余额 {balance.toppedUp} · 赠金 {balance.granted}</p></div>) : <strong>— {row.status === 'error' ? '查询失败' : row.status === 'unsupported' ? '暂不支持自动查询' : '未配置'}</strong>}
      <p className="my-2 text-xs leading-5 text-[var(--text-secondary)]">{row.message}</p><p className="text-xs text-[var(--text-tertiary)]">{new Date(row.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
      {row.consoleUrl ? <a className="mt-2 inline-flex min-h-11 items-center text-sm underline" href={row.consoleUrl} target="_blank" rel="noreferrer">供应商控制台</a> : null}
    </div>)}</div>
  </section>
}
