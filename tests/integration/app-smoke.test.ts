import { integrationSmsRegistration } from '../support/sms-registration.js'
import request from 'supertest'
import { randomInt } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

/**
 * 集成冒烟：不依赖数据库的用例无条件执行（health/校验层）；
 * 需要数据库的用例在 DB 不可达时整组跳过（本地无 PG 时不误报）。
 * 顶层 await 探测：文件加载阶段完成，describe 收集时条件已就绪。
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`
  .then(() => true)
  .catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe('应用冒烟（无 DB 依赖）', () => {
  it('GET /api/health 返回 ok', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.status).toBe('ok')
  })

  it('未知路由返回 404 标准结构', async () => {
    const res = await request(app).get('/api/definitely-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
  })

  it('登录缺参返回 400 且不触库（zod 校验层）', async () => {
    const res = await request(app).post('/api/auth/login').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe('请输入手机号和密码。')
  })

  it('发码缺参返回 400', async () => {
    const res = await request(app).post('/api/auth/sms/send-code').send({ phone: '13800138000' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('未登录用户不能读取 Agent 私有附件', async () => {
    const res = await request(app).get('/api/uploads/agent-attachments/not-a-real-file.txt')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })
})

describe.skipIf(!dbAvailable)('应用冒烟（需 DB）', () => {
  it('两个注册入口竞争时仅创建一个账号，过期协议同意不会消费短信验证码', async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861379${unique}`
    const { code, legalConsent } = await integrationSmsRegistration(phone)
    const registration = { phone, code, legalConsent, nickname: `注册并发${unique}` }

    const stale = await request(app).post('/api/auth/sms/register').send({
      ...registration,
      legalConsent: { ...legalConsent, termsVersionId: 'stale-fixture' },
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('POLICY_CONSENT_REQUIRED')
    expect(stale.headers['set-cookie']).toBeUndefined()
    expect(await prisma.smsVerificationCode.count({ where: { phone, purpose: 'register', consumedAt: null } })).toBe(1)

    const results = await Promise.all([
      request(app).post('/api/auth/register').send(registration),
      request(app).post('/api/auth/sms/register').send(registration),
    ])
    expect(results.filter(response => response.status === 201)).toHaveLength(1)
    const rejected = results.find(response => response.status !== 201)
    expect(['SMS_CODE_INVALID', 'AUTH_ACCOUNT_EXISTS']).toContain(rejected?.body.error.code)
    expect(rejected?.headers['set-cookie']).toBeUndefined()
    const created = await prisma.user.findUniqueOrThrow({ where: { phone } })
    expect(await prisma.userLegalConsent.count({ where: { userId: created.id } })).toBe(2)
    expect(await prisma.smsVerificationCode.count({ where: { phone, purpose: 'register', consumedAt: { not: null } } })).toBe(1)
  })

  it('注册→登录→登出全链路', async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861398${unique}`
    const password = 'Smoke-Test-123!'

    const registerRes = await request(app)
      .post('/api/auth/register').set('User-Agent', 'Mozilla/5.0 (Linux; Android 10; K) Chrome/131.0')
      .send({ ...await integrationSmsRegistration(phone), phone, nickname: `冒烟测试用户${unique}`, password })
    expect(registerRes.status).toBe(201)
    expect(registerRes.body.data.tokens.accessToken).toMatch(/^v3\./)
    // v2 双 cookie：access + refresh 同时下发
    const setCookies = registerRes.headers['set-cookie']
    const cookies = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []
    expect(cookies.some((c) => c.startsWith('chevoink_session='))).toBe(true)
    expect(cookies.some((c) => c.startsWith('chevoink_refresh='))).toBe(true)

    const activityRes = await request(app)
      .get('/api/credits/activity')
      .set('Cookie', `chevoink_session=${registerRes.body.data.tokens.accessToken}`)
    expect(activityRes.status).toBe(200)
    expect(activityRes.body.data.stats).toMatchObject({
      cumulativeSpent: 0,
      totalModelCalls: 0,
      currentStreakDays: 0,
    })

    const loginRes = await request(app).post('/api/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14; SM-S9210 Build/UP1A.231005.007; wv) Chrome/130.0')
      .send({ phone, password })
    expect(loginRes.status).toBe(200)

    const desktop = `Bearer ${registerRes.body.data.tokens.accessToken}`
    const phoneSession = `Bearer ${loginRes.body.data.tokens.accessToken}`
    const list = await request(app).get('/api/auth/devices').set('Authorization', desktop)
      .set('User-Agent', 'Mozilla/5.0 (Linux; Android 10; K) Chrome/131.0').set('Sec-CH-UA-Model', '"Pixel 8 Pro"')
    expect(list.status).toBe(200)
    expect(list.body.data.devices).toHaveLength(2)
    const [current] = list.body.data.devices.filter((device: { current: boolean }) => device.current)
    const [other] = list.body.data.devices.filter((device: { current: boolean }) => !device.current)
    expect(current.deviceName).toBe('Android · Pixel 8 Pro · Chrome')
    expect(other.deviceName).toBe('Android · SM-S9210 · 应用')
    const remove = (id: string, value: string) => request(app).post(`/api/auth/devices/${id}/revoke`)
      .set('Authorization', desktop).send({ password: value })
    expect((await remove(other.id, 'wrong-password')).status).toBe(403)
    const denied = await remove(current.id, 'wrong-password')
    expect(denied.status).toBe(403)
    expect(denied.headers['set-cookie']).toBeUndefined()
    expect((await request(app).get('/api/auth/devices').set('Authorization', phoneSession)).status).toBe(200)
    const removedOther = await remove(other.id, password)
    expect(removedOther.status).toBe(200)
    expect(removedOther.body.data).toEqual({ revoked: true, signedOutCurrent: false })
    expect(removedOther.headers['set-cookie']).toBeUndefined()
    for (const token of Object.values(loginRes.body.data.tokens).filter((value): value is string => typeof value === 'string')) {
      expect((await request(app).get('/api/auth/devices').set('Authorization', 'Bearer ' + token)).status).toBe(401)
    }
    expect((await request(app).get('/api/auth/devices').set('Authorization', desktop)).body.data.devices).toHaveLength(1)

    const relogin = await request(app).post('/api/auth/login').send({ phone, password })
    expect(relogin.status).toBe(200)
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `chevoink_refresh=${relogin.body.data.tokens.refreshToken}`)
    expect(logoutRes.status).toBe(200)

    expect((await request(app).get('/api/auth/devices').set('Authorization', desktop)).body.data.devices).toHaveLength(1)
    // 登出后 refresh 已吊销，重复退出保持幂等。
    const revoked = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `chevoink_refresh=${relogin.body.data.tokens.refreshToken}`)
    expect(revoked.status).toBe(200)
    const signedOut = await remove(current.id, password)
    expect(signedOut.status).toBe(200)
    expect(signedOut.body.data).toEqual({ revoked: true, signedOutCurrent: true })
    expect(signedOut.headers['set-cookie']).toEqual([
      expect.stringMatching(/^chevoink_session=;.*Max-Age=0/), expect.stringMatching(/^chevoink_refresh=;.*Max-Age=0/),
    ])
    for (const token of [registerRes.body.data.tokens.accessToken, registerRes.body.data.tokens.refreshToken]) {
      expect((await request(app).get('/api/auth/devices').set('Authorization', 'Bearer ' + token)).status).toBe(401)
    }
  })
})
