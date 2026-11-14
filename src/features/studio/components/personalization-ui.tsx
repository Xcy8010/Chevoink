import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

export function PersonalizationGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return <section className="studio-settings-group" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    <div className="studio-settings-card">{children}</div>
  </section>
}

export function PersonalizationFeedback({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p role={error ? 'alert' : 'status'} className={cn('studio-settings-feedback', error && 'error')}>{children}</p>
}

export function PersonalizationDialog({ title, children, footer, kind, toolbar, busy = false, onClose, returnFocus }: {
  title: string
  children: ReactNode
  footer: ReactNode
  kind?: 'manager' | 'confirm'
  toolbar?: ReactNode
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
      onClick={event => {
        if (busy || event.target !== event.currentTarget) return
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect()
        if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) onClose()
      }}
      className={cn('studio-settings-style studio-settings-dialog', kind)}
    >
      <header className="studio-settings-dialog-header">
        <h2 id={id}>{title}</h2>
        {kind !== 'confirm' ? <button type="button" className="studio-settings-icon-button" aria-label={`关闭${title}`} onClick={onClose} disabled={busy}>
          <X strokeWidth={1.6} aria-hidden="true" />
        </button> : null}
      </header>
      {toolbar ? <div className="studio-settings-toolbar">{toolbar}</div> : null}
      <div className="studio-settings-dialog-body">{children}</div>
      <footer className="studio-settings-dialog-footer">{footer}</footer>
    </dialog>,
    document.body,
  )
}
