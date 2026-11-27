import { readFile } from 'node:fs/promises'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { mockAdminEmailProvider, type AdminEmailProvider, type AdminEmailSendResult } from './admin-email-provider.js'
import { createTencentAdminEmailDelivery } from './admin-email-tencent.js'
import { requestTencentSes } from './tencent-ses-client.js'

import { governanceMailTemplates as templates, type GovernanceMailKind as Kind } from '../../shared/contracts/governance-mail.js'

type Notice = { eventId: string; userId: string; reason: string } & (
  | { kind: 'warning'; measure?: never }
  | { kind: 'enforcement'; measure: string }
  | { kind: 'appeal_result'; result: string; measure: string }
)
const appealSnapshot = z.object({ version: z.literal(1), result: z.string().min(1), measure: z.string().min(1) })

export async function queueGovernanceMail(tx: Prisma.TransactionClient, input: Notice) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true, emailVerifiedAt: true } })
  const recipient = user.emailVerifiedAt ? user.email?.toLowerCase() : null
  const delivery = governanceDelivery()
  const state = !recipient ? 'unavailable' : delivery ? 'pending' : 'unconfigured'
  const { eventId, userId, kind, reason } = input
  const measure = kind === 'appeal_result' ? JSON.stringify({ version: 1, result: input.result, measure: input.measure }) : input.measure
  await tx.governanceMail.createMany({ data: [{ eventId, userId, kind, reason, measure, recipient, mode: delivery?.mode ?? null, state }], skipDuplicates: true })
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
export function governanceMailVariables(kind: Kind, reason: string, measure?: string | null, result?: string): Record<string,string> {
  if (kind === 'appeal_result') {
    if (!result?.trim() || !measure?.trim()) throw Error('申诉通知缺少结果或账号使用安排')
    return { result: escapeHtml(result), reason: escapeHtml(reason), measure: escapeHtml(measure) }
  }
  if (kind === 'enforcement') {
    if (!measure?.trim()) throw Error('限制通知缺少措施和期限')
    return { reason: escapeHtml(reason), measure: escapeHtml(measure) }
  }
  return { reason: escapeHtml(reason) }
}
export async function governanceMailPreview(kind: Kind, reason: string, measure?: string, result?: string) {
  const { file, subject } = templates[kind]
  const html = await readFile(new URL('../templates/governance/' + file, import.meta.url), 'utf8')
  const variables = governanceMailVariables(kind, reason, measure, result)
  return { subject, html: html.replace(/\{\{(reason|measure|result)\}\}/g, (_, key: string) => variables[key]) }
}

type Delivery = { mode: 'mock' | 'tencent'; from: string; replyTo: string; provider: AdminEmailProvider; ids: Partial<Record<Kind,number>>; verify(kind: Kind): Promise<void> }
export function governanceDelivery(config = process.env, fetcher: typeof fetch = fetch): Delivery | null {
  const from = 'notice@chevolink.com'
  if (config.GOVERNANCE_MAIL_MODE === 'mock') return {
    mode: 'mock', from, replyTo: 'mock@chevoink.invalid', provider: mockAdminEmailProvider, ids: { warning: templates.warning.id, enforcement: templates.enforcement.id, appeal_result: templates.appeal_result.id }, verify: async () => {},
  }
  if (config.GOVERNANCE_MAIL_MODE !== 'tencent-allowlist') return null
  const { GOVERNANCE_SES_SECRET_ID: secretId, GOVERNANCE_SES_SECRET_KEY: secretKey, GOVERNANCE_SES_REPLY_TO: replyTo } = config
  if (!secretId || !secretKey || !replyTo || !z.string().email().safeParse(replyTo).success) return null
  const allowedRecipients = new Set((config.GOVERNANCE_SES_ALLOWLIST ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean))
  const ids = { warning: templates.warning.id, enforcement: templates.enforcement.id, appeal_result: templates.appeal_result.id }
  const reserved = [Number(config.ADMIN_EMAIL_TENCENT_TEMPLATE_ID), Number(config.ADMIN_EMAIL_TENCENT_RETURN_TEMPLATE_ID), Number(config.EMAIL_TENCENT_TEMPLATE_ID)]
  for (const kind of Object.keys(ids) as Kind[]) {
    const configured = config['GOVERNANCE_SES_' + kind.toUpperCase() + '_TEMPLATE_ID']
    if ((configured && Number(configured) !== ids[kind]) || reserved.includes(ids[kind])) return null
  }
  const credentials = { secretId, secretKey, region: 'ap-hongkong' }
  const delivery = createTencentAdminEmailDelivery({ ...credentials, from, replyTo, allowedRecipients }, fetcher)
  return { mode: 'tencent', from, replyTo, ids,
    async verify(kind) {
      const id = ids[kind]
      if (!id) throw Error('治理模板待配置')
      const response = await requestTencentSes(credentials, 'GetEmailTemplate', { TemplateID: id }, fetcher)
      const parsed = z.object({ RequestId: z.string().min(1), TemplateStatus: z.literal(0), TemplateContent: z.object({ Html: z.string().min(1), Text: z.string().nullish() }) }).safeParse(response.reply)
      if (!response.ok || !parsed.success || parsed.data.TemplateContent.Text?.trim()) throw Error('模板审核待核实')
      const html = await readFile(new URL('../templates/governance/' + templates[kind].file, import.meta.url), 'utf8')
      const normalize = (v: string) => v.replace(/\r\n/g, '\n').trim()
      if (normalize(Buffer.from(parsed.data.TemplateContent.Html,'base64').toString('utf8')) !== normalize(html)) throw Error('治理模板与批准原件不符')
    },
    provider: { status: delivery.provider.status,
      async send(m): Promise<AdminEmailSendResult> {
        const kind = (Object.keys(ids) as Kind[]).find(key => ids[key] === m.providerTemplateId)
        const variables = kind === 'appeal_result' ? ['measure','reason','result'] : kind === 'enforcement' ? ['measure','reason'] : ['reason']
        if (!kind || !m.providerTemplateId || !allowedRecipients.has(m.to) || m.from !== from || m.replyTo !== replyTo || m.subject !== templates[kind].subject || Object.keys(m.variables).sort().join(',') !== variables.join(',')) return { state: 'rejected', reason: 'outside_send_scope' }
        try {
          const response = await requestTencentSes(credentials, 'SendEmail', { FromEmailAddress: from, ReplyToAddresses: replyTo, Destination: [m.to], Subject: m.subject,
            Template: { TemplateID: m.providerTemplateId, TemplateData: JSON.stringify(m.variables) }, TriggerType: 0, SmtpMessageId: '<governance-' + m.attemptId + '@chevolink.com>' }, fetcher)
          const reply = z.object({ MessageId: z.string().min(1).optional(), RequestId: z.string().min(1), Error: z.object({ Code: z.string() }).optional() }).safeParse(response.reply)
          if (response.ok && reply.success && reply.data.MessageId && !reply.data.Error) return { state: 'accepted', messageId: reply.data.MessageId, requestId: reply.data.RequestId }
          if (response.status < 500 && reply.success && !reply.data.MessageId && /^(InvalidParameter|AuthFailure|FailedOperation\.(IncorrectEmail|InvalidTemplateID|EmailAddrInBlacklist|ReceiverHasUnsubscribed))/.test(reply.data.Error?.Code ?? '')) return { state: 'rejected', requestId: reply.data.RequestId, reason: 'provider_rejected' }
          return { state:'unknown', reason:'provider_unknown' }
        } catch { return { state:'unknown', reason:'provider_unknown' } }
      },
    },
  }
}

export async function processGovernanceMail(delivery: Delivery, now = new Date()) {
  const due = { OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] }
  const rows = await prisma.governanceMail.findMany({ where: { ...due, mode: delivery.mode, state: { in: ['pending','accepted','deferred'] } }, orderBy:{createdAt:'asc'}, take:20 })
  for (const row of rows) {
    if (!row.recipient) continue
    const kind = row.kind as Kind
    if (row.state === 'pending') {
      const account = await prisma.user.findUnique({ where:{id:row.userId}, select:{email:true,emailVerifiedAt:true} })
      const suppressed = await prisma.adminEmailPermission.findFirst({ where:{ email:row.recipient, suppression:{in:['hard_bounce','complained']} }, select:{email:true} })
      if (suppressed || !account?.emailVerifiedAt || account.email?.toLowerCase() !== row.recipient) {
        await prisma.governanceMail.updateMany({ where:{id:row.id,state:'pending'},data:{state:'suppressed'} })
        continue
      }
      let variables: Record<string,string>
      try {
        if (kind === 'appeal_result') {
          const snapshot = appealSnapshot.parse(JSON.parse(row.measure ?? 'null'))
          variables = governanceMailVariables(kind, row.reason, snapshot.measure, snapshot.result)
        } else {
          variables = governanceMailVariables(kind, row.reason, row.measure)
        }
      } catch {
        await prisma.governanceMail.updateMany({ where:{id:row.id,state:'pending'},data:{state:'unconfigured',detail:'notice_snapshot_unavailable'} })
        continue
      }
      try { await delivery.verify(kind) } catch {
        await prisma.governanceMail.updateMany({ where:{id:row.id,state:'pending'},data:{detail:'template_unavailable',nextCheckAt:new Date(+now+300_000)} })
        continue
      }
      // Commit uncertainty before crossing the provider boundary. A crashed worker cannot send twice.
      const claim = await prisma.governanceMail.updateMany({ where:{id:row.id,state:'pending'},data:{state:'unknown',mode:delivery.mode,attemptedAt:now,detail:'dispatch_started'} })
      if (!claim.count) continue
      const result = await delivery.provider.send({ attemptId:row.id,to:row.recipient,from:delivery.from,replyTo:delivery.replyTo,subject:templates[kind].subject,providerTemplateId:delivery.ids[kind] ?? null,variables })
      await prisma.governanceMail.update({ where:{id:row.id},data:{ state:result.state, requestId:result.requestId, messageId:'messageId' in result ? result.messageId : null, detail:'reason' in result ? result.reason : null, nextCheckAt:new Date(+now+60_000) } })
    } else if (row.messageId && row.attemptedAt) {
      const nextCheckAt = new Date(+now+300_000)
      const claim = await prisma.governanceMail.updateMany({ where:{id:row.id,state:row.state,nextCheckAt:row.nextCheckAt}, data:{nextCheckAt} })
      if (!claim.count) continue
      const receipt = await delivery.provider.status({ messageId:row.messageId,to:row.recipient,from:delivery.from,attemptedAt:row.attemptedAt,now }).catch(() => null)
      if (receipt) await prisma.$transaction(async tx => {
        await tx.governanceMail.update({where:{id:row.id},data:{state:receipt.state,detail:receipt.reason}})
        if (delivery.mode === 'tencent' && (receipt.suppression === 'hard_bounce' || receipt.suppression === 'complained')) await tx.adminEmailPermission.upsert({ where:{purpose_email:{purpose:'governance',email:row.recipient!}},create:{purpose:'governance',email:row.recipient!,suppression:receipt.suppression},update:{suppression:receipt.suppression} })
      })
    }
  }
}
