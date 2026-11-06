import { DataAccessError } from '../prisma.js'
import type { ModelActivities } from '../../../shared/model-activity.js'
import { z } from 'zod'
import { baseModelMultiplier } from '../../../shared/model-promotion.js'
import { evaluateModelActivity, frozenActivitySchema, readModelActivities } from '../../../shared/model-activity.js'
import { MAX_CREDIT_STORAGE_INT } from './pricing.js'

function imageAmount(base: number, effective: number, active: boolean): number {
  if (!active) return 6000
  if (effective === 0) return 0
  if (base === 0) throw new DataAccessError(409, 'MODEL_ACTIVITY_BASE_REQUIRED', '图片活动使用正倍率时，基础倍率须大于 0；请在模型计费配置中设置基础倍率，或将活动设为明确免费。')
  return Number((6000n * BigInt(effective) + BigInt(base) - 1n) / BigInt(base))
}
export const imagePriceSchema = z.object({ tariff: z.literal('image_call_scheduled_v2'), baseAmountMilli: z.literal(6000), amountMilli: z.number().int().min(0).max(MAX_CREDIT_STORAGE_INT),
  baseMultiplierBps: z.number().int().min(0), effectiveMultiplierBps: z.number().int().min(0), admittedAt: z.string().datetime(),
  activity: frozenActivitySchema.optional(),
}).strict().refine(value => (!value.activity || value.activity.baseMultiplierBps === value.baseMultiplierBps && value.activity.effectiveMultiplierBps === value.effectiveMultiplierBps && value.activity.admittedAt === value.admittedAt) && (value.activity?.activityId != null && value.baseMultiplierBps === 0 && value.effectiveMultiplierBps > 0 ? false : value.amountMilli === imageAmount(value.baseMultiplierBps, value.effectiveMultiplierBps, value.activity?.activityId != null)))
export type ImagePrice = z.infer<typeof imagePriceSchema>
export function admitImagePrice(model: { multiplierBps: number; metadata?: unknown }, now = Date.now()): ImagePrice {
  const base = baseModelMultiplier(model, now), config = readModelActivities(model.metadata)
  const evaluated = config ? evaluateModelActivity(config, base, now) : null
  const activity = evaluated ? frozenActivitySchema.parse({ baseMultiplierBps: evaluated.baseMultiplierBps, effectiveMultiplierBps: evaluated.effectiveMultiplierBps,
    revision: evaluated.revision, timezone: evaluated.timezone, admittedAt: evaluated.admittedAt, activityId: evaluated.activityId, activityName: evaluated.activityName }) : undefined
  const effective = activity?.effectiveMultiplierBps ?? base
  return imagePriceSchema.parse({ tariff: 'image_call_scheduled_v2', baseAmountMilli: 6000, amountMilli: imageAmount(base, effective, activity?.activityId != null),
    baseMultiplierBps: base, effectiveMultiplierBps: effective, admittedAt: new Date(now).toISOString(), ...(activity ? { activity } : {}) })
}

export function assertImageActivityConfiguration(baseMultiplierBps: number, activities: ModelActivities | null) {
  if (baseMultiplierBps === 0 && activities?.rules.some(rule => rule.enabled && rule.multiplierBps > 0)) {
    throw new DataAccessError(400, 'MODEL_ACTIVITY_BASE_REQUIRED', '图片活动使用正倍率时，基础倍率须大于 0；请先设置基础倍率，或将活动设为明确免费。')
  }
}
