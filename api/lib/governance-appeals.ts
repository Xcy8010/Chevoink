import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { AppealSubject } from '../../shared/contracts/governance-cases.js'
import {
  auditCase,
  caseListSelect,
  caseMissing,
  deadlines,
  notifyCase,
  privateDigest,
} from './governance-cases.js'
import { lockAccountKey } from './email-verification.js'
import { DataAccessError, prisma } from './prisma.js'
import { changeRestriction, governanceAvailableFor } from './governance-restrictions.js'
import { correctSafetyEscalation } from './governance-safety.js'
import { restrictionLabels } from '../../shared/contracts/governance-restrictions.js'
import { queueGovernanceMail } from './governance-mail.js'

export async function eligibleForAppealPortal(userId: string) {
  if (await governanceAvailableFor(userId)) return true
  const [restriction, warning, appeal] = await Promise.all([
    prisma.accountRestriction.findFirst({
      where: { userId, OR: [{ legacyBan: false }, { legacyBan:true, sourceId:'legacy-admin' }] },
      select: { id: true },
    }),
    prisma.agentSafetyEscalation.findFirst({ where: { userId, level: 'warning' }, select: { id: true } }),
    prisma.governanceCase.findFirst({ where: { reporterId: userId, kind: 'appeal' }, select: { id: true } }),
  ])
  return Boolean(restriction || warning || appeal)
}
export function issueAppealProof(userId: string, now = Date.now()) {
  const claims = Buffer.from(JSON.stringify([userId, now + 20 * 60_000])).toString('base64url')
  return claims + '.' + privateDigest('appeal:' + claims)
}
export function verifyAppealProof(token: string | undefined, now = Date.now()): string {
  const [claims, signature, ...extra] = (token ?? '').split('.')
  const invalid = () => new DataAccessError(401, 'APPEAL_VERIFICATION_REQUIRED', '请重新核验身份后查看申诉。')
  if (
    !claims ||
    claims.length > 512 ||
    extra.length ||
    !/^[0-9a-f]{64}$/.test(signature ?? '') ||
    !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(privateDigest('appeal:' + claims), 'hex'))
  )
    throw invalid()
  const parsed = z
    .tuple([z.string().min(1), z.number()])
    .parse(JSON.parse(Buffer.from(claims, 'base64url').toString()))
  if (parsed[1] <= now) throw invalid()
  return parsed[0]
}
const measures: Record<string, string> = restrictionLabels
async function appealSubjects(db: Prisma.TransactionClient, userId: string): Promise<AppealSubject[]> {
  const [restrictions, warnings] = await Promise.all([
    db.accountRestriction.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.agentSafetyEscalation.findMany({
      where: { userId, level: 'warning', correctedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ])
  const warningNotices = warnings.length
    ? await db.governanceMail.findMany({
        where: { userId, kind: 'warning', eventId: { in: warnings.map((row) => row.id) } },
        select: { eventId: true, reason: true },
      })
    : []
  const warningReasons = new Map(warningNotices.map((row) => [row.eventId, row.reason]))
  return [
    ...restrictions.map((r) => ({
      id: r.id,
      kind: 'restriction' as const,
      reason: r.reason,
      clause: r.clause,
      measure: measures[r.scope] ?? r.scope,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    })),
    ...warnings.map((r) => ({
      id: r.id,
      kind: 'warning' as const,
      reason: warningReasons.get(r.id) ?? '创作 Agent 使用提醒，可提交记录纠错。',
      measure: '账号使用提醒',
      clause: '用户服务协议 · 内容安全',
      expiresAt: null,
    })),
  ]
}
export async function readAppeals(userId: string) {
  const [subjects, cases] = await Promise.all([
    appealSubjects(prisma, userId),
    prisma.governanceCase.findMany({
      where: { kind: 'appeal', reporterId: userId },
      select: { ...caseListSelect, conclusion: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ])
  return { subjects, cases }
}
export async function submitAppeal(
  userId: string,
  input: { requestKey: string; targetId: string; statement: string },
) {
  return prisma.$transaction(async (tx) => {
    await lockAccountKey(tx, 'appeal:' + userId)
    const retry = await tx.governanceCase.findUnique({ where: { requestKey: input.requestKey } })
    if (retry) {
      if (retry.kind !== 'appeal' || retry.reporterId !== userId || retry.targetId !== input.targetId)
        throw caseMissing()
      return { id: retry.id }
    }
    const subject = (await appealSubjects(tx, userId)).find((s) => s.id === input.targetId)
    if (!subject) throw caseMissing()
    const prior = await tx.governanceCase.findFirst({
      where: { kind: 'appeal', reporterId: userId, targetId: subject.id },
      orderBy: { createdAt: 'desc' },
    })
    if (prior && (prior.statement === input.statement || ['pending', 'investigating'].includes(prior.status)))
      throw new DataAccessError(409, 'APPEAL_EXISTS', '此事项已有申诉，请查看进度；结案后可提交新证据。')
    if (
      (await tx.governanceCase.count({
        where: { kind: 'appeal', reporterId: userId, createdAt: { gte: new Date(Date.now() - 86400000) } },
      })) >= 8
    )
      throw new DataAccessError(429, 'RATE_LIMITED', '今日申诉已达到上限，请稍后再试。')
    const item = await tx.governanceCase.create({
      data: {
        ...input,
        kind: 'appeal',
        category: subject.kind,
        targetKind: subject.kind,
        subjectId: userId,
        reporterId: userId,
        requesterKey: privateDigest(userId),
        snapshot: JSON.stringify(subject),
        ...deadlines(new Date()),
        events: { create: { action: 'submitted', result: 'pending' } },
      },
    })
    await notifyCase(tx, userId, item.id, '已收到你的申诉，可在独立申诉页面查看进度。')
    return { id: item.id }
  })
}
export function linkedSafetyEscalation(
  tx: Prisma.TransactionClient,
  userId: string,
  targetKind: string,
  targetId: string,
) {
  return tx.agentSafetyEscalation.findFirst({
    where: {
      userId,
      correctedAt: null,
      ...(targetKind === 'warning'
        ? { id: targetId, level: 'warning' }
        : { restrictionId: targetId, level: 'platform' }),
    },
    select: { id: true, eventIds: true, restrictionId: true },
  })
}
export async function reviewAppeal(
  adminId: string,
  id: string,
  input: {
    status: 'investigating' | 'maintained' | 'adjusted' | 'lifted' | 'corrected'
    reason: string
    expiresAt?: Date
    retainUntil?: Date
    invalidEventIds?: string[]
  },
) {
  return prisma.$transaction(async (tx) => {
    await lockAccountKey(tx, 'case:' + id)
    const row = await tx.governanceCase.findFirst({ where: { id, kind: 'appeal' } })
    if (!row?.subjectId) throw caseMissing()
    if (!['pending', 'investigating'].includes(row.status) || row.status === input.status)
      throw new DataAccessError(409, 'CASE_CHANGED', '案件状态已变更，请刷新。')
    let status = input.status
    let revokedByCorrection = false
    const invalidEvents = input.invalidEventIds ?? []
    if (status === 'corrected' || invalidEvents.length) {
      if (!invalidEvents.length || !['adjusted', 'lifted', 'corrected'].includes(status))
        throw new DataAccessError(400, 'INVALID_CORRECTION', '请选择经复核认定有误的关联事件。')
      const escalation = await linkedSafetyEscalation(tx, row.subjectId, row.targetKind, row.targetId)
      if (!escalation) throw new DataAccessError(409, 'SAFETY_RECORD_CHANGED', '关联安全记录已变更，请刷新。')
      await correctSafetyEscalation(tx, adminId, escalation.id, row.subjectId, input.reason, invalidEvents)
      if (escalation.restrictionId) {
        const restriction = await tx.accountRestriction.findUniqueOrThrow({
          where: { id: escalation.restrictionId },
        })
        revokedByCorrection = Boolean(restriction.revokedAt)
        if (revokedByCorrection) status = 'lifted'
      }
    }
    if ((status === 'adjusted' || status === 'lifted') && !revokedByCorrection) {
      if (row.targetKind !== 'restriction')
        throw new DataAccessError(400, 'REVIEW_EVENT_FIRST', '请先在安全记录中复核并纠正关联事件。')
      if (status === 'adjusted' && !input.expiresAt)
        throw new DataAccessError(400, 'END_TIME_REQUIRED', '请选择调整后的截止时间。')
      await changeRestriction(
        tx,
        adminId,
        row.targetId,
        {
          action: status === 'lifted' ? 'revoke' : 'adjust',
          reason: input.reason,
          expiresAt: input.expiresAt?.toISOString(),
        },
        row.subjectId,
      )
    }
    const closed = status !== 'investigating'
    await tx.governanceCase.update({
      where: { id },
      data: {
        status,
        acknowledgedAt: row.acknowledgedAt ?? new Date(),
        publicProgress: null,
        conclusion: input.reason,
        evidenceUntil: closed ? (input.retainUntil ?? new Date()) : null,
      },
    })
    await auditCase(tx, adminId, id, 'review', row.status, status, input.reason)
    await notifyCase(tx, row.subjectId, id, input.reason)
    if (status !== 'investigating') {
      const results = { maintained: '维持原处理', adjusted: '调整原处理', lifted: '撤销相关限制', corrected: '纠正相关记录' }
      let measure = '本次复核涉及账号使用提醒。提醒本身不限制账号功能。'
      if (row.targetKind === 'restriction') {
        const restriction = await tx.accountRestriction.findFirstOrThrow({ where: { id: row.targetId, userId: row.subjectId } })
        const scope = measures[restriction.scope] ?? restriction.scope
        if (restriction.revokedAt) measure = '已撤销本次「' + scope + '」限制。'
        else if (restriction.expiresAt && restriction.expiresAt <= new Date()) measure = '本次「' + scope + '」限制已到期。'
        else measure = '本次限制范围为「' + scope + '」，' + (restriction.expiresAt ? '截至 ' + restriction.expiresAt.toISOString() : '期限为永久') + '。'
      }
      await queueGovernanceMail(tx, {
        eventId: 'appeal:' + id,
        userId: row.subjectId,
        kind: 'appeal_result',
        result: results[status],
        reason: input.reason,
        measure,
      })
    }
    return { id, userId: row.subjectId, status }
  })
}
