import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { governanceDelivery, governanceMailPreview, governanceMailVariables } from '../../api/lib/governance-mail'
const config = { GOVERNANCE_MAIL_MODE:'tencent-allowlist', GOVERNANCE_SES_SECRET_ID:'synthetic', GOVERNANCE_SES_SECRET_KEY:'synthetic',
  GOVERNANCE_SES_ALLOWLIST:'case@example.invalid', GOVERNANCE_SES_REPLY_TO:'case@example.invalid', GOVERNANCE_SES_ENFORCEMENT_TEMPLATE_ID:'238308' }
const input = { attemptId:'event-123',to:'case@example.invalid',from:'notice@chevolink.com',replyTo:'case@example.invalid',
  subject:'【启创墨域】账号使用限制通知',providerTemplateId:238308,variables:governanceMailVariables('enforcement','<理由>','7 天') }
describe('governance notices',()=>{
  it('previews the original fixed appeal link and escapes author-supplied variables',async()=>{
    const {html}=await governanceMailPreview('enforcement','<script>','7 天')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('href="https://chevoink.chevolink.com/appeal"')
    expect(html).not.toContain('{{measure}}')
    expect((await governanceMailPreview('warning','合成')).html).not.toContain('/appeal')
    expect(()=>governanceMailVariables('enforcement','x')).toThrow()
  })
  it('checks the approved template before a single-recipient synthetic dispatch',async()=>{
    const source=await readFile('api/templates/governance/chevoink-account-enforcement.html')
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({Response:{RequestId:'read',TemplateStatus:0,TemplateContent:{Html:source.toString('base64')}}}))
      .mockResolvedValueOnce(Response.json({Response:{RequestId:'request',MessageId:'message'}}))
    const sender=governanceDelivery(config,fetcher)!
    await sender.verify('enforcement')
    expect(await sender.provider.send(input)).toEqual({state:'accepted',requestId:'request',messageId:'message'})
    const payload=JSON.parse(fetcher.mock.calls[1][1].body)
    expect(payload).toMatchObject({FromEmailAddress:input.from,Destination:[input.to],Subject:input.subject,Template:{TemplateID:238308,TemplateData:JSON.stringify(input.variables)}})
    expect(payload).not.toHaveProperty('Unsubscribe')
    fetcher.mockResolvedValueOnce(Response.json({Response:{RequestId:'read',TemplateStatus:0,TemplateContent:{Html:source.toString('base64'),Text:Buffer.from('other content').toString('base64')}}}))
    await expect(sender.verify('enforcement')).rejects.toThrow()
  })
  it.each([
    ['warning',238307,'chevoink-account-warning.html','【启创墨域】账号使用提醒'],
    ['enforcement',238308,'chevoink-account-enforcement.html','【启创墨域】账号使用限制通知'],
    ['appeal_result',238309,'chevoink-appeal-result.html','【启创墨域】申诉处理结果通知'],
  ] as const)('validates the exact %s source and sends the typed snapshot once to an allowlisted synthetic address', async (kind, id, file, subject) => {
    const original = await readFile('api/templates/governance/'+file)
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ Response:{ RequestId:'lookup',TemplateStatus:0,TemplateContent:{Html:original.toString('base64')} } }))
      .mockResolvedValueOnce(Response.json({ Response:{ RequestId:'send',MessageId:'accepted' } }))
    const sender = governanceDelivery(config,fetcher)!
    const variables = governanceMailVariables(kind,'<证据>','<账号安排>','<复核结果>')
    await sender.verify(kind)
    await expect(sender.provider.send({...input,providerTemplateId:id,subject,variables})).resolves.toMatchObject({ state:'accepted' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({TemplateID:id})
    expect(JSON.parse(fetcher.mock.calls[1][1].body).Template).toEqual({TemplateID:id,TemplateData:JSON.stringify(variables)})
    if (kind==='appeal_result') {
      const {html}=await governanceMailPreview(kind,'<证据>','<账号安排>','<复核结果>')
      expect(html).toContain('&lt;复核结果&gt;')
      expect(html).toContain('&lt;账号安排&gt;')
      expect(html).toContain('&lt;证据&gt;')
      expect(html).not.toContain('{{')
      expect(await sender.provider.send({...input,providerTemplateId:id,subject,variables:{reason:'incomplete'}})).toMatchObject({state:'rejected'})
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  })
  it('preserves uncertain results, disallows unlisted recipients and disables delivery by default',async()=>{
    const fetcher=vi.fn().mockRejectedValue(new Error('timeout'))
    const sender=governanceDelivery(config,fetcher)!
    expect((await sender.provider.send({...input,to:'other@example.invalid'})).state).toBe('rejected')
    expect(fetcher).not.toHaveBeenCalled()
    expect((await sender.provider.send(input)).state).toBe('unknown')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(governanceDelivery({})).toBeNull()
    expect(governanceDelivery({...config,GOVERNANCE_SES_WARNING_TEMPLATE_ID:'238308'},fetcher)).toBeNull()
    expect(governanceDelivery({...config,ADMIN_EMAIL_TENCENT_TEMPLATE_ID:'238309'},fetcher)).toBeNull()
  })
})
