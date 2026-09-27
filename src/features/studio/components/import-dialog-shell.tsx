import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { isTopDialog, useDialogFocusTrap } from './use-dialog-focus-trap'

/** One modal at a time. Escape folds the job; only explicit cancellation cancels it. */
export function ImportDialogShell({ title, description, stage, onClose, children, footer, compact = false }: {
  title: string
  description: string
  stage: string
  onClose: () => void
  children: ReactNode
  compact?: boolean
  footer?: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const composing = useRef(false)
  useDialogFocusTrap({ panel, open: true, onClose: () => { if (!composing.current) close.current() } })
  // Put focus on the safe action in the same commit as the new confirmation,
  // before paint or keyboard input can observe a stale dialog-container focus.
  useLayoutEffect(() => { panel.current?.querySelector<HTMLElement>('[data-import-safe-focus]')?.focus() }, [stage])

  return createPortal(<div className="studio-workspace fixed inset-0 z-[200] flex items-center justify-center bg-black/45 sm:p-6">
    <dialog open data-native-back-dismiss ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}
      onCancel={event => { event.preventDefault(); if (!composing.current && isTopDialog(panel.current)) onClose() }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDownCapture={(event) => { if (event.key === 'Enter' && event.repeat) event.preventDefault(); if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) { event.preventDefault(); event.stopPropagation() } }}
      className={`relative m-0 flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden border-0 bg-[var(--surface-default)] p-0 text-[var(--text-primary)] shadow-xl sm:h-auto sm:max-h-[90dvh] ${compact ? 'sm:max-w-xl' : 'sm:max-w-4xl'} sm:rounded-2xl [&_button]:min-h-11 [&_button]:min-w-11 [&_input:not([type=checkbox])]:min-h-11 [&_select]:min-h-11`}>
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border-subtle)] p-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1"><h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2><p id={`${id}-description`} className="mt-1 break-words text-sm text-[var(--text-secondary)]">{description}</p></div>
        <button type="button" aria-label="收起导入面板" className="flex items-center justify-center rounded-lg hover:bg-[var(--surface-muted)]" onClick={onClose}><X className="h-5 w-5" /></button>
      </header>
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
      {footer && <footer className="flex max-h-[40dvh] shrink-0 flex-wrap items-center justify-end gap-2 overflow-y-auto border-t border-[var(--border-subtle)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</footer>}
    </dialog>
  </div>, document.body)
}
