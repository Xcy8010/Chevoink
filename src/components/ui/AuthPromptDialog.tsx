import { useId, useLayoutEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'

import Button from '@/components/ui/Button'
import ChevoinkMascot from '@/components/ui/ChevoinkMascot'

type AuthPromptDialogProps = {
  open: boolean
  /** 弹窗标题，默认「登录后继续」 */
  title?: string
  /** 说明文案，告诉用户登录后能做什么 */
  description?: string
  /** 登录/注册完成后回跳的路径，默认当前页 */
  redirectPath?: string
  onClose: () => void
}

export default function AuthPromptDialog({
  open,
  title = '登录后继续',
  description = '登录或注册后，就可以发布内容、收藏作品并和大家互动。',
  redirectPath,
  onClose,
}: AuthPromptDialogProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    const previousFocus = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) {
    return null
  }

  const redirect = encodeURIComponent(
    redirectPath ?? `${location.pathname}${location.search}${location.hash}`,
  )

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
      className="account-dialog fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-[400px] overflow-hidden rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-0 text-[var(--text-primary)] shadow-xl backdrop:bg-black/25 backdrop:backdrop-blur-sm"
    >
      <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-6">
        <header className="relative text-center">
          <ChevoinkMascot pose="welcome" className="mx-auto size-20" />
          <div className="mt-2 space-y-2">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            <p id={descriptionId} className="text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
          </div>
          <Button onClick={onClose} variant="ghost" size="sm" className="absolute right-0 top-0 h-9 w-9 px-0" aria-label="关闭">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="mt-6 space-y-3">
          <Button
            variant="primary"
            className="h-11 w-full"
            onClick={() => {
              onClose()
              navigate(`/login?redirect=${redirect}`)
            }}
          >
            去登录
          </Button>
          <Button
            variant="secondary"
            className="h-11 w-full"
            onClick={() => {
              onClose()
              navigate(`/register?redirect=${redirect}`)
            }}
          >
            创建新账户
          </Button>
        </div>
      </div>
    </dialog>,
    document.body,
  )
}
