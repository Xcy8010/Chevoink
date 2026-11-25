import { StudioPresence } from '@/features/studio/components/StudioPresence'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

type Perspective = 'work' | 'ide'
type MenuProps = {
  perspective: Perspective
  enabled: boolean
  onChange: (value: Perspective) => void
}
const modes = [
  { value: 'work', title: 'Studio', description: '对话、任务与创作' },
  { value: 'ide', title: 'Editor', description: '结构、正文与预览' },
] as const

export function StudioPerspectiveMenu({ perspective, enabled, onChange }: MenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [open])

  return <div ref={root} className="relative min-w-0" onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
  }}>
    <button ref={trigger} type="button" data-studio-mode-trigger={perspective}
      className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg px-2 text-[18px] font-semibold leading-6 tracking-tight text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      {perspective === 'work' ? 'Studio' : 'Editor'}
      <ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] motion-safe:transition-transform', open && 'rotate-180')} />
    </button>
    <StudioPresence kind="menu">{open && <div id={id} role="group" aria-label="工作模式"
      className="studio-floating-menu absolute left-0 [--studio-motion-origin:top_left] top-[calc(100%+5px)] z-50 w-60 rounded-[14px] border border-[var(--border-subtle)] p-1.5 shadow-[0_12px_32px_rgba(0,0,0,.2)]">
      {modes.map(mode => <button key={mode.value} type="button" disabled={!enabled}
        aria-label={mode.title + ' ' + mode.description} aria-pressed={perspective === mode.value} onClick={() => {
          setOpen(false)
          trigger.current?.focus()
          onChange(mode.value)
        }}
        className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left hover:bg-[var(--surface-muted)] disabled:opacity-50">
        <span className="min-w-0 flex-1"><strong className="block text-sm font-semibold">{mode.title}</strong>
          <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">{mode.description}</span></span>
        {perspective === mode.value && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
      </button>)}
    </div>}</StudioPresence>
  </div>
}

export default function StudioSidebarHeader({ actions, onSearch, ...mode }: MenuProps & { actions?: ReactNode; onSearch: () => void }) {
  return <div className="flex h-12 shrink-0 items-center gap-1 px-3" data-studio-sidebar-header>
    <div className="min-w-0 flex-1"><StudioPerspectiveMenu {...mode} /></div>
    {actions}
    <button type="button" onClick={onSearch} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" aria-label="搜索作品与任务" title="搜索（Ctrl+K）">
      <Search aria-hidden="true" className="h-4 w-4" />
    </button>
  </div>
}
