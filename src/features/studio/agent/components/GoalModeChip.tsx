import { LoaderCircle, Target, X } from 'lucide-react'

type GoalModeChipProps = {
  active: boolean
  draft: boolean
  busy: boolean
  onOpen: () => void
  onCancel: () => void
}

export function GoalModeChip({ active, draft, busy, onOpen, onCancel }: GoalModeChipProps) {
  if (!draft) return null

  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-[11px] text-[var(--text-secondary)]">
      <span aria-hidden="true" className="h-3.5 w-px bg-[var(--border-subtle)]" />
      <button
        type="button"
        disabled={busy}
        aria-label="取消目标模式"
        title="取消目标模式"
        onClick={onCancel}
        className="group/goal-cancel relative inline-flex h-7 w-5 items-center justify-center transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <>
          <Target aria-hidden="true" className="h-3.5 w-3.5 group-hover/goal-cancel:opacity-0 group-focus-visible/goal-cancel:opacity-0" />
          <X aria-hidden="true" className="absolute h-3.5 w-3.5 opacity-0 group-hover/goal-cancel:opacity-100 group-focus-visible/goal-cancel:opacity-100" />
        </>}
      </button>
      <button type="button" disabled={busy} aria-pressed={draft}
        aria-label={active ? '打开目标详情' : '退出目标模式'}
        onClick={active ? onOpen : onCancel}
        className="-ml-1.5 inline-flex h-7 items-center transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60">目标</button>
    </span>
  )
}

export type { GoalModeChipProps }
