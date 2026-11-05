import { z } from 'zod'
import { DataAccessError } from './prisma.js'

const storedSchema = z.array(z.object({ id: z.string().uuid(), label: z.string(), provider: z.string(), modelName: z.string(), baseUrl: z.string(), apiKeyCiphertext: z.string(), enabled: z.boolean(), reasoningEfforts: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).optional(), contextWindowTokens: z.number().optional(), visionEnabled: z.boolean().optional() })).max(7)

/** Stored configuration only; reading a tool route does not load text dispatch or retry classes. */
export function readModelRoutes(metadata: unknown) {
  const value = metadata && typeof metadata === 'object' && 'routes' in metadata ? metadata.routes : []
  const parsed = storedSchema.safeParse(value)
  if (!parsed.success) throw new DataAccessError(409, 'MODEL_ROUTES_INVALID', '模型线路配置无效，请管理员检查。')
  return parsed.data
}
