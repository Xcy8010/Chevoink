import { LoaderCircle, Target } from 'lucide-react'

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
    <span className="inline-flex shrink-0 items-center gap-2 text-[11px] text-[var(--text-secondary)]">
      <span aria-hidden="true" className="h-3.5 w-px bg-[var(--border-subtle)]" />
      <button
        type="button"
        disabled={busy}
        aria-pressed={active || draft}
        aria-label={active ? '打开目标详情' : '取消目标模式'}
        title={active ? '打开目标详情' : '取消目标模式'}
        onClick={active ? onOpen : onCancel}
        className="inline-flex h-7 items-center gap-1.5 px-1 transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Target aria-hidden="true" className="h-3.5 w-3.5" />}
        <span>目标</span>
      </button>
    </span>
  )
}

export type { GoalModeChipProps }
