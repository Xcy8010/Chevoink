import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendTencentEmailCode } from '../../api/lib/tencent-ses.js'

const config = {
  emailTencentSecretId: 'test-key-id',
  emailTencentSecretKey: 'synthetic-signing-key',
  emailTencentRegion: 'ap-hongkong',
  emailTencentFromAddress: 'chevoink@example.test',
  emailTencentTemplateId: 1,
  emailCodeExpireMinutes: 5,
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Tencent SES verification adapter', () => {
  it('sends one signed request with the approved template fields and a code-free subject', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T00:00:00.000Z'))
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      Response: { MessageId: 'accepted-id', RequestId: 'request-id' },
    }))
    vi.stubGlobal('fetch', transport)
    const result = await sendTencentEmailCode('recipient@example.test', '081462', config)
    expect(result).toEqual({ state: 'accepted', requestId: 'request-id' })
    expect(transport).toHaveBeenCalledTimes(1)
    const [url, request] = transport.mock.calls[0]
    expect(url).toBe('https://ses.tencentcloudapi.com/')
    const headers = new Headers(request?.headers)
    expect(headers.get('X-TC-Action')).toBe('SendEmail')
    expect(headers.get('X-TC-Region')).toBe('ap-hongkong')
    expect(headers.get('Authorization')).toMatch(/^TC3-HMAC-SHA256 Credential=test-key-id\/2026-11-12\/ses\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/)
    const body = JSON.parse(String(request?.body))
    expect(body).toEqual({
      FromEmailAddress: '启创墨域 <chevoink@example.test>',
      Destination: ['recipient@example.test'],
      Subject: '【启创墨域】邮箱验证码',
      Template: { TemplateID: 1, TemplateData: '{"code":"081462","expire_minutes":"5"}' },
    })
  })

  it('records an explicit rejection without returning provider error details', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      Response: { RequestId: 'request-id', Error: { Code: 'FailedOperation', Message: 'private diagnostic' } },
    }))
    vi.stubGlobal('fetch', transport)
    expect(await sendTencentEmailCode('recipient@example.test', '081462', config))
      .toEqual({ state: 'rejected', requestId: 'request-id' })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('preserves an unknown result and never retries a provider timeout', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError'))
    vi.stubGlobal('fetch', transport)
    expect(await sendTencentEmailCode('recipient@example.test', '081462', config)).toEqual({ state: 'unknown' })
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
