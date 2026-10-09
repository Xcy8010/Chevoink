import { createHash } from 'node:crypto'
import type { AiUsageLog, Prisma } from '@prisma/client'
import type { AgentCancelledReviewRetirement } from '../../../shared/contracts/index.js'
import type { PendingReviewCall } from './checkpoint.js'
import { activeChapterScope } from '../data/internal.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sensitive = ['continuity_validate', 'quality_analyze', 'chapter_write', 'chapter_edit_range', 'chapter_append']
const exemptUsage = (row: AiUsageLog) => {
  const snapshot = object(row.billingSnapshot)
  return row.billingStatus === 'settled' && row.multiplierBps === 0 && row.creditChargeMilli === 0 && row.reservedCreditMilli === 0
    && snapshot.version === 'credits-v1-exact' && snapshot.multiplierBps === 0 && snapshot.modelTier === row.modelTier
    && (row.usageSource === 'unknown' && row.requestTokens === null && row.responseTokens === null
      || row.usageSource === 'reported' && row.requestTokens !== null && row.responseTokens !== null)
}
const reviewActions = (toolName: string) => {
  const family = toolName === 'continuity_validate' ? 'agent3Continuity' : 'agent3Humanity', primary = `${family}Critic`
  return { family, primary, actions: new Set([primary, `${primary}OutputRecovery`, `${primary}EmptyRecovery`,
    ...(toolName === 'quality_analyze' ? ['agent3HumanityFormatRecovery'] : [])]) }
}
const inScope = (spec: unknown, novelId: string, chapter: { id: string; orderIndex: number }) => {
  const scope = object(object(spec).scope), writing = object(scope.writing)
  return scope.novelId === novelId && (writing.kind === 'unbounded' || writing.kind === 'bounded' && Array.isArray(writing.targets) && writing.targets.some(value => {
    const target = object(value)
    return target.orderIndex === chapter.orderIndex && (target.chapterId == null || target.chapterId === chapter.id)
  }) || writing.kind === undefined && Array.isArray(scope.chapterIds) && scope.chapterIds.includes(chapter.id))
}

/** Consume a durable retirement as an execution receipt, never as known usage.
 * Every consumer keeps its current request's normal returned-usage checks. */
export async function readRetiredReviewUsageIds(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, runIds: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>()
  if (!runIds.includes(subject.runId)) return ids
  const runs = await tx.agentRun.findMany({ where: { id: { in: [...runIds] }, userId: subject.userId, novelId: subject.novelId } })
  if (runs.length !== runIds.length) return ids
  const original = await readOriginalTaskRequest(tx, subject)
  const history = await tx.agentRunEvent.findMany({ where: { runId: { in: [...runIds] },
    type: { in: ['tool.call', 'tool.result', 'run.paused', 'run.started', 'run.finished', 'review.reconciled'] } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  for (const audit of history.filter(row => row.type === 'review.reconciled')) {
    const payload = object(audit.payload), receipt = object(payload.receipt)
    if (receipt.status !== 'cancelled_review_billing_exempt' || receipt.usageOutcome !== 'unknown_preserved'
      || receipt.sourceCallId !== payload.callId || typeof payload.callId !== 'string' || typeof payload.chapterId !== 'string'
      || !Number.isSafeInteger(receipt.currentRevision) || Number(receipt.currentRevision) < 1
      || typeof receipt.currentContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.currentContentHash)
      || !Array.isArray(receipt.usageIds) || !receipt.usageIds.length || !receipt.usageIds.every(id => typeof id === 'string')
      || new Set(receipt.usageIds).size !== receipt.usageIds.length) continue
    const calls = history.filter(row => row.type === 'tool.call' && object(row.payload).callId === payload.callId)
    const results = history.filter(row => row.type === 'tool.result' && object(row.payload).callId === payload.callId)
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], args = object(object(call.payload).args), returned = object(result.payload)
    const toolName = String(object(call.payload).toolName), source = runs.find(row => row.id === call.runId)
    if (!source || source.taskRootId || source.runtimeProtocolVersion !== 0 || receipt.sourceRunId !== call.runId
      || receipt.sourceResultId !== result.id || result.runId !== call.runId || result.seq <= call.seq || result.createdAt < call.createdAt
      || !['continuity_validate', 'quality_analyze'].includes(toolName) || returned.toolName !== toolName || returned.ok !== false
      || returned.failureCode !== 'UNEXPECTED_TOOL_ERROR' || returned.summary !== '已中断'
      || args.chapterId !== undefined && args.chapterId !== payload.chapterId
      || args.compilationId !== undefined && args.compilationId !== payload.compilationId
      || args.chapterId !== payload.chapterId && (!payload.compilationId || args.compilationId !== payload.compilationId)) continue
    const stop = history.find(row => row.runId === call.runId && row.seq > result.seq && ['run.paused', 'run.started', 'run.finished'].includes(row.type))
    if (!stop || stop.id !== receipt.sourceStopEventId || stop.type !== 'run.paused' || object(stop.payload).reason !== 'user_stop') continue
    const admitted = history.some(start => {
      const proof = object(object(start.payload).authorContinue)
      if (start.type !== 'run.started' || start.runId !== audit.runId || start.createdAt <= stop.createdAt || start.createdAt > audit.createdAt
        || !Number.isSafeInteger(proof.afterSeq) || start.seq !== Number(proof.afterSeq) + 1 || receipt.admissionId !== `author-continue:${proof.eventId}`) return false
      const terminal = history.find(row => row.id === proof.eventId && row.runId === start.runId && ['run.paused', 'run.finished'].includes(row.type)
        && row.seq <= Number(proof.afterSeq))
      return Boolean(terminal) && !history.some(row => row.runId === start.runId && ['run.paused', 'run.finished'].includes(row.type)
        && row.seq > terminal!.seq && row.seq < start.seq)
    })
    if (!admitted) continue
    const chapter = await tx.chapter.findFirst({ where: { id: payload.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) } })
    if (!chapter || !inScope(original.spec, subject.novelId, chapter)) continue
    if (payload.compilationId && (typeof payload.compilationId !== 'string' || !await tx.storyCompilation.findFirst({ where: {
      id: payload.compilationId, userId: subject.userId, novelId: subject.novelId, runId: { in: [...runIds] }, chapterId: chapter.id } }))) continue
    const { family, primary, actions } = reviewActions(toolName)
    const payments = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      action: { startsWith: family }, createdAt: { gte: call.createdAt, lte: result.createdAt },
      OR: [{ chapterId: chapter.id }, { targetId: { in: [chapter.id, ...(typeof payload.compilationId === 'string' ? [payload.compilationId] : [])] } }, { agentRunId: call.runId }] } })
    if (payments.length !== receipt.usageIds.length || payments.filter(row => row.action === primary).length !== 1
      || !payments.some(row => row.usageSource === 'unknown') || payments.some(row => !receipt.usageIds || !(receipt.usageIds as string[]).includes(row.id)
        || !actions.has(row.action) || !exemptUsage(row) || row.agentRunId !== null && row.agentRunId !== call.runId)) continue
    for (const payment of payments) ids.add(payment.id)
  }
  return ids
}

/** Retire a cancelled, author-exempt execution lock, not an unknown request.
 * The original usage, response uncertainty and budget remain untouched. */
export async function readCancelledReviewRetirements(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, pending: readonly PendingReviewCall[]) {
  const retired: Array<PendingReviewCall & { retirement: AgentCancelledReviewRetirement; persisted: boolean }> = []
  if (!pending.length) return retired
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.taskRootId || run.runtimeProtocolVersion !== 0) return retired
  const admission = await readQualityReviewAdmission(tx, run)
  if (!admission) return retired
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  const retiredUsageIds = await readRetiredReviewUsageIds(tx, subject, ids)
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['prepared', 'dispatching', 'unknown'] } } })) return retired
  const first = await tx.agentRun.findFirstOrThrow({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const history = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result', 'run.paused', 'run.started', 'run.finished', 'review.reconciled'] } },
    orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  for (const item of pending) {
    const calls = history.filter(row => row.type === 'tool.call' && object(row.payload).callId === item.callId)
    const results = history.filter(row => row.type === 'tool.result' && object(row.payload).callId === item.callId)
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], args = object(object(call.payload).args), payload = object(result.payload)
    if (call.runId !== result.runId || result.seq <= call.seq || result.createdAt < call.createdAt
      || object(call.payload).toolName !== item.toolName || payload.toolName !== item.toolName || payload.ok !== false
      || payload.failureCode !== 'UNEXPECTED_TOOL_ERROR' || payload.summary !== '已中断'
      || args.chapterId !== undefined && args.chapterId !== item.chapterId
      || args.compilationId !== undefined && args.compilationId !== item.compilationId
      || args.chapterId !== item.chapterId && (!item.compilationId || args.compilationId !== item.compilationId)) continue
    const source = await tx.agentRun.findUniqueOrThrow({ where: { id: call.runId } })
    if (source.taskRootId || source.runtimeProtocolVersion !== 0) continue
    const stop = history.find(row => row.runId === call.runId && row.seq > result.seq && ['run.paused', 'run.started', 'run.finished'].includes(row.type))
    if (!stop || stop.type !== 'run.paused' || object(stop.payload).reason !== 'user_stop' || admission.at <= stop.createdAt) continue
    // A different sensitive operation still in flight cannot borrow this stop.
    if (history.some(row => {
      if (row.type !== 'tool.call' || row.id === call.id || !sensitive.includes(String(object(row.payload).toolName)) || row.createdAt > stop.createdAt) return false
      const ends = history.filter(end => end.type === 'tool.result' && end.runId === row.runId && object(end.payload).callId === object(row.payload).callId && end.seq > row.seq)
      return row.createdAt >= call.createdAt || ends.length !== 1 || ends[0].createdAt >= call.createdAt
    })) continue
    const chapter = await tx.chapter.findFirst({ where: { id: item.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) } })
    if (!chapter || chapter.revision < item.revision || !inScope(original.spec, subject.novelId, chapter)) continue
    if (item.compilationId && !await tx.storyCompilation.findFirst({ where: { id: item.compilationId, userId: subject.userId,
      novelId: subject.novelId, runId: { in: ids }, chapterId: item.chapterId, status: 'active' } })) continue
    const { family, primary, actions } = reviewActions(item.toolName)
    const related = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, action: { startsWith: family },
      createdAt: { gte: first.createdAt }, OR: [{ chapterId: item.chapterId }, { targetId: { in: [item.chapterId, ...(item.compilationId ? [item.compilationId] : [])] } }, { agentRunId: { in: ids } }] } })
    const payments = related.filter(row => row.createdAt >= call.createdAt && row.createdAt <= result.createdAt)
    if (!payments.length || payments.filter(row => row.action === primary).length !== 1 || payments.some(row => !actions.has(row.action)
      || !exemptUsage(row) || row.agentRunId !== null && row.agentRunId !== call.runId) || !payments.some(row => row.usageSource === 'unknown')) continue
    if (related.some(row => !payments.some(payment => payment.id === row.id) && !retiredUsageIds.has(row.id) && (row.usageSource !== 'reported'
      || row.billingStatus !== 'settled' || row.requestTokens === null || row.responseTokens === null || row.reservedCreditMilli !== 0))) continue
    const previous = history.find(row => payments.every(payment => retiredUsageIds.has(payment.id)) && row.type === 'review.reconciled' && object(row.payload).callId === item.callId
      && object(object(row.payload).receipt).status === 'cancelled_review_billing_exempt'
      && object(object(row.payload).receipt).sourceResultId === result.id && object(object(row.payload).receipt).sourceStopEventId === stop.id)
    const receipt = object(object(previous?.payload).receipt)
    retired.push({ ...item, persisted: Boolean(previous), retirement: {
      status: 'cancelled_review_billing_exempt', sourceRunId: call.runId, sourceResultId: result.id, sourceReportId: null,
      sourceStopEventId: stop.id, sourceCallId: item.callId, usageOutcome: 'unknown_preserved', usageIds: payments.map(row => row.id),
      admissionId: typeof receipt.admissionId === 'string' ? receipt.admissionId : admission.id,
      currentRevision: chapter.revision, currentContentHash: createHash('sha256').update(chapter.content).digest('hex'),
    } })
  }
  return retired
}
