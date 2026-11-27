import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { requestJson } from '@/app/api-client'

const queues = [
  { key: 'pending', label: '待受理举报', to: '/admin/governance/reports?status=pending' },
  { key: 'appeals', label: '待受理申诉', to: '/admin/governance/appeals?status=pending' },
  { key: 'review', label: '调查中', to: '/admin/governance?status=investigating' },
  { key: 'overdue', label: '已逾期', to: '/admin/governance?overdue=true' },
] as const

export default function GovernanceSummary() {
  const query = useQuery({
    queryKey: ['governance', 'summary'],
    queryFn: () => requestJson<Record<(typeof queues)[number]['key'], number>>('/api/admin/governance/summary'),
  })
  if (query.isError) return <button type="button" className="underline" onClick={() => void query.refetch()}>待办统计读取失败，重试</button>
  return <nav aria-label="治理待办" aria-busy={query.isPending} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {queues.map(({ key, label, to }) => <Link key={key} to={to} aria-label={query.data ? `${label}，${query.data[key]} 件` : `${label}，正在读取`} className="min-w-0 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 py-3 transition-colors hover:bg-[var(--surface-muted)]">
      <span className="block text-xs text-[var(--text-secondary)]">{label}</span>
      {query.data ? <strong className="mt-1 block text-xl tabular-nums">{query.data[key]}</strong> : <span aria-hidden="true" className="skeleton-shimmer mt-2 block h-5 w-8 rounded"/>}
    </Link>)}
  </nav>
}
