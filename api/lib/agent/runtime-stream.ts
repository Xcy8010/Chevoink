import { publicReviewExecution } from '../../../shared/review-lifecycle.js'
import { setTimeout as delay } from 'node:timers/promises'
import type { Response } from 'express'
import { publishDurableEvents, loadDurableEvents, isDurablePauseResumed } from './runtime-event-projection.js'

/** DB-backed live/replay; no process-local bus or synthetic failure fallback. */
export async function streamDurableRun(userId: string, runId: string, sinceSeq: number, res: Response): Promise<void> {
  // Validate ownership/protocol/cursor before sending response headers.
  await publishDurableEvents(userId, runId)
  let page = await loadDurableEvents(userId, runId, sinceSeq)
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
  try {
    while (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      if (page.length === 0 && cursor > 0) {
        const previous = (await loadDurableEvents(userId, runId, cursor - 1, 1))[0]
        if (previous?.seq === cursor && (previous.type === 'run.paused' && !await isDurablePauseResumed(userId, runId, previous.seq) || previous.type === 'run.finished'
          || (previous.type === 'error' && !previous.recoverable))) return
      }
      for (const event of page) {
        if (event.type === 'run.paused' && await isDurablePauseResumed(userId, runId, event.seq)) { cursor = event.seq; continue }
        const visible = publicReviewExecution(event)
        if (!await write(`id: ${visible.seq}\nevent: ${visible.type}\ndata: ${JSON.stringify(visible)}\n\n`)) return
        cursor = event.seq
        if (event.type === 'run.paused' || event.type === 'run.finished' || (event.type === 'error' && !event.recoverable)) return
      }
      if (Date.now() - lastPing >= 20000) { if (!await write(': ping\n\n')) return; lastPing = Date.now() }
      if (page.length < 200) await delay(1000, undefined, { signal: controller.signal })
      if (controller.signal.aborted) return
      await publishDurableEvents(userId, runId)
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
