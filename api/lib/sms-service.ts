import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import { sms } from 'tencentcloud-sdk-nodejs-sms'

import { env } from '../config/env.js'
import { prisma, DataAccessError } from './prisma.js'
import { normalizePhoneNumber } from './phone.js'
import { invalidAccountCode, lockAccountKey } from './email-verification.js'

type SmsAuthPurpose = 'login' | 'register' | 'reset_password' | 'admin_login' | 'admin_bind' | 'bind_phone' | 'change_password'
type AccountSmsOptions = { userId: string | null; deliver: boolean }

const SmsClient = sms.v20210111.Client

function ensureSmsConfigured() {
  if (env.smsProviderMode !== 'provider') {
    throw new DataAccessError(503, 'SMS_PROVIDER_UNAVAILABLE', '短信服务尚未配置完成。')
  }
}

function hashVerificationCode(phone: string, purpose: SmsAuthPurpose, code: string, ownerId?: string | null): string {
  return createHash('sha256')
    .update(`${env.authSessionSecret}:${phone}:${purpose}:${code}${ownerId === undefined ? '' : `:account:${ownerId ?? '-'}`}`)
    .digest('hex')
}

function buildCode(): string {
  const max = 10 ** Math.max(4, env.smsCodeLength)
  const min = 10 ** Math.max(3, env.smsCodeLength - 1)

  return String(randomInt(min, max))
}

function buildSmsClient() {
  ensureSmsConfigured()

  return new SmsClient({
    credential: {
      secretId: env.smsTencentSecretId,
      secretKey: env.smsTencentSecretKey,
    },
    region: env.smsTencentRegion,
    profile: {
      httpProfile: {
        reqMethod: 'POST',
        reqTimeout: 10,
        endpoint: 'sms.tencentcloudapi.com',
      },
    },
  })
}

/** 腾讯云短信拒发时把平台状态码映射为友好中文文案，避免英文原文直出用户 */
function tencentSendFailureMessage(code: string, message: string): string {
  const haystack = `${code} ${message}`.toLowerCase()

  if (haystack.includes('every day') || haystack.includes('daily')) {
    return '该手机号今日验证码发送次数已达上限，请明天再试。'
  }
  if (haystack.includes('hour')) {
    return '该手机号获取验证码过于频繁，请稍后再试。'
  }
  if (haystack.includes('minute') || haystack.includes('frequency')) {
    return '发送过于频繁，请稍后再试。'
  }
  if (haystack.includes('blacklist')) {
    return '该手机号暂无法接收验证码，请稍后再试或使用密码登录。'
  }

  return '验证码发送失败，请稍后再试。'
}

async function ensureSmsSendAllowed(phone: string, purpose: SmsAuthPurpose) {
  const now = new Date()
  const cooldownWindow = new Date(now.getTime() - env.smsCodeCooldownSeconds * 1000)
  const hourlyWindow = new Date(now.getTime() - 60 * 60 * 1000)

  const [cooldownCount, hourlyCount] = await prisma.$transaction([
    prisma.smsVerificationCode.count({
      where: {
        phone,
        purpose,
        createdAt: {
          gte: cooldownWindow,
        },
      },
    }),
    prisma.smsVerificationCode.count({
      where: {
        phone,
        purpose,
        createdAt: {
          gte: hourlyWindow,
        },
      },
    }),
  ])

  if (cooldownCount > 0) {
    throw new DataAccessError(
      429,
      'SMS_CODE_COOLDOWN',
      `发送过于频繁，请 ${env.smsCodeCooldownSeconds} 秒后再试。`,
    )
  }

  if (hourlyCount >= env.smsCodeHourlyLimit) {
    throw new DataAccessError(429, 'SMS_CODE_HOURLY_LIMIT', '该手机号获取验证码过于频繁，请稍后再试。')
  }
}

export async function sendAuthSmsCode(input: { phone: string; purpose: SmsAuthPurpose; account?: AccountSmsOptions }) {
  ensureSmsConfigured()

  if (!env.authSessionSecret) {
    throw new DataAccessError(500, 'AUTH_SESSION_SECRET_MISSING', '服务端认证密钥未配置。')
  }

  const phone = normalizePhoneNumber(input.phone)
  const purpose = input.purpose
  if (!input.account) await ensureSmsSendAllowed(phone, purpose)

  const code = buildCode()
  const expiresAt = new Date(Date.now() + env.smsCodeExpiresInSeconds * 1000)
  const templateParams = [code, String(Math.max(1, Math.floor(env.smsCodeExpiresInSeconds / 60)))]
  const sessionContext = JSON.stringify({
    requestId: randomUUID(),
    purpose,
  })

  const sendParams = {
    SmsSdkAppId: env.smsTencentSdkAppId,
    SignName: env.smsTencentSignName,
    TemplateId: env.smsTencentTemplateIdAuth,
    TemplateParamSet: templateParams,
    PhoneNumberSet: [phone],
    SessionContext: sessionContext,
  }
  const result = {
    ok: true,
    expireInSeconds: env.smsCodeExpiresInSeconds,
    cooldownSeconds: env.smsCodeCooldownSeconds,
    provider: 'tencentcloud' as const,
  }

  if (input.account) {
    const { userId, deliver } = input.account
    const reservation = await prisma.$transaction(async tx => {
      await lockAccountKey(tx, `account-sms-send:${phone}`)
      const now = Date.now()
      const recent = await tx.smsVerificationCode.findMany({
        where: { phone, createdAt: { gte: new Date(now - 3_600_000) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, expiresAt: true, sendState: true },
        take: env.smsCodeHourlyLimit,
      })
      const latest = recent[0]
      if (latest && +latest.createdAt > now - env.smsCodeCooldownSeconds * 1000) {
        throw new DataAccessError(429, 'SMS_CODE_COOLDOWN', '请稍候再获取验证码。')
      }
      if (recent.length >= env.smsCodeHourlyLimit) {
        throw new DataAccessError(429, 'SMS_CODE_HOURLY_LIMIT', '验证码请求过于频繁，请稍后再试。')
      }
      const uncertain = recent.some(item => (item.sendState === 'pending' || item.sendState === 'unknown') && +item.expiresAt > now)
      const shouldSend = deliver && !uncertain
      const record = await tx.smsVerificationCode.create({
        data: { phone, purpose, userId, codeHash: hashVerificationCode(phone, purpose, code, userId),
          expiresAt, sendState: shouldSend ? 'pending' : 'suppressed' },
        select: { id: true },
      })
      return { id: record.id, shouldSend }
    })
    if (reservation.shouldSend) {
      void Promise.resolve().then(() => buildSmsClient().SendSms(sendParams))
        .then(reply => reply.SendStatusSet?.[0]).catch(() => undefined)
        .then(status => prisma.smsVerificationCode.update({
          where: { id: reservation.id },
          data: { sendState: status?.Code === 'Ok' ? 'accepted' : status?.Code ? 'rejected' : 'unknown' },
        })).catch(() => console.warn('[sms] could not record provider outcome', reservation.id))
    }
    return result
  }

  const response = await buildSmsClient().SendSms(sendParams)
  const status = response.SendStatusSet?.[0]
  if (!status || status.Code !== 'Ok') {
    console.warn('[sms] tencent send rejected:', status?.Code ?? 'unknown', status?.Message ?? '')
    throw new DataAccessError(
      502,
      'SMS_SEND_FAILED',
      tencentSendFailureMessage(status?.Code ?? '', status?.Message ?? ''),
    )
  }

  const user = await prisma.user.findFirst({
    where: {
      phone,
    },
    select: {
      id: true,
    },
  })

  await prisma.smsVerificationCode.create({
    data: {
      phone,
      purpose,
      userId: user?.id ?? null,
      codeHash: hashVerificationCode(phone, purpose, code),
      expiresAt,
      provider: 'tencentcloud',
      meta: {
        serialNo: status.SerialNo ?? null,
        sessionContext,
      },
    },
  })

  return result
}

type SmsCodeInput = { phone: string; purpose: SmsAuthPurpose; code: string; ownerId?: string | null }

export async function prepareAuthSmsCode(input: SmsCodeInput) {
  if (!env.authSessionSecret) {
    throw new DataAccessError(500, 'AUTH_SESSION_SECRET_MISSING', '服务端认证密钥未配置。')
  }

  const phone = normalizePhoneNumber(input.phone)
  const purpose = input.purpose
  const code = input.code.trim()
  const invalidCode = () => input.ownerId === undefined
    ? new DataAccessError(400, 'SMS_CODE_INVALID', '验证码已失效或不存在，请重新获取。')
    : invalidAccountCode()

  if (!/^\d{4,8}$/.test(code)) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '验证码格式不正确。')
  }

  // A consumed or expired newest record must not revive an older code.
  const record = await prisma.smsVerificationCode.findFirst({
    where: { phone, purpose, ...(input.ownerId === undefined ? {} : { userId: input.ownerId, sendState: { in: ['pending', 'accepted', 'rejected', 'unknown'] } }) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })

  if (!record || record.consumedAt || record.expiresAt <= new Date()
    || record.sendState === 'suppressed' || record.sendState === 'rejected') {
    throw invalidCode()
  }

  if (record.attempts >= 5) {
    if (input.ownerId !== undefined) throw invalidCode()
    throw new DataAccessError(429, 'SMS_CODE_ATTEMPTS_EXCEEDED', '验证码尝试次数过多，请重新获取。')
  }

  const availableRecord = (now: Date): Prisma.SmsVerificationCodeWhereInput => ({
    id: record.id,
    consumedAt: null,
    expiresAt: { gt: now },
    attempts: { lt: 5 },
    ...(input.ownerId === undefined ? {} : { sendState: { in: ['accepted', 'pending', 'unknown'] } }),
  })
  const codeHash = hashVerificationCode(phone, purpose, code, input.ownerId)
  if (record.codeHash.length !== codeHash.length ||
    !timingSafeEqual(Buffer.from(codeHash), Buffer.from(record.codeHash))) {
    await prisma.smsVerificationCode.updateMany({
      where: availableRecord(new Date()),
      data: {
        attempts: {
          increment: 1,
        },
      },
    })
    if (input.ownerId !== undefined) throw invalidCode()
    throw new DataAccessError(400, 'SMS_CODE_INVALID', '验证码错误。')
  }

  return {
    phone,
    async consume(db: Pick<Prisma.TransactionClient, 'smsVerificationCode' | '$executeRaw'>) {
      if (input.ownerId !== undefined) {
        await lockAccountKey(db, `account-sms-send:${phone}`)
        const latest = await db.smsVerificationCode.findFirst({
          where: { phone, purpose, userId: input.ownerId, sendState: { in: ['pending', 'accepted', 'rejected', 'unknown'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        })
        if (latest?.id !== record.id) {
          throw invalidCode()
        }
      }
      const now = new Date()
      const claimed = await db.smsVerificationCode.updateMany({
        where: availableRecord(now),
        data: { consumedAt: now },
      })
      if (claimed.count !== 1) {
        throw invalidCode()
      }
    },
  }
}

export async function verifyAuthSmsCode(input: SmsCodeInput) {
  const proof = await prepareAuthSmsCode(input)
  await proof.consume(prisma)
  return { phone: proof.phone }
}
