import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { isLegacyAccountMissingEmail } from '../../shared/account-contact.js'

import { env } from '../config/env.js'
import { prisma, DataAccessError } from './prisma.js'

const SESSION_COOKIE_NAME = 'chevoink_session'
const REFRESH_COOKIE_NAME = 'chevoink_refresh'

/**
 * v1 存量令牌格式：`${userId}.${expiresAt}.${sig}`（30 天有效期，兼容双读直至自然过期）
 * v2 令牌格式：`v2.${userId}.${expiresAt}.${tokenVersion}.${kind}.${sig}`
 * kind 区分 access / refresh；tokenVersion 与 User.tokenVersion 比对实现即刻吊销。
 */
const TOKEN_VERSION_PREFIX = 'v2'

/** 解析 env 中 "15m" / "24h" / "30d" / "90s" 形式的时长配置为秒数 */
function parseDurationSeconds(value: string | undefined, fallbackSeconds: number): number {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec((value ?? '').trim())
  if (!match) {
    return fallbackSeconds
  }

  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackSeconds
  }

  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1
  return Math.floor(amount * unitSeconds)
}

// 短效访问令牌 + 长效刷新令牌：泄漏的 access 最多存活 24h；
// refresh 命中时由登录闸口静默重签双 cookie，前端无感知
const ACCESS_TTL_SECONDS = parseDurationSeconds(env.authAccessTokenExpiresIn, 60 * 60 * 24)
const REFRESH_TTL_SECONDS = parseDurationSeconds(env.authRefreshTokenExpiresIn, 60 * 60 * 24 * 30)

function getSessionSecret(): string {
  if (!env.authSessionSecret) {
    throw new DataAccessError(500, 'AUTH_SESSION_SECRET_MISSING', '服务端登录配置缺失。')
  }

  return env.authSessionSecret
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('hex')
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {}
  }

  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, item) => {
      const separatorIndex = item.indexOf('=')
      if (separatorIndex <= 0) {
        return result
      }

      const name = item.slice(0, separatorIndex)
      const value = item.slice(separatorIndex + 1)
      try { result[name] = decodeURIComponent(value) } catch { /* Ignore a malformed cookie, not the entire authentication gate. */ }
      return result
    }, {})
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]

  if (env.authCookieDomain) {
    parts.push(`Domain=${env.authCookieDomain}`)
  }

  if (env.authCookieSecure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

type SessionTokenKind = 'access' | 'refresh'

interface VerifiedToken {
  userId: string
  /** v1 存量令牌无版本号，无法参与吊销比对（30 天内自然淘汰） */
  tokenVersion: number | null
}

function buildToken(userId: string, expiresAt: number, tokenVersion: number, kind: SessionTokenKind): string {
  const payload = `${TOKEN_VERSION_PREFIX}.${userId}.${expiresAt}.${tokenVersion}.${kind}`
  return `${payload}.${signPayload(payload)}`
}

export function buildSessionTokens(userId: string, tokenVersion: number) {
  const now = Math.floor(Date.now() / 1000)
  const accessToken = buildToken(userId, now + ACCESS_TTL_SECONDS, tokenVersion, 'access')
  const refreshToken = buildToken(userId, now + REFRESH_TTL_SECONDS, tokenVersion, 'refresh')

  return {
    accessToken,
    refreshToken,
    expiresInSeconds: ACCESS_TTL_SECONDS,
  }
}

function writeSessionCookies(userId: string, tokenVersion: number, res: Response) {
  const tokens = buildSessionTokens(userId, tokenVersion)
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, tokens.accessToken, ACCESS_TTL_SECONDS))
  res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, REFRESH_TTL_SECONDS))
  return tokens
}

/** 登录/重签会话：实时读库取最新 tokenVersion（不能走 60s 缓存，否则可能签出即刻失效的令牌） */
export async function createSession(userId: string, res: Response, expectedTokenVersion?: number) {
  const state = await getUserAuthState(userId, { fresh: true })
  if (!state) throw new DataAccessError(401, 'AUTH_REQUIRED', '账号已不存在，请重新登录。')
  if (state.banned) throw new DataAccessError(403, 'AUTH_ACCOUNT_BANNED', '当前账号已被封禁。')
  if (expectedTokenVersion !== undefined && state.tokenVersion !== expectedTokenVersion) {
    throw new DataAccessError(401, 'AUTH_SESSION_CHANGED', '账号状态已变化，请重新登录。')
  }
  return writeSessionCookies(userId, state.tokenVersion, res)
}

export function clearSession(res: Response) {
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, '', 0))
  res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE_NAME, '', 0))
}

/** 验签（v1 双读兼容 / v2 含 kind 与版本校验）；导出仅供单元测试使用 */
export function verifySessionToken(token: string | undefined | null, kind: SessionTokenKind): VerifiedToken | null {
  if (!token) {
    return null
  }

  const segments = token.split('.')

  // v1 存量令牌：userId.expiresAt.sig（无 kind / version，按 access 语义兼容读取）
  if (segments.length === 3) {
    const [userId, expiresAtRaw, signature] = segments
    if (!userId || !expiresAtRaw || !signature) {
      return null
    }

    const expiresAt = Number(expiresAtRaw)
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return null
    }

    if (!safeEqual(signature, signPayload(`${userId}.${expiresAtRaw}`))) {
      return null
    }

    return { userId, tokenVersion: null }
  }

  if (segments.length !== 6 || segments[0] !== TOKEN_VERSION_PREFIX) {
    return null
  }

  const [, userId, expiresAtRaw, tokenVersionRaw, kindSegment, signature] = segments
  if (!userId || !expiresAtRaw || !tokenVersionRaw || !signature) {
    return null
  }

  if (kindSegment !== kind) {
    return null
  }

  const expiresAt = Number(expiresAtRaw)
  const tokenVersion = Number(tokenVersionRaw)
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return null
  }
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) {
    return null
  }

  const expectedSignature = signPayload(
    `${TOKEN_VERSION_PREFIX}.${userId}.${expiresAtRaw}.${tokenVersionRaw}.${kindSegment}`,
  )
  if (!safeEqual(signature, expectedSignature)) {
    return null
  }

  return { userId, tokenVersion }
}

/* ---------------- 用户会话状态（封禁 + 令牌版本，60 秒进程内缓存） ---------------- */

interface UserAuthState {
  banned: boolean
  tokenVersion: number
  checkedAt: number
  missingLegacyEmail: boolean
}

const AUTH_STATE_CACHE_TTL_MS = 60_000
/** 缓存容量上限：超出时淘汰最旧 checkedAt 项，防长尾用户导致无界增长 */
const AUTH_STATE_CACHE_MAX_ENTRIES = 5000
const userAuthStateCache = new Map<string, UserAuthState>()

function evictOldestAuthStateIfOverLimit(): void {
  while (userAuthStateCache.size > AUTH_STATE_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null
    let oldestCheckedAt = Number.POSITIVE_INFINITY
    for (const [key, value] of userAuthStateCache) {
      if (value.checkedAt < oldestCheckedAt) {
        oldestCheckedAt = value.checkedAt
        oldestKey = key
      }
    }
    if (!oldestKey) {
      return
    }
    userAuthStateCache.delete(oldestKey)
  }
}
const BANNED_FLAG_KEY = Symbol('chevoinkBannedSession')
const RESOLVED_USER_ID_KEY = Symbol('chevoinkResolvedUserId')
const RESOLVED_TOKEN_VERSION_KEY = Symbol('chevoinkResolvedTokenVersion')
const MISSING_LEGACY_EMAIL_KEY = Symbol('chevoinkMissingLegacyEmail')
const SESSION_UNAVAILABLE_KEY = Symbol('chevoinkSessionUnavailable')

export function evictUserBanCache(userId: string): void {
  userAuthStateCache.delete(userId)
}

/**
 * 认证不可核实告警（60s进程内节流）；不记录令牌、Cookie、SQL或原始错误。
 */
const AUTH_DEGRADE_WARN_WINDOW_MS = 60_000
let lastAuthDegradeWarnAt = 0
let suppressedAuthDegradeCount = 0

function warnAuthDegrade(scope: string, detail: Record<string, unknown>): void {
  const now = Date.now()
  if (now - lastAuthDegradeWarnAt >= AUTH_DEGRADE_WARN_WINDOW_MS) {
    const suppressed = suppressedAuthDegradeCount
    suppressedAuthDegradeCount = 0
    lastAuthDegradeWarnAt = now
    console.warn(`[auth] 会话状态不可核实（${scope}）`, { ...detail, suppressedSinceLastWarn: suppressed })
  } else {
    suppressedAuthDegradeCount += 1
  }
}

export type UserAuthLookup =
  | { status: 'verified'; state: UserAuthState }
  | { status: 'notFound' }
  | { status: 'unavailable' }

/** Cached observations are diagnostic only; every authorization/issuance uses fresh:true. */
export async function readUserAuthState(userId: string, options: { fresh?: boolean } = {}): Promise<UserAuthLookup> {
  const cached = userAuthStateCache.get(userId)
  if (!options.fresh && cached && Date.now() - cached.checkedAt < AUTH_STATE_CACHE_TTL_MS) {
    return { status: 'verified', state: cached }
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId },
      select: { bannedAt: true, tokenVersion: true, phone: true, email: true, emailVerifiedAt: true } })
    if (!user) {
      evictUserBanCache(userId)
      return { status: 'notFound' }
    }
    const state: UserAuthState = { banned: user.bannedAt !== null, tokenVersion: user.tokenVersion, checkedAt: Date.now(),
      missingLegacyEmail: isLegacyAccountMissingEmail({ phone: user.phone, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) }) }
    userAuthStateCache.set(userId, state)
    evictOldestAuthStateIfOverLimit()
    return { status: 'verified', state }
  } catch {
    evictUserBanCache(userId)
    warnAuthDegrade('db-unavailable', { userId })
    return { status: 'unavailable' }
  }
}

function sessionUnavailable(): DataAccessError {
  return new DataAccessError(503, 'AUTH_SESSION_UNAVAILABLE', '暂时无法验证登录状态，请稍后重试，无需重新登录。')
}

/** Compatibility facade: missing user is null; unavailable is never interpreted as missing. */
export async function getUserAuthState(userId: string, options: { fresh?: boolean } = {}): Promise<UserAuthState | null> {
  const result = await readUserAuthState(userId, options)
  if (result.status === 'unavailable') throw sessionUnavailable()
  return result.status === 'verified' ? result.state : null
}

export async function isUserBanned(userId: string): Promise<boolean> {
  const state = await getUserAuthState(userId, { fresh: true })
  if (!state) throw new DataAccessError(401, 'AUTH_REQUIRED', '账号已不存在。')
  return state.banned
}

/** 全局中间件判定封禁后打标：后续 getSessionUserId / requireSessionUserId 一律视为未登录 */
export function markSessionBanned(req: Request): void {
  ;(req as Request & { [key: symbol]: unknown })[BANNED_FLAG_KEY] = true
}

function isSessionMarkedBanned(req: Request): boolean {
  return Boolean((req as Request & { [key: symbol]: unknown })[BANNED_FLAG_KEY])
}

function setResolvedUserId(req: Request, userId: string | null): void {
  ;(req as Request & { [key: symbol]: unknown })[RESOLVED_USER_ID_KEY] = userId
  ;(req as Request & { [key: symbol]: unknown })[SESSION_UNAVAILABLE_KEY] = false
}

export function markSessionUnavailable(req: Request): void {
  ;(req as Request & { [key: symbol]: unknown })[RESOLVED_USER_ID_KEY] = null
  ;(req as Request & { [key: symbol]: unknown })[SESSION_UNAVAILABLE_KEY] = true
}

function getResolvedUserId(req: Request): string | null | undefined {
  const value = (req as Request & { [key: symbol]: unknown })[RESOLVED_USER_ID_KEY]
  return typeof value === 'string' ? value : value === null ? null : undefined
}

/**
 * 登录闸口（app.ts 全局中间件调用）：
 * 1. 按 access cookie → Bearer access → refresh cookie → Bearer refresh 顺序识别会话；
 * 2. 实时封禁检查：命中打标 + 清 cookie；状态不可核实则标记503，不清cookie；
 * 3. v2 令牌与库中 tokenVersion 比对，不一致（改密/登出/封禁后）视为已吊销；
 * 4. refresh 命中时静默重签双 cookie（滑动续期 30 天），前端无感知。
 * 判定结果写入 req 标记，getSessionUserId 直接读取，避免下游重复验签。
 */
export async function resolveSessionGate(req: Request, res: Response): Promise<void> {
  // Keep a failed/uncompleted gate distinguishable from a verified anonymous request.
  markSessionUnavailable(req)
  const cookies = parseCookies(req.headers.cookie)
  const authHeader = req.headers.authorization
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null

  const accessCandidate =
    verifySessionToken(cookies[SESSION_COOKIE_NAME], 'access') ?? verifySessionToken(bearerToken, 'access')
  const candidate =
    accessCandidate ??
    verifySessionToken(cookies[REFRESH_COOKIE_NAME], 'refresh') ??
    verifySessionToken(bearerToken, 'refresh')

  if (!candidate) {
    setResolvedUserId(req, null)
    return
  }

  const lookup = await readUserAuthState(candidate.userId, { fresh: true })
  if (lookup.status === 'unavailable') return
  if (lookup.status === 'notFound') {
    clearSession(res)
    setResolvedUserId(req, null)
    return
  }
  const state = lookup.state

  if (state?.banned) {
    markSessionBanned(req)
    clearSession(res)
    setResolvedUserId(req, null)
    return
  }

  if (candidate.tokenVersion !== null && candidate.tokenVersion !== state.tokenVersion) {
    // 已被吊销的 v2 令牌：清 cookie 并按未登录处理
    clearSession(res)
    setResolvedUserId(req, null)
    return
  }

  if (!accessCandidate && candidate) {
    // refresh 命中（access 过期/丢失）：滚动续签
    writeSessionCookies(candidate.userId, state.tokenVersion, res)
  }

  setResolvedUserId(req, candidate.userId)
  ;(req as Request & { [key: symbol]: unknown })[RESOLVED_TOKEN_VERSION_KEY] = candidate.tokenVersion
  ;(req as Request & { [key: symbol]: unknown })[MISSING_LEGACY_EMAIL_KEY] = state.missingLegacyEmail
}

export function sessionMissingLegacyEmail(req: Request) {
  return (req as Request & { [key: symbol]: unknown })[MISSING_LEGACY_EMAIL_KEY] === true
}

export function getSessionUserId(req: Request): string | null {
  if ((req as Request & { [key: symbol]: unknown })[SESSION_UNAVAILABLE_KEY]) throw sessionUnavailable()
  // 全局中间件已判定本请求属于被封禁会话：直接视为未登录
  if (isSessionMarkedBanned(req)) {
    return null
  }

  // 闸口已识别会话（string=登录用户，null=明确未登录）
  const resolved = getResolvedUserId(req)
  if (resolved !== undefined) {
    return resolved
  }

  // No local-signature bypass when the global gate did not complete.
  if (req.headers.cookie || req.headers.authorization) throw sessionUnavailable()
  return null
}

/** Only explicit public data routes may drop personalization; never use for private reads/writes. */
export function getPublicSessionUserId(req: Request): string | null {
  try { return getSessionUserId(req) } catch (error) {
    if (error instanceof DataAccessError && error.code === 'AUTH_SESSION_UNAVAILABLE') return null
    throw error
  }
}

/** 吊销用户全部 v2 会话令牌（改密/登出/封禁时调用）：tokenVersion+1 并清缓存即刻生效 */
export async function revokeUserSessions(userId: string): Promise<void> {
  try {
    await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } })
  } catch {
    throw new DataAccessError(503, 'AUTH_REVOCATION_UNAVAILABLE', '暂时无法确认会话撤销，请稍后重试。')
  } finally { evictUserBanCache(userId) }
}

export function requireSessionUserId(req: Request): string {
  const userId = getSessionUserId(req)

  if (!userId) {
    throw new DataAccessError(401, 'AUTH_REQUIRED', '请先登录后再继续。')
  }

  return userId
}

export function requireVersionedSessionIdentity(req: Request) {
  const userId = requireSessionUserId(req)
  const tokenVersion = (req as Request & { [key: symbol]: unknown })[RESOLVED_TOKEN_VERSION_KEY]
  if (typeof tokenVersion !== 'number') {
    throw new DataAccessError(401, 'AUTH_SESSION_CHANGED', '请重新登录后继续设置密码。')
  }
  return { userId, tokenVersion }
}
