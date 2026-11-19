import { z } from 'zod'

/** 记忆证据必须能回到原文、对话或人工输入，避免模型推断升级成无来源事实。 */
export const memoryEvidenceSchema = z.object({
  id: z.string().min(1),
  memoryId: z.string().min(1),
  sourceType: z.enum(['chapter', 'volume', 'message', 'author_input', 'artifact']),
  sourceId: z.string().min(1),
  revision: z.number().int().positive().optional(),
  span: z
    .object({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      quoteHash: z.string().min(1).optional(),
    })
    .refine((span) => span.end >= span.start, {
      message: 'span.end 必须大于等于 span.start',
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
})

export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>

export const storyMemoryStatusSchema = z.enum(['confirmed', 'inferred', 'conflicted', 'superseded', 'invalid'])
export const memoryReviewStatusSchema = z.enum(['none', 'pending', 'accepted', 'rejected'])

export const memorySearchHitSchema = z.object({
  id: z.string().min(1),
  identityKey: z.string().optional(),
  memoryType: z.string().min(1),
  layer: z.enum(['L0', 'L1', 'L2', 'L3']),
  status: storyMemoryStatusSchema,
  title: z.string(),
  content: z.string(),
  score: z.number(),
  lexicalScore: z.number(),
  semanticScore: z.number(),
  graphScore: z.number(),
  evidence: z.array(memoryEvidenceSchema),
})

export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>

export const memoryGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable(),
  status: storyMemoryStatusSchema,
  aliases: z.array(z.string()),
  updatedAt: z.string().datetime(),
})

export const memoryGraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
  state: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  sourceId: z.string().min(1),
})

/** 创作区关系图是现有实体记忆的只读投影，不形成第二份事实来源。 */
export const memoryGraphSchema = z.object({
  novelId: z.string().min(1),
  version: z.string().min(1),
  updatedAt: z.string().datetime(),
  nodes: z.array(memoryGraphNodeSchema),
  edges: z.array(memoryGraphEdgeSchema),
})

export type MemoryGraphNode = z.infer<typeof memoryGraphNodeSchema>
export type MemoryGraphEdge = z.infer<typeof memoryGraphEdgeSchema>
export type MemoryGraph = z.infer<typeof memoryGraphSchema>

export const storyMemoryPatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().trim().min(1).optional(),
  importance: z.number().int().min(1).max(100).optional(),
  expectedVersion: z.number().int().positive(),
})
export const storyMemoryDeleteSchema = z.object({ expectedVersion: z.number().int().positive() })

export const memoryGraphJobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed'])
export type MemoryGraphJobStatus = z.infer<typeof memoryGraphJobStatusSchema>

/** 记忆中心卡片：Agent 沉淀的创作记忆（人物/世界观/情节等）的只读投影 + 作者就地编辑入口。 */
export const storyMemoryCardSchema = z.object({
  id: z.string().min(1),
  sourceChapter: z.object({ id: z.string().min(1), title: z.string() }).optional(),
  appearances: z.array(z.object({ id: z.string().min(1), title: z.string() })).optional(),
  memoryType: z.string().min(1),
  layer: z.enum(['L0', 'L1', 'L2', 'L3']),
  title: z.string(),
  content: z.string(),
  importance: z.number().int().min(0).max(100),
  status: storyMemoryStatusSchema,
  version: z.number().int().nonnegative(),
  reviewStatus: memoryReviewStatusSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const storyMemoryListSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(storyMemoryCardSchema),
  typeCounts: z.record(z.string(), z.number().int().nonnegative()),
})

export type StoryMemoryCard = z.infer<typeof storyMemoryCardSchema>
export type StoryMemoryList = z.infer<typeof storyMemoryListSchema>

/** 记忆卡片集封面：一个类型一叠牌，封面墙一次拿全，避免 N+1 */
export const storyMemorySetSchema = z.object({
  memoryType: z.string().min(1),
  count: z.number().int().nonnegative(),
  latestUpdatedAt: z.string().datetime(),
  previews: z.array(z.string()),
})

export const storyMemorySetsSchema = z.object({
  sets: z.array(storyMemorySetSchema),
})

export type StoryMemorySet = z.infer<typeof storyMemorySetSchema>
export type StoryMemorySets = z.infer<typeof storyMemorySetsSchema>

export const memoryGraphJobSchema = z.object({
  jobId: z.string().min(1),
  novelId: z.string().min(1),
  status: memoryGraphJobStatusSchema,
  totalChunks: z.number().int().min(0),
  doneChunks: z.number().int().min(0),
  error: z.string().nullable().optional(),
})
export type MemoryGraphJob = z.infer<typeof memoryGraphJobSchema>
