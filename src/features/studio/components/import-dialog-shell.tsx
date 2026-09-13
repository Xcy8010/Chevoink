import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/** One modal at a time. Escape folds the job; only explicit cancellation cancels it. */
export function ImportDialogShell({ title, description, stage, onClose, children, footer }: {
  title: string
  description: string
  stage: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const composing = useRef(false)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    ) ?? []).filter((element) => {
      if (element.closest('[hidden]') || element.matches(':disabled')) return false
      for (let ancestor: HTMLElement | null = element; ancestor && ancestor !== panel.current; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).display === 'none' || getComputedStyle(ancestor).visibility === 'hidden') return false
      }
      return true
    })
    const focus = () => {
      const elements = focusable()
      ;(elements.find(element => element.hasAttribute('data-import-safe-focus')) ?? elements[0] ?? panel.current)?.focus()
    }
    focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); panel.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    const focusin = (event: FocusEvent) => { if (!panel.current?.contains(event.target as Node)) focus() }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => { panel.current?.querySelector<HTMLElement>('[data-import-safe-focus]')?.focus() }, [stage])

  return createPortal(<div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/45 sm:p-6">
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDownCapture={(event) => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) { event.preventDefault(); event.stopPropagation() } }}
      className="flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden bg-[var(--surface-default)] text-[var(--text-primary)] shadow-xl sm:h-auto sm:max-h-[90dvh] sm:max-w-4xl sm:rounded-2xl [&_button]:min-h-11 [&_button]:min-w-11 [&_input:not([type=checkbox])]:min-h-11 [&_select]:min-h-11">
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border-subtle)] p-4">
        <div className="min-w-0 flex-1"><h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2><p id={`${id}-description`} className="mt-1 break-words text-sm text-[var(--text-secondary)]">{description}</p></div>
        <button type="button" aria-label="收起导入面板" className="flex items-center justify-center rounded-lg hover:bg-[var(--surface-muted)]" onClick={onClose}><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</footer>}
    </div>
  </div>, document.body)
}
