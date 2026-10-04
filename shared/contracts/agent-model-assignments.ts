import { z } from 'zod'
import { BUILT_IN_MODEL_TIERS } from './credits.js'

export const MODEL_ASSIGNMENT_TASKS = [
  { key: 'main', label: '主 Agent', kind: 'text' },
  { key: 'chapter_writing', label: '正文写作', kind: 'text' },
  { key: 'subagent', label: '子 Agent', kind: 'text' },
  { key: 'spawned_task', label: '派生任务', kind: 'text' },
  { key: 'continuity', label: '连续性检查', kind: 'text' },
  { key: 'quality', label: '质量检查', kind: 'text' },
  { key: 'creative_critique', label: '创作评审', kind: 'text' },
  { key: 'creative_revision', label: '局部修订', kind: 'text' },
  { key: 'research_synthesis', label: '研究综合', kind: 'text' },
  { key: 'style_learning', label: '风格学习', kind: 'text' },
  { key: 'memory_graph', label: '关系网', kind: 'text' },
  { key: 'publish_advice', label: '发布建议', kind: 'text' },
  { key: 'session_title', label: '任务命名', kind: 'text' },
  { key: 'cover_prompt', label: '封面提示词', kind: 'text' },
  { key: 'import_analysis', label: '导入识别', kind: 'text' },
  { key: 'vision', label: '图片理解', kind: 'vision' },
] as const
export type ModelAssignmentTask = typeof MODEL_ASSIGNMENT_TASKS[number]['key']
export const modelAssignmentTaskSchema = z.enum(MODEL_ASSIGNMENT_TASKS.map(item => item.key) as [ModelAssignmentTask, ...ModelAssignmentTask[]])
export const modelReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const agentModelSelectionSchema = z.object({
  modelTier: z.enum([...BUILT_IN_MODEL_TIERS, 'custom']),
  customModelId: z.string().trim().min(1).max(64).optional(),
  reasoningEffort: modelReasoningEffortSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.modelTier === 'custom' && !value.customModelId) ctx.addIssue({ code: 'custom', path: ['customModelId'], message: '请选择自定义模型。' })
  if (value.modelTier !== 'custom' && value.customModelId) ctx.addIssue({ code: 'custom', path: ['customModelId'], message: '内置模型不能指定自定义模型。' })
})
export type AgentModelSelection = z.infer<typeof agentModelSelectionSchema>
export const modelAssignmentsSchema = z.partialRecord(modelAssignmentTaskSchema, agentModelSelectionSchema)
export type ModelAssignments = z.infer<typeof modelAssignmentsSchema>
export const frozenModelAssignmentsSchema = z.object({ version: z.literal(1), globalRevision: z.number().int().nonnegative(),
  novelRevision: z.number().int().nonnegative(), assignments: modelAssignmentsSchema,
  sources: z.partialRecord(modelAssignmentTaskSchema, z.enum(['global', 'novel'])).optional() }).strict()
export type FrozenModelAssignments = z.infer<typeof frozenModelAssignmentsSchema>
export const patchModelAssignmentsSchema = z.object({ scope: z.enum(['global', 'novel']), novelId: z.string().trim().min(1).max(64).optional(),
  expectedRevision: z.number().int().nonnegative().max(2147483646),
  assignments: z.partialRecord(modelAssignmentTaskSchema, agentModelSelectionSchema.nullable()),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'novel' && !value.novelId || value.scope === 'global' && value.novelId) {
    ctx.addIssue({ code: 'custom', path: ['novelId'], message: '模型分配作用域无效。' })
  }
})
export type PatchModelAssignments = z.infer<typeof patchModelAssignmentsSchema>
export type ModelAssignmentsPayload = {
  version: 1
  global: { revision: number; assignments: ModelAssignments }
  novel: { revision: number; assignments: ModelAssignments } | null
  effective: Partial<Record<ModelAssignmentTask, { selection: AgentModelSelection; source: 'global' | 'novel' }>>
}
