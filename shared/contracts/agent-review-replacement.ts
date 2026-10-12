import type { CreditModelTier, ModelReasoningEffort } from './credits.js'

/** Read-only preview of a fresh, explicit author action. This grants no dispatch. */
export type AgentReviewReplacementQuote = {
  quoteToken: string
  authorizationId: string
  expiresAt: string
  chapterId: string
  currentRevision: number
  currentModel: { modelTier: CreditModelTier; customModelId: string | null; reasoningEffort: ModelReasoningEffort;
    modelName: string; label: string; multiplierBps: number }
  maximumCreditMilli: number
}

export type AgentReviewReplacementStatus = {
  authorizationId: string
  state: 'running' | 'waiting_confirmation' | 'complete' | 'incomplete'
  reportId?: string | null
  message: string
}
