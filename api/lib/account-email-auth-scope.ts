import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { appReleaseIdSchema, type AppReleaseBootstrap } from '../../shared/contracts/app-release.js'
import { env } from '../config/env.js'
import { DataAccessError } from './prisma.js'

const previewCookie = '__Host-chevoink_email_auth_preview'
const previewLifetimeSeconds = 30 * 60
const grantSchema = z.object({
  issuerId: z.string().min(1).max(128),
  releaseId: appReleaseIdSchema,
  revision: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict()

type Grant = z.infer<typeof grantSchema>
export type AccountEmailAuthPreview = {
  recipient: string
  selection: AppReleaseBootstrap
}

const accountScope = new AsyncLocalStorage<AccountEmailAuthPreview>()

export function accountEmailAuthPreview() {
  return accountScope.getStore()
}

export function accountEmailAuthEnabled() {
  return env.accountEmailAuthEnabled || Boolean(accountEmailAuthPreview())
}

export function withAccountEmailAuthPreview<T>(preview: AccountEmailAuthPreview, run: () => T) {
  return accountScope.run(preview, run)
}

export function configuredPreviewRecipient() {
  if (env.accountEmailAuthEnabled || !env.authSessionSecret) return undefined
  const parsed = z.string().email().max(254).safeParse(env.accountEmailAuthTestRecipient)
  return parsed.success ? parsed.data : undefined
}

function signGrant(payload: string, recipient: string) {
  return createHmac('sha256', env.authSessionSecret)
    .update(JSON.stringify(['email-auth-preview-v1', payload, recipient]))
    .digest()
}

export function readAccountEmailAuthPreviewGrant(req: Request) {
  const raw = req.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(previewCookie + '='))
  if (raw?.length !== 1 || raw[0].length > 1024) return undefined
  const recipient = configuredPreviewRecipient()
  if (!recipient) return undefined
  const [payload, signature, extra] = raw[0].slice(previewCookie.length + 1).split('.')
  if (extra !== undefined || !/^[\w-]+$/.test(payload) || !/^[a-f0-9]{64}$/.test(signature ?? '')) return undefined
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), signGrant(payload, recipient))) return undefined
  try {
    const grant = grantSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString()))
    if (grant.success && grant.data.expiresAt > Math.floor(Date.now() / 1000)) return { ...grant.data, recipient }
  } catch {
    // Invalid cookie payloads use the ordinary application assignment.
  }
}

export function writeAccountEmailAuthPreviewGrant(res: Response, grant: Omit<Grant, 'expiresAt'>, recipient: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + previewLifetimeSeconds
  const payload = Buffer.from(JSON.stringify({ ...grant, expiresAt })).toString('base64url')
  const signature = signGrant(payload, recipient).toString('hex')
  res.append('Set-Cookie', `${previewCookie}=${payload}.${signature}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${previewLifetimeSeconds}`)
}

export function assertPreviewEmailAllowed(email: string) {
  const preview = accountEmailAuthPreview()
  if (preview && preview.recipient !== email.trim().toLowerCase()) {
    throw new DataAccessError(403, 'AUTH_PREVIEW_RECIPIENT_REQUIRED', '请使用获准的测试邮箱。')
  }
}

export function assertPreviewAccountAllowed(user: { email: string | null; emailVerifiedAt: Date | null; bannedAt: Date | null } | null) {
  const preview = accountEmailAuthPreview()
  if (preview && (!user?.emailVerifiedAt || user.bannedAt || user.email?.toLowerCase() !== preview.recipient)) {
    throw new DataAccessError(403, 'AUTH_PREVIEW_RECIPIENT_REQUIRED', '请使用获准的测试邮箱。')
  }
}

export function assertPreviewSmsSendAllowed() {
  if (accountEmailAuthPreview()) {
    throw new DataAccessError(403, 'AUTH_PREVIEW_SMS_DISABLED', '邮箱注册预览暂不发送短信，你可以跳过手机号验证。')
  }
}

export function requiresPhoneForEmailSignup(user: {
  emailVerifiedAt: Date | null
  phoneVerifiedAt: Date | null
  phone: string | null
  accountSetupStep: number | null
  accountSetupFinishedAt: Date | null
}) {
  return Boolean(user.emailVerifiedAt && !user.phoneVerifiedAt && !user.phone
    && (user.accountSetupStep || user.accountSetupFinishedAt))
}
