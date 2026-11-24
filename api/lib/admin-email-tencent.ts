import { z } from 'zod'
import { createHash } from 'node:crypto'
import { parseHTML } from 'linkedom'
import { ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, ADMIN_EMAIL_TEMPLATE } from '../../shared/contracts/admin-email.js'
import type { AdminEmailDelivery } from './admin-email-provider.js'
import { returnEmailTemplate } from './admin-email-template.js'
import { DataAccessError } from './prisma.js'
import { requestTencentSes, TENCENT_SES_TIMEOUT_MS, type TencentSesCredentials } from './tencent-ses-client.js'

export type DirectedSesConfig = TencentSesCredentials & {
  templateId?: number
  returnTemplateId?: number
  from: string
  replyTo: string
} & ({ recipientScope?: 'allowlist'; allowedRecipients: ReadonlySet<string> } | { recipientScope: 'consented'; allowedRecipients?: never })

const providerId = z.string().regex(/^[\w-]{1,128}$/)
const messageId = z.string().regex(/^[!-~]{1,128}$/)
const apiReply = z.object({
  RequestId: providerId.optional(),
  MessageId: messageId.optional(),
  Error: z.object({ Code: z.string() }).optional(),
})
const templateReply = z.object({
  TemplateStatus: z.literal(0),
  TemplateContent: z.object({ Text: z.string().max(131_072).nullish(), Html: z.string().max(131_072).nullish() }),
})
const statusReply = z.object({
  EmailStatusList: z.array(z.object({
    MessageId: messageId,
    FromEmailAddress: z.string(),
    ToEmailAddress: z.string(),
    SendStatus: z.number().int(),
    DeliverStatus: z.number().int().optional(),
    DeliverMessage: z.string().optional(),
    UserUnsubscribed: z.boolean().optional(),
    UserComplained: z.boolean().optional(),
    UserComplainted: z.boolean().optional(),
  })),
})

const rejectedApiErrors = new Set([
  'OperationDenied', 'UnauthorizedOperation', 'MissingParameter', 'RequestLimitExceeded', 'LimitExceeded',
  'FailedOperation.EmailAddrInBlacklist', 'FailedOperation.ExceedSendLimit', 'FailedOperation.FrequencyLimit',
  'FailedOperation.IncorrectEmail', 'FailedOperation.IncorrectSender', 'FailedOperation.InsufficientBalance',
  'FailedOperation.InsufficientQuota', 'FailedOperation.InvalidTemplateID', 'FailedOperation.NotAuthenticatedSender',
  'FailedOperation.ReceiverHasUnsubscribed', 'FailedOperation.WrongContentJson', 'FailedOperation.WithOutPermission',
])
const rejectedSendStatuses = new Set([1006, 1007, 1008, 1010, 1011, 3007, 3008, 3009, 3010, 3014, 3020, 3024, 3030, 3033])
const statusUnavailable = () => new Error('Directed email SES status is not confirmed.')
const templateUnavailable = (changed = false) => new DataAccessError(
  changed ? 409 : 503, 'ADMIN_EMAIL_TEMPLATE_UNAVAILABLE', '无法核对已审核的定向邮件模板，请检查香港 SES 模板及其参数。',
)
const claimHref = 'https://chevoink.chevolink.com/{{workspace_path}}'
const returnVariable = /\{\{(?:max_credits|expires_at|workspace_path)\}\}/g
const returnMessage = z.object({
  max_credits: z.string().regex(/^[1-9]\d{0,6}$/), expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（北京时间）$/),
  workspace_path: z.string().regex(/^api\/credits\/return-reward\/open#[A-Za-z0-9_-]{43}$/),
}).strict()

function decodeTemplate(value: string | null | undefined) {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw templateUnavailable()
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw templateUnavailable()
  const body = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  if (!body.trim()) throw templateUnavailable()
  return body
}

// Reviewed copy from the approved 237702 submission. Ignore presentation and
// whitespace, but preserve every word, amount and deadline placeholder.
const approved237702TextHash = 'e455751f8c2fb0001e49b3bbfe7ffb78ee59960e61a097db566b052d851e2b1d'
// Tencent returns this review summary in Text alongside the approved HTML body.
const approved237702Summary = '邀请一段时间未使用创作功能的启创墨域用户回来与创作 Agent 小墨交流，并说明创作额度福利及适用条件。'

function checkReturnContent(content: string, html: boolean, templateId: number) {
  if (/\{\{|\}\}/.test(content.replace(returnVariable, ''))) throw templateUnavailable()
  const document = html ? parseHTML(content).document : null
  const visible = (document ? document.body.textContent ?? '' : content.split(claimHref).join('')).replace(/\s+/g, '')
  const showsClaimTerms = visible.includes('{{max_credits}}') && visible.includes('{{expires_at}}')
    && /(?:登录|点击|确认).{0,20}领取/.test(visible) && /(?:每个?账[号户]|每人).{0,8}(?:限领|限|领取)一次/.test(visible)
  const matchesOriginal = templateId === 237702 && createHash('sha256').update(visible).digest('hex') === approved237702TextHash
  if (!matchesOriginal && (!showsClaimTerms || /实际扣费.{0,30}返还|首笔.{0,20}返还|返还这笔消耗/.test(visible))) throw templateUnavailable()
  const uses = content.split('{{workspace_path}}').length - 1
  const links = document ? Array.from(document.querySelectorAll('a[href]')).filter(link =>
    link.getAttribute('href') === claimHref && link.textContent?.trim()).length
    : (content.match(/(?:^|\s)https:\/\/chevoink\.chevolink\.com\/\{\{workspace_path\}\}(?=$|\s)/g) ?? []).length
  if (!uses || uses !== links) throw templateUnavailable()
}
const hongKongDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function createTencentAdminEmailDelivery(config: DirectedSesConfig, fetcher: typeof fetch = fetch): AdminEmailDelivery {
  const request = (action: Parameters<typeof requestTencentSes>[1], payload: object) =>
    requestTencentSes(config, action, payload, fetcher)
  const tencentPurposes: NonNullable<AdminEmailDelivery['tencentPurposes']> = []
  if (config.templateId) tencentPurposes.push(ADMIN_EMAIL_PURPOSE)
  if (config.returnTemplateId) tencentPurposes.push(ADMIN_RETURN_EMAIL_PURPOSE)

  return {
    mode: 'tencent',
    allowedRecipients: config.allowedRecipients,
    tencentPurposes,
    async loadTemplate(campaign, customTemplate) {
      if (customTemplate) throw new DataAccessError(409, 'CAMPAIGN_MOCK_ONLY', '自定义模板当前仅开放模拟投递。')
      const templateId = campaign ? config.returnTemplateId : config.templateId
      if (!templateId) throw templateUnavailable()
      let inspected = false
      try {
        const response = await request('GetEmailTemplate', { TemplateID: templateId })
        const reply = apiReply.safeParse(response.reply)
        const template = templateReply.safeParse(response.reply)
        if (!response.ok || !reply.success || !reply.data.RequestId || reply.data.Error) {
          inspected = response.status < 500 && reply.success && !!reply.data.RequestId
            && reply.data.Error?.Code === 'InvalidParameterValue.TemplateNotExist'
          throw templateUnavailable()
        }
        const status = z.object({ TemplateStatus: z.number().int() }).safeParse(response.reply)
        inspected = status.success
        if (!template.success) throw templateUnavailable()
        const { Text, Html } = template.data.TemplateContent
        if (campaign) {
          const body = decodeTemplate(Html)
          checkReturnContent(body, true, templateId)
          const alternativeText = Text ? decodeTemplate(Text) : undefined
          if (alternativeText && !(templateId === 237702 && alternativeText === approved237702Summary)) {
            checkReturnContent(alternativeText, false, templateId)
          }
          return { ...returnEmailTemplate(campaign), providerTemplateId: templateId, from: config.from, replyTo: config.replyTo,
            body, ...(alternativeText && { alternativeText }) }
        }
        const body = decodeTemplate(Text)
        if (Html?.trim() || /\{\{|\}\}/.test(body.replace(/\{\{nickname\}\}/g, ''))) throw templateUnavailable()
        return {
          id: ADMIN_EMAIL_TEMPLATE, providerTemplateId: templateId, from: config.from, replyTo: config.replyTo,
          subject: '【启创墨域】内测邀请', body,
        }
      } catch {
        throw templateUnavailable(inspected)
      }
    },
    provider: {
      async send(message) {
        if (config.recipientScope !== 'consented' && !config.allowedRecipients.has(message.to)) return { state: 'rejected', reason: 'outside_send_scope' }
        const isReturn = !!config.returnTemplateId && message.providerTemplateId === config.returnTemplateId
        const permitted = isReturn ? returnMessage.safeParse(message.variables).success
          : !!config.templateId && message.providerTemplateId === config.templateId && Object.keys(message.variables).every(key => key === 'nickname')
        if (!permitted || message.from !== config.from || message.replyTo !== config.replyTo) {
          return { state: 'rejected', reason: 'template_changed' }
        }
        try {
          const response = await request('SendEmail', {
            FromEmailAddress: message.from, ReplyToAddresses: message.replyTo, Subject: message.subject,
            Destination: [message.to], Template: { TemplateID: message.providerTemplateId, TemplateData: JSON.stringify(message.variables) },
            TriggerType: 0, Unsubscribe: '1',
            SmtpMessageId: `<chevoink-${message.attemptId}@${config.from.split('@')[1]}>`,
          })
          const parsed = apiReply.safeParse(response.reply)
          const reply = parsed.success ? parsed.data : undefined
          if (response.ok && reply?.RequestId && reply.MessageId && !reply.Error) {
            return { state: 'accepted', requestId: reply.RequestId, messageId: reply.MessageId }
          }
          const error = reply?.Error?.Code
          if (response.status < 500 && reply?.RequestId && error && !reply.MessageId
            && (rejectedApiErrors.has(error) || /^(InvalidParameter(?:Value)?|AuthFailure)(?:\.|$)/.test(error))) {
            if (error === 'FailedOperation.ReceiverHasUnsubscribed') {
              return { state: 'rejected', requestId: reply.RequestId, reason: 'unsubscribed', suppression: 'unsubscribed' }
            }
            return { state: 'rejected', requestId: reply.RequestId, reason: 'provider_rejected' }
          }
          return { state: 'unknown', requestId: reply?.RequestId, reason: 'provider_unknown' }
        } catch {
          return { state: 'unknown', reason: 'provider_unknown' }
        }
      },
      async status(message) {
        // SES takes one calendar day per query. Cover both time zones and include a
        // neighboring day when the send's HTTP deadline crosses midnight.
        const latest = new Date(message.attemptedAt.getTime() + TENCENT_SES_TIMEOUT_MS)
        const dates = new Set([
          hongKongDay.format(message.attemptedAt), hongKongDay.format(latest),
          message.attemptedAt.toISOString().slice(0, 10), latest.toISOString().slice(0, 10),
        ])
        for (const RequestDate of dates) {
          const response = await request('GetSendEmailStatus', {
            RequestDate, MessageId: message.messageId, ToEmailAddress: message.to, Offset: 0, Limit: 10,
          })
          const reply = apiReply.safeParse(response.reply)
          const statuses = statusReply.safeParse(response.reply)
          if (!response.ok || !reply.success || !reply.data.RequestId || reply.data.Error || !statuses.success) throw statusUnavailable()
          const matches = statuses.data.EmailStatusList.filter(row =>
            row.MessageId === message.messageId
            && row.ToEmailAddress.toLowerCase() === message.to
            && row.FromEmailAddress.toLowerCase() === message.from)
          if (matches.length === 0) continue
          if (matches.length !== 1) throw statusUnavailable()
          const row = matches[0]
          if (row.SendStatus === 1013) return { state: 'rejected', reason: 'unsubscribed', suppression: 'unsubscribed' }
          if (rejectedSendStatuses.has(row.SendStatus)) return { state: 'rejected', reason: 'provider_rejected' }
          if (row.SendStatus !== 0) throw statusUnavailable()
          if (row.UserComplained || row.UserComplainted) return { state: 'delivered', reason: 'complained', suppression: 'complained' }
          if (row.UserUnsubscribed) return { state: 'delivered', reason: 'unsubscribed', suppression: 'unsubscribed' }
          if (row.DeliverStatus === 0) return { state: 'accepted' }
          if (row.DeliverStatus === 1) return { state: 'delivered' }
          if (row.DeliverStatus === 2) return { state: 'rejected', reason: 'provider_dropped' }
          if (row.DeliverStatus === 3) return /\b5\.1\.1\b/.test(row.DeliverMessage ?? '')
            ? { state: 'bounced', reason: 'hard_bounce', suppression: 'hard_bounce' }
            : { state: 'bounced', reason: 'provider_bounced' }
          if (row.DeliverStatus === 8) return { state: 'deferred' }
          throw statusUnavailable()
        }
        throw statusUnavailable()
      },
    },
  }
}
