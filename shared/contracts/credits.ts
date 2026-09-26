/**
 * 模型档位：五档用户可选 + basic 基础模型（后台轻量文本任务专用，不进用户侧选择器） + custom 自定义模型。
 * basic 承载关系网生成、导出建议等非对话任务，与用户侧体验档位解耦，
 * 管理员可在模型管理页独立配置其模型与 Credits 倍率；未配置时服务端自动回退 speed。
 */
export type CreditModelTier = 'lite' | 'speed' | 'standard' | 'performance' | 'ultimate' | 'basic' | 'custom'

/** 用户侧可选档位（产品语义顺序固定，不随管理员调整的 Credits 倍率漂移）。basic 不在列。 */
export const BUILT_IN_MODEL_TIERS = ['lite', 'speed', 'standard', 'performance', 'ultimate'] as const

/** 全部服务端内置档位（含后台轻任务档）。 */
export const SERVER_MODEL_TIERS = [...BUILT_IN_MODEL_TIERS, 'basic'] as const

/** OpenAI-compatible providers expose different subsets; the server validates per model. */
export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type CreditModelOption = {
  freePromotion?: import('../model-promotion.js').ModelPromotion | null
  pricing?: CreditLedgerItem['pricing']
  tier: Exclude<CreditModelTier, 'custom'>
  label: string
  multiplier: number
  available: boolean
  selectedByDefault: boolean
  reasoningEfforts: ModelReasoningEffort[]
  defaultReasoningEffort: ModelReasoningEffort
  visionEnabled: boolean
}

export type CreditAccountSummary = {
  plan: 'public_beta'
  planLabel: '公测版'
  dailyAllowance: number
  dailyUsed: number
  dailyRemaining: number
  bonusRemaining: number
  totalRemaining: number
  /** Available balance excludes temporary reservations; reservations are not charges. */
  reserved?: number
  balance?: number
  usedPercent: number
  periodStartedAt: string
  resetsAt: string
  resetTimeZone: 'UTC+8'
  globallyPaused: boolean
  suspended: boolean
  models: CreditModelOption[]
}

export type CreditLedgerItem = {
  estimatedUsage?: boolean
  /** Original settled price; never today's model configuration. */
  pricing?: { version: 'credits-v2-itemized'; rateCardId: string; inputPerMillion: number; cachePerMillion: number; outputPerMillion: number; v1CeilingMultiplier?: number } | null
  id: string
  delta: number
  kind: string
  sourceType: string
  referenceId: string | null
  /** Verified task linkage; null/absent for non-task or unlinked legacy charges. */
  taskRunId?: string | null
  modelTier: CreditModelTier | null
  multiplier: number
  requestTokens: number | null
  responseTokens: number | null
  /** 缓存命中输入 token（供应商未返回或旧记录为 null） */
  promptCacheHitTokens: number | null
  promptCacheMissTokens: number | null
  createdAt: string
}

export type CreditUsagePayload = {
  account: CreditAccountSummary
  ledger: CreditLedgerItem[]
}

export type TaskCreditUsagePayload = {
  runId: string
  asOf: string
  /** Recorded wallet movements only; not a claim that unknown provider cost is zero. */
  charged: number
  refunded: number
  netCharged: number
  pendingRefund: number
  /** New default-path calls with a frozen price but no completed wallet settlement. */
  pendingModelSettlements?: number
  unresolvedProviderAttempts: number | null
  ledger: CreditLedgerItem[]
  nextCursor: string | null
}

export type CreditActivityDay = {
  date: string
  creditsSpent: number
  eventCount: number
}

export type CreditModelActivity = {
  /** 仅返回产品档位名称，禁止透出供应商或底层模型 ID。 */
  label: string
  calls: number
  creditsSpent: number
  tokens: number
}

/** 个人资料页的全量真实使用画像；统计起点受 Credits 账本上线时间约束。 */
export type CreditActivityPayload = {
  account: CreditAccountSummary
  stats: {
    generatedAt: string
    ledgerStartedAt: string | null
    activityStartedAt: string
    activityEndsAt: string
    cumulativeSpent: number
    cumulativeEarned: number
    peakDailySpent: number
    totalTokens: number
    totalModelCalls: number
    agentRuns: number
    activeDays: number
    currentStreakDays: number
    longestStreakDays: number
    cacheHitRate: number | null
    activity: CreditActivityDay[]
    modelUsage: CreditModelActivity[]
  }
}

export type ReferralPayload = {
  code: string
  inviteUrl: string
  inviterReward: 300
  inviteeReward: 120
  successfulInvites: number
  totalEarned: number
}

export type CustomModelView = {
  id: string
  provider: string
  displayName: string
  modelName: string
  baseUrl: string | null
  apiKeyConfigured: boolean
  enabled: boolean
  reasoningEfforts: ModelReasoningEffort[]
  defaultReasoningEffort: ModelReasoningEffort
  visionEnabled: boolean
  /** Agent 可用上下文窗口；为空时沿用服务端安全默认值。 */
  contextWindowTokens: number | null
  createdAt: string
  updatedAt: string
}

export type CustomModelsPayload = { models: CustomModelView[] }

export type SaveCustomModelRequest = {
  provider: string
  displayName: string
  modelName: string
  baseUrl: string
  apiKey?: string
  enabled?: boolean
  reasoningEfforts?: ModelReasoningEffort[]
  defaultReasoningEffort?: ModelReasoningEffort
  visionEnabled?: boolean
  contextWindowTokens?: number
}
