import { createHash, createHmac } from 'node:crypto'

const endpoint = 'ses.tencentcloudapi.com'
const contentType = 'application/json; charset=utf-8'
export const TENCENT_SES_TIMEOUT_MS = 8_000

export type TencentSesCredentials = {
  secretId: string
  secretKey: string
  region: string
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest()

/** Tencent API 3.0 TC3 signing over the exact UTF-8 JSON request body. */
export async function requestTencentSes(
  credentials: TencentSesCredentials,
  action: 'SendEmail' | 'GetSendEmailStatus' | 'GetEmailTemplate',
  payload: object,
  fetcher: typeof fetch = fetch,
) {
  const body = JSON.stringify(payload)
  const now = new Date()
  const timestamp = Math.floor(now.getTime() / 1000)
  const date = now.toISOString().slice(0, 10)
  const scope = `${date}/ses/tc3_request`
  const signedHeaders = 'content-type;host;x-tc-action'
  const headers = `content-type:${contentType}\nhost:${endpoint}\nx-tc-action:${action.toLowerCase()}\n`
  const canonical = ['POST', '/', '', headers, signedHeaders, sha256(body)].join('\n')
  const toSign = ['TC3-HMAC-SHA256', timestamp, scope, sha256(canonical)].join('\n')
  const signingKey = hmac(hmac(hmac(`TC3${credentials.secretKey}`, date), 'ses'), 'tc3_request')
  const signature = hmac(signingKey, toSign).toString('hex')

  const response = await fetcher(`https://${endpoint}/`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-TC-Action': action,
      'X-TC-Version': '2020-10-02',
      'X-TC-Region': credentials.region,
      'X-TC-Timestamp': String(timestamp),
      Authorization: `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(TENCENT_SES_TIMEOUT_MS),
    redirect: 'error',
  })
  const result = await response.json() as { Response?: unknown } | null
  return { ok: response.ok, status: response.status, reply: result?.Response }
}
