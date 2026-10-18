import { useSyncExternalStore } from 'react'

// One midnight timer for every visible message, including an idle conversation.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
const snapshot = () => {
  const now = new Date()
  return `${now.getFullYear()}/${now.getMonth()}/${now.getDate()}/${now.getTimezoneOffset()}`
}
function refresh() {
  for (const listener of listeners) listener()
  clearTimeout(timer)
  if (!listeners.size) return
  const next = new Date()
  next.setHours(24, 0, 0, 0)
  timer = setTimeout(refresh, Math.max(1, next.getTime() - Date.now()))
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    refresh()
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }
}
export function useLocalCalendarDay() {
  useSyncExternalStore(subscribe, snapshot, snapshot)
}
