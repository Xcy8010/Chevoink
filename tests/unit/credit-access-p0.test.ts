import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pending: vi.fn(), model: vi.fn(), account: vi.fn(), setting: vi.fn(), initialize: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: {
    creditSystemSetting: { findUnique: mocks.setting, upsert: mocks.initialize },
    creditAccount: { upsert: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: mocks.account },
    aiUsageLog: { aggregate: mocks.pending },
    aiModelConfig: { findFirst: mocks.model },
  },
}))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: () => 'fixture-key' }))
import { assertCreditAccess, getAuxiliaryModelRuntime } from '../../api/lib/credits.js'

const start = new Date('2026-09-09T07:00:00Z')
beforeEach(() => {
  vi.clearAllMocks()
  mocks.setting.mockResolvedValue({ dailyAllowanceMilli: 450000, globallyPaused: false, resetHourUtc8: 15 })
  mocks.initialize.mockResolvedValue({ dailyAllowanceMilli: 450000, globallyPaused: false, resetHourUtc8: 15 })
  mocks.account.mockResolvedValue({ dailyAllowanceMilli: 450000, dailyUsedMilli: 0, bonusBalanceMilli: 0, periodStartedAt: start, suspendedAt: null })
  mocks.pending.mockResolvedValue({ _sum: { reservedCreditMilli: 0 } })
  mocks.model.mockResolvedValue({ tier: 'speed', modelName: 'fixture', baseUrl: 'https://fixture.example/v1', apiKeyCiphertext: 'fixture' })
})

describe('P0 credit admission and auxiliary model ownership', () => {
  it('reads current settings without upserting the global singleton on each admission', async () => {
    await assertCreditAccess('owner', 'speed')
    expect(mocks.setting).toHaveBeenCalled()
    expect(mocks.initialize).not.toHaveBeenCalled()
  })
  it('retains initialization for a missing singleton', async () => {
    mocks.setting.mockResolvedValueOnce(null)
    await assertCreditAccess('owner', 'speed')
    expect(mocks.initialize).toHaveBeenCalledTimes(1)
  })
  it('counts only unexpired reservations instead of locking on unknown usage', async () => {
    await assertCreditAccess('owner', 'speed')
    expect(mocks.pending).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'owner', reservationExpiresAt: { gt: expect.any(Date) } }) }))
  })
  it('preserves reservation exhaustion as a distinct error', async () => {
    mocks.pending.mockResolvedValue({ _sum: { reservedCreditMilli: 450000 } })
    await expect(assertCreditAccess('owner', 'speed')).rejects.toMatchObject({ code: 'CREDITS_RESERVED' })
  })
  it('permits BYOK with zero balance and pending platform usage', async () => {
    mocks.account.mockResolvedValue({ dailyAllowanceMilli: 450000, dailyUsedMilli: 450000, bonusBalanceMilli: 0, periodStartedAt: start, suspendedAt: null })
    mocks.pending.mockResolvedValue({ _sum: { reservedCreditMilli: 1000 } })
    await expect(assertCreditAccess('owner', 'custom')).resolves.toBeUndefined()
    expect(mocks.pending).not.toHaveBeenCalled()
    await expect(assertCreditAccess('owner', 'speed')).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
  })
  it('still rejects suspended BYOK accounts', async () => {
    mocks.account.mockResolvedValue({ suspendedAt: new Date() })
    await expect(assertCreditAccess('owner', 'custom')).rejects.toMatchObject({ code: 'CREDITS_ACCOUNT_SUSPENDED' })
  })
  it('resolves only an enabled model owned by the caller for standalone export and graph', async () => {
    mocks.model.mockResolvedValueOnce({ id: 'custom' }).mockResolvedValueOnce({ provider: 'openai', modelName: 'custom', baseUrl: 'https://fixture.example/v1', apiKeyCiphertext: 'fixture', metadata: {} })
    expect(await getAuxiliaryModelRuntime('owner')).toMatchObject({ tier: 'custom', multiplierBps: 0 })
    expect(mocks.model.mock.calls[0][0].where).toEqual({ ownerUserId: 'owner', enabled: true })
    expect(mocks.model.mock.calls[1][0].where).toEqual({ id: 'custom', ownerUserId: 'owner', enabled: true })
  })
  it('does not silently charge a built-in provider if the chosen BYOK configuration is invalid', async () => {
    mocks.model.mockResolvedValueOnce({ id: 'custom' }).mockResolvedValueOnce(null)
    await expect(getAuxiliaryModelRuntime('owner')).rejects.toMatchObject({ code: 'CUSTOM_MODEL_NOT_FOUND' })
    expect(mocks.model).toHaveBeenCalledTimes(2)
  })
})
