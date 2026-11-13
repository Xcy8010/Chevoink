import { ApiClientError, requestJson } from '@/app/api-client'

export type CaptchaAnswer = { captchaId: string; captchaAnswer: string }
export type CodeReceipt = { ok: true; expireInSeconds: number; cooldownSeconds: number }

export function postAuth<T>(path: string, body: object): Promise<T> {
  return requestJson<T>(`/api/auth${path}`, { method: 'POST', body: JSON.stringify(body) })
}

export function authError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback
}

export function emailAddress(value: string): string {
  const email = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : ''
}

export function mainlandPhone(value: string): string {
  const phone = value.trim().replace(/[\s-]/g, '').replace(/^(?:\+86|0086|86(?=1\d{10}$))/, '')
  return /^1\d{10}$/.test(phone) ? '+86' + phone : ''
}

export function authRedirectPath(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/me'
  const base = 'https://chevoink.invalid'
  try {
    const target = new URL(value, base)
    const path = decodeURIComponent(target.pathname)
    if (target.origin !== base || path.startsWith('//') || /^\/(?:login|register)\/*$/i.test(path)) return '/me'
    return target.pathname + target.search + target.hash
  } catch {
    return '/me'
  }
}

export function authSuccessMessage(registered: boolean): string {
  return registered ? '注册成功。你可以稍后完善个人资料。' : '登录成功。'
}
