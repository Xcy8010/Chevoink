import { CheckCircle2, Expand, LoaderCircle, Pause, Play, Target, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { agentGoalPresentation } from '../../../../../shared/contracts/agent-goal.js'
import type { AgentGoalSnapshot } from '../../../../../shared/contracts/agent-goal.js'

type AgentGoalBarProps = {
  goal: AgentGoalSnapshot
  busy: boolean
  onEdit: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onExpand: () => void
  onDismiss: () => void
}

function decimalMilliseconds(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}小时${String(minutes).padStart(2, '0')}分` : `${minutes}分${String(seconds).padStart(2, '0')}秒`
}

type DurationAnchor = { key: string; performanceNow: number }

function durationAt(goal: AgentGoalSnapshot, anchorRef: { current: DurationAnchor | null }): number {
  const base = decimalMilliseconds(goal.activeTimeMs)
  if (!goal.activeSince) return base
  const activeSince = Date.parse(goal.activeSince)
  const serverTime = Date.parse(goal.serverTime)
  if (!Number.isFinite(activeSince) || !Number.isFinite(serverTime)) return base
  const now = typeof performance !== 'undefined' && Number.isFinite(performance.now()) ? performance.now() : Date.now()
  const key = `${goal.id}:${goal.activeSince}:${goal.serverTime}:${goal.activeTimeMs}`
  if (!anchorRef.current || anchorRef.current.key !== key) anchorRef.current = { key, performanceNow: now }
  return base + Math.max(0, serverTime - activeSince) + Math.max(0, now - anchorRef.current.performanceNow)
}

function actionClass(disabled = false) {
  return `inline-flex h-8 w-8 mobile:h-11 mobile:w-9 shrink-0 items-center justify-center text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 ${disabled ? 'cursor-wait opacity-40' : ''}`
}

export function AgentGoalBar({ goal, busy, onEdit, onPause, onResume, onCancel, onExpand, onDismiss }: AgentGoalBarProps) {
  const presentation = agentGoalPresentation(goal)
  const [tick, setTick] = useState(0)
  const durationAnchorRef = useRef<DurationAnchor | null>(null)
  useEffect(() => {
    if (!goal.activeSince) return
    const timer = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [goal.activeSince])

  // Reading tick keeps the active duration anchored to the server snapshot while it is running.
  void tick
  if (!presentation.visible) return null
  const terminal = goal.status === 'completed'
  const canEdit = !terminal

  return (
    <section aria-label="目标条" className="relative mx-3 -mb-3 flex min-w-0 items-center gap-1.5 rounded-t-[14px] border border-b-0 border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2.5 pb-3 text-xs text-[var(--text-primary)] sm:mx-4">
      {presentation.running ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-secondary)] motion-reduce:animate-none" /> : <Target aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-medium mobile:max-w-24 mobile:truncate">{presentation.label}</span>
        <button type="button" disabled={busy || !canEdit} onClick={onEdit} aria-label="修改目标" className="min-w-0 flex-1 truncate text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2" title={goal.objective}>{goal.objective}</button>
        <span className="hidden shrink-0 items-center gap-1 tabular-nums text-[var(--text-tertiary)] sm:inline-flex">
          {formatDuration(durationAt(goal, durationAnchorRef))}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="目标操作">
        {presentation.canPause ? <button type="button" disabled={busy} onClick={onPause} className={actionClass(busy)} aria-label="暂停目标" title="暂停目标"><Pause aria-hidden="true" className="h-4 w-4" /></button> : null}
        {presentation.canResume ? <button type="button" disabled={busy} onClick={onResume} className={actionClass(busy)} aria-label="继续目标" title="继续目标"><Play aria-hidden="true" className="h-4 w-4" /></button> : null}
        {!terminal && goal.status !== 'cancelled' ? <button type="button" disabled={busy} onClick={onCancel} className={actionClass(busy)} aria-label="取消目标" title="取消目标"><X aria-hidden="true" className="h-4 w-4" /></button> : null}
        {terminal ? <CheckCircle2 aria-hidden="true" className="mx-1 h-4 w-4 text-emerald-600" /> : null}
        <button type="button" disabled={busy} onClick={onExpand} className={actionClass(busy)} aria-label="展开目标详情" title="展开目标详情"><Expand aria-hidden="true" className="h-4 w-4" /></button>
        {terminal ? <button type="button" disabled={busy} onClick={onDismiss} className={actionClass(busy)} aria-label="收起已完成目标" title="收起已完成目标"><X aria-hidden="true" className="h-4 w-4" /></button> : null}
      </div>
    </section>
  )
}

export type { AgentGoalBarProps }
