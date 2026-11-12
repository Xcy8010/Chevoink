import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

const scrollOffset = 'scroll-mt-[calc(var(--safe-top)+1rem)] md:scroll-mt-[calc(var(--app-header-height,0px)+1rem)]'

export function SectionTitle({ children }: { children: string }) {
  return (
    <h2
      tabIndex={-1}
      className={cn(scrollOffset, 'mb-2.5 rounded-sm px-1 text-[15px] font-semibold text-[var(--text-primary)] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]')}
    >
      {children}
    </h2>
  )
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-solid)]">
      {children}
    </div>
  )
}

/** 单行设置项外壳：图标 + 标题/说明 + 右侧值区，行本身可点击 */
export interface SettingsRowProps {
  icon: ReactNode
  bareIcon?: boolean
  title: string
  searchKeywords?: string
  caption?: string
  value?: ReactNode
  actions?: ReactNode
  chevron?: 'right' | 'down' | 'up' | 'none'
  onClick?: () => void
  danger?: boolean
}

export function SettingsRow({
  icon, bareIcon, title, searchKeywords, caption, value, actions, chevron = 'none', onClick, danger,
}: SettingsRowProps) {
  const rowClass = cn(
    'flex min-h-[64px] w-full items-center gap-3 px-3.5 py-3 text-left sm:px-4',
    scrollOffset,
    actions && 'flex-wrap',
  )
  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
          !bareIcon && 'bg-[var(--surface-muted)]',
          danger ? 'text-[var(--color-error)]' : 'text-[var(--text-secondary)]',
        )}
      >
        {icon}
      </span>
      <span className={cn('flex-1 text-left', actions ? 'min-w-[min(35%,9rem)]' : 'min-w-0')}>
        <span
          className={cn(
            'block text-[15px] font-medium leading-5',
            danger ? 'text-[var(--color-error)]' : 'text-[var(--text-primary)]',
          )}
        >
          {title}
        </span>
        {caption ? <span className="mt-1 block text-[13px] leading-[1.125rem] text-[var(--text-secondary)] [overflow-wrap:anywhere]">{caption}</span> : null}
      </span>
      {actions ? <span className="ml-auto flex max-w-full shrink-0 items-center justify-end gap-1.5">{actions}</span> : null}
      {value ? <span className="max-w-[42%] shrink-0 break-words text-right text-[13px] font-medium text-[var(--text-secondary)]">{value}</span> : null}
      {chevron === 'right' ? <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" /> : null}
      {chevron === 'down' || chevron === 'up' ? (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-4 w-4 shrink-0 text-[var(--text-tertiary)] motion-safe:transition-transform',
            chevron === 'up' && 'rotate-180',
          )}
        />
      ) : null}
    </>
  )

  if (!onClick) {
    return <div tabIndex={-1} data-setting-title={title} data-setting-keywords={searchKeywords}
      className={cn(rowClass, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]')}>{content}</div>
  }

  return (
    <button
      type="button"
      data-setting-title={title}
      data-setting-keywords={searchKeywords}
      onClick={onClick}
      className={cn(
        rowClass,
        'hover:bg-[var(--surface-muted)] active:bg-[var(--color-brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)] motion-safe:transition-colors',
      )}
    >
      {content}
    </button>
  )
}
