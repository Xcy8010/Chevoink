// Hints only: each reader verifies the committed revision and its own session access.
const observers = new Map<string, Set<() => void>>()

export function observeConversation(userId: string, sessionId: string, wake: () => void) {
  const key = JSON.stringify([userId, sessionId])
  const listeners = observers.get(key) ?? new Set<() => void>()
  listeners.add(wake)
  observers.set(key, listeners)
  return () => {
    listeners.delete(wake)
    if (!listeners.size && observers.get(key) === listeners) observers.delete(key)
  }
}

export function wakeConversation(userId: string, sessionId: string) {
  for (const wake of observers.get(JSON.stringify([userId, sessionId])) ?? []) wake()
}
