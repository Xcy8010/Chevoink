import { emailVariablePattern } from '../../shared/contracts/email-library.js'
import { createHash } from 'node:crypto'
import { ADMIN_EMAIL_TEMPLATE, ADMIN_RETURN_TEMPLATE_ID, type AdminEmailCampaign, type AdminCustomEmailTemplate } from '../../shared/contracts/admin-email.js'

export type AdminEmailTemplateSnapshot = {
  id: string
  customTemplate?: AdminCustomEmailTemplate
  campaign?: AdminEmailCampaign
  providerTemplateId: number | null
  from: string
  replyTo: string
  subject: string
  body: string
  alternativeText?: string
}

export const mockEmailTemplate: AdminEmailTemplateSnapshot = {
  id: ADMIN_EMAIL_TEMPLATE,
  providerTemplateId: null,
  from: '启创墨域 <notices@chevoink.invalid>',
  replyTo: 'support@chevoink.invalid',
  subject: '【启创墨域】内测邀请',
  body: '您好，{{nickname}}。启创墨域邀请您参加本轮内测。测试期间，您可以尝试创作工作区的新功能，并通过站内反馈入口提交使用体验。参与由您自行决定，测试资格和具体安排以站内通知为准。',
}

export function returnEmailTemplate(campaign: AdminEmailCampaign): AdminEmailTemplateSnapshot {
  return {
    id: ADMIN_RETURN_TEMPLATE_ID, providerTemplateId: Number(ADMIN_RETURN_TEMPLATE_ID),
    from: 'notices@chevolink.com', replyTo: '2449129862@qq.com',
    subject: '【启创墨域】你有一份创作额度福利！',
    body: '在 {{expires_at}} 前，通过本邮件登录并领取 {{max_credits}} Credits。奖励额度将直接存入你的账号，每封邮件的奖励限领一次。',
    campaign,
  }
}

export function substituteEmailVariables(content: string, values: Record<string, string>) {
  return content.replace(emailVariablePattern, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : token)
}

export function customEmailTemplate(customTemplate: AdminCustomEmailTemplate): AdminEmailTemplateSnapshot {
  return {
    id: String(customTemplate.id), providerTemplateId: customTemplate.id,
    from: 'notices@chevolink.com', replyTo: '2449129862@qq.com',
    subject: substituteEmailVariables(customTemplate.subject, customTemplate.values),
    body: customTemplate.body, customTemplate,
  }
}

export function campaignDeadline(campaign: AdminEmailCampaign, sendAt: Date) {
  return campaign.deadline.mode === 'fixed' ? new Date(campaign.deadline.at) : new Date(sendAt.getTime() + campaign.deadline.days * 86_400_000)
}

export function emailTemplateVariables(template: AdminEmailTemplateSnapshot, nickname: string, sendAt: Date): Record<string, string> {
  if (template.customTemplate) return template.customTemplate.values
  const campaign = template.campaign
  if (!campaign) return template.body.includes('{{nickname}}') ? { nickname: nickname.trim() || '创作者' } : {}
  const deadline = campaignDeadline(campaign, sendAt)
  const expiresAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(deadline)
  return { max_credits: String(campaign.maxCredits), expires_at: expiresAt + '（北京时间）', workspace_path: campaign.workspacePath }
}

export function adminEmailTemplateHash(template: AdminEmailTemplateSnapshot) {
  return createHash('sha256').update(JSON.stringify([
    template.id, template.providerTemplateId, template.from, template.replyTo, template.subject, template.body,
    ...(template.alternativeText ? [template.alternativeText] : []),
    ...(template.customTemplate ? [template.customTemplate.name, template.customTemplate.subject,
      Object.entries(template.customTemplate.values).sort(([a], [b]) => a.localeCompare(b, 'en'))] : []),
    ...(template.campaign ? [template.campaign.maxCredits, template.campaign.workspacePath, template.campaign.deadline.mode,
      template.campaign.deadline.mode === 'relative' ? template.campaign.deadline.days : template.campaign.deadline.at] : []),
  ])).digest('hex')
}

export function renderEmailPreview(nickname: string, body: string = mockEmailTemplate.body) {
  return body.replace(/\{\{nickname\}\}/g, () => nickname.trim() || '创作者')
}
