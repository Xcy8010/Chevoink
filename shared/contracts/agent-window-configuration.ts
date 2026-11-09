import { z } from 'zod'
import { agentModelSelectionSchema } from './agent-model-assignments.js'
import type { CreativeFreedom } from './agent-events.js'

export const DEFAULT_CREATIVE_FREEDOM = 'stable' satisfies CreativeFreedom
export const CREATIVE_FREEDOM_LABELS = { stable: '平衡创作', balanced: '严谨创作', bold: '大胆创作' } satisfies Record<CreativeFreedom, string>
export const CREATIVE_FREEDOM_DESCRIPTIONS = {
  stable: '默认。兼顾情节、节奏和文风。',
  balanced: '细查因果和设定，直接修正明确问题。',
  bold: '尝试新视角、新场景和新写法。',
} satisfies Record<CreativeFreedom, string>

export const agentWindowConfigurationSchema = z.object({
  model: agentModelSelectionSchema.nullable().default(null),
  creativeFreedom: z.enum(['stable', 'balanced', 'bold']).default(DEFAULT_CREATIVE_FREEDOM),
}).strict()
export type AgentWindowConfiguration = z.infer<typeof agentWindowConfigurationSchema>
export const patchAgentWindowConfigurationSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(2147483646),
  model: agentModelSelectionSchema.nullable().optional(),
  creativeFreedom: z.enum(['stable', 'balanced', 'bold']).optional(),
}).strict().refine(value => value.model !== undefined || value.creativeFreedom !== undefined, '请选择需要更新的窗口配置。')
export type PatchAgentWindowConfiguration = z.infer<typeof patchAgentWindowConfigurationSchema>
export type AgentWindowConfigurationPayload = {
  sessionId: string
  novelId: string
  title: string
  revision: number
  configuration: AgentWindowConfiguration
  source?: 'saved' | 'last_run' | 'default'
  modelSelectionSource?: 'explicit' | 'inherited' | 'unknown'
}
