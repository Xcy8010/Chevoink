import { createHmac } from 'node:crypto'
import type { GovernanceCase, Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import {
  allowedReasons,
  isReportReason,
  reportFeedback,
  type ReportReason,
  type ReportTarget,
} from '../../shared/contracts/governance-cases.js'
import { lockAccountKey } from './email-verification.js'
import { DataAccessError, prisma } from './prisma.js'
import { searchableNovelWhere, publicChapterWhere } from './data-access.js'

export const caseListSelect = {
  id: true,
  kind: true,
  targetKind: true,
  targetId: true,
  category: true,
  status: true,
  acknowledgeBy: true,
  feedbackBy: true,
  materialsAt: true,
  acknowledgedAt: true,
  publicProgress: true,
  createdAt: true,
  updatedAt: true,
} as const
export const caseMissing = () => new DataAccessError(404, 'GOVERNANCE_NOT_FOUND', '未找到可访问的事项。')
export function privateDigest(value: string) {
  if (!env.authSessionSecret)
    throw new DataAccessError(503, 'GOVERNANCE_SECRET_UNAVAILABLE', '当前无法核验身份，请稍后重试。')
  return createHmac('sha256', env.authSessionSecret)
    .update('governance:' + value)
    .digest('hex')
}

// Dates are evaluated in China Standard Time. Explicit makeup days and holidays
// override the weekly calendar when the operator supplies the official schedule.
export function workdayDue(
  start: Date,
  days: number,
  holidays = process.env.GOVERNANCE_HOLIDAYS ?? '',
  workdays = process.env.GOVERNANCE_WORKDAYS ?? '',
) {
  const day = new Date(+start + 8 * 3600000)
  const off = new Set(holidays.split(',')),
    on = new Set(workdays.split(','))
  while (days > 0) {
    day.setUTCDate(day.getUTCDate() + 1)
    const key = day.toISOString().slice(0, 10),
      weekday = day.getUTCDay()
    if (on.has(key) || (!off.has(key) && weekday !== 0 && weekday !== 6)) days--
  }
  return new Date(+day - 8 * 3600000)
}
export function deadlines(start: Date) {
  return { acknowledgeBy: workdayDue(start, 3), materialsAt: start, feedbackBy: workdayDue(start, 15) }
}

export function overdueCases(now: Date): Prisma.GovernanceCaseWhereInput {
  return {
    OR: [
      { status: 'pending', acknowledgeBy: { lt: now } },
      { status: 'investigating', feedbackBy: { lt: now } },
    ],
  }
}

export function casesWithCategory(category: string): Prisma.GovernanceCaseWhereInput {
  return isReportReason(category)
    ? { OR: [{ category }, { kind: 'report', category: { contains: ',' + category + ',' } }] }
    : { category }
}

type Tx = Prisma.TransactionClient
export async function notifyCase(tx: Tx, userId: string | null, id: string, body: string) {
  if (userId) await tx.userNotification.create({ data: { userId, title: '治理事项 ' + id, body } })
}
async function evidence(tx: Tx, kind: ReportTarget, id: string, reporter: string | null) {
  if (kind === 'platform') return { subjectId: null, snapshot: null }
  if (kind === 'message') {
    if (!reporter) throw caseMissing()
    const row = await tx.message.findFirst({
      where: { id, conversation: { type: 'direct', members: { some: { userId: reporter } } } },
      select: { senderId: true, content: true },
    })
    if (row) return { subjectId: row.senderId, snapshot: row.content.slice(0, 2000) }
  }
  if (kind === 'post') {
    const row = await tx.post.findFirst({
      where: { id, auditStatus: { not: 'rejected' } },
      select: { userId: true, content: true, imageUrls: true },
    })
    if (row)
      return {
        subjectId: row.userId,
        snapshot: [row.content.slice(0, 2000), ...row.imageUrls.slice(0, 9).map((url) => url.slice(0, 512))]
          .filter(Boolean)
          .join('\n'),
      }
  }
  if (kind === 'profile') {
    const row = await tx.user.findUnique({ where: { id }, select: { id: true, nickname: true, bio: true } })
    if (row)
      return {
        subjectId: row.id,
        snapshot: [row.nickname, row.bio].filter(Boolean).join('\n').slice(0, 2000),
      }
  }
  if (kind === 'novel') {
    const row = await tx.novel.findFirst({
      where: { id, ...searchableNovelWhere },
      select: { authorId: true, title: true, summary: true },
    })
    if (row) return { subjectId: row.authorId, snapshot: (row.title + '\n' + row.summary).slice(0, 2000) }
  }
  if (kind === 'comment') {
    const row = await tx.comment.findFirst({
      where: {
        id,
        auditStatus: { not: 'rejected' },
        OR: [
          { targetType: 'post', post: { auditStatus: { not: 'rejected' } } },
          { targetType: 'novel', novel: searchableNovelWhere },
          {
            targetType: 'chapter',
            chapter: { ...publicChapterWhere, archivedAt: null, novel: searchableNovelWhere },
          },
        ],
      },
      select: { userId: true, content: true },
    })
    if (row) return { subjectId: row.userId, snapshot: row.content.slice(0, 2000) }
  }
  throw caseMissing()
}

type Submission = {
  requestKey: string
  targetKind: ReportTarget
  targetId: string
  category?: ReportReason
  categories?: ReportReason[]
  statement: string
}
export function reporterReceipt(
  item: Pick<GovernanceCase, 'id' | 'requestKey' | 'status' | 'publicProgress'>,
) {
  return {
    id: item.id,
    status: item.status,
    receipt: privateDigest('receipt:' + item.requestKey),
    message: item.publicProgress ?? reportFeedback[item.status],
  }
}
function assertReportSubject(reporterId: string | null, subjectId: string | null) {
  if (reporterId && subjectId === reporterId)
    throw new DataAccessError(400, 'SELF_REPORT', '无法举报自己的内容或个人主页。')
}
export async function createReport(userId: string | null, source: string, data: Submission) {
  const { category, categories, ...submission } = data
  const incoming = categories ?? (category ? [category] : [])
  const reasons = allowedReasons(data.targetKind).filter((reason) => incoming.includes(reason))
  if (
    (category && categories) ||
    !reasons.length ||
    incoming.some((reason) => !reasons.includes(reason)) ||
    (reasons.some((reason) => reason === 'copyright' || reason === 'other') && !data.statement.trim())
  )
    throw new DataAccessError(400, 'INVALID_REASON', '请补充举报理由或必要的权利证明。')
  const requesterKey = privateDigest(userId ? 'account:' + userId : 'guest:' + source)
  return prisma.$transaction(async (tx) => {
    await lockAccountKey(tx, 'report-key:' + data.requestKey)
    const existing = await tx.governanceCase.findUnique({ where: { requestKey: data.requestKey } })
    if (existing) {
      if (
        existing.kind !== 'report' ||
        existing.reporterId !== userId ||
        existing.requesterKey !== requesterKey ||
        existing.targetKind !== data.targetKind ||
        existing.targetId !== data.targetId
      )
        throw caseMissing()
      assertReportSubject(userId, existing.subjectId)
      return reporterReceipt(existing)
    }
    await lockAccountKey(tx, 'report-rate:' + requesterKey)
    const now = new Date()
    if (
      (await tx.governanceCase.count({
        where: { requesterKey, createdAt: { gte: new Date(+now - 3600000) } },
      })) >= 12
    )
      throw new DataAccessError(429, 'RATE_LIMITED', '提交过于频繁，请稍后再试。')
    const snapshot = await evidence(tx, data.targetKind, data.targetId, userId)
    assertReportSubject(userId, snapshot.subjectId)
    const item = await tx.governanceCase.create({
      data: {
        ...submission,
        category: reasons.length === 1 ? reasons[0] : ',' + reasons.join(',') + ',',
        ...snapshot,
        ...deadlines(now),
        kind: 'report',
        requesterKey,
        reporterId: userId,
        events: { create: { action: 'submitted', result: 'pending' } },
      },
    })
    await notifyCase(tx, userId, item.id, reportFeedback.pending)
    return reporterReceipt(item)
  })
}
export async function auditCase(
  tx: Tx,
  adminId: string,
  id: string,
  action: string,
  prior?: string,
  result?: string,
  reason?: string,
) {
  const event = await tx.governanceCaseEvent.create({
    data: { caseId: id, actorId: adminId, action, prior, result, reason },
  })
  await tx.adminAuditLog.create({
    data: {
      adminId,
      action: 'governance.' + action,
      targetType: 'governance_case',
      targetId: id,
      detail: { eventId: event.id, prior: prior ?? null, result: result ?? null },
    },
  })
  return event
}
export async function reviewReport(
  id: string,
  adminId: string,
  input: {
    status: 'investigating' | 'upheld' | 'dismissed' | 'linked'
    reason: string
    relatedId?: string
    retainUntil?: Date
  },
) {
  return prisma.$transaction(async (tx) => {
    // Serialize linking with closing the parent so a receipt cannot miss its final result.
    for (const key of [...new Set([id, ...(input.relatedId ? [input.relatedId] : [])])].sort())
      await lockAccountKey(tx, 'case:' + key)
    const item = await tx.governanceCase.findFirst({ where: { id, kind: { in: ['report', 'usage'] } } })
    if (!item) throw caseMissing()
    if (!['pending', 'investigating'].includes(item.status) || input.status === item.status)
      throw new DataAccessError(409, 'CASE_CHANGED', '案件状态已变更，请刷新。')
    if (input.status === 'linked') {
      if (
        !input.relatedId ||
        input.relatedId === id ||
        !(await tx.governanceCase.findFirst({
          where: {
            id: input.relatedId,
            kind: item.kind,
            targetId: item.targetId,
            targetKind: item.targetKind,
            status: { in: ['pending', 'investigating'] },
          },
        })) ||
        (await tx.governanceCase.count({ where: { relatedId: id } }))
      )
        throw new DataAccessError(400, 'INVALID_CASE_LINK', '请选择同一目标的待处理主案件。')
    }
    const closed = ['upheld', 'dismissed'].includes(input.status)
    const dependents = closed
      ? await tx.governanceCase.findMany({ where: { relatedId: id, status: 'linked' } })
      : []
    for (const row of [item, ...dependents]) {
      await tx.governanceCase.update({
        where: { id: row.id },
        data: {
          status: input.status,
          acknowledgedAt: row.acknowledgedAt ?? new Date(),
          publicProgress: null,
          relatedId: input.status === 'linked' ? input.relatedId : row.relatedId,
          conclusion: input.reason,
          evidenceUntil: closed ? (input.retainUntil ?? new Date()) : null,
        },
      })
      await auditCase(tx, adminId, row.id, 'review', row.status, input.status, input.reason)
      await notifyCase(tx, row.reporterId, row.id, reportFeedback[input.status])
    }
    return { id, status: input.status }
  })
}
export async function purgeDueCaseEvidence(now = new Date()) {
  const where = { evidenceUntil: { lte: now } }
  const rows = await prisma.governanceCase.findMany({
    where,
    select: { id: true },
    take: 100,
    orderBy: { evidenceUntil: 'asc' },
  })
  if (rows.length)
    await prisma.governanceCase.updateMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
      data: { snapshot: null, statement: null, evidenceUntil: null },
    })
}
