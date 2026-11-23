import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import StudioPaneSkeleton, { type StudioPaneShape } from './StudioPaneSkeleton'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

export default function StudioSurfaceStatus({ label, retry, close, shape }: { label: string; shape?: StudioPaneShape; retry?: () => void; close?: () => void }) {
  const feedback = retry ? <div role="alert" className="text-sm">
    {label}加载失败。<button type="button" className="underline" onClick={retry}>重试</button>
  </div> : <StudioPaneSkeleton label={`正在打开${label}`} shape={close ? 'dialog' : shape} />
  if (!close && !retry) return feedback
  if (!close) return <div className="grid min-h-12 flex-1 place-items-center">{feedback}</div>
  const dialog = <FeedbackDialog label={label} close={close}>{feedback}</FeedbackDialog>
  return retry ? dialog : <PendingDialog close={close}>{dialog}</PendingDialog>
}

function PendingDialog({ close, children }: { close: () => void; children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200)
    return () => window.clearTimeout(timer)
  }, [])
  // A quick Escape can cancel an opening dialog while focus is still on the trigger.
  useEffect(() => {
    if (visible) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
      }
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [close, visible])
  return visible ? children : null
}

function FeedbackDialog({ label, close, children }: { label: string; close: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  useDialogFocusTrap({ panel, open: true, onClose: close })
  return createPortal(<div className="studio-workspace fixed inset-0 z-[200] grid place-items-center bg-black/30 p-4">
    <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      className="flex items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] px-5 py-3 text-[var(--text-primary)] shadow-lg">
      {children}<button type="button" className="min-h-11 px-2 text-sm" onClick={close}>关闭</button>
    </div>
  </div>, document.body)
}
