import { readRetiredReviewUsageIds } from './cancelled-review-recovery.js'
import { COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'
import type { Prisma } from '@prisma/client'
import type { PendingReviewCall } from './checkpoint.js'
import type { ToolRestriction } from './tool-local-failure.js'
import { originalTaskRunIds } from './original-request.js'
import { readWritingScope } from './writing-scope.js'
import { runtimeJson } from './runtime-common.js'
import { activeChapterScope } from '../data/internal.js'
import { isKnownTextRequestBilling, isKnownRejectedTextRequestAttempt } from './text-request-billing.js'
import { readKnownFailedContinuityCorrection } from './continuity-response-correction.js'
import { readOwnedContinuityReassessment, readUnsentContinuityAdmission } from './continuity-reassessment-witness.js'
import { hasContinuitySourceAuthority } from './continuity-source-authority.js'
import { hasTerminalEvidenceProtocol, terminalEvidenceVersion } from './terminal-evidence-context.js'
import { readReviewRequestRecoveryEvidence } from './review-request-recovery.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const capCodes = new Set(['CONTINUITY_CHECK_LIMIT', 'CONTINUITY_CHECK_BUDGET_EXCEEDED'])
const capCommitReason = '正文已保存；连续性自动检查次数已用完，最终版本尚未复核。继续其余可执行工作，交付时必须保留此限制。'

/** Authenticate retired local limits and received legacy locator failures. This
 * reads immutable witnesses; it never changes a report, ledger or unknown call. */
export async function readLegacyContinuityRecovery(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, restrictions: readonly ToolRestriction[], pending: readonly PendingReviewCall[]) {
  const original = await readWritingScope(tx, subject)
  const empty = { removed: [] as ToolRestriction[], settled: [] as PendingReviewCall[], recovered: [] as string[], markers: [] as string[], chapterIds: [] as string[] }
  if (original.parentRunId || !original.writing || original.writing.kind === 'needs_input') return empty
  const runIds = await originalTaskRunIds(tx, subject, original)
  const compilations = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds }, status: 'active' } })
  if (!compilations.length) return empty
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] } }, orderBy: [{ runId: 'asc' }, { seq: 'asc' }], take: 2001 })
  if (events.length >= 2001) return empty
  for (const compilation of compilations) {
    if (!compilation.chapterId) continue
    const validation = object(compilation.validation)
    const coverage = object(validation.coverage)
    if (coverage.version !== 1 || !Number.isInteger(coverage.protocolVersion) || Number(coverage.protocolVersion) < 1 || Number(coverage.protocolVersion) > 5
      || typeof coverage.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(coverage.contentHash)
      || !Number.isSafeInteger(coverage.charCount) || Number(coverage.charCount) < 0) continue
    const chapter = await tx.chapter.findFirst({ where: { id: compilation.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true } })
    if (!chapter) continue
    if (original.writing.kind === 'bounded' && !original.writing.targets.some(target =>
      (target.chapterId ?? original.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapter.id)) continue
    const matching = events.filter(event => {
      const payload = object(event.payload), args = object(payload.args)
      return event.type === 'tool.call' && payload.toolName === 'continuity_validate' && typeof payload.callId === 'string'
        && (args.compilationId === compilation.id || args.chapterId === chapter.id)
        && (args.compilationId === undefined || args.compilationId === compilation.id)
        && (args.chapterId === undefined || args.chapterId === chapter.id)
    })
    for (const call of matching) {
      const callId = String(object(call.payload).callId)
      const sameRun = events.filter(event => event.runId === call.runId)
      if (sameRun.filter(event => event.type === 'tool.call' && object(event.payload).callId === callId).length !== 1) continue
      const results = sameRun.filter(event => event.type === 'tool.result' && object(event.payload).callId === callId)
      if (results.length !== 1) continue
      const result = results[0], payload = object(result.payload), code = String(payload.failureCode)
      if (result.seq <= call.seq || payload.toolName !== 'continuity_validate' || payload.ok !== false) continue
      const cap = capCodes.has(code) && Number(validation.checkRounds) >= 3
      const locator = code === 'CONTINUITY_EVIDENCE_UNLOCATED' && validation.independentCheck === 'unavailable'
        && validation.checkedRevision === chapter.revision
      if (!cap && !locator) continue
      const sensitive = sameRun.filter(event => event.type === 'tool.call'
        && ['continuity_validate', 'chapter_write', 'chapter_edit_range', 'chapter_append'].includes(String(object(event.payload).toolName)))
      if (sensitive.some(event => event.id !== call.id && event.seq < result.seq && (event.seq > call.seq
        || !sameRun.some(end => end.type === 'tool.result' && object(end.payload).callId === object(event.payload).callId && end.seq < call.seq)))) continue
      const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
        targetType: 'story_compilation', targetId: compilation.id, action: { startsWith: 'agent3Continuity' },
        createdAt: { gte: call.createdAt, lte: result.createdAt } } })
      if (cap ? paid.length !== 0 : paid.filter(item => item.action === 'agent3ContinuityCritic' && !isKnownRejectedTextRequestAttempt(item)).length !== 1
        || paid.some(item => !isKnownRejectedTextRequestAttempt(item) && (item.usageSource !== 'reported' || !isKnownTextRequestBilling(item)))) continue
      const key = `${compilation.id}:${chapter.id}:${chapter.revision}:continuity_validate:protocol${COMPILER_CONTINUITY_PROTOCOL}`
      empty.recovered.push(key)
      empty.markers.push(`continuity-recovery:protocol6:${runtimeJson({ taskId: original.taskId, compilationId: compilation.id, callId, code }).hash}`)
      empty.chapterIds.push(chapter.id)
      empty.settled.push(...pending.filter(item => item.callId === callId && item.compilationId === compilation.id && item.chapterId === chapter.id && item.toolName === 'continuity_validate'))
      if (cap) empty.removed.push(...restrictions.filter(item => (item.action === 'continuity_validate' && capCodes.has(item.code)
        && [compilation.id, chapter.id].includes(item.target ?? '')) || (item.action === 'chapter_bridge_commit'
          && item.code === 'REVIEW_DEPENDENCY_UNAVAILABLE' && item.target === compilation.id && item.reason === capCommitReason)))
    }
  }
  return empty
}

/** A new author continuation may retry a returned, settled legacy review.
 * Restarting, changing compilers or copying an old request cannot authorize it. */
export async function readContinuedContinuityRecovery(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string },
  ignoreCurrentCall?: { callId: string; compilationId: string; chapterId: string }): Promise<Array<[string, string]>> {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.taskRootId) return []
  const admission = await readQualityReviewAdmission(tx, run)
  if (!admission) return []
  const original = await readWritingScope(tx, subject)
  if (original.parentRunId || original.writing?.kind !== 'bounded') return []
  const runIds = await originalTaskRunIds(tx, subject, original)
  const retiredUsageIds = await readRetiredReviewUsageIds(tx, subject, runIds)
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: runIds }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })) return []
  const compilations = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds } } })
  let events = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  // Only a real, uniquely owned current tool invocation may be omitted from
  // historical returned-call proof. Default readers retain their old behavior.
  if (ignoreCurrentCall) {
    if (run.status !== 'running' || !ignoreCurrentCall.callId || await tx.agentProviderAttempt.count({ where: {
      runId: { in: runIds }, status: { in: ['dispatching'] } } })) return []
    const matching = events.filter(event => event.runId === run.id && object(event.payload).callId === ignoreCurrentCall.callId)
    const call = matching[0], payload = object(call?.payload), args = object(payload.args)
    if (matching.length !== 1 || call.type !== 'tool.call' || payload.toolName !== 'continuity_validate' || call.createdAt < admission.at
      || args.compilationId !== undefined && args.compilationId !== ignoreCurrentCall.compilationId
      || args.chapterId !== undefined && args.chapterId !== ignoreCurrentCall.chapterId
      || args.compilationId === undefined && args.chapterId === undefined
      || !compilations.some(item => item.id === ignoreCurrentCall.compilationId && item.chapterId === ignoreCurrentCall.chapterId)
      || await tx.aiUsageLog.count({ where: { userId: subject.userId, novelId: subject.novelId, action: { startsWith: 'agent3Continuity' },
        OR: [{ targetType: 'story_compilation', targetId: ignoreCurrentCall.compilationId }, { targetType: 'chapter', targetId: ignoreCurrentCall.chapterId }],
        createdAt: { gte: call.createdAt } } })) return []
    events = events.filter(event => event.id !== call.id)
  }
  const keys: Array<[string, string]> = []
  const localRefusals = new Set((await readReviewRequestRecoveryEvidence(tx, subject))
    .filter(item => item.notDispatched).map(item => `${item.receipt.sourceRunId}:${item.callId}`))
  for (const compilation of compilations) {
    const validation = object(compilation.validation), coverage = object(validation.coverage)
    // Continue resumes candidate decisions, not this identical failed paid
    // terminal subject. Its authenticated handoff is handled by the loop;
    // missing/unknown witnesses must not fall back to another critic call.
    const terminalAudit = object(validation.continuityCriticResponse)
    if (terminalAudit.parserVersion === 8 && terminalAudit.classification === 'source_invalid'
      && object(validation.terminalCandidate).exitState) continue
    if (compilation.status !== 'active' || !compilation.chapterId || validation.independentCheck !== 'unavailable'
      || ![6, 7, COMPILER_CONTINUITY_PROTOCOL, ...(hasContinuitySourceAuthority(original.spec) ? [9] : []), ...(hasTerminalEvidenceProtocol(original.spec) ? [10] : []), ...(terminalEvidenceVersion(original.spec) === 2 ? [11] : [])].includes(Number(coverage.protocolVersion))) continue
    const chapter = await tx.chapter.findFirst({ where: { id: compilation.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true, orderIndex: true } })
    if (!chapter || validation.checkedChapterId !== chapter.id || validation.checkedRevision !== chapter.revision
      || coverage.contentHash !== runtimeJson({ content: chapter.content }).hash
      || !original.writing.targets.some(target => target.orderIndex === chapter.orderIndex
        && (target.chapterId ?? original.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapter.id)) continue
    const ids = compilations.filter(item => item.chapterId === chapter.id).map(item => item.id)
    const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      OR: [{ targetType: 'story_compilation', targetId: { in: ids } }, { targetType: 'chapter', targetId: chapter.id }], action: { startsWith: 'agent3Continuity' } } })
    const known = (item: typeof paid[number]) => isKnownRejectedTextRequestAttempt(item) || item.usageSource === 'reported' && isKnownTextRequestBilling(item)
    if (paid.some(item => !known(item) && !retiredUsageIds.has(item.id))) continue
    const unfinishedMutation = events.some(event => {
      const payload = object(event.payload), args = object(payload.args)
      return event.type === 'tool.call' && ['chapter_write', 'chapter_edit_range', 'chapter_append'].includes(String(payload.toolName))
        && args.chapterId === chapter.id && !events.some(end => end.runId === event.runId && end.type === 'tool.result'
          && object(end.payload).callId === payload.callId && end.seq > event.seq)
    })
    if (unfinishedMutation) continue
    const calls = events.filter(event => {
      const payload = object(event.payload), args = object(payload.args)
      return event.type === 'tool.call' && payload.toolName === 'continuity_validate'
        && (ids.includes(String(args.compilationId)) || args.chapterId === chapter.id)
    })
    if (calls.some(call => events.filter(event => event.runId === call.runId && event.type === 'tool.result'
      && object(event.payload).callId === object(call.payload).callId && event.seq > call.seq).length !== 1)) continue
    // Old servers represented this exact preflight rejection as a failed
    // invocation. Authenticate that zero-effect pair before selecting the last
    // actual assessment. No generic failure or unconfirmed request is skipped.
    const executedCalls = calls.filter(call => {
      const start = object(call.payload)
      if (localRefusals.has(`${call.runId}:${String(start.callId)}`)) return false
      const pair = events.filter(event => event.runId === call.runId && object(event.payload).callId === start.callId)
      const result = pair.find(event => event.type === 'tool.result'), end = object(result?.payload)
      return !(pair.length === 2 && start.autoApproved === false && result && result.seq === call.seq + 1
        && end.toolName === 'continuity_validate' && end.ok === false && end.durationMs === 0
        && end.failureCode === undefined && end.reviewRequestFinished === undefined && end.display === undefined
        && end.summary === '未执行：当前版本已收到未完成的检查报告，复用失败原因；正文或检查协议改变后再复核，未重复付费。'
        && result.createdAt >= call.createdAt && result.createdAt.getTime() - call.createdAt.getTime() <= 1000
        && !paid.some(item => item.createdAt >= call.createdAt && item.createdAt <= result.createdAt))
    })
    const call = executedCalls.at(-1)
    if (!call) continue
    const callId = object(call.payload).callId
    if (typeof callId !== 'string' || !callId || events.filter(event => event.runId === call.runId && event.type === 'tool.call' && object(event.payload).callId === callId).length !== 1) continue
    const args = object(object(call.payload).args)
    if (args.compilationId !== undefined && args.compilationId !== compilation.id || args.chapterId !== undefined && args.chapterId !== chapter.id) continue
    const result = events.find(event => event.runId === call.runId && event.type === 'tool.result' && object(event.payload).callId === object(call.payload).callId && event.seq > call.seq)!
    const knownCorrection = await readKnownFailedContinuityCorrection(tx, subject, {
      runIds, runId: call.runId, callId, chapterId: chapter.id, revision: chapter.revision, resultAt: result.createdAt,
    })
    const payload = object(result.payload), checkedAt = knownCorrection?.observation.createdAt.getTime()
      ?? new Date(String(object(validation.continuityEvidenceRecovery).observedAt ?? validation.checkedAt)).getTime()
    if (payload.toolName !== 'continuity_validate' || payload.ok !== false || !knownCorrection && !['CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_EVIDENCE_UNLOCATED'].includes(String(payload.failureCode))
      || admission.at <= result.createdAt || !Number.isFinite(checkedAt) || checkedAt < call.createdAt.getTime() || checkedAt > result.createdAt.getTime()) continue
    const overlaps = events.some(other => {
      const otherPayload = object(other.payload), otherArgs = object(otherPayload.args)
      if (other.id === call.id || other.type !== 'tool.call'
        || !['continuity_validate', 'chapter_write', 'chapter_edit_range', 'chapter_append'].includes(String(otherPayload.toolName))
        || !(otherArgs.chapterId === chapter.id || ids.includes(String(otherArgs.compilationId)))) return false
      const ends = events.filter(end => end.runId === other.runId && end.type === 'tool.result'
        && object(end.payload).callId === otherPayload.callId && end.seq > other.seq)
      if (ends.length !== 1) return true
      return other.runId === call.runId ? other.seq < result.seq && ends[0].seq > call.seq
        : other.createdAt <= result.createdAt && ends[0].createdAt >= call.createdAt
    })
    if (overlaps) continue
    const receipts = paid.filter(item => item.createdAt >= call.createdAt && item.createdAt <= result.createdAt)
    if (receipts.some(row => row.action === 'agent3ContinuityCriticSecondPass') && !await readOwnedContinuityReassessment(tx, subject, {
      runId: call.runId, callId, chapterId: chapter.id, revision: chapter.revision, compilationId: compilation.id,
      callAt: call.createdAt, resultAt: result.createdAt, payments: receipts,
    })) continue
    const correctionOnly = receipts.filter(item => item.action === 'agent3ContinuityEvidenceCorrection')
    if (knownCorrection && correctionOnly.length !== knownCorrection.usage.length) continue
    if (correctionOnly.length && (!knownCorrection || knownCorrection.usage.length !== correctionOnly.length
      || correctionOnly.some(row => !knownCorrection.usage.some(item => item.id === row.id)))) continue
    if ((!knownCorrection && receipts.filter(item => item.action === 'agent3ContinuityCritic' && !isKnownRejectedTextRequestAttempt(item)).length !== 1)
      || receipts.some(item => !known(item) || !isKnownRejectedTextRequestAttempt(item) && object(item.billingEvidence).responseObserved !== true
        || !['agent3ContinuityCritic', 'agent3ContinuityCriticOutputRecovery', 'agent3ContinuityCriticEmptyRecovery', 'agent3ContinuityEvidenceCorrection', 'agent3ContinuityCriticSecondPass'].includes(item.action))) continue
    const key = `continuity-author-recovery:${runtimeJson({ taskId: original.taskId, chapterId: chapter.id, contentHash: coverage.contentHash, admissionId: admission.id }).hash}`
    keys.push([`${compilation.id}:${chapter.id}:${chapter.revision}:continuity_validate:protocol${COMPILER_CONTINUITY_PROTOCOL}`, key])
  }
  for (const compilation of compilations) {
    const proof = await readUnsentContinuityAdmission(tx, subject, { runIds, compilationId: compilation.id, admission, retiredUsageIds })
    if (!proof || !original.writing.targets.some(target => target.orderIndex === proof.chapter.orderIndex
      && (target.chapterId ?? original.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === proof.chapter.id)) continue
    const target = `${compilation.id}:${proof.chapter.id}:${proof.chapter.revision}:continuity_validate:protocol${COMPILER_CONTINUITY_PROTOCOL}`
    if (!keys.some(([saved]) => saved === target)) keys.push([target, `continuity-author-recovery:${runtimeJson({ taskId: original.taskId,
      chapterId: proof.chapter.id, contentHash: proof.coverage.contentHash, admissionId: admission.id }).hash}`])
  }
  return keys
}
