import type { ReactNode } from 'react'
import { AlertCircle, LoaderCircle, SearchX } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'

type AppStateTone = 'loading' | 'empty' | 'error'

type AppStateAction = {
  label: string
  onClick?: () => void
  href?: string
}

type AppStateProps = {
  tone?: AppStateTone
  eyebrow?: string
  title: string
  description?: string
  details?: ReactNode
  primaryAction?: AppStateAction
  secondaryAction?: AppStateAction
  className?: string
  icon?: ReactNode
}

const toneIconMap = {
  loading: LoaderCircle,
  empty: SearchX,
  error: AlertCircle,
} as const

export default function AppState({
  tone = 'empty',
  eyebrow,
  title,
  description,
  details,
  primaryAction,
  secondaryAction,
  className,
  icon,
}: AppStateProps) {
  const Icon = toneIconMap[tone]

  return (
    // 空态/加载/错误提示不再套卡片容器：无边框无底色，直接融入页面背景
    <section
      className={cn('flex min-h-[220px] items-center justify-center p-4 text-center md:min-h-[280px] md:p-5', className)}
    >
      <div className={cn('mx-auto flex max-w-xl flex-col items-center', tone === 'error' && 'max-w-sm')}>
        {icon ?? <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
          <Icon aria-hidden="true" className={cn('h-5 w-5', tone === 'loading' && 'motion-safe:animate-spin')} />
        </span>}
        {eyebrow ? (
          <p className="mt-4 text-xs font-medium text-[var(--text-tertiary)]">{eyebrow}</p>
        ) : null}
        <h2 className={cn('mt-3 text-base font-medium text-[var(--text-primary)]', tone === 'error' && 'text-lg font-semibold tracking-tight')}>{title}</h2>
        {description ? <p className="mt-1.5 text-sm leading-6 text-[var(--text-tertiary)]">{description}</p> : null}
        {details ? <div className="mt-4 w-full text-left text-sm leading-6 text-[var(--text-secondary)]">{details}</div> : null}
        {primaryAction || secondaryAction ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {primaryAction ? (
              primaryAction.href ? (
                <Link
                  to={primaryAction.href}
                  className="inline-flex h-11 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--surface-contrast)] px-4 text-sm font-medium text-[var(--text-contrast)] transition-colors hover:bg-[var(--surface-contrast-hover)]"
                >
                  {primaryAction.label}
                </Link>
              ) : (
                <Button variant="primary" onClick={primaryAction.onClick}>
                  {primaryAction.label}
                </Button>
              )
            ) : null}
            {secondaryAction ? (
              secondaryAction.href ? (
                <Link
                  to={secondaryAction.href}
                  className="inline-flex h-11 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  {secondaryAction.label}
                </Link>
              ) : (
                <Button variant="secondary" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </Button>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
