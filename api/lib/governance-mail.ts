import { readFile } from 'node:fs/promises'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { mockAdminEmailProvider, type AdminEmailProvider, type AdminEmailSendResult } from './admin-email-provider.js'
import { createTencentAdminEmailDelivery } from './admin-email-tencent.js'
import { requestTencentSes } from './tencent-ses-client.js'

const templates = {
  warning: { file: 'chevoink-account-warning.html', subject: '【启创墨域】账号使用提醒' },
  enforcement: { file: 'chevoink-account-enforcement.html', subject: '【启创墨域】账号使用限制通知' },
  appeal_result: { file: 'appeal-result-draft.html', subject: '【启创墨域】申诉复核结果' },
} as const
type Kind = keyof typeof templates
type Notice = { eventId: string; userId: string; kind: Kind; reason: string; measure?: string }

export async function queueGovernanceMail(tx: Prisma.TransactionClient, input: Notice) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true, emailVerifiedAt: true } })
  const recipient = user.emailVerifiedAt ? user.email?.toLowerCase() : null
  const delivery = governanceDelivery()
  const enabled = delivery && (delivery.mode === 'mock' || delivery.ids[input.kind] !== undefined)
  const state = !recipient ? 'unavailable' : enabled ? 'pending' : 'unconfigured'
  await tx.governanceMail.createMany({ data: [{ ...input, recipient, mode: delivery?.mode ?? null, state }], skipDuplicates: true })
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
export function governanceMailVariables(kind: Kind, reason: string, measure?: string | null): Record<string,string> {
  if (kind === 'enforcement') {
    if (!measure?.trim()) throw Error('限制通知缺少措施和期限')
    return { reason: escapeHtml(reason), measure: escapeHtml(measure) }
  }
  return { reason: escapeHtml(reason) }
}
export async function governanceMailPreview(kind: Kind, reason: string, measure?: string) {
  const { file, subject } = templates[kind]
  const html = await readFile(new URL('../templates/governance/' + file, import.meta.url), 'utf8')
  const variables = governanceMailVariables(kind, reason, measure)
  return { subject, html: html.replace(/\{\{(reason|measure)\}\}/g, (_, key: string) => variables[key]) }
}

type Delivery = { mode: 'mock' | 'tencent'; from: string; replyTo: string; provider: AdminEmailProvider; ids: Partial<Record<Kind,number>>; verify(kind: Kind): Promise<void> }
export function governanceDelivery(config = process.env, fetcher: typeof fetch = fetch): Delivery | null {
  const from = 'notice@chevolink.com'
  if (config.GOVERNANCE_MAIL_MODE === 'mock') return {
    mode: 'mock', from, replyTo: 'mock@chevoink.invalid', provider: mockAdminEmailProvider, ids: {}, verify: async () => {},
  }
  if (config.GOVERNANCE_MAIL_MODE !== 'tencent-allowlist') return null
  const { GOVERNANCE_SES_SECRET_ID: secretId, GOVERNANCE_SES_SECRET_KEY: secretKey, GOVERNANCE_SES_REPLY_TO: replyTo } = config
  if (!secretId || !secretKey || !replyTo || !z.string().email().safeParse(replyTo).success) return null
  const allowedRecipients = new Set((config.GOVERNANCE_SES_ALLOWLIST ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean))
  const ids: Delivery['ids'] = {}
  for (const kind of ['warning','enforcement'] as const) {
    const id = Number(config['GOVERNANCE_SES_' + kind.toUpperCase() + '_TEMPLATE_ID'])
    const reserved = [237702, Number(config.ADMIN_EMAIL_TENCENT_TEMPLATE_ID), Number(config.ADMIN_EMAIL_TENCENT_RETURN_TEMPLATE_ID), Number(config.EMAIL_TENCENT_TEMPLATE_ID)]
    if (Number.isSafeInteger(id) && id > 0 && !reserved.includes(id)) ids[kind] = id
  }
  if (ids.warning && ids.warning === ids.enforcement) return null
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
        const variables = kind === 'enforcement' ? ['measure','reason'] : ['reason']
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
      try { await delivery.verify(kind) } catch {
        await prisma.governanceMail.updateMany({ where:{id:row.id,state:'pending'},data:{detail:'template_unavailable',nextCheckAt:new Date(+now+300_000)} })
        continue
      }
      const variables = governanceMailVariables(kind, row.reason, row.measure)
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
