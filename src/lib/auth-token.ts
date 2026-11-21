/**
 * 会话令牌的本地持久化（localStorage）。
 *
 * 主认证通道仍是 HttpOnly cookie；但安卓 WebView 的 CookieManager 懒刷盘，
 * 登录后立刻杀掉 APP 会丢失尚未落盘的会话 cookie。登录响应里的令牌与 cookie
 * 同值，持久化到 localStorage 后随请求以 Authorization 头兜底，保证登录态不丢。
 */

import { isWindowsDesktopApp } from './desktop-app'

const STORAGE_KEY = 'chevoink-session-token'
export const DEVICE_SELECTION_KEY = 'chevoink-selected-device'

export function readDeviceSelection(): { id: string; userId?: string } | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_SELECTION_KEY) ?? 'null')
    return typeof value?.id === 'string' ? value : null
  } catch { return null }
}

export function selectedDevice(): string | null {
  return readDeviceSelection()?.id ?? null
}

export function selectDevice(id: string | null, userId?: string) {
  try {
    if (id) window.localStorage.setItem(DEVICE_SELECTION_KEY, JSON.stringify({ id, userId }))
    else window.localStorage.removeItem(DEVICE_SELECTION_KEY)
  } catch { /* HttpOnly primary cookies still authenticate when storage is unavailable. */ }
}

export function getSessionToken(): string | null {
  if (isWindowsDesktopApp()) return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (isWindowsDesktopApp()) {
      // Called only after verified authentication or explicit logout; never clear drafts.
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }
    if (token) {
      window.localStorage.setItem(STORAGE_KEY, token)
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // 忽略隐私模式等写入失败
  }
}

/** 拼接鉴权请求头：有令牌时附带 Bearer 头（cookie 丢失时服务端以此恢复会话） */
export function buildAuthHeader(): Record<string, string> {
  const token = getSessionToken()
  const device = selectedDevice()
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(device ? { 'X-Chevoink-Device': device } : {}) }
}
