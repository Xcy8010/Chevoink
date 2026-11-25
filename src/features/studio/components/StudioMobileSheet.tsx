import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

type Dismiss = (afterClose?: () => void) => void

/** Native modal semantics keep the sheet above, and focus inside, mobile navigation. */
export default function StudioMobileSheet({ title, label, closeLabel, trigger, busy = false, onClose, children }: {
  title: string
  label?: string
  closeLabel: string
  trigger: HTMLElement
  busy?: boolean
  onClose: () => void
  children: (dismiss: Dismiss) => ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const [closing, setClosing] = useState(false)
  const timer = useRef<number | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    node.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      node.close()
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [trigger])

  const dismiss: Dismiss = afterClose => {
    if (timer.current !== null) return
    const finish = () => { close.current(); afterClose?.() }
    if (document.documentElement.dataset.studioReducedMotion === 'true' || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
      return
    }
    setClosing(true)
    timer.current = window.setTimeout(finish, 200)
  }

  return <dialog ref={dialog} className="studio-mobile-sheet studio-popover-glass" data-state={closing ? 'closing' : 'open'}
    aria-label={label} aria-labelledby={label ? undefined : heading} data-native-back-dismiss
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) dismiss() }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss()
    }}>
    <header className="studio-mobile-sheet-header">
      <h2 id={heading} tabIndex={-1} className="min-w-0 flex-1 truncate text-base font-semibold outline-none">{title}</h2>
      <button type="button" aria-label={closeLabel} disabled={busy || closing} onClick={() => dismiss()} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] disabled:opacity-45"><X aria-hidden="true" className="h-5 w-5" strokeWidth={1.8} /></button>
    </header>
    <div className="studio-mobile-sheet-body">{children(dismiss)}</div>
  </dialog>
}
