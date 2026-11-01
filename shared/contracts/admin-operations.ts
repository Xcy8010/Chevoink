import { z } from 'zod'
import type { Pagination } from './models.js'

const filter = z.string().trim().min(1).max(160).optional()
const windowFields = { period: z.enum(['today', 'week', 'month']).default('today'), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), model: filter, provider: filter, runId: filter, taskId: filter }
const pageFields = { page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }
const callFields = { ...windowFields, source: z.enum(['provider_attempts', 'usage', 'web_tools']).default('provider_attempts'), status: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,32}$/).optional(), errorCategory: z.enum(['known_failure', 'unknown_result', 'cancelled', 'billing_pending']).optional() }
function validWindow(value: { from?: string; to?: string }, context: z.RefinementCtx) {
  if (Boolean(value.from) !== Boolean(value.to) || (value.from && value.to && Date.parse(value.from) >= Date.parse(value.to))) context.addIssue({ code: 'custom', path: ['from'], message: '起止时间需成对提供，且开始早于结束。' })
}
export const adminOperationCallsQuerySchema = z.object({ ...callFields, ...pageFields }).strict().superRefine(validWindow)
export const adminOperationsHealthQuerySchema = z.object(callFields).strict().superRefine(validWindow)
export const adminOperationRunsQuerySchema = z.object({ ...windowFields, ...pageFields, status: z.enum(['queued', 'running', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled']).optional(), user: filter }).strict().superRefine(validWindow)
export type AdminOperationCallsQuery = z.infer<typeof adminOperationCallsQuerySchema>
export type AdminOperationsHealthQuery = z.infer<typeof adminOperationsHealthQuerySchema>
export type AdminOperationRunsQuery = z.infer<typeof adminOperationRunsQuerySchema>
export type AdminOperationSource = AdminOperationCallsQuery['source']
export type AdminOperationOutcome = 'success' | 'failure' | 'pending' | 'cancelled' | 'unknown'
export type AdminOperationsContext = {
  source: string
  coverage: string[]
  snapshotAt: string
  window: { from: string; to: string; timeZone: 'UTC+8'; boundary: 'created_at' }
}
export type AdminOperationCall = {
  id: string; source: AdminOperationSource; createdAt: string; provider: string | null; model: string | null; action: string | null
  runId: string | null; taskId: string | null; operationId: string | null; status: string | null; outcome: AdminOperationOutcome
  errorCategory: AdminOperationCallsQuery['errorCategory'] | null; billingStatus: string | null; usageSource: string | null
  requestTokens: number | null; responseTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null
  durationMs: number | null; chargedCreditsMilli: number | null
}
export type AdminOperationCallsPayload = AdminOperationsContext & { items: AdminOperationCall[]; pagination: Pagination }
export type AdminOperationRun = { id: string; taskId: string | null; status: string; action: string; modelTier: string; customModelId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; user: { id: string; nickname: string }; session: { id: string; title: string } }
export type AdminOperationRunsPayload = AdminOperationsContext & { items: AdminOperationRun[]; pagination: Pagination }
export type AdminOperationsHealthPayload = AdminOperationsContext & {
  observation: 'no_samples' | 'attention' | 'observed' | 'unknown'
  counts: { total: number; success: number; failure: number; pending: number; cancelled: number; unknown: number }
  lastSampleAt: string | null
  /** Existing receipts contain no reliable first-text/distribution samples. */
  firstTextMs: null; p50Ms: null; p95Ms: null; tokensPerSecond: null
}
