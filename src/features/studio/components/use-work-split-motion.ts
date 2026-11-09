import { useLayoutEffect, useRef, useState } from 'react'

export type WorkPaneSizes = { rail: number; chat: number; viewer: number; inspector: number; dock: number }
export const WORK_FOLD_DURATION = 220

/** Match the original panel curve, cubic-bezier(.22, 1, .36, 1). */
function foldProgress(progress: number) {
  let low = 0
  let high = 1
  for (let step = 0; step < 12; step++) {
    const t = (low + high) / 2
    const x = 3 * (1 - t) * t * (.22 * (1 - t) + .36 * t) + t ** 3
    if (x < progress) low = t
    else high = t
  }
  return 1 - (1 - (low + high) / 2) ** 3
}

/** A fold has one fixed deadline. Pointer updates retarget it without restarting it. */
export function useWorkSplitMotion(target: WorkPaneSizes, phase: string): WorkPaneSizes {
  const targetRef = useRef(target)
  targetRef.current = target
  const displayed = useRef(target)
  const previousPhase = useRef(phase)
  const frame = useRef(0)
  const [animated, setAnimated] = useState<WorkPaneSizes | null>(null)
  const result = animated ?? target
  useLayoutEffect(() => {
    if (previousPhase.current === phase) return
    previousPhase.current = phase
    cancelAnimationFrame(frame.current)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setAnimated(null); return }
    const origin = displayed.current
    const started = performance.now()
    setAnimated(origin)
    const tick = () => {
      const progress = Math.min(1, (performance.now() - started) / WORK_FOLD_DURATION)
      const eased = foldProgress(progress)
      const next = { ...targetRef.current }
      for (const key of Object.keys(next) as (keyof WorkPaneSizes)[]) next[key] = origin[key] + (next[key] - origin[key]) * eased
      if (progress === 1) { frame.current = 0; setAnimated(null); return }
      setAnimated(next)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [phase])
  useLayoutEffect(() => { displayed.current = result }, [result])
  return result
}
