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

export type AdminYunshuRecordKind = 'all' | 'consume' | 'error' | 'refund'
export type AdminYunshuCall = {
  id: string; createdAt: string; modelName: string; group: string | null
  kind: Exclude<AdminYunshuRecordKind, 'all'>; requestId: string | null
  requestTokens: number | null; responseTokens: number | null
  durationMs: number | null; streamOutcome: 'ok' | 'error' | 'unknown'; quota: string | null
}
export type AdminYunshuAuxState = 'not_requested' | 'unconfigured' | 'ready' | 'stale' | 'error'
export type AdminYunshuOperations = Omit<AdminYunshuModelUsage, 'models'> & {
  records: { items: AdminYunshuCall[]; page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean; totalObserved: number; kind: AdminYunshuRecordKind }
  health: { observation: 'no_samples' | 'attention' | 'observed'; consumeCount: number; errorCount: number; refundCount: number; streamSuccessCount: number; streamErrorCount: number; unknownOutcomeCount: number; durationSamples: number; p50Ms: number | null; p95Ms: number | null; lastSampleAt: string | null }
  cost: { deductionQuota: string | null; refundQuota: string | null; netQuota: string | null; unknownDeductionCount: number; unknownRefundCount: number;
    display: { state: AdminYunshuAuxState; observedAt: string | null; message: string; quotaPerUnit: number | null; type: 'USD' | 'CNY' | 'CUSTOM' | 'TOKENS' | null; rate: number | null; symbol: string | null; deduction: string | null; refund: string | null; net: string | null } }
  balance: { scope: 'management_account'; state: AdminYunshuAuxState; observedAt: string | null; message: string; remainingQuota: string | null; usedQuota: string | null; displayRemaining: string | null; displayUsed: string | null }
}
export type AdminYunshuOperationsQuery = { period: AdminYunshuUsagePeriod; page: number; pageSize: number; kind: AdminYunshuRecordKind; view: 'records' | 'health' | 'cost' }
