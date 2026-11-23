import { z } from 'zod'

export const userDirectiveSchema = z.object({
  id: z.string().min(1),
  novelId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  volumeId: z.string().min(1).nullable(),
  chapterId: z.string().min(1).nullable(),
  taskSpecId: z.string().min(1).nullable(),
  scope: z.enum(['global', 'volume', 'chapter', 'task']),
  kind: z.enum(['goal', 'must', 'must_not', 'preference', 'decision']),
  text: z.string().min(1),
  status: z.enum(['active', 'fulfilled', 'superseded', 'cancelled']),
  sourceMessageId: z.string().min(1),
  supersededBy: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const contextCheckpointSummarySchema = z.object({
  goals: z.array(z.string()),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  completed: z.array(z.string()),
  pending: z.array(z.string()),
  toolReceipts: z.array(z.object({ toolName: z.string(), summary: z.string(), artifactId: z.string().nullable() })),
  directiveIds: z.array(z.string()),
})

export const contextCheckpointSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  sourceMessageCount: z.number().int().positive(),
  sourceTokens: z.number().int().nonnegative(),
  summaryTokens: z.number().int().nonnegative(),
  model: z.string().min(1),
  version: z.number().int().positive(),
  sourceHash: z.string().length(64),
  summary: contextCheckpointSummarySchema,
  validation: z.object({
    hardConstraintRetention: z.number().min(0).max(1),
    missingDirectiveIds: z.array(z.string()),
    valid: z.boolean(),
  }),
  createdAt: z.string().datetime(),
})

/** Measured on the assembled input, before dispatch. Independent of billing totals. */
export const contextUsageSchema = z.object({
  estimatedTokens: z.number().int().nonnegative(),
  contextWindowTokens: z.number().int().positive(),
  compactAtTokens: z.number().int().nonnegative(),
})
export type ContextUsage = z.infer<typeof contextUsageSchema>

export const contextStateSchema = z.object({
  requestSample: z.object({ runId: z.string(), seq: z.number().int().positive(), sampledAt: z.string().datetime().optional() }).optional(),
  estimatedTokens: z.number().int().nonnegative(),
  contextWindowTokens: z.number().int().positive(),
  usageRatio: z.number().min(0),
  warningThreshold: z.number().min(0).max(1),
  compactionThreshold: z.number().min(0).max(1),
  activeDirectiveCount: z.number().int().nonnegative(),
  checkpoint: contextCheckpointSchema.nullable(),
})

/** 上下文详情弹窗的单条对话记录：token 估算 + 是否在当前上下文窗口内 */
export const contextDetailRecordSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  createdAt: z.string().datetime(),
  estimatedTokens: z.number().int().nonnegative(),
  excerpt: z.string(),
  inWindow: z.boolean(),
})

const contextDetailPageMeta = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
}

/** 上下文详情三视图：上下文记录 / 压缩记录 / 最终上下文（大量数据均分页返回） */
export const contextDetailSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('records'), items: z.array(contextDetailRecordSchema), ...contextDetailPageMeta }),
  z.object({ view: z.literal('checkpoints'), items: z.array(contextCheckpointSchema), ...contextDetailPageMeta }),
  z.object({
    view: z.literal('final'),
    estimatedTokens: z.number().int().nonnegative(),
    checkpointTokens: z.number().int().nonnegative(),
    checkpointDigest: z.string().nullable(),
    directiveDigest: z.string().nullable(),
    window: z.object({ items: z.array(contextDetailRecordSchema), ...contextDetailPageMeta }),
  }),
])

export type UserDirective = z.infer<typeof userDirectiveSchema>
export type ContextCheckpointSummary = z.infer<typeof contextCheckpointSummarySchema>
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>
export type ContextState = z.infer<typeof contextStateSchema>
export type ContextDetailRecord = z.infer<typeof contextDetailRecordSchema>
export type ContextDetail = z.infer<typeof contextDetailSchema>
