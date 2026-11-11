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
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const background = getComputedStyle(root).getPropertyValue('--boot-background').trim()
    meta.setAttribute('content', background)
  }
})()
