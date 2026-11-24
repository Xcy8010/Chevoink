import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminEmailRecipientState } from '../../shared/contracts/admin-email.js'

const mocks = vi.hoisted(() => {
  const db = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    agentRun: { groupBy: vi.fn() },
    adminEmailPermission: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    adminEmailBatch: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    adminEmailRecipient: { findMany: vi.fn(), updateMany: vi.fn() },
    adminAuditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(async (run: (db: unknown) => unknown): Promise<unknown> => run(db)),
  }
  return { db, auth: vi.fn(), env: { adminEmailMockEnabled: true } }
})

vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: mocks.db }))
vi.mock('../../api/config/env.js', async original => {
  const module = await original<{ env: object }>()
  return { ...module, env: { ...module.env, ...mocks.env } }
})
vi.mock('../../api/lib/admin-auth.js', () => ({ requireAdmin: mocks.auth, getRequestIp: () => null }))
import { env } from '../../api/config/env.js'
import { customMockRecipientKey, emailCandidateWhere, sampleEmailCandidates } from '../../api/lib/admin-email-audience.js'
import { mockAdminEmailDelivery, mockAdminEmailProvider } from '../../api/lib/admin-email-provider.js'
import { adminEmailTemplateHash, mockEmailTemplate } from '../../api/lib/admin-email-template.js'
import { confirmEmailBatch, createEmailPreview } from '../../api/lib/admin-email-batches.js'
import { processAdminEmailQueue } from '../../api/lib/admin-email-queue.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import adminEmailRoutes from '../../api/routes/admin-email.js'

const now = new Date('2026-11-24T11:00:00Z')
const verifiedAt = new Date('2026-11-01T00:00:00Z')
const adminId = 'admin-fixture'
const mockEmailTemplateHash = adminEmailTemplateHash(mockEmailTemplate)
const app = express().use(express.json()).use('/api/admin/email', adminEmailRoutes)

function user(id: string, email = `${id}@chevoink.invalid`) {
  return { id, email, nickname: id, emailVerifiedAt: verifiedAt, bannedAt: null as Date | null, lastActiveAt: now }
}

function permission(account: ReturnType<typeof user>) {
  return { userId: account.id, email: account.email, consentedAt: now, source: 'fixture-opt-in', suppression: null }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.db.$transaction.mockImplementation(async run => run(mocks.db))
  mocks.db.$queryRaw.mockResolvedValue([{ id: adminId }])
  mocks.auth.mockResolvedValue({ id: adminId, isSuperAdmin: true })
  env.adminEmailMockEnabled = true
  env.adminEmailTencentEnabled = false
  mocks.db.adminEmailPermission.findMany.mockResolvedValue([])
})

describe('admin email audience and approval', () => {
  it('uses the existing tester rule and Beijing date, and draws deterministically without replacement', () => {
    const filters = { role: 'user' as const, registeredSince: '2026-11-24', activeWithinDays: 10, tester: 'effective' as const }
    expect(emailCandidateWhere({ mode: 'filter', filters }, now)).toMatchObject({
      role: 'user', createdAt: { gte: new Date('2026-11-23T16:00:00Z') },
      lastActiveAt: { gte: new Date('2026-11-14T11:00:00Z') },
      AND: [{ bannedAt: null, OR: [{ role: 'admin', isSuperAdmin: true }, { testerEntitlement: { is: { enabled: true } } }] }],
    })
    const candidates = [user('recent'), { ...user('older'), lastActiveAt: new Date('2026-11-03T00:00:00Z') },
      { ...user('unknown'), lastActiveAt: null }]
    const preview = sampleEmailCandidates(candidates, 2, 'recent_activity', 'frozen-seed', now)
    expect(preview.weightCounts).toEqual({ 1: 1, 2: 1, 3: 1 })
    expect(new Set(preview.picked.map(row => row.candidate.id)).size).toBe(2)
    expect(sampleEmailCandidates([...candidates].reverse(), 2, 'recent_activity', 'frozen-seed', now)).toEqual(preview)
  })

  it('freezes a masked preview and reports missing users, invalid proof and suppressed addresses', async () => {
    const allowed = user('allowed'), retired = user('retired'), rebound = user('rebound'), unverified = user('unverified')
    const banned = { ...user('banned'), bannedAt: now }
    mocks.db.user.findMany.mockResolvedValue([allowed, retired, rebound, { ...unverified, emailVerifiedAt: null }, banned])
    mocks.db.adminEmailPermission.findMany.mockResolvedValue([
      permission(allowed), { ...permission(retired), suppression: 'unsubscribed' },
      { ...permission(rebound), consentedAt: new Date('2026-10-01T00:00:00Z') },
    ])
    mocks.db.adminEmailBatch.create.mockImplementation(async ({ data }) => ({
      ...data, state: 'preview', recipients: data.recipients.create.map(recipient => ({
        ...recipient, state: 'preview', reason: null, providerMessageId: null, providerRequestId: null, updatedAt: now,
      })),
    }))
    const preview = await createEmailPreview(adminId, {
      mode: 'manual', userIds: [allowed.id, allowed.id, retired.id, rebound.id, unverified.id, banned.id, 'missing'],
    }, { now })
    expect(preview).toMatchObject({
      candidateCount: 6, eligibleCount: 1, recipientCount: 1,
      exclusions: { unsubscribed: 1, no_permission: 1, unverified_email: 1, missing_user: 1, banned: 1 },
      recipients: [{ userId: allowed.id, maskedEmail: 'a•••@chevoink.invalid', state: 'preview' }],
    })
    expect(preview.template.sampleBody).toContain('allowed')
    expect(JSON.stringify(preview)).not.toContain(allowed.email)
    expect(mocks.db.adminEmailRecipient.updateMany).not.toHaveBeenCalled()
  })

  it('accepts standalone addresses only in mock mode and retains suppression, verification and deduplication', async () => {
    const bound = user('bound')
    const unverified = { ...user('unverified'), emailVerifiedAt: null }
    const external = 'external@example.test'
    const suppressed = 'suppressed@example.test'
    const selection = { mode: 'emails' as const, emails: [bound.email, bound.email, unverified.email, external, suppressed] }
    mocks.db.user.findMany.mockResolvedValue([bound, unverified])
    mocks.db.adminEmailPermission.findMany.mockImplementation(async query =>
      query.where.suppression ? [{ email: suppressed, suppression: 'complained' }] : [permission(bound)])
    mocks.db.adminEmailBatch.create.mockImplementation(async ({ data }) => ({
      ...data, state: 'preview', recipients: data.recipients.create.map(recipient => ({ ...recipient, state: 'preview', updatedAt: now })),
    }))
    const local = await createEmailPreview(adminId, selection, { now })
    expect(local).toMatchObject({ candidateCount: 5, eligibleCount: 2, exclusions: { duplicate_email: 1, unverified_email: 1, complained: 1 } })
    expect(local.recipients.map(row => row.nickname)).toContain('自定义邮箱（模拟）')
    const real = await createEmailPreview(adminId, selection, { now, delivery: { ...mockAdminEmailDelivery, mode: 'tencent' } })
    expect(real).toMatchObject({ eligibleCount: 1, exclusions: { missing_user: 2, unverified_email: 1, duplicate_email: 1 } })
  })

  it('keeps users with zero successful creations when only an upper bound is requested', async () => {
    mocks.db.agentRun.groupBy.mockResolvedValue([{ userId: 'four-runs' }])
    mocks.db.user.findMany.mockResolvedValue([])
    mocks.db.adminEmailBatch.create.mockImplementation(async ({ data }) => ({ ...data, state: 'preview', recipients: [] }))
    await createEmailPreview(adminId, { mode: 'filter', filters: { maxCreations: 3 } }, { now })
    expect(mocks.db.agentRun.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'completed', incomingChildGrant: null }),
      having: { userId: { _count: { gt: 3 } } },
    }))
    expect(mocks.db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { notIn: ['four-runs'] } }),
    }))
  })

  it('rechecks an independent mock address for account binding and suppression before provider dispatch', async () => {
    const addresses = ['external@example.test', 'complaint@example.test', 'nowbound@example.test']
    const rows = addresses.map(email => ({
      batchId: randomUUID(), email, userId: customMockRecipientKey(email), nickname: '自定义邮箱（模拟）', state: 'queued',
      batch: { template: mockEmailTemplate, purpose: 'tester_invitation', templateHash: mockEmailTemplateHash },
    }))
    mocks.db.adminEmailRecipient.findMany.mockImplementation(async ({ where }) => where.state === 'queued' ? rows : [])
    mocks.db.user.findFirst.mockImplementation(async ({ where }) => where.email.equals === addresses[2] ? { id: 'nowbound' } : null)
    mocks.db.adminEmailPermission.findUnique.mockImplementation(async ({ where }) =>
      where.purpose_email.email === addresses[1] ? { suppression: 'complained' } : null)
    mocks.db.adminEmailRecipient.updateMany.mockResolvedValue({ count: 1 })
    const provider = { send: vi.fn(mockAdminEmailProvider.send), status: vi.fn(mockAdminEmailProvider.status) }
    await processAdminEmailQueue({ ...mockAdminEmailDelivery, provider }, () => now)
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(provider.send.mock.calls[0][0].to).toBe(addresses[0])
    const skipped = mocks.db.adminEmailRecipient.updateMany.mock.calls.flatMap(([input]) =>
      input.data.state === 'skipped' ? [input.data.reason] : [])
    expect(skipped).toEqual(['complained', 'email_changed'])
  })

  it('uses inclusive Beijing end dates and registration age when last activity is unknown', () => {
    const where = emailCandidateWhere({ mode: 'filter', filters: { registeredBefore: '2026-10-31', inactiveForDays: 14 } }, now)
    expect(where.createdAt).toMatchObject({ lt: new Date('2026-10-31T16:00:00Z') })
    const cutoff = new Date('2026-11-10T11:00:00Z')
    expect(where.OR).toEqual([{ lastActiveAt: { lte: cutoff } }, { lastActiveAt: null, createdAt: { lte: cutoff } }])
  })

  it('freezes return incentive parameters and consults only the return campaign consent', async () => {
    const account = user('approved')
    const campaign = { maxCredits: 50, deadline: { mode: 'relative' as const, days: 3 }, workspacePath: 'studio' }
    mocks.db.user.findMany.mockResolvedValue([account])
    mocks.db.adminEmailPermission.findMany.mockImplementation(async ({ where }) =>
      where.purpose === 'creator_return' ? [permission(account)] : [])
    mocks.db.adminEmailBatch.create.mockImplementation(async ({ data }) => ({
      ...data, state: 'preview', recipients: data.recipients.create.map(row => ({ ...row, updatedAt: now })),
    }))
    const preview = await createEmailPreview(adminId, { mode: 'manual', userIds: [account.id] }, { now, campaign })
    expect(preview).toMatchObject({ campaign, recipientCount: 1, template: { id: '237702' } })
    expect(preview.template.sampleBody).toContain('2026-11-27 19:00（北京时间）')
    expect(preview.template.sampleBody).toContain('50 Credits')
    expect(mocks.db.adminEmailBatch.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ purpose: 'creator_return', template: expect.objectContaining({ providerTemplateId: 237702, campaign }) }),
    }))
  })

  it('rejects stale approval and an address change without enqueuing the preview', async () => {
    const account = user('allowed')
    const batchId = randomUUID()
    const hash = 'a'.repeat(64)
    mocks.db.adminEmailBatch.findFirst.mockResolvedValue({
      id: batchId, adminId, previewHash: hash, templateHash: mockEmailTemplateHash,
      state: 'preview', confirmedAt: null, blocker: null, recipients: [{ userId: account.id, email: account.email }],
    })
    await expect(confirmEmailBatch(adminId, batchId, 'b'.repeat(64), null, now)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    expect(mocks.db.adminEmailBatch.updateMany).not.toHaveBeenCalled()
    mocks.db.adminEmailBatch.updateMany.mockResolvedValue({ count: 0 })
    await expect(confirmEmailBatch(adminId, batchId, hash, null, now)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    mocks.db.adminEmailBatch.updateMany.mockResolvedValue({ count: 1 })
    mocks.db.user.findMany.mockResolvedValue([{ ...account, email: 'new@chevoink.invalid' }])
    await expect(confirmEmailBatch(adminId, batchId, hash, null, now)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    expect(mocks.db.adminEmailRecipient.updateMany).not.toHaveBeenCalled()
    expect(mocks.db.adminAuditLog.create).not.toHaveBeenCalled()
  })

  it('rechecks the approving actor, and returns the same batch on a repeated confirmation', async () => {
    const batchId = randomUUID()
    const account = user('allowed')
    const hash = 'a'.repeat(64)
    const before = {
      id: batchId, previewHash: hash, templateHash: mockEmailTemplateHash, replacedById: null, state: 'preview', confirmedAt: null, blocker: null,
      selection: { mode: 'manual' }, template: mockEmailTemplate, createdAt: now, expiresAt: now,
      recipients: [{ userId: account.id, email: account.email, nickname: account.nickname, state: 'preview', updatedAt: now }],
    }
    const confirmed = {
      ...before, state: 'confirmed', confirmedAt: now, recipients: [{ ...before.recipients[0], state: 'queued' }],
    }
    mocks.db.adminEmailBatch.findFirst.mockResolvedValue(before)
    mocks.db.$queryRaw.mockResolvedValueOnce([])
    await expect(confirmEmailBatch(adminId, batchId, hash, null, now)).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    expect(mocks.db.adminEmailBatch.updateMany).not.toHaveBeenCalled()
    mocks.db.adminEmailBatch.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValue(confirmed)
    mocks.db.user.findMany.mockResolvedValue([account])
    mocks.db.adminEmailPermission.findMany.mockResolvedValue([permission(account)])
    mocks.db.adminEmailBatch.updateMany.mockResolvedValue({ count: 1 })
    const first = await confirmEmailBatch(adminId, batchId, hash, null, now)
    const retry = await confirmEmailBatch(adminId, batchId, hash, null, now)
    expect(retry).toEqual(first)
    expect(first).toMatchObject({ state: 'confirmed', progress: { queued: 1 } })
    expect(mocks.db.adminEmailRecipient.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.db.adminAuditLog.create).toHaveBeenCalledTimes(1)
    mocks.db.adminEmailBatch.findFirst.mockResolvedValueOnce({ ...before, replacedById: randomUUID() })
    await expect(confirmEmailBatch(adminId, batchId, hash, null, now)).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_CHANGED' })
    expect(mocks.db.adminEmailRecipient.updateMany).toHaveBeenCalledTimes(1)
  })

  it('checks super administrator and mock mode before querying account data', async () => {
    mocks.auth.mockResolvedValueOnce({ id: adminId, isSuperAdmin: false })
    expect((await request(app).post('/api/admin/email/previews').send({})).status).toBe(403)
    mocks.auth.mockRejectedValueOnce(new DataAccessError(401, 'AUTH_REQUIRED', '登录后操作'))
    expect((await request(app).get('/api/admin/email/candidates')).status).toBe(401)
    env.adminEmailMockEnabled = false
    expect((await request(app).get('/api/admin/email/candidates')).status).toBe(503)
    env.adminEmailMockEnabled = true
    expect((await request(app).post('/api/admin/email/previews').send({
      mode: 'mock', selection: { mode: 'sample', filters: {}, size: 101, weighting: 'equal' },
    })).status).toBe(400)
    expect(mocks.db.user.findMany).not.toHaveBeenCalled()
  })

  it('rejects stale mock-mode preview and confirmation requests if the server has switched to Tencent SES', async () => {
    env.adminEmailMockEnabled = false
    env.adminEmailTencentEnabled = true
    env.adminEmailTencentSecretId = 'fixture-business-id'
    env.adminEmailTencentSecretKey = 'fixture-business-key'
    env.adminEmailTencentFrom = 'business@chevoink.invalid'
    env.adminEmailTencentReplyTo = 'reply@chevoink.invalid'
    env.adminEmailTencentTemplateId = 9_876
    env.adminEmailTencentRecipients = ['reader@chevoink.invalid']
    const settings = await request(app).get('/api/admin/email/settings')
    expect(settings.body.data.mode).toBe('tencent')
    const preview = await request(app).post('/api/admin/email/previews').send({
      mode: 'mock', selection: { mode: 'manual', userIds: ['reader'] },
    })
    const confirm = await request(app).post(`/api/admin/email/batches/${randomUUID()}/confirm`).send({
      mode: 'mock', previewHash: 'a'.repeat(64),
    })
    expect([preview.status, confirm.status]).toEqual([409, 409])
    expect(mocks.db.adminEmailBatch.findFirst).not.toHaveBeenCalled()
    expect(mocks.db.adminEmailBatch.create).not.toHaveBeenCalled()
  })
})

type TestRecipient = {
  batchId: string
  userId: string
  email: string
  nickname: string
  state: AdminEmailRecipientState
  attemptId: string | null
  attemptedAt: Date | null
  providerMessageId: string | null
  providerRequestId: string | null
  nextCheckAt: Date | null
  reason: string | null
  batch: { purpose: string; templateHash: string; template: typeof mockEmailTemplate }
}

it('sends each claimed record at most once and reconciles mock receipts without replaying unknown outcomes', async () => {
  const accounts = ['mock-delivered', 'mock-deferred', 'mock-bounce', 'mock-unsubscribe', 'mock-complaint', 'mock-unknown',
    'mock-rejected', 'rebound', 'withdraw-before-claim', 'interrupted'].map(id => user(id))
  const batchId = randomUUID()
  const rows: TestRecipient[] = accounts.map(account => ({
    batchId, userId: account.id, email: account.email, nickname: account.nickname, state: 'queued',
    attemptId: null, attemptedAt: null, nextCheckAt: null, providerMessageId: null, providerRequestId: null,
    reason: null, batch: { purpose: 'tester_invitation', templateHash: mockEmailTemplateHash, template: mockEmailTemplate },
  }))
  const interrupted = rows.at(-1)!
  interrupted.state = 'sending'
  interrupted.attemptId = randomUUID()
  interrupted.attemptedAt = new Date(now.getTime() - 180_000)
  mocks.db.user.findUnique.mockImplementation(async ({ where }) => accounts.find(account => account.id === where.id))
  const allowed: Array<Omit<ReturnType<typeof permission>, 'suppression'> & { suppression: 'unsubscribed' | null }> = accounts.map(permission)
  mocks.db.$queryRaw.mockImplementation(async (_sql, _purpose, email) => {
    const record = allowed.find(item => item.email === email)
    if (record?.userId === 'withdraw-before-claim') record.suppression = 'unsubscribed'
    return []
  })
  mocks.db.adminEmailPermission.findMany.mockImplementation(async ({ where }) =>
    allowed.filter(item => where.email.in.includes(item.email)))
  mocks.db.adminEmailRecipient.findMany.mockImplementation(async ({ where }) => rows.filter(row =>
    (typeof where.state === 'string' ? row.state === where.state : where.state.in.includes(row.state))
    && (!where.nextCheckAt || (row.nextCheckAt && row.nextCheckAt <= where.nextCheckAt.lte)),
  ).map(row => ({ ...row })))
  mocks.db.adminEmailRecipient.updateMany.mockImplementation(async ({ where, data }) => {
    const found = rows.filter(row =>
      (!where.batchId || row.batchId === where.batchId)
      && (!where.userId || row.userId === where.userId)
      && (!where.attemptId || row.attemptId === where.attemptId)
      && (!where.attemptedAt || (row.attemptedAt && row.attemptedAt < where.attemptedAt.lt))
      && (!where.nextCheckAt || row.nextCheckAt?.getTime() === where.nextCheckAt.getTime())
      && (typeof where.state === 'string' ? row.state === where.state : where.state.in.includes(row.state)),
    )
    for (const row of found) Object.assign(row, data)
    return { count: found.length }
  })
  const rebound = accounts.find(row => row.id === 'rebound')!
  rebound.email = 'new@chevoink.invalid'
  allowed.push(permission(rebound))

  const provider = { send: vi.fn(mockAdminEmailProvider.send), status: vi.fn(mockAdminEmailProvider.status) }
  const delivery = { ...mockAdminEmailDelivery, provider }
  await Promise.all([processAdminEmailQueue(delivery, () => now), processAdminEmailQueue(delivery, () => now)])
  expect(provider.send).toHaveBeenCalledTimes(7)
  expect(rows.map(row => row.state)).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'unknown', 'rejected', 'skipped', 'skipped', 'unknown'])
  expect(rows.find(row => row.userId === 'rebound')?.reason).toBe('email_changed')
  expect(rows.find(row => row.userId === 'withdraw-before-claim')?.reason).toBe('unsubscribed')
  expect(interrupted.reason).toBe('worker_interrupted')
  expect(rows[0]).toMatchObject({ providerMessageId: expect.stringMatching(/^mock-message-/), providerRequestId: expect.stringMatching(/^mock-request-/) })
  await processAdminEmailQueue(delivery, () => new Date(now.getTime() + 5_000))
  expect(rows.map(row => row.state)).toEqual(['delivered', 'deferred', 'bounced', 'delivered', 'delivered', 'unknown', 'rejected', 'skipped', 'skipped', 'unknown'])
  expect(mocks.db.$executeRaw.mock.calls.map(call => call[3])).toEqual(['hard_bounce'])
  await processAdminEmailQueue(delivery, () => new Date(now.getTime() + 35_000))
  expect(rows[1].state).toBe('delivered')
  expect(rows[3]).toMatchObject({ state: 'delivered', reason: 'unsubscribed', nextCheckAt: null })
  expect(rows[4]).toMatchObject({ state: 'delivered', reason: 'complained', nextCheckAt: null })
  expect(mocks.db.$executeRaw.mock.calls.map(call => call[3])).toEqual(['hard_bounce', 'unsubscribed', 'complained'])
  expect(provider.send).toHaveBeenCalledTimes(7)
})
