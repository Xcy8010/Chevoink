import { lazy, type ComponentType } from 'react'

const CHUNK_RELOAD_KEY = 'chevoink:chunk-reload-at'

/**
 * 懒加载页面 chunk：发版后旧 chunk 被清理导致 404 时，
 * 3 分钟内只自动刷新一次拿新版本，避免刷新死循环。
 */
export function lazyPage(load: () => Promise<{ default: ComponentType }>) {
  return lazy(() =>
    load().catch((error) => {
      const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
      if (Date.now() - lastReload > 180_000) {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
        window.location.reload()
      }
      throw error
    }),
  )
}
