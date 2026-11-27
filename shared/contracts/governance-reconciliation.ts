export type GoalReceipt = { goalId: string; runId: string; creditsMicros: string; reservedTokens: string; status: string }
export type FixedFeeReceipt = {
  id: string; userId: string; actionId: string | null; sourceType: string; expectedMilli: number | null; chargedMilli: number
  refundMilli: number | null; refundPending: boolean; goal: GoalReceipt | null
}
export type ReconciliationRow = {
  goal?: GoalReceipt | null
  upstreamId: string | null
  observedAt: string
  userId: string | null
  actionId: string | null
  state: 'unknown' | 'matched' | 'pending' | 'provider_error' | 'refunded' | 'difference'
  reason: string
  expectedMilli: number | null
  chargedMilli: number | null
  refundMilli: number | null
}
export type GovernanceReconciliation = {
  observedAt: string | null
  message: string
  page: number
  hasMore: boolean
  fixedFees: FixedFeeReceipt[]
  rows: ReconciliationRow[]
}
