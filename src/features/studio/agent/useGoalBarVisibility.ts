import { useCallback, useSyncExternalStore } from 'react'

import type { AgentGoalSnapshot } from '../../../../shared/contracts/agent-goal.js'

const storagePrefix = 'chevoink:completed-goal-dismissed:v1:'
const memoryLimit = 256
// Only unavailable storage needs the bounded, page-lifetime fallback.
const memoryDismissals = new Set<string>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && !event.key.startsWith(storagePrefix)) return
  if (event.key === null) memoryDismissals.clear()
  else memoryDismissals.delete(event.key)
  notify()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

function readDismissed(key: string | null) {
  if (!key) return false
  try {
    if (typeof window !== 'undefined' && window.localStorage.getItem(key) === '1') return true
  } catch { /* Storage can be unavailable; keep the page-lifetime preference. */ }
  return memoryDismissals.has(key)
}

export function useGoalBarVisibility(userId: string | undefined, sessionId: string | null, goal: AgentGoalSnapshot | null) {
  const key = userId && sessionId && goal?.sessionId === sessionId && goal.status === 'completed'
    ? storagePrefix + JSON.stringify([userId, sessionId, goal.id, goal.revision])
    : null
  // Read the incoming identity synchronously; never copy the previous scope's
  // state into a new key during an effect or StrictMode remount.
  const getSnapshot = useCallback(() => readDismissed(key), [key])
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, () => false)
  const dismiss = useCallback(() => {
    if (!key) return
    try {
      window.localStorage.setItem(key, '1')
      if (window.localStorage.getItem(key) !== '1') throw new Error('Dismissal storage unavailable')
      memoryDismissals.delete(key)
    } catch {
      memoryDismissals.delete(key)
      memoryDismissals.add(key)
      if (memoryDismissals.size > memoryLimit) memoryDismissals.delete(memoryDismissals.values().next().value!)
    }
    notify()
  }, [key])

  return { visible: Boolean(goal) && !dismissed, dismiss }
}
