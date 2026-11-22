// Let WebView2 verify the user gesture for ordinary links and React Router links alike.
(() => {
  if (window !== window.top || location.origin !== 'https://chevoink.chevolink.com') return
  document.addEventListener('click', event => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return
    const link = event.target instanceof Element && event.target.closest('a[href]')
    if (!link || link.hasAttribute('download') || link.target === '_blank') return
    if (link.protocol !== 'https:' || link.username || link.password) return
    if (link.origin === location.origin && !/^\/account(?:\/|$)/.test(link.pathname)) return
    event.preventDefault()
    event.stopPropagation()
    window.open(link.href, '_blank', 'noopener,noreferrer')
  }, true)
})()
