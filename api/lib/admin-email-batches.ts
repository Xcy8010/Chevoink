import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  ADMIN_EMAIL_BATCH_LIMIT, ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, ADMIN_CUSTOM_EMAIL_PURPOSE, adminEmailPurposeSchema,
  type AdminEmailCampaign, type AdminCustomEmailTemplate,
  type AdminEmailBatch, type AdminEmailBatchDetail, type AdminEmailExclusion, type AdminEmailMode, type AdminEmailSelection,
} from '../../shared/contracts/admin-email.js'
import { DataAccessError, prisma } from './prisma.js'
import {
  emailCandidateSelect, matchingEmailCandidates, customMockRecipientKey, customMockAddressExclusion, EMAIL_CANDIDATE_LIMIT, excludeCandidate,
  maskedEmail, normalizedEmail, permissionsFor, presentCandidate, sampleEmailCandidates,
} from './admin-email-audience.js'
import { adminEmailTemplateHash, emailTemplateVariables, substituteEmailVariables, type AdminEmailTemplateSnapshot } from './admin-email-template.js'
import { mockAdminEmailDelivery, type AdminEmailDelivery } from './admin-email-provider.js'

const previewLifetimeMs = 15 * 60_000
const detailInclude = { recipients: { orderBy: { userId: 'asc' } } } satisfies Prisma.AdminEmailBatchInclude
type BatchDetailRecord = Prisma.AdminEmailBatchGetPayload<{ include: typeof detailInclude }>

function summarize(batch: Omit<BatchDetailRecord, 'recipients'>, recipients: Array<{ state: AdminEmailBatchDetail['recipients'][number]['state'] }>): AdminEmailBatch {
  const progress: AdminEmailBatch['progress'] = {}
  for (const { state } of recipients) progress[state] = (progress[state] ?? 0) + 1
  return {
    id: batch.id, mode: batch.mode, state: batch.state, createdAt: batch.createdAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(), recipientCount: batch.recipientCount, progress,
  }
}

function presentBatch(batch: BatchDetailRecord): AdminEmailBatchDetail {
  const template = batch.template as AdminEmailTemplateSnapshot
  const nickname = batch.recipients[0]?.nickname ?? '创作者'
  return {
    ...summarize(batch, batch.recipients),
    previewHash: batch.previewHash,
    replacedById: batch.replacedById,
    selection: batch.selection as AdminEmailSelection,
    ...(template.campaign && { campaign: template.campaign }),
    ...(template.customTemplate && { customTemplate: template.customTemplate }),
    template: {
      id: template.id, from: template.from, replyTo: template.replyTo, subject: template.subject,
      sampleBody: substituteEmailVariables(template.body, emailTemplateVariables(template, nickname, batch.createdAt)),
    },
    candidateCount: batch.candidateCount, eligibleCount: batch.eligibleCount,
    exclusions: batch.exclusions as AdminEmailBatchDetail['exclusions'],
    blocker: batch.blocker as AdminEmailBatchDetail['blocker'],
    recipients: batch.recipients.map(recipient => ({
      userId: recipient.userId, nickname: recipient.nickname, maskedEmail: maskedEmail(recipient.email) ?? '•••',
      state: recipient.state, reason: recipient.reason, providerMessageId: recipient.providerMessageId,
      providerRequestId: recipient.providerRequestId, attemptedAt: recipient.attemptedAt?.toISOString() ?? null,
      updatedAt: recipient.updatedAt.toISOString(),
    })),
  }
}

async function batchFor(db: Prisma.TransactionClient, adminId: string, batchId: string, mode: AdminEmailMode) {
  const batch = await db.adminEmailBatch.findFirst({
    where: { id: batchId, adminId, purpose: { in: adminEmailPurposeSchema.options }, mode }, include: detailInclude,
  })
  if (!batch) throw new DataAccessError(404, 'EMAIL_BATCH_NOT_FOUND', '找不到此邮件批次。')
  return batch
}

const previewChanged = () => new DataAccessError(409, 'EMAIL_PREVIEW_CHANGED', '预览已过期或收件资格、模板已变化，请重新生成预览。')

async function lockEmailAdmin(tx: Prisma.TransactionClient, adminId: string) {
  const actor = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE id = ${adminId} AND role = 'admin' AND is_super_admin AND banned_at IS NULL
    FOR SHARE
  `
  if (!actor.length) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '定向邮件仅限超级管理员。')
}

export async function listEmailCandidates(search: string, page: number, delivery = mockAdminEmailDelivery, purpose: string = ADMIN_EMAIL_PURPOSE) {
  const pageSize = 20
  const where: Prisma.UserWhereInput = search ? { OR: [
    { id: { contains: search, mode: 'insensitive' } },
    { nickname: { contains: search, mode: 'insensitive' } },
    { email: { contains: search, mode: 'insensitive' } },
  ] } : {}
  const users = await prisma.user.findMany({
    where, select: emailCandidateSelect, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize + 1,
  })
  const candidates = users.slice(0, pageSize)
  const permissions = await permissionsFor(prisma, candidates, purpose)
  const items = candidates.map(candidate => {
    const view = presentCandidate(candidate, permissions)
    if (!view.exclusion && delivery.allowedRecipients && !delivery.allowedRecipients.has(normalizedEmail(candidate.email) ?? '')) {
      view.exclusion = 'outside_send_scope'
    }
    return view
  })
  return { page, hasNextPage: users.length > pageSize, items }
}

export async function listEmailBatches(adminId: string, mode: AdminEmailMode = 'mock') {
  const items = await prisma.adminEmailBatch.findMany({
    where: { adminId, mode, purpose: { in: adminEmailPurposeSchema.options }, state: { not: 'preview' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30, include: { recipients: { select: { state: true } } },
  })
  return { items: items.map(batch => summarize(batch, batch.recipients)) }
}

export async function getEmailBatch(adminId: string, batchId: string, mode: AdminEmailMode = 'mock') {
  return presentBatch(await batchFor(prisma, adminId, batchId, mode))
}

export async function createEmailPreview(
  adminId: string, selection: AdminEmailSelection,
  { now = new Date(), replaces, campaign, customTemplate, delivery = mockAdminEmailDelivery }: { now?: Date; campaign?: AdminEmailCampaign; customTemplate?: AdminCustomEmailTemplate; replaces?: string; delivery?: AdminEmailDelivery } = {},
) {
  const purpose = campaign ? ADMIN_RETURN_EMAIL_PURPOSE : customTemplate ? ADMIN_CUSTOM_EMAIL_PURPOSE : ADMIN_EMAIL_PURPOSE
  if (campaign?.deadline.mode === 'fixed' && Date.parse(campaign.deadline.at) <= now.getTime()) {
    throw new DataAccessError(400, 'CAMPAIGN_EXPIRED', '请选择未来的活动截止时间。')
  }
  const template = await delivery.loadTemplate(campaign, customTemplate)
  const templateHash = adminEmailTemplateHash(template)
  return prisma.$transaction(async tx => {
    await lockEmailAdmin(tx, adminId)
    const id = randomUUID()
    if (replaces) {
      const replaced = await tx.adminEmailBatch.updateMany({
        where: { id: replaces, adminId, purpose: { in: adminEmailPurposeSchema.options }, mode: delivery.mode, state: 'preview', replacedById: null },
        data: { replacedById: id },
      })
      if (!replaced.count) throw previewChanged()
    }
    const users = await matchingEmailCandidates(tx, selection, now)
    if (users.length > EMAIL_CANDIDATE_LIMIT) {
      throw new DataAccessError(409, 'EMAIL_CANDIDATE_LIMIT', '候选范围超过 10000 个账号，请缩小筛选条件。')
    }

    const permissions = await permissionsFor(tx, users, purpose)
    const userById = new Map(users.map(user => [user.id, user]))
    const candidateIds = selection.mode === 'manual' ? [...new Set(selection.userIds)] : users.map(user => user.id)
    const exclusions: Partial<Record<AdminEmailExclusion, number>> = {}
    const exclude = (reason: AdminEmailExclusion) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1 }
    const seenEmail = new Set<string>()
    const eligible = candidateIds.flatMap(id => {
      const user = userById.get(id)
      const exclusion = excludeCandidate(user, permissions)
      if (exclusion) exclude(exclusion)
      if (!user || exclusion) return []
      const email = normalizedEmail(user.email)
      if (!email) return []
      if (delivery.allowedRecipients && !delivery.allowedRecipients.has(email)) {
        exclude('outside_send_scope')
        return []
      }
      if (seenEmail.has(email)) {
        exclude('duplicate_email')
        return []
      }
      seenEmail.add(email)
      return [{ id, email, nickname: user.nickname, lastActiveAt: user.lastActiveAt }]
    })

    let candidateCount = candidateIds.length
    if (selection.mode === 'emails') {
      const bound = new Set(users.map(user => normalizedEmail(user.email)))
      const distinct = [...new Set(selection.emails.map(email => email.trim().toLowerCase()))]
      const missing = distinct.filter(email => !bound.has(email))
      candidateCount += missing.length
      if (selection.emails.length > distinct.length) {
        exclusions.duplicate_email = (exclusions.duplicate_email ?? 0) + selection.emails.length - distinct.length
        candidateCount += selection.emails.length - distinct.length
      }
      const suppressed = missing.length && delivery.mode === 'mock' ? await tx.adminEmailPermission.findMany({
        where: { purpose, email: { in: missing }, suppression: { not: null } },
        select: { email: true, suppression: true },
      }) : []
      const byEmail = new Map(suppressed.map(item => [item.email, item.suppression]))
      for (const email of missing) {
        const reason = byEmail.get(email)
        if (delivery.mode !== 'mock') exclude('missing_user')
        else if (reason) exclude(reason)
        else eligible.push({ id: customMockRecipientKey(email), email, nickname: '自定义邮箱（模拟）', lastActiveAt: null })
      }
    }

    let blocker: AdminEmailBatchDetail['blocker'] = null
    if (!eligible.length) blocker = 'empty'
    else if (selection.mode === 'sample' && selection.size > eligible.length) blocker = 'sample_size'
    else if (selection.mode !== 'sample' && eligible.length > ADMIN_EMAIL_BATCH_LIMIT) blocker = 'batch_limit'

    const seed = randomUUID()
    const sample = selection.mode === 'sample' && !blocker
      ? sampleEmailCandidates(eligible, selection.size, selection.weighting, seed, now)
      : null
    const picked = blocker ? [] : sample?.picked ?? eligible.map(candidate => ({ candidate, weight: null }))
    const recipients = picked.map(({ candidate, weight }) => ({
      userId: candidate.id, email: candidate.email, nickname: candidate.nickname, weight,
    })).sort((a, b) => a.userId.localeCompare(b.userId))
    const expiresAt = new Date(now.getTime() + previewLifetimeMs)
    const previewHash = createHash('sha256').update(JSON.stringify({
      id, adminId, mode: delivery.mode, selection, expiresAt, templateHash, recipients,
    })).digest('hex')
    const snapshot = await tx.adminEmailBatch.create({
      data: {
        id, adminId, mode: delivery.mode, purpose, template: { ...template }, templateHash,
        selection, sampling: sample ? { version: 'exponential-race-v1', seed, weightCounts: sample.weightCounts } : undefined,
        candidateCount, eligibleCount: eligible.length, recipientCount: recipients.length,
        exclusions, blocker, previewHash, createdAt: now, expiresAt, recipients: { create: recipients },
      },
      include: detailInclude,
    })
    return presentBatch(snapshot)
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40001'))) throw previewChanged()
    throw error
  })
}

export async function confirmEmailBatch(
  adminId: string, batchId: string, previewHash: string, ip: string | null, now = new Date(), delivery = mockAdminEmailDelivery,
) {
  const snapshot = await batchFor(prisma, adminId, batchId, delivery.mode)
  if (snapshot.previewHash !== previewHash || snapshot.replacedById) throw previewChanged()
  const savedTemplate = snapshot.template as AdminEmailTemplateSnapshot
  if (!snapshot.confirmedAt && savedTemplate?.campaign?.deadline.mode === 'fixed' && Date.parse(savedTemplate.campaign.deadline.at) <= now.getTime()) throw previewChanged()
  const templateHash = snapshot.confirmedAt ? null : adminEmailTemplateHash(await delivery.loadTemplate(savedTemplate?.campaign, savedTemplate?.customTemplate))
  if (templateHash !== null && templateHash !== snapshot.templateHash) throw previewChanged()
  return prisma.$transaction(async tx => {
    await lockEmailAdmin(tx, adminId)
    const batch = await batchFor(tx, adminId, batchId, delivery.mode)
    if (batch.previewHash !== previewHash || batch.replacedById) throw previewChanged()
    if (batch.confirmedAt) return presentBatch(batch)
    if (batch.blocker || !batch.recipients.length) {
      throw new DataAccessError(409, 'EMAIL_BATCH_INELIGIBLE', '此预览无法发送，请调整收件范围。')
    }

    // Claim the immutable preview inside the same transaction as the eligibility check and enqueuing.
    const claimed = await tx.adminEmailBatch.updateMany({
      where: { id: batchId, adminId, mode: delivery.mode, state: 'preview', replacedById: null, expiresAt: { gt: now }, templateHash: batch.templateHash },
      data: { state: 'confirmed', confirmedAt: now },
    })
    if (!claimed.count) {
      const existing = await batchFor(tx, adminId, batchId, delivery.mode)
      if (existing.confirmedAt) return presentBatch(existing)
      throw previewChanged()
    }

    const users = await tx.user.findMany({
      where: { id: { in: batch.recipients.map(recipient => recipient.userId) } }, select: emailCandidateSelect,
    })
    const permissions = await permissionsFor(tx, users, batch.purpose)
    const userById = new Map(users.map(user => [user.id, user]))
    for (const recipient of batch.recipients) {
      if (batch.mode === 'mock' && recipient.userId === customMockRecipientKey(recipient.email)) {
        if (await customMockAddressExclusion(tx, recipient.email, batch.purpose)) throw previewChanged()
        continue
      }
      const user = userById.get(recipient.userId)
      if (!user || normalizedEmail(user.email) !== recipient.email || excludeCandidate(user, permissions)
        || (delivery.allowedRecipients && !delivery.allowedRecipients.has(recipient.email))) throw previewChanged()
    }

    await tx.adminEmailRecipient.updateMany({ where: { batchId, state: 'preview' }, data: { state: 'queued' } })
    await tx.adminAuditLog.create({ data: {
      adminId, action: 'email_batch.confirm', targetType: 'email_batch', targetId: batchId, ip,
      detail: { template: (batch.template as AdminEmailTemplateSnapshot).id, templateHash: batch.templateHash, provider: batch.mode,
        selectionMode: (batch.selection as AdminEmailSelection).mode, recipientCount: batch.recipientCount },
    } })
    return presentBatch(await batchFor(tx, adminId, batchId, delivery.mode))
  })
}

export async function cancelEmailBatch(adminId: string, batchId: string, ip: string | null, mode: AdminEmailMode = 'mock') {
  return prisma.$transaction(async tx => {
    await lockEmailAdmin(tx, adminId)
    const batch = await batchFor(tx, adminId, batchId, mode)
    if (batch.state === 'preview') throw new DataAccessError(409, 'EMAIL_BATCH_NOT_QUEUED', '此批次尚未入队。')
    const cancelled = await tx.adminEmailBatch.updateMany({
      where: { id: batchId, adminId, mode, state: 'confirmed' }, data: { state: 'cancelled' },
    })
    if (cancelled.count) {
      const recipients = await tx.adminEmailRecipient.updateMany({
        where: { batchId, state: 'queued' }, data: { state: 'cancelled', reason: 'admin_cancelled' },
      })
      await tx.adminAuditLog.create({ data: {
        adminId, action: 'email_batch.cancel', targetType: 'email_batch', targetId: batchId, ip,
        detail: { cancelledCount: recipients.count },
      } })
    }
    return presentBatch(await batchFor(tx, adminId, batchId, mode))
  })
}
