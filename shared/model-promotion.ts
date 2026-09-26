import { z } from 'zod'

export const modelPromotionSchema = z.object({
  endsAt: z.string().datetime({ offset: true }),
  afterMultiplier: z.number().positive().max(100).refine(value => {
    const bps = Math.round(value * 10000)
    return bps >= 1 && Math.abs(value * 10000 - bps) < 0.000001
  }, '到期倍率至少为 0.0001，最多四位小数'),
})
export type ModelPromotion = z.infer<typeof modelPromotionSchema>

export function readModelPromotion(metadata: unknown): ModelPromotion | null {
  if (!metadata || typeof metadata !== 'object' || !('freePromotion' in metadata)) return null
  const parsed = modelPromotionSchema.safeParse(metadata.freePromotion)
  return parsed.success ? parsed.data : null
}

/** Resolve before freezing a new operation's price. Never alter saved receipts. */
export function effectiveModelMultiplier(model: { multiplierBps: number; metadata?: unknown }, now = Date.now()): number {
  const promotion = readModelPromotion(model.metadata)
  if (model.multiplierBps !== 0 || !promotion || now < Date.parse(promotion.endsAt)) return model.multiplierBps
  return Math.round(promotion.afterMultiplier * 10000)
}
