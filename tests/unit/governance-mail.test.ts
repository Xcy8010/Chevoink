import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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

const cloudCopies = [
  ['warning', 'chevoink-account-warning.html', 'e0cf4e8301531aea6f201590aaad51e26c1717cc771967df417d1a894522eeaf'],
  ['enforcement', 'chevoink-account-enforcement.html', 'b95aa69737f915466d0afb12923e22bc45d703449c117bf449431e0eb8426f39'],
  ['appeal_result', 'chevoink-appeal-result.html', 'f16397dcb7d2a027b6c8874cc25f71b900fbd5ded6ed1b6101af7ef10649d9e0'],
] as const

// Rebuild the three SES readbacks from the tracked originals. The independent hashes
// bind the test data to the observed UTF-8 bytes, including the leading blank line.
function cloudHtml(original: string) {
  return original.replaceAll('\r\n', '\n')
    .replace('<!DOCTYPE html>', '')
    .replace('<meta name="viewport" content="width=device-width, initial-scale=1.0">', '')
    .replace('<meta name="x-apple-disable-message-reformatting">', '')
    .replace(/<!--\[if mso\]>.*?<!\[endif\]-->/g, '')
    .replaceAll("'", '&#39;')
    .replace(/(<a\b[^>]*?)>/g, '$1 rel="nofollow noopener">')
}

function approvedResponse(html: string) {
  return Response.json({
    Response: { RequestId: 'synthetic-lookup', TemplateStatus: 0, TemplateContent: { Html: Buffer.from(html).toString('base64') } },
  })
}

describe('production governance mail', () => {
  it.each(cloudCopies)('verifies the approved SES readback for %s using a template lookup only', async (kind, file, hash) => {
    const copy = cloudHtml(await readFile('api/templates/governance/' + file, 'utf8'))
    expect(createHash('sha256').update(copy).digest('hex')).toBe(hash)
    const lookup = vi.fn<typeof fetch>().mockResolvedValue(approvedResponse(copy))
    const delivery = governanceDelivery({ ...config, GOVERNANCE_MAIL_MODE:'tencent', GOVERNANCE_SES_ALLOWLIST:'' }, lookup)
    expect(delivery).not.toBeNull()
    await delivery!.verify(kind)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(new Headers(lookup.mock.calls[0][1]?.headers).get('X-TC-Action')).toBe('GetEmailTemplate')
  })

  it.each([
    ['appeal link', '/appeal"', '/wrong"'],
    ['visible title', '申诉处理结果通知', '申诉结果已撤回'],
    ['variable', '{{reason}}', '{{measure}}'],
    ['additional content', '</body>', '<p>额外内容</p></body>'],
    ['hidden resource', '</body>', '<img src="https://example.invalid/pixel"></body>'],
  ])('rejects a different %s in an otherwise approved cloud copy', async (_name, find, replacement) => {
    const original = cloudHtml(await readFile('api/templates/governance/chevoink-appeal-result.html', 'utf8'))
    const changed = original.replace(find, replacement)
    expect(changed).not.toBe(original)
    const lookup = vi.fn<typeof fetch>().mockResolvedValue(approvedResponse(changed))
    const delivery = governanceDelivery({ ...config, GOVERNANCE_MAIL_MODE:'tencent' }, lookup)!
    expect(delivery).not.toBeNull()
    await expect(delivery.verify('appeal_result')).rejects.toThrow()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(new Headers(lookup.mock.calls[0][1]?.headers).get('X-TC-Action')).toBe('GetEmailTemplate')
  })

  it('distinguishes full production from allowlist delivery without weakening the fixed sender or template contract', async () => {
    const address = 'verified-outside-list@example.invalid'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ Response:{ RequestId:'synthetic-send',MessageId:'synthetic-accepted' } }))
    const limited = governanceDelivery(config, fetcher)!
    expect(limited.mode).toBe('tencent')
    await expect(limited.provider.send({ ...input, to:address })).resolves.toMatchObject({ state:'rejected' })
    const full = governanceDelivery({ ...config, GOVERNANCE_MAIL_MODE:'tencent' }, fetcher)
    expect(full).not.toBeNull()
    expect(full!.mode).toBe('tencent-verified')
    await expect(full!.provider.send({ ...input, to:address+',another@example.invalid' })).resolves.toMatchObject({ state:'rejected' })
    for (const changed of [{ from:'other@example.invalid' }, { replyTo:'other@example.invalid' }, { providerTemplateId:238307 }, { subject:'其他主题' }, { variables:{ reason:'缺少期限' } }]) {
      await expect(full!.provider.send({ ...input, to:address, ...changed })).resolves.toMatchObject({ state:'rejected' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    await expect(full!.provider.send({ ...input, to:address })).resolves.toMatchObject({ state:'accepted' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      Destination:[address], FromEmailAddress:input.from, Template:{ TemplateID:238308 },
    })
    expect(governanceDelivery({ ...config, GOVERNANCE_MAIL_MODE:'tencent', GOVERNANCE_SES_SECRET_KEY:'' }, fetcher)).toBeNull()
    expect(governanceDelivery({ ...config, GOVERNANCE_MAIL_MODE:'tencent', GOVERNANCE_SES_WARNING_TEMPLATE_ID:'238309' }, fetcher)).toBeNull()
  })
})
