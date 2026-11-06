import { readLedgerActivity, readLedgerPriceMetadata, presentLedgerPrice } from '../../api/lib/billing/ledger-presentation.js'
import { tokenPriceConfiguration } from '../../api/lib/billing/token-price.js'
import { modelFeeIdentity } from '../../api/lib/model-lifecycle.js'
import { describe, expect, it } from 'vitest'
import { evaluateModelActivity, findActivityConflict, modelActivitiesSchema, type ModelActivityRule } from '../../shared/model-activity.js'
import { admitModelPrice } from '../../api/lib/billing/model-activity-price.js'
import { admitImagePrice, assertImageActivityConfiguration } from '../../api/lib/billing/image-price.js'
import { calculateV1ChargeMilli, calculateV2UserChargeMilli } from '../../api/lib/billing/pricing.js'
import { tokenReservationMilli } from '../../api/lib/billing/reservation-policy.js'
import { coverWorkSchema, coverUnitSchema } from '../../api/lib/agent/runtime-cover-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const rule = (patch: Partial<ModelActivityRule> = {}): ModelActivityRule => ({ id: 'night', name: '夜间', enabled: true, startDate: null, endDate: null,
  weekdays: [1], allDay: false, startTime: '22:00', endTime: '02:00', multiplierBps: 1250, ...patch })
const config = (rules = [rule()]) => modelActivitiesSchema.parse({ revision: 4, timezone: 'Asia/Shanghai', rules })
const at = (value: string) => Date.parse(value + '+08:00')

describe('scheduled model admission', () => {
  it('uses inclusive start/exclusive end and start-day weekdays across midnight', () => {
    const schedule = config()
    expect(evaluateModelActivity(schedule, 10000, at('2026-11-02T21:59:59')).effectiveMultiplierBps).toBe(10000)
    expect(evaluateModelActivity(schedule, 10000, at('2026-11-02T22:00:00')).effectiveMultiplierBps).toBe(1250)
    expect(evaluateModelActivity(schedule, 10000, at('2026-11-03T01:59:59')).activityId).toBe('night')
    const ended = evaluateModelActivity(schedule, 10000, at('2026-11-03T02:00:00'))
    expect(ended.effectiveMultiplierBps).toBe(10000)
    expect(ended.nextSwitchAt).toBe('2026-11-09T14:00:00.000Z')
  })
  it('clips crossnight at the global exclusive end date and honors future starts', () => {
    const schedule = config([rule({ startDate: '2026-11-02', endDate: '2026-11-03' })])
    expect(evaluateModelActivity(schedule, 10000, at('2026-11-03T00:00:00')).activityId).toBeNull()
    expect(evaluateModelActivity(schedule, 10000, at('2026-11-02T22:00:00')).nextSwitchAt).toBe('2026-11-02T16:00:00.000Z')
    expect(evaluateModelActivity(schedule, 10000, at('2020-01-01T00:00:00')).nextSwitchAt).toBe('2026-11-02T14:00:00.000Z')
  })
  it('finds unbounded weekly overlaps without a finite lookahead', () => {
    const conflict = findActivityConflict({ timezone: 'Asia/Shanghai', rules: [rule(), rule({ id: 'far', startDate: '2099-01-01', weekdays: [2], startTime: '01:00', endTime: '03:00' })] })
    expect(conflict).toMatchObject({ firstId: 'night', secondId: 'far', timezone: 'Asia/Shanghai' })
    expect(conflict!.start).toMatch(/^2099-/)
    expect(Date.parse(conflict!.end) - Date.parse(conflict!.start)).toBe(3600000)
  })
  it('allows touching boundaries, disabled rows, and disjoint exclusive date ranges', () => {
    expect(config([rule(), rule({ id: 'touch', weekdays: [2], startTime: '02:00', endTime: '04:00' })]).rules).toHaveLength(2)
    expect(config([rule(), rule({ id: 'disabled', enabled: false })]).rules).toHaveLength(2)
    expect(config([rule({ endDate: '2026-11-03' }), rule({ id: 'future', startDate: '2026-11-03', weekdays: [2], startTime: '00:00', endTime: '02:00' })]).rules).toHaveLength(2)
  })
  it('rejects true overlaps, invalid dates, zero-length clocks, duplicate identifiers and unsupported zones', () => {
    expect(() => config([rule(), rule({ id: 'collision' })])).toThrow(/活动时间重叠/)
    for (const patch of [{ startDate: '2026-02-30' }, { endTime: '22:00' }, { weekdays: [] }, { weekdays: [1, 1] }]) expect(() => config([rule(patch)])).toThrow()
    expect(modelActivitiesSchema.safeParse({ ...config(), timezone: 'America/New_York' }).success).toBe(false)
    expect(modelActivitiesSchema.parse({ revision: 0, rules: [] }).timezone).toBe('Asia/Shanghai')
  })
  it('treats all-day rows in the selected timezone, independent of host/browser timezone', () => {
    const schedule = config([rule({ allDay: true })])
    expect(evaluateModelActivity(schedule, 10000, Date.parse('2026-11-01T16:00:00Z')).effectiveMultiplierBps).toBe(1250)
    expect(evaluateModelActivity({ ...schedule, timezone: 'UTC' }, 10000, Date.parse('2026-11-01T16:00:00Z')).effectiveMultiplierBps).toBe(10000)
  })
  it('freezes exact V1 prices and V2 ratio once, including cache concession and ceiling', () => {
    const model = { multiplierBps: 30000, metadata: { activities: config([rule({ multiplierBps: 10000 })]) } }
    const now = at('2026-11-02T23:00:00'), v1 = admitModelPrice(model, 'speed', null, now)
    expect(v1).toMatchObject({ multiplierBps: 10000, activity: { baseMultiplierBps: 30000, effectiveMultiplierBps: 10000, revision: 4, timezone: 'Asia/Shanghai', admittedAt: '2026-11-02T15:00:00.000Z' } })
    expect(calculateV1ChargeMilli(10001, 0, v1.multiplierBps)).toBe(1001)
    const card = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 30000, rateCardId: 'original', rates: { inputNano: 300000, cacheNano: 75000, outputNano: 3000000 }, v1CeilingBps: 30000 }
    const price = admitModelPrice(model, 'speed', card, now)
    if (price.version !== 'credits-v2-itemized') throw new Error('wrong protocol')
    expect(price.rates).toEqual(card.rates)
    expect(calculateV2UserChargeMilli(10001, 2, null, price.rates, price.v1CeilingBps, price.activity)).toBe(253)
    expect(calculateV2UserChargeMilli(0, 1000, 0, price.rates, price.v1CeilingBps, price.activity)).toBe(1000)
    expect(tokenReservationMilli(price, 10000, 1000, 100000, 100000)).toBe(1000)
    model.metadata.activities = config([rule({ multiplierBps: 5000 })])
    expect(price.activity?.effectiveMultiplierBps).toBe(10000)
    const free = admitModelPrice({ ...model, metadata: { activities: config([rule({ multiplierBps: 0 })]) } }, 'speed', card, now)
    expect(free).toMatchObject({ version: 'credits-v1-exact', multiplierBps: 0 })
    expect(admitModelPrice(model, 'custom', card, now).multiplierBps).toBe(0)
  })
  it('compares live quote configuration without repricing the stored admission and preserves lifecycle future prices', () => {
    const model = { multiplierBps: 10000, metadata: { activities: config() } }
    const first = admitModelPrice(model, 'speed', null, at('2026-11-02T22:00:00'))
    const later = admitModelPrice(model, 'speed', null, at('2026-11-02T23:00:00'))
    expect(first.activity?.admittedAt).not.toBe(later.activity?.admittedAt)
    expect(tokenPriceConfiguration(first)).toEqual(tokenPriceConfiguration(later))
    const image = { multiplierBps: 10000, metadata: { modelKind: 'image_generation' } }
    expect(modelFeeIdentity(image, null)).toBe(runtimeJson({ tariff: 'image_call_6000_v1', amountMilli: 6000 }).hash)
    expect(modelFeeIdentity({ ...image, multiplierBps: 5000 }, null)).toBe(modelFeeIdentity(image, null))
    expect(modelFeeIdentity({ ...image, metadata: { ...image.metadata, activities: config() } }, null)).not.toBe(modelFeeIdentity(image, null))
  })
  it('preserves only validated original V1 activity on refunds and keeps V2 display rates separate', () => {
    const price = admitModelPrice({ multiplierBps: 10000, metadata: { activities: config() } }, 'speed', null, at('2026-11-02T23:00:00'))
    const metadata = { activity: price.activity, provider: 'private-provider', apiKey: 'private-secret', prompt: 'private-content' }
    expect(readLedgerActivity(metadata)).toEqual(price.activity)
    expect(readLedgerPriceMetadata(metadata)).toEqual({ activity: price.activity })
    expect(presentLedgerPrice(metadata).pricing).toBeNull()
    expect(readLedgerPriceMetadata({ provider: 'private-provider' })).toBeNull()
    expect(JSON.stringify(readLedgerPriceMetadata(metadata))).not.toMatch(/private-/)
    const displayed = presentLedgerPrice({ ...metadata, pricingVersion: 'credits-v2-itemized', rateCardId: 'base', rates: { inputNano: 100000, cacheNano: 25000, outputNano: 1000000 } })
    expect(displayed.pricing).toMatchObject({ inputPerMillion: 12.5, cachePerMillion: 3.125, outputPerMillion: 125 })
  })
  it('preserves fixed legacy image fees and applies only real active activity ratios', () => {
    for (const base of [0, 1250, 10000, 15000]) {
      expect(admitImagePrice({ multiplierBps: base }).amountMilli).toBe(6000)
      const inactive = { multiplierBps: base, metadata: { activities: config([rule({ enabled: false, multiplierBps: 0 })]) } }
      expect(admitImagePrice(inactive, at('2026-11-02T23:00:00')).amountMilli).toBe(6000)
    }
    const now = at('2026-11-02T23:00:00')
    const explicitFree = { multiplierBps: 0, metadata: { activities: config([rule({ multiplierBps: 0 })]) } }
    expect(admitImagePrice(explicitFree, now).amountMilli).toBe(0)
    const activeDiscount = { multiplierBps: 20000, metadata: { activities: config([rule({ multiplierBps: 10000 })]) } }
    expect(admitImagePrice(activeDiscount, now).amountMilli).toBe(3000)
    const invalid = config([rule({ multiplierBps: 10000 })])
    expect(() => assertImageActivityConfiguration(0, invalid)).toThrow(/基础倍率须大于 0/)
    expect(() => admitImagePrice({ multiplierBps: 0, metadata: { activities: invalid } }, now)).toThrow(/基础倍率须大于 0/)
    expect(() => assertImageActivityConfiguration(0, explicitFree.metadata.activities)).not.toThrow()
  })
  it('adds image v2 while preserving exact v1 hashes and literal6000 receipts', () => {
    const old = { version: 1, novelId: 'novel', title: '书名', displayTitle: null, prompt: '画上书名', count: 1, size: '768x1024', assetIds: ['11111111-1111-4111-8111-111111111111'],
      tariff: 'image_call_6000_v1', amountMilli: 6000, route: { provider: 'internal', modelName: 'internal-model', baseUrl: 'https://image.invalid/generate', providerMode: 'live' } }
    expect(runtimeJson(coverWorkSchema.parse(old)).hash).toBe(runtimeJson(old).hash)
    expect(coverWorkSchema.safeParse({ ...old, amountMilli: 3000 }).success).toBe(false)
    const price = admitImagePrice({ multiplierBps: 15000, metadata: { activities: config([rule({ multiplierBps: 1 })]) } }, at('2026-11-02T23:00:00'))
    expect(price.amountMilli).toBe(1)
    expect(coverWorkSchema.parse({ ...old, version: 2, tariff: price.tariff, amountMilli: price.amountMilli, price })).toMatchObject({ version: 2, amountMilli: 1 })
    expect(coverUnitSchema.safeParse({ tariff: 'image_call_6000_v1', chargedMilli: 1 }).success).toBe(false)
  })
})
