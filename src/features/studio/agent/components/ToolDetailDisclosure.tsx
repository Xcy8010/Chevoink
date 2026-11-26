import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentProcessRegion } from './AgentProcessRegion'

export function ToolDetailDisclosure({ label, children, leadingChevron = false }: {
  label: string; children: ReactNode; leadingChevron?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      className="flex w-fit max-w-full items-center gap-1 text-left hover:text-[var(--text-primary)] focus-visible:underline">
      {label}<ChevronRight aria-hidden className={cn('size-3 shrink-0 motion-safe:transition-transform motion-safe:duration-200', leadingChevron && 'order-first', open && 'rotate-90')} />
    </button>
    <AgentProcessRegion id={id} open={open}>{children}</AgentProcessRegion>
  </>
}
