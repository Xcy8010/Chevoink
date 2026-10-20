import { z } from 'zod'

/** No provider prose or credentials. The receipt and original debit own this obligation. */
export const webToolRefundEvidenceSchema = z.object({
  callId: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['failed', 'aborted', 'empty', 'fallback']),
}).strict()
