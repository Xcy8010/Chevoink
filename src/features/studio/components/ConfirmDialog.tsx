import { AlertTriangle, X } from 'lucide-react'
import { createPortal } from 'react-dom'

import Button from '@/components/ui/Button'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) {
    return null
  }

  return createPortal(
    <div data-workspace-confirm-dialog role="dialog" aria-modal="true" aria-label={title} className="studio-workspace fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4 py-8 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-[0_24px_64px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              className={
                tone === 'danger'
                  ? 'inline-flex h-10 w-10 items-center justify-center rounded-[16px] bg-[rgba(127,29,29,0.08)] text-[rgb(153,27,27)]'
                  : 'inline-flex h-10 w-10 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--text-primary)]'
              }
            >
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
              <p className="text-sm leading-7 text-[var(--text-secondary)]">{description}</p>
            </div>
          </div>
          <Button
            onClick={onCancel}
            variant="ghost"
            size="sm"
            className="h-9 w-9 px-0"
            aria-label="关闭确认弹窗"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button onClick={onCancel} variant="ghost" disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            variant={tone === 'danger' ? 'primary' : 'secondary'}
            disabled={busy}
            className={tone === 'danger' ? 'bg-[rgb(153,27,27)] hover:bg-[rgb(127,29,29)]' : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
