import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function ActivityScrollArea({ children, detail = false }: { children: ReactNode; detail?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<'fit' | 'more' | 'end'>('fit')

  function measure() {
    const node = viewport.current
    if (!node) return
    const overflow = node.scrollHeight - node.clientHeight
    setPosition(overflow <= 1 ? 'fit' : overflow - node.scrollTop > 1 ? 'more' : 'end')
  }

  useLayoutEffect(() => {
    measure()
    if (!viewport.current || !content.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport.current)
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [])

  const scrollable = position !== 'fit'
  return <div className="agent-activity-scroll-frame" data-activity-scroll-more={position === 'more' || undefined}>
    <div ref={viewport} className="agent-activity-scroll" onScroll={measure} data-activity-scroll={detail ? 'detail' : 'records'}
      role={scrollable ? 'group' : undefined} aria-label={scrollable ? detail ? '工具详情' : '工具记录' : undefined} tabIndex={scrollable ? 0 : undefined}>
      <div ref={content}>{children}</div>
    </div>
  </div>
}
