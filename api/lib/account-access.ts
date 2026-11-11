import type { RequestHandler } from 'express'
import { env } from '../config/env.js'
import { getSessionUserId } from './auth-session.js'
import { createRequestId } from './http.js'
import { DataAccessError, prisma } from './prisma.js'
import { sendRouteError } from './route-error.js'

export function accountAccessError(emailVerified: boolean, phoneVerified: boolean, studio: boolean) {
  if (!emailVerified) return new DataAccessError(403, 'AUTH_EMAIL_BIND_REQUIRED', '请先验证并绑定邮箱。')
  if (studio && !phoneVerified) return new DataAccessError(403, 'AUTH_PHONE_VERIFICATION_REQUIRED', '进入创作区前，请先验证手机号。')
}

export async function assertStudioAccountAccess(userId: string) {
  if (!env.accountEmailAuthEnabled) return
  const user = await readAccountAccess(userId)
  const error = accountAccessError(Boolean(user.emailVerifiedAt), Boolean(user.phoneVerifiedAt), true)
  if (error) throw error
}

async function readAccountAccess(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true, phoneVerifiedAt: true },
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

function availableBeforeEmailBinding(path: string, method: string) {
  if (/^\/(?:site-content|app-releases|admin|local-model-connector)(?:\/|$)/.test(path)) return true
  if (['/health', '/meta', '/feedback'].includes(path)) return true
  if (path === '/users/me' && ['GET', 'HEAD'].includes(method)) return true
  return /^\/auth(?:\/|$)/.test(path) && !/^\/auth\/account\/(?:phone|password|setup)(?:\/|$)/.test(path)
}

export const accountAccessGuard: RequestHandler = async (req, res, next) => {
  if (!env.accountEmailAuthEnabled || req.method === 'OPTIONS') return next()
  const path = req.path.toLowerCase().replace(/\/$/, '')
  if (availableBeforeEmailBinding(path, req.method)) return next()
  try {
    const userId = getSessionUserId(req)
    if (userId) {
      const user = await readAccountAccess(userId)
      const phoneVerified = Boolean(user.phoneVerifiedAt)
      const error = accountAccessError(Boolean(user.emailVerifiedAt), phoneVerified, isStudioAccountRoute(path, req.method))
      if (error) throw error
      res.locals.allowStudioOwnerAccess = phoneVerified
    }
    next()
  } catch (error) {
    sendRouteError(res, createRequestId(), error)
  }
}
