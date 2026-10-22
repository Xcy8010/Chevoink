import { readRetiredReviewUsageIds } from './cancelled-review-recovery.js'
import { createHash } from 'node:crypto'
import type { AiUsageLog, Prisma } from '@prisma/client'
import type { AgentReviewFailureReconciliation } from '../../../shared/contracts/index.js'
import type { PendingReviewCall } from './checkpoint.js'
import { activeChapterScope } from '../data/internal.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'
import { isKnownTextRequestBilling } from './text-request-billing.js'
import { runtimeJson } from './runtime-common.js'
import { applyTerminalCandidatePatch, hasLegacyTerminalCallEvidence, terminalCandidatePatchSchema } from './terminal-candidate-patch.js'
import { readTerminalCandidate } from './terminal-state-review.js'
import { DataAccessError } from '../prisma.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const reviewers = ['quality_analyze', 'continuity_validate']
const sensitive = [...reviewers, 'chapter_write', 'chapter_edit_range', 'chapter_append']

export type ReviewRequestRecoveryEvidence = PendingReviewCall & {
  notDispatched?: true
  changedReviewInput?: { chapterId: string; revision: number }
  resultAt: Date
  receipt: Omit<AgentReviewFailureReconciliation, 'admissionId'>
}

/** Read only persisted request/accounting facts. This never grants admission,
 * clears a pending call, changes accounting or certifies a failed report. */
export async function readReviewRequestRecoveryEvidence(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, pending: readonly PendingReviewCall[] = []) {
  const recovered: ReviewRequestRecoveryEvidence[] = []
  const relatedByCall = new Map<string, AiUsageLog[]>()
  const authenticatedZeroUsage = new Set<string>()
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run) return recovered
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
      || typeof payload.callId !== 'string'
      || candidates.some(item => item.callId === payload.callId)) continue
    const call = history.find(row => row.type === 'tool.call' && row.runId === result.runId && object(row.payload).callId === payload.callId)
    if (!call) continue
    const args = object(object(call.payload).args)
    if (proof.version === 1 && Array.isArray(proof.usageIds) && typeof proof.chapterId === 'string' && Number.isSafeInteger(proof.revision)) {
      candidates.push({ callId: payload.callId, toolName: payload.toolName as PendingReviewCall['toolName'], chapterId: proof.chapterId,
        revision: Number(proof.revision), compilationId: typeof args.compilationId === 'string' ? args.compilationId : null })
    } else if (payload.toolName === 'continuity_validate' && payload.failureCode === 'CONTINUITY_INPUT_STALE'
      && typeof args.compilationId === 'string' && terminalCandidatePatchSchema.safeParse(args.terminalPatch).success) {
      // Discover old local refusals even after their pending checkpoint entry
      // was reconciled. The exact same ownership/journal/usage proof below
      // authenticates them; a missing usage row alone proves nothing.
      const compiler = await tx.storyCompilation.findFirst({ where: { id: args.compilationId, userId: subject.userId,
        novelId: subject.novelId, runId: { in: ids } }, select: { chapterId: true, validation: true } })
      const revision = object(compiler?.validation).checkedRevision
      if (compiler?.chapterId && Number.isSafeInteger(revision)) candidates.push({ callId: payload.callId, toolName: 'continuity_validate',
        chapterId: compiler.chapterId, revision: Number(revision), compilationId: args.compilationId })
    }
  }
  for (const item of candidates) {
    const events = history.filter(row => object(row.payload).callId === item.callId)
    const calls = events.filter(row => row.type === 'tool.call'), results = events.filter(row => row.type === 'tool.result')
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], payload = object(result.payload), args = object(object(call.payload).args), proof = object(payload.reviewRequestFinished)
    if (call.runId !== result.runId || result.seq <= call.seq || result.createdAt < call.createdAt
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
      && (chapter.revision !== item.revision || proof.contentHash === contentHash
        || item.toolName === 'continuity_validate' && proof.contentHash === runtimeJson({ content: chapter.content }).hash)
      && Array.isArray(proof.usageIds) && proof.usageIds.length > 0 && proof.usageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)
      && new Set(proof.usageIds).size === proof.usageIds.length
    const source = await tx.agentRun.findUniqueOrThrow({ where: { id: call.runId } })
    // terminalPatch was introduced with reserve-before-send journaling. A
    // closed local stale refusal on that producer can prove zero dispatch,
    // unlike an arbitrary legacy stale/provider error or an absent usage row.
    let localPatchRefusal = false
    const patch = terminalCandidatePatchSchema.safeParse(args.terminalPatch)
    if (!typed && item.toolName === 'continuity_validate' && payload.failureCode === 'CONTINUITY_INPUT_STALE'
      && !source.taskRootId && source.runtimeProtocolVersion === 0 && item.compilationId && patch.success
      && args.terminalState === undefined && chapter.revision === item.revision
      && !await hasLegacyTerminalCallEvidence(tx, { runId: call.runId, callId: item.callId })) {
      const compiler = await tx.storyCompilation.findFirst({ where: { id: item.compilationId, userId: subject.userId,
        novelId: subject.novelId, runId: { in: ids }, chapterId: chapter.id }, select: { validation: true } })
      const validation = object(compiler?.validation), candidate = readTerminalCandidate(validation)
      if (candidate && typeof validation.checkedAt === 'string' && Date.parse(validation.checkedAt) <= call.createdAt.getTime()
        && chapter.updatedAt <= call.createdAt) {
        try { applyTerminalCandidatePatch(candidate, patch.data) }
        catch (error) { localPatchRefusal = error instanceof DataAccessError && error.code === 'CONTINUITY_INPUT_STALE' }
      }
    }
    if (payload.reviewRequestFinished !== undefined && !typed && !(localPatchRefusal && proof.version === 1
      && proof.chapterId === chapter.id && proof.revision === chapter.revision && proof.contentHash === contentHash
      && Array.isArray(proof.usageIds) && proof.usageIds.length === 0)) continue
    if (!typed && !localPatchRefusal && (source.taskRootId || source.runtimeProtocolVersion !== 0 || !String(payload.failureCode).startsWith('AI_PROVIDER_'))) continue
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
    const known = (row: typeof related[number]) => isKnownTextRequestBilling(row)
      && (row.usageSource === 'reported' || typed && (proof.usageIds as string[]).includes(row.id)
        && row.action.startsWith(family) && row.createdAt >= call.createdAt && row.createdAt <= result.createdAt
        && (row.chapterId === item.chapterId || row.targetId !== null && targets.includes(row.targetId)))
    const payments = related.filter(row => row.action.startsWith(family) && row.createdAt >= call.createdAt && row.createdAt <= result.createdAt)
    if (localPatchRefusal) {
      if (payments.length || related.some(row => row.createdAt >= call.createdAt && row.createdAt <= result.createdAt)) continue
      relatedByCall.set(item.callId, related)
      recovered.push({ ...item, notDispatched: true, resultAt: result.createdAt, receipt: { status: 'terminal_failed_billing_known',
        sourceRunId: call.runId, sourceResultId: result.id, sourceReportId: null, usageIds: [],
        currentRevision: chapter.revision, currentContentHash: contentHash } })
      continue
    }
    if (!payments.length || payments.some(row => !known(row) || row.durationMs < 0 || row.createdAt.getTime() + row.durationMs > result.createdAt.getTime())) continue
    if (typed && (proof.usageIds as string[]).some(id => !payments.some(row => row.id === id))) continue
    if (typed && payments.some(row => !(proof.usageIds as string[]).includes(row.id))) continue
    // Validate each zero terminal against its own complete, owned call/result
    // proof before considering the task's other observations. Two authentic
    // non-overlapping refusals must not turn each other into unknown charges.
    payments.filter(row => row.usageSource !== 'reported').forEach(row => authenticatedZeroUsage.add(row.id))
    relatedByCall.set(item.callId, related)
    const sourceReports = reports.filter(row => row.runId === call.runId && row.chapterRevision === item.revision && row.status === 'failed'
      && row.createdAt >= call.createdAt && row.createdAt <= result.createdAt && object(object(row.deterministicMetrics).criticResponse).callId === item.callId)
    // Only a complete, exactly billed old request can narrow a legacy target ban.
    // A newer revision alone is insufficient: its actual body must differ too.
    const changedReviewInput = typed && item.toolName === 'quality_analyze' && chapter.revision > item.revision
      && proof.contentHash !== contentHash
      && !pending.some(other => other.callId !== item.callId && other.toolName === item.toolName && other.chapterId === item.chapterId)
      && !history.some(event => event.type === 'tool.call' && event.createdAt > call.createdAt
        && object(event.payload).toolName === item.toolName
        && (object(object(event.payload).args).chapterId === item.chapterId
          || item.compilationId && object(object(event.payload).args).compilationId === item.compilationId))
      ? { chapterId: item.chapterId, revision: item.revision } : undefined
    recovered.push({ ...item, ...(changedReviewInput ? { changedReviewInput } : {}), resultAt: result.createdAt, receipt: { status: 'terminal_failed_billing_known', sourceRunId: call.runId,
      sourceResultId: result.id, sourceReportId: sourceReports.length === 1 ? sourceReports[0].id : null, usageIds: payments.map(row => row.id),
      currentRevision: chapter.revision, currentContentHash: contentHash } })
  }
  return recovered.filter(item => !pending.some(other => (other.compilationId ?? other.chapterId) === (item.compilationId ?? item.chapterId)
      && other.toolName === item.toolName && other.callId !== item.callId)
    && relatedByCall.get(item.callId)?.every(row => retiredUsageIds.has(row.id)
      || isKnownTextRequestBilling(row) && (row.usageSource === 'reported' || authenticatedZeroUsage.has(row.id))))
    .sort((left, right) => left.resultAt.getTime() - right.resultAt.getTime() || left.callId.localeCompare(right.callId))
}

/** Only a genuine fresh human admission can turn evidence into a one-time
 * recovery proof. Old attempts, reservations and failed claims remain intact. */
export async function readReviewRequestRecovery(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, pending: readonly PendingReviewCall[]) {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run) return []
  const admission = await readQualityReviewAdmission(tx, run)
  if (!admission) return []
  return (await readReviewRequestRecoveryEvidence(tx, subject, pending)).filter(item => admission.at > item.resultAt)
    .map(({ receipt, resultAt: _resultAt, ...item }) => ({ ...item, reconciliation: { ...receipt, admissionId: admission.id } }))
}
