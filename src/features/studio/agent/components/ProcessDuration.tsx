import { useSyncExternalStore } from 'react'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'
import { runElapsedMs, timestamp } from '../../../../../shared/agent-timing.js'

// All visible active summaries share one clock. History has no ticking subscription.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
const snapshot = () => Math.floor(Date.now() / 1000)
const idleSnapshot = () => 0
const idleSubscribe = () => () => {}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) timer = setInterval(() => { for (const notify of listeners) notify() }, 1000)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) clearInterval(timer)
  }
}

export function ProcessDuration({ timing, active = false }: { timing: AgentRunTiming; active?: boolean }) {
  const ticking = timing.status === 'running' && timestamp(timing.activeSince) !== null && timing.elapsedMs !== null
  useSyncExternalStore(ticking ? subscribe : idleSubscribe, ticking ? snapshot : idleSnapshot, idleSnapshot)
  const elapsed = runElapsedMs(timing, Date.now())
  const live = active || timing.status === 'running'
  if (elapsed === null && live) return <span role="status" className="agent-processing-shimmer text-sm leading-6 text-[var(--text-secondary)]" data-process-duration>正在准备中...</span>
  const seconds = elapsed === null ? null : Math.floor(Math.max(0, elapsed) / 1000)
  const units = seconds === null ? [] : [
    ...(seconds >= 3600 ? [{ value: Math.floor(seconds / 3600), label: '小时' }] : []),
    ...(seconds >= 60 ? [{ value: Math.floor(seconds / 60) % 60, label: '分钟' }] : []),
    { value: seconds % 60, label: '秒' },
  ]
  const durationLabel = units.map(unit => `${unit.value} ${unit.label}`).join(' ')
  return <span className="inline-flex shrink-0 items-baseline whitespace-nowrap text-sm leading-6 tabular-nums text-[var(--text-secondary)]" data-process-duration>
    <span>{timing.status === 'paused' ? '已暂停 · ' : ''}{live ? '已处理 ' : '用时 '}</span>
    {seconds === null ? <span>未知</span> : <span aria-label={durationLabel} className="inline-flex items-baseline">{units.map((unit, index) => <span key={unit.label}>{index > 0 ? ' ' : null}<span className="inline-block min-w-[2ch] text-right tabular-nums">{unit.value}</span>{' '}{unit.label}</span>)}</span>}
  </span>
}
