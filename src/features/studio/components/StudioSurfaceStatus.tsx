import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { StudioPresence } from './StudioPresence'
import StudioPaneSkeleton, { type StudioPaneShape } from './StudioPaneSkeleton'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

export default function StudioSurfaceStatus({ open = true, label, retry, close, shape }: { open?: boolean; label: string; shape?: StudioPaneShape; retry?: () => void; close?: () => void }) {
  const feedback = retry ? <div role="alert" className="text-sm">
    {label}加载失败。<button type="button" className="underline" onClick={retry}>重试</button>
  </div> : <StudioPaneSkeleton label={`正在打开${label}`} shape={close ? 'dialog' : shape} />
  if (!close && !retry) return feedback
  if (!close) return <div className="grid min-h-12 flex-1 place-items-center">{feedback}</div>
  return <PendingDialog open={open} immediate={!!retry} close={close}>
    <FeedbackDialog label={label} close={close}>{feedback}</FeedbackDialog>
  </PendingDialog>
}

function PendingDialog({ open, immediate, close, children }: { open: boolean; immediate: boolean; close: () => void; children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!open || immediate) { setVisible(false); return }
    const timer = window.setTimeout(() => setVisible(true), 200)
    return () => window.clearTimeout(timer)
  }, [open, immediate])
  // A quick Escape can cancel an opening dialog while focus is still on the trigger.
  useEffect(() => {
    if (!open || immediate || visible) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
      }
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [close, immediate, open, visible])
  return createPortal(<StudioPresence kind="dialog">{open && (visible || immediate) && children}</StudioPresence>, document.body)
}

function FeedbackDialog({ label, close, children }: { label: string; close: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  useDialogFocusTrap({ panel, open: true, onClose: close })
  return <div className="studio-workspace fixed inset-0 z-[200] grid place-items-center bg-black/30 p-4">
    <div data-studio-motion-panel ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      className="flex items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] px-5 py-3 text-[var(--text-primary)] shadow-lg">
      {children}<button type="button" className="min-h-11 px-2 text-sm" onClick={close}>关闭</button>
    </div>
  </div>
}
