import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'

type Summary = { pending: number; appeals: number; review: number; overdue: number }
export default function GovernanceSummary() {
  const q = useQuery({
    queryKey: ['governance', 'summary'],
    queryFn: () => requestJson<Summary>('/api/admin/governance/summary'),
  })
  return (
    <p aria-live="polite">
      {q.data
        ? '待受理 ' +
          q.data.pending +
          ' · 待复核 ' +
          q.data.review +
          ' · 待申诉处理 ' +
          q.data.appeals +
          ' · 逾期 ' +
          q.data.overdue
        : q.isError
          ? '待办统计暂不可用。'
          : '正在读取待办…'}
    </p>
  )
}
