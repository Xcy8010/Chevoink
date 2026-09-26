import { describe, expect, it } from 'vitest'
import { effectiveModelMultiplier, modelPromotionSchema, readModelPromotion } from '../../shared/model-promotion.js'

const endsAt = '2026-09-25T20:00:00+08:00'
const model = { multiplierBps: 0, metadata: { freePromotion: { endsAt, afterMultiplier: 1.5 } } }
describe('timed model offers', () => {
  it('switches at the exact instant independent of server timezone or scheduler', () => {
    const expiry = Date.parse('2026-09-25T12:00:00Z')
    expect(effectiveModelMultiplier(model, expiry - 1)).toBe(0)
    expect(effectiveModelMultiplier(model, expiry)).toBe(15000)
    expect(effectiveModelMultiplier(model, expiry + 1)).toBe(15000)
    expect(model.multiplierBps).toBe(0)
  })
  it('does not reprice ordinary free, BYOK-like, or explicitly changed paid configurations', () => {
    expect(effectiveModelMultiplier({ multiplierBps: 0 })).toBe(0)
    expect(effectiveModelMultiplier({ ...model, multiplierBps: 30000 }, Infinity)).toBe(30000)
    expect(readModelPromotion({ freePromotion: null })).toBeNull()
  })
  it.each([0, -1, 0.00001, 1.55555, Infinity, 101])('rejects an unrepresentable post-offer price %s', afterMultiplier => {
    expect(modelPromotionSchema.safeParse({ endsAt, afterMultiplier }).success).toBe(false)
  })
  it('requires an explicit timezone and accepts the minimum nonzero fixed-point price', () => {
    expect(modelPromotionSchema.safeParse({ endsAt: '2026-09-25T20:00:00', afterMultiplier: 1.5 }).success).toBe(false)
    expect(effectiveModelMultiplier({ multiplierBps: 0, metadata: { freePromotion: { endsAt, afterMultiplier: 0.0001 } } }, Infinity)).toBe(1)
  })
})
