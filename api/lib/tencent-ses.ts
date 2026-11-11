import { createHash, createHmac } from 'node:crypto'
import { env } from '../config/env.js'
import { DataAccessError } from './prisma.js'

const endpoint = 'ses.tencentcloudapi.com'
const action = 'SendEmail'
const contentType = 'application/json; charset=utf-8'
export const EMAIL_CODE_COOLDOWN_SECONDS = 60

export function emailCodeConfig() {
  const { emailTencentSecretId, emailTencentSecretKey, emailTencentRegion, emailTencentFromAddress,
    emailTencentTemplateId, emailCodeExpireMinutes, authSessionSecret } = env
  if (!emailTencentSecretId || !emailTencentSecretKey || !authSessionSecret
    || emailTencentRegion !== 'ap-hongkong'
    || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(emailTencentFromAddress)
    || !Number.isSafeInteger(emailTencentTemplateId) || emailTencentTemplateId < 1
    || !Number.isSafeInteger(emailCodeExpireMinutes) || emailCodeExpireMinutes < 1 || emailCodeExpireMinutes > 30) {
    throw new DataAccessError(503, 'EMAIL_PROVIDER_UNAVAILABLE', '邮箱验证码服务暂不可用，请稍后重试。')
  }
  return { emailTencentSecretId, emailTencentSecretKey, emailTencentRegion, emailTencentFromAddress,
    emailTencentTemplateId, emailCodeExpireMinutes }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest()

type SendResult = { state: 'accepted' | 'rejected' | 'unknown'; requestId?: string }

/** Tencent API 3.0 TC3 signing over the exact UTF-8 JSON body. One provider call per reservation. */
export async function sendTencentEmailCode(
  email: string,
  code: string,
  config: ReturnType<typeof emailCodeConfig>,
): Promise<SendResult> {
  const body = JSON.stringify({
    FromEmailAddress: `启创墨域 <${config.emailTencentFromAddress}>`,
    Destination: [email],
    Subject: '【启创墨域】邮箱验证码',
    Template: {
      TemplateID: config.emailTencentTemplateId,
      TemplateData: JSON.stringify({ code, expire_minutes: String(config.emailCodeExpireMinutes) }),
    },
  })
  const now = new Date()
  const timestamp = Math.floor(now.getTime() / 1000)
  const date = now.toISOString().slice(0, 10)
  const scope = `${date}/ses/tc3_request`
  const signedHeaders = 'content-type;host;x-tc-action'
  const headers = `content-type:${contentType}\nhost:${endpoint}\nx-tc-action:${action.toLowerCase()}\n`
  const canonical = ['POST', '/', '', headers, signedHeaders, sha256(body)].join('\n')
  const toSign = ['TC3-HMAC-SHA256', timestamp, scope, sha256(canonical)].join('\n')
  const signingKey = hmac(hmac(hmac(`TC3${config.emailTencentSecretKey}`, date), 'ses'), 'tc3_request')
  const signature = hmac(signingKey, toSign).toString('hex')

  try {
    const response = await fetch(`https://${endpoint}/`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-TC-Action': action,
        'X-TC-Version': '2020-10-02',
        'X-TC-Region': config.emailTencentRegion,
        'X-TC-Timestamp': String(timestamp),
        Authorization: `TC3-HMAC-SHA256 Credential=${config.emailTencentSecretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
    })
    const result = await response.json() as { Response?: { RequestId?: string; MessageId?: string; Error?: { Code?: string } } }
    const reply = result.Response
    const requestId = typeof reply?.RequestId === 'string' && /^[\w-]{1,128}$/.test(reply.RequestId)
      ? reply.RequestId : undefined
    if (response.ok && reply?.MessageId && requestId && !reply.Error) return { state: 'accepted', requestId }
    if (response.status < 500 && reply?.Error?.Code && requestId) return { state: 'rejected', requestId }
    return { state: 'unknown', requestId }
  } catch {
    return { state: 'unknown' }
  }
}
