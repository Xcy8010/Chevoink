import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Trash2, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useDialogFocusTrap } from './use-dialog-focus-trap'
import './document-settings-layout.css'

type StudioDocumentSettingsDrawerProps = {
  title: string
  documentName?: string
  insetOnMobile?: boolean
  deleteAction?: { label: string; description: string; onClick: () => void }
  children: ReactNode
  footer: ReactNode
  busy?: boolean
  onClose: () => void
  overlayClassName?: string
}

export default function StudioDocumentSettingsDrawer({
  title, documentName, insetOnMobile = false, deleteAction, children, footer, busy = false, onClose, overlayClassName,
}: StudioDocumentSettingsDrawerProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const namedDocument = documentName !== undefined
  const heading = namedDocument ? `${title} · ${documentName}` : title
  useDialogFocusTrap({ panel: panelRef, open: namedDocument, onClose: () => { if (!busy) onClose() } })
  useEffect(() => {
    if (namedDocument) return
    const panel = panelRef.current
    const trigger = document.activeElement
    panel?.focus({ preventScroll: true })
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected
        && (document.activeElement === document.body || panel?.contains(document.activeElement))) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [namedDocument])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const confirmation = document.querySelector('[data-workspace-confirm-dialog]')
    if (confirmation) {
      if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        confirmation.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onClose()
      return
    }
    if (event.key !== 'Tab') return
    const panel = event.currentTarget
    const controls = panel.querySelectorAll<HTMLElement>(':is(button, input, textarea, select, summary):not(:disabled)')
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
      className={cn('studio-tool-overlay studio-workspace fixed inset-0 bg-black/30', overlayClassName ?? 'z-[110]')}
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
        onKeyDown={namedDocument ? undefined : handleKeyDown}
        className={cn('studio-tool-dialog absolute flex min-h-0 flex-col overflow-hidden border-[var(--border-subtle)] bg-[var(--app-bg)] text-[var(--text-primary)] shadow-[var(--shadow-modal)] outline-none',
          documentName && 'document-settings-dialog',
          insetOnMobile
            ? 'inset-y-4 right-4 w-[min(28rem,calc(100vw-2rem))] rounded-[28px] border'
            : 'right-0 top-0 bottom-[var(--keyboard-inset,0px)] w-full max-w-[28rem] border-l pl-[var(--safe-left,0px)] pr-[var(--safe-right,0px)]')}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 pb-3 pt-[calc(var(--safe-top,0px)+0.75rem)] sm:px-5">
          <h2 id={titleId} className="min-w-0 truncate text-lg font-semibold" title={heading} aria-label={heading}>
            {title}{documentName && <span className="document-settings-name"> · {documentName}</span>}
          </h2>
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
            size="sm"
            className="h-9 w-9 shrink-0 rounded-lg p-0"
            aria-label={`关闭${title}`}
            disabled={busy}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>
        <div data-studio-settings-scroll className={cn('studio-tool-body min-h-0 flex-auto overflow-x-hidden overflow-y-auto overscroll-contain',
          documentName ? 'document-settings-body' : 'studio-document-grid space-y-4 px-4 py-4 sm:px-5')}>
          {children}
        </div>
        <footer className="flex shrink-0 justify-end border-t border-[var(--border-subtle)] px-4 pb-[calc(var(--bottom-bar-inset,0px)+0.75rem)] pt-3 sm:px-5">
          {deleteAction && <Button onClick={deleteAction.onClick} variant="ghost" size="sm" className="document-settings-delete mr-auto shrink-0 rounded-lg"
            title={deleteAction.description} aria-description={deleteAction.description}>
            <Trash2 aria-hidden="true" className="h-4 w-4" />{deleteAction.label}
          </Button>}
          {footer}
        </footer>
      </section>
    </div>
  )
}
