import { env } from '../config/env.js'
import { DataAccessError } from './prisma.js'
import { requestTencentSes } from './tencent-ses-client.js'

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

type SendResult = { state: 'accepted' | 'rejected' | 'unknown'; requestId?: string }

export async function sendTencentEmailCode(
  email: string,
  code: string,
  config: ReturnType<typeof emailCodeConfig>,
): Promise<SendResult> {
  try {
    const response = await requestTencentSes({
      secretId: config.emailTencentSecretId, secretKey: config.emailTencentSecretKey, region: config.emailTencentRegion,
    }, 'SendEmail', {
      FromEmailAddress: `启创墨域 <${config.emailTencentFromAddress}>`,
      Destination: [email],
      Subject: '【启创墨域】邮箱验证码',
      Template: {
        TemplateID: config.emailTencentTemplateId,
        TemplateData: JSON.stringify({ code, expire_minutes: String(config.emailCodeExpireMinutes) }),
      },
    })
    const reply = response.reply as { RequestId?: string; MessageId?: string; Error?: { Code?: string } } | undefined
    const requestId = typeof reply?.RequestId === 'string' && /^[\w-]{1,128}$/.test(reply.RequestId)
      ? reply.RequestId : undefined
    if (response.ok && reply?.MessageId && requestId && !reply.Error) return { state: 'accepted', requestId }
    if (response.status < 500 && reply?.Error?.Code && requestId) return { state: 'rejected', requestId }
    return { state: 'unknown', requestId }
  } catch {
    return { state: 'unknown' }
  }
}
