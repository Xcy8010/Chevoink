import { z } from 'zod'

export const MAX_CREDIT_MILLI = 2_147_483_647
const milli = z.number().int().min(0).max(MAX_CREDIT_MILLI)
export const adminCreditAdjustmentSchema = z.object({
  mode: z.enum(['add', 'subtract', 'set']),
  amountMilli: milli,
  expectedBonusBalanceMilli: milli,
  requestKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
}).refine(value => value.mode === 'set' || value.amountMilli > 0, { path: ['amountMilli'], message: '增减金额必须大于零。' })
export type AdminCreditAdjustmentInput = z.infer<typeof adminCreditAdjustmentSchema>
export type AdminCreditAdjustmentResult = {
  userId: string
  mode: AdminCreditAdjustmentInput['mode']
  amountMilli: number
  previousBonusBalanceMilli: number
  bonusBalanceMilli: number
  deltaMilli: number
  requestKey: string
}
