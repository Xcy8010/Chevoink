import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { requestJson } from '@/app/api-client'
import type { AdminAnalyticsPayload } from '../../../../shared/contracts/admin-analytics.js'
import { AdminCard, AdminPageHeader } from '../AdminLayout'
import { listAdminFeedbacks } from '../api'
import AdminAnalytics from '../components/AdminAnalytics'

export default function AdminDashboardPage() {
  const feedback = useQuery({ queryKey: ['admin', 'attention', 'feedback'], queryFn: () => listAdminFeedbacks({ status: 'pending', page: 1, pageSize: 1 }) })
  const execution = useQuery({ queryKey: ['admin', 'analytics', 'creation', 'day'], queryFn: () => requestJson<AdminAnalyticsPayload>('/api/admin/analytics?period=day&scope=creation'), staleTime: 60000 })
  const cost = useQuery({ queryKey: ['admin', 'analytics', 'cost', 'day'], queryFn: () => requestJson<AdminAnalyticsPayload>('/api/admin/analytics?period=day&scope=cost'), staleTime: 60000 })
  const failed = execution.data?.metrics.find(metric => metric.key === 'failed')
  const cards = [
    { title: '待处理反馈', value: feedback.isError ? '加载失败' : feedback.isPending ? '加载中…' : `${feedback.data?.counts.pending ?? 0} 条`, to: '/admin/feedback?status=pending', source: '反馈待处理队列 · 当前状态' },
    { title: '创作执行失败', value: execution.isError ? '加载失败' : execution.isPending ? '加载中…' : failed ? `${failed.total} 次` : '未采集', to: '/admin/creation-records?tab=stats', source: '本日发起执行的当前状态 · UTC+8' },
    { title: '待核估算成本', value: cost.isError ? '加载失败' : cost.isPending ? '加载中…' : cost.data?.cost ? `${cost.data.cost.unknownCalls} 次缺价格或用量` : '未采集', to: '/admin/tokens?tab=cost&period=today', source: '本地用量与公开价 · 不代表待扣 Credits' },
    { title: '服务异常', value: '未接入', to: '/admin/tokens?tab=health', source: '尚无连接检测和服务异常观测' },
  ]
  return <div>
    <AdminPageHeader title="总览" description="先处理待办与异常，再查看平台趋势。" />
    <section id="attention" aria-label="待办与异常" className="mb-6">
      <h2 className="mb-3 text-base font-semibold">待办与异常</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(card => <AdminCard key={card.title}>
        <p className="text-sm text-[var(--text-secondary)]">{card.title}</p><p className="mt-2 text-xl font-semibold">{card.value}</p><p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">{card.source}</p><Link className="mt-2 inline-flex min-h-11 items-center text-sm underline" to={card.to}>查看{card.title}</Link>
      </AdminCard>)}</div>
      <p className="mt-3 text-xs text-[var(--text-secondary)]">异常统计快照：{execution.data ? new Date(execution.data.to).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '待取得'} · 反馈按当前状态读取。无样本不代表运行健康。</p>
    </section>
    <h2 className="mb-3 text-base font-semibold">平台趋势</h2><AdminAnalytics scope="dashboard" />
  </div>
}
