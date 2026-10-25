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
  v1CeilingBps: multiplier.optional() }).strict()
// V1 is also the explicit zero-Credits policy for owner-authenticated BYOK.
// BYOK must never enter an itemized platform rate card.
export const tokenPriceSchema = z.union([z.object({ version: z.literal(V1_PRICING_VERSION), modelTier: tokenPriceTiers, multiplierBps: multiplier }).strict(), itemizedTokenPriceSchema])
export type TokenPrice = z.infer<typeof tokenPriceSchema>

/** Itemized prices already contain their multiplier. Runtime/usage metadata
 * may retain the original route multiplier; V1 still requires exact equality. */
export function frozenTokenPriceMatchesModel(price: TokenPrice, modelTier: string, multiplierBps: number) {
  return price.modelTier === modelTier && (price.version === 'credits-v2-itemized' || price.multiplierBps === multiplierBps)
}
