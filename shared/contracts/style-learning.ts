import { z } from 'zod'

export const STYLE_DIMENSIONS = ['叙述视角', '语言与句式', '对白', '场景与格式', '节奏与冲突', '悬念与转折', '人物塑造'] as const
export const styleRuleSchema = z.object({
  dimension: z.enum(STYLE_DIMENSIONS),
  rule: z.string().trim().min(1).max(300),
  evidence: z.string().trim().min(1).max(160),
})
export const styleAnalysisSchema = z.object({ rules: z.array(styleRuleSchema).max(14) })
export const styleModelSelectionSchema = z.object({
  modelTier: z.enum(['lite', 'speed', 'standard', 'performance', 'ultimate', 'custom']),
  customModelId: z.string().min(1).max(64).nullable().default(null),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
}).refine(value => value.modelTier !== 'custom' || Boolean(value.customModelId), '请选择自定义模型')
export const startStyleLearningSchema = z.object({
  requestId: z.string().uuid(), profileId: z.string().min(1).max(64),
  model: z.object({ ...styleModelSelectionSchema.shape, reasoningEffort: styleModelSelectionSchema.shape.reasoningEffort.optional() })
    .refine(value => value.modelTier !== 'custom' || Boolean(value.customModelId), '请选择自定义模型').optional(), consent: z.literal(true),
})
export const changeStyleLearningSchema = z.object({
  revision: z.number().int().nonnegative(),
  action: z.enum(['pause', 'resume', 'retry', 'enable', 'disable']),
  rules: z.array(styleRuleSchema).min(1).max(48).optional(),
  consent: z.literal(true).optional(),
}).refine(v => v.action !== 'retry' || v.consent === true, '重试可能再次计费，需要确认')
export type StyleModelSelection = z.infer<typeof styleModelSelectionSchema>
export type StartStyleLearning = z.infer<typeof startStyleLearningSchema>
export type ChangeStyleLearning = z.infer<typeof changeStyleLearningSchema>
export type StyleRule = z.infer<typeof styleRuleSchema>
export type StyleLearningView = {
  id: string; profileId: string; status: string; revision: number; enabled: boolean
  processed: number; total: number; pauseRequested: boolean; modelLabel: string
  rules: StyleRule[]; reports: { chunk: number; rules: StyleRule[] }[]
  error: string | null; updatedAt: string
}
export type StyleSampleView = {
  id: string; sourceId: string; name: string; createdAt: string
  files: { name: string; chars: number }[]; canLearn: boolean; chars: number
}
export type StyleLearningWorkspace = { samples: StyleSampleView[]; jobs: StyleLearningView[]; privateStyleEnabled: boolean }
