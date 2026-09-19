import { z } from 'zod'

export const modelRouteInputSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(40),
  modelName: z.string().trim().min(1).max(160),
  baseUrl: z.string().trim().url().max(512).refine(value => /^https?:\/\//.test(value), '仅支持 HTTP(S)'),
  apiKey: z.string().trim().min(8).max(2000).optional(),
  enabled: z.boolean(),
  reasoningEfforts: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).min(1).max(7).optional(),
  contextWindowTokens: z.number().int().min(16_000).max(4_000_000).optional(),
  visionEnabled: z.boolean().optional(),
}).strict()
export const modelRoutesInputSchema = z.array(modelRouteInputSchema).max(7)
export type ModelRouteInput = z.infer<typeof modelRouteInputSchema>
export type ModelRouteView = Omit<ModelRouteInput, 'apiKey'> & { id: string; apiKeyConfigured: boolean }
