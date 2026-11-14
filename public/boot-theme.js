;(function () {
  let theme = 'light'
  try {
    const saved = JSON.parse(localStorage.getItem('chevoink-shell'))
    if (saved?.state?.theme === 'dark') theme = 'dark'
  } catch {
    // Storage may be unavailable or contain invalid JSON.
  }

  const root = document.documentElement
  root.classList.add(theme)
  const background = getComputedStyle(root).getPropertyValue('--boot-background').trim()
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', background)
  }

  // Capacitor injects the bridge before page scripts. Match the loading surface
  // now, while the app bundle/release selection/authentication may still be loading.
  if (/\bChevoinkApp\b/.test(navigator.userAgent)) {
    const appearance = window.Capacitor?.Plugins?.ImmersiveMode
    if (appearance?.setSystemBarAppearance) {
      void appearance.setSystemBarAppearance({ color: background, dark: theme === 'dark' })
        .catch(() => { /* Older shells retain their startup appearance until app initialization. */ })
    }
  }
})()
