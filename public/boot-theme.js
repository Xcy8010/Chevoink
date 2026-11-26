;(function () {
  // Archived artifacts load this same file as a compatibility script before
  // their original boot theme. Keep their own visual initialization intact.
  if (document.currentScript?.getAttribute('src') === '/api/app-releases/legacy-foreground.js') return
  let theme = 'light'
  try {
    const saved = JSON.parse(localStorage.getItem('chevoink-shell'))
    if (saved?.state?.theme === 'dark') theme = 'dark'
  } catch {
    // Storage may be unavailable or contain invalid JSON.
  }

  const root = document.documentElement
  const android = /\bChevoinkApp\b/.test(navigator.userAgent)
  if (android) root.dataset.bootPlatform = 'android'
  else if (/\bChevoinkDesktop\/\d+\.\d+\.\d+\b/.test(navigator.userAgent)) root.dataset.bootPlatform = 'windows'
  root.classList.add(theme)
  const colors = getComputedStyle(root)
  const background = colors.getPropertyValue('--boot-background').trim()
  // Keep the first-paint palette until the startup document releases its splash.
  root.style.setProperty('--boot-splash-background', background)
  root.style.setProperty('--boot-splash-mark-base', colors.getPropertyValue('--boot-mark-base').trim())
  root.style.setProperty('--boot-splash-mark-highlight', colors.getPropertyValue('--boot-mark-highlight').trim())
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', background)
  }

  // Capacitor injects the bridge before page scripts. Match the loading surface
  // now, while the app bundle/release selection/authentication may still be loading.
  if (android) {
    const appearance = window.Capacitor?.Plugins?.ImmersiveMode
    if (appearance?.setSystemBarAppearance) {
      void appearance.setSystemBarAppearance({ color: background, dark: theme === 'dark' })
        .catch(() => { /* Older shells retain their startup appearance until app initialization. */ })
    }
  }
})()

// Loaded by the delivery layer for older documents; an already resident document
// can only install this listener on its next real navigation.
;(function () {
  const root = document.documentElement
  if (!root.dataset || root.dataset.sessionActivity) return
  document.documentElement.dataset.sessionActivity = 'legacy'

  const endpoint = '/api/auth/session/activity'
  let identity
  let expectedOwner
  let sessionChanged = false
  let lastSent = -Infinity
  let pendingAt = 0
  let timer
  let sending = false

  const key = 'chevoink-selected-device'
  function selection() {
    try { return JSON.parse(localStorage.getItem(key) || 'null')?.id } catch { return null }
  }
  const nativeFetch = window.fetch.bind(window)
  let generation = 0
  // An old module has no device header. Its normal bootstrap can rotate the
  // selected device's signed refresh credential even after the primary cookie expires.
  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url || input, location.href)
    if (url.origin !== location.origin) return nativeFetch(input, init)
    const method = (init?.method || input.method || 'GET').toUpperCase()
    if (method === 'GET' && (url.pathname === '/api/app-releases/bootstrap' || url.pathname === '/api/users/me')) {
      const device = identity?.deviceId || selection()
      if (device && (init?.credentials || input.credentials) !== 'omit') {
        const requestHeaders = new Headers(init?.headers ?? input.headers)
        if (!requestHeaders.has('X-Chevoink-Device')) requestHeaders.set('X-Chevoink-Device', device)
        return nativeFetch(input, { ...init, headers: requestHeaders })
      }
    }
    const result = nativeFetch(input, init)
    if (method === 'POST' && /^\/api\/auth\/(?:(?:email|sms)\/)?(?:login|register)$/.test(url.pathname)) {
      result.then(response => {
        if (response.ok) {
          generation++
          expectedOwner = undefined
          sessionChanged = false
          identity = undefined
          opened()
        }
      }, () => {})
    }
    return result
  }
  function headers() {
    const result = { 'Content-Type': 'application/json' }
    const device = identity?.deviceId || selection()
    if (device) result['X-Chevoink-Device'] = device
    try {
      const token = localStorage.getItem('chevoink-session-token')
      if (token && !/\bChevoinkDesktop\//.test(navigator.userAgent)) result.Authorization = 'Bearer ' + token
    } catch { /* Cookies are sufficient when storage is unavailable. */ }
    return result
  }

  async function flush() {
    clearTimeout(timer)
    timer = undefined
    if (sending || !pendingAt) return
    sending = true
    const observed = pendingAt
    pendingAt = 0
    lastSent = Date.now()
    try {
      const options = { credentials: 'same-origin', cache: 'no-store', headers: headers() }
      if (!identity) {
        const requestGeneration = generation
        const initialSelection = selection()
        const response = await nativeFetch(endpoint, options)
        if (!response.ok) return
        const { data } = await response.json()
        if (!data?.deviceId || !data.userId || requestGeneration !== generation || selection() !== initialSelection) return
        if (expectedOwner && expectedOwner !== data.userId) return
        identity = { deviceId: data.deviceId, userId: data.userId }
        try { localStorage.setItem(key, JSON.stringify({ id: data.deviceId, userId: data.userId })) } catch { /* Storage is optional. */ }
      }
      // Pin the document to its verified session. A late event from a different
      // tab cannot renew the newly selected account.
      const reportedIdentity = identity
      const report = await nativeFetch(endpoint, { ...options, headers: headers(), method: 'POST', keepalive: true,
        body: JSON.stringify({ ...identity, elapsedMs: Math.max(0, Date.now() - observed) }) })
      if (report.status === 409 && reportedIdentity === identity) sessionChanged = true
    } catch { /* The next foreground event can retry if the connection is lost. */ }
    finally {
      sending = false
      if (pendingAt) schedule()
    }
  }
  function schedule() {
    const delay = Math.max(0, 60_000 - (Date.now() - lastSent))
    if (!delay || document.visibilityState !== 'visible') void flush()
    else timer ??= setTimeout(flush, delay)
  }
  function opened() {
    if (document.visibilityState !== 'visible') return
    // Only a new foreground opening can follow a same-account login in another
    // tab. Delayed input and background flushes stay pinned to their original device.
    const selected = selection()
    if (identity && (sessionChanged || (selected && selected !== identity.deviceId))) {
      expectedOwner = identity.userId
      identity = undefined
      sessionChanged = false
      generation++
    }
    pendingAt = Date.now()
    void flush()
  }
  function input(event) {
    if (!event.isTrusted || document.visibilityState !== 'visible') return
    pendingAt = Date.now()
    schedule()
  }
  for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove', 'click']) {
    document.addEventListener(type, input, { capture: true, passive: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') opened()
    else void flush()
  })
  window.addEventListener('pageshow', event => { if (event.persisted) opened() })
  window.addEventListener('pagehide', flush)
  opened()
})()
