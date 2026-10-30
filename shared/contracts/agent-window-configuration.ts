import { z } from 'zod'
import { agentModelSelectionSchema } from './agent-model-assignments.js'

export const agentWindowConfigurationSchema = z.object({
  model: agentModelSelectionSchema.nullable().default(null),
  creativeFreedom: z.enum(['stable', 'balanced', 'bold']).default('balanced'),
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
