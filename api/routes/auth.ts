import { readPublicSiteContent } from '../lib/site-content.js'
import { legalConsentSchema } from '../../shared/contracts/site-content.js'
import { Router, type Request, type Response } from 'express'
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
import { getUserByPhoneData, loginUserData, registerUserData } from '../lib/data-access.js'
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
    const body = parseBody(loginSchema, req.body, '请输入手机号和密码。')

    const user = await loginUserData(body.phone.trim(), body.password)
    if (!user) {
      res.status(401).json(buildError(requestId, 'AUTH_INVALID_CREDENTIALS', '手机号或密码不正确。'))
      return
    }

    const tokens = await createSession(user.id, res)
    res.status(200).json(buildSuccess(requestId, { user, tokens }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/sms/login', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const body = parseBody(smsLoginSchema, req.body, '请输入手机号和验证码。')

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
