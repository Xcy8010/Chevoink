import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import './studio-presence.css'

type Phase = 'open' | 'closing'
const exitDuration = 150 // Matches the exit transitions in studio-presence.css.

// React 18 forwards inert as an HTML attribute when its value is a string.
export function studioInert(closing: boolean) {
  return closing ? { inert: '' as const, 'aria-hidden': true as const } : {}
}

function canAnimate() {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
    && document.documentElement.dataset.studioReducedMotion !== 'true'
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function useStudioPresence<T>(value: T | null) {
  const open = value != null && value !== false
  const previous = useRef<T | null>(null)
  const [retained, setRetained] = useState(open)
  useLayoutEffect(() => {
    if (open) previous.current = value
  }, [open, value])
  useLayoutEffect(() => {
    if (open) {
      setRetained(true)
      return
    }
    if (!retained) return
    const release = () => {
      previous.current = null
      setRetained(false)
    }
    if (!canAnimate()) { release(); return }
    const timer = window.setTimeout(release, exitDuration)
    return () => window.clearTimeout(timer)
  }, [open, retained])
  const phase: Phase = open ? 'open' : 'closing'
  return { rendered: open ? value : retained ? previous.current : null, phase }
}

// A native dialog remains in the top layer until its backdrop finishes fading.
export function useStudioDismiss(onClose: () => void) {
  const [phase, setPhase] = useState<Phase>('open')
  const closing = useRef(false)
  const timer = useRef<number>()
  const finish = useRef(onClose)
  useLayoutEffect(() => { finish.current = onClose }, [onClose])
  useLayoutEffect(() => () => window.clearTimeout(timer.current), [])
  const dismiss = useCallback(() => {
    if (closing.current) return
    closing.current = true
    setPhase('closing')
    if (canAnimate()) timer.current = window.setTimeout(() => finish.current(), exitDuration)
    else finish.current()
  }, [])
  return { dismiss, phase }
}
