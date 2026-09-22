import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ active: vi.fn(), migrated: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { creditRateCardEvent: { findFirst: mocks.migrated } },
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
})

describe('zero-rate built-in tiers are permanently free', () => {
  it('returns exact-zero V1 pricing for a zero-rate tier even when a legacy active card exists', async () => {
    mocks.active.mockResolvedValue(legacyStandardCard)
    await expect(resolveTokenPrice('standard', 0)).resolves.toEqual({ version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 0 })
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
