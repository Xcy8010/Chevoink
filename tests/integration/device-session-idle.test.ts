import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { env } from '../../api/config/env.js'
import { buildSessionTokens, isDeviceSessionActive } from '../../api/lib/auth-session.js'
import { hashPassword } from '../../api/lib/password.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const day = 86_400_000
const activity = '/api/auth/session/activity'
const ids: string[] = []
async function account() {
  const id = randomUUID()
  await prisma.user.create({ data: { id, nickname: 'Synthetic idle session', passwordHash: 'fixture-only' } })
  ids.push(id)
  return id
}

async function device(userId: string, age: number) {
  const id = 'fg1-' + randomUUID()
  const lastActiveAt = new Date(Date.now() - age)
  await prisma.accountDeviceSession.create({ data: { id, userId, tokenVersion: 0, deviceName: 'Idle fixture',
    lastActiveAt, expiresAt: new Date(Date.now() + day) } })
  return { id, lastActiveAt, ...buildSessionTokens(userId, 0, id) }
}
const read = (id: string) => prisma.accountDeviceSession.findUniqueOrThrow({ where: { id } })
afterAll(async () => {
  if (available) await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

describe.skipIf(!available)('30 days since foreground use of each device session', () => {
  it('keeps two tabs sharing legacy cookies compatible and enrolls verified logins only on the separate host', async () => {
    const id = await account(), password = 'fixture-foreground-coverage'
    const phone = '+86139' + String(parseInt(id.slice(0, 8), 16) % 100_000_000).padStart(8, '0')
    await prisma.user.update({ where: { id }, data: { phone, passwordHash: hashPassword(password) } })
    const shared = new URL('http://shared-preview.localhost:4173'), dedicated = new URL('http://fg-preview.localhost:4173')
    const modern = { 'X-Chevoink-Foreground-Protocol': '1', Origin: dedicated.origin, Host: dedicated.host }
    const login = async (headers: Record<string, string>) => {
      const req = request(app).post('/api/auth/login').set(headers)
      const result = await req.send({ phone, password })
      expect(result.status).toBe(200)
      const tokens = result.body.data.tokens as { deviceSessionId: string; accessToken: string; refreshToken: string }
      const cookies = (result.headers['set-cookie'] as unknown as string[]).map(cookie => cookie.split(';')[0]).join('; ')
      return { ...tokens, cookies }
    }
    const original = { authForegroundActivityOrigin: env.authForegroundActivityOrigin, webUrl: env.webUrl, authCookieDomain: env.authCookieDomain }
    try {
      Object.assign(env, { authForegroundActivityOrigin: '', webUrl: shared.origin, authCookieDomain: '' })
      expect((await login(modern)).deviceSessionId).not.toMatch(/^fg1-/)
      env.authForegroundActivityOrigin = dedicated.origin
      const tabA = await login({ Host: shared.host, Origin: shared.origin })
      const compatible = await login({ ...modern, Host: shared.host, Origin: shared.origin, Cookie: tabA.cookies })
      expect(compatible.deviceSessionId).not.toMatch(/^fg1-/)
      const enrolled = await login(modern)
      expect(enrolled.deviceSessionId).toMatch(/^fg1-/)
      const unsupported: Array<Record<string, string>> = [
        { ...modern, Origin: 'null' }, { Host: dedicated.host, 'X-Chevoink-Foreground-Protocol': '1' },
        { ...modern, Host: shared.host, 'X-Forwarded-Host': dedicated.host },
        { ...modern, Origin: shared.origin }, { Origin: dedicated.origin, Host: dedicated.host },
      ]
      for (const headers of unsupported) expect((await login(headers)).deviceSessionId).not.toMatch(/^fg1-/)
      env.authCookieDomain = '.localhost'
      expect((await login(modern)).deviceSessionId).not.toMatch(/^fg1-/)
      env.authCookieDomain = ''
      env.authForegroundActivityOrigin = 'http://' + shared.hostname + ':4174'
      expect((await login({ ...modern, Origin: env.authForegroundActivityOrigin, Host: shared.hostname + ':4174' })).deviceSessionId).not.toMatch(/^fg1-/)
      env.authForegroundActivityOrigin = ''
      const old = new Date(Date.now() - 31 * day)
      for (const token of [compatible, enrolled]) {
        await prisma.accountDeviceSession.update({ where: { id: token.deviceSessionId }, data: { lastActiveAt: old } })
        const passive = await request(app).get('/api/auth/devices').set('Authorization', 'Bearer ' + token.refreshToken)
        expect(passive.status).toBe(token === compatible ? 200 : 401)
        expect((await read(token.deviceSessionId)).lastActiveAt).toEqual(old)
      }
      // Tab A still runs old JS without a reporter. The browser sends B's
      // current cookies, and no unobserved foreground use is inferred from this read.
      const resumedA = await request(app).get('/api/users/me').set('Host', shared.host).set('Cookie', compatible.cookies)
      expect(resumedA.status).toBe(200)
      expect(resumedA.body.data.deviceSessionId).toBe(compatible.deviceSessionId)
      expect((await read(compatible.deviceSessionId)).lastActiveAt).toEqual(old)
      const open = () => request(app).post(activity).set('Authorization', 'Bearer ' + compatible.refreshToken)
        .send({ userId: id, deviceId: compatible.deviceSessionId })
      expect((await open()).status).toBe(200)
      expect((await read(compatible.deviceSessionId)).lastActiveAt.getTime()).toBeGreaterThan(old.getTime())
      await prisma.accountDeviceSession.update({ where: { id: compatible.deviceSessionId }, data: { lastActiveAt: old } })
      expect(await isDeviceSessionActive({ userId: id, deviceId: compatible.deviceSessionId, tokenVersion: 0 })).toBe(true)
      await prisma.accountDeviceSession.update({ where: { id: compatible.deviceSessionId }, data: { expiresAt: new Date(0) } })
      expect((await open()).status).toBe(401)
      expect(await isDeviceSessionActive({ userId: id, deviceId: compatible.deviceSessionId, tokenVersion: 0 })).toBe(false)
    } finally { Object.assign(env, original) }
  })

  it('reopens every 29 days without input, keeps stale tabs from touching another login and never replaces main cookies', async () => {
    const id = await account(), secondUser = await account()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now(), first = await device(id, 0), second = await device(id, 0), foreign = await device(secondUser, 0)
      const open = (cookie: string, selection: string, owner: string, target: string) =>
        request(app).post(activity).set('Cookie', cookie).set('X-Chevoink-Device', selection).send({ userId: owner, deviceId: target })
      for (const next of [second, foreign]) {
        const mismatch = await open('chevoink_refresh=' + next.refreshToken, next.id, id, first.id)
        expect(mismatch.status).toBe(409)
        expect(mismatch.headers['set-cookie']).toBeUndefined()
        expect((await read(next.id)).lastActiveAt).toEqual(next.lastActiveAt)
      }
      await prisma.accountDeviceSession.update({ where: { id: first.id }, data: { expiresAt: new Date(start + 30 * day) } })
      let cookie = 'chevoink_refresh=' + first.refreshToken
      for (const days of [29, 58, 87]) {
        vi.setSystemTime(start + days * day)
        const opened = await open(cookie, first.id, id, first.id)
        expect(opened.status).toBe(200)
        const responseCookies = opened.headers['set-cookie'] as unknown as string[]
        expect(responseCookies).toHaveLength(1)
        expect(responseCookies[0].startsWith('chevoink_refresh_' + first.id + '=')).toBe(true)
        cookie = responseCookies[0].split(';')[0]
        expect((await open(cookie, first.id, id, first.id)).headers['set-cookie']).toBeUndefined()
        expect((await open(cookie, foreign.id, secondUser, foreign.id)).status).toBe(401)
      }
      const signedOut = await request(app).post('/api/auth/logout').set('Cookie', cookie).set('X-Chevoink-Device', first.id).send({})
      expect(signedOut.status).toBe(200)
      expect(signedOut.headers['set-cookie']).toContainEqual(expect.stringContaining('chevoink_refresh_' + first.id + '=;'))
      expect((await open(cookie, first.id, id, first.id)).status).toBe(401)
    } finally { vi.useRealTimers() }
  })

  it('keeps the rotated refresh valid through the last millisecond of the 30th day', async () => {
    const id = await account()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Math.floor(Date.now() / 1_000) * 1_000 + 700
      vi.setSystemTime(start)
      const session = await device(id, day)
      vi.setSystemTime(start + 1_000)
      const response = await request(app).post(activity).set('Cookie',
        'chevoink_session=' + session.accessToken + '; chevoink_refresh=' + session.refreshToken).send({ userId: id, deviceId: session.id })
      expect(response.status).toBe(200)
      const refreshCookie = (response.headers['set-cookie'] as unknown as string[])
        .find(item => item.startsWith('chevoink_refresh_' + session.id + '='))!.split(';')[0]
      vi.setSystemTime(start + 1_000 + 30 * day - 1)
      expect((await request(app).get(activity).set('Cookie', refreshCookie).set('X-Chevoink-Device', session.id)).status).toBe(200)
      vi.setSystemTime(start + 1_000 + 30 * day)
      expect((await request(app).get(activity).set('Cookie', refreshCookie).set('X-Chevoink-Device', session.id)).status).toBe(401)
    } finally { vi.useRealTimers() }
  })

  it('allows 29-day cookies and background refresh without updating activity; foreground use renews only this session', async () => {
    const id = await account(), recent = await device(id, 29 * day), other = await device(id, 2 * day)
    const cookies = 'chevoink_session=' + recent.accessToken + '; chevoink_refresh=' + recent.refreshToken
    expect((await request(app).get(activity).set('Cookie', cookies)).status).toBe(200)
    expect((await request(app).get('/api/auth/devices').set('Authorization', 'Bearer ' + recent.refreshToken)).status).toBe(200)
    expect((await read(recent.id)).lastActiveAt).toEqual(recent.lastActiveAt)
    const before = Date.now()
    const touch = await request(app).post(activity).set('Cookie', cookies).send({ userId: id, deviceId: recent.id, elapsedMs: 1_000 })
    expect(touch.status).toBe(200)
    expect(touch.headers['set-cookie']).toBeUndefined()
    const updated = await read(recent.id)
    expect(updated.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before - 1_000)
    expect(updated.lastActiveAt.getTime()).toBeLessThanOrEqual(Date.now() - 1_000)
    expect((await read(other.id)).lastActiveAt).toEqual(other.lastActiveAt)
    expect((await request(app).post(activity).set('Cookie', cookies).type('form').send({})).status).toBe(415)
    expect((await read(recent.id)).lastActiveAt).toEqual(updated.lastActiveAt)
  })

  it('rejects at the exact boundary, including refresh, foreground update, native credential and stream recheck', async () => {
    const id = await account()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = Date.now(), exact = await device(id, 30 * day - 1), old = await device(id, 31 * day), other = await device(id, day)
      const get = (token: string) => request(app).get(activity).set('Authorization', 'Bearer ' + token)
      expect((await get(exact.accessToken)).status).toBe(200)
      vi.setSystemTime(now + 1)
      for (const session of [exact, old]) {
        for (const token of [session.accessToken, session.refreshToken]) {
          expect((await get(token)).body.error.code).toBe('AUTH_SESSION_IDLE')
          expect((await request(app).post(activity).set('Authorization', 'Bearer ' + token).send({ userId: id, deviceId: session.id })).status).toBe(401)
        }
        expect(await isDeviceSessionActive({ userId: id, deviceId: session.id, tokenVersion: 0 })).toBe(false)
        expect((await read(session.id)).lastActiveAt).toEqual(session.lastActiveAt)
      }
      const devices = await request(app).get('/api/auth/devices').set('Authorization', 'Bearer ' + other.accessToken)
      expect(devices.body.data.devices.map((row: { id: string }) => row.id)).toEqual([other.id])
    } finally { vi.useRealTimers() }
  })
})
