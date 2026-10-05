import { Prisma } from '@prisma/client'
import { DataAccessError, prisma } from './prisma.js'

/** Must run on the caller's actual transaction connection, held until commit. */
export async function lockCreditPolicy(tx: Prisma.TransactionClient) {
  if ('$transaction' in tx) throw new Error('Credit policy requires a transaction connection')
  const lock = async () => {
    try { return await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM credit_system_settings WHERE id = 'global' FOR SHARE` }
    catch (error) {
      // Prisma exposes raw PostgreSQL serialization failures as P2010. Abort
      // this transaction; the caller's existing whole-TX retry handles P2034.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010'
        && (error.meta?.code === '40001' || error.meta?.code === '40P01')) {
        throw new Prisma.PrismaClientKnownRequestError('Credit policy transaction conflicted', { code: 'P2034', clientVersion: error.clientVersion })
      }
      throw error
    }
  }
  let rows = await lock()
  if (!rows.length) {
    await tx.creditSystemSetting.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} })
    rows = await lock()
  }
  if (!rows.length) throw new Error('Credit policy singleton unavailable')
  return tx.creditSystemSetting.findUniqueOrThrow({ where: { id: 'global' } })
}

export async function creditTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }) }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue
      throw error
    }
  }
  throw new DataAccessError(409, 'CREDIT_CONCURRENCY_CONFLICT', '额度更新冲突，请重试。')
}

export async function setPublicBetaEnabled(adminId: string, enabled: boolean, expectedRevision: number, ip?: string | null) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DataAccessError(400, 'VALIDATION_ERROR', '公测版本无效。')
  return creditTransaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, isSuperAdmin: true, bannedAt: true } })
    if (!actor || actor.role !== 'admin' || !actor.isSuperAdmin || actor.bannedAt) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '该操作仅限超级管理员。')
    // UPDATE acquires the exclusive row lock; a stale snapshot aborts the whole TX.
    const changed = await tx.creditSystemSetting.updateMany({ where: { id: 'global', publicBetaRevision: expectedRevision, publicBetaEnabled: !enabled },
      data: { publicBetaEnabled: enabled, publicBetaRevision: { increment: 1 } } })
    if (changed.count !== 1) throw new DataAccessError(409, 'PUBLIC_BETA_CONFLICT', '公测状态已变化，请刷新后重试。')
    const setting = await tx.creditSystemSetting.findUniqueOrThrow({ where: { id: 'global' } })
    await tx.adminAuditLog.create({ data: { adminId, action: enabled ? 'credits.resume_beta' : 'credits.stop_beta', targetType: 'creditSystem', targetId: 'global',
      ip, detail: { publicBetaEnabled: enabled, previousRevision: expectedRevision, publicBetaRevision: setting.publicBetaRevision } } })
    return { publicBetaEnabled: setting.publicBetaEnabled, publicBetaRevision: setting.publicBetaRevision }
  })
}

export async function getPublicCreditPolicy(): Promise<import('../../shared/contracts/credits.js').PublicCreditPolicy> {
  const setting = await prisma.creditSystemSetting.findUnique({ where: { id: 'global' }, select: { publicBetaEnabled: true, publicBetaRevision: true } })
  const publicBetaEnabled = setting?.publicBetaEnabled ?? true
  return { publicBetaEnabled, publicBetaRevision: setting?.publicBetaRevision ?? 0, plan: publicBetaEnabled ? 'public_beta' : 'free', planLabel: publicBetaEnabled ? '公测版' : '免费版' }
}
