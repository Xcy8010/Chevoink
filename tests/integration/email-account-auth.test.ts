import { createHmac, randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { env } from '../../api/config/env.js'
import { assertPreviewSmsSendAllowed, withAccountEmailAuthPreview } from '../../api/lib/account-email-auth-scope.js'
import { assertStudioAccountAccess } from '../../api/lib/account-access.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { sendAccountEmailCode } from '../../api/lib/email-verification.js'
import { hashPassword } from '../../api/lib/password.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { integrationLegalConsent } from '../support/legal-consent.js'
import { openReservedAdminFixture } from '../support/reserved-admin-database.js'

const fixture = vi.hoisted(() => ({ reserved: undefined as Awaited<ReturnType<typeof openReservedAdminFixture>> | undefined }))
vi.mock('../../api/lib/prisma.js', async original => {
  const actual = await original<typeof import('../../api/lib/prisma.js')>()
  return { ...actual, get prisma() { return fixture.reserved ?? actual.prisma } }
})

const smsCodes = vi.hoisted(() => new Map<string, string>())
vi.mock('tencentcloud-sdk-nodejs-sms', () => ({
  sms: { v20210111: { Client: class {
    async SendSms(input: { PhoneNumberSet: string[]; TemplateParamSet: string[] }) {
      smsCodes.set(input.PhoneNumberSet[0], input.TemplateParamSet[0])
      return { SendStatusSet: [{ Code: 'Ok' }] }
    }
  } } },
}))
vi.mock('svg-captcha', () => ({ default: {
  create: () => ({ data: '<svg xmlns="http://www.w3.org/2000/svg"/>', text: 'TEST' }),
} }))

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const mailCodes = new Map<string, string>()
const uncertainAddresses = new Set<string>()
const deliveryCalls = new Map<string, number>()
const recipient = () => `${randomUUID()}@example.test`
const cookie = (token: string) => `chevoink_session=${token}`
const api = () => request(app)
const auth = '/api/auth'
const requesterPrefix = '2001:db8:' + randomUUID().slice(0, 8).replace(/^(.{4})(.{4})$/, '$1:$2')
let requestNumber = 0
const nextRequester = () => requesterPrefix + '::' + (++requestNumber).toString(16)

async function captcha(answer = 'test') {
  const response = await api().get(auth + '/captcha')
  return { captchaId: response.body.data.captchaId as string, captchaAnswer: answer }
}

async function ageEmail(email: string) {
  await prisma.emailVerificationCode.updateMany({
    where: { email }, data: { createdAt: new Date(Date.now() - 70_000) },
  })
  mailCodes.delete(email)
}

async function emailCode(path: string, body: object, address: string, token?: string) {
  await ageEmail(address)
  const req = api().post(auth + path).set('X-Forwarded-For', nextRequester())
  if (token) req.set('Cookie', cookie(token))
  const sent = await req.send({ ...body, ...await captcha() })
  expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  await vi.waitFor(async () => {
    expect(mailCodes.get(address)).toMatch(/^\d{6}$/)
    const row = await prisma.emailVerificationCode.findFirst({
      where: { email: address }, orderBy: { createdAt: 'desc' },
    })
    expect(row?.sendState).toBe('accepted')
  })
  return mailCodes.get(address)!
}

async function smsCode(path: string, body: object, phone: string, token?: string) {
  smsCodes.delete(phone)
  await prisma.smsVerificationCode.updateMany({
    where: { phone }, data: { createdAt: new Date(Date.now() - 70_000) },
  })
  const req = api().post(auth + path).set('X-Forwarded-For', nextRequester())
  if (token) req.set('Cookie', cookie(token))
  const sent = await req.send({ ...body, ...await captcha() })
  expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  await vi.waitFor(async () => {
    expect(smsCodes.get(phone)).toMatch(/^\d{4,8}$/)
    const row = await prisma.smsVerificationCode.findFirst({
      where: { phone }, orderBy: { createdAt: 'desc' },
    })
    expect(row?.sendState).toBe('accepted')
  })
  return smsCodes.get(phone)!
}

describe.skipIf(!available)('email-first accounts against isolated PostgreSQL and fake providers', () => {
  const saved = { ...env }
  beforeAll(() => {
    Object.assign(env, {
      accountEmailAuthEnabled: true, emailTencentSecretId: 'test-id', emailTencentSecretKey: 'test-secret',
      emailTencentRegion: 'ap-hongkong', emailTencentFromAddress: 'chevoink@example.test',
      emailTencentTemplateId: 1, emailCodeExpireMinutes: 5, smsProviderMode: 'provider',
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) !== 'https://ses.tencentcloudapi.com/') throw new Error('Unexpected fake transport URL')
      const body = JSON.parse(String(init?.body))
      const address = String(body.Destination[0])
      mailCodes.set(address, JSON.parse(body.Template.TemplateData).code)
      deliveryCalls.set(address, (deliveryCalls.get(address) ?? 0) + 1)
      if (uncertainAddresses.has(address)) throw new DOMException('simulated timeout', 'TimeoutError')
      return Response.json({ Response: { RequestId: 'fixture-request', MessageId: 'fixture-accepted' } })
    }))
  })
  afterAll(async () => {
    Object.assign(env, saved)
    vi.unstubAllGlobals()
    await prisma.$disconnect()
  })

  it('reserves only one scoped registration dispatch across concurrent sends and subsequent delivery states', async () => {
    const email = recipient()
    const preview = {
      recipient: email,
      selection: { mode: 'legacy', channel: 'stable', release: null } as const,
    }
    await withAccountEmailAuthPreview(preview, async () => {
      const requester = nextRequester()
      const send = () => sendAccountEmailCode({ email, purpose: 'register', userId: null }, requester, true)
      await expect(sendAccountEmailCode({ email: recipient(), purpose: 'register', userId: null }, requester, true))
        .rejects.toMatchObject({ code: 'AUTH_PREVIEW_RECIPIENT_REQUIRED' })
      await expect(sendAccountEmailCode({ email, purpose: 'login', userId: null }, requester, true))
        .rejects.toMatchObject({ code: 'AUTH_PREVIEW_REGISTRATION_ONLY' })
      expect(assertPreviewSmsSendAllowed).toThrow(expect.objectContaining({ code: 'AUTH_PREVIEW_SMS_DISABLED' }))
      const results = await Promise.allSettled([send(), send()])
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'AUTH_PREVIEW_DISPATCH_USED' }) }),
      ]))
      await vi.waitFor(async () => {
        expect(await prisma.emailVerificationCode.findFirst({ where: { email } })).toMatchObject({ sendState: 'accepted' })
      })
      for (const sendState of ['pending', 'unknown', 'rejected'] as const) {
        await prisma.emailVerificationCode.updateMany({ where: { email }, data: { sendState } })
        await expect(send()).rejects.toMatchObject({ code: 'AUTH_PREVIEW_DISPATCH_USED' })
      }
      expect(deliveryCalls.get(email)).toBe(1)
      expect(await prisma.emailVerificationCode.count({ where: { email } })).toBe(1)
    })
  })

  it('keeps phone-skipped email signups out of Studio and private attachments after preview ends', async () => {
    const emailOnly = await prisma.user.create({ data: {
      email: recipient(), emailVerifiedAt: new Date(), accountSetupFinishedAt: new Date(),
      accountSetupSkippedSteps: [1, 2, 3], nickname: 'Email preview fixture', passwordHash: 'unset:fixture',
    } })
    const ordinary = await prisma.user.create({ data: {
      phone: `+86138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, nickname: 'Ordinary stable fixture', passwordHash: 'unset:fixture',
    } })
    const previouslyEnabled = env.accountEmailAuthEnabled
    env.accountEmailAuthEnabled = false
    try {
      const token = buildSessionTokens(emailOnly.id, emailOnly.tokenVersion).accessToken
      expect((await api().get(auth + '/options').set('Cookie', cookie(token))).body.data.emailAuthEnabled).toBe(false)
      for (const url of ['/api/novels/fixture/studio', `/api/uploads/agent-attachments/${emailOnly.id}/sample.txt`]) {
        const response = await api().get(url).set('Cookie', cookie(token))
        expect(response.status).toBe(403)
        expect(response.body.error.code).toBe('AUTH_PHONE_VERIFICATION_REQUIRED')
      }
      await expect(assertStudioAccountAccess(ordinary.id)).resolves.toBeUndefined()
    } finally {
      env.accountEmailAuthEnabled = previouslyEnabled
    }
  })

  it('requires server captcha, isolates purposes and consumes a registration code exactly once', async () => {
    const email = recipient()
    const { legalConsent } = await integrationLegalConsent()
    const invalidCaptcha = await api().post(auth + '/email/send-code').send({
      email, purpose: 'register', ...await captcha('wrong'),
    })
    expect(invalidCaptcha.body.error.code).toBe('AUTH_CAPTCHA_INVALID')
    expect(await prisma.emailVerificationCode.count({ where: { email } })).toBe(0)
    expect((await api().post(auth + '/sms/register').send({})).body.error.code).toBe('AUTH_EMAIL_REGISTRATION_REQUIRED')
    const code = await emailCode('/email/send-code', { email, purpose: 'register' }, email)
    const otherPurpose = await api().post(auth + '/email/login').send({ email, code })
    expect(otherPurpose.body.error.code).toBe('AUTH_CODE_INVALID')
    const stalePolicy = await api().post(auth + '/email/register').send({
      email, code, legalConsent: { ...legalConsent, termsVersionId: 'obsolete-fixture' },
    })
    expect(stalePolicy.body.error.code).toBe('POLICY_CONSENT_REQUIRED')
    const results = await Promise.all(['email/register', 'email/register'].map(path =>
      api().post(`${auth}/${path}`).send({ email: email.toUpperCase(), code, legalConsent }),
    ))
    const created = results.find(res => res.status === 201)
    expect(results.filter(res => res.status === 201)).toHaveLength(1)
    const user = created!.body.data.user
    expect(user).toMatchObject({ email, emailVerified: true, phoneVerified: false, accountSetupStep: 1, passwordConfigured: false })
    expect(user.nickname).not.toContain(email.split('@')[0])
    expect(await prisma.userLegalConsent.count({ where: { userId: user.id } })).toBe(2)
    expect(await prisma.emailVerificationCode.count({ where: { email, consumedAt: { not: null } } })).toBe(1)
    const profile = await api().get(`/api/users/${user.id}`)
    expect(profile.status).toBe(200)
    expect(JSON.stringify(profile.body)).not.toContain(email)
  })

  it('changes a password with current credentials and invalidates previous sessions and recovery codes', async () => {
    const email = recipient()
    const user = await prisma.user.create({ data: {
      email, emailVerifiedAt: new Date(), nickname: 'Password settings fixture', passwordHash: 'unset:fixture',
    } })
    try {
      const url = auth + '/account/password'
      const initial = buildSessionTokens(user.id, user.tokenVersion)
      const oldSession = cookie(initial.accessToken)
      const change = { oldPassword: 'current-secret', password: 'replacement-secret' }
      expect((await api().post(url).send(change)).status).toBe(401)
      expect((await api().post(url).set('Cookie', oldSession).send(change)).body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
      const setupCode = await emailCode('/account/password/send-code', { channel: 'email' }, email, initial.accessToken)
      const set = await api().post(url).set('Cookie', oldSession).send({ channel: 'email', code: setupCode, password: change.oldPassword })
      expect(set.status).toBe(200)
      const configured = set.body.data.tokens
      const changeRequest = () => api().post(url).set('Cookie', cookie(configured.accessToken))
      expect((await changeRequest().send({ ...change, oldPassword: 'incorrect' })).body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
      const pending = await emailCode('/account/password/send-code', { channel: 'email' }, email, configured.accessToken)
      const results = await Promise.all([changeRequest().send(change), changeRequest().send(change)])
      expect(results.filter(res => res.status === 200)).toHaveLength(1)
      expect([401, 403, 409]).toContain(results.find(res => res.status !== 200)?.status)
      const renewed = results.find(res => res.status === 200)!.body.data.tokens.accessToken
      const me = () => api().get('/api/users/me')
      expect((await me().set('Cookie', cookie(configured.accessToken))).status).toBe(401)
      expect((await me().set('Cookie', `chevoink_refresh=${configured.refreshToken}`)).status).toBe(401)
      expect((await me().set('Cookie', cookie(renewed))).body.data.user.id).toBe(user.id)
      expect((await api().post(url).set('Cookie', cookie(renewed)).send({
        channel: 'email', code: pending, password: 'unused-password',
      })).body.error.code).toBe('AUTH_CODE_INVALID')
      expect((await api().post(auth + '/login').send({ identifier: email, password: change.password })).body.data.user.id).toBe(user.id)
    } finally {
      await prisma.user.delete({ where: { id: user.id } })
    }
  })

  it('observes an email password failure burst followed by a foreign login without interrupting sign-in', async () => {
    const email = recipient()
    const password = 'observation-fixture-password'
    const user = await prisma.user.create({ data: {
      email, emailVerifiedAt: new Date(), nickname: 'Observation fixture', passwordHash: hashPassword(password),
    } })
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    const login = (candidate: string, address: string) => api().post(auth + '/login')
      .set('X-Forwarded-For', '198.51.100.197').set('X-Real-IP', address)
      .send({ identifier: email, password: candidate })
    try {
      expect((await login(password, '113.118.113.77')).status).toBe(200)
      for (let attempt = 0; attempt < 5; attempt++) {
        const failed = await login('incorrect-fixture-password', '8.8.8.8')
        expect(failed.status).toBe(401)
        expect(failed.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
      }
      expect(output).toHaveBeenCalledWith('[account-security-observation]', expect.objectContaining({
        action: 'password_login', stage: 'failed', decision: 'notice',
      }))
      const accepted = await login(password, '8.8.8.8')
      expect(accepted.status).toBe(200)
      expect(accepted.body.data.user.id).toBe(user.id)
      expect(accepted.body.data.tokens.accessToken).toBeTruthy()
      await vi.waitFor(() => expect(output).toHaveBeenCalledWith('[account-security-observation]', {
        action: 'password_login', stage: 'succeeded', decision: 'would_verify',
        repeatedFailures: true, countryChanged: true, deviceEvidence: 'unknown',
      }))
      const previous = await prisma.accountDeviceSession.findFirstOrThrow({
        where: { userId: user.id, location: { startsWith: '中国' } }, select: { id: true },
      })
      const removed = await api().post(auth + '/devices/' + previous.id + '/revoke')
        .set('Cookie', cookie(accepted.body.data.tokens.accessToken)).set('X-Real-IP', '8.8.8.8').send({ password })
      expect(removed.status).toBe(200)
      expect(removed.body.data.revoked).toBe(true)
      await vi.waitFor(() => expect(output).toHaveBeenCalledWith('[account-security-observation]', {
        action: 'device_revoke', stage: 'succeeded', decision: 'notice',
        repeatedFailures: false, countryChanged: true, deviceEvidence: 'recent_session',
      }))
    } finally {
      output.mockRestore()
      await prisma.user.delete({ where: { id: user.id } })
    }
  })

  it('accepts a valid v1 session for an old-password change and revokes it after renewal', async () => {
    const oldPassword = 'historical-password'
    const user = await prisma.user.create({ data: {
      email: recipient(), emailVerifiedAt: new Date(), nickname: 'Legacy password fixture', passwordHash: hashPassword(oldPassword),
    } })
    try {
      const payload = user.id + '.' + (Math.floor(Date.now() / 1000) + 600)
      const signature = createHmac('sha256', env.authSessionSecret).update(payload).digest('hex')
      const oldSession = cookie(payload + '.' + signature)
      const response = await api().post(auth + '/account/password').set('Cookie', oldSession)
        .send({ oldPassword, password: 'renewed-password' })
      expect(response.status).toBe(200)
      const me = () => api().get('/api/users/me')
      expect((await me().set('Cookie', oldSession)).status).toBe(401)
      expect((await me().set('Cookie', cookie(response.body.data.tokens.accessToken))).body.data.user.id).toBe(user.id)
    } finally {
      await prisma.user.delete({ where: { id: user.id } })
    }
  })

  it('persists each onboarding step, enforces the studio boundary and uses both verified identifiers', async () => {
    const email = recipient()
    const phone = `+86137${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const user = await prisma.user.create({ data: {
      email, emailVerifiedAt: new Date(), accountSetupStep: 1, nickname: 'Setup fixture', passwordHash: 'unset:fixture',
    } })
    const initial = buildSessionTokens(user.id, 0)
    const token = initial.accessToken
    const post = (path: string, body: object, access = token) =>
      api().post(auth + path).set('Cookie', cookie(access)).send(body)
    expect((await post('/account/setup', { step: 3, skip: true })).body.data.user.accountSetupStep).toBe(1)
    expect((await post('/account/setup', { step: 1, skip: false })).body.error.code).toBe('AUTH_SETUP_INCOMPLETE')
    const password = 'synthetic-password'
    expect((await api().post(auth + '/account/setup/password').send({ password })).status).toBe(401)
    expect((await post('/account/setup/password', { password })).body.error.code).toBe('AUTH_SETUP_PASSWORD_UNAVAILABLE')
    expect((await post('/account/setup', { step: 1, skip: true })).body.data.user.accountSetupStep).toBe(2)
    expect((await post('/account/setup/back', { step: 2 })).body.data.user.accountSetupStep).toBe(1)
    expect((await post('/account/setup/back', { step: 2 })).body.data.user.accountSetupStep).toBe(1)
    expect((await post('/account/setup', { step: 1, skip: true })).body.data.user.accountSetupStep).toBe(2)
    expect((await post('/account/setup', { step: 2, skip: true })).body.data.user.accountSetupStep).toBe(3)
    expect((await post('/account/setup/back', { step: 3 })).body.data.user.accountSetupStep).toBe(2)
    expect((await api().get('/api/users/me').set('Cookie', cookie(token))).body.data.user.accountSetupStep).toBe(2)
    expect((await api().post(auth + '/account/setup/password').set('Cookie', cookie(token)).type('form').send({ password })).status).toBe(415)
    const pendingCode = await emailCode('/account/password/send-code', { channel: 'email' }, email, token)
    const attempts = await Promise.all([post('/account/setup/password', { password }), post('/account/setup/password', { password })])
    expect(attempts.filter(response => response.status === 200)).toHaveLength(1)
    expect([401, 409]).toContain(attempts.find(response => response.status !== 200)?.status)
    const set = attempts.find(response => response.status === 200)!
    expect(set.body.data.user).toMatchObject({ id: user.id, hasPassword: true, accountSetupStep: 3 })
    expect((await api().get('/api/users/me').set('Cookie', cookie(token))).status).toBe(401)
    expect((await api().get('/api/users/me').set('Cookie', `chevoink_refresh=${initial.refreshToken}`)).status).toBe(401)
    const fresh = set.body.data.tokens.accessToken as string
    expect((await post('/account/password', { channel: 'email', code: pendingCode, password: 'new-password' }, fresh)).body.error.code)
      .toBe('AUTH_CODE_INVALID')
    expect((await post('/account/setup/back', { step: 3 }, fresh)).body.data.user).toMatchObject({ accountSetupStep: 2, hasPassword: true })
    expect((await post('/account/setup/password', { password: 'new-password' }, fresh)).body.error.code).toBe('AUTH_SETUP_PASSWORD_UNAVAILABLE')
    expect((await post('/account/setup', { step: 2, skip: false }, fresh)).body.data.user.accountSetupStep).toBe(3)
    expect((await post('/account/setup', { step: 3, skip: true }, fresh)).body.data.user.accountSetupStep).toBeNull()
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({
      accountSetupSkippedSteps: [1, 3], accountSetupFinishedAt: expect.any(Date),
    })
    for (const url of ['/api/agent/sessions', '/api/novels/example/studio', '/api/uploads/agent-attachments/sample.txt']) {
      expect((await api().get(url).set('Cookie', cookie(fresh))).body.error.code).toBe('AUTH_PHONE_VERIFICATION_REQUIRED')
    }
    expect((await api().get('/api/novels/example/reader/sample').set('Cookie', cookie(fresh))).status).toBe(404)
    const phoneCode = await smsCode('/account/phone/send-code', { phone }, phone, fresh)
    expect((await post('/account/phone', { phone, code: phoneCode }, fresh)).body.data.user.phoneVerified).toBe(true)
    expect((await api().get('/api/novels/example/studio').set('Cookie', cookie(fresh))).status).toBe(404)
    for (const identifier of [email, phone]) {
      const login = await api().post(auth + '/login').send({ identifier, password })
      expect(login.body.data.user.id).toBe(user.id)
    }
    const emailOtp = await emailCode('/email/send-code', { email, purpose: 'login' }, email)
    expect((await api().post(auth + '/email/login').send({ email, code: emailOtp })).body.data.user.id).toBe(user.id)
    const smsOtp = await smsCode('/sms/send-code', { phone, purpose: 'login' }, phone)
    expect((await api().post(auth + '/sms/login').send({ phone, code: smsOtp })).body.data.user.id).toBe(user.id)

    const changeCode = await emailCode('/account/password/send-code', { channel: 'email' }, email, fresh)
    const changedPassword = 'changed-password'
    const changed = await post('/account/password', { channel: 'email', code: changeCode, password: changedPassword }, fresh)
    expect(changed.status).toBe(200)
    expect((await api().post(auth + '/login').send({ identifier: email, password: changedPassword })).body.data.user.id).toBe(user.id)
    const resetCode = await smsCode('/reset/send-code', { identifier: phone }, phone)
    expect((await api().post(auth + '/sms/login').send({ phone, code: resetCode })).body.error.code).toBe('AUTH_CODE_INVALID')
    const reset = await api().post(auth + '/reset').send({ identifier: phone, code: resetCode, password: 'replacement-password' })
    expect(reset.body.data).toEqual({ ok: true })
    expect((await api().post(auth + '/reset').send({ identifier: phone, code: resetCode, password })).body.error.code).toBe('AUTH_CODE_INVALID')
    expect((await api().post(auth + '/login').send({ identifier: email, password: changedPassword })).status).toBe(401)
  })

  it.each([
    { scenario: 'without a saved email', hasSavedEmail: false },
    { scenario: 'with a saved but unverified email', hasSavedEmail: true },
  ])('allows legacy accounts to use the app and optionally verify an email $scenario', async ({ hasSavedEmail }) => {
    const email = recipient()
    const occupied = recipient()
    const phone = `+86138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const legacy = await prisma.user.create({ data: {
      ...(hasSavedEmail ? { email } : {}),
      phone, phoneVerifiedAt: new Date('2020-01-01'), nickname: 'Legacy fixture', passwordHash: hashPassword('legacy-fixture-password'),
    } })
    const existing = await prisma.user.create({ data: {
      email: occupied, emailVerifiedAt: new Date(), nickname: 'Other fixture', passwordHash: 'unset:fixture',
    } })
    const login = await api().post(auth + '/login').send({ phone, password: 'legacy-fixture-password' })
    expect(login.status).toBe(200)
    const access = login.body.data.tokens.accessToken as string
    for (const path of ['/api/home', '/api/conversations', '/api/users/me/favorite-novels']) {
      expect((await api().get(path).set('Cookie', cookie(access))).status).toBe(200)
    }
    const novel = await api().post('/api/novels').set('Cookie', cookie(access)).send({ title: '旧账户创作测试', summary: '验证旧账户作品访问' })
    expect(novel.status).toBe(201)
    const own = await api().get('/api/users/me').set('Cookie', cookie(access))
    expect(own.status).toBe(200)
    expect(own.body.data.user).toMatchObject({ email: hasSavedEmail ? email : null, phoneVerified: true, emailVerified: false })
    expect(own.body.data.user).not.toHaveProperty('requiresEmailBinding')
    expect(own.body.data.authoredNovels).toEqual(expect.arrayContaining([expect.objectContaining({ id: novel.body.data.novel.id })]))
    if (hasSavedEmail) {
      expect((await api().post(auth + '/login').send({ identifier: email, password: 'legacy-fixture-password' })).status).toBe(401)
    }

    const conflict = await api().post(auth + '/email/send-code').set('X-Forwarded-For', nextRequester()).set('Cookie', cookie(access)).send({
      email: occupied.toUpperCase(), purpose: 'bind', ...await captcha(),
    })
    expect(conflict.status).toBe(200)
    expect(mailCodes.has(occupied)).toBe(false)
    expect((await api().post(auth + '/account/email').set('Cookie', cookie(access)).send({ email: occupied, code: '123456' })).body.error.code)
      .toBe('AUTH_CODE_INVALID')
    const code = await emailCode('/email/send-code', { email, purpose: 'bind' }, email, access)
    const bound = await api().post(auth + '/account/email').set('Cookie', cookie(access)).send({ email, code })
    expect(bound.body.data.user).toMatchObject({ id: legacy.id, email, phone, emailVerified: true, phoneVerified: true })
    expect(await prisma.user.findUnique({ where: { id: legacy.id } })).toMatchObject({ passwordHash: legacy.passwordHash, phoneVerifiedAt: legacy.phoneVerifiedAt })
    expect(await prisma.user.findUnique({ where: { id: existing.id } })).toMatchObject({ email: occupied })
    const admin = await prisma.user.create({ data: { role: 'admin', nickname: 'Admin fixture', passwordHash: 'unset:fixture' } })
    const search = await api().get('/api/admin/users').query({ search: email.toUpperCase() })
      .set('Cookie', cookie(buildSessionTokens(admin.id, 0).accessToken))
    expect(search.body.data.items).toEqual([expect.objectContaining({ id: legacy.id, email })])
    expect((await api().get('/api/admin/users').query({ search: email }).set('Cookie', cookie(access))).status).toBe(403)
  })

  it('allows a legacy admin to use the main site and verify their phone independently of email', async () => {
    const email = recipient()
    const phone = `+86137${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const admin = await prisma.user.create({ data: {
      email, phone, role: 'admin', nickname: 'Legacy admin fixture',
      passwordHash: hashPassword('legacy-admin-fixture-password'),
    } })
    const login = await api().post(auth + '/login').send({ phone, password: 'legacy-admin-fixture-password' })
    expect(login.status).toBe(200)
    const access = login.body.data.tokens.accessToken as string
    for (const path of ['/api/home', '/api/conversations', '/api/users/me/favorite-novels', '/api/admin/users']) {
      expect((await api().get(path).set('Cookie', cookie(access))).status).toBe(200)
    }
    for (const path of ['/api/novels/fixture/studio', `/api/uploads/agent-attachments/${admin.id}/sample.txt`]) {
      const blocked = await api().get(path).set('Cookie', cookie(access))
      expect(blocked.status).toBe(403)
      expect(blocked.body.error.code).toBe('AUTH_PHONE_VERIFICATION_REQUIRED')
    }
    const code = await smsCode('/account/phone/send-code', { phone }, phone, access)
    const bound = await api().post(auth + '/account/phone').set('Cookie', cookie(access)).send({ phone, code })
    expect(bound.status).toBe(200)
    expect(bound.body.data.user).toMatchObject({ id: admin.id, email, phone, phoneVerified: true, emailVerified: false })
    await expect(assertStudioAccountAccess(admin.id)).resolves.toBeUndefined()
    const novel = await api().post('/api/novels').set('Cookie', cookie(access))
      .send({ title: '管理员创作测试', summary: '验证手机号通过后作品可访问' })
    expect(novel.status).toBe(201)
  })

  it('allows a superadmin without a verified phone to open their own studio', async () => {
    const superAdmin = await prisma.user.create({ data: {
      role: 'admin', isSuperAdmin: true, nickname: 'Superadmin studio fixture', passwordHash: 'unset:fixture',
    } })
    const otherOwner = await prisma.user.create({ data: {
      role: 'admin', isSuperAdmin: true, nickname: 'Other owner fixture', passwordHash: 'unset:fixture',
    } })
    const cookieFor = (user: typeof superAdmin) => cookie(buildSessionTokens(user.id, user.tokenVersion).accessToken)
    const session = cookieFor(superAdmin)
    const draft = await api().post('/api/novels').set('Cookie', session)
      .send({ title: '超级管理员草稿', summary: '创作区准入回归', visibility: 'private' })
    expect(draft.status).toBe(201)
    const id = draft.body.data.novel.id as string
    expect((await api().get(`/api/novels/${id}/studio`).set('Cookie', session)).status).toBe(200)
    expect((await api().get(`/api/novels/${id}/detail`).set('Cookie', session)).status).toBe(200)
    expect((await api().get(`/api/novels/${id}/detail`).set('Cookie', cookieFor(otherOwner))).status).toBe(404)
    await expect(assertStudioAccountAccess(superAdmin.id)).resolves.toBeUndefined()
    const me = await api().get('/api/users/me').set('Cookie', session)
    expect(me.body.data.user).toMatchObject({ phone: null, phoneVerified: false, studioPhoneVerificationRequired: false })
    expect(me.body.data.authoredNovels).toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
  })

  it('admits the reserved superadmin email only to password login and preserves contact verification', async ({ onTestFinished }) => {
    const isolated = await openReservedAdminFixture()
    fixture.reserved = isolated
    onTestFinished(async () => { fixture.reserved = undefined; await isolated.$disconnect() })
    const email = 'admin@chevoink.local'
    const password = ' Reserved-Superadmin-Fixture-1 '
    const admin = await prisma.user.create({ data: {
      email, role: 'admin', isSuperAdmin: true, nickname: 'Reserved superadmin fixture', passwordHash: hashPassword(password),
    } })
    const login = async (identifier: string, password: string) => api().post(auth + '/login')
      .set('X-Forwarded-For', nextRequester()).send({ identifier, password })

    const result = await login(email.toUpperCase(), password)
    expect(result.status).toBe(200)
    expect(result.body.data.user).toMatchObject({ id: admin.id, email, emailVerified: false, phoneVerified: false })
    const token = result.body.data.tokens.accessToken as string
    expect((await api().get('/api/users/me').set('Cookie', cookie(token))).body.data.user.id).toBe(admin.id)
    expect((await login(email, password.trim())).status).toBe(401)
    for (const [purpose, path, body] of [
      ['login', '/email/send-code', { email, purpose: 'login' }],
      ['reset_password', '/reset/send-code', { identifier: email }],
    ] as const) {
      await ageEmail(email)
      const sent = await api().post(auth + path).set('X-Forwarded-For', nextRequester())
        .send({ ...body, ...await captcha() })
      expect(sent.status).toBe(200)
      expect(await prisma.emailVerificationCode.findFirst({ where: { email, purpose } }))
        .toMatchObject({ sendState: 'suppressed', userId: null })
      expect(mailCodes.has(email)).toBe(false)
    }
    expect((await api().post(auth + '/email/login').send({ email, code: '123456' })).body.error.code).toBe('AUTH_CODE_INVALID')
    expect((await api().post(auth + '/reset').send({ identifier: email, code: '123456', password })).body.error.code)
      .toBe('AUTH_CODE_INVALID')
    expect(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({ emailVerifiedAt: null })

    await prisma.user.update({ where: { id: admin.id }, data: { bannedAt: new Date() } })
    expect((await login(email, password)).status).toBe(401)
    await prisma.user.update({ where: { id: admin.id }, data: { bannedAt: null, isSuperAdmin: false } })
    expect((await login(email, password)).status).toBe(401)
  })

  it('quarantines an uncertain SES send and still accepts the delivered proof if it arrives', async () => {
    const email = recipient()
    const { legalConsent } = await integrationLegalConsent()
    uncertainAddresses.add(email)
    const send = async () => api().post(auth + '/email/send-code').set('X-Forwarded-For', nextRequester())
      .send({ email, purpose: 'register', ...await captcha() })
    const first = await send()
    expect(first.status).toBe(200)
    await vi.waitFor(async () => {
      expect((await prisma.emailVerificationCode.findFirst({ where: { email } }))?.sendState).toBe('unknown')
    })
    const code = mailCodes.get(email)
    await ageEmail(email)
    const second = await send()
    expect(second.body.data).toEqual(first.body.data)
    expect(deliveryCalls.get(email)).toBe(1)
    expect(await prisma.emailVerificationCode.count({ where: { email, sendState: 'suppressed' } })).toBe(1)
    expect((await api().post(auth + '/email/register').send({ email, code, legalConsent })).status).toBe(201)
  })

  it('expires codes and closes the attempt window even with the correct code afterwards', async () => {
    const email = recipient()
    const { legalConsent } = await integrationLegalConsent()
    const code = await emailCode('/email/send-code', { email, purpose: 'register' }, email)
    const wrong = code === '000000' ? '999999' : '000000'
    const submit = (value: string) => api().post(auth + '/email/register').send({ email, code: value, legalConsent })
    for (let index = 0; index < 5; index += 1) expect((await submit(wrong)).body.error.code).toBe('AUTH_CODE_INVALID')
    expect((await submit(code)).body.error.code).toBe('AUTH_CODE_INVALID')
    const latest = await emailCode('/email/send-code', { email, purpose: 'register' }, email)
    await prisma.emailVerificationCode.updateMany({ where: { email }, data: { expiresAt: new Date(0) } })
    expect((await submit(latest)).body.error.code).toBe('AUTH_CODE_INVALID')
    expect(await prisma.user.count({ where: { email } })).toBe(0)
  })
})
