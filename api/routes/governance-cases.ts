import { Router, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { updateCaseProgress, supplementCase } from '../lib/governance-case-progress.js'
import { governanceTargets, reportReasons, usageCategories } from '../../shared/contracts/governance-cases.js'
import { openUsageCase } from '../lib/governance-usage-cases.js'
import { createAuthCaptchaChallenge, verifyAuthCaptchaChallenge } from '../lib/auth-captcha.js'
import { getSessionUserId, evictUserBanCache } from '../lib/auth-session.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { requireAppReleaseCapability } from '../lib/app-releases.js'
import { DataAccessError, prisma } from '../lib/prisma.js'
import {
  caseListSelect,
  caseMissing,
  auditCase,
  createReport,
  privateDigest,
  reporterReceipt,
  reviewReport,
} from '../lib/governance-cases.js'
import {
  eligibleForAppealPortal,
  issueAppealProof,
  linkedSafetyEscalation,
  readAppeals,
  reviewAppeal,
  submitAppeal,
  verifyAppealProof,
} from '../lib/governance-appeals.js'
import {
  invalidAccountCode,
  prepareAccountEmailCode,
  sendAccountEmailCode,
} from '../lib/email-verification.js'
import { parseBody } from '../lib/parse-body.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { sendRouteError } from '../lib/route-error.js'
import { verifyPassword, hashPassword } from '../lib/password.js'
import { randomUUID } from 'node:crypto'
import { consumePasswordAttempt } from '../lib/password-attempts.js'

export const publicGovernanceRouter = Router(),
  adminGovernanceCaseRouter = Router()
function route(fn: (req: Request) => Promise<unknown> | unknown): RequestHandler {
  return async (req, res) => {
    const id = createRequestId()
    try {
      res.json(buildSuccess(id, await fn(req)))
    } catch (error) {
      sendRouteError(res, id, error)
    }
  }
}
const nonempty = z.string().trim().min(1)
const details = nonempty.max(4000)
const requestKey = z.string().uuid()
const captcha = z.object({ captchaId: z.string().uuid(), answer: nonempty.max(12) })
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase())
const appealUser = (req: Request) => verifyAppealProof(req.get('X-Appeal-Proof'))
const parse = <T extends z.ZodType>(schema: T, input: unknown) =>
  parseBody(schema, input, '请检查输入内容后重试。')
const future = z
  .string()
  .datetime()
  .transform((v) => new Date(v))
  .refine((v) => v > new Date())
publicGovernanceRouter.get(
  '/captcha',
  route(() => createAuthCaptchaChallenge()),
)
publicGovernanceRouter.post(
  '/reports',
  route(async (req) => {
    await requireAppReleaseCapability(req, 'platformGovernance')
    const input = parse(
      z.object({
        requestKey,
        targetKind: z.enum(governanceTargets),
        targetId: nonempty.max(128),
        category: z.enum(
          Object.keys(reportReasons) as [keyof typeof reportReasons, ...(keyof typeof reportReasons)[]],
        ),
        statement: z.string().trim().max(4000).default(''),
      }),
      req.body,
    )
    return createReport(getSessionUserId(req), req.ip ?? 'unknown', input)
  }),
)
publicGovernanceRouter.post(
  '/receipt',
  route(async (req) => {
    const { id, receipt } = parse(
      z.object({ id: nonempty.max(128), receipt: z.string().regex(/^[a-f0-9]{64}$/) }),
      req.body,
    )
    const item = await prisma.governanceCase.findFirst({
      where: { id, kind: 'report' },
      select: { id: true, status: true, requestKey: true, publicProgress: true, materialsAt: true },
    })
    if (!item || reporterReceipt(item).receipt !== receipt) throw caseMissing()
    return { ...reporterReceipt(item), needsMaterials: item.status === 'investigating' && !item.materialsAt }
  }),
)
publicGovernanceRouter.post(
  '/reports/:id/materials',
  route((req) => {
    const input = parse(
      z.object({ receipt: z.string().regex(/^[a-f0-9]{64}$/), statement: details }),
      req.body,
    )
    return supplementCase(req.params.id, { kind: 'report', receipt: input.receipt }, input.statement)
  }),
)
publicGovernanceRouter.post(
  '/appeal/:id/materials',
  route((req) =>
    supplementCase(
      req.params.id,
      { kind: 'appeal', userId: appealUser(req) },
      parse(z.object({ statement: details }), req.body).statement,
    ),
  ),
)
publicGovernanceRouter.post(
  '/appeal/code',
  route(async (req) => {
    if (process.env.GOVERNANCE_APPEAL_EMAIL_ENABLED !== 'true')
      throw new DataAccessError(503, 'EMAIL_DISABLED', '邮箱验证码暂未开放，请使用账号密码核验。')
    const input = parse(z.object({ email, challenge: captcha }), req.body)
    verifyAuthCaptchaChallenge(input.challenge.captchaId, input.challenge.answer)
    const owner = await prisma.user.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' }, emailVerifiedAt: { not: null } },
      select: { id: true },
    })
    return sendAccountEmailCode(
      { email: input.email, purpose: 'appeal', userId: owner?.id ?? null },
      req.ip ?? 'unknown',
      Boolean(owner && (await eligibleForAppealPortal(owner.id))),
    )
  }),
)
publicGovernanceRouter.post(
  '/appeal/verify-code',
  route(async (req) => {
    const input = parse(z.object({ email, code: z.string().regex(/^\d{6}$/) }), req.body)
    const owner = await prisma.user.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' }, emailVerifiedAt: { not: null } },
      select: { id: true },
    })
    if (!owner || !(await eligibleForAppealPortal(owner.id))) throw invalidAccountCode()
    const consume = await prepareAccountEmailCode(
      { email: input.email, purpose: 'appeal', userId: owner.id },
      input.code,
    )
    await prisma.$transaction(consume)
    return { proof: issueAppealProof(owner.id) }
  }),
)
const dummyHash = hashPassword(randomUUID())
publicGovernanceRouter.post(
  '/appeal/verify-password',
  route(async (req) => {
    const input = parse(
      z.object({ identity: nonempty.max(254), password: z.string().min(1).max(256) }),
      req.body,
    )
    if (
      !consumePasswordAttempt('appeal-ip:' + (req.ip ?? 'unknown')) ||
      !consumePasswordAttempt('appeal-identity:' + privateDigest(input.identity.toLowerCase()))
    )
      throw new DataAccessError(429, 'RATE_LIMITED', '密码尝试过于频繁，请稍后再试。')
    const owner = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: input.identity, mode: 'insensitive' } }, { phone: input.identity }] },
      select: { id: true, passwordHash: true, role: true },
    })
    const valid = verifyPassword(
      owner?.role === 'admin' ? input.password : input.password.trim(),
      owner?.passwordHash ?? dummyHash,
    )
    if (!valid || !owner || !(await eligibleForAppealPortal(owner.id)))
      throw new DataAccessError(401, 'INVALID_IDENTITY', '无法核验此账号的申诉身份。')
    return { proof: issueAppealProof(owner.id) }
  }),
)
publicGovernanceRouter.get(
  '/appeal',
  route((req) => readAppeals(appealUser(req))),
)
publicGovernanceRouter.post(
  '/appeal',
  route((req) =>
    submitAppeal(
      appealUser(req),
      parse(z.object({ requestKey, targetId: nonempty.max(128), statement: details }), req.body),
    ),
  ),
)
adminGovernanceCaseRouter.use(
  ['/cases', '/summary', '/reports', '/appeals', '/usage-cases'],
  async (req, res, next) => {
    try {
      res.locals.governanceAdmin = await requireAdmin(req)
      await requireAppReleaseCapability(req, 'platformGovernance')
      next()
    } catch (error) {
      sendRouteError(res, createRequestId(), error)
    }
  },
)
adminGovernanceCaseRouter.post(
  '/usage-cases',
  route((req) =>
    openUsageCase(
      req.res!.locals.governanceAdmin.id,
      parse(
        z.object({
          requestKey,
          userId: nonempty.max(64),
          category: z.enum(
            Object.keys(usageCategories) as [
              keyof typeof usageCategories,
              ...(keyof typeof usageCategories)[],
            ],
          ),
          risk: z.enum(['observe', 'review', 'urgent']),
          statement: details,
          evidence: z.array(nonempty.max(240)).min(1).max(5),
        }),
        req.body,
      ),
    ),
  ),
)
adminGovernanceCaseRouter.get(
  '/cases',
  route(async (req) => {
    const q = parse(
      z.object({
        kind: z.enum(['report', 'appeal', 'usage']).optional(),
        status: nonempty.max(32).optional(),
        target: nonempty.max(32).optional(),
        category: nonempty.max(32).optional(),
        userId: nonempty.max(128).optional(),
        before: z.string().datetime().optional(),
        after: z.string().datetime().optional(),
        cursor: nonempty.max(128).optional(),
      }),
      req.query,
    )
    const rows = await prisma.governanceCase.findMany({
      where: {
        kind: q.kind,
        status: q.status,
        targetKind: q.target,
        category: q.category,
        subjectId: q.userId,
        createdAt: { gte: q.after, lte: q.before },
      },
      select: caseListSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })
    return { items: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null }
  }),
)
adminGovernanceCaseRouter.get(
  '/summary',
  route(async () => {
    const now = new Date()
    const [pending, appeals, review, overdue] = await Promise.all([
      prisma.governanceCase.count({ where: { kind: 'report', status: 'pending' } }),
      prisma.governanceCase.count({ where: { kind: 'appeal', status: 'pending' } }),
      prisma.governanceCase.count({ where: { status: 'investigating' } }),
      prisma.governanceCase.count({
        where: {
          OR: [
            { status: 'pending', acknowledgeBy: { lt: now } },
            { status: 'investigating', feedbackBy: { lt: now } },
          ],
        },
      }),
    ])
    return { pending, appeals, review, overdue }
  }),
)
adminGovernanceCaseRouter.get(
  '/cases/:id',
  route(async (req) => {
    const actor = req.res!.locals.governanceAdmin
    return prisma.$transaction(async (tx) => {
      const row = await tx.governanceCase.findUnique({
        where: { id: req.params.id },
        select: {
          ...caseListSelect,
          snapshot: true,
          statement: true,
          subjectId: true,
          conclusion: true,
          relatedId: true,
          events: {
            where: { action: { not: 'view' } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, action: true, reason: true, result: true, createdAt: true },
          },
        },
      })
      if (!row) throw caseMissing()
      await auditCase(tx, actor.id, row.id, 'view')
      const escalation =
        row.kind === 'appeal' && row.subjectId
          ? await linkedSafetyEscalation(tx, row.subjectId, row.targetKind, row.targetId)
          : null
      const safetyEvents =
        escalation && row.subjectId
          ? await tx.agentSafetyEvent.findMany({
              where: { userId: row.subjectId, id: { in: escalation.eventIds }, status: 'confirmed' },
              select: { id: true, category: true },
              orderBy: { createdAt: 'asc' },
            })
          : []
      return { ...row, safetyEvents }
    })
  }),
)
adminGovernanceCaseRouter.post(
  '/cases/:id/progress',
  route((req) => {
    const input = parse(
      z.object({
        action: z.enum(['request_materials', 'extend']),
        reason: details,
        until: future.optional(),
      }),
      req.body,
    )
    return updateCaseProgress(
      req.params.id,
      req.res!.locals.governanceAdmin.id,
      input.action,
      input.reason,
      input.until,
    )
  }),
)
adminGovernanceCaseRouter.post(
  '/reports/:id',
  route((req) => {
    const input = parse(
      z.object({
        status: z.enum(['investigating', 'upheld', 'dismissed', 'linked']),
        reason: details,
        relatedId: nonempty.max(128).optional(),
        retainUntil: future.optional(),
      }),
      req.body,
    )
    return reviewReport(req.params.id, req.res!.locals.governanceAdmin.id, input)
  }),
)
adminGovernanceCaseRouter.post(
  '/appeals/:id',
  route(async (req) => {
    const input = parse(
      z.object({
        status: z.enum(['investigating', 'maintained', 'adjusted', 'lifted', 'corrected']),
        reason: details,
        expiresAt: future.optional(),
        retainUntil: future.optional(),
        invalidEventIds: z.array(nonempty.max(128)).max(50).optional(),
      }),
      req.body,
    )
    const result = await reviewAppeal(req.res!.locals.governanceAdmin.id, req.params.id, input)
    evictUserBanCache(result.userId)
    return result
  }),
)
