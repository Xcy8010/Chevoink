import { COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'
import type { Prisma } from '@prisma/client'
import type { PendingReviewCall } from './checkpoint.js'
import type { ToolRestriction } from './tool-local-failure.js'
import { originalTaskRunIds } from './original-request.js'
import { readWritingScope } from './writing-scope.js'
import { runtimeJson } from './runtime-common.js'
import { activeChapterScope } from '../data/internal.js'

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
      if (cap ? paid.length !== 0 : paid.filter(item => item.action === 'agent3ContinuityCritic').length !== 1
        || paid.some(item => item.billingStatus !== 'settled' || item.usageSource !== 'reported'
          || item.requestTokens === null || item.responseTokens === null || item.responseTokens <= 0)) continue
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
  subject: { userId: string; novelId: string; runId: string }): Promise<Array<[string, string]>> {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.taskRootId) return []
  const admission = await readQualityReviewAdmission(tx, run)
  if (!admission) return []
  const original = await readWritingScope(tx, subject)
  if (original.parentRunId || original.writing?.kind !== 'bounded') return []
  const runIds = await originalTaskRunIds(tx, subject, original)
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: runIds }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })) return []
  const compilations = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds } } })
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  const keys: Array<[string, string]> = []
  for (const compilation of compilations) {
    const validation = object(compilation.validation), coverage = object(validation.coverage)
    if (compilation.status !== 'active' || !compilation.chapterId || validation.independentCheck !== 'unavailable' || ![6, COMPILER_CONTINUITY_PROTOCOL].includes(Number(coverage.protocolVersion))) continue
    const chapter = await tx.chapter.findFirst({ where: { id: compilation.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true, orderIndex: true } })
    if (!chapter || validation.checkedChapterId !== chapter.id || validation.checkedRevision !== chapter.revision
      || coverage.contentHash !== runtimeJson({ content: chapter.content }).hash
      || !original.writing.targets.some(target => target.orderIndex === chapter.orderIndex
        && (target.chapterId ?? original.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapter.id)) continue
    const ids = compilations.filter(item => item.chapterId === chapter.id).map(item => item.id)
    const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      OR: [{ targetType: 'story_compilation', targetId: { in: ids } }, { targetType: 'chapter', targetId: chapter.id }], action: { startsWith: 'agent3Continuity' } } })
    if (paid.some(item => item.billingStatus !== 'settled' || item.usageSource !== 'reported' || item.requestTokens === null || item.responseTokens === null)) continue
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
    const call = calls.at(-1)
    if (!call) continue
    const callId = object(call.payload).callId
    if (typeof callId !== 'string' || !callId || events.filter(event => event.runId === call.runId && event.type === 'tool.call' && object(event.payload).callId === callId).length !== 1) continue
    const args = object(object(call.payload).args)
    if (args.compilationId !== undefined && args.compilationId !== compilation.id || args.chapterId !== undefined && args.chapterId !== chapter.id) continue
    const result = events.find(event => event.runId === call.runId && event.type === 'tool.result' && object(event.payload).callId === object(call.payload).callId && event.seq > call.seq)!
    const payload = object(result.payload), checkedAt = new Date(String(validation.checkedAt)).getTime()
    if (payload.toolName !== 'continuity_validate' || payload.ok !== false || !['CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_EVIDENCE_UNLOCATED'].includes(String(payload.failureCode))
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
    if (receipts.filter(item => item.action === 'agent3ContinuityCritic').length !== 1 || receipts.some(item => !item.responseTokens || object(item.billingEvidence).responseObserved !== true
      || !['agent3ContinuityCritic', 'agent3ContinuityCriticOutputRecovery', 'agent3ContinuityCriticEmptyRecovery'].includes(item.action))) continue
    const key = `continuity-author-recovery:${runtimeJson({ taskId: original.taskId, chapterId: chapter.id, contentHash: coverage.contentHash, admissionId: admission.id }).hash}`
    keys.push([`${compilation.id}:${chapter.id}:${chapter.revision}:continuity_validate:protocol${COMPILER_CONTINUITY_PROTOCOL}`, key])
  }
  return keys
}
