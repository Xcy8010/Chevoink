import type { AgentTool } from './types.js'
import { z } from 'zod'
import { coerceToolArgumentEnvelope } from './argument-coercion.js'
import { decodeToolArgumentContainers } from './argument-container-decoding.js'

/** Shared by live dispatch and durable pre-execution rejection. Pure only. */
export function normalizeToolInput(tool: Pick<AgentTool, 'coerceArgs'> & Partial<Pick<AgentTool, 'parameters'>>, raw: unknown): unknown {
  // Old context receipts are not executable arguments, even if a wrapper or
  // permissive schema could otherwise turn an excerpt into a valid write.
  if (raw && typeof raw === 'object' && '_contextCompacted' in raw && raw._contextCompacted === true) {
    throw new Error('Historical context excerpt cannot be executed')
  }
  const envelope = coerceToolArgumentEnvelope(raw)
  if (envelope && typeof envelope === 'object' && '_contextCompacted' in envelope && envelope._contextCompacted === true) {
    throw new Error('Historical context excerpt cannot be executed')
  }
  const coerced = tool.coerceArgs ? tool.coerceArgs(envelope) : envelope
  const normalized = tool.parameters ? decodeToolArgumentContainers(tool.parameters, coerced) : coerced
  if (!(tool.parameters instanceof z.ZodObject) || !normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized
  const result = { ...normalized } as Record<string, unknown>
  for (const [key, value] of Object.entries(result)) {
    // Only optional identifiers: never erase required IDs, empty replacement
    // text, or whitespace that the user actually wants to write/search.
    const field = tool.parameters.shape[key]
    if (/Id$/.test(key) && typeof value === 'string' && !value.trim() && field?.safeParse(undefined).success) delete result[key]
  }
  return result
}

export function validateToolInput(tool: Pick<AgentTool, 'parameters'>, normalized: unknown) {
  return tool.parameters.safeParse(normalized)
}
