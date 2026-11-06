import { baseModelMultiplier, readModelPromotion } from '../../../shared/model-promotion.js'
import { evaluateModelActivity, frozenActivitySchema, readModelActivities } from '../../../shared/model-activity.js'
import { tokenPriceSchema, type TokenPrice } from './token-price.js'
import type { CreditModelTier } from '../../../shared/contracts/credits.js'

/** Rate card values are frozen base rates; activity carries the independent exact ratio. */
export function admitModelPrice(model: { multiplierBps: number; metadata?: unknown }, tier: CreditModelTier, card?: TokenPrice | null, now = Date.now()): TokenPrice {
  if (tier === 'custom') return tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier: 'custom', multiplierBps: 0 })
  const base = baseModelMultiplier(model, now), config = readModelActivities(model.metadata)
  const evaluated = config ? evaluateModelActivity(config, base, now) : null
  const activity = evaluated ? frozenActivitySchema.parse({ baseMultiplierBps: evaluated.baseMultiplierBps, effectiveMultiplierBps: evaluated.effectiveMultiplierBps,
    revision: evaluated.revision, timezone: evaluated.timezone, admittedAt: evaluated.admittedAt, activityId: evaluated.activityId, activityName: evaluated.activityName }) : undefined
  const effective = activity?.effectiveMultiplierBps ?? base
  if (effective === 0 || readModelPromotion(model.metadata) || !card || base === 0) {
    return tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier: tier, multiplierBps: effective, ...(activity ? { activity } : {}) })
  }
  return tokenPriceSchema.parse({ ...card, ...(activity ? { activity } : {}) })
}
