import { z } from 'zod'
import type { AgentRunOutcome } from '../../../shared/contracts/models.js'

export function readRunOutcome(usage: unknown): { outcome?: AgentRunOutcome } {
  const parsed = z.object({ outcome: z.object({ kind: z.literal('delivered_with_limitations'), summary: z.string().min(1) }).strict().optional() }).safeParse(usage)
  return parsed.success && parsed.data.outcome ? { outcome: parsed.data.outcome } : {}
}
