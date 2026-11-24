import app from '../../api/app.js'
import request from 'supertest'
import { env } from '../../api/config/env.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { randomUUID, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, ADMIN_CUSTOM_EMAIL_PURPOSE } from '../../shared/contracts/admin-email.js'
import { cancelEmailBatch, confirmEmailBatch, createEmailPreview, getEmailBatch, listEmailCandidates, listEmailPreviewCandidates } from '../../api/lib/admin-email-batches.js'
import { mockAdminEmailDelivery, mockAdminEmailProvider, type AdminEmailDelivery } from '../../api/lib/admin-email-provider.js'
import { createTencentAdminEmailDelivery } from '../../api/lib/admin-email-tencent.js'
import { processAdminEmailQueue } from '../../api/lib/admin-email-queue.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(() => prisma.$disconnect())

describe.skipIf(!dbAvailable)('directed email persistence with mock SES (isolated PostgreSQL)', () => {
  const adminId = randomUUID()
  const fixtureIds: string[] = []
  const fixtureEmails: string[] = []
  beforeAll(() => prisma.user.create({
    data: { id: adminId, nickname: '模拟发信管理员', role: 'admin', isSuperAdmin: true, passwordHash: 'unused-fixture-password' },
  }))
  afterAll(() => prisma.user.deleteMany({ where: { id: adminId } }))

  async function createRecipient(nickname: string, at: Date) {
    const email = `${randomUUID()}@chevoink.invalid`
    const user = await prisma.user.create({
      data: { nickname, email, emailVerifiedAt: at, passwordHash: 'unused-fixture-password', lastActiveAt: at },
    })
    fixtureIds.push(user.id)
    fixtureEmails.push(email)
    await prisma.adminEmailPermission.create({
      data: { purpose: ADMIN_EMAIL_PURPOSE, email, userId: user.id, consentedAt: at, source: 'integration-fixture' },
    })
    return user
  }

  afterEach(async () => {
    await prisma.adminEmailBatch.deleteMany({ where: { adminId } })
    await prisma.adminAuditLog.deleteMany({ where: { adminId, targetType: 'email_batch' } })
    await prisma.adminEmailPermission.deleteMany({ where: { email: { in: fixtureEmails.splice(0) } } })
    await prisma.user.deleteMany({ where: { id: { in: fixtureIds.splice(0) } } })
  })

  it('freezes the return offer in JSONB and computes its deadline from the individual dispatch', async () => {
    const at = new Date('2026-11-25T15:30:00Z')
    const account = await createRecipient('回归活动账号', at)
    const campaign = { maxCredits: 350, deadline: { mode: 'relative' as const, days: 5 }, workspacePath: 'studio' }
    const selection = { mode: 'manual' as const, userIds: [account.id] }
    const preview = await createEmailPreview(adminId, selection, { now: at, campaign })
    expect(preview.recipientCount).toBe(1)
    expect((await getEmailBatch(adminId, preview.id)).campaign).toEqual(campaign)
    expect(preview.template.sampleBody).toContain('2026-11-30 23:30')
    await confirmEmailBatch(adminId, preview.id, preview.previewHash, null, at)
    const confirmedBatch = await prisma.adminEmailBatch.findUniqueOrThrow({ where: { id: preview.id }, select: { sampling: true } })
    expect(confirmedBatch.sampling).not.toHaveProperty('candidates')
    const provider = { ...mockAdminEmailProvider, send: vi.fn(mockAdminEmailProvider.send) }
    const delivery = { ...mockAdminEmailDelivery, provider }
    const sentAt = new Date('2026-11-25T16:15:00Z')
    await processAdminEmailQueue(delivery, () => sentAt)
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      to: account.email, providerTemplateId: 237702,
      variables: { max_credits: '350', expires_at: '2026-12-01 00:15（北京时间）', workspace_path: expect.stringMatching(/^return-reward#[A-Za-z0-9_-]{43}$/) },
    }))
    await processAdminEmailQueue(delivery, () => new Date(sentAt.getTime() + 5000))
    expect((await getEmailBatch(adminId, preview.id)).progress).toEqual({ delivered: 1 })
  })

  it('pages the frozen preview audience with masked addresses and reconstructs legacy previews', async () => {
    const at = new Date()
    const selected = await createRecipient('发送候选', at)
    const excluded = await createRecipient('待验证候选', at)
    await prisma.user.update({ where: { id: excluded.id }, data: { emailVerifiedAt: null } })
    const missing = Array.from({ length: 24 }, () => randomUUID())
    const preview = await createEmailPreview(adminId, { mode: 'manual', userIds: [selected.id, excluded.id, ...missing] }, {
      campaign: { maxCredits: 200, deadline: { mode: 'relative', days: 7 }, workspacePath: 'studio' },
    })
    expect(preview).toMatchObject({ candidateCount: 26, recipientCount: 1, exclusions: { unverified_email: 1, missing_user: 24 } })
    await expect(listEmailPreviewCandidates(randomUUID(), preview.id, 1, mockAdminEmailDelivery))
      .rejects.toMatchObject({ status: 404 })
    const previousMock = env.adminEmailMockEnabled
    env.adminEmailMockEnabled = true
    try {
      const cookie = 'chevoink_session=' + buildSessionTokens(adminId, 0).accessToken
      const url = '/api/admin/email/batches/' + preview.id + '/candidates'
      await request(app).get(url + '?page=0').set('Cookie', cookie).expect(400)
      await prisma.user.update({ where: { id: excluded.id }, data: { nickname: '修改后的昵称', emailVerifiedAt: at } })
      const first = (await request(app).get(url).set('Cookie', cookie).expect(200)).body.data
      expect(first).toMatchObject({ page: 1, hasNextPage: true, reconstructed: false })
      expect(first.items).toHaveLength(25)
      expect(first.items.slice(0, 2)).toMatchObject([
        { id: selected.id, nickname: '发送候选', maskedEmail: expect.stringMatching(/•••@chevoink\.invalid$/), exclusion: null, selected: true },
        { id: excluded.id, nickname: '待验证候选', exclusion: 'unverified_email', selected: false },
      ])
      const second = (await request(app).get(url + '?page=2').set('Cookie', cookie).expect(200)).body.data
      expect(second).toMatchObject({ page: 2, hasNextPage: false, items: [{ id: missing.at(-1), exclusion: 'missing_user', selected: false }] })
      await prisma.adminEmailBatch.update({ where: { id: preview.id }, data: { sampling: { version: 'exponential-race-v1' } } })
      await prisma.user.update({ where: { id: selected.id }, data: { emailVerifiedAt: null } })
      const legacy = (await request(app).get(url).set('Cookie', cookie).expect(200)).body.data
      expect(legacy).toMatchObject({ reconstructed: true })
      expect(legacy.items[0]).toMatchObject({ exclusion: 'unverified_email', selected: true })
      expect(legacy.items[1]).toMatchObject({ nickname: '修改后的昵称', exclusion: null, selected: false })
      expect(await prisma.adminEmailBatch.count({ where: { id: preview.id, confirmedAt: null } })).toBe(1)
    } finally {
      env.adminEmailMockEnabled = previousMock
    }
  })

  it('adds a template to the shared library, reads it back and rejects a duplicate ID', async () => {
    const cookie = 'chevoink_session=' + buildSessionTokens(adminId, 0).accessToken
    const entry = { id: randomInt(10000000, 2147483647), name: '事务验收', subject: '{{ topic }}', body: '记录 {{ title }}' }
    const previousMock = env.adminEmailMockEnabled
    env.adminEmailMockEnabled = true
    let inserted = false
    try {
      const created = await request(app).post('/api/admin/email/templates').set('Cookie', cookie).send(entry)
      expect(created.status, created.body.error?.code).toBe(200)
      inserted = true
      expect(created.body.data).toEqual(entry)
      const templates = await request(app).get('/api/admin/email/templates').set('Cookie', cookie).expect(200)
      expect(templates.body.data.items).toContainEqual(entry)
      await request(app).post('/api/admin/email/templates').set('Cookie', cookie).send(entry).expect(409)
    } finally {
      env.adminEmailMockEnabled = previousMock
      if (inserted) await prisma.$executeRaw`DELETE FROM admin_email_templates WHERE id = ${entry.id}`
    }
  })

  it('keeps custom template variables through JSONB and requires the matching consent at confirmation', async () => {
    const at = new Date()
    const account = await createRecipient('自定义模板账号', at)
    const selection = { mode: 'manual' as const, userIds: [account.id] }
    const customTemplate = {
      name: '创作通知', id: 990021, subject: '活动 {{topic}}', body: '{{line}}，{{topic}}！',
      values: { topic: '创作日', line: '周五见' },
    }
    const excluded = await createEmailPreview(adminId, selection, { now: at, customTemplate })
    expect(excluded.blocker).toBe('empty')
    const permission = { purpose: ADMIN_CUSTOM_EMAIL_PURPOSE, email: account.email! }
    await prisma.adminEmailPermission.create({ data: { ...permission, userId: account.id, consentedAt: at, source: 'custom-opt-in' } })
    const snapshot = await createEmailPreview(adminId, selection, { now: at, customTemplate })
    expect(snapshot.template).toMatchObject({ subject: '活动 创作日', sampleBody: '周五见，创作日！' })
    await prisma.adminEmailPermission.update({ where: { purpose_email: permission }, data: { suppression: 'unsubscribed' } })
    await expect(confirmEmailBatch(adminId, snapshot.id, snapshot.previewHash, null, at)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    expect((await getEmailBatch(adminId, snapshot.id)).state).toBe('preview')
    await prisma.adminEmailPermission.update({ where: { purpose_email: permission }, data: { suppression: null } })
    await confirmEmailBatch(adminId, snapshot.id, snapshot.previewHash, null, at)
    const provider = { ...mockAdminEmailProvider, send: vi.fn(mockAdminEmailProvider.send) }
    await processAdminEmailQueue({ ...mockAdminEmailDelivery, provider }, () => at)
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      providerTemplateId: customTemplate.id, subject: '活动 创作日', variables: customTemplate.values,
    }))
  })

  it('deduplicates a typed address and skips a queued standalone simulation if it binds to an account', async () => {
    const at = new Date()
    const account = await createRecipient('已绑定邮箱', at)
    const standalone = randomUUID() + '@example.test'
    const preview = await createEmailPreview(adminId, {
      mode: 'emails', emails: [account.email!, standalone, standalone.toUpperCase()],
    }, { now: at })
    expect(preview).toMatchObject({ recipientCount: 2, exclusions: { duplicate_email: 1 } })
    expect(preview.recipients.map(row => row.userId)).toContain(account.id)
    await confirmEmailBatch(adminId, preview.id, preview.previewHash, null, at)
    const newlyBound = await prisma.user.create({ data: {
      nickname: '已绑定独立地址', email: standalone, emailVerifiedAt: at, passwordHash: 'unused-fixture-password',
    } })
    fixtureIds.push(newlyBound.id)
    const provider = { ...mockAdminEmailProvider, send: vi.fn(mockAdminEmailProvider.send) }
    await processAdminEmailQueue({ ...mockAdminEmailDelivery, provider }, () => at)
    expect(provider.send.mock.calls.map(([message]) => message.to)).toEqual([account.email])
    const final = await getEmailBatch(adminId, preview.id)
    expect(final.progress).toEqual({ accepted: 1, skipped: 1 })
    expect(final.recipients.find(row => row.state === 'skipped')?.reason).toBe('email_changed')
  })

  it('preserves the drawn recipient set and creates exactly one confirm audit and one provider attempt per eligible recipient', async () => {
    const at = new Date()
    const targets = await Promise.all(['新用户', '回访用户', '第三个用户'].map(nickname => createRecipient(nickname, at)))
    const selection = { mode: 'sample' as const, filters: { role: 'user' as const }, size: 2, weighting: 'recent_activity' as const }
    const replaced = await createEmailPreview(adminId, selection, { now: at })
    const first = await createEmailPreview(adminId, selection, { now: at, replaces: replaced.id })
    expect((await getEmailBatch(adminId, replaced.id)).replacedById).toBe(first.id)
    await expect(confirmEmailBatch(adminId, replaced.id, replaced.previewHash, null, at)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    const ids = first.recipients.map(row => row.userId)
    expect(ids).toHaveLength(2)
    expect(ids.every(id => targets.some(user => user.id === id))).toBe(true)
    await expect(getEmailBatch(randomUUID(), first.id)).rejects.toMatchObject({ code: 'EMAIL_BATCH_NOT_FOUND' })
    expect((await getEmailBatch(adminId, first.id)).recipients.map(row => row.userId)).toEqual(ids)

    const confirmations = await Promise.all([
      confirmEmailBatch(adminId, first.id, first.previewHash, null, at),
      confirmEmailBatch(adminId, first.id, first.previewHash, null, at),
    ])
    expect(confirmations.map(row => [row.state, row.progress.queued])).toEqual([['confirmed', 2], ['confirmed', 2]])
    expect(await prisma.adminAuditLog.count({ where: { targetId: first.id, action: 'email_batch.confirm' } })).toBe(1)

    const withdrawn = targets.find(user => user.id === ids[0])!
    await prisma.adminEmailPermission.update({
      where: { purpose_email: { purpose: ADMIN_EMAIL_PURPOSE, email: withdrawn.email! } },
      data: { suppression: 'unsubscribed' },
    })
    const provider = { send: vi.fn(mockAdminEmailProvider.send), status: vi.fn(mockAdminEmailProvider.status) }
    const delivery = { ...mockAdminEmailDelivery, provider }
    await Promise.all([processAdminEmailQueue(delivery, () => at), processAdminEmailQueue(delivery, () => at)])
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(provider.send.mock.calls[0][0].to).not.toBe(withdrawn.email)
    const waiting = await getEmailBatch(adminId, first.id)
    expect(waiting.progress).toEqual({ accepted: 1, skipped: 1 })
    expect(waiting.recipients[0]).toMatchObject({ userId: withdrawn.id, reason: 'unsubscribed' })

    await processAdminEmailQueue(delivery, () => new Date(at.getTime() + 5_000))
    expect((await getEmailBatch(adminId, first.id)).progress).toEqual({ delivered: 1, skipped: 1 })
    expect(provider.send).toHaveBeenCalledTimes(1)
  })

  it('rolls back an attempt to confirm a stale address and can stop queued work before dispatch', async () => {
    const at = new Date()
    const account = await createRecipient('更换邮箱', at)
    const input = { mode: 'manual' as const, userIds: [account.id] }
    const stale = await createEmailPreview(adminId, input, { now: at })
    await prisma.user.update({ where: { id: account.id }, data: { email: `${randomUUID()}@chevoink.invalid` } })
    await expect(confirmEmailBatch(adminId, stale.id, stale.previewHash, null, at)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    expect((await getEmailBatch(adminId, stale.id)).state).toBe('preview')
    expect(await prisma.adminAuditLog.count({ where: { targetId: stale.id } })).toBe(0)

    await prisma.user.update({ where: { id: account.id }, data: { email: account.email } })
    const current = await createEmailPreview(adminId, input, { now: at })
    await confirmEmailBatch(adminId, current.id, current.previewHash, null, at)
    const cancelled = await cancelEmailBatch(adminId, current.id, null)
    expect(cancelled.progress).toEqual({ cancelled: 1 })
    const provider = { send: vi.fn(mockAdminEmailProvider.send), status: vi.fn(mockAdminEmailProvider.status) }
    await processAdminEmailQueue({ ...mockAdminEmailDelivery, provider }, () => at)
    expect(provider.send).not.toHaveBeenCalled()
  })

  it('isolates mock batches from signed SES work, deduplicates attempts, and persists unknown and late unsubscribe receipts', async () => {
    const at = new Date('2026-11-24T15:59:58Z')
    const claimedAt = new Date('2026-11-24T16:00:05Z')
    const crossingClock = () => {
      let tick = true
      return () => {
        if (!tick) return claimedAt
        tick = false
        return at
      }
    }
    const known = await createRecipient('合成送达账号', at)
    const uncertain = await createRecipient('合成未知账号', at)
    const excluded = await createRecipient('合成名单外账号', at)
    const sender = 'notify@chevoink.invalid'
    const messageId = 'fixture-ses-message'
    let userUnsubscribed = false
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const action = new Headers(init?.headers).get('X-TC-Action')
      const body = JSON.parse(String(init?.body))
      const RequestId = 'fixture-request'
      if (action === 'GetEmailTemplate') return Response.json({
        Response: { RequestId, TemplateStatus: 0, TemplateContent: { Text: Buffer.from('您好，{{nickname}}！合成测试。').toString('base64') } },
      })
      if (action === 'SendEmail') {
        expect(body.Destination).toHaveLength(1)
        if (body.Destination[0] === uncertain.email) throw new Error('synthetic timeout')
        expect(body.Destination).toEqual([known.email])
        return Response.json({ Response: { RequestId, MessageId: messageId } })
      }
      if (action === 'GetSendEmailStatus') {
        expect(body.RequestDate).toBe('2026-11-25')
        return Response.json({ Response: { RequestId, EmailStatusList: [{
          MessageId: messageId, FromEmailAddress: sender, ToEmailAddress: known.email, SendStatus: 0, DeliverStatus: 1,
          UserUnsubscribed: userUnsubscribed,
        }] } })
      }
      throw new Error('Unexpected mock transport action')
    })
    const delivery = createTencentAdminEmailDelivery({
      secretId: 'fixture-key', secretKey: 'fixture-secret', region: 'ap-hongkong', templateId: 9001,
      from: sender, replyTo: 'reply@chevoink.invalid', allowedRecipients: new Set([known.email!, uncertain.email!]),
    }, transport)
    const input = { mode: 'manual' as const, userIds: [known.id, uncertain.id, excluded.id] }
    const mock = await createEmailPreview(adminId, input, { now: at })
    await confirmEmailBatch(adminId, mock.id, mock.previewHash, null, at)
    const live = await createEmailPreview(adminId, input, { now: at, delivery })
    expect(live.exclusions).toEqual({ outside_send_scope: 1 })
    await expect(getEmailBatch(adminId, live.id)).rejects.toMatchObject({ code: 'EMAIL_BATCH_NOT_FOUND' })
    await confirmEmailBatch(adminId, live.id, live.previewHash, null, at, delivery)
    await Promise.all([processAdminEmailQueue(delivery, crossingClock()), processAdminEmailQueue(delivery, crossingClock())])
    expect((await getEmailBatch(adminId, mock.id)).progress).toEqual({ queued: 3 })
    expect((await getEmailBatch(adminId, live.id, 'tencent')).progress).toEqual({ accepted: 1, unknown: 1 })

    await processAdminEmailQueue(delivery, () => new Date(claimedAt.getTime() + 5_000))
    expect((await getEmailBatch(adminId, live.id, 'tencent')).progress).toEqual({ delivered: 1, unknown: 1 })
    userUnsubscribed = true
    await processAdminEmailQueue(delivery, () => new Date(claimedAt.getTime() + 21_000))
    expect(transport.mock.calls.filter(([, init]) => new Headers(init?.headers).get('X-TC-Action') === 'SendEmail')).toHaveLength(2)
    expect(await prisma.adminEmailPermission.findUnique({
      where: { purpose_email: { purpose: ADMIN_EMAIL_PURPOSE, email: known.email! } },
    })).toMatchObject({ suppression: 'unsubscribed' })
    for (const suppression of ['hard_bounce', 'complained'] as const) {
      await prisma.adminEmailPermission.update({ where: { purpose_email: { purpose: ADMIN_EMAIL_PURPOSE, email: known.email! } }, data: { suppression } })
      await prisma.adminEmailRecipient.update({ where: { batchId_userId: { batchId: live.id, userId: known.id } }, data: { nextCheckAt: claimedAt } })
      await processAdminEmailQueue(delivery, () => new Date(claimedAt.getTime() + 25_000))
      expect(await prisma.adminEmailPermission.findUniqueOrThrow({
        where: { purpose_email: { purpose: ADMIN_EMAIL_PURPOSE, email: known.email! } },
      })).toMatchObject({ suppression })
    }
    const originalAttempt = await prisma.adminEmailRecipient.findUniqueOrThrow({
      where: { batchId_userId: { batchId: live.id, userId: uncertain.id } },
    })
    expect(originalAttempt).toMatchObject({ state: 'unknown', reason: 'provider_unknown', providerMessageId: null, attemptedAt: claimedAt })
    expect(originalAttempt.attemptId).toBeTruthy()
  })

  it('includes verified return recipients by default within the real sending scope and honors a later opt-out', async () => {
    const now = new Date()
    const account = await createRecipient('回归活动账号', now)
    const other = await createRecipient('非指定账号', now)
    const provider = { ...mockAdminEmailProvider, send: vi.fn(mockAdminEmailProvider.send) }
    const delivery: AdminEmailDelivery = { ...mockAdminEmailDelivery, provider, mode: 'tencent',
      allowedRecipients: new Set([account.email!]), tencentPurposes: [ADMIN_RETURN_EMAIL_PURPOSE] }
    const campaign = { maxCredits: 200, deadline: { mode: 'relative' as const, days: 7 }, workspacePath: 'studio' }
    const selection = { mode: 'emails' as const, emails: [account.email!, other.email!] }
    const candidates = await listEmailCandidates(account.id, 1, delivery, ADMIN_RETURN_EMAIL_PURPOSE)
    expect(candidates.items).toMatchObject([{ id: account.id, exclusion: null }])
    const bothAllowed = await createEmailPreview(adminId, selection, {
      now, campaign, delivery: { ...delivery, allowedRecipients: new Set(selection.emails) },
    })
    expect(bothAllowed.recipientCount).toBe(2)

    await prisma.user.update({ where: { id: account.id }, data: { emailVerifiedAt: null } })
    expect((await createEmailPreview(adminId, selection, { now, campaign, delivery })).exclusions)
      .toEqual({ unverified_email: 1, outside_send_scope: 1 })
    await prisma.user.update({ where: { id: account.id }, data: { emailVerifiedAt: now } })
    const preview = await createEmailPreview(adminId, selection, { now, campaign, delivery })
    expect(preview).toMatchObject({ recipientCount: 1, exclusions: { outside_send_scope: 1 } })
    const key = { purpose: ADMIN_RETURN_EMAIL_PURPOSE, email: account.email! }
    await prisma.adminEmailPermission.create({ data: { ...key, suppression: 'unsubscribed' } })
    await expect(confirmEmailBatch(adminId, preview.id, preview.previewHash, null, now, delivery)).rejects.toMatchObject({ status: 409 })
    await prisma.adminEmailPermission.delete({ where: { purpose_email: key } })
    await confirmEmailBatch(adminId, preview.id, preview.previewHash, null, now, delivery)
    await prisma.adminEmailPermission.create({ data: { ...key, suppression: 'unsubscribed' } })
    await processAdminEmailQueue(delivery, () => now)
    expect(provider.send).not.toHaveBeenCalled()
    expect((await getEmailBatch(adminId, preview.id, 'tencent')).recipients[0]).toMatchObject({ state: 'skipped', reason: 'unsubscribed' })
    await prisma.adminEmailPermission.delete({ where: { purpose_email: key } })
    const permitted = await createEmailPreview(adminId, selection, { now, campaign, delivery })
    await confirmEmailBatch(adminId, permitted.id, permitted.previewHash, null, now, delivery)
    await processAdminEmailQueue(delivery, () => now)
    expect(provider.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: account.email, providerTemplateId: 237702 }))
    expect(await prisma.adminEmailPermission.findUnique({ where: { purpose_email: key } })).toBeNull()
  })

  it('waits for address suppression before claiming a default recipient with no permission row', async () => {
    const now = new Date()
    const account = await createRecipient('收到旧地址投诉的作者', now)
    const address = account.email!
    const provider = { ...mockAdminEmailProvider, send: vi.fn(mockAdminEmailProvider.send) }
    const delivery = { ...mockAdminEmailDelivery, provider }
    const campaign = { maxCredits: 200, deadline: { mode: 'relative' as const, days: 7 }, workspacePath: 'studio' }
    const preview = await createEmailPreview(adminId, { mode: 'manual', userIds: [account.id] }, { now, campaign, delivery })
    await confirmEmailBatch(adminId, preview.id, preview.previewHash, null, now, delivery)

    let pending: Promise<void> | undefined
    try {
      await prisma.$transaction(async tx => {
        const key = `admin-email-suppression:${ADMIN_RETURN_EMAIL_PURPOSE}:${address}`
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
        pending = processAdminEmailQueue(delivery, () => now)
        await vi.waitFor(async () => {
          const [result] = await tx.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks held JOIN pg_locks waiting
                ON held.locktype = waiting.locktype AND held.classid = waiting.classid
                AND held.objid = waiting.objid AND held.objsubid = waiting.objsubid
              WHERE held.pid = pg_backend_pid() AND held.locktype = 'advisory' AND NOT waiting.granted
            ) AS waiting
          `
          expect(result.waiting).toBe(true)
        })
        await tx.adminEmailPermission.create({ data: {
          purpose: ADMIN_RETURN_EMAIL_PURPOSE, email: address, suppression: 'complained',
        } })
      })
    } finally { await pending }
    expect(provider.send).not.toHaveBeenCalled()
    expect((await getEmailBatch(adminId, preview.id)).recipients[0]).toMatchObject({ state: 'skipped', reason: 'complained' })
  })

  it('continues healthy Tencent batches through a template outage and never sends changed return terms', async () => {
    const now = new Date()
    const author = await createRecipient('腾讯回归账户', now)
    const to = author.email!
    await prisma.adminEmailPermission.create({ data: { purpose: ADMIN_RETURN_EMAIL_PURPOSE, email: to, userId: author.id, consentedAt: now, source: 'return-opt-in' } })
    const html = readFileSync(new URL('../../src/features/admin/pages/creator-return.html', import.meta.url), 'utf8')
    let returnState: 'approved' | 'offline' | 'pending' = 'approved'
    const sends: Array<{ TemplateID: number; TemplateData: string }> = []
    const transport: typeof fetch = async (_url, init) => {
      const action = new Headers(init?.headers).get('X-TC-Action')
      const body = JSON.parse(String(init?.body))
      let payload: object
      if (action === 'GetEmailTemplate') {
        if (body.TemplateID === 237702 && returnState === 'offline') throw Error('mock outage')
        payload = { TemplateStatus: body.TemplateID === 237702 && returnState === 'pending' ? 1 : 0,
          TemplateContent: body.TemplateID === 237702 ? { Html: Buffer.from(html).toString('base64') } : { Text: Buffer.from('您好，{{nickname}}！').toString('base64') } }
      } else if (action === 'SendEmail') {
        expect(body.Destination).toEqual([to])
        sends.push(body.Template)
        payload = { MessageId: 'local-' + sends.length }
      } else {
        expect(action).toBe('GetSendEmailStatus')
        payload = { EmailStatusList: [{ MessageId: body.MessageId, FromEmailAddress: 'local@example.test', ToEmailAddress: to, SendStatus: 0, DeliverStatus: 1 }] }
      }
      return Response.json({ Response: { RequestId: 'local-fixture', ...payload } })
    }
    const delivery = createTencentAdminEmailDelivery({ from: 'local@example.test', replyTo: 'reply@example.test', allowedRecipients: new Set([to]),
      templateId: 100, returnTemplateId: 237702, region: 'ap-hongkong', secretId: 'local', secretKey: 'local' }, transport)
    const selection = { mode: 'manual' as const, userIds: [author.id] }
    const campaign = { maxCredits: 200, deadline: { mode: 'relative' as const, days: 7 }, workspacePath: 'studio' }
    const prepare = async (isReturn: boolean) => {
      const preview = await createEmailPreview(adminId, selection, { now, delivery, ...(isReturn && { campaign }) })
      if (isReturn) expect(preview.template.sampleBody).toContain('使用收件账号登录并确认领取')
      await confirmEmailBatch(adminId, preview.id, preview.previewHash, null, now, delivery)
      return preview.id
    }
    const first = await prepare(true)
    await prepare(false)
    returnState = 'offline'
    await processAdminEmailQueue(delivery, () => now)
    expect((await getEmailBatch(adminId, first, 'tencent')).progress).toEqual({ queued: 1 })
    expect(sends.map(send => send.TemplateID)).toEqual([100])
    returnState = 'pending'
    await processAdminEmailQueue(delivery, () => new Date(+now + 16000))
    expect((await getEmailBatch(adminId, first, 'tencent')).recipients[0]).toMatchObject({ state: 'skipped', reason: 'template_changed', attemptedAt: null })
    returnState = 'approved'
    const fresh = await prepare(true)
    await processAdminEmailQueue(delivery, () => new Date(+now + 20000))
    expect(sends.map(send => send.TemplateID)).toEqual([100, 237702])
    expect(JSON.parse(sends[1].TemplateData)).toMatchObject({ max_credits: '200', workspace_path: expect.stringMatching(/^api\/credits\/return-reward\/open#[A-Za-z0-9_-]{43}$/) })
    await processAdminEmailQueue(delivery, () => new Date(+now + 26000))
    expect((await getEmailBatch(adminId, fresh, 'tencent')).progress).toEqual({ delivered: 1 })
  })
})
