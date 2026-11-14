import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'

export const personalizationCard = 'divide-y divide-[var(--border-subtle)] rounded-2xl border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--surface-default)_50%,var(--surface-elevated))]'
export const personalizationRow = 'flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2.5 sm:gap-5 sm:px-5'
export const personalizationField = 'min-h-11 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50'

export function PersonalizationGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return <section aria-labelledby={id}>
    <h2 id={id} className="mb-2.5 text-sm font-semibold">{title}</h2>
    <div className={personalizationCard}>{children}</div>
  </section>
}

export function PersonalizationFeedback({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p role={error ? 'alert' : 'status'} className={cn('text-sm', error ? 'text-rose-700 dark:text-rose-400' : 'text-[var(--text-secondary)]')}>{children}</p>
}

export function PersonalizationDialog({ title, children, footer, wide, busy = false, onClose, returnFocus }: {
  title: string
  children: ReactNode
  footer: ReactNode
  wide?: boolean
  busy?: boolean
  onClose: () => void
  returnFocus: () => HTMLElement | null
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const focusOnClose = useRef(returnFocus)
  focusOnClose.current = returnFocus

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-personalization-focus]')?.focus({ preventScroll: true })
    return () => {
      dialog.close()
      focusOnClose.current()?.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <dialog
      ref={ref}
      data-native-back-dismiss
      aria-labelledby={id}
      onCancel={event => {
        event.preventDefault()
        event.stopPropagation()
        if (!busy) onClose()
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
      className={cn(
        'studio-workspace fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[520px] flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--surface-default)_50%,var(--surface-elevated))] p-0 text-[var(--text-primary)] shadow-2xl open:flex backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        wide && 'max-w-[620px]',
      )}
    >
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
        <h2 id={id} className="text-base font-semibold sm:text-lg">{title}</h2>
        <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" aria-label={`关闭${title}`} onClick={onClose} disabled={busy}>
          <X className="size-5" aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 grow overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6">{children}</div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:px-6">
        {footer}
      </footer>
    </dialog>,
    document.body,
  )
}
