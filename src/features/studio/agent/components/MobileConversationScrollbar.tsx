import { useLayoutEffect, useRef, type RefObject } from 'react'

const MIN_THUMB_HEIGHT = 16
const MAX_THUMB_HEIGHT = 52

export default function MobileConversationScrollbar({ scrollRef, contentRef, footerRef }: {
  scrollRef: RefObject<HTMLDivElement>
  contentRef: RefObject<HTMLDivElement>
  footerRef: RefObject<HTMLDivElement>
}) {
  const thumbRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    const footer = footerRef.current
    const thumb = thumbRef.current
    if (!scroll || !content || !footer || !thumb) return

    const update = () => {
      const viewport = scroll.clientHeight
      const range = scroll.scrollHeight - viewport
      const track = Math.max(0, viewport - footer.offsetHeight - 16)
      thumb.hidden = range <= 0 || track <= 0
      if (thumb.hidden) return
      const height = Math.min(track, MAX_THUMB_HEIGHT, Math.max(MIN_THUMB_HEIGHT, track * viewport / scroll.scrollHeight))
      const progress = Math.max(0, Math.min(1, scroll.scrollTop / range))
      thumb.style.height = `${height}px`
      thumb.style.transform = `translateY(${progress * (track - height)}px)`
    }

    const resize = new ResizeObserver(update)
    resize.observe(scroll)
    resize.observe(content)
    resize.observe(footer)
    scroll.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      resize.disconnect()
      scroll.removeEventListener('scroll', update)
    }
  }, [scrollRef, contentRef, footerRef])

  return <div ref={thumbRef} className="agent-mobile-scroll-thumb" aria-hidden="true" hidden />
}
