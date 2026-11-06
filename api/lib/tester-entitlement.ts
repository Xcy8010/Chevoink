import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type CreditAccount } from '@prisma/client'
import { prisma, DataAccessError } from './prisma.js'
import { creditTransaction } from './credit-policy.js'

export const TESTER_CREDIT_RULE = { version: 'tester-floor-20-target-450-v1', thresholdMilli: 20000, targetMilli: 450000, balanceBasis: 'ledger' } as const
const effectiveWhere = (now: Date): Prisma.UserWhereInput => ({ bannedAt: null, OR: [{ role: 'admin', isSuperAdmin: true }, { testerEntitlement: { is: { enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } } }] })
export async function isEffectiveTester(db: Prisma.TransactionClient, userId: string, now = new Date()): Promise<boolean> {
  return Boolean(await db.user.findFirst({ where: { id: userId, ...effectiveWhere(now) }, select: { id: true } }))
}
export async function effectiveTesterIds(db: Prisma.TransactionClient, now = new Date()): Promise<Set<string>> {
  return new Set((await db.user.findMany({ where: effectiveWhere(now), select: { id: true } })).map(user => user.id))
}
export function testerTopupDelta(balanceMilli: number): number {
  if (!Number.isSafeInteger(balanceMilli) || balanceMilli < 0) throw new DataAccessError(409, 'CREDIT_BALANCE_INVALID', '额度余额需要核对。')
  return balanceMilli < TESTER_CREDIT_RULE.thresholdMilli ? TESTER_CREDIT_RULE.targetMilli - balanceMilli : 0
}
/** Caller owns one Serializable wallet transaction. Reservations are not consumption. */
export async function applyTesterCreditFloor(tx: Prisma.TransactionClient, account: CreditAccount, trigger: string): Promise<CreditAccount> {
  if (!await isEffectiveTester(tx, account.userId)) return account
  const balance = Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + Math.max(0, account.bonusBalanceMilli)
  const delta = testerTopupDelta(balance)
  if (!delta) return account
  const sequence = account.testerTopupSequence + 1
  const key = 'tester-topup:' + account.userId + ':' + sequence
  const updated = await tx.creditAccount.update({ where: { userId: account.userId }, data: { bonusBalanceMilli: { increment: delta }, testerTopupSequence: { increment: 1 } } })
  await tx.creditLedgerEntry.create({ data: { id: randomUUID(), userId: account.userId, deltaMilli: delta, dailyDeltaMilli: 0, bonusDeltaMilli: delta,
    kind: 'tester_topup', sourceType: 'tester_auto_topup', idempotencyKey: key,
    metadata: { ruleVersion: TESTER_CREDIT_RULE.version, reason: '测试员自动补额', trigger, balanceBasis: TESTER_CREDIT_RULE.balanceBasis,
      beforeBalanceMilli: balance, afterBalanceMilli: balance + delta, thresholdMilli: TESTER_CREDIT_RULE.thresholdMilli, targetMilli: TESTER_CREDIT_RULE.targetMilli, sequence } } })
  return updated
}
export async function listTesters(search = '', page = 1) {
  const now = new Date(), keyword = search.trim()
  const where: Prisma.UserWhereInput = keyword ? { OR: [{ id: keyword }, { nickname: { contains: keyword, mode: 'insensitive' } }, { email: { contains: keyword, mode: 'insensitive' } }, { phone: { contains: keyword } }] } : {}
  const [total, users] = await Promise.all([prisma.user.count({ where }), prisma.user.findMany({ where, skip: (page - 1) * 30, take: 30, orderBy: { id: 'asc' },
    select: { id: true, nickname: true, role: true, bannedAt: true, isSuperAdmin: true, testerEntitlement: true } })])
  return { total, page, pageSize: 30, rule: TESTER_CREDIT_RULE, users: users.map(user => ({ id: user.id, nickname: user.nickname, revision: user.testerEntitlement?.revision ?? 0,
    effectiveTester: !user.bannedAt && (user.role === 'admin' && user.isSuperAdmin || Boolean(user.testerEntitlement?.enabled && (!user.testerEntitlement.expiresAt || user.testerEntitlement.expiresAt > now))),
    qualification: user.role === 'admin' && user.isSuperAdmin ? 'super_admin' : user.testerEntitlement?.enabled ? 'grant' : 'none',
    enabled: user.testerEntitlement?.enabled ?? false, expiresAt: user.testerEntitlement?.expiresAt?.toISOString() ?? null, reason: user.testerEntitlement?.reason ?? null })) }
}
export type TesterUpdate = { enabled: boolean; reason: string; expiresAt: string | null; expectedRevision: number; operationId: string }
export async function updateTester(actorId: string, userId: string, input: TesterUpdate, ip: string | null) {
  const requestHash = createHash('sha256').update(JSON.stringify({ userId, ...input })).digest('hex')
  const auditId = createHash('sha256').update('tester:' + actorId + ':' + input.operationId).digest('hex')
  return creditTransaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, isSuperAdmin: true, bannedAt: true } })
    if (!actor || actor.role !== 'admin' || !actor.isSuperAdmin || actor.bannedAt) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '该操作仅限超级管理员。')
    const replay = await tx.adminAuditLog.findUnique({ where: { id: auditId } })
    if (replay) {
      const detail = replay.detail as Prisma.JsonObject
      if (detail.requestHash !== requestHash) throw new DataAccessError(409, 'TESTER_OPERATION_CONFLICT', '同一请求编号的目标或内容已改变。')
      return { revision: Number(detail.revision), replayed: true }
    }
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isSuperAdmin: true } })
    if (!user) throw new DataAccessError(404, 'USER_NOT_FOUND', '用户不存在。')
    if (user.role === 'admin' && user.isSuperAdmin && !input.enabled) throw new DataAccessError(409, 'SUPER_ADMIN_TESTER_REQUIRED', '超级管理员默认具备测试员资格。')
    const old = await tx.testerEntitlement.findUnique({ where: { userId } })
    if ((old?.revision ?? 0) !== input.expectedRevision) throw new DataAccessError(409, 'TESTER_REVISION_CONFLICT', '测试员资格已变化，请刷新后核对。')
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw new DataAccessError(400, 'TESTER_EXPIRY_INVALID', '有效期须晚于当前时间。')
    const revision = (old?.revision ?? 0) + 1
    await tx.testerEntitlement.upsert({ where: { userId }, create: { userId, enabled: input.enabled, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, grantedById: actorId },
      update: { enabled: input.enabled, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, grantedById: actorId, revision } })
    await tx.adminAuditLog.create({ data: { id: auditId, adminId: actorId, action: input.enabled ? 'tester.grant' : 'tester.revoke', targetType: 'user', targetId: userId, ip,
      detail: { requestHash, revision, enabled: input.enabled, reason: input.reason, expiresAt: input.expiresAt, previousRevision: old?.revision ?? 0 } } })
    return { revision, replayed: false }
  })
}
