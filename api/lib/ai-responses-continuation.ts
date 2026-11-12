import { z } from 'zod'

export const responsesReasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string().min(1),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).strict()),
  encrypted_content: z.string().min(1),
}).strict()

// The opaque provider context is only used for a tool continuation on the
// same owner, credential, model and endpoint. It is never a visible message.
export const responsesContinuationSchema = z.object({
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(responsesReasoningItemSchema).min(1),
}).strict()

export type ResponsesContinuation = z.infer<typeof responsesContinuationSchema>
export type ResponsesReasoningItem = z.infer<typeof responsesReasoningItemSchema>
