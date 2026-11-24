import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, adminEmailPurposeSchema } from '../../shared/contracts/admin-email.js'
import { DataAccessError, prisma } from './prisma.js'
import { customMockRecipientKey, customMockAddressExclusion, emailCandidateSelect, excludeCandidate, normalizedEmail, permissionsFor } from './admin-email-audience.js'
import { adminEmailTemplateHash, emailTemplateVariables, type AdminEmailTemplateSnapshot } from './admin-email-template.js'
import { createRewardLink } from './admin-return-reward-link.js'
import type { AdminEmailDelivery, AdminEmailProvider, AdminEmailStatusResult, AdminEmailSuppression } from './admin-email-provider.js'

const initialStatusDelayMs = 2_000
const subsequentStatusDelayMs = 15_000
const routineFeedbackDelayMs = 24 * 60 * 60_000
const statusWindowMs = 30 * 24 * 60 * 60_000
const staleSendMs = 2 * 60_000

const queuedEmailInclude = {
  batch: { select: { purpose: true, template: true, templateHash: true } },
} satisfies Prisma.AdminEmailRecipientInclude
type QueuedEmail = Prisma.AdminEmailRecipientGetPayload<{ include: typeof queuedEmailInclude }>

async function lockRecipientAddress(tx: Prisma.TransactionClient, item: QueuedEmail) {
  const key = `admin-email-suppression:${item.batch.purpose}:${item.email}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

async function suppressRecipient(tx: Prisma.TransactionClient, item: QueuedEmail, suppression: AdminEmailSuppression) {
  await tx.$executeRaw`
    INSERT INTO admin_email_permissions AS existing (purpose, email, suppression, updated_at)
    VALUES (${item.batch.purpose}, ${item.email}, ${suppression}::"AdminEmailSuppression", now() AT TIME ZONE 'UTC')
    ON CONFLICT (purpose, email) DO UPDATE SET suppression = excluded.suppression, updated_at = excluded.updated_at
    WHERE existing.suppression IS NULL OR
      (existing.suppression = 'unsubscribed' AND excluded.suppression IN ('hard_bounce', 'complained')) OR
      (existing.suppression = 'hard_bounce' AND excluded.suppression = 'complained')
  `
}

async function sendQueuedEmail(delivery: AdminEmailDelivery, item: QueuedEmail, clock: () => Date, currentTemplateHash: string) {
  const key = { batchId: item.batchId, userId: item.userId }
  const template = item.batch.template as AdminEmailTemplateSnapshot
  const rewardLink = item.batch.purpose === ADMIN_RETURN_EMAIL_PURPOSE && template.campaign && item.userId !== customMockRecipientKey(item.email)
    ? createRewardLink(delivery.mode) : null
  const attemptId = rewardLink?.attemptId ?? randomUUID()
  const attemptedAt = await prisma.$transaction(async tx => {
    // Serialize the eligibility decision and claim with account edits and suppression writes.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${item.userId} FOR SHARE`
    await lockRecipientAddress(tx, item)
    await tx.$queryRaw`
      SELECT email FROM admin_email_permissions
      WHERE purpose = ${item.batch.purpose} AND email = ${item.email} FOR SHARE
    `
    const user = await tx.user.findUnique({ where: { id: item.userId }, select: emailCandidateSelect })
    const permissions = await permissionsFor(tx, user ? [user] : [], item.batch.purpose)
    const claimedAt = clock()
    const expired = template.campaign?.deadline.mode === 'fixed' && Date.parse(template.campaign.deadline.at) <= claimedAt.getTime()
    const blocked = expired ? 'campaign_expired' : item.batch.templateHash !== currentTemplateHash ? 'template_changed'
      : delivery.allowedRecipients && !delivery.allowedRecipients.has(item.email) ? 'outside_send_scope'
      : user && normalizedEmail(user.email) !== item.email ? 'email_changed'
      : delivery.mode === 'mock' && item.userId === customMockRecipientKey(item.email)
        ? await customMockAddressExclusion(tx, item.email, item.batch.purpose)
        : excludeCandidate(user ?? undefined, permissions, item.batch.purpose)
    if (blocked) {
      await tx.adminEmailRecipient.updateMany({ where: { ...key, state: 'queued' }, data: { state: 'skipped', reason: blocked } })
      return null
    }
    const updated = await tx.adminEmailRecipient.updateMany({
      where: { ...key, state: 'queued' }, data: { state: 'sending', attemptId, attemptedAt: claimedAt, reason: null, nextCheckAt: null },
    })
    return updated.count === 1 ? claimedAt : null
  })
  if (!attemptedAt) return

  const result = await delivery.provider.send({
    attemptId, to: item.email, providerTemplateId: template.providerTemplateId, from: template.from,
    replyTo: template.replyTo, subject: template.subject,
    variables: { ...emailTemplateVariables(template, item.nickname, attemptedAt), ...(rewardLink && { workspace_path: rewardLink.workspacePath }) },
  }).catch(() => ({ state: 'unknown', reason: 'provider_unknown' } as const))

  await prisma.$transaction(async tx => {
    if (result.state === 'rejected' && result.suppression) {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${item.userId} FOR UPDATE`
      await lockRecipientAddress(tx, item)
    }
    const updated = await tx.adminEmailRecipient.updateMany({
      where: { ...key, attemptId, state: { in: ['sending', 'unknown'] } },
      data: result.state === 'accepted' ? {
        state: 'accepted', reason: null, providerMessageId: result.messageId, providerRequestId: result.requestId,
        nextCheckAt: new Date(attemptedAt.getTime() + initialStatusDelayMs),
      } : { state: result.state, reason: result.reason, providerRequestId: 'requestId' in result ? result.requestId : null },
    })
    if (updated.count && result.state === 'rejected' && result.suppression) {
      await suppressRecipient(tx, item, result.suppression)
    }
  })
}

async function reconcileDueEmail(provider: AdminEmailProvider, item: QueuedEmail, now: Date) {
  const { attemptId, attemptedAt, providerMessageId, nextCheckAt } = item
  if (!attemptId || !attemptedAt || !providerMessageId || !nextCheckAt) return
  const where = { batchId: item.batchId, userId: item.userId, attemptId, state: item.state, nextCheckAt }
  if (now.getTime() - attemptedAt.getTime() >= statusWindowMs) {
    await prisma.adminEmailRecipient.updateMany({
      where, data: item.state === 'delivered'
        ? { nextCheckAt: null } : { state: 'unknown', reason: 'status_window_expired', nextCheckAt: null },
    })
    return
  }

  let result: AdminEmailStatusResult
  try {
    const template = item.batch.template as AdminEmailTemplateSnapshot
    result = await provider.status({ messageId: providerMessageId, to: item.email, from: template.from, attemptedAt, now })
  } catch {
    await prisma.adminEmailRecipient.updateMany({ where, data: { nextCheckAt: new Date(now.getTime() + subsequentStatusDelayMs) } })
    return
  }

  await prisma.$transaction(async tx => {
    const { state, reason, suppression } = result
    if (suppression) {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${item.userId} FOR UPDATE`
      await lockRecipientAddress(tx, item)
    }
    // A later lookup can discover feedback without undoing a known delivery.
    const currentState = item.state === 'delivered' || (item.state === 'deferred' && state === 'accepted') ? item.state : state
    let delay = 0
    if (!suppression && currentState === 'delivered') delay = item.state === 'delivered' ? routineFeedbackDelayMs : subsequentStatusDelayMs
    if (currentState === 'accepted' || currentState === 'deferred') delay = subsequentStatusDelayMs
    const updated = await tx.adminEmailRecipient.updateMany({
      where,
      data: {
        state: currentState, reason: reason ?? null,
        nextCheckAt: delay ? new Date(now.getTime() + delay) : null,
      },
    })
    if (updated.count && suppression) await suppressRecipient(tx, item, suppression)
  })
}

export async function processAdminEmailQueue(delivery: AdminEmailDelivery, clock = () => new Date()) {
  const now = clock()
  const purpose = { in: delivery.mode === 'mock' ? adminEmailPurposeSchema.options : delivery.tencentPurposes ?? [ADMIN_EMAIL_PURPOSE] }
  const batchScope = { batch: { mode: delivery.mode, purpose } }
  await prisma.adminEmailRecipient.updateMany({
    where: { ...batchScope, state: 'sending', attemptedAt: { lt: new Date(now.getTime() - staleSendMs) } },
    data: { state: 'unknown', reason: 'worker_interrupted' },
  })

  const pendingReceipts = await prisma.adminEmailRecipient.findMany({
    where: { ...batchScope, state: { in: ['accepted', 'deferred'] }, nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: 'asc' }, take: 20, include: queuedEmailInclude,
  })
  for (const item of pendingReceipts) await reconcileDueEmail(delivery.provider, item, now)

  const feedback = await prisma.adminEmailRecipient.findMany({
    where: { ...batchScope, state: 'delivered', nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: 'asc' }, take: 20, include: queuedEmailInclude,
  })
  for (const item of feedback) await reconcileDueEmail(delivery.provider, item, now)

  const queued = await prisma.adminEmailRecipient.findMany({
    where: { ...batchScope, state: 'queued', OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    orderBy: { updatedAt: 'asc' }, take: 10, include: queuedEmailInclude,
  })
  let invitationHash: string | undefined
  const batchHashes = new Map<string, string | null>()
  for (const item of queued) {
    const template = item.batch.template as AdminEmailTemplateSnapshot
    let hash = batchHashes.get(item.batchId)
    if (hash === null) continue
    if (!hash) {
      try {
        hash = template.campaign || template.customTemplate
          ? adminEmailTemplateHash(await delivery.loadTemplate(template.campaign, template.customTemplate))
          : (invitationHash ??= adminEmailTemplateHash(await delivery.loadTemplate()))
        batchHashes.set(item.batchId, hash)
      } catch (error) {
        const changed = error instanceof DataAccessError && error.status === 409 &&
          ['ADMIN_EMAIL_TEMPLATE_UNAVAILABLE', 'CAMPAIGN_MOCK_ONLY'].includes(error.code)
        await prisma.adminEmailRecipient.updateMany({ where: { batchId: item.batchId, state: 'queued' },
          data: changed ? { state: 'skipped', reason: 'template_changed', nextCheckAt: null }
            : { nextCheckAt: new Date(now.getTime() + subsequentStatusDelayMs) } })
        batchHashes.set(item.batchId, null)
        continue
      }
    }
    await sendQueuedEmail(delivery, item, clock, hash)
  }

  // Expired unconfirmed snapshots have no audit or provider receipts.
  await prisma.adminEmailBatch.deleteMany({
    where: { mode: delivery.mode, state: 'preview', expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) }, purpose },
  })
}
