import { ApiClientError, requestJson } from './api-client'

export const REAUTHENTICATION_REQUIRED = 'chevoink:reauthentication-required'
export function requestSessionSignIn() {
  window.dispatchEvent(new Event(REAUTHENTICATION_REQUIRED))
}

const endpoint = '/api/auth/session/activity'
const reportInterval = 60_000
const interactionEvents = ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove', 'click'] as const

/** Coalesce real input, including a trailing report when the author stops typing. */
export function listenForSessionActivity(userId: string, deviceId: string, isCurrent: () => boolean) {
  let lastReport = -Infinity
  let lastInput = -Infinity
  let pending = false
  let retryOnReconnect = false
  let timer: number | undefined
  let disposed = false

  async function send() {
    if (disposed || !isCurrent()) return
    try {
      await requestJson(endpoint, {
        method: 'POST', body: JSON.stringify({ userId, deviceId, elapsedMs: Math.max(0, Date.now() - lastInput) }), keepalive: true,
      })
      retryOnReconnect = false
    } catch (error) {
      if (!disposed && isCurrent() && error instanceof ApiClientError &&
          (error.status === 401 || error.code === 'AUTH_ACTIVITY_SESSION_CHANGED')) requestSessionSignIn()
      retryOnReconnect = !(error instanceof ApiClientError) || error.status >= 500
      lastReport = Date.now() - reportInterval + 5_000
    }
  }

  function flush() {
    window.clearTimeout(timer)
    timer = undefined
    if (!pending) return
    pending = false
    lastReport = Date.now()
    void send()
  }

  function onInput(event: Event) {
    if (!event.isTrusted || document.visibilityState !== 'visible') return
    lastInput = Date.now()
    pending = true
    const delay = lastReport + reportInterval - lastInput
    if (delay <= 0) flush()
    else timer ??= window.setTimeout(flush, delay)
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') opened()
    else flush()
  }

  function opened() {
    lastInput = Date.now()
    pending = true
    flush()
  }

  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted && document.visibilityState === 'visible' && Date.now() - lastReport > 250) opened()
  }

  function onOnline() {
    if (retryOnReconnect && document.visibilityState === 'visible') {
      pending = true
      flush()
    }
  }

  for (const event of interactionEvents) document.addEventListener(event, onInput, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('pagehide', flush)
  window.addEventListener('online', onOnline)
  if (document.visibilityState === 'visible') opened()
  return () => {
    disposed = true
    window.clearTimeout(timer)
    for (const event of interactionEvents) document.removeEventListener(event, onInput, true)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('online', onOnline)
  }
}
