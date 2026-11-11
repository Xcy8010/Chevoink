import { readPublicSiteContent } from '../lib/site-content.js'
import { legalConsentSchema } from '../../shared/contracts/site-content.js'
import { Router, type Request, type Response } from 'express'
import { accountEmailAuthEnabled, assertPreviewSmsSendAllowed } from '../lib/account-email-auth-scope.js'
import { accountAuthRoutes } from './account-auth.js'
import { z } from 'zod'

import type {
  GetAuthCaptchaResponse,
  SmsAccountStatus,
} from '../../shared/contracts/index.js'
import { createAuthCaptchaChallenge, verifyAuthCaptchaChallenge } from '../lib/auth-captcha.js'
import {
  clearSession,
  createSession,
  getSessionUserId,
  revokeUserSessions,
} from '../lib/auth-session.js'
import {
  accountIdentity, findAccountByIdentity, getUserByPhoneData, loginAccountSmsCodeData, loginAccountUserData,
  loginUserData, registerUserData,
} from '../lib/data-access.js'
import { DataAccessError } from '../lib/prisma.js'
import { buildError, buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { sendRouteError } from '../lib/route-error.js'
import { normalizePhoneNumber } from '../lib/phone.js'
import { sendAuthSmsCode, verifyAuthSmsCode } from '../lib/sms-service.js'

const router = Router()
router.get('/legal-policies',async(_req:Request,res:Response)=>{
  const requestId=createRequestId()
  try{const {legal}=await readPublicSiteContent();res.json(buildSuccess(requestId,{legal}))}catch(error){sendRouteError(res,requestId,error)}
})

/* ---------------- 请求体校验 schema（文案与历史提示保持一致） ---------------- */

const sendSmsCodeSchema = z.object({
  phone: z.string().min(1),
  purpose: z.enum(['login', 'register', 'auth']),
  captchaId: z.string().min(1),
  captchaAnswer: z.string().min(1),
})

const smsRegisterSchema = z.object({
  phone: z.string().min(1),
  code: z.string().min(1),
  password: z.string().optional(),
  referralCode: z.string().max(24).optional(),
  legalConsent: legalConsentSchema.optional(),
})
const legacyRegisterSchema = smsRegisterSchema.extend({
  email: z.string().optional(),
  nickname: z.string().min(1),
})

const loginSchema = z.object({
  phone: z.string().min(1),
  password: z.string().min(1),
})

const accountLoginSchema = z.union([
  z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().trim().min(1).max(1024) }),
  loginSchema,
])

const smsLoginSchema = z.object({
  phone: z.string().min(1),
  code: z.string().min(1),
})

/* ---------------- 发码接口 IP 维度限流（小时/天双窗口） ---------------- */

// 手机号维度冷却与小时上限在 sms-service 内；这里补 IP 维度，
// 拦截换号批量刷验证码的脚本（正常用户单 IP 每小时远低于 10 条）
const SMS_IP_HOURLY_LIMIT = 10
const SMS_IP_DAILY_LIMIT = 30
const smsIpHourlyBuckets = new Map<string, { count: number; resetAt: number }>()
const smsIpDailyBuckets = new Map<string, { count: number; resetAt: number }>()

function consumeSmsIpQuota(ip: string): boolean {
  const now = Date.now()
  const windows = [
    { buckets: smsIpHourlyBuckets, windowMs: 3_600_000, limit: SMS_IP_HOURLY_LIMIT },
    { buckets: smsIpDailyBuckets, windowMs: 86_400_000, limit: SMS_IP_DAILY_LIMIT },
  ]

  for (const { buckets, windowMs, limit } of windows) {
    const bucket = buckets.get(ip)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(ip, { count: 1, resetAt: now + windowMs })
      continue
    }
    if (bucket.count >= limit) {
      return false
    }
    bucket.count += 1
  }

  // 防 Map 无限增长：超阈值清空重置（影响仅为限流窗口重置）
  if (smsIpHourlyBuckets.size > 5000) {
    smsIpHourlyBuckets.clear()
  }
  if (smsIpDailyBuckets.size > 5000) {
    smsIpDailyBuckets.clear()
  }
  return true
}

const passwordAttemptBuckets = new Map<string, number>()
let passwordWindowEnd = 0
function consumePasswordAttempt(ip: string) {
  const now = Date.now()
  if (now >= passwordWindowEnd) {
    passwordAttemptBuckets.clear()
    passwordWindowEnd = now + 5 * 60_000
  }
  const count = passwordAttemptBuckets.get(ip) ?? 0
  if (count >= 20) return false
  passwordAttemptBuckets.set(ip, count + 1)
  return true
}

router.use(accountAuthRoutes(consumeSmsIpQuota))

router.get('/captcha', (_req: Request, res: Response): void => {
  const requestId = createRequestId()
  const challenge = createAuthCaptchaChallenge()

  res.status(200).json(buildSuccess<GetAuthCaptchaResponse['data']>(requestId, challenge))
})

router.post('/sms/send-code', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const body = parseBody(sendSmsCodeSchema, req.body, '请先完成人机验证，再获取验证码。')

    const phone = normalizePhoneNumber(body.phone)
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())

    if (!consumeSmsIpQuota(req.ip ?? 'unknown')) {
      res.status(429).json(buildError(requestId, 'RATE_LIMITED', '验证码请求过于频繁，请稍后再试。'))
      return
    }

    if (accountEmailAuthEnabled()) {
      if (body.purpose === 'register') throw new DataAccessError(400, 'AUTH_EMAIL_REGISTRATION_REQUIRED', '请使用邮箱注册。')
      assertPreviewSmsSendAllowed()
      const account = await findAccountByIdentity({ phone })
      const payload = await sendAuthSmsCode({
        phone, purpose: 'login', account: { userId: account?.id ?? null, deliver: Boolean(account && !account.bannedAt) },
      })
      res.json(buildSuccess(requestId, { ...payload, accountStatus: 'existing', normalizedPhone: phone }))
      return
    }

    const existingUser = await getUserByPhoneData(phone)
    const accountStatus: SmsAccountStatus = existingUser ? 'existing' : 'new'

    if (body.purpose === 'login' && !existingUser) {
      res.status(404).json(buildError(requestId, 'AUTH_ACCOUNT_NOT_FOUND', '该手机号尚未注册。'))
      return
    }

    const payload = await sendAuthSmsCode({
      phone,
      purpose: body.purpose === 'auth' ? (existingUser ? 'login' : 'register') : body.purpose,
    })

    res.status(200).json(
      buildSuccess(requestId, {
        ...payload,
        accountStatus,
        normalizedPhone: phone,
      }),
    )
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

async function registerWithSms(req: Request, res: Response, schema: typeof smsRegisterSchema | typeof legacyRegisterSchema): Promise<void> {
  const requestId = createRequestId()

  try {
    if (accountEmailAuthEnabled()) throw new DataAccessError(400, 'AUTH_EMAIL_REGISTRATION_REQUIRED', '请使用邮箱注册。')
    const body = parseBody(schema, req.body, '请输入手机号和验证码。')
    const user = await registerUserData({
      ...body,
      password: body.password?.trim() || undefined,
      referralCode: body.referralCode?.trim() || undefined,
    })

    const tokens = await createSession(user.id, res)
    res.status(201).json(buildSuccess(requestId, { user, tokens }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
}

router.post('/register', (req, res) => registerWithSms(req, res, legacyRegisterSchema))
router.post('/sms/register', (req, res) => registerWithSms(req, res, smsRegisterSchema))

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const enabled = accountEmailAuthEnabled()
    const body = parseBody(accountLoginSchema, req.body, enabled ? '请输入您的邮箱或手机号和密码。' : '请输入手机号和密码。')
    const identity = 'identifier' in body ? body.identifier : body.phone
    if (enabled && !consumePasswordAttempt(req.ip ?? 'unknown')) {
      throw new DataAccessError(429, 'RATE_LIMITED', '登录尝试过于频繁，请稍后再试。')
    }
    const verified = enabled
      ? await loginAccountUserData('identifier' in body ? accountIdentity(identity) : { phone: normalizePhoneNumber(identity) }, body.password.trim())
      : null
    const user = enabled ? verified?.user : await loginUserData(identity, body.password)
    if (!user) {
      res.status(401).json(buildError(requestId, 'AUTH_INVALID_CREDENTIALS', enabled ? '邮箱、手机号或密码不正确。' : '手机号或密码不正确。'))
      return
    }

    const tokens = await createSession(user.id, res, verified?.tokenVersion)
    res.status(200).json(buildSuccess(requestId, { user, tokens }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/sms/login', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const body = parseBody(smsLoginSchema, req.body, '请输入手机号和验证码。')

    if (accountEmailAuthEnabled()) {
      const { user, tokenVersion } = await loginAccountSmsCodeData(normalizePhoneNumber(body.phone), body.code)
      const tokens = await createSession(user.id, res, tokenVersion)
      res.json(buildSuccess(requestId, { user, tokens }))
      return
    }

    const { phone } = await verifyAuthSmsCode({
      phone: body.phone,
      purpose: 'login',
      code: body.code,
    })

    const user = await getUserByPhoneData(phone)
    if (!user) {
      res.status(404).json(buildError(requestId, 'AUTH_ACCOUNT_NOT_FOUND', '该手机号尚未注册。'))
      return
    }

    const tokens = await createSession(user.id, res)
    res.status(200).json(buildSuccess(requestId, { user, tokens }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    // 登出即吊销该用户全部 v2 会话令牌（tokenVersion+1），Bearer 通道随之失效
    const userId = getSessionUserId(req)
    if (userId) {
      await revokeUserSessions(userId)
    }
  } catch (error) {
    sendRouteError(res, requestId, error)
    return
  }
  clearSession(res)
  res.status(200).json(buildSuccess(requestId, { ok: true }))
})

export default router
