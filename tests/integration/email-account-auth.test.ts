import { randomUUID } from 'node:crypto'
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
let ip = 1

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
  const req = api().post(auth + path).set('X-Forwarded-For', `198.51.100.${ip++}`)
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
  const req = api().post(auth + path).set('X-Forwarded-For', `198.51.100.${ip++}`)
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
      const send = () => sendAccountEmailCode({ email, purpose: 'register', userId: null }, '198.51.100.200', true)
      await expect(sendAccountEmailCode({ email: recipient(), purpose: 'register', userId: null }, '198.51.100.200', true))
        .rejects.toMatchObject({ code: 'AUTH_PREVIEW_RECIPIENT_REQUIRED' })
      await expect(sendAccountEmailCode({ email, purpose: 'login', userId: null }, '198.51.100.200', true))
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
      phone: '+8613800000067', nickname: 'Ordinary stable fixture', passwordHash: 'unset:fixture',
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

    const conflict = await api().post(auth + '/email/send-code').set('Cookie', cookie(access)).send({
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

  it('quarantines an uncertain SES send and still accepts the delivered proof if it arrives', async () => {
    const email = recipient()
    const { legalConsent } = await integrationLegalConsent()
    uncertainAddresses.add(email)
    const send = async () => api().post(auth + '/email/send-code').set('X-Forwarded-For', `198.51.100.${ip++}`)
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
