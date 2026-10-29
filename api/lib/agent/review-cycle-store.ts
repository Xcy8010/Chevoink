import type { ChapterReviewReadScope } from './chapter-review-guard.js'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { advanceReviewCycle, beginReviewCycle, markReviewCycleVerification, readReviewCycle, reviewCycleContentHash, type ReviewCycle } from './review-cycle.js'
import { runtimeJson } from './runtime-common.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { qualityReportCheckedCurrentContent } from './quality-report-contract.js'

/** Legacy v1 has no phase marker. Only a saved assessment bound to one of its
 * actual edited bodies can demonstrate verification; messages cannot. */
export function observedReviewCycleVerification(cycle: ReviewCycle | null, validation: unknown,
  report: { status: string; chapterRevision: number; deterministicMetrics: unknown } | null, chapter: { revision: number; content: string }) {
  return !!observedReviewCycleVerificationBody(cycle, validation, report, chapter)
}

export function observedReviewCycleVerificationBody(cycle: ReviewCycle | null, validation: unknown,
  report: { status: string; chapterRevision: number; deterministicMetrics: unknown } | null, chapter: { revision: number; content: string }) {
  if (!cycle?.baseline || !cycle.transitions.length) return false
  if (cycle.verificationStarted) return cycle.verificationStarted
  const value = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : null
  const coverage = value?.coverage && typeof value.coverage === 'object' && !Array.isArray(value.coverage) ? value.coverage as Record<string, unknown> : null
  const assessed = ['complete', 'unavailable'].includes(String(value?.independentCheck)) ? cycle.transitions.find(step =>
    value?.checkedRevision === step.after.revision && coverage?.contentHash === step.after.contentHash) : null
  if (assessed) return assessed.after
  return report && report.chapterRevision > cycle.baseline.body.revision
    && qualityReportCheckedCurrentContent(report, chapter.revision, chapter.content)
    ? cycle.transitions.find(step => step.after.revision === chapter.revision && step.after.contentHash === reviewCycleContentHash(chapter.content))?.after ?? false : false
}

/** Call only after a real review request's ordinary admission/reservation.
 * It records coordination, never a completed/passed assessment or fee grant. */
export async function markChapterReviewCycleVerification(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, input: { compilationId: string; chapterId: string; revision: number;
    contentHash: string; kind?: 'continuity' | 'quality'; callId?: string }) {
  await lockNovelActiveScope(tx, subject.novelId)
  const original = await readOriginalTaskRequest(tx, subject), runIds = await originalTaskRunIds(tx, subject, original)
  await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${input.compilationId} AND user_id = ${subject.userId} AND novel_id = ${subject.novelId} FOR UPDATE`
  const compilation = await tx.storyCompilation.findFirst({ where: { id: input.compilationId, userId: subject.userId,
    novelId: subject.novelId, chapterId: input.chapterId, runId: { in: runIds } } })
  if (!compilation) throw new DataAccessError(409, 'REVIEW_CYCLE_CONFLICT', '复核不属于当前原任务的编译，未推进周期。')
  const scope = { taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: input.chapterId }
  const cycle = readReviewCycle(compilation.preparedContext, scope)
  if (!cycle?.transitions.length || cycle.verificationStarted) return false
  const chapter = await tx.chapter.findFirst({ where: { id: input.chapterId, revision: input.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { revision: true, content: true } })
  if (!chapter || reviewCycleContentHash(chapter.content) !== input.contentHash) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '复核周期仅能绑定当前已保存正文。')
  const context = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext) ? compilation.preparedContext : {}
  await tx.storyCompilation.update({ where: { id: compilation.id }, data: { preparedContext: { ...context,
    reviewCycle: markReviewCycleVerification(cycle, { revision: input.revision, contentHash: input.contentHash }) } as Prisma.InputJsonValue } })
  return true
}

/** Caller already holds the manuscript/compilation locks and has independently
 * authorized its mutation. This is bookkeeping, never mutation admission. */
export async function prepareReviewCycleTransition(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number; content: string; orderIndex: number },
  compilationId: string, after: string, ranges?: Array<{ start: number; end: number; newText: string }>, readScope?: ChapterReviewReadScope) {
  if (chapter.content === after) return
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  const compilation = await tx.storyCompilation.findFirst({ where: { id: compilationId, userId: subject.userId,
    novelId: subject.novelId, chapterId: chapter.id, runId: { in: runIds } } })
  if (!compilation) throw new DataAccessError(409, 'REVIEW_CYCLE_CONFLICT', '修订编译不属于当前原任务，未记录复查转换。')
  const scope = { taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id }
  const existing = readReviewCycle(compilation.preparedContext, scope)
  const { readChapterReviewReadiness, lockChapterReviewDecisions, createChapterReviewReadScope } = await import('./chapter-review-guard.js')
  readScope ??= createChapterReviewReadScope()
  let review = await readChapterReviewReadiness(tx, subject, compilationId, { readScope })
  if (review?.qualityReportId) {
    await lockChapterReviewDecisions(tx, review.qualityReportId)
    review = await readChapterReviewReadiness(tx, subject, compilationId, { readScope })
  }
  // Record actual manuscript transitions even when the other independent
  // report has not run yet. This context is not writing or paid authority.
  let cycle = existing ?? (review?.decisionBinding && (review.quality === 'complete' || review.continuity === 'complete') ? beginReviewCycle(scope, { compilationId, revision: chapter.revision,
    content: chapter.content, ready: true, binding: review.decisionBinding, required: { continuity: review.continuity === 'complete', quality: review.quality === 'complete' },
    findings: review.reviewCycleFindings ?? [], obligations: review.requiredDecisions ?? [] }) : null)
  if (!cycle) return
  if (!cycle.verificationStarted && review?.reviewCycle?.verificationStarted) {
    const quality = await tx.chapterQualityReport.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
      chapterId: chapter.id, runId: { in: runIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const body = observedReviewCycleVerificationBody(cycle, compilation.validation, quality, chapter)
    if (body) cycle = markReviewCycleVerification(cycle, body)
  }
  const boundCycle = cycle
  // Snapshot primitives: a caller's mutable ORM fixture/object cannot rebind CAS.
  const before = chapter.content, beforeRevision = chapter.revision, chapterId = chapter.id
  return async () => {
    const saved = await tx.chapter.findFirst({ where: { id: chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId),
      revision: beforeRevision + 1 }, select: { revision: true, content: true } })
    if (!saved || saved.revision !== beforeRevision + 1 || saved.content !== after) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '复查转换必须绑定实际成功的正文CAS。')
    const fresh = await tx.storyCompilation.findFirstOrThrow({ where: { id: compilationId, userId: subject.userId,
      novelId: subject.novelId, chapterId, runId: { in: runIds } } })
    const context = fresh.preparedContext && typeof fresh.preparedContext === 'object' && !Array.isArray(fresh.preparedContext) ? fresh.preparedContext : {}
    if (runtimeJson({ cycle: readReviewCycle(context, scope) }).hash !== runtimeJson({ cycle: existing }).hash) throw new DataAccessError(409, 'REVIEW_CYCLE_CONFLICT', '正文CAS之前复查周期已变化，未覆盖并发状态。')
    await tx.storyCompilation.update({ where: { id: compilationId }, data: { preparedContext: { ...context,
      reviewCycle: advanceReviewCycle(boundCycle, { beforeRevision, before, afterRevision: saved.revision, after, ranges }) } as Prisma.InputJsonValue } })
  }
}
