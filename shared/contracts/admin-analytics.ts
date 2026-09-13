export type AdminAnalyticsPeriod = 'day' | 'week' | 'month'
export type AdminAnalyticsPayload = {
  period: AdminAnalyticsPeriod
  from: string
  to: string
  labels: string[]
  metrics: Array<{ key: string; label: string; values: number[]; total: number; unavailable?: boolean }>
  cost?: { knownCalls: number; unknownCalls: number; models: Array<{ provider: string; model: string; estimated: number; knownCalls: number; unknownCalls: number }> }
  tools: Array<{ name: string; calls: number; failed: number; succeeded: number; unknown: number }>
  imports?: { jobs: number; previewed: number; failedBeforePreview: number; committed: number; cancelled: number; restored: number; failures: Array<{ code: string; count: number }> }
}
