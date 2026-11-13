import { useEffect, useRef, useState, type RefObject } from 'react'

/** Translate the sticky header without resizing the feed or reacting to tiny scroll jitter. */
export function useRevealHeader(pinned: boolean, scrollRootRef?: RefObject<HTMLElement | null>, resetKey?: string) {
  const ref = useRef<HTMLElement>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const root = scrollRootRef?.current ?? ref.current?.closest<HTMLElement>('[data-app-main-scroll]')
    if (!root) return
    setHidden(false)
    let previous = root.scrollTop
    let travel = 0
    let frame = 0
    const update = () => {
      frame = 0
      // Clamp overscroll so iOS edge bounce cannot reverse the header direction.
      const top = Math.max(0, Math.min(root.scrollTop, root.scrollHeight - root.clientHeight))
      const delta = top - previous
      previous = top
      if (top < 16) {
        travel = 0
        setHidden(false)
        return
      }
      if (Math.sign(delta) !== Math.sign(travel)) travel = 0
      travel += delta
      if (Math.abs(travel) >= 20) {
        setHidden(travel > 0)
        travel = 0
      }
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [scrollRootRef, resetKey])

  return { ref, hidden: hidden && !pinned }
}
