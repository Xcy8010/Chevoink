import { readRetiredReviewUsageIds } from './cancelled-review-recovery.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { AgentReviewFailureReconciliation } from '../../../shared/contracts/index.js'
import type { PendingReviewCall } from './checkpoint.js'
import { activeChapterScope } from '../data/internal.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const reviewers = ['quality_analyze', 'continuity_validate']
const sensitive = [...reviewers, 'chapter_write', 'chapter_edit_range', 'chapter_append']

/** Resolve request uncertainty, never report validity. A fresh human admission
 * permits one new assessment; old attempts, reservations and claims remain. */
export async function readReviewRequestRecovery(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, pending: readonly PendingReviewCall[]) {
  const recovered: Array<PendingReviewCall & { reconciliation: AgentReviewFailureReconciliation }> = []
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run) return recovered
  const admission = await readQualityReviewAdmission(tx, run)
  if (!admission) return recovered
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  const retiredUsageIds = await readRetiredReviewUsageIds(tx, subject, ids)
  const first = await tx.agentRun.findFirstOrThrow({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['prepared', 'dispatching', 'unknown'] } } })) return recovered
  const history = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result'] } },
    orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  const candidates = [...pending]
  for (const result of history) {
    const payload = object(result.payload), proof = object(payload.reviewRequestFinished)
    if (result.type !== 'tool.result' || payload.ok !== false || !reviewers.includes(String(payload.toolName))
      || proof.version !== 1 || !Array.isArray(proof.usageIds) || !proof.usageIds.length || typeof payload.callId !== 'string'
      || candidates.some(item => item.callId === payload.callId)) continue
    const call = history.find(row => row.type === 'tool.call' && row.runId === result.runId && object(row.payload).callId === payload.callId)
    if (!call || typeof proof.chapterId !== 'string' || !Number.isSafeInteger(proof.revision)) continue
    const args = object(object(call.payload).args)
    candidates.push({ callId: payload.callId, toolName: payload.toolName as PendingReviewCall['toolName'], chapterId: proof.chapterId,
      revision: Number(proof.revision), compilationId: typeof args.compilationId === 'string' ? args.compilationId : null })
  }
  for (const item of candidates) {
    const events = history.filter(row => object(row.payload).callId === item.callId)
    const calls = events.filter(row => row.type === 'tool.call'), results = events.filter(row => row.type === 'tool.result')
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], payload = object(result.payload), args = object(object(call.payload).args), proof = object(payload.reviewRequestFinished)
    if (call.runId !== result.runId || result.seq <= call.seq || result.createdAt < call.createdAt || admission.at <= result.createdAt
      || payload.ok !== false || payload.toolName !== item.toolName || object(call.payload).toolName !== item.toolName
      || !reviewers.includes(item.toolName) || args.chapterId !== undefined && args.chapterId !== item.chapterId
      || args.compilationId !== undefined && args.compilationId !== item.compilationId
      || args.chapterId !== item.chapterId && args.compilationId !== item.compilationId) continue
    const chapter = await tx.chapter.findFirst({ where: { id: item.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) } })
    if (!chapter || chapter.revision < item.revision) continue
    const scope = object(object(original.spec).scope), writing = object(scope.writing)
    if (scope.novelId !== subject.novelId || !(writing.kind === 'bounded' ? Array.isArray(writing.targets) && writing.targets.some(value => {
      const target = object(value)
      return target.orderIndex === chapter.orderIndex && (target.chapterId == null || target.chapterId === chapter.id)
    }) : writing.kind === 'unbounded' || Array.isArray(scope.chapterIds) && scope.chapterIds.includes(chapter.id))) continue
    if (item.compilationId && !await tx.storyCompilation.findFirst({ where: { id: item.compilationId, userId: subject.userId,
      novelId: subject.novelId, runId: { in: ids }, chapterId: item.chapterId } })) continue
    const contentHash = createHash('sha256').update(chapter.content).digest('hex')
    const typed = proof.version === 1 && proof.chapterId === item.chapterId && proof.revision === item.revision
      && typeof proof.contentHash === 'string' && /^[a-f0-9]{64}$/.test(proof.contentHash)
      && (chapter.revision !== item.revision || proof.contentHash === contentHash)
      && Array.isArray(proof.usageIds) && proof.usageIds.length > 0 && proof.usageIds.every(id => typeof id === 'string')
    const source = await tx.agentRun.findUniqueOrThrow({ where: { id: call.runId } })
    if (!typed && (source.taskRootId || source.runtimeProtocolVersion !== 0 || !String(payload.failureCode).startsWith('AI_PROVIDER_'))) continue
    if (history.some(event => {
      if (event.type !== 'tool.call' || event.id === call.id || !sensitive.includes(String(object(event.payload).toolName)) || event.createdAt > result.createdAt) return false
      const ends = history.filter(end => end.type === 'tool.result' && end.runId === event.runId && object(end.payload).callId === object(event.payload).callId && end.seq > event.seq)
      return event.createdAt >= call.createdAt || ends.length !== 1 || ends[0].createdAt >= call.createdAt
    })) continue
    const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      chapterId: item.chapterId, runId: { in: ids } }, select: { id: true, runId: true, chapterRevision: true, createdAt: true, status: true, deterministicMetrics: true } })
    const targets = [item.chapterId, ...reports.map(row => row.id), ...(item.compilationId ? [item.compilationId] : [])]
    const family = item.toolName === 'quality_analyze' ? 'agent3Humanity' : 'agent3Continuity'
    const related = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      OR: [{ agentRunId: { in: ids } }, { action: { startsWith: family }, createdAt: { gte: first.createdAt },
        OR: [{ chapterId: item.chapterId }, { targetId: { in: targets } }] }] } })
    const known = (row: typeof related[number]) => row.usageSource === 'reported' && ['settled', 'exempt'].includes(row.billingStatus ?? '')
      && row.requestTokens !== null && row.responseTokens !== null && row.reservedCreditMilli === 0
    if (related.some(row => !known(row) && !retiredUsageIds.has(row.id))) continue
    const payments = related.filter(row => row.action.startsWith(family) && row.createdAt >= call.createdAt && row.createdAt <= result.createdAt)
    if (!payments.length || payments.some(row => !known(row) || row.createdAt.getTime() + row.durationMs > result.createdAt.getTime())) continue
    if (typed && (proof.usageIds as string[]).some(id => !payments.some(row => row.id === id))) continue
    if (typed && payments.some(row => !(proof.usageIds as string[]).includes(row.id))) continue
    const sourceReports = reports.filter(row => row.runId === call.runId && row.chapterRevision === item.revision && row.status === 'failed'
      && row.createdAt >= call.createdAt && row.createdAt <= result.createdAt && object(object(row.deterministicMetrics).criticResponse).callId === item.callId)
    recovered.push({ ...item, reconciliation: { status: 'terminal_failed_billing_known', sourceRunId: call.runId,
      sourceResultId: result.id, sourceReportId: sourceReports.length === 1 ? sourceReports[0].id : null, usageIds: payments.map(row => row.id), admissionId: admission.id,
      currentRevision: chapter.revision, currentContentHash: contentHash } })
  }
  return recovered
}
