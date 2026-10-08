import { createHash } from 'node:crypto'
import type { AgentReviewFailureReconciliation } from '../../../shared/contracts/index.js'
import type { PendingReviewCall } from './checkpoint.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { qualityReportCheckedCurrentContent, REPAIR_BLOCK_CODES } from './quality-report-contract.js'
import { activeChapterScope } from '../data/internal.js'
import type { AgentRun, AgentRunEvent, Prisma } from '@prisma/client'
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


const hashText = (value: string) => createHash('sha256').update(value).digest('hex')
function reviewTargetInScope(spec: unknown, novelId: string, chapter: { id: string; orderIndex: number }) {
  const scope = object(object(spec).scope), writing = object(scope.writing)
  return scope.novelId === novelId && (writing.kind === 'bounded'
    ? Array.isArray(writing.targets) && writing.targets.some(value => {
      const target = object(value)
      return target.orderIndex === chapter.orderIndex && (target.chapterId == null || target.chapterId === chapter.id)
    }) : writing.kind === 'unbounded' || Array.isArray(scope.chapterIds) && scope.chapterIds.includes(chapter.id))
}

/** A terminal failed request with known charges is not a successful response or
 * report. Only a new human admission and new manuscript permit a new check. */
async function readFailedInlineQualityRequest(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, ids: string[], taskId: string,
  item: PendingReviewCall, call: AgentRunEvent, result: AgentRunEvent,
  chapter: { id: string; revision: number; content: string }): Promise<AgentReviewFailureReconciliation | null> {
  const runs = await tx.agentRun.findMany({ where: { id: { in: [subject.runId, call.runId] }, userId: subject.userId, novelId: subject.novelId } })
  const run = runs.find(row => row.id === subject.runId), source = runs.find(row => row.id === call.runId)
  if (!run || !source || run.taskRootId || source.taskRootId || source.runtimeProtocolVersion !== 0 || chapter.revision <= item.revision) return null
  const admission = await readQualityReviewAdmission(tx, run)
  if (!admission || admission.at <= result.createdAt) return null
  const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: call.runId, chapterId: item.chapterId, compilationId: item.compilationId, chapterRevision: item.revision,
    createdAt: { gte: call.createdAt, lte: result.createdAt } } })
  if (reports.length !== 1 || reports[0].status !== 'failed') return null
  const report = reports[0], metrics = object(report.deterministicMetrics), audit = object(metrics.criticResponse), claim = object(metrics.formatRecovery)
  const currentContentHash = hashText(chapter.content), claimedAt = new Date(String(claim.claimedAt))
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (metrics.independentCheck !== 'unavailable' || !hash(metrics.contentHash) || metrics.contentHash === currentContentHash
    || audit.callId !== item.callId || audit.version !== 1 || !hash(audit.contentHash) || !(Number(audit.characterCount) > 0)
    || !['json_invalid', 'incomplete_json', 'envelope_invalid', 'ambiguous_envelope', 'duplicate_keys', 'findings_invalid'].includes(String(audit.classification))
    || claim.version !== 1 || claim.state !== 'claimed' || claim.taskId !== taskId || claim.reportId !== report.id
    || claim.chapterId !== item.chapterId || claim.chapterRevision !== item.revision || claim.compilationId !== item.compilationId
    || claim.claimRunId !== call.runId || claim.operationId !== undefined || typeof claim.admissionId !== 'string'
    || claim.contextHash !== metrics.qualityContextHash || !hash(claim.contextHash) || !hash(claim.evidenceHash)
    || !Number.isFinite(claimedAt.getTime()) || claimedAt < report.createdAt || claimedAt > result.createdAt
    || claim.key !== runtimeJson({ taskId, chapterId: item.chapterId, revision: item.revision, admissionId: claim.admissionId }).hash) return null
  const first = await tx.agentRun.findFirstOrThrow({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const target = [{ chapterId: item.chapterId }, { targetId: { in: [item.chapterId, report.id, ...(item.compilationId ? [item.compilationId] : [])] } }]
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['prepared', 'dispatching', 'unknown'] } } })
    || await tx.aiUsageLog.count({ where: { userId: subject.userId, novelId: subject.novelId,
      AND: [{ OR: [{ agentRunId: { in: ids } }, { action: { startsWith: 'agent3Humanity' }, createdAt: { gte: first.createdAt }, OR: target }] },
        { OR: [{ billingStatus: { not: 'settled' } }, { billingStatus: null },
          { usageSource: { not: 'reported' } }, { usageSource: null }, { reservedCreditMilli: { gt: 0 } }] }] } })) return null
  const history = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result'] },
    createdAt: { lte: result.createdAt } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }], take: 2001 })
  if (history.length >= 2001 || history.some(event => {
    if (event.type !== 'tool.call' || event.id === call.id
      || !['quality_analyze', 'continuity_validate', 'chapter_write', 'chapter_edit_range', 'chapter_append'].includes(String(object(event.payload).toolName))) return false
    const ends = history.filter(end => end.type === 'tool.result' && end.runId === event.runId
      && object(end.payload).callId === object(event.payload).callId && end.seq > event.seq)
    return event.createdAt >= call.createdAt || ends.length !== 1 || ends[0].createdAt >= call.createdAt
  })) return null
  const payments = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    action: { startsWith: 'agent3Humanity' }, OR: target, createdAt: { gte: call.createdAt, lte: result.createdAt } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const primary = payments.find(row => row.action === 'agent3HumanityCritic'), recovery = payments.find(row => row.action === 'agent3HumanityFormatRecovery')
  if (payments.length !== 2 || !primary || !recovery || payments.some(row => row.usageSource !== 'reported' || row.billingStatus !== 'settled'
    || row.agentRunId !== null && row.agentRunId !== call.runId || row.requestTokens === null || row.responseTokens === null || row.responseTokens <= 0
    || object(row.billingEvidence).responseObserved !== true || row.reservedCreditMilli > 0
    || row.createdAt.getTime() + row.durationMs > result.createdAt.getTime())
    || primary.createdAt > report.createdAt || primary.createdAt.getTime() + primary.durationMs > report.createdAt.getTime()
    || recovery.createdAt < claimedAt || claim.evidenceHash !== runtimeJson({ callId: item.callId, contentHash: audit.contentHash, usageIds: [primary.id] }).hash) return null
  return { status: 'terminal_failed_billing_known', sourceRunId: call.runId, sourceResultId: result.id, sourceReportId: report.id,
    usageIds: payments.map(row => row.id), admissionId: admission.id, currentRevision: chapter.revision, currentContentHash }
}

/** Old loops left a received report pending when its subsequent local edit
 * failed. Reconcile only that exact call/result and settled payments; never
 * reopen a request or infer a returned response from a report alone. */
export async function readSettledQualityReviews(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, pending: readonly PendingReviewCall[]) {
  const quality = pending.filter(item => item.toolName === 'quality_analyze')
  if (!quality.length) return []
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  const settled: Array<PendingReviewCall & { reconciliation?: AgentReviewFailureReconciliation }> = []
  for (const item of quality) {
    const events = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result'] },
      payload: { path: ['callId'], equals: item.callId } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
    const calls = events.filter(event => event.type === 'tool.call'), results = events.filter(event => event.type === 'tool.result')
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], payload = object(result.payload), args = object(object(call.payload).args)
    if (call.runId !== result.runId || result.createdAt < call.createdAt || result.seq <= call.seq || object(call.payload).toolName !== 'quality_analyze'
      || payload.toolName !== 'quality_analyze' || payload.ok !== false
      || !REPAIR_BLOCK_CODES.has(String(payload.failureCode)) && !['QUALITY_REPORT_SAVE_FAILED', 'UNEXPECTED_TOOL_ERROR'].includes(String(payload.failureCode))
      || !(args.chapterId === item.chapterId || item.compilationId && args.compilationId === item.compilationId)
      || args.chapterId !== undefined && args.chapterId !== item.chapterId
      || args.compilationId !== undefined && args.compilationId !== item.compilationId) continue
    const chapter = await tx.chapter.findFirst({ where: { id: item.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) },
      select: { id: true, revision: true, content: true, orderIndex: true } })
    if (!chapter) continue
    if (payload.failureCode === 'UNEXPECTED_TOOL_ERROR') {
      if (!reviewTargetInScope(original.spec, subject.novelId, chapter) || !item.compilationId
        || !await tx.storyCompilation.findFirst({ where: { id: item.compilationId, userId: subject.userId,
          novelId: subject.novelId, runId: { in: ids }, chapterId: item.chapterId }, select: { id: true } })) continue
      const reconciliation = await readFailedInlineQualityRequest(tx, subject, ids, original.taskId, item, call, result, chapter)
      if (reconciliation) settled.push({ ...item, reconciliation })
      continue
    }
    if (payload.failureCode === 'QUALITY_REPORT_SAVE_FAILED') {
      // The server emits this only after every dispatched review phase returned
      // and the local report transaction failed. It says nothing about quality.
      const proof = object(payload.reviewRequestFinished), inScope = reviewTargetInScope(original.spec, subject.novelId, chapter)
      if (!inScope || proof.version !== 1 || proof.chapterId !== item.chapterId || proof.revision !== item.revision
        || typeof proof.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.contentHash)
        || chapter.revision < item.revision
        || chapter.revision === item.revision && proof.contentHash !== createHash('sha256').update(chapter.content).digest('hex')) continue
      if (item.compilationId && !await tx.storyCompilation.findFirst({ where: { id: item.compilationId,
        userId: subject.userId, novelId: subject.novelId, runId: { in: ids }, chapterId: item.chapterId }, select: { id: true } })) continue
      settled.push(item)
      continue
    }
    if (chapter.revision !== item.revision) continue
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
