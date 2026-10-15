import { useCallback, useEffect, useState } from 'react'
import { readNativeSystemSurface, registerNativeSystemSurface, restoreNativeSystemBarsToTheme } from './native-app'

/** Attach to the actual mobile header. Hidden desktop headers yield to the root theme. */
export function useNativeSystemSurface<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null)
  const ref = useCallback((node: T | null) => setElement(node), [])
  useEffect(() => {
    if (!element) return
    const release = registerNativeSystemSurface(() => (
      element.isConnected && element.getClientRects().length > 0 ? readNativeSystemSurface(element) : null
    ))
    let frame: number | undefined
    let forceNative = false
    const refresh = (force = false) => {
      forceNative ||= force
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        restoreNativeSystemBarsToTheme({ forceNative })
        forceNative = false
      })
    }
    // Configuration/resume can reset Android icon style even when CSS color is unchanged.
    const viewport = () => refresh(true)
    const visibility = () => { if (document.visibilityState === 'visible') refresh(true) }
    // Only observe theme/target attributes, never body children or streamed message text.
    const themeObserver = new MutationObserver(() => refresh())
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    themeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] })
    const sizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(viewport)
    sizeObserver?.observe(element)
    window.addEventListener('resize', viewport)
    window.addEventListener('orientationchange', viewport)
    window.addEventListener('focus', viewport)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      themeObserver.disconnect()
      sizeObserver?.disconnect()
      window.removeEventListener('resize', viewport)
      window.removeEventListener('orientationchange', viewport)
      window.removeEventListener('focus', viewport)
      document.removeEventListener('visibilitychange', visibility)
      if (frame !== undefined) cancelAnimationFrame(frame)
      release()
    }
  }, [element])
  return ref
}
