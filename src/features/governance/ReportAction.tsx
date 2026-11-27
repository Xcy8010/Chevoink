import { Flag, MoreHorizontal } from 'lucide-react'
import { useShellStore } from '@/store/useShellStore'
import type { ReportTarget } from '../../../shared/contracts/governance-cases'
export type ReportContext = {
  kind: ReportTarget
  id: string
  messagesFor?: string
  messages?: { id: string; label: string }[]
}
export const REPORT_EVENT = 'chevoink:report'
export default function ReportAction({
  target,
  onOpen,
  ownerId,
  menu = false,
}: {
  target: ReportContext
  ownerId?: string | null
  onOpen?: () => void
  menu?: boolean
}) {
  const viewer = useShellStore((state) => state.sessionUser?.id)
  const checking = useShellStore((state) => state.authStatus === 'checking')
  if (
    checking ||
    (target.kind === 'message'
      ? !viewer || viewer !== target.messagesFor || !target.messages?.length
      : !ownerId || ownerId === viewer)
  )
    return null
  const button = (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.closest('details')?.removeAttribute('open')
        window.dispatchEvent(new CustomEvent(REPORT_EVENT, { detail: target }))
        onOpen?.()
      }}
      className="flex w-full items-center gap-2 whitespace-nowrap px-4 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
    >
      <Flag size={15} />
      举报与投诉
    </button>
  )
  return menu ? (
    <details className="relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <summary
        aria-label="更多操作"
        className="inline-flex min-h-8 min-w-8 cursor-pointer list-none items-center justify-center rounded-full hover:bg-[var(--surface-muted)]"
      >
        <MoreHorizontal size={17} />
      </summary>
      <div className="absolute right-0 top-full z-30 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] py-1 shadow-lg">
        {button}
      </div>
    </details>
  ) : (
    button
  )
}
