import { useRef } from 'react'
import { createPortal } from 'react-dom'

import LoadingMark from '@/components/ui/LoadingMark'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

export default function StudioSurfaceStatus({ label, retry, close }: { label: string; retry?: () => void; close?: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useDialogFocusTrap({ panel, open: Boolean(close), onClose: () => close?.() })
  const feedback = retry ? <div role="alert" className="text-sm">
    {label}加载失败。<button type="button" className="underline" onClick={retry}>重试</button>
  </div> : <LoadingMark label={`正在打开${label}`} className="m-auto" />
  if (!close) return <div className="grid min-h-12 flex-1 place-items-center">{feedback}</div>
  return createPortal(<div className="studio-workspace fixed inset-0 z-[200] grid place-items-center bg-black/30 p-4">
    <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      className="flex items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] px-5 py-3 text-[var(--text-primary)] shadow-lg">
      {feedback}<button type="button" className="min-h-11 px-2 text-sm" onClick={close}>关闭</button>
    </div>
  </div>, document.body)
}
