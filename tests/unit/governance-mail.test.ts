import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { governanceDelivery, governanceMailPreview, governanceMailVariables } from '../../api/lib/governance-mail'
const config = { GOVERNANCE_MAIL_MODE:'tencent-allowlist', GOVERNANCE_SES_SECRET_ID:'synthetic', GOVERNANCE_SES_SECRET_KEY:'synthetic',
  GOVERNANCE_SES_ALLOWLIST:'case@example.invalid', GOVERNANCE_SES_REPLY_TO:'case@example.invalid', GOVERNANCE_SES_ENFORCEMENT_TEMPLATE_ID:'10' }
const input = { attemptId:'event-123',to:'case@example.invalid',from:'notice@chevolink.com',replyTo:'case@example.invalid',
  subject:'【启创墨域】账号使用限制通知',providerTemplateId:10,variables:governanceMailVariables('enforcement','<理由>','7 天') }
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
    expect(payload).toMatchObject({FromEmailAddress:input.from,Destination:[input.to],Subject:input.subject,Template:{TemplateID:10,TemplateData:JSON.stringify(input.variables)}})
    expect(payload).not.toHaveProperty('Unsubscribe')
    fetcher.mockResolvedValueOnce(Response.json({Response:{RequestId:'read',TemplateStatus:0,TemplateContent:{Html:source.toString('base64'),Text:Buffer.from('other content').toString('base64')}}}))
    await expect(sender.verify('enforcement')).rejects.toThrow()
  })
  it('preserves uncertain results, disallows unlisted recipients and disables delivery by default',async()=>{
    const fetcher=vi.fn().mockRejectedValue(new Error('timeout'))
    const sender=governanceDelivery(config,fetcher)!
    expect((await sender.provider.send({...input,to:'other@example.invalid'})).state).toBe('rejected')
    expect(fetcher).not.toHaveBeenCalled()
    expect((await sender.provider.send(input)).state).toBe('unknown')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(governanceDelivery({})).toBeNull()
    await expect(sender.verify('appeal_result')).rejects.toThrow()
  })
})
