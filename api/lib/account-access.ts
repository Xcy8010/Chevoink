import type { Request, RequestHandler } from 'express'
import { accountEmailAuthEnabled, requiresStudioPhoneVerification } from './account-email-auth-scope.js'
import { selectAppRelease } from './app-releases.js'
import { getPublicSessionUserId, getSessionUserId, sessionMissingLegacyEmail } from './auth-session.js'
import { createRequestId } from './http.js'
import { DataAccessError, prisma } from './prisma.js'
import { sendRouteError } from './route-error.js'

export function accountAccessError(phoneVerificationRequired: boolean, studio: boolean) {
  if (studio && phoneVerificationRequired) return new DataAccessError(403, 'AUTH_PHONE_VERIFICATION_REQUIRED', '进入创作区前，请先验证手机号。')
}

async function requiresEmailBinding(req: Request) {
  if (!sessionMissingLegacyEmail(req) || !accountEmailAuthEnabled()) return false
  const selection = await selectAppRelease(req)
  return selection.release?.capabilities.includes('legacyEmailBinding') === true
}

export async function assertLegacyEmailBound(req: Request) {
  if (await requiresEmailBinding(req)) throw emailBindingRequired()
}

function emailBindingRequired() {
  return new DataAccessError(403, 'AUTH_EMAIL_BIND_REQUIRED', '请先绑定邮箱。')
}

export async function assertStudioAccountAccess(userId: string, enabled = accountEmailAuthEnabled()) {
  const user = await readAccountAccess(userId)
  const error = accountAccessError(requiresStudioPhoneVerification(user, enabled), true)
  if (error) throw error
}

async function readAccountAccess(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true, isSuperAdmin: true, bannedAt: true,
      emailVerifiedAt: true, phoneVerifiedAt: true, phone: true, accountSetupStep: true, accountSetupFinishedAt: true,
    },
  })
  if (!user) throw new DataAccessError(401, 'AUTH_INVALID_SESSION', '登录状态已失效，请重新登录。')
  return user
}

export function isStudioAccountRoute(path: string, method: string) {
  if (/^\/(?:agent|changesets)(?:\/|$)/.test(path)) return true
  if (/^\/credits\/tasks(?:\/|$)/.test(path)) return true
  if (/^\/ai\/(?:cover-prompt|cover-image|outline|chapter-assist)$/.test(path)) return true
  if (!/^\/novels(?:\/|$)/.test(path)) return false
  if (/^\/novels\/[^/]+\/(?:studio|structure|volumes|chapters|changesets|imports)(?:\/|$)/.test(path)) return true
  return !['GET', 'HEAD'].includes(method) && !/^\/novels\/[^/]+\/favorite$/.test(path)
}

export const accountAccessGuard: RequestHandler = async (req, res, next) => {
  if (req.method === 'OPTIONS') return next()
  const path = req.path.toLowerCase().replace(/\/$/, '')
  const studio = isStudioAccountRoute(path, req.method)
  try {
    const read = req.method === 'GET' || req.method === 'HEAD'
    const publicRead = read && ['/health', '/meta', '/site-content', '/credits/public-policy'].includes(path)
    const authFlow = /^\/auth(?:\/|$)/.test(path) && !/^\/auth\/account(?:\/|$)/.test(path)
    const recoveryPath = authFlow || /^\/auth\/account\/(?:email|password(?:\/send-code)?)$/.test(path)
      || /^\/(?:admin|local-model-connector)(?:\/|$)/.test(path) || path === '/feedback'
    if (!publicRead && !recoveryPath && await requiresEmailBinding(req)) {
      if (!read || (path !== '/users/me' && path !== '/home')) throw emailBindingRequired()
      res.locals.emailBindingRequired = true
    }
    if (!studio && !/^\/novels(?:\/|$)/.test(path)) return next()
    const enabled = accountEmailAuthEnabled()
    const userId = !enabled && !studio ? getPublicSessionUserId(req) : getSessionUserId(req)
    if (userId) {
      const user = await readAccountAccess(userId)
      const phoneVerificationRequired = requiresStudioPhoneVerification(user, enabled)
      const error = accountAccessError(phoneVerificationRequired, studio)
      if (error) throw error
      res.locals.allowStudioOwnerAccess = !phoneVerificationRequired
    }
    next()
  } catch (error) {
    sendRouteError(res, createRequestId(), error)
  }
}
