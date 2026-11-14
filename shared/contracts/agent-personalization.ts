import { z } from 'zod'

export const AGENT_PERSONALIZATION_LIMITS = {
  customInstructions: 2_000,
  memoryText: 500,
  activeMemories: 50,
} as const

export const AGENT_PERSONALIZATION_MEMORY_PROTOCOL = '2'

export const agentPersonalizationStyleSchema = z.enum(['natural', 'professional', 'direct', 'partner'])
export const agentPersonalizationDegreeSchema = z.enum(['less', 'default', 'more'])
export const agentPersonalizationRevisionSchema = z.number().int().nonnegative().max(2_147_483_646)

const authorText = (max: number) => z.string().trim().max(max)
const hasNoNull = (value: string) => !value.includes('\u0000')
const settingsSchema = z.object({
  memoryEnabled: z.boolean(),
  customInstructions: authorText(AGENT_PERSONALIZATION_LIMITS.customInstructions).refine(hasNoNull),
  style: agentPersonalizationStyleSchema,
  warmth: agentPersonalizationDegreeSchema,
  enthusiasm: agentPersonalizationDegreeSchema,
  detail: agentPersonalizationDegreeSchema,
  emoji: agentPersonalizationDegreeSchema,
  format: agentPersonalizationDegreeSchema,
}).strict()

export type AgentPersonalizationSettings = z.infer<typeof settingsSchema>

export const DEFAULT_AGENT_PERSONALIZATION_SETTINGS: Readonly<AgentPersonalizationSettings> = {
  memoryEnabled: true,
  customInstructions: '',
  style: 'natural',
  warmth: 'default',
  enthusiasm: 'default',
  detail: 'default',
  emoji: 'less',
  format: 'default',
}

export type AgentPersonalizationPayload = {
  settings: AgentPersonalizationSettings
  revision: number
  rules: AgentPersonalizationRule[]
}

export const patchAgentPersonalizationSchema = settingsSchema.partial()
  .extend({ expectedRevision: agentPersonalizationRevisionSchema })
  .refine(value => Object.entries(value).some(([key, field]) => key !== 'expectedRevision' && field !== undefined))
export type PatchAgentPersonalization = z.infer<typeof patchAgentPersonalizationSchema>

export const agentPersonalizationMemoryTextSchema = authorText(2 * AGENT_PERSONALIZATION_LIMITS.memoryText).min(1)
  .refine(value => hasNoNull(value) && Array.from(value).length <= AGENT_PERSONALIZATION_LIMITS.memoryText)
export const agentPersonalizationMemoryIdSchema = z.string().min(1).max(64)
export const agentPersonalizationExpectedRevisionSchema = z.object({ expectedRevision: agentPersonalizationRevisionSchema }).strict()
export const createAgentPersonalizationMemorySchema = z.object({
  text: agentPersonalizationMemoryTextSchema,
  pinned: z.boolean().optional(),
}).strict()
export const patchAgentPersonalizationMemoryFields = createAgentPersonalizationMemorySchema.partial().extend(agentPersonalizationExpectedRevisionSchema.shape)
export const patchAgentPersonalizationMemorySchema = patchAgentPersonalizationMemoryFields
  .refine(value => value.text !== undefined || value.pinned !== undefined)
export type PatchAgentPersonalizationMemory = z.infer<typeof patchAgentPersonalizationMemorySchema>

export const agentPersonalizationRuleNameSchema = z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)
export const agentPersonalizationRuleSchema = z.object({
  toolName: agentPersonalizationRuleNameSchema,
  permission: z.enum(['allow', 'ask', 'deny']),
}).strict()
export const writeAgentPersonalizationRuleSchema = agentPersonalizationRuleSchema.extend(agentPersonalizationExpectedRevisionSchema.shape)
export const removeAgentPersonalizationRuleSchema = agentPersonalizationExpectedRevisionSchema.extend({ toolName: agentPersonalizationRuleNameSchema })
export type AgentPersonalizationRule = z.infer<typeof agentPersonalizationRuleSchema>
export type AgentPersonalizationRuleOperation = { toolName: string; title: string }

export type AgentPersonalizationMemory = {
  id: string
  text: string
  source: 'manual' | 'conversation'
  createdAt: string
  updatedAt: string
  revision: number
  pinned: boolean
  recoveryUntil: string | null
  lastChange: 'saved' | 'edited' | 'merged' | 'corrected' | 'capacity' | 'restored' | 'migrated'
}

export type AgentPersonalizationMemoriesPayload = {
  memories: AgentPersonalizationMemory[]
  archived: AgentPersonalizationMemory[]
  revision: number
}
