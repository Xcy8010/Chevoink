import { ADMIN_RETURN_EMAIL_PURPOSE } from '../../shared/contracts/admin-email.js'
import { normalizedEmail } from './admin-email-audience.js'
import { DataAccessError, prisma } from './prisma.js'

export async function getReturnEmailPreference(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } })
  const email = normalizedEmail(user.email)
  if (!email || !user.emailVerifiedAt) return { available: false, subscribed: false }
  const permission = await prisma.adminEmailPermission.findUnique({
    where: { purpose_email: { purpose: ADMIN_RETURN_EMAIL_PURPOSE, email } }, select: { suppression: true },
  })
  const suppression = permission?.suppression
  return {
    available: suppression !== 'hard_bounce' && suppression !== 'complained',
    subscribed: !suppression,
  }
}

export async function setReturnEmailPreference(userId: string, subscribed: boolean) {
  return prisma.$transaction(async tx => {
    // Serialize an opt-in decision with account address changes and queue admission.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } })
    const email = normalizedEmail(user.email)
    if (!email || !user.emailVerifiedAt) throw new DataAccessError(409, 'VERIFIED_EMAIL_REQUIRED', '验证邮箱后才能管理创作活动邮件。')
    const purpose = ADMIN_RETURN_EMAIL_PURPOSE
    const now = new Date()
    const suppression = subscribed ? null : 'unsubscribed'
    // The statement locks the permission row and never clears a provider
    // complaint or hard bounce, including when one arrives concurrently.
    const changed = await tx.$executeRaw`
      INSERT INTO admin_email_permissions (purpose, email, user_id, consented_at, source, suppression, updated_at)
      VALUES (${purpose}, ${email}, ${userId}, ${subscribed ? now : null}, 'account-preferences',
        CAST(${suppression} AS "AdminEmailSuppression"), ${now})
      ON CONFLICT (purpose, email) DO UPDATE SET user_id = EXCLUDED.user_id, consented_at = EXCLUDED.consented_at,
        source = EXCLUDED.source, suppression = EXCLUDED.suppression, updated_at = EXCLUDED.updated_at
      WHERE admin_email_permissions.suppression IS NULL OR admin_email_permissions.suppression = 'unsubscribed'
    `
    if (!changed && subscribed) throw new DataAccessError(409, 'EMAIL_DELIVERY_BLOCKED', '该邮箱此前退信或投诉，暂时无法订阅。')
    return { available: !!changed, subscribed: !!changed && subscribed }
  })
}
