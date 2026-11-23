import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'
import { runElapsedMs, timestamp } from '../../../../../shared/agent-timing.js'

// One timer wakes at the nearest visible elapsed-second boundary. History stays idle.
const liveClocks = new Map<() => void, () => number>()
let timer: ReturnType<typeof setTimeout> | undefined
const idleSnapshot = () => null
const idleSubscribe = () => () => {}
function scheduleClock() {
  clearTimeout(timer)
  if (!liveClocks.size || document.visibilityState === 'hidden') return
  let wait = Infinity
  for (const nextTick of liveClocks.values()) wait = Math.min(wait, nextTick())
  timer = setTimeout(() => {
    for (const notify of liveClocks.keys()) notify()
    scheduleClock()
  }, Math.max(1, wait))
}
function syncVisibleClocks() {
  if (document.visibilityState !== 'hidden') for (const notify of liveClocks.keys()) notify()
  scheduleClock()
}

export function ProcessDuration({ timing, active = false }: { timing: AgentRunTiming; active?: boolean }) {
  const lastLive = useRef<AgentRunTiming | null>(null)
  useLayoutEffect(() => {
    if (timing.status === 'running' && timing.elapsedMs !== null && timestamp(timing.activeSince) !== null) lastLive.current = timing
    else if (timing.status === 'paused' || timing.status === 'waiting' || timing.status === 'finished') lastLive.current = null
  }, [timing])
  const live = timing.status !== 'waiting' && (active || timing.status === 'running')
  const previous = lastLive.current
  const retained = live && timing.elapsedMs === null && previous && previous.sourceRunId === timing.sourceRunId
    && previous.scopeId === timing.scopeId && (timing.status === 'running' || timing.status === 'unknown')
    ? previous : null
  const since = timestamp(retained?.activeSince ?? timing.activeSince)
  const segmentOnly = !retained && timing.status === 'running' && timing.elapsedMs === null && since !== null
  const initial = retained?.elapsedMs ?? timing.elapsedMs ?? (segmentOnly ? 0 : null)
  const ticking = (timing.status === 'running' || !!retained) && since !== null && initial !== null
  const elapsedNow = useCallback(() => since === null || initial === null ? null : initial + Math.max(0, Date.now() - since), [initial, since])
  const snapshot = useCallback(() => {
    const elapsed = elapsedNow()
    return elapsed === null ? null : Math.floor(elapsed / 1000)
  }, [elapsedNow])
  const subscribe = useCallback((notify: () => void) => {
    if (!liveClocks.size) document.addEventListener('visibilitychange', syncVisibleClocks)
    liveClocks.set(notify, () => Math.max(0, (since ?? 0) - Date.now()) + 1000 - (elapsedNow() ?? 0) % 1000)
    scheduleClock()
    return () => {
      liveClocks.delete(notify)
      if (!liveClocks.size) document.removeEventListener('visibilitychange', syncVisibleClocks)
      scheduleClock()
    }
  }, [elapsedNow, since])
  const liveSeconds = useSyncExternalStore(ticking ? subscribe : idleSubscribe, ticking ? snapshot : idleSnapshot, idleSnapshot)
  const elapsed = ticking ? (liveSeconds ?? 0) * 1000 : runElapsedMs(timing, Date.now())
  if (elapsed === null && live) return <span role="status" className="agent-processing-shimmer text-sm leading-6 text-[var(--text-secondary)]" data-process-duration>正在准备中...</span>
  const seconds = elapsed === null ? null : Math.floor(Math.max(0, elapsed) / 1000)
  const units = seconds === null ? [] : [
    ...(seconds >= 3600 ? [{ value: Math.floor(seconds / 3600), label: '小时' }] : []),
    ...(seconds >= 60 ? [{ value: Math.floor(seconds / 60) % 60, label: '分钟' }] : []),
    { value: seconds % 60, label: '秒' },
  ]
  const durationLabel = units.map(unit => `${unit.value} ${unit.label}`).join(' ')
  return <span className="inline-flex shrink-0 items-baseline whitespace-nowrap text-sm leading-6 tabular-nums text-[var(--text-secondary)]" data-process-duration>
    <span>{timing.status === 'paused' ? '已暂停 · ' : timing.status === 'waiting' ? '等待回答 · ' : ''}{segmentOnly ? '本段已处理 ' : live ? '已处理 ' : '用时 '}</span>
    {seconds === null ? <span>未知</span> : <span aria-label={durationLabel} className="inline-flex items-baseline">{units.map((unit, index) => <span key={unit.label}>{index > 0 ? ' ' : null}<span className="inline-block min-w-[2ch] text-right tabular-nums">{unit.value}</span>{' '}{unit.label}</span>)}</span>}
  </span>
}
