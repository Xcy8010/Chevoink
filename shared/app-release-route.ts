/** Also serialized into release-entry.js. Keep this function self-contained. */
export function canonicalAppRoute(route: string | null | undefined): string {
  if (!route || !/^\/(?!\/)/.test(route) || /[\\\s]/.test(route)) return '/'
  try {
    const origin = 'https://chevoink.invalid'
    const url = new URL(route, origin)
    if (url.origin !== origin) return '/'
    const pathname = decodeURIComponent(url.pathname)
    if (!/^\/(?!\/)/.test(pathname) || /[\\\r\n]/.test(pathname) || /^\/api(?:\/|$)/i.test(pathname)) return '/'
    if (pathname.split('/').some(segment => segment === '.' || segment === '..')) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}
