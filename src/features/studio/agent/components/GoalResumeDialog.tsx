import { Gauge, LoaderCircle, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { AgentGoalSnapshot } from '../../../../../shared/contracts/agent-goal.js'
import { useDialogFocusTrap } from '../../components/use-dialog-focus-trap'

export type GoalResumeLimits = { tokenLimit?: number; activeTimeLimitMs?: number }

type GoalResumeDialogProps = {
  open: boolean
  goal?: AgentGoalSnapshot | null
  busy: boolean
  error?: string
  onClose: () => void
  onResume: (limits?: GoalResumeLimits) => void
}

function parsePositiveInteger(value: string): number | null | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function GoalResumeDialog({ open, goal, busy, error, onClose, onResume }: GoalResumeDialogProps) {
  const [tokenLimit, setTokenLimit] = useState('')
  const [activeTimeLimitMs, setActiveTimeLimitMs] = useState('')
  const [validationError, setValidationError] = useState('')
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    setTokenLimit('')
    setActiveTimeLimitMs('')
    setValidationError('')
  }, [goal?.id, open])

  useDialogFocusTrap({ panel, open: open && Boolean(goal), onClose: () => { if (!busy) onClose() } })

  if (!open || !goal) return null

  const resume = () => {
    const nextToken = parsePositiveInteger(tokenLimit)
    const nextTime = parsePositiveInteger(activeTimeLimitMs)
    if (nextToken === null) { setValidationError('请输入有效的 Token 上限。'); return }
    if (nextTime === null) { setValidationError('请输入有效的活动时间上限。'); return }
    const currentToken = Number(goal.tokenLimit)
    const currentTime = Number(goal.activeTimeLimitMs)
    if (nextToken !== undefined && Number.isFinite(currentToken) && nextToken <= currentToken) {
      setValidationError('Token 上限需高于当前值。')
      return
    }
    if (nextTime !== undefined && Number.isFinite(currentTime) && nextTime <= currentTime) {
      setValidationError('活动时间上限需高于当前值。')
      return
    }
    if (['budget_limited'].includes(goal.status) && nextToken === undefined && nextTime === undefined) {
      setValidationError('请先提高至少一项上限。')
      return
    }
    const limits: GoalResumeLimits = {}
    if (nextToken !== undefined) limits.tokenLimit = nextToken
    if (nextTime !== undefined) limits.activeTimeLimitMs = nextTime
    onResume(Object.keys(limits).length > 0 ? limits : undefined)
  }

  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[160] flex min-h-0 items-center justify-center overflow-hidden bg-[rgba(15,23,42,0.32)] px-3 py-3 backdrop-blur-[2px] sm:px-4 sm:py-6" role="presentation" onClick={onClose}>
      <section ref={panel} role="dialog" aria-modal="true" aria-label="继续目标" tabIndex={-1} className="flex max-h-[calc(100dvh-24px)] min-h-0 w-full max-w-md flex-col overflow-hidden rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_28px_80px_rgba(15,23,42,0.28)] sm:max-h-[calc(100dvh-48px)]" onClick={event => event.stopPropagation()}>
        <header className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Gauge aria-hidden="true" className="h-4 w-4" /></span>
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">继续目标</h2>
          <button type="button" disabled={busy} onClick={onClose} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-40" aria-label="关闭继续目标"><X aria-hidden="true" className="h-4 w-4" /></button>
        </header>

        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [-webkit-overflow-scrolling:touch] sm:px-5">
          <p className="truncate text-xs text-[var(--text-secondary)]" title={goal.objective}>{goal.objective}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-[var(--text-secondary)]">
            <div className="rounded-[9px] bg-[var(--surface-muted)] px-2.5 py-2"><dt className="text-[var(--text-tertiary)]">当前 Token 上限</dt><dd className="mt-0.5 tabular-nums text-[var(--text-primary)]">{goal.tokenLimit}</dd></div>
            <div className="rounded-[9px] bg-[var(--surface-muted)] px-2.5 py-2"><dt className="text-[var(--text-tertiary)]">当前活动时间上限</dt><dd className="mt-0.5 tabular-nums text-[var(--text-primary)]">{goal.activeTimeLimitMs} ms</dd></div>
          </dl>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-[var(--text-secondary)]">提高 Token 上限<input type="number" min="1" step="1" inputMode="numeric" aria-label="提高 Token 上限" value={tokenLimit} disabled={busy} onChange={event => { setTokenLimit(event.target.value); setValidationError('') }} placeholder="可选" className="mt-1 h-11 w-full rounded-[9px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-secondary)] disabled:opacity-60" /></label>
            <label className="text-[11px] text-[var(--text-secondary)]">提高活动时间上限<input type="number" min="1" step="1" inputMode="numeric" aria-label="提高活动时间上限" value={activeTimeLimitMs} disabled={busy} onChange={event => { setActiveTimeLimitMs(event.target.value); setValidationError('') }} placeholder="可选（毫秒）" className="mt-1 h-11 w-full rounded-[9px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-secondary)] disabled:opacity-60" /></label>
          </div>
          {validationError || error ? <p role="alert" className="mt-3 rounded-[9px] bg-rose-500/8 px-3 py-2 text-xs leading-5 text-rose-600">{validationError || error}</p> : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:px-5">
          <button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-[9px] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 disabled:opacity-40">取消</button>
          <button type="button" disabled={busy} onClick={resume} className="inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-[var(--surface-contrast)] px-3.5 text-xs font-medium text-[var(--text-contrast)] transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 disabled:cursor-wait disabled:opacity-40" aria-label="继续目标">{busy ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}{busy ? '继续中…' : '继续目标'}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export type { GoalResumeDialogProps }
