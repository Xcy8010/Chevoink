import { assertGovernanceAllowed } from '../governance-access.js'
/**
 * 评论域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import type { Prisma } from '@prisma/client'
import type { Comment, CommentTargetType, CreateCommentRequest, UpdateCommentRequest } from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { buildCommentTargetIds, buildPagination, commentInclude, ensureNonEmptyText, ensureUserExists, toComment } from './internal.js'



/** 评论排序候选集上限：单目标评论百千级，内存线程化排序足够 */
export const COMMENT_RANK_FETCH_LIMIT = 1000



/** 评论打分（方案 18 §2）：
 * - 帖子评论/章评/段评：热门优先 like*2 + reply + 新鲜加成
 * - 书评（novel）：优质优先 like*3 + reply*2 + 新鲜加成
 * 新鲜加成 = max(0, 48 - ageHours) / 48 * 2，保证新评论 48 小时内有冒头机会 */
function computeCommentRankScore(
  record: { likeCount: number; replyCount: number; createdAt: Date },
  targetType: CommentTargetType,
  nowMs: number,
): number {
  const ageHours = Math.max(0, (nowMs - record.createdAt.getTime()) / 3_600_000)
  const freshBonus = (Math.max(0, 48 - ageHours) / 48) * 2

  if (targetType === 'novel') {
    return record.likeCount * 3 + record.replyCount * 2 + freshBonus
  }

  return record.likeCount * 2 + record.replyCount + freshBonus
}



/** 线程扁平化排序：根评论按策略分降序，各自楼中楼回复按时间正序紧随其后，
 * 前端 buildThreads 按 parent 链归并时直接继承此顺序，无需前端改动 */
export function rankCommentRecords<
  T extends { id: string; parentId: string | null; rootId: string | null; likeCount: number; replyCount: number; createdAt: Date },
>(records: T[], targetType: CommentTargetType): T[] {
  const nowMs = Date.now()
  const roots = records.filter((record) => !record.parentId)
  const replies = records.filter((record) => Boolean(record.parentId))

  roots.sort((a, b) => {
    const scoreDiff = computeCommentRankScore(b, targetType, nowMs) - computeCommentRankScore(a, targetType, nowMs)
    if (scoreDiff !== 0) {
      return scoreDiff
    }
    const timeDiff = b.createdAt.getTime() - a.createdAt.getTime()
    if (timeDiff !== 0) {
      return timeDiff
    }
    return b.id.localeCompare(a.id)
  })

  const rootIds = new Set(roots.map((record) => record.id))
  const byRoot = new Map<string, T[]>()
  const orphans: T[] = []

  for (const reply of replies) {
    const key =
      reply.rootId && rootIds.has(reply.rootId)
        ? reply.rootId
        : reply.parentId && rootIds.has(reply.parentId)
          ? reply.parentId
          : null
    if (!key) {
      orphans.push(reply)
      continue
    }
    const bucket = byRoot.get(key)
    if (bucket) {
      bucket.push(reply)
    } else {
      byRoot.set(key, [reply])
    }
  }

  for (const bucket of byRoot.values()) {
    bucket.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }
  orphans.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const flattened: T[] = []
  for (const root of roots) {
    flattened.push(root, ...(byRoot.get(root.id) ?? []))
  }
  flattened.push(...orphans)
  return flattened
}



export async function listCommentsData(
  targetType: CommentTargetType,
  targetId: string,
  page: number,
  pageSize: number,
  viewerUserId?: string | null,
) {
  const where: Prisma.CommentWhereInput = { targetType, targetId }
  const [records, total] = await prisma.$transaction([
    prisma.comment.findMany({
      where,
      include: commentInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: COMMENT_RANK_FETCH_LIMIT,
    }),
    prisma.comment.count({ where }),
  ])

  const ranked = rankCommentRecords(records, targetType)
  const start = (page - 1) * pageSize
  const items = ranked.slice(start, start + pageSize)

  const likedCommentIds = await getViewerLikedCommentIds(
    viewerUserId,
    items.map((item) => item.id),
  )

  return {
    items: items.map((item) => ({ ...toComment(item), likedByViewer: likedCommentIds.has(item.id) })),
    pagination: buildPagination(page, pageSize, total),
  }
}



export async function createCommentData(userId: string, input: CreateCommentRequest): Promise<Comment> {
  await assertGovernanceAllowed(userId, input.targetType === 'post' ? 'post_comment' : 'novel_comment')
  await ensureUserExists(userId)
  const targetIds = buildCommentTargetIds(input.targetType, input.targetId)
  ensureNonEmptyText(input.content, 'content')

  // 作品根评论必须携带 1-5 星评分；回复与其他目标不记评分
  const isNovelRootComment = input.targetType === 'novel' && !input.parentId
  if (isNovelRootComment && (!Number.isInteger(input.rating) || input.rating! < 1 || input.rating! > 5)) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '请先为作品打分（1-5 星）。')
  }
  const rating = isNovelRootComment ? input.rating! : null

  // 章节段评：仅章节根评论记录段落序号，非法值一律归为章评
  const paragraphIndex =
    input.targetType === 'chapter' &&
    !input.parentId &&
    Number.isInteger(input.paragraphIndex) &&
    (input.paragraphIndex as number) >= 0
      ? (input.paragraphIndex as number)
      : null

  // 作品根评论一人只能发一条，重复发表引导去编辑/删除
  if (isNovelRootComment) {
    const existing = await prisma.comment.findFirst({
      where: { targetType: 'novel', targetId: input.targetId, userId, parentId: null },
      select: { id: true },
    })
    if (existing) {
      throw new DataAccessError(409, 'COMMENT_EXISTS', '你已点评过这部作品，可以在自己的评论上编辑或删除后重新发表。')
    }
  }

  // 回复：校验父评论存在并从父评论派生 rootId（父为根评论时 rootId 为空，父即根）
  let replyRootId: string | null = null
  if (input.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: input.parentId },
      select: { id: true, rootId: true },
    })
    if (!parent) {
      throw new DataAccessError(404, 'COMMENT_NOT_FOUND', '回复的评论不存在。')
    }
    replyRootId = parent.rootId ?? parent.id
  }

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        userId,
        targetType: input.targetType,
        targetId: input.targetId,
        parentId: input.parentId ?? null,
        rootId: replyRootId,
        content: input.content,
        rating,
        paragraphIndex,
        auditStatus: 'pending',
        ...targetIds,
      },
      include: commentInclude,
    })

    if (input.targetType === 'post') {
      await tx.post.update({
        where: { id: input.targetId },
        data: {
          commentCount: {
            increment: 1,
          },
        },
      })
    }

    if (input.targetType === 'chapter') {
      await tx.chapter.update({
        where: { id: input.targetId },
        data: {
          commentCount: {
            increment: 1,
          },
        },
      })
    }

    if (input.targetType === 'novel') {
      await tx.novel.update({
        where: { id: input.targetId },
        data: {
          commentCount: {
            increment: 1,
          },
        },
      })
    }

    if (input.parentId) {
      await tx.comment.updateMany({
        where: { id: input.parentId },
        data: {
          replyCount: {
            increment: 1,
          },
        },
      })
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        unreadNotificationCount: {
          increment: 1,
        },
      },
    })

    return created
  })

  return toComment(comment)
}



/** 编辑自己的评论；作品根评论可同步修改评星 */
export async function updateCommentData(
  userId: string,
  commentId: string,
  input: UpdateCommentRequest,
): Promise<Comment | null> {
  const existing = await prisma.comment.findUnique({ where: { id: commentId } })
  if (!existing) {
    return null
  }
  if (existing.userId !== userId) {
    throw new DataAccessError(403, 'FORBIDDEN', '只能编辑自己的评论。')
  }
  await assertGovernanceAllowed(userId, existing.targetType === 'post' ? 'post_comment' : 'novel_comment')
  ensureNonEmptyText(input.content, 'content')

  const isNovelRootComment = existing.targetType === 'novel' && !existing.parentId
  if (
    isNovelRootComment &&
    input.rating !== undefined &&
    (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
  ) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '请先为作品打分（1-5 星）。')
  }

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: {
      content: input.content,
      ...(isNovelRootComment && input.rating !== undefined ? { rating: input.rating } : {}),
    },
    include: commentInclude,
  })

  return toComment(updated)
}



/** 删除自己的评论（连同它的回复与点赞），并回算目标与父评论计数 */
export async function deleteCommentData(
  userId: string,
  commentId: string,
): Promise<{ deletedCount: number } | null> {
  const existing = await prisma.comment.findUnique({ where: { id: commentId } })
  if (!existing) {
    return null
  }
  if (existing.userId !== userId) {
    throw new DataAccessError(403, 'FORBIDDEN', '只能删除自己的评论。')
  }

  return purgeCommentData(existing)
}



/** 后台管理删除评论：不做归属校验，级联与计数回算与普通删除一致 */
export async function adminDeleteCommentData(commentId: string): Promise<{ deletedCount: number } | null> {
  const existing = await prisma.comment.findUnique({ where: { id: commentId } })
  if (!existing) {
    return null
  }

  return purgeCommentData(existing)
}



/** 删除评论核心事务（普通删除与后台管理删除共用） */
async function purgeCommentData(existing: {
  id: string
  parentId: string | null
  targetType: CommentTargetType
  targetId: string
}): Promise<{ deletedCount: number }> {
  const commentId = existing.id
  const deletedCount = await prisma.$transaction(async (tx) => {
    const descendants = await tx.comment.findMany({
      where: { OR: [{ parentId: commentId }, { rootId: commentId }] },
      select: { id: true },
    })
    const ids = [commentId, ...descendants.map((item) => item.id)]

    await tx.commentLike.deleteMany({ where: { commentId: { in: ids } } })
    await tx.comment.deleteMany({ where: { id: { in: ids } } })

    // 用剩余条数回算计数，避免 decrement 出现负数
    const remaining = await tx.comment.count({
      where: { targetType: existing.targetType, targetId: existing.targetId },
    })
    if (existing.targetType === 'post') {
      await tx.post.updateMany({ where: { id: existing.targetId }, data: { commentCount: remaining } })
    } else if (existing.targetType === 'chapter') {
      await tx.chapter.updateMany({ where: { id: existing.targetId }, data: { commentCount: remaining } })
    } else if (existing.targetType === 'novel') {
      await tx.novel.updateMany({ where: { id: existing.targetId }, data: { commentCount: remaining } })
    }

    if (existing.parentId) {
      const parentReplies = await tx.comment.count({ where: { parentId: existing.parentId } })
      await tx.comment.updateMany({
        where: { id: existing.parentId },
        data: { replyCount: parentReplies },
      })
    }

    return ids.length
  })

  return { deletedCount }
}



/** 查询 viewer 已点赞的评论 id 集合 */
export async function getViewerLikedCommentIds(
  viewerUserId: string | null | undefined,
  commentIds: string[],
): Promise<Set<string>> {
  if (!viewerUserId || commentIds.length === 0) {
    return new Set()
  }

  const likes = await prisma.commentLike.findMany({
    where: { userId: viewerUserId, commentId: { in: commentIds } },
    select: { commentId: true },
  })

  return new Set(likes.map((item) => item.commentId))
}



export async function setCommentLikeData(
  userId: string,
  commentId: string,
  liked: boolean,
): Promise<{ liked: boolean; likeCount: number } | null> {
  await ensureUserExists(userId)
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } })
  if (!comment) {
    return null
  }

  return prisma.$transaction(async (tx) => {
    if (liked) {
      const existing = await tx.commentLike.findUnique({
        where: { commentId_userId: { commentId, userId } },
      })
      if (!existing) {
        await tx.commentLike.create({ data: { commentId, userId } })
        await tx.comment.update({ where: { id: commentId }, data: { likeCount: { increment: 1 } } })
      }
    } else {
      const deleted = await tx.commentLike.deleteMany({ where: { commentId, userId } })
      if (deleted.count > 0) {
        await tx.comment.update({ where: { id: commentId }, data: { likeCount: { decrement: 1 } } })
      }
    }

    const updated = await tx.comment.findUnique({ where: { id: commentId }, select: { likeCount: true } })
    return { liked, likeCount: Math.max(0, updated?.likeCount ?? 0) }
  })
}
