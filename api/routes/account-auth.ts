import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { legalConsentSchema } from '../../shared/contracts/site-content.js'
import { env } from '../config/env.js'
import { verifyAuthCaptchaChallenge } from '../lib/auth-captcha.js'
import { createSession, requireSessionUserId } from '../lib/auth-session.js'
import {
  accountIdentity, accountPasswordIdentity, advanceAccountSetupData, bindAccountEmailData, bindAccountPhoneData,
  canSendBindingEmail, canSendBindingPhone, canSendRegistrationEmail, findAccountByIdentity,
  loginAccountEmailCodeData, registerEmailUserData, updateAccountPasswordWithCode,
} from '../lib/data-access.js'
import { sendAccountEmailCode } from '../lib/email-verification.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { normalizeAccountPhoneNumber } from '../lib/phone.js'
import { DataAccessError } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'
import { sendAuthSmsCode } from '../lib/sms-service.js'

const email = z.string().trim().email().max(254).transform(value => value.toLowerCase())
const identifier = z.string().trim().min(1).max(254)
const password = z.string().trim().min(6).max(128)
const code = z.string().trim().regex(/^\d{4,8}$/)
const emailCode = z.string().trim().regex(/^\d{6}$/)
const phone = z.string().trim().min(1).max(32).transform(normalizeAccountPhoneNumber)
const channel = z.enum(['email', 'sms'])
const captcha = {
  captchaId: z.string().trim().min(1).max(64),
  captchaAnswer: z.string().trim().min(1).max(16),
}

function checkCaptcha(body: { captchaId: string; captchaAnswer: string }) {
  verifyAuthCaptchaChallenge(body.captchaId, body.captchaAnswer)
}

export function accountAuthRoutes(consumeSmsIpQuota: (ip: string) => boolean) {
  const router = Router()
  router.get('/options', (_req, res) => {
    res.json(buildSuccess(createRequestId(), { emailAuthEnabled: env.accountEmailAuthEnabled }))
  })

  function post<T extends z.ZodTypeAny>(
    path: string, schema: T,
    handler: (body: z.output<T>, req: Request, res: Response) => Promise<unknown>,
    status = 200,
  ) {
    router.post(path, async (req, res) => {
      const requestId = createRequestId()
      try {
        if (!env.accountEmailAuthEnabled) throw new DataAccessError(404, 'AUTH_FEATURE_DISABLED', '此认证方式暂未启用。')
        const body = parseBody(schema, req.body, '请检查填写的信息和验证码。')
        res.status(status).json(buildSuccess(requestId, await handler(body, req, res)))
      } catch (error) {
        sendRouteError(res, requestId, error)
      }
    })
  }

  function sendSms(req: Request, phone: string, purpose: 'reset_password' | 'change_password' | 'bind_phone', userId: string | null, deliver: boolean) {
    if (!consumeSmsIpQuota(req.ip ?? 'unknown')) {
      throw new DataAccessError(429, 'RATE_LIMITED', '验证码请求过于频繁，请稍后再试。')
    }
    return sendAuthSmsCode({ phone, purpose, account: { userId, deliver } })
  }

  post('/email/send-code', z.object({ email, purpose: z.enum(['register', 'login', 'bind']), ...captcha }), async (body, req) => {
    checkCaptcha(body)
    const address = body.email
    const purpose = body.purpose
    const requester = req.ip ?? 'unknown'
    if (purpose === 'bind') {
      const userId = requireSessionUserId(req)
      return sendAccountEmailCode({ email: address, purpose, userId }, requester, await canSendBindingEmail(userId, address))
    }
    if (purpose === 'register') {
      return sendAccountEmailCode({ email: address, purpose, userId: null }, requester, await canSendRegistrationEmail(address))
    }
    const account = await findAccountByIdentity({ email: address })
    return sendAccountEmailCode({ email: address, purpose, userId: account?.id ?? null }, requester, Boolean(account && !account.bannedAt))
  })

  post('/email/register', z.object({
    email, code: emailCode, legalConsent: legalConsentSchema, referralCode: z.string().trim().max(24).optional(),
  }), async (body, _req, res) => {
    const user = await registerEmailUserData(body)
    return { user, tokens: await createSession(user.id, res) }
  }, 201)

  post('/email/login', z.object({ email, code: emailCode }), async (body, _req, res) => {
    const { user, tokenVersion } = await loginAccountEmailCodeData(body.email, body.code)
    return { user, tokens: await createSession(user.id, res, tokenVersion) }
  })

  post('/account/email', z.object({ email, code: emailCode }), async (body, req) => ({
    user: await bindAccountEmailData(requireSessionUserId(req), body.email, body.code),
  }))

  post('/account/phone/send-code', z.object({ phone, ...captcha }), async (body, req) => {
    checkCaptcha(body)
    const userId = requireSessionUserId(req)
    return sendSms(req, body.phone, 'bind_phone', userId, await canSendBindingPhone(userId, body.phone))
  })

  post('/account/phone', z.object({ phone, code }), async (body, req) => ({
    user: await bindAccountPhoneData(requireSessionUserId(req), body.phone, body.code),
  }))

  post('/reset/send-code', z.object({ identifier, ...captcha }), async (body, req) => {
    checkCaptcha(body)
    const identity = accountIdentity(body.identifier)
    const account = await findAccountByIdentity(identity, true)
    const userId = account?.id ?? null
    const deliver = Boolean(account && !account.bannedAt)
    if ('email' in identity) return sendAccountEmailCode({ ...identity, purpose: 'reset_password', userId }, req.ip ?? 'unknown', deliver)
    return sendSms(req, identity.phone, 'reset_password', userId, deliver)
  })

  post('/reset', z.object({ identifier, code, password }), async (body) => {
    await updateAccountPasswordWithCode(accountIdentity(body.identifier), 'reset_password', body.code, body.password)
    return { ok: true }
  })

  post('/account/password/send-code', z.object({ channel, ...captcha }), async (body, req) => {
    checkCaptcha(body)
    const userId = requireSessionUserId(req)
    const identity = await accountPasswordIdentity(userId, body.channel)
    if ('email' in identity) return sendAccountEmailCode({ ...identity, purpose: 'change_password', userId }, req.ip ?? 'unknown', true)
    return sendSms(req, identity.phone, 'change_password', userId, true)
  })

  post('/account/password', z.object({ channel, code, password }), async (body, req, res) => {
    const userId = requireSessionUserId(req)
    const identity = await accountPasswordIdentity(userId, body.channel)
    const { user, tokenVersion } = await updateAccountPasswordWithCode(identity, 'change_password', body.code, body.password, userId)
    return { user, tokens: await createSession(user.id, res, tokenVersion) }
  })

  post('/account/setup', z.object({
    step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    skip: z.boolean(),
  }), async (body, req) => ({
    user: await advanceAccountSetupData(requireSessionUserId(req), body.step, body.skip),
  }))

  return router
}
