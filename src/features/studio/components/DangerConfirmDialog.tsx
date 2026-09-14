import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { createPortal } from 'react-dom'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'

/**
 * 高危操作确认弹窗：删除作品这类不可撤销动作专用。
 * 传 requiredText 时必须逐字输入该文本才能点确认，用来挡住误触；
 * 不传时退化为「二次点击确认」，供删除任务、创建分支等可接受的动作复用。
 * z-index 高于侧栏右键菜单（z-[190]），避免被菜单层压住。
 */
type DangerConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  /** 需要作者逐字输入的确认文本；为空则不要求输入 */
  requiredText?: string
  /** 输入框上方的提示语，默认按 requiredText 自动生成 */
  requiredHint?: string
  /** 补充说明：列出这次操作会连带清掉什么 */
  bullets?: string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function DangerConfirmDialog({
  open,
  title,
  description,
  requiredText,
  requiredHint,
  bullets,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: DangerConfirmDialogProps) {
  const [value, setValue] = useState('')

  // 每次打开都清空输入，避免上一次的残留让作者一点就删
  useEffect(() => {
    if (open) setValue('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const matched = !requiredText || value.trim() === requiredText
  const canConfirm = matched && !busy

  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(15,23,42,0.32)] px-4 py-8 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-[0_24px_64px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              className={
                tone === 'danger'
                  ? 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[16px] bg-[rgba(127,29,29,0.08)] text-[rgb(153,27,27)]'
                  : 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--text-primary)]'
              }
            >
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-2">
              <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
              <p className="break-words text-sm leading-7 text-[var(--text-secondary)]">{description}</p>
            </div>
          </div>
          <Button onClick={onCancel} variant="ghost" size="sm" className="h-9 w-9 shrink-0 px-0" aria-label="关闭确认弹窗">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {bullets && bullets.length > 0 ? (
          <ul className="mt-4 space-y-1.5 rounded-[16px] bg-[var(--surface-muted)] px-4 py-3">
            {bullets.map((item) => (
              <li key={item} className="flex gap-2 text-[13px] leading-6 text-[var(--text-secondary)]">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
                <span className="min-w-0 break-words">{item}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {requiredText ? (
          <div className="mt-4 space-y-2">
            <p className="text-[13px] leading-6 text-[var(--text-secondary)]">
              {requiredHint ?? (
                <>
                  请输入 <span className="font-semibold text-[var(--text-primary)]">{requiredText}</span> 以确认此操作
                </>
              )}
            </p>
            <TextInput
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canConfirm) {
                  event.preventDefault()
                  onConfirm()
                }
              }}
              placeholder={requiredText}
              aria-label={`输入${requiredText}以确认`}
              className="h-11"
            />
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button onClick={onCancel} variant="ghost" disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            variant={tone === 'danger' ? 'primary' : 'secondary'}
            disabled={!canConfirm}
            className={tone === 'danger' ? 'bg-[rgb(153,27,27)] hover:bg-[rgb(127,29,29)]' : undefined}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
