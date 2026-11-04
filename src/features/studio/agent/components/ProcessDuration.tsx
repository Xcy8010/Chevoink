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
  const seconds = elapsed === null ? live ? 0 : null : Math.floor(Math.max(0, elapsed) / 1000)
  return <span className="inline-flex shrink-0 items-baseline whitespace-nowrap text-[11px] tabular-nums text-[var(--text-secondary)]" data-process-duration>
    <span>{timing.status === 'paused' ? '已暂停 · ' : ''}{live ? '已处理 ' : '用时 '}</span>
    {seconds === null ? <span>未知</span> : <span aria-label={`${seconds} 秒`}><span className="inline-block w-[6ch] text-right tabular-nums">{seconds}</span>{' '}秒</span>}
  </span>
}
