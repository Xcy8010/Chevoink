import { z } from 'zod'
import type { AgentRun } from '../../../shared/contracts/index.js'

export function readAuthorEnded(usage: unknown): { authorEnded?: AgentRun['authorEnded'] } {
  const parsed = z.object({ authorEnded: z.object({ fulfilled: z.boolean(), todoItems: z.array(z.object({ id: z.string().optional(), content: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']), reason: z.string().optional() })).optional() }).optional() }).safeParse(usage)
  return parsed.success && parsed.data.authorEnded ? { authorEnded: parsed.data.authorEnded } : {}
}
