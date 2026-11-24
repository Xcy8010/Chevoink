import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createTencentAdminEmailDelivery, type DirectedSesConfig } from '../../api/lib/admin-email-tencent.js'
import { createRewardLink } from '../../api/lib/admin-return-reward-link.js'
import { emailTemplateVariables } from '../../api/lib/admin-email-template.js'
import { configuredAdminEmailDelivery } from '../../api/lib/admin-email-config.js'
import { env } from '../../api/config/env.js'

const sender = 'pilot@chevoink.invalid'
const recipient = 'reader@chevoink.invalid'
const config = {
  secretId: 'fixture-business-id', secretKey: 'fixture-business-secret', region: 'ap-hongkong',
  templateId: 10_101, from: sender, replyTo: 'reply@chevoink.invalid', allowedRecipients: new Set([recipient]),
} satisfies DirectedSesConfig
const attemptedAt = new Date('2026-11-24T16:30:00Z')
const smtpId = 'e35f0d4a-5ff1-45b6-8bdf-91a01dbd118e'
const attempt = {
  attemptId: smtpId, to: recipient, from: sender, replyTo: config.replyTo,
  providerTemplateId: config.templateId, subject: '【启创墨域】内测邀请', variables: { nickname: '读者甲' },
}
const lookup = { messageId: 'fixture-msg', to: recipient, from: sender, attemptedAt, now: attemptedAt }
const success = (payload: object) => Response.json({ Response: { RequestId: 'fixture-request', ...payload } })
const deliveryRecord = (properties = {}) => ({
  MessageId: lookup.messageId, ToEmailAddress: recipient, FromEmailAddress: sender, SendStatus: 0, DeliverStatus: 1, ...properties,
})

describe('directed Tencent SES adapter with mock HTTP transport', () => {
  const html = readFileSync(new URL('../../src/features/admin/pages/creator-return.html', import.meta.url), 'utf8')
  const campaign = { maxCredits: 200, deadline: { mode: 'relative' as const, days: 7 }, workspacePath: 'studio' }
  const returnTemplateId = 237702
  const approved = (content: string, status = 0) => success({ TemplateStatus: status, TemplateContent: { Html: Buffer.from(content).toString('base64') } })

  it('retains the approved 237702 wording and sends its existing CTA to the authenticated claim ingress', async () => {
    const original = readFileSync(new URL('../fixtures/admin-email-return-237702.html', import.meta.url), 'utf8')
    const summary = '邀请一段时间未使用创作功能的启创墨域用户回来与创作 Agent 小墨交流，并说明创作额度福利及适用条件。'
    const originalReply = (text: string) => success({
      TemplateStatus: 0,
      TemplateContent: { Html: Buffer.from(original).toString('base64'), Text: Buffer.from(text).toString('base64') },
    })
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(originalReply(summary)).mockResolvedValueOnce(success({ MessageId: 'fixture-original' }))
    const delivery = createTencentAdminEmailDelivery({ ...config, returnTemplateId: 237702 }, transport)
    const template = await delivery.loadTemplate(campaign)
    expect(template).toMatchObject({ body: original, alternativeText: summary })
    const link = createRewardLink('tencent')
    const variables = { ...emailTemplateVariables(template, '', attemptedAt), workspace_path: link.workspacePath }
    expect(await delivery.provider.send({ ...attempt, providerTemplateId: 237702, variables })).toMatchObject({ state: 'accepted' })
    const payload = JSON.parse(String(transport.mock.calls[1][1]?.body))
    expect(JSON.parse(payload.Template.TemplateData)).toEqual({ max_credits: '200', expires_at: '2026-12-02 00:30（北京时间）', workspace_path: link.workspacePath })
    for (const rejected of [original.replace('每个账号限一次', '每个账号限两次'),
      original.replace('https://chevoink.chevolink.com/{{workspace_path}}', 'https://other.invalid/{{workspace_path}}')]) {
      transport.mockResolvedValueOnce(approved(rejected))
      await expect(delivery.loadTemplate(campaign)).rejects.toMatchObject({ status: 409 })
    }
    transport.mockResolvedValueOnce(originalReply(summary + ' 请使用其他地址。'))
    await expect(delivery.loadTemplate(campaign)).rejects.toMatchObject({ status: 409 })
    const differentId = createTencentAdminEmailDelivery({ ...config, returnTemplateId: 237703 }, transport)
    transport.mockResolvedValueOnce(approved(original))
    await expect(differentId.loadTemplate(campaign)).rejects.toMatchObject({ status: 409 })
  })

  it('requires an exact allowed list by default and an explicit broader production scope', () => {
    const values = { appEnv: 'production', adminEmailMockEnabled: false, adminEmailTencentEnabled: true,
      adminEmailTencentSecretId: 'local-fixture', adminEmailTencentSecretKey: 'local-fixture',
      adminEmailTencentFrom: sender, adminEmailTencentReplyTo: config.replyTo, adminEmailTencentTemplateId: 0,
      adminEmailTencentReturnTemplateId: 237702, adminEmailTencentRecipients: [recipient], adminEmailTencentRecipientScope: 'allowlist' }
    const previous = Object.fromEntries((Object.keys(values) as Array<keyof typeof values>).map(key => [key, env[key]]))
    try {
      Object.assign(env, values)
      expect(configuredAdminEmailDelivery()).toMatchObject({ mode: 'tencent', tencentPurposes: ['creator_return'], allowedRecipients: new Set([recipient]) })
      env.adminEmailTencentRecipients = []
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentRecipientScope = 'consented'
      expect(configuredAdminEmailDelivery().allowedRecipients).toBeUndefined()
      env.adminEmailTencentTemplateId = 237702
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentTemplateId = 0
      env.appEnv = 'development'
      expect(configuredAdminEmailDelivery).toThrow()
      env.appEnv = 'production'
      env.adminEmailTencentRecipientScope = '*'
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentRecipientScope = 'allowlist'
      env.adminEmailTencentRecipients = ['*@example.test']
      expect(configuredAdminEmailDelivery).toThrow()
    } finally { Object.assign(env, previous) }
  })

  it('loads an approved return-only SES account and sends the three variables through the protected claim ingress', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(approved(html)).mockResolvedValueOnce(success({ MessageId: 'fixture-return' }))
    const delivery = createTencentAdminEmailDelivery({ ...config, templateId: undefined, returnTemplateId }, transport)
    expect(delivery.tencentPurposes).toEqual(['creator_return'])
    await expect(delivery.loadTemplate()).rejects.toMatchObject({ code: 'ADMIN_EMAIL_TEMPLATE_UNAVAILABLE' })
    const template = await delivery.loadTemplate(campaign)
    expect(template).toMatchObject({ providerTemplateId: returnTemplateId, body: html, campaign })
    const link = createRewardLink('tencent')
    const variables = { ...emailTemplateVariables(template, '创作者', attemptedAt), workspace_path: link.workspacePath }
    const send = { ...attempt, providerTemplateId: returnTemplateId, variables, attemptId: link.attemptId }
    expect(await delivery.provider.send({ ...send, variables: { ...variables, workspace_path: createRewardLink('mock').workspacePath } })).toMatchObject({ state: 'rejected' })
    expect(await delivery.provider.send({ ...send, variables: { ...variables, extra: 'unexpected' } })).toMatchObject({ state: 'rejected' })
    expect(await delivery.provider.send(send)).toMatchObject({ state: 'accepted' })
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ TemplateID: returnTemplateId })
    const payload = JSON.parse(String(transport.mock.calls[1][1]?.body))
    expect(payload).toMatchObject({ Destination: [recipient], Template: { TemplateID: returnTemplateId }, Unsubscribe: '1' })
    expect(JSON.parse(payload.Template.TemplateData)).toEqual({ max_credits: '200', expires_at: '2026-12-02 00:30（北京时间）',
      workspace_path: expect.stringMatching(/^api\/credits\/return-reward\/open#[A-Za-z0-9_-]{43}$/) })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('uses one complete explicitly selected credential pair while keeping the OTP sender and template isolated', async () => {
    const values = { appEnv: 'production', adminEmailMockEnabled: false, adminEmailTencentEnabled: true,
      adminEmailTencentCredentialSource: 'dedicated', adminEmailTencentSecretId: '', adminEmailTencentSecretKey: '',
      emailTencentSecretId: 'local-otp-id', emailTencentSecretKey: 'local-otp-secret', emailTencentFromAddress: 'otp@example.test', emailTencentTemplateId: 5,
      adminEmailTencentFrom: sender, adminEmailTencentReplyTo: config.replyTo, adminEmailTencentTemplateId: 0, adminEmailTencentReturnTemplateId: 237702,
      adminEmailTencentRecipients: [recipient], adminEmailTencentRecipientScope: 'allowlist' }
    const previous = Object.fromEntries((Object.keys(values) as Array<keyof typeof values>).map(key => [key, env[key]]))
    const transport = vi.fn<typeof fetch>(async () => approved(html))
    vi.stubGlobal('fetch', transport)
    try {
      Object.assign(env, values)
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentCredentialSource = 'account-email'
      await configuredAdminEmailDelivery().loadTemplate(campaign)
      env.adminEmailTencentSecretId = 'local-business-id'
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentSecretKey = 'local-business-secret'
      await configuredAdminEmailDelivery().loadTemplate(campaign)
      const signers = transport.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')?.match(/Credential=([^/]+)/)?.[1])
      expect(signers).toEqual(['local-otp-id', 'local-business-id'])
      env.adminEmailTencentFrom = env.emailTencentFromAddress
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentFrom = sender
      env.adminEmailTencentReturnTemplateId = 5
      expect(configuredAdminEmailDelivery).toThrow()
      env.adminEmailTencentReturnTemplateId = 237702
      env.appEnv = 'development'
      expect(configuredAdminEmailDelivery).toThrow()
    } finally { Object.assign(env, previous); vi.unstubAllGlobals() }
  })

  it('rejects an unapproved or incompatible return template before sending', async () => {
    const transport = vi.fn<typeof fetch>()
    const delivery = createTencentAdminEmailDelivery({ ...config, returnTemplateId }, transport)
    const cases = [approved(html, 1), approved(html.replaceAll('{{expires_at}}', '{{expiry}}')),
      approved(html.replace('https://chevoink.chevolink.com/{{workspace_path}}', 'https://other.invalid/{{workspace_path}}')),
      approved(html.replace('</body>', '<p>{{workspace_path}}</p></body>')),
      approved(html.replace('每个账号限领一次', '首次实际扣费后返还这笔消耗'))]
    for (const response of cases) {
      transport.mockResolvedValueOnce(response)
      await expect(delivery.loadTemplate(campaign)).rejects.toMatchObject({ status: 409, code: 'ADMIN_EMAIL_TEMPLATE_UNAVAILABLE' })
    }
    transport.mockResolvedValueOnce(success({ Error: { Code: 'InvalidParameterValue.TemplateNotExist' } }))
    await expect(delivery.loadTemplate(campaign)).rejects.toMatchObject({ status: 409 })
    transport.mockResolvedValueOnce(success({ Error: { Code: 'RequestLimitExceeded' } }))
    await expect(delivery.loadTemplate(campaign)).rejects.toMatchObject({ status: 503 })
    expect(transport.mock.calls.every(([, init]) => new Headers(init?.headers).get('X-TC-Action') === 'GetEmailTemplate')).toBe(true)
  })
  it('signs the approved template lookup and sends one allowlisted recipient with a correlation ID and unsubscribe', async () => {
    const body = '您好，{{nickname}}。这是合成测试模板。'
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ TemplateStatus: 0, TemplateContent: { Text: Buffer.from(body).toString('base64') } }))
      .mockResolvedValueOnce(success({ MessageId: lookup.messageId }))
    const delivery = createTencentAdminEmailDelivery(config, transport)
    expect(await delivery.loadTemplate()).toMatchObject({ providerTemplateId: config.templateId, body, from: sender })
    expect(await delivery.provider.send(attempt)).toEqual({ state: 'accepted', requestId: 'fixture-request', messageId: 'fixture-msg' })
    expect(transport.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get('X-TC-Action')])).toEqual([
      ['https://ses.tencentcloudapi.com/', 'GetEmailTemplate'], ['https://ses.tencentcloudapi.com/', 'SendEmail'],
    ])
    const request = transport.mock.calls[1][1]
    expect(new Headers(request?.headers).get('X-TC-Region')).toBe('ap-hongkong')
    expect(new Headers(request?.headers).get('Authorization')).toMatch(/^TC3-HMAC-SHA256 Credential=fixture-business-id\/.*\/ses\/tc3_request,/)
    expect(JSON.parse(String(request?.body))).toEqual({
      FromEmailAddress: sender, ReplyToAddresses: config.replyTo, Subject: attempt.subject, Destination: [recipient],
      Template: { TemplateID: config.templateId, TemplateData: JSON.stringify({ nickname: '读者甲' }) },
      TriggerType: 0, Unsubscribe: '1', SmtpMessageId: `<chevoink-${smtpId}@chevoink.invalid>`,
    })
  })

  it('blocks out-of-scope recipients and mismatched sender configuration before any provider call', async () => {
    const transport = vi.fn<typeof fetch>()
    const { provider } = createTencentAdminEmailDelivery(config, transport)
    expect(await provider.send({ ...attempt, to: 'outside@chevoink.invalid' })).toMatchObject({ state: 'rejected', reason: 'outside_send_scope' })
    expect(await provider.send({ ...attempt, from: 'otp@chevoink.invalid' })).toMatchObject({ state: 'rejected', reason: 'template_changed' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('only considers documented definitive rejections rejected and never retries uncertain sends', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ Error: { Code: 'FailedOperation.ReceiverHasUnsubscribed' } }))
      .mockResolvedValueOnce(success({ Error: { Code: 'FailedOperation.SendEmailErr' } }))
      .mockResolvedValueOnce(Response.json({
        Response: { RequestId: 'fixture-request', Error: { Code: 'InvalidParameter' } },
      }, { status: 503 }))
      .mockRejectedValueOnce(new Error('synthetic timeout'))
    const { provider } = createTencentAdminEmailDelivery(config, transport)
    expect(await provider.send(attempt)).toMatchObject({ state: 'rejected', reason: 'unsubscribed', suppression: 'unsubscribed' })
    for (let n = 0; n < 3; n++) expect(await provider.send(attempt)).toMatchObject({ state: 'unknown', reason: 'provider_unknown' })
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('uses the Hong Kong day, reconciles only the exact message and addresses, and consumes late feedback', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ ToEmailAddress: 'unrelated@chevoink.invalid' })] }))
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ UserComplained: true })] }))
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ UserComplainted: true })] }))
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ DeliverStatus: 3, DeliverMessage: '550 5.1.1 mailbox absent' })] }))
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ DeliverStatus: 3, DeliverMessage: '550 5.7.1 policy rejection' })] }))
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ SendStatus: 1013, DeliverStatus: undefined })] }))
    const { provider } = createTencentAdminEmailDelivery(config, transport)
    for (let n = 0; n < 2; n++) {
      expect(await provider.status(lookup)).toMatchObject({ state: 'delivered', reason: 'complained', suppression: 'complained' })
    }
    expect(await provider.status(lookup)).toEqual({ state: 'bounced', reason: 'hard_bounce', suppression: 'hard_bounce' })
    expect(await provider.status(lookup)).toEqual({ state: 'bounced', reason: 'provider_bounced' })
    expect(await provider.status(lookup)).toEqual({ state: 'rejected', reason: 'unsubscribed', suppression: 'unsubscribed' })
    expect(transport.mock.calls.slice(0, 2).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { RequestDate: '2026-11-25', MessageId: lookup.messageId, ToEmailAddress: recipient, Offset: 0, Limit: 10 },
      { RequestDate: '2026-11-24', MessageId: lookup.messageId, ToEmailAddress: recipient, Offset: 0, Limit: 10 },
    ])
  })

  it('keeps ambiguous status pending and rejects drafts, HTML, and unsupported template variables', async () => {
    const text = Buffer.from('您好，{{other}}。').toString('base64')
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ EmailStatusList: [deliveryRecord({ SendStatus: 1004 })] }))
      .mockResolvedValueOnce(success({ TemplateStatus: 1, TemplateContent: { Text: text } }))
      .mockResolvedValueOnce(success({ TemplateStatus: 0, TemplateContent: { Text: text, Html: 'dGVzdA==' } }))
      .mockResolvedValueOnce(success({ TemplateStatus: 0, TemplateContent: { Text: text } }))
    const delivery = createTencentAdminEmailDelivery(config, transport)
    await expect(delivery.provider.status(lookup)).rejects.toThrow('not confirmed')
    for (let n = 0; n < 3; n++) await expect(delivery.loadTemplate()).rejects.toMatchObject({ code: 'ADMIN_EMAIL_TEMPLATE_UNAVAILABLE' })
  })
})
