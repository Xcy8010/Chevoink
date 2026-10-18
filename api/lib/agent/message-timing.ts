import type { Prisma } from '@prisma/client'
import type { AgentRunTiming } from '../../../shared/contracts/agent-events.js'
import { combineRunTimings, recoverRunTiming, recoverSingleExecutionTiming, timestamp } from '../../../shared/agent-timing.js'
import { prisma } from '../prisma.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'

const timingSelection = {
  id: true, taskRootId: true, runtimeProtocolVersion: true, status: true, startedAt: true, finishedAt: true,
  events: {
    where: { type: { in: ['run.started', 'run.paused', 'run.finished'] } },
    orderBy: { seq: 'asc' }, select: { type: true, seq: true, payload: true },
  },
} satisfies Prisma.AgentRunSelect

/** Read-only projection, scoped to the authorized history window and its roots. */
export async function loadMessageTimings(userId: string, sessionId: string, runIds: string[]): Promise<Map<string, AgentRunTiming>> {
  const result = new Map<string, AgentRunTiming>()
  if (!runIds.length) return result
  const ownership = { userId, sessionId, ...MAIN_RUN_FILTER }
  const initial = await prisma.agentRun.findMany({
    where: { ...ownership, id: { in: [...new Set(runIds)] } }, select: timingSelection,
  })
  const rootIds = [...new Set(initial.flatMap(run => run.runtimeProtocolVersion === 1 && run.taskRootId ? [run.taskRootId] : []))]
  // Resumes share the original message IDs, so include their actual execution
  // intervals even if a resumed run has not created any message of its own.
  const durableRuns = rootIds.length ? await prisma.agentRun.findMany({
    where: { ...ownership, taskRootId: { in: rootIds }, runtimeProtocolVersion: 1 },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: timingSelection,
  }) : []
  const pauses = rootIds.length ? await prisma.agentExecutionOutbox.findMany({
    where: { taskRootId: { in: rootIds }, type: 'run.paused' },
    orderBy: { sequence: 'asc' }, select: { payload: true, createdAt: true },
  }) : []
  const pauseByRun = new Map<string, string>()
  for (const pause of pauses) {
    const ids = pause.payload && typeof pause.payload === 'object' && 'runIds' in pause.payload ? pause.payload.runIds : null
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && !pauseByRun.has(id)) pauseByRun.set(id, pause.createdAt.toISOString())
  }
  const byRoot = new Map<string, typeof durableRuns>()
  for (const run of durableRuns) {
    const group = byRoot.get(run.taskRootId!) ?? []
    group.push(run)
    byRoot.set(run.taskRootId!, group)
  }
  for (const [rootId, runs] of byRoot) {
    const intervals = runs.map(run => ({
      ...recoverSingleExecutionTiming({ status: run.status, startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null }, pauseByRun.get(run.id) ?? null, run.events.at(-1)?.seq ?? 0),
      sourceRunId: run.id,
      completedAt: run.status === 'completed' ? run.finishedAt?.toISOString() ?? null : null,
    }))
    const timing = { ...combineRunTimings(intervals), scopeId: `root:${rootId}` }
    for (const run of runs) result.set(run.id, timing)
  }
  for (const run of initial) {
    if (run.runtimeProtocolVersion === 1 && run.taskRootId) continue
    const events = run.events.map(event => ({ type: event.type, seq: event.seq,
      ts: event.payload && typeof event.payload === 'object' && 'ts' in event.payload && typeof event.payload.ts === 'string' ? event.payload.ts : '' }))
    // No admission/start witness yet. Let its first actual start establish time.
    if (run.status === 'queued' && !events.length && timestamp(run.startedAt?.toISOString()) === null) continue
    result.set(run.id, { ...recoverRunTiming({ status: run.status, startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null }, events), scopeId: run.id, sourceRunId: run.id,
      completedAt: run.status === 'completed' ? run.finishedAt?.toISOString() ?? null : null })
  }
  return result
}
