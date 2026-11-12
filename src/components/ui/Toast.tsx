import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Info, XCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ToastContext, type ToastContextValue, type ToastTone } from './toast-context'

type ToastItem = {
  id: number
  tone: ToastTone
  message: string
}

const toneConfig: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: {
    icon: CheckCircle2,
    className: 'border-[var(--color-success)]/30 bg-[var(--color-success)] text-white',
  },
  error: {
    icon: XCircle,
    className: 'border-[var(--color-error)]/30 bg-[var(--color-error)] text-white',
  },
  info: {
    icon: Info,
    className: 'border-[var(--border-strong)] bg-[var(--surface-contrast)] text-[var(--text-contrast)]',
  },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [dialogs, setDialogs] = useState<HTMLDialogElement[]>([])
  const idRef = useRef(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const dialog = dialogs.at(-1)
  const useTopLayer = Boolean(dialog && typeof HTMLElement.prototype.showPopover === 'function')

  const registerDialog = useCallback((dialog: HTMLDialogElement) => {
    setDialogs(current => [...current, dialog])
    return () => setDialogs(current => current.filter(item => item !== dialog))
  }, [])

  // Native modal dialogs sit above document z-index and make outside content
  // inert. Keep the single toast viewport inside the active account dialog.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (useTopLayer && viewport) {
      viewport.setAttribute('popover', 'manual')
      viewport.showPopover()
    }
  }, [dialog, useTopLayer])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      idRef.current += 1
      const id = idRef.current
      setToasts((current) => [...current.slice(-2), { id, tone, message }])
      window.setTimeout(() => dismiss(id), 3000)
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (message: string) => toast(message, 'success'),
      error: (message: string) => toast(message, 'error'),
      info: (message: string) => toast(message, 'info'),
      registerDialog,
    }),
    [toast, registerDialog],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div ref={viewportRef}
          className={cn('pointer-events-none inset-x-0 bottom-auto z-[150] m-0 flex w-full max-w-none flex-col items-center gap-2 border-0 bg-transparent px-4 py-0',
            dialog && !useTopLayer ? 'absolute top-3' : 'fixed top-[calc(var(--safe-top)+12px)]')}>
          {toasts.map((item) => {
            const config = toneConfig[item.tone]
            const Icon = config.icon
            return (
              <div
                key={item.id}
                role="status"
                className={cn(
                  'animate-toast-slide-down pointer-events-auto flex max-w-[min(420px,100%)] items-center gap-2 rounded-[var(--radius-pill)] border px-4 py-2.5 text-sm font-medium shadow-[var(--shadow-elevated)]',
                  config.className,
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="line-clamp-2">{item.message}</span>
              </div>
            )
          })}
        </div>,
        dialog ?? document.body,
      )}
    </ToastContext.Provider>
  )
}
