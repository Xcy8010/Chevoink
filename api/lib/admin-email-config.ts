import { isGovernanceMailTemplateId } from '../../shared/contracts/governance-mail.js'
import { z } from 'zod'
import { env } from '../config/env.js'
import { ADMIN_EMAIL_BATCH_LIMIT } from '../../shared/contracts/admin-email.js'
import { mockAdminEmailDelivery } from './admin-email-provider.js'
import { createTencentAdminEmailDelivery } from './admin-email-tencent.js'
import { DataAccessError } from './prisma.js'

const settings = z.object({
  secretId: z.string().regex(/^[\w-]+$/),
  secretKey: z.string().trim().min(1),
  templateId: z.number().int().positive().safe().optional(),
  returnTemplateId: z.number().int().positive().safe().optional(),
  from: z.email(),
  replyTo: z.email(),
  recipientScope: z.enum(['allowlist', 'consented']),
  recipients: z.array(z.email().refine(email => !email.includes('*'))).max(ADMIN_EMAIL_BATCH_LIMIT),
})

export function configuredAdminEmailDelivery() {
  if (env.adminEmailMockEnabled) return mockAdminEmailDelivery
  if (!env.adminEmailTencentEnabled) throw new DataAccessError(503, 'ADMIN_EMAIL_DISABLED', '定向邮件功能尚未启用。')
  const invalid = () => new DataAccessError(503, 'ADMIN_EMAIL_SES_CONFIG_INVALID', '请核对定向邮件的发件地址、模板、凭据来源及允许的收件范围。')
  const credentialSource = env.adminEmailTencentCredentialSource
  if (credentialSource !== 'dedicated' && (credentialSource !== 'account-email' || env.appEnv !== 'production')) throw invalid()
  if (!!env.adminEmailTencentSecretId !== !!env.adminEmailTencentSecretKey) throw invalid()
  const useAccountEmail = credentialSource === 'account-email' && !env.adminEmailTencentSecretId
  const parsed = settings.safeParse({
    secretId: useAccountEmail ? env.emailTencentSecretId : env.adminEmailTencentSecretId,
    secretKey: useAccountEmail ? env.emailTencentSecretKey : env.adminEmailTencentSecretKey,
    templateId: env.adminEmailTencentTemplateId === 0 ? undefined : env.adminEmailTencentTemplateId,
    returnTemplateId: env.adminEmailTencentReturnTemplateId === 0 ? undefined : env.adminEmailTencentReturnTemplateId,
    from: env.adminEmailTencentFrom, replyTo: env.adminEmailTencentReplyTo,
    recipientScope: env.adminEmailTencentRecipientScope, recipients: env.adminEmailTencentRecipients,
  })
  if (!parsed.success || (parsed.data.recipientScope === 'consented' ? env.appEnv !== 'production' : !parsed.data.recipients.length)
    || parsed.data.templateId === parsed.data.returnTemplateId || parsed.data.from === env.emailTencentFromAddress?.toLowerCase()
    || [parsed.data.templateId, parsed.data.returnTemplateId].some(id => id && (id === env.emailTencentTemplateId || isGovernanceMailTemplateId(id)))
    || (!useAccountEmail && parsed.data.secretId === env.emailTencentSecretId)) {
    throw invalid()
  }
  const { recipients, recipientScope, ...config } = parsed.data
  const scope = recipientScope === 'consented' ? { recipientScope } as const : { allowedRecipients: new Set(recipients) }
  return createTencentAdminEmailDelivery({ ...config, ...scope, region: 'ap-hongkong' })
}
