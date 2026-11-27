import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'

type Options = {
  scrollRef: RefObject<HTMLDivElement>
  scrollContentRef: RefObject<HTMLDivElement>
  floatingFooterRef: RefObject<HTMLDivElement>
  pinnedToBottomRef: MutableRefObject<boolean>
  returnFrameRef: MutableRefObject<number>
  scopeKey?: string
  collapsed: boolean
  messages: readonly AgentUIMessage[]
}

export function useConversationDistance({ scrollRef, scrollContentRef, floatingFooterRef, pinnedToBottomRef, returnFrameRef, scopeKey, collapsed, messages }: Options) {
  const [position, setPosition] = useState({ away: false, deepHistory: false })
  const scheduleMeasurement = useRef<(() => void) | null>(null)
  const thirdTurn = useRef<Element | undefined>(undefined)
  useLayoutEffect(() => {
    const turns = scrollContentRef.current?.querySelectorAll('[data-agent-author-turn]')
    thirdTurn.current = turns?.[turns.length - 3]
    scheduleMeasurement.current?.()
  }, [messages, scrollContentRef, collapsed, scopeKey])

  useLayoutEffect(() => {
    const node = scrollRef.current, content = scrollContentRef.current, footer = floatingFooterRef.current
    if (!node || !content || !footer || collapsed) return
    let frame = 0
    function measure() {
      frame = 0
      if (!node || !content || !footer || !node.clientHeight) return
      const edge = footer.getBoundingClientRect().top
      // Measure against the composer without its capsules so fading them cannot reverse the threshold.
      const track = footer.querySelector('[data-agent-capsule-track]')
      const baseline = edge + (track?.getBoundingClientRect().height ?? 0)
      const readingAbove = !pinnedToBottomRef.current && content.getBoundingClientRect().bottom > edge + 12
      // The active tool can still be readable above the end of a long reply.
      const icons = readingAbove ? content.querySelectorAll('[data-agent-tool-motion]') : null
      const progress = icons?.[icons.length - 1]?.getBoundingClientRect()
      const progressVisible = progress && progress.height > 0 && progress.bottom > node.getBoundingClientRect().top && progress.top < edge
      const away = readingAbove && !progressVisible
      const deepHistory = readingAbove && Boolean(thirdTurn.current && thirdTurn.current.getBoundingClientRect().top >= baseline)
      setPosition(old => old.away === away && old.deepHistory === deepHistory ? old : { away, deepHistory })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    scheduleMeasurement.current = schedule
    const stop = () => { cancelAnimationFrame(returnFrameRef.current); returnFrameRef.current = 0 }
    const observer = new ResizeObserver(schedule)
    for (const element of [node, content, footer]) observer.observe(element)
    node.addEventListener('scroll', schedule, { passive: true })
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.addEventListener(event, stop, { passive: true })
    measure()
    return () => {
      scheduleMeasurement.current = null
      stop()
      cancelAnimationFrame(frame)
      observer.disconnect()
      node.removeEventListener('scroll', schedule)
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.removeEventListener(event, stop)
    }
  }, [scrollRef, scrollContentRef, floatingFooterRef, pinnedToBottomRef, returnFrameRef, scopeKey, collapsed])

  const returnToLive = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    cancelAnimationFrame(returnFrameRef.current)
    const start = node.scrollTop
    const started = performance.now()
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0
      : Math.min(520, 240 + (node.scrollHeight - node.clientHeight - start) * 0.07)
    const tick = (now: number) => {
      const part = duration ? Math.max(0, Math.min(1, (now - started) / duration)) : 1
      const bottom = node.scrollHeight - node.clientHeight
      pinnedToBottomRef.current = part === 1
      node.scrollTop = start + (bottom - start) * (1 - (1 - part) ** 3)
      returnFrameRef.current = part < 1 ? requestAnimationFrame(tick) : 0
    }
    tick(started)
  }, [scrollRef, pinnedToBottomRef, returnFrameRef])
  return { ...position, returnToLive }
}
