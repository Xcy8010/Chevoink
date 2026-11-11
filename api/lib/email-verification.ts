import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { EmailVerificationPurpose, Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { DataAccessError, prisma } from './prisma.js'
import { EMAIL_CODE_COOLDOWN_SECONDS, emailCodeConfig, sendTencentEmailCode } from './tencent-ses.js'

type CodeScope = { email: string; purpose: EmailVerificationPurpose; userId: string | null }
const hourMs = 3_600_000
const maxAttempts = 5

const digest = (value: string) => createHmac('sha256', env.authSessionSecret).update(value).digest('hex')
const codeDigest = (id: string, code: string) => digest(`account-email-code:${id}:${code}`)

export async function lockAccountKey(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

export async function sendAccountEmailCode(scope: CodeScope, requester: string, deliver: boolean) {
  const config = emailCodeConfig()
  const requesterKey = digest(`account-email-requester:${requester}`)
  const id = randomUUID()
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expireInSeconds = config.emailCodeExpireMinutes * 60

  const shouldSend = await prisma.$transaction(async tx => {
    await lockAccountKey(tx, `account-email-send-ip:${requesterKey}`)
    await lockAccountKey(tx, `account-email-send-address:${scope.email}`)
    const now = Date.now()
    const dayStart = new Date(now - 24 * hourMs)
    const hourStart = new Date(now - hourMs)
    const [recentAddress, requesterDay, requesterHour] = await Promise.all([
      tx.emailVerificationCode.findMany({
        where: { email: scope.email, createdAt: { gte: dayStart } },
        select: { createdAt: true, expiresAt: true, sendState: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      tx.emailVerificationCode.count({ where: { requesterKey, createdAt: { gte: dayStart } } }),
      tx.emailVerificationCode.count({ where: { requesterKey, createdAt: { gte: hourStart } } }),
    ])
    const latest = recentAddress[0]
    const cooldownStart = now - EMAIL_CODE_COOLDOWN_SECONDS * 1000
    if (latest && +latest.createdAt > cooldownStart) {
      throw new DataAccessError(429, 'EMAIL_CODE_COOLDOWN', '请稍候再获取验证码。')
    }
    if (recentAddress.length >= 10 || recentAddress.filter(item => item.createdAt >= hourStart).length >= 5
      || requesterDay >= 30 || requesterHour >= 10) {
      throw new DataAccessError(429, 'RATE_LIMITED', '验证码请求过于频繁，请稍后再试。')
    }

    const uncertain = recentAddress.some(item => ['pending', 'unknown'].includes(item.sendState) && +item.expiresAt > now)
    const send = deliver && !uncertain
    await tx.emailVerificationCode.create({
      data: { ...scope, id, requesterKey, codeHash: codeDigest(id, code),
        expiresAt: new Date(now + expireInSeconds * 1000), sendState: send ? 'pending' : 'suppressed' },
    })
    return send
  })

  if (shouldSend) {
    // Return after the reservation in both branches so provider latency cannot
    // expose whether the target account exists. Never replay a pending send.
    void sendTencentEmailCode(scope.email, code, config).then(result =>
      prisma.emailVerificationCode.update({
        where: { id }, data: { sendState: result.state, providerRequestId: result.requestId },
      }),
    ).catch(() => console.warn('[email-verification] could not record provider outcome', id))
  }

  return { ok: true, expireInSeconds, cooldownSeconds: EMAIL_CODE_COOLDOWN_SECONDS }
}

export function invalidAccountCode() {
  return new DataAccessError(400, 'AUTH_CODE_INVALID', '验证码不正确或已失效，请重新获取。')
}

export async function prepareAccountEmailCode(scope: CodeScope, code: string) {
  const record = await prisma.emailVerificationCode.findFirst({
    where: { ...scope, sendState: { not: 'suppressed' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!record || record.consumedAt || record.expiresAt <= new Date()
    || record.attempts >= maxAttempts || ['rejected', 'suppressed'].includes(record.sendState)) {
    throw invalidAccountCode()
  }
  const available = (now: Date): Prisma.EmailVerificationCodeWhereInput => ({
    id: record.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: maxAttempts },
    sendState: { in: ['accepted', 'pending', 'unknown'] },
  })
  if (!timingSafeEqual(Buffer.from(record.codeHash, 'hex'), Buffer.from(codeDigest(record.id, code), 'hex'))) {
    await prisma.emailVerificationCode.updateMany({
      where: available(new Date()), data: { attempts: { increment: 1 } },
    })
    throw invalidAccountCode()
  }

  return async (tx: Prisma.TransactionClient) => {
    const now = new Date()
    // A concurrent resend supersedes an older code for the same purpose/owner.
    await lockAccountKey(tx, `account-email-send-address:${scope.email}`)
    const latest = await tx.emailVerificationCode.findFirst({
      where: { ...scope, sendState: { not: 'suppressed' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
    })
    if (latest?.id !== record.id) throw invalidAccountCode()
    const claimed = await tx.emailVerificationCode.updateMany({
      where: available(now), data: { consumedAt: now },
    })
    if (claimed.count !== 1) throw invalidAccountCode()
  }
}
