import type { Prisma } from '@prisma/client'
import { DataAccessError, prisma } from '../../prisma.js'
import { activeChapterScope } from '../../data/internal.js'
import { isAgent2FeatureEnabled } from '../../agent2-feature-flags.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { assertWritingTarget } from '../writing-scope.js'
import { assertChapterManuscriptRevision, type ChapterReviewRevisionOptions } from '../chapter-review-guard.js'
import { recordStoryCompilerWrite } from '../story-compiler.js'
import type { ToolContext } from './types.js'

/** Shared manuscript CAS. Both runtimes and coordinated writing use the same
 * active scope, author revision and review-consumption boundary. Callers may
 * supply their effect transaction; this helper never opens a nested one. */
export async function updateOwnedChapterAtRevision(
  ctx: ToolContext,
  chapter: { id: string; revision: number; content?: string },
  data: Prisma.ChapterUpdateManyMutationInput,
  mutation?: ChapterReviewRevisionOptions['mutation'],
  mergedBatch = false,
  review?: Pick<ChapterReviewRevisionOptions, 'retainedFindings' | 'editRanges'>,
) {
  const apply = async (tx: Prisma.TransactionClient) => {
    ctx.signal.throwIfAborted()
    const consumeContinuityRevision = ctx.continuityRevision ? await (await import('../continuity-coordinator.js'))
      .assertContinuityRevisionApplication(tx, ctx, chapter, data.content, review) : ctx.nativeContinuityRevision
        ? await (await import('../continuity-coordinator.js')).assertNativeContinuityRevisionApplication(tx, ctx, chapter, data.content, review) : undefined
    await assertAgentManuscriptCurrent(tx, ctx)
    await assertWritingTarget(tx, ctx, { chapterId: chapter.id, effect: mutation ?? 'metadata' })
    if (typeof data.content === 'string' && data.content === chapter.content) {
      await assertChapterManuscriptRevision(tx, ctx, chapter, { mutation, mergedBatch, ...review, after: data.content })
      return tx.chapter.findFirst({ where: { id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision } })
    }
    const consumeReviewRevision = data.content !== undefined ? await assertChapterManuscriptRevision(tx, ctx, chapter, { mutation, mergedBatch, ...review,
      ...(typeof data.content === 'string' ? { after: data.content } : {}) }) : undefined
    ctx.signal.throwIfAborted()
    const result = await tx.chapter.updateMany({
      where: { id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision },
      data: { ...data, revision: { increment: 1 } },
    })
    if (result.count !== 1) return null
    await consumeContinuityRevision?.()
    await consumeReviewRevision?.()
    if (ctx.continuityRevision) await (await import('../continuity-coordinator.js')).recordContinuityRevisionApplication(tx, ctx, chapter, data.content)
    const updated = await tx.chapter.findFirst({ where: {
      id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision + 1,
    } })
    if (!updated) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '写入后的章节作用域已变化，本次事务需要回滚。')
    if (data.content !== undefined && isAgent2FeatureEnabled('storyCompiler', ctx.userId)) {
      await recordStoryCompilerWrite({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
        chapterId: updated.id, chapterOrderIndex: updated.orderIndex, chapterRevision: updated.revision }, tx)
    }
    ctx.signal.throwIfAborted()
    return updated
  }
  return ctx.transaction ? apply(ctx.transaction) : prisma.$transaction(apply)
}
