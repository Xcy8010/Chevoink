import type { AgentRunTiming } from './contracts/agent-events.js'

export type TimingEvent = { type: string; seq: number; ts: string; runId?: string; recoverable?: boolean }
export const timestamp = (value: string | null | undefined): number | null => {
  if (!value) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}
export const unknownRunTiming = (): AgentRunTiming => ({ elapsedMs: null, activeSince: null, status: 'unknown', lastSeq: 0 })

/** Presentation only. Never count the paused gap or restart a settled interval. */
export function advanceRunTiming(previous: AgentRunTiming | undefined, event: TimingEvent): AgentRunTiming {
  const current = previous ?? { ...unknownRunTiming(), scopeId: event.runId, sourceRunId: event.runId }
  if (event.seq <= current.lastSeq) return current
  const at = timestamp(event.ts)
  if (at === null) return { ...current, elapsedMs: null, activeSince: null, status: 'unknown', lastSeq: event.seq }
  if (event.type === 'run.started') {
    // Another actual admission without its preceding stop is incomplete
    // evidence. Replayed starts are already rejected by the sequence cursor.
    if (current.activeSince) return { ...current, elapsedMs: null, activeSince: event.ts, status: 'running', lastSeq: event.seq }
    return { ...current, elapsedMs: previous ? current.elapsedMs : 0, activeSince: event.ts, status: 'running', lastSeq: event.seq }
  }
  const status = event.type === 'run.paused' ? 'paused' : 'finished'
  const since = timestamp(current.activeSince)
  const elapsedMs = current.elapsedMs === null || since !== null && at < since ? null
    : current.elapsedMs + (since === null ? 0 : at - since)
  return { ...current, elapsedMs, activeSince: null, status, lastSeq: event.seq }
}

/** A status read has a real stop time, but must not invent an SSE sequence. */
export function settleRunTiming(timing: AgentRunTiming | undefined, stoppedAt: string | null | undefined, paused = false): AgentRunTiming {
  const current = timing ?? unknownRunTiming()
  if (!current.activeSince && ['paused', 'finished'].includes(current.status)) return { ...current, status: paused ? 'paused' : 'finished' }
  if (timestamp(stoppedAt) === null) return { ...current, elapsedMs: null, activeSince: null, status: paused ? 'paused' : 'finished' }
  return { ...advanceRunTiming(current, { type: paused ? 'run.paused' : 'run.finished', seq: current.lastSeq + 1, ts: stoppedAt! }), lastSeq: current.lastSeq }
}

/** Persisted transition timestamps are the source; missing stops are never Date.now(). */
export function recoverRunTiming(run: { status: string; startedAt: string | null; finishedAt: string | null }, events: TimingEvent[]): AgentRunTiming {
  let timing: AgentRunTiming | undefined
  let lastAt = -Infinity
  for (const event of events) {
    const at = timestamp(event.ts)
    if (at === null || at < lastAt || timing && event.seq <= timing.lastSeq) return unknownRunTiming()
    lastAt = at
    if (!timing && event.type === 'run.started') {
      const started = timestamp(run.startedAt)
      timing = { elapsedMs: 0, activeSince: started !== null && started <= at ? run.startedAt : event.ts, status: 'running', lastSeq: event.seq }
    } else timing = advanceRunTiming(timing, event)
  }
  timing ??= unknownRunTiming()
  if (['queued', 'running', 'awaiting_approval'].includes(run.status)) return timing
  const status = run.status === 'paused' ? 'paused' : 'finished'
  if (timing.activeSince) {
    if (timestamp(run.finishedAt) === null) return { ...timing, elapsedMs: null, activeSince: null, status }
    timing = settleRunTiming(timing, run.finishedAt, status === 'paused')
  }
  return { ...timing, status }
}

/** Durable resume creates a new run; old root events are replay, not its start. */
export function recoverSingleExecutionTiming(run: { status: string; startedAt: string | null; finishedAt: string | null }, pausedAt: string | null, lastSeq: number): AgentRunTiming {
  if (timestamp(run.startedAt) === null) return { ...unknownRunTiming(), lastSeq }
  const timing: AgentRunTiming = { elapsedMs: 0, activeSince: run.startedAt, status: 'running', lastSeq }
  return ['queued', 'running', 'awaiting_approval'].includes(run.status) ? timing
    : settleRunTiming(timing, run.status === 'paused' ? pausedAt : run.finishedAt, run.status === 'paused')
}

/** Each distinct execution scope contributes once, even on many message rows. */
export function combineRunTimings(timings: AgentRunTiming[]): AgentRunTiming {
  const latest = timings.at(-1) ?? unknownRunTiming()
  const active = timings.filter(timing => timing.status === 'running' && timing.activeSince)
  const known = timings.length > 0 && active.length <= 1 && timings.every(timing => timing.elapsedMs !== null && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0)
  return { ...latest, elapsedMs: known ? timings.reduce((sum, timing) => sum + timing.elapsedMs!, 0) : null,
    activeSince: known ? active[0]?.activeSince ?? null : null,
    status: active.length ? 'running' : latest.status }
}

export function runElapsedMs(timing: AgentRunTiming, now: number): number | null {
  const since = timestamp(timing.activeSince)
  if (timing.elapsedMs === null || timing.elapsedMs < 0 || !Number.isFinite(timing.elapsedMs) || !Number.isFinite(now)
    || timing.status === 'running' && since === null || since !== null && now < since) return null
  return timing.elapsedMs + (timing.status === 'running' && since !== null ? now - since : 0)
}

export function formatRunDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟${seconds % 60}秒`
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分钟${seconds % 60}秒`
}
