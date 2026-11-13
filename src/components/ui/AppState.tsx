import { useRef, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import ChevoinkMascot, { type ChevoinkMascotPose } from '@/components/ui/ChevoinkMascot'
import { cn } from '@/lib/utils'

type AppStateTone = 'loading' | 'empty' | 'error'

type AppStateAction = {
  label: string
} & (
  | { href: string }
  | { onClick: () => void | Promise<unknown>; pendingLabel?: string; busy?: boolean }
)

type AppStateProps = {
  tone?: AppStateTone
  scene?: ChevoinkMascotPose
  compact?: boolean
  eyebrow?: string
  title: string
  description?: string
  details?: ReactNode
  primaryAction?: AppStateAction
  secondaryAction?: AppStateAction
  className?: string
  icon?: ReactNode
}

function StateAction({ action, variant }: { action: AppStateAction; variant: 'primary' | 'secondary' | 'ghost' }) {
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  if ('href' in action) {
    return (
      <Link
        to={action.href}
        className={cn(
          'inline-flex h-11 items-center justify-center rounded-[var(--radius-pill)] px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          variant === 'primary'
            ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)] hover:bg-[var(--surface-contrast-hover)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
        )}
      >
        {action.label}
      </Link>
    )
  }

  const { onClick } = action
  const busy = pending || action.busy
  function runAction() {
    if (inFlight.current || busy) return

    setFailed(false)
    const result = onClick()
    if (!result) return

    inFlight.current = true
    setPending(true)
    function settle() {
      inFlight.current = false
      setPending(false)
    }
    void result.then(settle, () => {
      setFailed(true)
      settle()
    })
  }

  return (
    <>
      <Button variant={variant} size={variant === 'ghost' ? 'sm' : 'md'} onClick={runAction} disabled={busy} aria-busy={busy || undefined}>
        {busy ? action.pendingLabel ?? '正在重试…' : action.label}
      </Button>
      {failed ? <span role="alert" className="text-sm text-[var(--text-secondary)]">重试失败，请稍后再试。</span> : null}
    </>
  )
}

export function AppStateRefreshNotice({ retry, busy }: { retry: () => Promise<unknown>; busy?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 px-3 py-1 text-sm text-[var(--text-secondary)]">
      <p role="status">更新失败，正在显示上次加载的内容。</p>
      <StateAction action={{ label: '重试', onClick: retry, busy }} variant="ghost" />
    </div>
  )
}

export default function AppState({
  tone = 'empty',
  scene,
  compact = false,
  eyebrow,
  title,
  description,
  details,
  primaryAction,
  secondaryAction,
  className,
  icon,
}: AppStateProps) {
  const loading = tone === 'loading'

  return (
    <section
      data-app-state={tone}
      data-compact={compact}
      className={cn(
        'flex items-center justify-center text-center',
        compact ? 'min-h-36 px-3 py-4' : 'min-h-[220px] p-4 md:min-h-[280px] md:p-5',
        className,
      )}
    >
      <div className={cn('mx-auto flex min-w-0 max-w-xl flex-col items-center', tone === 'error' && 'max-w-sm')}>
        {icon ?? (loading ? (
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
            <LoaderCircle aria-hidden="true" className="h-5 w-5 motion-safe:animate-spin" />
          </span>
        ) : (
          <ChevoinkMascot
            pose={scene ?? (tone === 'error' ? 'connection' : 'reading')}
            className={compact ? 'size-[72px]' : 'size-28 md:size-36'}
          />
        ))}
        {eyebrow ? (
          <p className="mt-4 text-xs font-medium text-[var(--text-tertiary)]">{eyebrow}</p>
        ) : null}
        <h2 className={cn('mt-3 max-w-full break-words text-base font-medium text-[var(--text-primary)]', !loading && !compact && 'text-lg font-semibold tracking-tight')}>{title}</h2>
        {description ? <p className={cn('mt-1.5 text-sm leading-6', loading ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]')}>{description}</p> : null}
        {details ? <div className="mt-4 w-full text-left text-sm leading-6 text-[var(--text-secondary)]">{details}</div> : null}
        {primaryAction || secondaryAction ? (
          <div className={cn('flex flex-wrap items-center justify-center gap-2', compact ? 'mt-3' : 'mt-5')}>
            {primaryAction ? <StateAction action={primaryAction} variant="primary" /> : null}
            {secondaryAction ? <StateAction action={secondaryAction} variant="secondary" /> : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
