import { isNativeApp, observeNativeInsets, refreshNativeInsets, type ImmersiveInsets } from './native-app'

const EDGES = ['top', 'bottom', 'left', 'right'] as const
let applyFn: (() => void) | null = null
let nativeImmersive = false
let nativeHint: ImmersiveInsets | null = null
let measured: ImmersiveInsets | null = null

export function setNativeImmersiveSafeArea(active: boolean, insets?: ImmersiveInsets | null) {
  nativeImmersive = active
  nativeHint = active ? insets ?? null : null
  applyFn?.()
}

export function refreshSafeArea() {
  applyFn?.()
  void refreshNativeInsets()
}

/** Zero is a measured inset, including gesture-free and already-fitted edges. */
function inset(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function setupSafeAreaFallback(): (() => void) | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !/Android/i.test(navigator.userAgent)) return
  const native = isNativeApp()
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;width:0;height:env(safe-area-inset-top,0px);pointer-events:none;visibility:hidden;'
  document.documentElement.append(probe)
  const apply = () => {
    const style = document.documentElement.style
    if (native) {
      // Native shells own layout. Measure only the safe space still overlapping
      // the WebView; screen-height guesses double-count island/bar animations.
      const current = measured?.immersive === nativeImmersive ? measured : null
      for (const edge of EDGES) {
        const fallback = nativeImmersive ? inset(nativeHint?.[edge], edge === 'top' ? 32 : edge === 'bottom' ? 24 : 0) : 0
        style.setProperty(`--safe-${edge}`, `${inset(current?.[edge], fallback)}px`)
      }
      return
    }
    for (const edge of EDGES) style.removeProperty(`--safe-${edge}`)
    // Preserve the existing QQ/WeChat fallback outside the native shell.
    if (!document.fullscreenElement && probe.getBoundingClientRect().height < 1 && window.innerHeight >= window.screen.height - 1) {
      style.setProperty('--safe-top', '32px')
    }
  }
  applyFn = apply
  const stop = observeNativeInsets(insets => { measured = insets; apply() })
  const refresh = () => { apply(); if (native) void refreshNativeInsets() }
  const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
  apply()
  window.addEventListener('resize', refresh)
  window.addEventListener('orientationchange', refresh)
  window.addEventListener('pageshow', refresh)
  document.addEventListener('visibilitychange', onVisibility)
  document.addEventListener('fullscreenchange', apply)
  return () => {
    stop()
    probe.remove()
    window.removeEventListener('resize', refresh)
    window.removeEventListener('orientationchange', refresh)
    window.removeEventListener('pageshow', refresh)
    document.removeEventListener('visibilitychange', onVisibility)
    document.removeEventListener('fullscreenchange', apply)
    if (applyFn === apply) applyFn = null
    measured = null
    nativeHint = null
    nativeImmersive = false
    for (const edge of EDGES) document.documentElement.style.removeProperty(`--safe-${edge}`)
  }
}