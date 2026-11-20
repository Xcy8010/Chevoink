import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const joinedRead = vi.hoisted(() => vi.fn())
const device = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn() }))
const db = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/prisma.js')>(), prisma: { user: db, accountDeviceSession: device, $queryRaw: joinedRead },
}))
import { buildSessionTokens, createSession, evictUserBanCache, getPublicSessionUserId, getSessionUserId, getUserAuthState, readUserAuthState, requireSessionUserId, resolveSessionGate, revokeUserSessions } from '../../api/lib/auth-session.js'

const userId = 'auth-fault-fixture'
const unavailable = { status: 503, code: 'AUTH_SESSION_UNAVAILABLE' }
function request(channel: 'access-cookie' | 'refresh-cookie' | 'bearer-access' | 'bearer-refresh' = 'access-cookie') {
  const tokens = buildSessionTokens(userId, 3)
  const headers = channel === 'access-cookie' ? { cookie: `chevoink_session=${tokens.accessToken}` }
    : channel === 'refresh-cookie' ? { cookie: `chevoink_refresh=${tokens.refreshToken}` }
      : { authorization: `Bearer ${channel === 'bearer-access' ? tokens.accessToken : tokens.refreshToken}` }
  return { headers, path: '/api/credits/me' } as Request
}
const response = () => ({ append: vi.fn() }) as unknown as Response
beforeEach(() => {
  vi.resetAllMocks()
  evictUserBanCache(userId)
  db.findUnique.mockResolvedValue({ bannedAt: null, tokenVersion: 3 })
  db.update.mockResolvedValue({})
  device.findUnique.mockResolvedValue({ userId, tokenVersion: 3, lastActiveAt: new Date(), expiresAt: new Date(Date.now() + 60_000) })
  device.updateMany.mockResolvedValue({ count: 1 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); evictUserBanCache(userId) })

describe('R03 authentication unavailable is not authenticated', () => {
  it('keeps notFound distinct from unavailable and does not cache either failure', async () => {
    db.findUnique.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
    expect(await readUserAuthState(userId)).toEqual({ status: 'notFound' })
    expect(await readUserAuthState(userId)).toEqual({ status: 'unavailable' })
    expect(await readUserAuthState(userId)).toMatchObject({ status: 'verified', state: { tokenVersion: 3 } })
  })
  it('allows explicit public fallback only as anonymous, without weakening protected access', async () => {
    const req = request()
    db.findUnique.mockRejectedValue(new Error('offline'))
    await resolveSessionGate(req, response())
    expect(getPublicSessionUserId(req)).toBeNull()
    expect(() => requireSessionUserId(req)).toThrow(expect.objectContaining(unavailable))
  })
  it.each(['access-cookie', 'refresh-cookie', 'bearer-access', 'bearer-refresh'] as const)('blocks %s without clearing or renewing cookies', async channel => {
    const req = request(channel), res = response()
    db.findUnique.mockRejectedValue(new Error('database offline'))
    // Gate records failure so explicitly public routes can still serve anonymous data.
    await resolveSessionGate(req, res)
    expect(() => requireSessionUserId(req)).toThrow(expect.objectContaining(unavailable))
    expect(res.append).not.toHaveBeenCalled()
  })
  it('does not trust a fresh process cache when authorizing a new request', async () => {
    await getUserAuthState(userId)
    db.findUnique.mockRejectedValue(new Error('database offline'))
    const req = request()
    await resolveSessionGate(req, response())
    expect(() => getSessionUserId(req)).toThrow(expect.objectContaining(unavailable))
  })
  it.each([{ bannedAt: new Date(), tokenVersion: 3 }, { bannedAt: null, tokenVersion: 4 }])('rejects a newly banned or revoked account despite a warm cache (%j)', async state => {
    await getUserAuthState(userId)
    db.findUnique.mockResolvedValue(state)
    const req = request(), res = response()
    await resolveSessionGate(req, res)
    expect(getSessionUserId(req)).toBeNull()
    expect(res.append).toHaveBeenCalledTimes(2)
  })
  it('does not revive a deleted user from its prior cached state', async () => {
    await getUserAuthState(userId)
    db.findUnique.mockResolvedValue(null)
    const req = request(), res = response()
    await resolveSessionGate(req, res)
    expect(getSessionUserId(req)).toBeNull()
    expect(() => requireSessionUserId(req)).toThrow(expect.objectContaining({ status: 401 }))
  })
  it('cannot authenticate through local signature fallback when the gate was not run', () => {
    expect(() => getSessionUserId(request())).toThrow(expect.objectContaining(unavailable))
  })
  it('does not mint version-zero sessions when database lookup fails', async () => {
    db.findUnique.mockRejectedValue(new Error('database offline'))
    const res = response()
    await expect(createSession(userId, res)).rejects.toMatchObject(unavailable)
    expect(res.append).not.toHaveBeenCalled()
  })
  it.each([null, { bannedAt: new Date(), tokenVersion: 3 }])('does not mint sessions for deleted or banned accounts (%j)', async state => {
    db.findUnique.mockResolvedValue(state)
    const res = response()
    await expect(createSession(userId, res)).rejects.toMatchObject({ status: state ? 403 : 401 })
    expect(res.append).not.toHaveBeenCalled()
  })
  it('reports revocation failure instead of claiming that bearer tokens are revoked', async () => {
    db.update.mockRejectedValue(new Error('database offline'))
    await expect(revokeUserSessions(userId)).rejects.toMatchObject({ status: 503, code: 'AUTH_REVOCATION_UNAVAILABLE' })
  })
  it('still accepts validated access and rotates validated refresh tokens normally', async () => {
    for (const channel of ['access-cookie', 'refresh-cookie'] as const) {
      const req = request(channel), res = response()
      await resolveSessionGate(req, res)
      expect(requireSessionUserId(req)).toBe(userId)
      expect(res.append).toHaveBeenCalledTimes(channel === 'refresh-cookie' ? 2 : 0)
    }
  })
  it('authorizes a recent v3 session in one indexed read without an activity write', async () => {
    const deviceId = 'desktop-fixture'
    const tokens = buildSessionTokens(userId, 3, deviceId)
    const req = { headers: { authorization: 'Bearer ' + tokens.accessToken } } as Request
    joinedRead.mockResolvedValue([{ userId, tokenVersion: 3, accountVersion: 3, revokedAt: null, bannedAt: null,
      lastActiveAt: new Date(), expiresAt: new Date(Date.now() + 60000), phone: null, email: null, emailVerifiedAt: null }])
    await resolveSessionGate(req, response())
    expect(requireSessionUserId(req)).toBe(userId)
    expect(joinedRead).toHaveBeenCalledOnce()
    expect(db.findUnique).not.toHaveBeenCalled()
    expect(device.updateMany).not.toHaveBeenCalled()
  })
  it('rejects both access and refresh for a removed v3 session without recreating it', async () => {
    const tokens = buildSessionTokens(userId, 3, 'revoked-fixture')
    joinedRead.mockResolvedValue([])
    for (const token of [tokens.accessToken, tokens.refreshToken]) {
      const req = { headers: { authorization: 'Bearer ' + token } } as Request
      await resolveSessionGate(req, response())
      expect(getSessionUserId(req)).toBe(null)
    }
    expect(device.findUnique).not.toHaveBeenCalled()
  })
  it('does not access the database for an anonymous request', async () => {
    const req = { headers: {} } as Request
    await resolveSessionGate(req, response())
    expect(getSessionUserId(req)).toBeNull()
    expect(db.findUnique).not.toHaveBeenCalled()
  })
})
