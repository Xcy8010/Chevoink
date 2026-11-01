import { z } from 'zod'

export const webToolProtocolSchema = z.enum(['deepseek', 'bocha'])
export type WebToolProtocol = z.infer<typeof webToolProtocolSchema>
