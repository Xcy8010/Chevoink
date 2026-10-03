import { useCallback, useLayoutEffect, useRef, type MutableRefObject, type RefCallback } from 'react'

/** Layout/content growth is not a request to stop following. Only human scrolling changes that preference. */
export function useStreamingAutoFollow<T extends HTMLElement>(
  active: boolean,
  content: string | undefined,
  scope?: string,
): { ref: RefCallback<T>; nodeRef: MutableRefObject<T | null>; onScroll: () => void } {
  const nodeRef = useRef<T | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const follow = useRef(true)
  const intentUntil = useRef(0)
  const observedTop = useRef(0)
  const frame = useRef(0)
  const detach = useRef<(() => void) | null>(null)
  const previous = useRef({ active: false, scope })
  const cancel = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])
  const schedule = useCallback(() => {
    cancel()
    if (!activeRef.current || !follow.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const node = nodeRef.current
      if (node && activeRef.current && follow.current) {
        node.scrollTop = node.scrollHeight
        observedTop.current = node.scrollTop
      }
    })
  }, [cancel])
  const onScroll = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    const moved = node.scrollTop !== observedTop.current
    observedTop.current = node.scrollTop
    if (!moved || Date.now() > intentUntil.current) return
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 12
    if (!follow.current) cancel()
  }, [cancel])
  const setRef = useCallback((node: T | null) => {
    if (nodeRef.current === node) return
    detach.current?.()
    cancel()
    nodeRef.current = node
    observedTop.current = node?.scrollTop ?? 0
    follow.current = true
    intentUntil.current = 0
    if (!node) return
    const intent = () => { intentUntil.current = Date.now() + 1200 }
    const pointerMove = (event: PointerEvent) => { if (event.buttons) intent() }
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) intent()
    }
    node.addEventListener('wheel', intent, { passive: true })
    node.addEventListener('touchmove', intent, { passive: true })
    node.addEventListener('pointerdown', intent, { passive: true })
    node.addEventListener('pointermove', pointerMove, { passive: true })
    node.addEventListener('keydown', key)
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    observer?.observe(node, { childList: true, characterData: true, subtree: true })
    detach.current = () => {
      node.removeEventListener('wheel', intent)
      node.removeEventListener('touchmove', intent)
      node.removeEventListener('pointerdown', intent)
      node.removeEventListener('pointermove', pointerMove)
      node.removeEventListener('keydown', key)
      observer?.disconnect()
    }
    schedule()
  }, [cancel, schedule])
  useLayoutEffect(() => {
    if (scope !== previous.current.scope || (active && !previous.current.active)) {
      follow.current = true
      intentUntil.current = 0
    }
    previous.current = { active, scope }
    schedule()
    return cancel
  }, [active, content, scope, cancel, schedule])
  useLayoutEffect(() => {
    const node = nodeRef.current
    setRef(null)
    setRef(node)
    return () => { detach.current?.(); cancel() }
  }, [scope, setRef, cancel])
  return { ref: setRef, nodeRef, onScroll }
}
