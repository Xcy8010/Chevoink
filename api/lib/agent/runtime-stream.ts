import { publicAgentProgressEvent } from '../../../shared/agent-progress.js'
import { publicReviewExecution } from '../../../shared/review-lifecycle.js'
import { setTimeout as delay } from 'node:timers/promises'
import type { Response } from 'express'
import { publishDurableEvents, loadDurableEvents, isDurablePauseResumed } from './runtime-event-projection.js'
import { loadMessageTimings } from './message-timing.js'
import { prisma } from '../prisma.js'
import type { AgentRunTiming } from '../../../shared/contracts/index.js'

const publishing = new Map<string, ReturnType<typeof publishDurableEvents>>()
function publishForReaders(userId: string, runId: string) {
  const key = JSON.stringify([userId, runId])
  const pending = publishing.get(key)
  if (pending) return pending
  const work = publishDurableEvents(userId, runId).finally(() => publishing.delete(key))
  publishing.set(key, work)
  return work
}

/** DB-backed live/replay; no process-local bus or synthetic failure fallback. */
export async function streamDurableRun(userId: string, runId: string, sinceSeq: number, res: Response, sessionId?: string): Promise<void> {
  // Validate ownership/protocol/cursor before sending response headers.
  await publishForReaders(userId, runId)
  let page = await loadDurableEvents(userId, runId, sinceSeq)
  const session = sessionId ?? (await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { sessionId: true } }))?.sessionId
  const readTiming = async (): Promise<AgentRunTiming | null> => {
    const timings = session ? await loadMessageTimings(userId, session, [runId]).catch(() => null) : null
    const timing = timings?.get(runId)
    return timing?.sourceRunId === runId ? timing : null
  }
  const controller = new AbortController()
  const closed = () => controller.abort()
  res.once('close', closed)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  const write = async (data: string) => {
    if (controller.signal.aborted || res.writableEnded || res.destroyed) return false
    if (!res.write(data)) {
      // One bounded batch in memory; never continue polling while client is blocked.
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => controller.abort(), 30000)
        timeout.unref?.()
        const finish = () => { clearTimeout(timeout); res.off('drain', finish); controller.signal.removeEventListener('abort', finish); resolve() }
        res.once('drain', finish)
        controller.signal.addEventListener('abort', finish, { once: true })
        if (controller.signal.aborted || res.writableEnded || res.destroyed) finish()
      })
    }
    ;(res as Response & { flush?: () => void }).flush?.()
    return !controller.signal.aborted
  }
  let cursor = sinceSeq, lastPing = Date.now()
  let clockObserved = false
  try {
    while (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      if (page.length === 0 && cursor > 0) {
        const previous = (await loadDurableEvents(userId, runId, cursor - 1, 1))[0]
        if (previous?.seq === cursor && (previous.type === 'run.paused' && !await isDurablePauseResumed(userId, runId, previous.seq) || previous.type === 'run.finished'
          || (previous.type === 'error' && !previous.recoverable))) return
      }
      let timing: AgentRunTiming | null | undefined
      let sentTiming = false
      for (const event of page) {
        if (event.type === 'run.paused' && await isDurablePauseResumed(userId, runId, event.seq)) { cursor = event.seq; continue }
        const boundary = event.type === 'run.started' || event.type === 'run.question_wait' || event.type === 'run.paused'
          || event.type === 'run.finished' || event.type === 'error' && !event.recoverable
        // The durable model scheduling frame is projected before supplier output.
        const activation = !clockObserved && !sentTiming && event.type === 'execution.progress'
        if ((boundary || activation) && timing === undefined) timing = await readTiming()
        if (timing && (timing.activeSince || timing.status === 'finished' || timing.status === 'waiting')) clockObserved = true
        const visible = publicAgentProgressEvent(publicReviewExecution(boundary || activation ? { ...event, durableTiming: timing ?? null } : event))
        if (boundary || activation) sentTiming = true
        if (!await write(`id: ${visible.seq}\nevent: ${visible.type}\ndata: ${JSON.stringify(visible)}\n\n`)) return
        cursor = event.seq
        if (event.type === 'run.paused' || event.type === 'run.finished' || (event.type === 'error' && !event.recoverable)) return
      }
      if (Date.now() - lastPing >= 20000) { if (!await write(': ping\n\n')) return; lastPing = Date.now() }
      if (page.length < 200) await delay(1000, undefined, { signal: controller.signal })
      if (controller.signal.aborted) return
      await publishForReaders(userId, runId)
      page = await loadDurableEvents(userId, runId, cursor)
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      // Closing permits client reconnect to the same saved cursor; no fake terminal event.
      res.destroy(error instanceof Error ? error : undefined)
    }
  } finally {
    controller.abort()
    res.off('close', closed)
    if (!res.writableEnded && !res.destroyed) res.end()
  }
}
