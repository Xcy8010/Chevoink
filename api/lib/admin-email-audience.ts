import { createHash, createHmac } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, type AdminEmailCandidate, type AdminEmailExclusion, type AdminEmailSelection } from '../../shared/contracts/admin-email.js'
import { effectiveTesterWhere } from './tester-entitlement.js'

const day = 24 * 60 * 60 * 1000
export const EMAIL_CANDIDATE_LIMIT = 10_000

export const emailCandidateSelect = {
  id: true, nickname: true, email: true, emailVerifiedAt: true, bannedAt: true, lastActiveAt: true,
} satisfies Prisma.UserSelect
export type EmailCandidate = Prisma.UserGetPayload<{ select: typeof emailCandidateSelect }>
type EmailPermission = {
  userId: string | null
  email: string
  consentedAt: Date | null
  source: string | null
  suppression: 'unsubscribed' | 'hard_bounce' | 'complained' | null
}

export function emailCandidateWhere(selection: AdminEmailSelection, now: Date): Prisma.UserWhereInput {
  if (selection.mode === 'manual') return { id: { in: selection.userIds } }
  if (selection.mode === 'emails') return { email: { in: selection.emails, mode: 'insensitive' } }
  const { role, registeredSince, registeredBefore, activeWithinDays, inactiveForDays, tester } = selection.filters
  const inactiveCutoff = inactiveForDays ? new Date(now.getTime() - inactiveForDays * day) : undefined
  const eligibility = effectiveTesterWhere(now)
  return {
    role,
    createdAt: registeredSince || registeredBefore ? {
      gte: registeredSince ? new Date(`${registeredSince}T00:00:00+08:00`) : undefined,
      lt: registeredBefore ? new Date(new Date(`${registeredBefore}T00:00:00+08:00`).getTime() + day) : undefined,
    } : undefined,
    OR: inactiveCutoff ? [
      { lastActiveAt: { lte: inactiveCutoff } },
      { lastActiveAt: null, createdAt: { lte: inactiveCutoff } },
    ] : undefined,
    lastActiveAt: activeWithinDays ? { gte: new Date(now.getTime() - activeWithinDays * day) } : undefined,
    AND: tester === 'effective' ? [eligibility] : tester === 'other' ? [{ NOT: eligibility }] : undefined,
  }
}

export async function matchingEmailCandidates(db: Prisma.TransactionClient, selection: AdminEmailSelection, now: Date) {
  const where = emailCandidateWhere(selection, now)
  if (selection.mode === 'filter' || selection.mode === 'sample') {
    const { minCreations = 0, maxCreations } = selection.filters
    if (minCreations > 0 || maxCreations !== undefined) {
      // GroupBy omits accounts with zero runs. For a zero lower bound, exclude only above-maximum groups.
      const groups = await db.agentRun.groupBy({
        by: ['userId'],
        where: { user: where, status: 'completed', incomingChildGrant: null },
        having: { userId: { _count: minCreations ? { gte: minCreations, lte: maxCreations } : { gt: maxCreations } } },
      })
      const ids = groups.map(group => group.userId)
      where.id = minCreations > 0 ? { in: ids } : { notIn: ids }
    }
  }
  return db.user.findMany({ where, select: emailCandidateSelect, orderBy: { id: 'asc' }, take: EMAIL_CANDIDATE_LIMIT + 1 })
}

// This is a recipient key, never an account or entitlement.
export function customMockRecipientKey(email: string) {
  return 'mock-address:' + createHash('sha256').update(email).digest('hex').slice(0, 48)
}

export async function customMockAddressExclusion(db: Prisma.TransactionClient, email: string, purpose: string) {
  const [boundUser, permission] = await Promise.all([
    db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
    db.adminEmailPermission.findUnique({ where: { purpose_email: { purpose, email } }, select: { suppression: true } }),
  ])
  return boundUser ? 'email_changed' : permission?.suppression ?? null
}

export function normalizedEmail(value: string | null) {
  return value?.trim().toLowerCase() || null
}

export function maskedEmail(email: string | null) {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : '•••'
}

export async function permissionsFor(db: Prisma.TransactionClient, candidates: EmailCandidate[], purpose: string = ADMIN_EMAIL_PURPOSE) {
  const emails = [...new Set(candidates.flatMap(candidate => {
    const email = normalizedEmail(candidate.email)
    return email ? [email] : []
  }))]
  const permissions = await db.adminEmailPermission.findMany({
    where: { purpose, email: { in: emails } },
    select: { email: true, userId: true, consentedAt: true, source: true, suppression: true },
  })
  return new Map(permissions.map(permission => [permission.email, permission]))
}

export function excludeCandidate(
  candidate: EmailCandidate | undefined, permissions: Map<string, EmailPermission>, purpose: string,
): AdminEmailExclusion | null {
  if (!candidate) return 'missing_user'
  if (candidate.bannedAt) return 'banned'
  const email = normalizedEmail(candidate.email)
  if (!candidate.emailVerifiedAt || !email || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(email)) return 'unverified_email'
  const permission = permissions.get(email)
  if (permission?.suppression) return permission.suppression
  if (purpose === ADMIN_RETURN_EMAIL_PURPOSE) return null
  if (!permission?.consentedAt || !permission.source || permission.userId !== candidate.id || permission.consentedAt < candidate.emailVerifiedAt) {
    return 'no_permission'
  }
  return null
}

export function presentCandidate(
  candidate: EmailCandidate, permissions: Map<string, EmailPermission>, purpose: string,
): AdminEmailCandidate {
  return {
    id: candidate.id, nickname: candidate.nickname, maskedEmail: maskedEmail(normalizedEmail(candidate.email)),
    exclusion: excludeCandidate(candidate, permissions, purpose),
  }
}

export function sampleEmailCandidates<T extends Pick<EmailCandidate, 'id' | 'lastActiveAt'>>(
  candidates: T[], size: number, weighting: 'equal' | 'recent_activity', seed: string, now: Date,
) {
  const weightCounts: Record<number, number> = {}
  const picked = candidates.map(candidate => {
    const age = candidate.lastActiveAt ? Math.max(0, now.getTime() - candidate.lastActiveAt.getTime()) : Infinity
    const weight = weighting === 'equal' ? 1 : age <= 7 * day ? 3 : age <= 30 * day ? 2 : 1
    weightCounts[weight] = (weightCounts[weight] ?? 0) + 1
    const bits = createHmac('sha256', seed).update(candidate.id).digest().readUIntBE(0, 6)
    const uniform = (bits + 1) / (2 ** 48 + 1)
    return { candidate, weight, score: -Math.log(uniform) / weight }
  }).sort((a, b) => a.score - b.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, size)
  return { weightCounts, picked: picked.map(({ candidate, weight }) => ({ candidate, weight })) }
}
