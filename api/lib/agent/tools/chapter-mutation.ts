import type { Prisma } from '@prisma/client'
import { DataAccessError, prisma } from '../../prisma.js'
import { activeChapterScope } from '../../data/internal.js'
import { isAgent2FeatureEnabled } from '../../agent2-feature-flags.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { assertWritingTarget } from '../writing-scope.js'
import { assertChapterManuscriptRevision, createChapterReviewReadScope, type ChapterReviewReadScope, type ChapterReviewRevisionOptions } from '../chapter-review-guard.js'
import { recordStoryCompilerWrite } from '../story-compiler.js'
import type { ToolContext } from './types.js'

/** Optional review repairs keep the current session's manuscript policy. */
export async function automaticChapterRevisionWritable(tx: Prisma.TransactionClient,
  subject: Pick<ToolContext, 'sessionId' | 'inlineChild'>) {
  if (subject.inlineChild) return false
  const session = await tx.agentSession.findUnique({ where: { id: subject.sessionId }, select: { sandboxMode: true, toolPolicy: true } })
  const policy = session?.toolPolicy && typeof session.toolPolicy === 'object' && !Array.isArray(session.toolPolicy) ? session.toolPolicy : {}
  return !!session && session.sandboxMode !== 'read_only' && policy.contentWrite !== 'deny'
}

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
  sourceReadScope?: ChapterReviewReadScope,
) {
  const apply = async (tx: Prisma.TransactionClient) => {
    ctx.signal.throwIfAborted()
    const readScope = sourceReadScope ?? createChapterReviewReadScope()
    await assertAgentManuscriptCurrent(tx, ctx)
    await assertWritingTarget(tx, ctx, { chapterId: chapter.id, effect: mutation ?? 'metadata' })
    if (typeof data.content === 'string' && data.content === chapter.content) {
      await assertChapterManuscriptRevision(tx, ctx, chapter, { mutation, mergedBatch, ...review, after: data.content, readScope })
      return tx.chapter.findFirst({ where: { id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision } })
    }
    const consumeReviewRevision = data.content !== undefined ? await assertChapterManuscriptRevision(tx, ctx, chapter, { mutation, mergedBatch, ...review, readScope,
      ...(typeof data.content === 'string' ? { after: data.content } : {}) }) : undefined
    ctx.signal.throwIfAborted()
    const result = await tx.chapter.updateMany({
      where: { id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision },
      data: { ...data, revision: { increment: 1 } },
    })
    if (result.count !== 1) return null
    await consumeReviewRevision?.()
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
  if (ctx.transaction) return apply(ctx.transaction)
  // A body effect authenticates its complete review-source lineage before CAS.
  // Keep that operation's bounded budget local; metadata retains the default.
  return data.content !== undefined ? prisma.$transaction(apply, { timeout: 20_000 }) : prisma.$transaction(apply)
}
