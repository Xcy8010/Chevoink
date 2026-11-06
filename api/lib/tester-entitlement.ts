import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type CreditAccount } from '@prisma/client'
import { prisma, DataAccessError } from './prisma.js'
import type { UserIdentityUpdate, TesterIdentity, UserIdentityUpdateResult } from '../../shared/contracts/tester.js'
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
export function presentTesterIdentity(user: { role: string; isSuperAdmin: boolean; bannedAt: Date | null; testerEntitlement: { enabled: boolean; revision: number; expiresAt: Date | null; reason: string } | null }, now = new Date()): TesterIdentity {
  const grant = user.testerEntitlement
  return { enabled: grant?.enabled ?? false, effective: !user.bannedAt && (user.role === 'admin' && user.isSuperAdmin || Boolean(grant?.enabled && (!grant.expiresAt || grant.expiresAt > now))),
    revision: grant?.revision ?? 0, expiresAt: grant?.expiresAt?.toISOString() ?? null, reason: grant?.reason ?? null }
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
    if (!actor || actor.role !== 'admin' || actor.bannedAt) throw new DataAccessError(403, 'ADMIN_REQUIRED', '该操作仅限管理员。')
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

/** Identity changes and their replay/audit receipt commit together; no partial role/grant save. */
export async function updateUserIdentity(actorId: string, userId: string, input: UserIdentityUpdate, ip: string | null): Promise<UserIdentityUpdateResult> {
  const requestHash = createHash('sha256').update(JSON.stringify({ userId, ...input })).digest('hex')
  const auditId = createHash('sha256').update('user-identity:' + actorId + ':' + input.operationId).digest('hex')
  return creditTransaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, isSuperAdmin: true, bannedAt: true } })
    if (!actor || actor.role !== 'admin' || actor.bannedAt) throw new DataAccessError(403, 'ADMIN_REQUIRED', '该操作仅限管理员。')
    if (input.role !== undefined && !actor.isSuperAdmin) throw new DataAccessError(403, 'SUPER_REQUIRED', '仅超级管理可以设置用户身份。')
    const replay = await tx.adminAuditLog.findUnique({ where: { id: auditId } })
    if (replay) {
      const detail = replay.detail as Prisma.JsonObject
      if (detail.requestHash !== requestHash) throw new DataAccessError(409, 'USER_IDENTITY_OPERATION_CONFLICT', '同一请求编号的目标或内容已改变。')
      return { ...(detail.result as unknown as Omit<UserIdentityUpdateResult, 'replayed'>), replayed: true }
    }
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isSuperAdmin: true, bannedAt: true, testerEntitlement: true } })
    if (!user) throw new DataAccessError(404, 'USER_NOT_FOUND', '用户不存在。')
    if (input.role !== undefined) {
      if (actorId === userId) throw new DataAccessError(400, 'VALIDATION_ERROR', '不能修改当前登录管理员自己的角色。')
      if (user.isSuperAdmin) throw new DataAccessError(400, 'VALIDATION_ERROR', '超级管理身份唯一，不可修改。')
      if (user.role !== input.expectedRole) throw new DataAccessError(409, 'USER_IDENTITY_CONFLICT', '用户身份已变化，请刷新后核对。')
    }
    const old = user.testerEntitlement
    if (input.tester) {
      if (user.role === 'admin' && user.isSuperAdmin && !input.tester.enabled) throw new DataAccessError(409, 'SUPER_ADMIN_TESTER_REQUIRED', '超级管理员默认具备测试员资格。')
      if ((old?.revision ?? 0) !== input.tester.expectedRevision) throw new DataAccessError(409, 'TESTER_REVISION_CONFLICT', '测试员资格已变化，请刷新后核对。')
      if (input.tester.expiresAt && Date.parse(input.tester.expiresAt) <= Date.now()) throw new DataAccessError(400, 'TESTER_EXPIRY_INVALID', '有效期须晚于当前时间。')
    }
    const role = input.role ?? user.role
    if (input.role !== undefined) await tx.user.update({ where: { id: userId }, data: { role: input.role } })
    const grant = input.tester ? await tx.testerEntitlement.upsert({ where: { userId },
      create: { userId, enabled: input.tester.enabled, reason: input.tester.reason, expiresAt: input.tester.expiresAt ? new Date(input.tester.expiresAt) : null, grantedById: actorId },
      update: { enabled: input.tester.enabled, reason: input.tester.reason, expiresAt: input.tester.expiresAt ? new Date(input.tester.expiresAt) : null, grantedById: actorId, revision: { increment: 1 } } }) : old
    const result = { role, tester: presentTesterIdentity({ ...user, role, testerEntitlement: grant }) }
    await tx.adminAuditLog.create({ data: { id: auditId, adminId: actorId, action: 'user.set_identity', targetType: 'user', targetId: userId, ip,
      detail: { requestHash, previousRole: user.role, previousTesterRevision: old?.revision ?? 0, result } } })
    return { ...result, replayed: false }
  })
}
