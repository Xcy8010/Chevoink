import { isGovernanceMailTemplateId } from '../../shared/contracts/governance-mail.js'
import { DataAccessError } from './prisma.js'
import type { ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, AdminCustomEmailTemplate, AdminEmailCampaign, AdminEmailMode } from '../../shared/contracts/admin-email.js'
import { mockEmailTemplate, returnEmailTemplate, customEmailTemplate, type AdminEmailTemplateSnapshot } from './admin-email-template.js'

export type AdminEmailSuppression = 'unsubscribed' | 'hard_bounce' | 'complained'

export type AdminEmailSendResult =
  | { state: 'accepted'; requestId: string; messageId: string }
  | { state: 'rejected'; requestId?: string; reason: string; suppression?: AdminEmailSuppression }
  | { state: 'unknown'; requestId?: string; reason: string }

export type AdminEmailStatusResult = {
  state: 'accepted' | 'deferred' | 'delivered' | 'rejected' | 'bounced'
  reason?: string
  suppression?: AdminEmailSuppression
}

export type AdminEmailProvider = {
  send(message: {
    attemptId: string
    to: string
    providerTemplateId: number | null
    from: string
    replyTo: string
    subject: string
    variables: Record<string, string>
  }): Promise<AdminEmailSendResult>
  status(message: { messageId: string; to: string; from: string; attemptedAt: Date; now: Date }): Promise<AdminEmailStatusResult>
}

export type AdminEmailDelivery = {
  mode: AdminEmailMode
  provider: AdminEmailProvider
  loadTemplate: (campaign?: AdminEmailCampaign, customTemplate?: AdminCustomEmailTemplate) => Promise<AdminEmailTemplateSnapshot>
  allowedRecipients?: ReadonlySet<string>
  tencentPurposes?: Array<typeof ADMIN_EMAIL_PURPOSE | typeof ADMIN_RETURN_EMAIL_PURPOSE>
}

/** The mock is deterministic and never reads secrets or uses an external service. */
export const mockAdminEmailProvider: AdminEmailProvider = {
  async send({ attemptId, to }) {
    const requestId = `mock-request-${attemptId}`
    if (to === 'mock-rejected@chevoink.invalid') return { state: 'rejected', requestId, reason: 'provider_rejected' }
    if (to === 'mock-unknown@chevoink.invalid') return { state: 'unknown', reason: 'provider_unknown' }
    return { state: 'accepted', requestId, messageId: `mock-message-${attemptId}` }
  },
  async status({ to, attemptedAt, now }) {
    switch (to) {
      case 'mock-deferred@chevoink.invalid':
        return { state: now.getTime() - attemptedAt.getTime() < 30_000 ? 'deferred' : 'delivered' }
      case 'mock-bounce@chevoink.invalid':
        return { state: 'bounced', reason: 'hard_bounce', suppression: 'hard_bounce' }
      case 'mock-unsubscribe@chevoink.invalid':
        return now.getTime() - attemptedAt.getTime() < 15_000
          ? { state: 'delivered' } : { state: 'delivered', reason: 'unsubscribed', suppression: 'unsubscribed' }
      case 'mock-complaint@chevoink.invalid':
        return now.getTime() - attemptedAt.getTime() < 15_000
          ? { state: 'delivered' } : { state: 'delivered', reason: 'complained', suppression: 'complained' }
      default:
        return { state: 'delivered' }
    }
  },
}

export const mockAdminEmailDelivery: AdminEmailDelivery = {
  mode: 'mock',
  provider: mockAdminEmailProvider,
  loadTemplate: async (campaign, custom) => {
    if (isGovernanceMailTemplateId(custom?.id)) throw new DataAccessError(409, 'ADMIN_EMAIL_TEMPLATE_UNAVAILABLE', '该模板专用于治理事务通知。')
    return custom ? customEmailTemplate(custom) : campaign ? returnEmailTemplate(campaign) : mockEmailTemplate
  },
}
