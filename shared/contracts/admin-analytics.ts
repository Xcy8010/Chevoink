export type AdminAnalyticsPeriod = 'day' | 'week' | 'month'
export type AdminAnalyticsPayload = {
  period: AdminAnalyticsPeriod
  from: string
  to: string
  labels: string[]
  metrics: Array<{ key: string; label: string; values: number[]; total: number }>
  tools: Array<{ name: string; calls: number; failed: number; succeeded: number; unknown: number }>
}
