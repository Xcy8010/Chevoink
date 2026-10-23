import { z } from 'zod'

/** Shared response shapes, separate from report interpretation and addressing. */
export const terminalVerdictSchema = z.object({ path: z.string().max(100),
  verdict: z.enum(['supported', 'unknown', 'planned', 'negated', 'attributed']),
  segmentIds: z.array(z.string().regex(/^c[0-9]+$/)).max(8),
}).strict()
export const inheritedTerminalVerdictSchema = terminalVerdictSchema.omit({ segmentIds: true }).extend({
  basis: z.enum(['current', 'inherited']),
  sourceEvidence: z.array(z.object({ segmentId: z.string().regex(/^[cpt][0-9]+$/), quote: z.string().min(2).max(300) }).strict()).max(8),
  inheritance: z.object({ priorEndState: z.enum(['established', 'uncertain']), currentState: z.enum(['unchanged', 'changed', 'uncertain']) }).strict().optional(),
}).strict()
export const sourcedTerminalVerdictSchema = inheritedTerminalVerdictSchema.extend({ basis: z.string().max(1500).optional() })
export const terminalSpanVerdictSchema = sourcedTerminalVerdictSchema.extend({ sourceEvidence: z.array(z.object({
  segmentId: z.string().regex(/^[cp][0-9]+$/u), quote: z.string().min(2).max(300).optional(),
}).strict()).max(8) })
export const terminalFactVerdictSchema = z.union([terminalSpanVerdictSchema.omit({ path: true }).extend({
  factId: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict(), terminalSpanVerdictSchema])
// v4 is frozen. v5 accepts redundant addresses only after exact agreement.
export const terminalJointFactVerdictSchema = z.union([terminalSpanVerdictSchema.omit({ path: true }).extend({
  factId: z.string().regex(/^[a-f0-9]{64}$/u), path: terminalSpanVerdictSchema.shape.path.optional(),
}).strict(), terminalSpanVerdictSchema])
