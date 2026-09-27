import { LoaderCircle, Target, X } from 'lucide-react'

type GoalModeChipProps = {
  active: boolean
  draft: boolean
  busy: boolean
  onOpen: () => void
  onCancel: () => void
}

export function GoalModeChip({ active, draft, busy, onOpen, onCancel }: GoalModeChipProps) {
  if (!active && !draft) return null

  return (
    <span className="group inline-flex min-h-11 items-center gap-0.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-muted)] pl-2 text-xs text-[var(--text-primary)]">
      <button
        type="button"
        disabled={busy}
        aria-pressed={active}
        aria-label={active ? '打开目标详情' : '目标模式'}
        title={active ? '打开目标详情' : '目标模式'}
        onClick={onOpen}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-l-full px-1.5 transition-colors hover:bg-[var(--surface-default)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Target aria-hidden="true" className="h-3.5 w-3.5" />}
        <span>目标</span>
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={active ? '取消目标' : '取消目标模式'}
        title={active ? '取消目标' : '取消目标模式'}
        onClick={(event) => { event.stopPropagation(); onCancel() }}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] opacity-0 transition-[opacity,background-color,color] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 group-hover:opacity-100 group-focus-within:opacity-100 mobile:opacity-100 disabled:cursor-wait disabled:opacity-40"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

export type { GoalModeChipProps }
