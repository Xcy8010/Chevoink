import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { env } from '../../api/config/env.js'
import { mockAdminEmailDelivery, mockAdminEmailProvider } from '../../api/lib/admin-email-provider.js'
import { processAdminEmailQueue } from '../../api/lib/admin-email-queue.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { ADMIN_RETURN_EMAIL_PURPOSE } from '../../shared/contracts/admin-email.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const day = 86_400_000
const claimRoute = '/api/credits/return-reward/claim'
const cookie = (id: string) => 'chevoink_session=' + buildSessionTokens(id, 0).accessToken
const claim = (id: string, token: string) => request(app).post(claimRoute).set('Cookie', cookie(id)).send({ token })
afterAll(() => prisma.$disconnect())

describe.skipIf(!available)('claiming a directed return offer in isolated PostgreSQL', () => {
  const adminId = randomUUID()
  const previousMock = env.adminEmailMockEnabled
  let userId: string
  let email: string

  beforeAll(async () => {
    await prisma.user.create({ data: { id: adminId, nickname: '本地活动管理员', role: 'admin', isSuperAdmin: true, passwordHash: 'fixture' } })
  })
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: adminId } }) })
  beforeEach(async () => {
    env.adminEmailMockEnabled = true
    userId = randomUUID()
    email = userId + '@example.test'
    const verifiedAt = new Date(Date.now() - 30 * day)
    await prisma.user.create({ data: { id: userId, email, nickname: '受邀作者', emailVerifiedAt: verifiedAt, passwordHash: 'fixture' } })
  })
  afterEach(async () => {
    vi.useRealTimers()
    env.adminEmailMockEnabled = previousMock
    await prisma.adminEmailBatch.deleteMany({ where: { adminId } })
    await prisma.adminAuditLog.deleteMany({ where: { adminId } })
    await prisma.adminEmailPermission.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  })

  async function invite(amount: number, options: { sentAt?: Date; deadline?: Date; deliver?: boolean; standalone?: boolean } = {}) {
    const sentAt = options.sentAt ?? new Date()
    const to = options.standalone ? randomUUID() + '@example.test' : email
    const selection = options.standalone ? { mode: 'emails', emails: [to] } : { mode: 'manual', userIds: [userId] }
    const preview = await request(app).post('/api/admin/email/previews').set('Cookie', cookie(adminId)).send({
      mode: 'mock', selection, campaign: { maxCredits: amount, workspacePath: 'studio',
        deadline: options.deadline ? { mode: 'fixed', at: options.deadline.toISOString() } : { mode: 'relative', days: 2 } },
    }).expect(200)
    const { id, previewHash, recipientCount } = preview.body.data
    expect(recipientCount).toBe(1)
    expect(JSON.stringify(preview.body.data)).not.toMatch(/return-reward#[A-Za-z0-9_-]{43}/)
    await request(app).post('/api/admin/email/batches/' + id + '/confirm').set('Cookie', cookie(adminId)).send({ mode: 'mock', previewHash }).expect(200)
    const provider = { ...mockAdminEmailProvider, send: vi.fn(mockAdminEmailProvider.send) }
    const delivery = { ...mockAdminEmailDelivery, provider }
    await processAdminEmailQueue(delivery, () => sentAt)
    const message = provider.send.mock.calls.find(([entry]) => entry.to === to)?.[0]
    expect(message).toMatchObject({ to, providerTemplateId: 237702, variables: { max_credits: String(amount) } })
    if (options.deliver !== false) await processAdminEmailQueue(delivery, () => new Date(sentAt.getTime() + 5000))
    const path = message!.variables.workspace_path
    if (!options.standalone) expect(path).toMatch(/^return-reward#[A-Za-z0-9_-]{43}$/)
    return { batchId: String(id), token: path.split('#')[1], path }
  }

  async function accounting() {
    return {
      wallet: await prisma.creditAccount.findUnique({ where: { userId } }),
      entries: await prisma.creditLedgerEntry.findMany({ where: { userId } }),
      notices: await prisma.userNotification.findMany({ where: { userId } }),
    }
  }

  it('defaults to receiving return mail and keeps an explicit opt-out and provider complaint', async () => {
    const preference = '/api/users/me/return-email'
    const key = { purpose_email: { purpose: ADMIN_RETURN_EMAIL_PURPOSE, email } }
    const userCookie = cookie(userId)
    await request(app).put(preference).send({ subscribed: true }).expect(401)
    const current = await request(app).get(preference).set('Cookie', userCookie).expect(200)
    expect(current.body.data).toEqual({ available: true, subscribed: true })
    expect(await prisma.adminEmailPermission.findUnique({ where: key })).toBeNull()
    for (const subscribed of [false, true]) {
      const result = await request(app).put(preference).set('Cookie', userCookie).send({ subscribed }).expect(200)
      expect(result.body.data).toEqual({ available: true, subscribed })
      expect((await request(app).get(preference).set('Cookie', userCookie).expect(200)).body.data)
        .toEqual({ available: true, subscribed })
    }
    await prisma.adminEmailPermission.update({ where: key, data: { suppression: 'complained' } })
    expect((await request(app).get(preference).set('Cookie', userCookie).expect(200)).body.data)
      .toEqual({ available: false, subscribed: false })
    await request(app).put(preference).set('Cookie', userCookie).send({ subscribed: true }).expect(409)
    expect(await prisma.adminEmailPermission.findUnique({ where: key })).toMatchObject({ suppression: 'complained', userId })
  })

  it('defaults to receiving at a newly verified address and preserves the original address opt-out', async () => {
    const preference = '/api/users/me/return-email'
    const userCookie = cookie(userId)
    await request(app).put(preference).set('Cookie', userCookie).send({ subscribed: false }).expect(200)
    await prisma.user.update({ where: { id: userId }, data: { email: 'new-' + email, emailVerifiedAt: null } })
    expect((await request(app).get(preference).set('Cookie', userCookie).expect(200)).body.data)
      .toEqual({ available: false, subscribed: false })
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } })
    expect((await request(app).get(preference).set('Cookie', userCookie).expect(200)).body.data)
      .toEqual({ available: true, subscribed: true })
    await prisma.user.update({ where: { id: userId }, data: { email, emailVerifiedAt: new Date() } })
    const preview = await request(app).post('/api/admin/email/previews').set('Cookie', cookie(adminId)).send({
      mode: 'mock', selection: { mode: 'manual', userIds: [userId] }, campaign: {
        maxCredits: 200, workspacePath: 'studio', deadline: { mode: 'relative', days: 2 },
      },
    }).expect(200)
    expect(preview.body.data).toMatchObject({ recipientCount: 0, exclusions: { unsubscribed: 1 } })
    expect((await request(app).get(preference).set('Cookie', userCookie).expect(200)).body.data)
      .toEqual({ available: true, subscribed: false })
  })

  it('opens a mail fragment via a same-origin script before the SPA launcher', async () => {
    const base = '/api/credits/return-reward'
    const page = await request(app).get(base + '/open').expect(200)
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.text).toContain('src="' + base + '/entry.js"')
    const reply = await request(app).get(base + '/entry.js').expect(200)
    const token = 'a'.repeat(43)
    const location = { hash: '#' + token, replace: vi.fn() }
    const sessionStorage = { setItem: vi.fn(), removeItem: vi.fn() }
    new Function('location', 'sessionStorage', reply.text)(location, sessionStorage)
    expect(sessionStorage.setItem).toHaveBeenCalledWith('chevoink:return-reward:pending', token)
    expect(location.replace).toHaveBeenCalledWith('/return-reward')
  })

  it('credits the full offer in the user wallet with an ordinary unread reward notice, even without a previous wallet, creation or charge', async () => {
    const { batchId, token } = await invite(125)
    const before = await accounting()
    expect(before).toMatchObject({ wallet: null, entries: [] })
    expect(before.notices).toMatchObject([{ title: '创作回归活动', body: expect.stringContaining('125 Credits'), readAt: null }])
    const response = await claim(userId, token).expect(200)
    expect(response.body.data).toMatchObject({ amountMilli: 125000, bonusBalanceMilli: 125000, alreadyClaimed: false, workspacePath: 'studio' })
    const { wallet, entries, notices } = await accounting()
    expect(wallet).toMatchObject({ dailyUsedMilli: 0, bonusBalanceMilli: 125000 })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sourceType: 'creator_return', kind: 'reward', idempotencyKey: `creator-return:${batchId}:${userId}`,
      dailyDeltaMilli: 0, bonusDeltaMilli: 125000, deltaMilli: 125000 })
    expect(notices).toHaveLength(2)
    const rewardNotice = notices.find(row => row.title === '你收到了奖励额度')
    expect(rewardNotice).toMatchObject({ body: expect.stringContaining('125'), readAt: null })
    const inbox = await request(app).get('/api/site-content/announcements').set('Cookie', cookie(userId)).expect(200)
    expect(inbox.body.data.personalItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: before.notices[0].id, unread: true }),
      expect.objectContaining({ id: rewardNotice?.id, unread: true }),
    ]))
    expect(await prisma.agentRun.count({ where: { userId } })).toBe(0)
  })

  it('accepts one claim per email across concurrent requests for multiple offers to the same user', async () => {
    const first = await invite(80)
    const second = await invite(125)
    expect(first.token).not.toBe(second.token)
    const attempts = await Promise.all([first.token, second.token, first.token, second.token].map(token => claim(userId, token)))
    expect(attempts.map(result => result.status)).toEqual([200, 200, 200, 200])
    expect(attempts.map(result => result.body.data.alreadyClaimed).sort()).toEqual([false, false, true, true])
    expect(attempts.map(result => result.body.data.amountMilli)).toEqual([80000, 125000, 80000, 125000])
    expect((await claim(userId, first.token).expect(200)).body.data).toMatchObject({ alreadyClaimed: true, amountMilli: 80000 })
    expect((await claim(userId, second.token).expect(200)).body.data).toMatchObject({ alreadyClaimed: true, amountMilli: 125000 })
    const { wallet, entries, notices } = await accounting()
    expect(wallet?.bonusBalanceMilli).toBe(205000)
    expect(entries.map(row => row.referenceId).sort()).toEqual([first.batchId, second.batchId].sort())
    expect(notices.map(row => row.title).sort()).toEqual(['你收到了奖励额度', '你收到了奖励额度', '创作回归活动', '创作回归活动'])
  })

  it('requires the addressed session and the actual delivered receipt, and rejects an unrelated token', async () => {
    const { token } = await invite(45, { deliver: false })
    await request(app).post(claimRoute).send({ token }).expect(401)
    expect((await claim(userId, token).expect(409)).body.error.code).toBe('RETURN_REWARD_RECEIPT_PENDING')
    expect(await accounting()).toMatchObject({ entries: [], notices: [] })
    const receiptAt = new Date(Date.now() + 10_000)
    await Promise.all([1, 2].map(() => processAdminEmailQueue(mockAdminEmailDelivery, () => receiptAt)))
    await processAdminEmailQueue(mockAdminEmailDelivery, () => new Date(receiptAt.getTime() + 30_000))
    expect((await claim(adminId, token).expect(404)).body.error.code).toBe('RETURN_REWARD_UNAVAILABLE')
    expect((await claim(userId, 'a'.repeat(43)).expect(404)).body.error.code).toBe('RETURN_REWARD_UNAVAILABLE')
    env.adminEmailMockEnabled = false
    expect((await claim(userId, token).expect(404)).body.error.code).toBe('RETURN_REWARD_UNAVAILABLE')
    env.adminEmailMockEnabled = true
    expect(await accounting()).toMatchObject({ entries: [], notices: [{ title: '创作回归活动' }] })
    await claim(userId, token).expect(200)
  })

  it('does not issue an invitation when the offer expires while its first delivery receipt is being checked', async () => {
    const sentAt = new Date(Date.now() - 4 * day)
    const expiresAt = sentAt.getTime() + 2 * day
    const { token } = await invite(30, { sentAt, deliver: false })
    let clock = new Date(expiresAt - 1)
    const delivery = {
      ...mockAdminEmailDelivery,
      provider: {
        ...mockAdminEmailProvider,
        status: async () => {
          clock = new Date(expiresAt)
          return { state: 'delivered' as const }
        },
      },
    }
    await processAdminEmailQueue(delivery, () => clock)
    expect((await claim(userId, token).expect(410)).body.error.code).toBe('RETURN_REWARD_EXPIRED')
    expect(await accounting()).toMatchObject({ entries: [], notices: [] })
  })

  it('records an opt-out reported with first delivery without posting an invitation', async () => {
    await invite(30, { deliver: false })
    const delivery = {
      ...mockAdminEmailDelivery,
      provider: { ...mockAdminEmailProvider, status: async () => ({ state: 'delivered' as const, suppression: 'unsubscribed' as const }) },
    }
    await processAdminEmailQueue(delivery, () => new Date(Date.now() + 5_000))
    expect(await prisma.adminEmailPermission.findUnique({ where: { purpose_email: { purpose: ADMIN_RETURN_EMAIL_PURPOSE, email } } }))
      .toMatchObject({ suppression: 'unsubscribed' })
    expect(await accounting()).toMatchObject({ entries: [], notices: [] })
  })

  it('rejects at the calendar deadline but still shows the amount previously collected', async () => {
    const deadline = new Date(Date.now() + 10 * 60000)
    const { token } = await invite(55, { deadline })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(deadline)
    expect((await claim(userId, token).expect(410)).body.error.code).toBe('RETURN_REWARD_EXPIRED')
    expect(await accounting()).toMatchObject({ entries: [], notices: [{ title: '创作回归活动' }] })
    vi.setSystemTime(new Date(deadline.getTime() - 5000))
    expect((await claim(userId, token).expect(200)).body.data.alreadyClaimed).toBe(false)
    vi.setSystemTime(new Date(deadline.getTime() + 5000))
    expect((await claim(userId, token).expect(200)).body.data).toMatchObject({ alreadyClaimed: true, amountMilli: 55000 })
    const { entries, notices } = await accounting()
    expect(entries).toHaveLength(1)
    expect(notices.map(row => row.title).sort()).toEqual(['你收到了奖励额度', '创作回归活动'])
  })

  it('honors a legacy grant for its original email and allows a new email to grant its own reward', async () => {
    const original = await invite(70)
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId, dailyAllowanceMilli: 450000, dailyUsedMilli: 1200, bonusBalanceMilli: 1200,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    await prisma.creditLedgerEntry.create({ data: { userId, kind: 'reward', sourceType: 'creator_return', referenceId: original.batchId,
      deltaMilli: 1200, bonusDeltaMilli: 1200, dailyDeltaMilli: 0, idempotencyKey: 'creator-return:' + userId } })
    expect((await claim(userId, original.token).expect(200)).body.data).toMatchObject({ alreadyClaimed: true, amountMilli: 1200, bonusBalanceMilli: 1200 })
    const next = await invite(90)
    expect((await claim(userId, next.token).expect(200)).body.data).toMatchObject({ alreadyClaimed: false, amountMilli: 90000, bonusBalanceMilli: 91200 })
    expect((await claim(userId, original.token).expect(200)).body.data).toMatchObject({ alreadyClaimed: true, amountMilli: 1200, bonusBalanceMilli: 91200 })
    const { entries, notices } = await accounting()
    expect(entries.map(row => row.deltaMilli).sort((a, b) => a - b)).toEqual([1200, 90000])
    expect(notices.map(row => row.title).sort()).toEqual(['你收到了奖励额度', '创作回归活动', '创作回归活动'])
  })

  it('never issues an account claim URL to a typed address without a bound recipient', async () => {
    const { path } = await invite(25, { standalone: true })
    expect(path).not.toMatch(/^return-reward#/)
    expect(await accounting()).toMatchObject({ entries: [], notices: [] })
  })
})
