import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'

type StudioDocumentSettingsDrawerProps = {
  title: string
  children: ReactNode
  footer: ReactNode
  busy?: boolean
  onClose: () => void
  overlayClassName?: string
}

export default function StudioDocumentSettingsDrawer({
  title, children, footer, busy = false, onClose, overlayClassName,
}: StudioDocumentSettingsDrawerProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const trigger = document.activeElement
    const panel = panelRef.current
    panel?.focus({ preventScroll: true })
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected
        && (document.activeElement === document.body || panel?.contains(document.activeElement))) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    const confirmation = document.querySelector('[data-workspace-confirm-dialog]')
    if (confirmation) {
      if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        confirmation.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
      }
      return
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onClose()
      return
    }
    if (event.key !== 'Tab') return

    const panel = event.currentTarget
    const controls = panel.querySelectorAll<HTMLElement>(':is(button, input, textarea):not(:disabled)')
    const first = controls[0] ?? panel
    const last = controls[controls.length - 1] ?? panel
    const focused = document.activeElement
    if (focused === panel || focused === (event.shiftKey ? first : last)) {
      event.preventDefault()
      const next = event.shiftKey ? last : first
      next.focus()
    }
  }

  return (
    <div
      className={cn('studio-workspace fixed inset-0 bg-black/30', overlayClassName ?? 'z-[110]')}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="absolute right-0 top-0 bottom-[var(--keyboard-inset,0px)] flex w-full max-w-[28rem] flex-col overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--app-bg)] pl-[var(--safe-left,0px)] pr-[var(--safe-right,0px)] text-[var(--text-primary)] shadow-[var(--shadow-modal)] outline-none lg:bg-[var(--surface-solid)]"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 pb-3 pt-[calc(var(--safe-top,0px)+0.75rem)] sm:px-5">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
            size="sm"
            className="h-9 w-9 rounded-lg p-0"
            aria-label={`关闭${title}`}
            disabled={busy}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>
        <div data-studio-settings-scroll className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {children}
        </div>
        <footer className="flex shrink-0 justify-end border-t border-[var(--border-subtle)] px-4 pb-[calc(var(--safe-bottom,0px)+0.75rem)] pt-3 sm:px-5">
          {footer}
        </footer>
      </section>
    </div>
  )
}
