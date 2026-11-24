import { describe, expect, it } from 'vitest'
import { adminEmailPreviewSchema, type AdminEmailCampaign } from '../../shared/contracts/admin-email.js'
import { mockAdminEmailDelivery } from '../../api/lib/admin-email-provider.js'
import { adminEmailTemplateHash, customEmailTemplate, emailTemplateVariables, returnEmailTemplate, substituteEmailVariables } from '../../api/lib/admin-email-template.js'
import { createTencentAdminEmailDelivery } from '../../api/lib/admin-email-tencent.js'

const relative: AdminEmailCampaign = { maxCredits: 280, deadline: { mode: 'relative', days: 2 }, workspacePath: 'studio' }
const custom = { id: 9876, name: '通知', subject: '通知 {{topic}}', body: '{{topic}} {{note}}', values: { topic: '回归', note: '活动详情' } }
const input = { mode: 'mock', selection: { mode: 'manual', userIds: ['account'] } }

describe('directed campaign and custom templates', () => {
  it('expands the approved SES parameters with a per-send Beijing deadline and preserves fixed instants', async () => {
    const template = await mockAdminEmailDelivery.loadTemplate(relative)
    expect(template).toMatchObject({ id: '237702', providerTemplateId: 237702, replyTo: '2449129862@qq.com' })
    expect(emailTemplateVariables(template, 'unused', new Date('2026-11-25T15:58:00Z'))).toEqual({
      max_credits: '280', expires_at: '2026-11-27 23:58（北京时间）', workspace_path: 'studio',
    })
    const fixed = returnEmailTemplate({ ...relative, deadline: { mode: 'fixed', at: '2026-12-01T00:30:00+08:00' } })
    expect(emailTemplateVariables(fixed, '', new Date()).expires_at).toBe('2026-12-01 00:30（北京时间）')
    expect(adminEmailTemplateHash(fixed)).not.toBe(adminEmailTemplateHash(template))
  })

  it('binds custom variables and source to the snapshot while ignoring database object key order', () => {
    expect(adminEmailPreviewSchema.safeParse({ ...input, customTemplate: custom }).success).toBe(true)
    const snapshot = customEmailTemplate(custom)
    expect(snapshot.subject).toBe('通知 回归')
    expect(substituteEmailVariables(snapshot.body, emailTemplateVariables(snapshot, '', new Date()))).toBe('回归 活动详情')
    const hash = adminEmailTemplateHash(snapshot)
    expect(adminEmailTemplateHash(customEmailTemplate({ ...custom, values: { note: '活动详情', topic: '回归' } }))).toBe(hash)
    expect(adminEmailTemplateHash(customEmailTemplate({ ...custom, values: { ...custom.values, note: '另一次' } }))).not.toBe(hash)
    for (const invalid of [
      { ...custom, values: { topic: 'x' } }, { ...custom, body: '{{bad-key}}' }, { ...custom, id: 237702 },
    ]) expect(adminEmailPreviewSchema.safeParse({ ...input, customTemplate: invalid }).success).toBe(false)
    expect(adminEmailPreviewSchema.safeParse({ ...input, campaign: relative, customTemplate: custom }).success).toBe(false)
  })

  it('rejects unsendable activity templates in real mode before any provider request', async () => {
    const config = { region: 'ap-hongkong', secretId: 'unused', secretKey: 'unused', templateId: 1, from: 'x@example.test', replyTo: 'y@example.test', allowedRecipients: new Set<string>() }
    const delivery = createTencentAdminEmailDelivery(config, () => { throw Error('unexpected network call') })
    await expect(delivery.loadTemplate(relative)).rejects.toMatchObject({ code: 'ADMIN_EMAIL_TEMPLATE_UNAVAILABLE' })
    await expect(delivery.loadTemplate(undefined, custom)).rejects.toMatchObject({ code: 'CAMPAIGN_MOCK_ONLY' })
  })
})
