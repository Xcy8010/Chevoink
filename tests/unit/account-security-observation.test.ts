import type { Request } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateAccountObservation } from '../../shared/account-security-observation.js'
import { observeOtherDeviceRemoval, observePasswordLogin, recordAccountPasswordFailure } from '../../api/lib/account-security-observation.js'

const db = vi.hoisted(() => ({ findMany: vi.fn(), findFirst: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { accountDeviceSession: db } }))
const locate = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/device-location.js', () => ({ resolveDeviceLocation: locate }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function log() { return vi.spyOn(console, 'info').mockImplementation(() => {}) }
function failures(action: 'password_login' | 'device_revoke', id: string, count = 5) {
  for (let i = 0; i < count; i++) recordAccountPasswordFailure(action, id)
}
function device(userId: string, location = '美国 · California') {
  return { id: 'example-session', userId, tokenVersion: 2, location, createdAt: new Date() }
}

describe('account security observation', () => {
  it('allows routine activity, travel and a location change alone, including a VPN change', () => {
    expect(evaluateAccountObservation({ action: 'ordinary_activity', repeatedFailures: true, countryChanged: true })).toBe('allow')
    for (const deviceEvidence of ['unknown', 'existing_session'] as const) {
      expect(evaluateAccountObservation({ action: 'password_login', repeatedFailures: false, countryChanged: true, deviceEvidence })).toBe('allow')
    }
    expect(evaluateAccountObservation({ action: 'device_revoke', repeatedFailures: false, countryChanged: true, deviceEvidence: 'existing_session' })).toBe('allow')
  })

  it('observes a burst on an existing account, escalates only combined evidence and consumes it on sign-in', async () => {
    const output = log()
    const current = device('sensitive-fixture-account')
    failures('password_login', current.userId, 7)
    expect(output).toHaveBeenCalledTimes(1)
    expect(output.mock.calls[0][1]).toMatchObject({ stage: 'failed', decision: 'notice' })
    db.findMany.mockResolvedValue([{ location: '中国 · 广东省 · 深圳市' }])
    await observePasswordLogin(device('different-fixture'), false)
    expect(db.findMany).not.toHaveBeenCalled()
    await observePasswordLogin(current, false)
    expect(db.findMany.mock.calls[0][0].where).toMatchObject({ userId: current.userId, tokenVersion: 2, createdAt: { lt: current.createdAt } })
    expect(output.mock.calls[1][1]).toEqual({
      action: 'password_login', stage: 'succeeded', decision: 'would_verify', repeatedFailures: true,
      countryChanged: true, deviceEvidence: 'unknown',
    })
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/fixture|深圳|California/)
    await observePasswordLogin(current, false)
    expect(output).toHaveBeenCalledTimes(2)
  })

  it('keeps a known country, unresolvable locations, and same-account travel at the reminder level after failures', async () => {
    const output = log()
    for (const history of [[], [{ location: '局域网' }, { location: '本机' }], [{ location: '美国 · Oregon' }]]) {
      db.findMany.mockResolvedValue(history)
      failures('password_login', 'traveler')
      await observePasswordLogin(device('traveler'), false)
      expect(output.mock.lastCall?.[1]).toMatchObject({ stage: 'succeeded', decision: 'notice', countryChanged: false })
    }
    db.findMany.mockClear()
    failures('password_login', 'traveler')
    await observePasswordLogin(device('traveler'), true)
    expect(db.findMany).not.toHaveBeenCalled()
    expect(output.mock.lastCall?.[1]).toMatchObject({ decision: 'notice', deviceEvidence: 'existing_session' })
  })

  it('discards expired evidence and does not combine unrelated sessions or actions', async () => {
    vi.useFakeTimers()
    const output = log()
    failures('password_login', 'expired', 4)
    vi.advanceTimersByTime(600_000)
    failures('password_login', 'expired', 1)
    failures('device_revoke', 'expired', 4)
    await observePasswordLogin(device('expired'), false)
    expect(output).not.toHaveBeenCalled()
    expect(db.findMany).not.toHaveBeenCalled()
  })

  it('observes successful removal from a recently issued session, excluding legacy first-seen dates', async () => {
    const output = log()
    const identity = { userId: 'example-user', deviceId: 'example-issuer', tokenVersion: 2 }
    db.findFirst.mockResolvedValue({ createdAt: new Date() })
    db.findMany.mockResolvedValue([{ location: '美国 · California' }])
    locate.mockResolvedValue('中国 · 广东省 · 深圳市')
    await observeOtherDeviceRemoval({} as Request, identity)
    expect(output.mock.lastCall?.[1]).toMatchObject({ decision: 'notice', deviceEvidence: 'recent_session' })
    failures('device_revoke', identity.deviceId)
    await observeOtherDeviceRemoval({} as Request, identity)
    expect(output.mock.lastCall?.[1]).toMatchObject({ stage: 'succeeded', decision: 'would_verify' })
    output.mockClear()
    await observeOtherDeviceRemoval({} as Request, { ...identity, deviceId: 'shared-historical' })
    db.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 86400_000) })
    await observeOtherDeviceRemoval({} as Request, identity)
    expect(output).not.toHaveBeenCalled()
  })
})
