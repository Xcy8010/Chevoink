import type { PendingReviewCall } from './checkpoint.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { qualityReportCheckedCurrentContent, REPAIR_BLOCK_CODES } from './quality-report-contract.js'
import { activeChapterScope } from '../data/internal.js'
import type { AgentRun, Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readGoalConsentSourceRun } from './goal-consent.js'
import { runtimeJson } from './runtime-common.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export type QualityReviewAdmission = { id: string; at: Date }

/** Reuse actual author admissions. A new run, copied request, ordinary worker
 * restart or new compilation never grants another paid recovery by itself. */
export async function readQualityReviewAdmission(tx: Prisma.TransactionClient, run: AgentRun): Promise<QualityReviewAdmission | null> {
  if (run.taskRootId) {
    let source: AgentRun
    try { source = await readGoalConsentSourceRun(tx, run) } catch (error) {
      if (error instanceof DataAccessError) return null
      throw error
    }
    if (source.id !== run.id) {
      // readGoalConsentSourceRun verifies the owned root, pause receipt and frame.
      const resumed = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: run.taskRootId,
        runId: run.id, type: 'run.resume.queued' } })
      return resumed ? { id: resumed.eventKey, at: resumed.createdAt } : null
    }
  } else {
    const starts = await tx.agentRunEvent.findMany({ where: { runId: run.id, type: 'run.started' }, orderBy: { seq: 'desc' } })
    for (const start of starts) {
      const proof = object(object(start.payload).authorContinue)
      if (typeof proof.eventId !== 'string' || !Number.isSafeInteger(proof.afterSeq) || start.seq !== Number(proof.afterSeq) + 1) continue
      const terminal = await tx.agentRunEvent.findFirst({ where: { id: proof.eventId, runId: run.id,
        type: { in: ['run.paused', 'run.finished'] }, seq: { lte: Number(proof.afterSeq) } } })
      if (!terminal || await tx.agentRunEvent.count({ where: { runId: run.id, type: { in: ['run.paused', 'run.finished'] },
        seq: { gt: terminal.seq, lt: start.seq } } })) continue
      const first = [...starts].reverse().find(candidate => {
        const marker = object(object(candidate.payload).authorContinue)
        return marker.eventId === terminal.id && Number.isSafeInteger(marker.afterSeq)
          && Number(marker.afterSeq) >= terminal.seq && candidate.seq === Number(marker.afterSeq) + 1
      })!
      return { id: `author-continue:${terminal.id}`, at: first.createdAt }
    }
  }
  const admission = readHumanAdmission(run.startRequest)
  if (!admission || admission.request.sessionId !== run.sessionId || admission.request.novelId !== run.novelId) return null
  const message = await tx.agentMessage.findFirst({ where: { runId: run.id, sessionId: run.sessionId, role: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const parts = [{ type: 'text', text: admission.request.prompt }, ...(admission.request.attachments ?? []).map(part => ({
    type: 'attachment', kind: part.kind, name: part.name, url: part.url, size: part.size,
  }))]
  return message && runtimeJson(message.parts).hash === runtimeJson(JSON.parse(JSON.stringify(parts))).hash
    ? { id: `author-message:${message.id}`, at: message.createdAt } : null
}


/** Old loops left a received report pending when its subsequent local edit
 * failed. Reconcile only that exact call/result and settled payments; never
 * reopen a request or infer a returned response from a report alone. */
export async function readSettledQualityReviews(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, pending: readonly PendingReviewCall[]) {
  const quality = pending.filter(item => item.toolName === 'quality_analyze')
  if (!quality.length) return []
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  const settled: PendingReviewCall[] = []
  for (const item of quality) {
    const events = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result'] },
      payload: { path: ['callId'], equals: item.callId } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
    const calls = events.filter(event => event.type === 'tool.call'), results = events.filter(event => event.type === 'tool.result')
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], payload = object(result.payload), args = object(object(call.payload).args)
    if (call.runId !== result.runId || result.seq <= call.seq || object(call.payload).toolName !== 'quality_analyze'
      || payload.toolName !== 'quality_analyze' || payload.ok !== false || !REPAIR_BLOCK_CODES.has(String(payload.failureCode))
      || !(args.chapterId === item.chapterId || item.compilationId && args.compilationId === item.compilationId)
      || args.chapterId !== undefined && args.chapterId !== item.chapterId
      || args.compilationId !== undefined && args.compilationId !== item.compilationId) continue
    const chapter = await tx.chapter.findFirst({ where: { id: item.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) },
      select: { revision: true, content: true } })
    if (!chapter || chapter.revision !== item.revision) continue
    const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      runId: call.runId, chapterId: item.chapterId, compilationId: item.compilationId, chapterRevision: item.revision,
      createdAt: { gte: call.createdAt, lte: result.createdAt } } })
    if (reports.length !== 1 || !qualityReportCheckedCurrentContent(reports[0], chapter.revision, chapter.content)) continue
    const report = reports[0]
    if (object(object(report.deterministicMetrics).criticResponse).callId !== item.callId) continue
    const history = await tx.agentRunEvent.findMany({ where: { runId: call.runId, type: { in: ['tool.call', 'tool.result'] },
      seq: { lt: result.seq } }, orderBy: { seq: 'asc' }, take: 2001 })
    if (history.length >= 2001 || history.some(event => event.type === 'tool.call' && event.id !== call.id
      && ['quality_analyze', 'chapter_write', 'chapter_edit_range', 'chapter_append'].includes(String(object(event.payload).toolName))
      && (event.seq > call.seq || !history.some(end => end.type === 'tool.result'
        && object(end.payload).callId === object(event.payload).callId && end.seq > event.seq && end.seq < call.seq)))) continue
    const payments = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      action: { startsWith: 'agent3Humanity' }, targetId: { in: [item.chapterId, report.id] }, createdAt: { gte: call.createdAt, lte: result.createdAt } } })
    if (!payments.length || payments.some(payment => payment.usageSource !== 'reported' || payment.billingStatus !== 'settled'
      || payment.requestTokens === null || payment.responseTokens === null || payment.responseTokens <= 0)) continue
    settled.push(item)
  }
  return settled
}
