import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ active: vi.fn(), migrated: vi.fn(), model: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { creditRateCardEvent: { findFirst: mocks.migrated }, aiModelConfig: { findFirst: mocks.model } },
}))
vi.mock('../../api/lib/billing/rate-cards.js', () => ({ getActiveTokenPrice: mocks.active }))
import { resolveTokenPrice } from '../../api/lib/billing/resolve-token-price.js'

const legacyStandardCard = {
  version: 'credits-v2-itemized', modelTier: 'standard', multiplierBps: 10000, rateCardId: 'legacy-standard-card',
  rates: { inputNano: 100000, cacheNano: 25000, outputNano: 1000000 }, v1CeilingBps: 10000,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.active.mockResolvedValue(null)
  mocks.migrated.mockResolvedValue(null)
  mocks.model.mockResolvedValue(null)
})

describe('zero-rate built-in tiers are permanently free', () => {
  it('honors the explicitly configured post-offer multiplier instead of a stale card', async () => {
    mocks.model.mockResolvedValue({ metadata: { freePromotion: { endsAt: '2026-09-25T12:00:00Z', afterMultiplier: 1.5 } } })
    mocks.active.mockResolvedValue(legacyStandardCard)
    await expect(resolveTokenPrice('standard', 15000)).resolves.toEqual({ version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 15000 })
    expect(mocks.active).not.toHaveBeenCalled()
  })
  it('returns exact-zero V1 pricing for a zero-rate tier even when a legacy active card exists', async () => {
    mocks.active.mockResolvedValue(legacyStandardCard)
    await expect(resolveTokenPrice('standard', 0)).resolves.toEqual({ version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 0 })
    expect(mocks.active).not.toHaveBeenCalled()
    expect(mocks.migrated).not.toHaveBeenCalled()
  })
  it('uses an exact-zero V1 price for owner-authenticated BYOK without consulting platform cards', async () => {
    mocks.active.mockResolvedValue(legacyStandardCard)
    mocks.migrated.mockResolvedValue({ id: 'rate-card-event' })
    await expect(resolveTokenPrice('custom', 99999)).resolves.toEqual({ version: 'credits-v1-exact', modelTier: 'custom', multiplierBps: 0 })
    expect(mocks.active).not.toHaveBeenCalled()
    expect(mocks.migrated).not.toHaveBeenCalled()
  })
  it('still binds a paid tier to its active rate card', async () => {
    const card = {
      version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 11000, rateCardId: 'speed-card',
      rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 }, v1CeilingBps: 11000,
    }
    mocks.active.mockResolvedValue(card)
    await expect(resolveTokenPrice('speed', 15000)).resolves.toEqual(card)
    expect(mocks.active).toHaveBeenCalledWith('speed')
  })
  it('keeps the migrated-tier guard for paid tiers without an active card', async () => {
    mocks.migrated.mockResolvedValue({ id: 'rate-card-event' })
    await expect(resolveTokenPrice('performance', 30000)).rejects.toMatchObject({ code: 'RUNTIME_PRICE_REQUIRED' })
  })
  it('keeps the V1 fallback for paid tiers without cards or migration history', async () => {
    await expect(resolveTokenPrice('ultimate', 35000)).resolves.toEqual({ version: 'credits-v1-exact', modelTier: 'ultimate', multiplierBps: 35000 })
  })
})

it('refreshes cached zero activity at the next independent operation while retaining the original frozen receipt', async () => {
  mocks.model.mockResolvedValue({ multiplierBps: 12000, metadata: { activities: { revision: 2, timezone: 'Asia/Shanghai', rules: [{ id: 'free-hour', name: '免费时段', enabled: true,
    startDate: null, endDate: null, weekdays: [1], allDay: false, startTime: '22:00', endTime: '23:00', multiplierBps: 0 }] } } })
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T22:59:59+08:00'))
  try {
    const first = await resolveTokenPrice('standard', 0, { freshOperation: true })
    now.mockReturnValue(Date.parse('2026-11-02T23:00:00+08:00'))
    const second = await resolveTokenPrice('standard', 0, { freshOperation: true })
    expect(first).toMatchObject({ multiplierBps: 0, activity: { effectiveMultiplierBps: 0, activityId: 'free-hour' } })
    expect(second).toMatchObject({ multiplierBps: 12000, activity: { effectiveMultiplierBps: 12000, activityId: null } })
    expect(first.activity?.effectiveMultiplierBps).toBe(0)
  } finally { now.mockRestore() }
})
