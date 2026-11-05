import { z } from 'zod'

/** The main Agent interprets the human request; the server resolves identities. */
export const agentWritingScopeInputSchema = z.object({
  intent: z.enum(['write', 'revise', 'review']),
  targets: z.array(z.object({ chapterId: z.string().min(1).optional(), orderIndex: z.number().int().positive().optional(),
    preserveText: z.array(z.string().min(1)).default([]),
  }).strict().refine(target => target.chapterId !== undefined || target.orderIndex !== undefined, '请提供真实章节编号或全书序号')).min(1).max(1000),
  locality: z.enum(['chapter', 'local']).default('chapter'),
  requiredChecks: z.array(z.enum(['continuity', 'humanity'])).default(['continuity', 'humanity']),
}).strict().refine(input => input.targets.every(target => !target.preserveText.length) || input.locality === 'local',
  '明确保留原文须使用local精确修改')
export type AgentWritingScopeInput = z.infer<typeof agentWritingScopeInputSchema>
