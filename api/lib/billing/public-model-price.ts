import { admitImagePrice } from './image-price.js'
import type { PublicImageModel } from '../../../shared/contracts/image-model.js'
import { baseModelMultiplier, readModelPromotion } from '../../../shared/model-promotion.js'
import { evaluateModelActivity, readModelActivities } from '../../../shared/model-activity.js'
import type { CreditModelOption } from '../../../shared/contracts/credits.js'
import type { TokenPrice } from './token-price.js'
import { admitModelPrice } from './model-activity-price.js'

export function publicModelPrice(model: { multiplierBps: number; metadata?: unknown }, tier: CreditModelOption['tier'], card?: TokenPrice | null, now = Date.now()) {
  const config = readModelActivities(model.metadata), base = baseModelMultiplier(model, now)
  const activity = config ? evaluateModelActivity(config, base, now) : null
  const price = admitModelPrice(model, tier, card, now)
  const ratio = price.activity && price.activity.baseMultiplierBps > 0 ? price.activity.effectiveMultiplierBps / price.activity.baseMultiplierBps : 1
  const metadata = model.metadata && typeof model.metadata === 'object' ? model.metadata as Record<string, unknown> : {}
  return {
    multiplier: (activity?.effectiveMultiplierBps ?? base) / 10000, baseMultiplier: base / 10000, discountRatio: base ? (activity?.effectiveMultiplierBps ?? base) / base : null,
    publicDescription: typeof metadata.publicDescription === 'string' ? metadata.publicDescription : '',
    publicFeatures: Array.isArray(metadata.publicFeatures) ? metadata.publicFeatures.filter((value): value is string => typeof value === 'string') : [],
    activity: activity ? { name: activity.activityName, revision: activity.revision, timezone: activity.timezone, asOf: activity.admittedAt, nextSwitchAt: activity.nextSwitchAt,
      rules: config!.rules.map(({ id: _id, ...rule }) => rule) } : null,
    pricing: price.version === 'credits-v2-itemized' ? { version: price.version, rateCardId: price.rateCardId,
      inputPerMillion: price.rates.inputNano * ratio / 1000, cachePerMillion: price.rates.cacheNano * ratio / 1000, outputPerMillion: price.rates.outputNano * ratio / 1000,
      ...(price.v1CeilingBps !== undefined ? { v1CeilingMultiplier: price.v1CeilingBps * ratio / 10000 } : {}) } : null,
    basePricing: card?.version === 'credits-v2-itemized' && !readModelPromotion(model.metadata) && base !== 0 ? {
      inputPerMillion: card.rates.inputNano / 1000, cachePerMillion: card.rates.cacheNano / 1000, outputPerMillion: card.rates.outputNano / 1000 } : null,
  }
}

export function publicImagePrice(model: { displayName: string; enabled: boolean; multiplierBps: number; metadata?: unknown }, now = Date.now()): PublicImageModel {
  const fields = publicModelPrice(model, 'speed', null, now), price = admitImagePrice(model, now)
  return { label: model.displayName, available: model.enabled, publicDescription: fields.publicDescription, publicFeatures: fields.publicFeatures,
    basePerCallCredits: 6, perCallCredits: price.amountMilli / 1000,
    baseMultiplier: fields.baseMultiplier, multiplier: fields.multiplier, discountRatio: fields.discountRatio, activity: fields.activity }
}
