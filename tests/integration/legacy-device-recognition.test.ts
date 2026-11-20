import { createHmac, randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { env } from '../../api/config/env.js'
import { hashPassword } from '../../api/lib/password.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const ids: string[] = []
const password = 'fixture-legacy-password'
const endpoint = '/api/auth/devices'
const sign = (value: string) => createHmac('sha256', env.authSessionSecret).update(value).digest('hex')
async function account() {
  const id = randomUUID()
  await prisma.user.create({ data: { id, nickname: 'Synthetic legacy fixture', passwordHash: hashPassword(password) } })
  ids.push(id)
  return id
}
function pair(user: string, issued: number, group?: string) {
  const prefix = group ? 'v3.' + group : 'v2'
  const token = (life: number, kind: string) => {
    const data = [prefix, user, issued + life, 0, kind].join('.')
    return data + '.' + sign(data)
  }
  return { access: token(900, 'access'), refresh: token(2592000, 'refresh') }
}
const cookies = (tokens: ReturnType<typeof pair>) => 'chevoink_session=' + tokens.access + '; chevoink_refresh=' + tokens.refresh
const byBearer = (token: string) => request(app).get(endpoint).set('Authorization', 'Bearer ' + token)
const current = (response: request.Response) => {
  expect(response.status).toBe(200)
  return response.body.data.devices.find((row: { current: boolean }) => row.current)
}
const responseCookies = (response: request.Response) => (response.headers['set-cookie'] as unknown as string[]).map(item => item.split(';')[0]).join('; ')
afterAll(async () => {
  if (dbAvailable) await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

describe.skipIf(!dbAvailable)('upgrade signed sessions on first visit', () => {
  it('registers desktop and Android separately, matches concurrent cookie and native access/refresh, and revokes every form', async () => {
    const id = await account(), issued = Math.floor(Date.now() / 1000) - 5
    const desktop = pair(id, issued), phone = pair(id, issued + 1)
    const desktopResponse = await request(app).get(endpoint).set('Cookie', cookies(desktop)).set('User-Agent', 'Windows Chrome/130.0')
    const pc = current(desktopResponse)
    expect(pc).toMatchObject({ deviceName: 'Windows · Chrome', firstSeenOnly: true })
    const upgradedDesktop = responseCookies(desktopResponse)
    expect(upgradedDesktop).toContain('chevoink_refresh=v3.' + pc.id)
    expect(current(await request(app).get(endpoint).set('Cookie', upgradedDesktop)).id).toBe(pc.id)
    const [viaCookie, viaRefresh, viaAccess] = await Promise.all([
      request(app).get(endpoint).set('Cookie', 'chevoink_session=' + phone.access).set('Authorization', 'Bearer ' + phone.refresh),
      byBearer(phone.refresh), byBearer(phone.access),
    ].map(q => q.set('User-Agent', 'Android; wv) Chrome/130.0')))
    const android = current(viaCookie)
    expect(android).toMatchObject({ deviceName: 'Android · 应用', firstSeenOnly: true })
    expect(current(viaRefresh).id).toBe(android.id)
    expect(current(viaAccess).id).toBe(android.id)
    expect(android.id).not.toBe(pc.id)
    expect(await prisma.accountDeviceSession.count({ where: { userId: id } })).toBe(2)
    const remove = await request(app).post(endpoint + '/' + android.id + '/revoke').set('Cookie', upgradedDesktop).send({ password })
    expect(remove.status).toBe(200)
    for (const check of [byBearer(phone.access), byBearer(phone.refresh), request(app).get(endpoint).set('Cookie', responseCookies(viaRefresh))]) {
      expect((await check.set('User-Agent', 'Windows Firefox')).status).toBe(401)
    }
    expect(current(await byBearer(desktop.access)).id).toBe(pc.id)
    expect((await byBearer(pair(id, issued - 1).refresh)).status).toBe(401)
    expect((await request(app).get(endpoint).set('Cookie', upgradedDesktop)).body.data.devices).toHaveLength(1)
  })

  it('preserves previous group revocation, account version and signed expiry', async () => {
    const id = await account(), issued = Math.floor(Date.now() / 1000) - 5
    const group = 'legacy-' + sign('legacy/' + id + '/0').slice(0, 48)
    const tokens = pair(id, issued, group), older = pair(id, issued)
    expect((await byBearer(tokens.refresh)).status).toBe(401)
    await prisma.accountDeviceSession.create({ data: { id: group, userId: id, tokenVersion: 0,
      expiresAt: new Date(Date.now() + 100000), deviceName: '旧版登录（合并显示）' } })
    const result = await request(app).get(endpoint).set('Cookie', cookies(tokens))
    expect(current(result)).toMatchObject({ legacyGroup: true, firstSeenOnly: true })
    expect(current(result).id).not.toBe(group)
    expect(result.body.data.devices).toHaveLength(1)
    await prisma.accountDeviceSession.update({ where: { id: group }, data: { revokedAt: new Date() } })
    for (const check of [byBearer(older.refresh), byBearer(tokens.access), request(app).get(endpoint).set('Cookie', responseCookies(result))]) {
      expect((await check).status).toBe(401)
    }
    await prisma.accountDeviceSession.update({ where: { id: group }, data: { revokedAt: null, expiresAt: new Date(0) } })
    expect((await byBearer(tokens.refresh)).status).toBe(401)
    const another = await account()
    expect((await byBearer(pair(another, issued - 2592000).refresh)).status).toBe(401)
    await prisma.user.update({ where: { id: another }, data: { tokenVersion: 1 } })
    expect((await byBearer(pair(another, issued).access)).status).toBe(401)
    expect(await prisma.accountDeviceSession.count({ where: { userId: another } })).toBe(0)
  })

  it('revokes Android WebView cookies and the retained, older native Bearer together without affecting new logins', async () => {
    const id = await account(), issued = Math.floor(Date.now() / 1000) - 9
    const original = pair(id, issued)
    const group = 'legacy-' + sign('legacy/' + id + '/0').slice(0, 48)
    await prisma.accountDeviceSession.create({ data: { id: group, userId: id, tokenVersion: 0,
      expiresAt: new Date(Date.now() + 100000), deviceName: '旧版登录（合并显示）' } })
    const webview = pair(id, issued + 4, group)
    const result = await request(app).get(endpoint).set('Cookie', cookies(webview)).set('Authorization', 'Bearer ' + original.refresh)
    expect(current(result).legacyGroup).toBe(true)
    expect(current(await byBearer(original.refresh)).legacyGroup).toBe(true)
    const newDevice = randomUUID(), standalone = pair(id, issued, newDevice)
    await prisma.accountDeviceSession.create({ data: { id: newDevice, userId: id, tokenVersion: 0,
      expiresAt: new Date(Date.now() + 100000), deviceName: 'Desktop' } })
    expect((await request(app).post(endpoint + '/' + current(result).id + '/revoke')
      .set('Authorization', 'Bearer ' + standalone.access).send({ password })).status).toBe(200)
    for (const token of [original.access, original.refresh, webview.access, webview.refresh]) expect((await byBearer(token)).status).toBe(401)
    expect((await request(app).get(endpoint).set('Cookie', responseCookies(result))).status).toBe(401)
    expect((await byBearer(standalone.access)).body.data.devices).toHaveLength(1)
  })

  it('preserves a nondefault deployment’s shared identity and revocation after switching lifetimes', async () => {
    const id = await account(), now = Math.floor(Date.now() / 1000)
    const tokens = { access: '', refresh: '' }
    for (const [kind, ttl] of [['access', 60], ['refresh', 10800]] as const) {
      const data = ['v2', id, now + ttl, 0, kind].join('.')
      tokens[kind] = data + '.' + sign(data)
    }
    vi.stubEnv('AUTH_ACCESS_TOKEN_EXPIRES_IN', '1m')
    vi.stubEnv('AUTH_REFRESH_TOKEN_EXPIRES_IN', '3h')
    vi.resetModules()
    try {
      const custom = (await import('../../api/app.js')).default
      const first = await request(custom).get(endpoint).set('Cookie', cookies(tokens))
      expect(current(first)).toMatchObject({ legacyGroup: true, deviceName: '旧版登录（合并显示）' })
      const idInList = current(first).id
      // The original app instance still uses default lifetimes.
      expect(current(await byBearer(tokens.refresh)).id).toBe(idInList)
      expect((await request(app).post('/api/auth/logout').set('Authorization', 'Bearer ' + tokens.access)).status).toBe(200)
      expect((await byBearer(tokens.refresh)).status).toBe(401)
      expect((await request(custom).get(endpoint).set('Cookie', cookies(tokens))).status).toBe(401)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it.each(['v2', 'upgraded'] as const)('links a %s refresh-only cookie and a different stored refresh Bearer even when both were already recognized', async mode => {
    const id = await account(), issued = Math.floor(Date.now() / 1000) - 2000
    const cookiePair = pair(id, issued), nativePair = pair(id, issued - 10)
    const upgradedCookie = await byBearer(cookiePair.refresh)
    const upgradedNative = await byBearer(nativePair.refresh)
    expect(current(upgradedCookie).id).not.toBe(current(upgradedNative).id)
    const refreshCookie = mode === 'v2' ? 'chevoink_refresh=' + cookiePair.refresh :
      responseCookies(upgradedCookie).split('; ').find(cookie => cookie.startsWith('chevoink_refresh='))!
    const expiredAccess = 'chevoink_session=' + cookiePair.access + '; '
    const combined = await request(app).get(endpoint).set('Cookie', expiredAccess + refreshCookie).set('Authorization', 'Bearer ' + nativePair.refresh)
    expect(current(combined)).toMatchObject({ id: current(upgradedCookie).id, legacyGroup: true })
    expect((await request(app).post('/api/auth/logout').set('Cookie', responseCookies(combined))).status).toBe(200)
    for (const check of [byBearer(cookiePair.refresh), byBearer(nativePair.refresh), request(app).get(endpoint).set('Cookie', responseCookies(upgradedNative))]) {
      expect((await check).status).toBe(401)
    }
  })

  it('keeps access-only validity, ignores an unrelated refresh, and refreshes stale device location', async () => {
    const id = await account(), issued = Math.floor(Date.now() / 1000) - 5
    const tokens = pair(id, issued)
    const result = await byBearer(tokens.access)
    const row = current(result)
    expect(result.headers['set-cookie']).toBeUndefined()
    const details = await prisma.accountDeviceSession.findUniqueOrThrow({ where: { id: row.id } })
    expect(details.expiresAt.getTime()).toBe((issued + 900) * 1000)
    const unrelated = await request(app).get(endpoint).set('Cookie', 'chevoink_session=' + tokens.access + '; chevoink_refresh=' + pair(id, issued - 1).refresh)
    expect(current(unrelated).id).toBe(row.id)
    expect(unrelated.headers['set-cookie']).toBeUndefined()
    await prisma.accountDeviceSession.update({ where: { id: row.id }, data: { location: 'old value', lastActiveAt: new Date(0) } })
    expect((await byBearer(tokens.access)).status).toBe(200)
    await expect.poll(async () => (await prisma.accountDeviceSession.findUniqueOrThrow({ where: { id: row.id } })).location).toBe('本机')
    const payload = id + '.' + (issued + 500)
    const v1 = await byBearer(payload + '.' + sign(payload))
    expect(current(v1).id).not.toBe(row.id)
    expect(v1.headers['set-cookie']).toBeUndefined()
    expect(await prisma.accountDeviceSession.findUniqueOrThrow({ where: { id: current(v1).id } })).toMatchObject({ expiresAt: new Date((issued + 500) * 1000) })
  })
})
