import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Keep the same content mounted through a short exit, without changing execution state. */
export function AgentProcessRegion({ open, children, className, id }: { open: boolean; children: ReactNode; className?: string; id?: string }) {
  const [present, setPresent] = useState(open)
  const [expanded, setExpanded] = useState(open)
  const node = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (node.current) node.current.inert = !open
    if (open) {
      setPresent(true)
      const frame = setTimeout(() => setExpanded(true), 16)
      return () => clearTimeout(frame)
    }
    if (!present) return
    setExpanded(false)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setPresent(false); return }
    const timer = setTimeout(() => setPresent(false), 220)
    return () => clearTimeout(timer)
  }, [open, present])
  if (!present && !open) return null
  return <div ref={node} id={id} aria-hidden={!open || undefined} data-agent-process-open={expanded}
    className={cn('agent-process-region', className)} onTransitionEnd={event => {
      if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows' && !open) setPresent(false)
    }}><div className="min-h-0 overflow-hidden">{children}</div></div>
}
