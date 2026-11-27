import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { restrictionLabels, type changeRestrictionSchema, type issueRestrictionsSchema } from '../../shared/contracts/governance-restrictions.js'
import { stopAccountCoverRequests } from './governance-cover-requests.js'
import { activeAgentRestriction } from './governance-access.js'
import { DataAccessError, prisma } from './prisma.js'
import { queueGovernanceMail } from './governance-mail.js'
import { env } from '../config/env.js'
import { hasPlatformGovernanceCapability } from './app-releases.js'

type Tx = Prisma.TransactionClient
export async function governanceAvailableFor(userId: string, tx: Tx = prisma) {
  return await hasPlatformGovernanceCapability(userId, tx) ?? env.appEnv !== 'production'
}

export async function lockGovernanceAccount(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`
}

export async function holdRestrictedAgentWork(tx: Tx, userId: string) {
  await tx.agentQueuedRequest.updateMany({ where: { userId, status: 'pending' }, data: { status: 'held', revision: { increment: 1 }, error: '账号受到使用限制，需求已保留。' } })
  await tx.agentSchedule.updateMany({ where: { userId, status: 'active' }, data: { status: 'paused' } })
}

function deadline(value: string | null | undefined) {
  if (value == null) return null
  const date = new Date(value)
  if (!(date.getTime() > Date.now())) throw new DataAccessError(400, 'INVALID_DEADLINE', '截止时间必须晚于现在。')
  return date
}
export async function issueRestrictions(tx: Tx, actorId: string, input: z.infer<typeof issueRestrictionsSchema>) {
  const { userId, reason, clause, sourceId } = input
  await lockGovernanceAccount(tx, userId)
  const scopes = [...new Set(input.scopes)].sort()
  const operationKey = input.operationId ? 'limit-' + input.operationId : null
  const signature = createHash('sha256').update(JSON.stringify([actorId, userId, scopes, reason, clause, input.expiresAt, sourceId ?? null])).digest('hex')
  if (operationKey) {
    const prior = await tx.adminAuditLog.findUnique({ where: { id: operationKey } })
    if (prior) {
      const data = prior.detail as { signature?:string; ids?:string[] }
      if (prior.adminId !== actorId || prior.targetId !== userId || data.signature !== signature || !data.ids?.length) throw new DataAccessError(409,'OPERATION_CONFLICT','操作编号已关联其他处置。')
      return tx.accountRestriction.findMany({where:{userId,id:{in:data.ids}}})
    }
  }
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true, isSuperAdmin: true } })
  if (!user) throw new DataAccessError(404, 'USER_NOT_FOUND', '用户不存在。')
  if (userId === actorId || user.isSuperAdmin || user.role === 'admin') throw new DataAccessError(403, 'PROTECTED_ACCOUNT', '无法通过此入口限制管理员账号。')
  if (!await governanceAvailableFor(userId, tx)) throw new DataAccessError(403, 'APP_RELEASE_CAPABILITY_DISABLED', '该账号当前版本未开放治理测试。')
  const expiresAt = deadline(input.expiresAt)
  const rows = []
  for (const scope of scopes) {
    const row = await tx.accountRestriction.create({ data: { userId, scope, reason, clause, sourceId, expiresAt } })
    await tx.adminAuditLog.create({ data: { adminId: actorId, action: 'governance.restriction.issue', targetType: 'restriction', targetId: row.id,
      detail: { userId, scope, reason, clause, sourceId: sourceId ?? null, expiresAt: input.expiresAt } } })
    rows.push(row)
  }
  if (scopes.includes('platform')) await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } })
  if (scopes.includes('platform') || scopes.includes('agent')) {
    await holdRestrictedAgentWork(tx, userId)
  }
  const measure = scopes.map(s => restrictionLabels[s]).join('、') + '；' + (expiresAt ? '截至 ' + expiresAt.toISOString() : '永久')
  await tx.userNotification.create({ data: { userId, title: '账号使用限制通知', body: reason + '。限制范围：' + measure + '。依据：' + clause + '。如有异议，可前往 /appeal。' } })
  await queueGovernanceMail(tx, { eventId: rows[0].id, userId, kind: 'enforcement', reason, measure })
  if (operationKey) await tx.adminAuditLog.create({data:{id:operationKey,adminId:actorId,action:'governance.restriction.receipt',targetType:'user',targetId:userId,detail:{signature,ids:rows.map(row=>row.id)}}})
  return rows
}

export async function changeRestriction(tx: Tx, actorId: string, id: string, input: z.infer<typeof changeRestrictionSchema>, expectedUserId?: string) {
  const where = { id, ...(expectedUserId ? { userId: expectedUserId } : {}) }
  const identity = await tx.accountRestriction.findFirst({ where, select: { userId: true } })
  if (!identity) throw new DataAccessError(404, 'RESTRICTION_NOT_FOUND', '未找到该限制。')
  await lockGovernanceAccount(tx, identity.userId)
  const row = await tx.accountRestriction.findFirstOrThrow({ where })
  const target = await tx.user.findUniqueOrThrow({where:{id:row.userId},select:{role:true,isSuperAdmin:true}})
  if (actorId === row.userId || target.isSuperAdmin || target.role === 'admin') throw new DataAccessError(403,'PROTECTED_ACCOUNT','无法通过此入口处置管理员账号。')
  const reviewedLegacyAppeal = expectedUserId === row.userId && row.legacyBan && row.sourceId === 'legacy-admin' &&
    (input.action === 'revoke' || (input.action === 'adjust' && !row.expiresAt && Boolean(input.expiresAt)))
  if (!reviewedLegacyAppeal && (row.legacyBan || input.action !== 'revoke') && !await governanceAvailableFor(row.userId,tx)) throw new DataAccessError(403,'APP_RELEASE_CAPABILITY_DISABLED','目标账号当前版本未开放治理处置。')
  const now = new Date()
  if (row.revokedAt || (input.action !== 'revoke' && row.expiresAt && row.expiresAt <= now)) throw new DataAccessError(409, 'RESTRICTION_CLOSED', '该限制已结束。')
  const expiry = input.action === 'revoke' ? row.expiresAt : deadline(input.expiresAt)
  if (input.action === 'extend' && (!row.expiresAt || (expiry && expiry <= row.expiresAt))) throw new DataAccessError(400, 'INVALID_EXTENSION', '请选择晚于原期限的截止时间。')
  const changed = await tx.accountRestriction.update({ where: { id }, data: { ...(row.legacyBan ? { legacyBan: false } : {}), expiresAt: expiry, revokedAt: input.action === 'revoke' ? now : null } })
  if (row.legacyBan) await tx.user.update({ where: { id: row.userId }, data: { bannedAt: null, tokenVersion: { increment: 1 } } })
  await tx.adminAuditLog.create({ data: { adminId: actorId, action: 'governance.restriction.' + input.action, targetType: 'restriction', targetId: id,
    detail: { userId: row.userId, scope: row.scope, before: row.expiresAt?.toISOString() ?? null, after: expiry?.toISOString() ?? null, revokedAt: changed.revokedAt?.toISOString() ?? null, reason: input.reason } } })
  await tx.userNotification.create({ data: { userId: row.userId, title: input.action === 'revoke' ? '账号限制已撤销' : '账号限制期限已调整', body: input.reason } })
  return changed
}

export async function stopRestrictedAgentWork(userId: string) {
  const { stopActiveRunsByUser } = await import('./agent/active-runs.js')
  const restricted = await prisma.user.findFirst({ where: { id:userId, accountRestrictions:{some:activeAgentRestriction(new Date())} }, select:{id:true} })
  if (!restricted) return
  stopActiveRunsByUser(userId)
  stopAccountCoverRequests(userId)
  const { stopLoopRun } = await import('./agent/run-service.js')
  const runs = await prisma.agentRun.findMany({ where: { userId, engine: 'loop', status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })
  for (const run of runs) await stopLoopRun(userId, run.id)
}

export async function reconcileRestrictedAgentWork() {
  const candidates = await prisma.agentRun.findMany({ where: { engine:'loop', status:{in:['queued','running','awaiting_approval']},
    user:{accountRestrictions:{some:activeAgentRestriction(new Date())}} },
    distinct:['userId'], take:32, select:{userId:true} })
  for (const row of candidates) await stopRestrictedAgentWork(row.userId)
}
