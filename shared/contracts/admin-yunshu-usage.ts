export type AdminYunshuUsagePeriod = 'today' | 'week' | 'month'
export type AdminYunshuModelUsage = {
  source: 'yunshu_admin_logs'
  scope: 'configured_platform_tokens'
  period: AdminYunshuUsagePeriod
  window: { from: string; to: string }
  observedAt: string | null
  state: 'unconfigured' | 'ready' | 'partial' | 'stale' | 'error'
  coverage: 'partial'
  paginationComplete: boolean
  message: string
  lastAttemptAt: string | null
  sources: { configured: number; verified: number; unresolved: number }
  models: Array<{
    modelName: string; group: string | null; requestCount: number
    requestTokens: number | null; responseTokens: number | null
    cacheHitTokens: number | null; cacheWriteTokens: number | null
    errorCount: number; refundCount: number
  }>
}
