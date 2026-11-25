import type { ReactNode, SelectHTMLAttributes } from 'react'
import { Check, Clock3, LoaderCircle, RefreshCcw } from 'lucide-react'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'

import type { SaveState } from '../types'

export function InputLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
      {hint ? <p className="text-xs leading-5 text-[var(--text-secondary)]">{hint}</p> : null}
    </div>
  )
}

export function SelectControl({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn('studio-form-select', className)}>{children}</select>
  )
}

export function SegmentedOptionGroup({
  value,
  options,
  onChange,
  className,
}: {
  value: string
  options: Array<{
    value: string
    label: string
    tone?: 'default' | 'danger'
  }>
  onChange: (nextValue: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex min-h-10 items-center justify-center rounded-full border px-4 text-sm font-medium transition',
              active
                ? option.tone === 'danger'
                  ? 'border-[rgba(127,29,29,0.28)] bg-[rgba(127,29,29,0.1)] text-[rgb(127,29,29)]'
                  : 'border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--text-primary)]'
                : option.tone === 'danger'
                  ? 'border-[rgba(127,29,29,0.16)] bg-transparent text-[rgb(153,27,27)] hover:bg-[rgba(127,29,29,0.06)]'
                  : 'border-[var(--border-subtle)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
            )}
            aria-pressed={active}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function ActionCommandButton({
  icon,
  label,
  onClick,
  disabled = false,
  tone = 'default',
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-11 items-center justify-start gap-2 rounded-[16px] border px-4 text-sm font-medium transition',
        tone === 'danger'
          ? 'border-[rgba(127,29,29,0.18)] text-[rgb(153,27,27)] hover:bg-[rgba(127,29,29,0.06)] hover:text-[rgb(127,29,29)]'
          : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
        disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-inherit',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

export function SaveStatusPill({
  state,
  message,
  onRetry,
  compact = false,
  shortMessage,
  onPress,
}: {
  state: SaveState
  message: string
  onRetry?: () => void
  compact?: boolean
  /** 窄屏下只展示的短文案（如「已自动保存」），完整信息交给 onPress */
  shortMessage?: string
  /** 点击胶囊时回调（例如用 toast 展示完整保存时间） */
  onPress?: () => void
}) {
  const icon =
    state === 'saving' ? (
      <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
    ) : state === 'saved' ? (
      <Check className="h-4 w-4 shrink-0" />
    ) : state === 'error' ? (
      <RefreshCcw className="h-4 w-4 shrink-0" />
    ) : (
      <Clock3 className="h-4 w-4 shrink-0" />
    )

  const content = (
    <>
      {icon}
      <span className={cn('min-w-0 truncate', compact ? 'max-w-[8rem]' : 'max-w-[16rem] md:max-w-[22rem]')}>
        {shortMessage ?? message}
      </span>
    </>
  )

  if (state === 'error' && onRetry) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onRetry}
        className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-[var(--border-subtle)] px-3 text-xs text-[var(--text-secondary)]"
      >
        {content}
      </Button>
    )
  }

  if (onPress) {
    return (
      <button
        type="button"
        onClick={onPress}
        className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-muted)]"
      >
        {content}
      </button>
    )
  }

  return (
    <div className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-secondary)]">
      {content}
    </div>
  )
}

export function ToolShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div className="mt-4 min-h-0 flex-1">{children}</div>
    </div>
  )
}
