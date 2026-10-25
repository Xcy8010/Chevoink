import { z } from 'zod'
import type { CreditModelTier, ModelReasoningEffort } from './credits.js'

export const submitManualReviewRepairSchema = z.object({ intent: z.literal('repair_failed_review_once'), quoteToken: z.string().min(1).max(16384) }).strict()
export type ManualReviewRepairStatus = {
  operationId: string
  eventStartSeq: number
  state: 'running' | 'unknown' | 'incomplete' | 'complete'
  reportId: string | null
  terminalCommitted: boolean
  needsContinuation: boolean
  canResume?: boolean
  message: string
}
export type ManualReviewRepairPreview = { eligible: boolean; status: ManualReviewRepairStatus | null; message: string }
export type ManualReviewRepairQuote = {
  operationId: string; quoteToken: string; expiresAt: string; chapterId: string; currentRevision: number
  model: { modelTier: CreditModelTier; customModelId: string | null; reasoningEffort: ModelReasoningEffort; modelName: string; label: string }
  maximumCreditMilli: number; maxProviderDispatches: 0 | 1; recoveryOnly?: boolean
}
