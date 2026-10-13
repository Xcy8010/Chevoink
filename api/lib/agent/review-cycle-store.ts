import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { advanceReviewCycle, beginReviewCycle, readReviewCycle } from './review-cycle.js'
import { runtimeJson } from './runtime-common.js'

/** Caller already holds the manuscript/compilation locks and has independently
 * authorized its mutation. This is bookkeeping, never mutation admission. */
export async function prepareReviewCycleTransition(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number; content: string },
  compilationId: string, after: string, ranges?: Array<{ start: number; end: number; newText: string }>) {
  if (chapter.content === after) return
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  const compilation = await tx.storyCompilation.findFirst({ where: { id: compilationId, userId: subject.userId,
    novelId: subject.novelId, chapterId: chapter.id, runId: { in: runIds } } })
  if (!compilation) throw new DataAccessError(409, 'REVIEW_CYCLE_CONFLICT', '修订编译不属于当前原任务，未记录复查转换。')
  const scope = { taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id }
  const existing = readReviewCycle(compilation.preparedContext, scope)
  const { readChapterReviewReadiness, originalChapterReviewRequirements, lockChapterReviewDecisions } = await import('./chapter-review-guard.js')
  let review = await readChapterReviewReadiness(tx, subject, compilationId)
  if (review?.qualityReportId) {
    await lockChapterReviewDecisions(tx, review.qualityReportId)
    review = await readChapterReviewReadiness(tx, subject, compilationId)
  }
  const cycle = existing ?? (review?.ready && review.decisionBinding ? beginReviewCycle(scope, { compilationId, revision: chapter.revision,
    content: chapter.content, ready: true, binding: review.decisionBinding, required: originalChapterReviewRequirements(original),
    findings: review.reviewCycleFindings ?? [] }) : null)
  if (!cycle) return
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
      reviewCycle: advanceReviewCycle(cycle, { beforeRevision, before, afterRevision: saved.revision, after, ranges }) } as Prisma.InputJsonValue } })
  }
}
