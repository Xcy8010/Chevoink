import type { Prisma } from '@prisma/client'
import type { RestrictionScope } from '../../shared/contracts/governance-restrictions.js'
import { DataAccessError, prisma } from './prisma.js'

export const effectiveRestrictionWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] })

export const activeAgentRestriction = (now: Date) => ({ legacyBan: false, scope: { in: ['platform','agent'] }, ...effectiveRestrictionWhere(now) })

export async function assertGovernanceAllowed(userId: string, scope: RestrictionScope, tx: Prisma.TransactionClient = prisma) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: {
    accountRestrictions: { where: { legacyBan:false, scope: { in: ['platform', scope] }, ...effectiveRestrictionWhere(new Date()) }, take: 1, select: { id: true } } } })
  if (user?.accountRestrictions?.length) {
    throw new DataAccessError(403, 'ACCOUNT_FEATURE_RESTRICTED', '当前账号受到使用限制，请查看处置通知或前往申诉。')
  }
}
