import { z } from 'zod'

export const AGENT_PERSONALIZATION_LIMITS = {
  preferredName: 80,
  aboutMe: 2_000,
  customInstructions: 2_000,
  memoryText: 500,
} as const

export const agentPersonalizationStyleSchema = z.enum(['natural', 'professional', 'direct', 'partner'])
export const agentPersonalizationDegreeSchema = z.enum(['less', 'default', 'more'])
export const agentPersonalizationRevisionSchema = z.number().int().nonnegative().max(2_147_483_646)

const authorText = (max: number) => z.string().trim().max(max)
const hasNoNull = (value: string) => !value.includes('\u0000')
const settingsSchema = z.object({
  memoryEnabled: z.boolean(),
  preferredName: authorText(AGENT_PERSONALIZATION_LIMITS.preferredName).refine(hasNoNull),
  aboutMe: authorText(AGENT_PERSONALIZATION_LIMITS.aboutMe).refine(hasNoNull),
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
  preferredName: '',
  aboutMe: '',
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
}

export const patchAgentPersonalizationSchema = settingsSchema.partial()
  .extend({ expectedRevision: agentPersonalizationRevisionSchema })
  .refine(value => Object.entries(value).some(([key, field]) => key !== 'expectedRevision' && field !== undefined))
export type PatchAgentPersonalization = z.infer<typeof patchAgentPersonalizationSchema>

export const agentPersonalizationMemoryTextSchema = authorText(AGENT_PERSONALIZATION_LIMITS.memoryText).min(1).refine(hasNoNull)
export const createAgentPersonalizationMemorySchema = z.object({
  text: agentPersonalizationMemoryTextSchema,
}).strict()
export const patchAgentPersonalizationMemorySchema = createAgentPersonalizationMemorySchema
  .extend({ expectedRevision: agentPersonalizationRevisionSchema })
export type PatchAgentPersonalizationMemory = z.infer<typeof patchAgentPersonalizationMemorySchema>

export type AgentPersonalizationMemory = {
  id: string
  text: string
  source: 'manual' | 'conversation'
  createdAt: string
  updatedAt: string
  revision: number
}

export type AgentPersonalizationMemoriesPayload = {
  memories: AgentPersonalizationMemory[]
  revision: number
}
