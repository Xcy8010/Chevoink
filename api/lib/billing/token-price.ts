import { frozenActivitySchema } from '../../../shared/model-activity.js'
import { z } from 'zod'
import { creditModelTierSchema, serverModelTierSchema } from '../../../shared/contracts/credits.js'
import { MAX_CREDIT_STORAGE_INT, V1_PRICING_VERSION, V2_PRICING_VERSION } from './pricing.js'

const multiplier = z.number().int().min(0).max(MAX_CREDIT_STORAGE_INT)
const tokenPriceTiers = creditModelTierSchema
export const itemizedRatesSchema = z.object({ inputNano: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cacheNano: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), outputNano: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
  .refine(value => value.cacheNano <= value.inputNano)
export const itemizedTokenPriceSchema = z.object({ version: z.literal(V2_PRICING_VERSION), modelTier: serverModelTierSchema,
  multiplierBps: multiplier, rateCardId: z.string().min(1).max(64), rates: itemizedRatesSchema,
  v1CeilingBps: multiplier.optional(), activity: frozenActivitySchema.optional() }).strict()
// V1 is also the explicit zero-Credits policy for owner-authenticated BYOK.
// BYOK must never enter an itemized platform rate card.
export const tokenPriceSchema = z.union([z.object({ version: z.literal(V1_PRICING_VERSION), modelTier: tokenPriceTiers, multiplierBps: multiplier, activity: frozenActivitySchema.optional() }).strict(), itemizedTokenPriceSchema]).refine(value => !value.activity || (value.modelTier !== 'custom' && (value.version === V1_PRICING_VERSION ? value.activity.effectiveMultiplierBps === value.multiplierBps : value.activity.baseMultiplierBps > 0)), '活动上下文与冻结价格不一致')
export type TokenPrice = z.infer<typeof tokenPriceSchema>

/** Itemized prices already contain their multiplier. Runtime/usage metadata
 * may retain the original route multiplier; V1 still requires exact equality. */
export function frozenTokenPriceMatchesModel(price: TokenPrice, modelTier: string, multiplierBps: number) {
  return price.modelTier === modelTier && (price.version === 'credits-v2-itemized' || price.multiplierBps === multiplierBps)
}

/** Live quote staleness ignores only the observation instant; frozen receipts retain it. */
export function tokenPriceConfiguration(price: TokenPrice) {
  if (!price.activity) return price
  const { admittedAt: _instant, ...activity } = price.activity
  return { ...price, activity }
}

export function frozenEffectiveMultiplier(price: TokenPrice): number {
  return price.activity?.effectiveMultiplierBps ?? price.multiplierBps
}

/** Usage keeps a route's nominal multiplier for legacy V2 cards; activity explicitly
 * owns the effective multiplier. Itemized rates remain the frozen billing source. */
export function operationModelMultiplier(price: TokenPrice, selectedMultiplierBps: number): number {
  return price.activity?.effectiveMultiplierBps ?? (price.version === V2_PRICING_VERSION ? selectedMultiplierBps : price.multiplierBps)
}
