import { useSyncExternalStore } from 'react'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'
import { formatRunDuration, runElapsedMs, timestamp } from '../../../../../shared/agent-timing.js'

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

export function ProcessDuration({ timing }: { timing: AgentRunTiming }) {
  const ticking = timing.status === 'running' && timestamp(timing.activeSince) !== null && timing.elapsedMs !== null
  useSyncExternalStore(ticking ? subscribe : idleSubscribe, ticking ? snapshot : idleSnapshot, idleSnapshot)
  const elapsed = runElapsedMs(timing, Date.now())
  return <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]">
    {timing.status === 'paused' ? '已暂停 · ' : ''}{timing.status === 'running' ? '已处理 ' : '用时 '}{elapsed === null ? '未知' : formatRunDuration(elapsed)}
  </span>
}
