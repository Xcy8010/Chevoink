import { z } from 'zod'
import {
  MAX_AGENT_FILE_BYTES_PDF,
  MAX_AGENT_FILE_COUNT,
  MAX_AGENT_IMAGE_COUNT,
} from './agent-attachments.js'

/**
 * P0 写操作路由请求体 schema（阶段 L 收编）
 *
 * 设计约定：
 * - Create 类必填字段保持必填；Update 类全 optional，未知字段静默剔除（strip 与 data 层字段白名单对齐）
 * - 400 文案由路由层 parseBody 的 fallbackMessage 统一提供（逐字保留历史文案），schema 自身不携带对外文案
 * - 枚举值与 contracts 手写类型一一对应，由 tests/unit/schemas.test.ts 的 expectTypeOf
 *   全等断言锁死，防止两处漂移
 */

/** 非空文本：对齐路由原 `!body.x?.trim()` 判定（空串与纯空白均拒绝，数值原样透传不做 trim 变换） */
const nonEmptyText = z.string().refine((value) => value.trim().length > 0)

const visibilitySchema = z.enum(['public', 'followers', 'private'])
const novelStatusSchema = z.enum(['draft', 'published', 'completed', 'archived'])
const chapterStatusSchema = z.enum(['draft', 'published', 'scheduled', 'archived'])

/* ---------------- novels ---------------- */

/** POST /api/novels（原校验：标题与简介 trim 后非空） */
export const createNovelSchema = z.object({
  title: nonEmptyText,
  displayTitle: z.string().optional(),
  summary: nonEmptyText,
  categoryId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  visibility: visibilitySchema.optional(),
  status: z.enum(['draft', 'published']).optional(),
})

/** PATCH /api/novels/:novelId（原路由零校验透传：仅错型拦截 + 字段白名单 strip，空值校验留在 data 层） */
export const updateNovelSchema = z.object({
  title: z.string().optional(),
  displayTitle: z.string().optional(),
  summary: z.string().optional(),
  categoryId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  visibility: visibilitySchema.optional(),
  status: novelStatusSchema.optional(),
  pinned: z.boolean().optional(),
  coverAssetId: z.string().nullable().optional(),
  coverPrompt: z.string().nullable().optional(),
})

/** PATCH /api/novels/:novelId/cover（原校验：coverDataUrl trim 后非空） */
export const uploadNovelCoverSchema = z.object({
  coverDataUrl: nonEmptyText,
})

/** POST /api/novels/:novelId/publish（chapterIds 缺省视为 []，visibility 缺省由路由补 'public'） */
export const publishNovelSchema = z.object({
  chapterIds: z.array(z.string().min(1)).default([]),
  visibility: visibilitySchema.optional(),
})

/** POST /api/novels/:novelId/chapters（原校验：标题 trim 后非空、content 仅拒缺省、status 必填） */
export const createChapterSchema = z.object({
  title: nonEmptyText,
  summary: z.string().optional(),
  content: z.string(),
  status: chapterStatusSchema,
  visibility: visibilitySchema.optional(),
  volumeId: z.string().min(1).optional(),
  orderInVolume: z.number().int().positive().optional(),
})

/** PATCH /api/novels/:novelId/chapters/:chapterId（原路由零校验透传：同 updateNovelSchema 策略） */
export const updateChapterSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  status: chapterStatusSchema.optional(),
  visibility: visibilitySchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
})

/* ---------------- posts / comments ---------------- */

/** POST /api/posts（配图张数上限校验留在路由层：文案含动态数量） */
export const createPostSchema = z.object({
  content: nonEmptyText,
  topicId: z.string().optional(),
  imageUrls: z.array(z.string()).optional(),
  imageDataUrls: z.array(z.string()).optional(),
  relatedNovelId: z.string().optional(),
  sharedUserId: z.string().optional(),
})

/** POST /api/comments（rating/paragraphIndex 的业务校验留在 data 层） */
export const createCommentSchema = z.object({
  targetType: z.enum(['novel', 'chapter', 'post']),
  targetId: nonEmptyText,
  content: nonEmptyText,
  parentId: z.string().optional(),
  rating: z.number().optional(),
  paragraphIndex: z.number().nullable().optional(),
})

/* ---------------- agent ---------------- */

const agentAttachmentMetaSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(['image', 'file']),
  name: z.string().trim().min(1).max(255),
  url: z.string().max(500).startsWith('/api/uploads/agent-attachments/'),
  size: z.number().int().nonnegative().max(MAX_AGENT_FILE_BYTES_PDF).optional(),
})

const agentAttachmentsSchema = z.array(agentAttachmentMetaSchema)
  .max(MAX_AGENT_IMAGE_COUNT + MAX_AGENT_FILE_COUNT)
  .superRefine((items, context) => {
    if (items.filter((item) => item.kind === 'image').length > MAX_AGENT_IMAGE_COUNT) {
      context.addIssue({ code: 'custom', message: '参考图数量超过上限。' })
    }
    if (items.filter((item) => item.kind === 'file').length > MAX_AGENT_FILE_COUNT) {
      context.addIssue({ code: 'custom', message: '文件数量超过上限。' })
    }
  })

/** POST /api/agent/runs（原校验：四字段齐全；mode 管道保留但后端恒 build，见 agent.ts） */
export const startAgentLoopRunSchema = z.object({
  sessionId: z.string().min(1),
  novelId: z.string().min(1),
  chapterId: z.string().nullable().optional(),
  mode: z.enum(['plan', 'build', 'review']),
  prompt: nonEmptyText.and(z.string().max(20_000)),
  selection: z
    .object({
      text: z.string().max(200_000),
      start: z.number().optional(),
      end: z.number().optional(),
    })
    .nullable()
    .optional(),
  attachments: agentAttachmentsSchema.optional(),
  creativeFreedom: z.enum(['stable', 'balanced', 'bold']).optional(),
  qualityMode: z.enum(['balanced', 'premium']).optional(),
  modelTier: z.enum(['lite', 'speed', 'standard', 'performance', 'ultimate', 'custom']).optional(),
  customModelId: z.string().trim().min(1).max(64).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** 作者手动指定的技能；上限 3 个，避免一次性把上下文填满。 */
  pinnedSkillIds: z.array(z.string().trim().min(1).max(120)).max(3).optional(),
  pinnedSubagentId: z.string().trim().min(1).max(64).optional(),
})

/** POST /api/agent/runs/:runId/continue（可选：续跑跟随作者当前的模型选择；缺省沿用原任务档位） */
export const continueAgentLoopRunSchema = z.object({
  modelTier: z.enum(['lite', 'speed', 'standard', 'performance', 'ultimate', 'custom']).optional(),
  customModelId: z.string().trim().min(1).max(64).nullable().optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
})

/** POST /api/agent/runs/:runId/approvals（原校验：callId 真值 + approved 为布尔） */
export const resolveAgentApprovalSchema = z.object({
  callId: z.string().min(1),
  approvalId: z.string().min(1).max(64).optional(),
  approved: z.boolean(),
  alwaysAllow: z.boolean().optional(),
})

/** POST /api/agent/runs/:runId/questions（原校验：callId 真值 + answer trim 后非空） */
export const resolveAgentQuestionSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  callId: z.string().min(1),
  answer: nonEmptyText,
})

/** POST /api/agent/attachments（原校验：kind 真值 + name/dataUrl trim 后非空；kind 枚举收紧为 image|file） */
export const uploadAgentAttachmentSchema = z.object({
  kind: z.enum(['image', 'file']),
  name: nonEmptyText.and(z.string().max(255)),
  // 10MB PDF becomes ~13.4MB after base64; cap encoded input before decoding.
  dataUrl: nonEmptyText.and(z.string().max(15_000_000)),
})
