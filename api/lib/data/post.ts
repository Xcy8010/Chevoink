import { assertGovernanceAllowed } from '../governance-access.js'
/**
 * 社区帖子域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import type { Prisma } from '@prisma/client'
import type { CreatePostRequest, Post, PostDetailPayload } from '../../../shared/contracts/index.js'
import { extractTopicNames } from '../../../shared/contracts/topic-parse.js'
import { DataAccessError, prisma } from '../prisma.js'
import { buildPagination, buildSlug, commentInclude, ensureNonEmptyText, ensureUserExists, excerptContent, postInclude, toComment, toPost } from './internal.js'
import { COMMENT_RANK_FETCH_LIMIT, getViewerLikedCommentIds, rankCommentRecords } from './comment.js'



/** 查询 viewer 对一批帖子的点赞/收藏状态 */
export async function getViewerPostFlags(viewerUserId: string | null | undefined, postIds: string[]) {
  if (!viewerUserId || postIds.length === 0) {
    return { likedIds: new Set<string>(), bookmarkedIds: new Set<string>() }
  }

  const [likes, bookmarks] = await prisma.$transaction([
    prisma.postLike.findMany({
      where: { userId: viewerUserId, postId: { in: postIds } },
      select: { postId: true },
    }),
    prisma.postBookmark.findMany({
      where: { userId: viewerUserId, postId: { in: postIds } },
      select: { postId: true },
    }),
  ])

  return {
    likedIds: new Set(likes.map((item) => item.postId)),
    bookmarkedIds: new Set(bookmarks.map((item) => item.postId)),
  }
}



export function attachPostViewerFlags(post: Post, flags: { likedIds: Set<string>; bookmarkedIds: Set<string> }): Post {
  return {
    ...post,
    likedByViewer: flags.likedIds.has(post.id),
    bookmarkedByViewer: flags.bookmarkedIds.has(post.id),
  }
}



export async function setPostLikeData(
  userId: string,
  postId: string,
  liked: boolean,
): Promise<{ liked: boolean; likeCount: number } | null> {
  await ensureUserExists(userId)
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) {
    return null
  }

  return prisma.$transaction(async (tx) => {
    if (liked) {
      const existing = await tx.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      })
      if (!existing) {
        await tx.postLike.create({ data: { postId, userId } })
        await tx.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } })
      }
    } else {
      const deleted = await tx.postLike.deleteMany({ where: { postId, userId } })
      if (deleted.count > 0) {
        await tx.post.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } } })
      }
    }

    const updated = await tx.post.findUnique({ where: { id: postId }, select: { likeCount: true } })
    return { liked, likeCount: Math.max(0, updated?.likeCount ?? 0) }
  })
}



export async function setPostBookmarkData(
  userId: string,
  postId: string,
  bookmarked: boolean,
): Promise<{ bookmarked: boolean; favoriteCount: number } | null> {
  await ensureUserExists(userId)
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) {
    return null
  }

  return prisma.$transaction(async (tx) => {
    if (bookmarked) {
      const existing = await tx.postBookmark.findUnique({
        where: { postId_userId: { postId, userId } },
      })
      if (!existing) {
        await tx.postBookmark.create({ data: { postId, userId } })
        await tx.post.update({ where: { id: postId }, data: { favoriteCount: { increment: 1 } } })
      }
    } else {
      const deleted = await tx.postBookmark.deleteMany({ where: { postId, userId } })
      if (deleted.count > 0) {
        await tx.post.update({ where: { id: postId }, data: { favoriteCount: { decrement: 1 } } })
      }
    }

    const updated = await tx.post.findUnique({ where: { id: postId }, select: { favoriteCount: true } })
    return { bookmarked, favoriteCount: Math.max(0, updated?.favoriteCount ?? 0) }
  })
}



export type PostFeedSort = 'recommended' | 'latest'



/** 推荐流单轮候选集上限：千级帖子规模内存打分足够，避免全表扫描 */
const RECOMMEND_CANDIDATE_LIMIT = 500



/** 帖子推荐分（方案 18 §1.2）：对数压缩互动量 + 时间衰减；
 * age 以快照时间为基准，保证同一轮浏览翻页打分一致不跳位 */
export function computePostRecommendScore(
  post: { likeCount: number; commentCount: number; favoriteCount: number; createdAt: Date },
  referenceMs: number,
): number {
  const ageHours = Math.max(0, (referenceMs - post.createdAt.getTime()) / 3_600_000)
  const engagement = post.likeCount * 3 + post.commentCount * 4 + post.favoriteCount * 5
  return Math.log2(1 + engagement) / Math.pow(ageHours + 2, 1.3)
}



export async function listPostsData(
  page: number,
  pageSize: number,
  topicId?: string,
  viewerUserId?: string | null,
  authorUserId?: string,
  sort: PostFeedSort = 'latest',
  snapshotAt?: string,
) {
  const where: Prisma.PostWhereInput = {
    // 话题过滤同时兼容旧单外键与新多对多关联（方案 18 §3）
    ...(topicId ? { OR: [{ topicId }, { topicLinks: { some: { topicId } } }] } : {}),
    ...(authorUserId ? { userId: authorUserId } : {}),
  }

  if (sort === 'recommended') {
    // 快照式游标：首页生成快照时间，翻页回传；快照后新帖不进本轮榜单，刷新重算
    const parsed = snapshotAt ? new Date(snapshotAt) : null
    const snapshot = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()

    const candidates = await prisma.post.findMany({
      where: { ...where, createdAt: { lte: snapshot } },
      include: postInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: RECOMMEND_CANDIDATE_LIMIT,
    })

    const referenceMs = snapshot.getTime()
    const ranked = candidates
      .map((item) => ({ item, score: computePostRecommendScore(item, referenceMs) }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score
        }
        const timeDiff = b.item.createdAt.getTime() - a.item.createdAt.getTime()
        if (timeDiff !== 0) {
          return timeDiff
        }
        return b.item.id.localeCompare(a.item.id)
      })

    const start = (page - 1) * pageSize
    const pageItems = ranked.slice(start, start + pageSize).map((entry) => entry.item)

    const pageFlags = await getViewerPostFlags(
      viewerUserId,
      pageItems.map((item) => item.id),
    )

    return {
      items: pageItems.map((item) => attachPostViewerFlags(toPost(item), pageFlags)),
      pagination: buildPagination(page, pageSize, ranked.length),
      snapshotAt: snapshot.toISOString(),
    }
  }

  const [items, total] = await prisma.$transaction([
    prisma.post.findMany({
      where,
      include: postInclude,
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.post.count({ where }),
  ])

  const flags = await getViewerPostFlags(
    viewerUserId,
    items.map((item) => item.id),
  )

  return {
    items: items.map((item) => attachPostViewerFlags(toPost(item), flags)),
    pagination: buildPagination(page, pageSize, total),
  }
}



/** 社区面板统计：讨论总数/关联作品数/最近发帖时间，独立于分页口径保证数字准确 */
export async function getPostStatsData() {
  const [totalPosts, linkedNovelCount, latest] = await prisma.$transaction([
    prisma.post.count(),
    prisma.post.count({ where: { relatedNovelId: { not: null } } }),
    prisma.post.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])
  return {
    totalPosts,
    linkedNovelCount,
    lastPostAt: latest ? latest.createdAt.toISOString() : null,
  }
}

export async function getPostDetailData(postId: string, viewerUserId?: string | null): Promise<PostDetailPayload | null> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: postInclude,
  })

  if (!post) {
    return null
  }

  const [commentRecords, relatedPosts] = await prisma.$transaction([
    prisma.comment.findMany({
      where: {
        targetType: 'post',
        targetId: postId,
      },
      include: commentInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: COMMENT_RANK_FETCH_LIMIT,
    }),
    prisma.post.findMany({
      where: {
        id: { not: postId },
      },
      include: postInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: 4,
    }),
  ])

  // 帖子详情评论与列表接口同一套排序策略（热门优先 + 楼中楼正序）
  const rankedComments = rankCommentRecords(commentRecords, 'post')

  const [flags, likedCommentIds] = await Promise.all([
    getViewerPostFlags(viewerUserId, [postId, ...relatedPosts.map((item) => item.id)]),
    getViewerLikedCommentIds(
      viewerUserId,
      rankedComments.map((item) => item.id),
    ),
  ])

  return {
    post: attachPostViewerFlags(toPost(post), flags),
    comments: rankedComments.map((item) => ({ ...toComment(item), likedByViewer: likedCommentIds.has(item.id) })),
    relatedPosts: relatedPosts.map((item) => attachPostViewerFlags(toPost(item), flags)),
  }
}



export async function createPostData(userId: string, input: CreatePostRequest): Promise<Post> {
  await assertGovernanceAllowed(userId, 'post')
  await ensureUserExists(userId)
  ensureNonEmptyText(input.content, 'content')

  // 分享作者卡片：先校验目标用户存在，避免外键报错变成 500
  if (input.sharedUserId) {
    const sharedUser = await prisma.user.findUnique({ where: { id: input.sharedUserId } })
    if (!sharedUser) {
      throw new DataAccessError(404, 'USER_NOT_FOUND', '未找到要分享的作者。')
    }
  }

  // 服务端解析 # 为准（方案 18 §3.2）：自动创建缺失话题，单帖上限 5 个
  const topicNames = extractTopicNames(input.content)

  const post = await prisma.$transaction(async (tx) => {
    const topicIds: string[] = []
    for (const name of topicNames) {
      const existing = await tx.topic.findUnique({ where: { name } })
      if (existing) {
        topicIds.push(existing.id)
        continue
      }
      // slug 碰撞时加时间后缀兼容，保证创建不因唯一约束失败
      const baseSlug = buildSlug(name)
      const slugTaken = await tx.topic.findUnique({ where: { slug: baseSlug } })
      const createdTopic = await tx.topic.create({
        data: { name, slug: slugTaken ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug },
      })
      topicIds.push(createdTopic.id)
    }

    // 旧客户端仍可能直传 topicId：正文无 # 时作为兑底话题
    if (topicIds.length === 0 && input.topicId) {
      const legacyTopic = await tx.topic.findUnique({ where: { id: input.topicId } })
      if (legacyTopic) {
        topicIds.push(legacyTopic.id)
      }
    }

    const created = await tx.post.create({
      data: {
        userId,
        // 主话题写回单外键，兼容话题频道栏等旧链路
        topicId: topicIds[0] ?? null,
        relatedNovelId: input.relatedNovelId ?? null,
        sharedUserId: input.sharedUserId ?? null,
        content: input.content,
        excerpt: excerptContent(input.content),
        imageUrls: input.imageUrls ?? [],
        auditStatus: 'pending',
      },
      include: postInclude,
    })

    if (topicIds.length > 0) {
      await tx.postTopic.createMany({
        data: topicIds.map((topicId) => ({ postId: created.id, topicId })),
        skipDuplicates: true,
      })
      // 计数按关联表实量回算（与 listTopicsData 的实时计数口径一致）
      for (const topicId of topicIds) {
        const linkedCount = await tx.postTopic.count({ where: { topicId } })
        await tx.topic.updateMany({ where: { id: topicId }, data: { postCount: linkedCount } })
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        postCount: {
          increment: 1,
        },
      },
    })

    return created
  })

  return toPost(post)
}



/** 删除自己的帖子：连同评论/点赞/收藏/话题关联一并清理，计数回算 */
export async function deletePostData(userId: string, postId: string): Promise<boolean | null> {
  const existing = await prisma.post.findUnique({
    where: { id: postId },
    include: { topicLinks: true },
  })
  if (!existing) {
    return null
  }
  if (existing.userId !== userId) {
    throw new DataAccessError(403, 'FORBIDDEN', '只能删除自己的动态。')
  }

  await purgePostData(existing)
  return true
}



/** 后台管理删除帖子：不做归属校验，级联与计数回算与普通删除一致 */
export async function adminDeletePostData(postId: string): Promise<boolean | null> {
  const existing = await prisma.post.findUnique({
    where: { id: postId },
    include: { topicLinks: true },
  })
  if (!existing) {
    return null
  }

  await purgePostData(existing)
  return true
}



/** 删除帖子核心事务（普通删除与后台管理删除共用） */
async function purgePostData(existing: {
  id: string
  userId: string
  topicId: string | null
  topicLinks: Array<{ topicId: string }>
}): Promise<void> {
  const postId = existing.id
  const userId = existing.userId

  await prisma.$transaction(async (tx) => {
    const commentIds = (
      await tx.comment.findMany({
        where: { targetType: 'post', targetId: postId },
        select: { id: true },
      })
    ).map((item) => item.id)

    if (commentIds.length > 0) {
      await tx.commentLike.deleteMany({ where: { commentId: { in: commentIds } } })
      await tx.comment.deleteMany({ where: { id: { in: commentIds } } })
    }
    await tx.postLike.deleteMany({ where: { postId } })
    await tx.postBookmark.deleteMany({ where: { postId } })
    await tx.postTopic.deleteMany({ where: { postId } })
    await tx.post.delete({ where: { id: postId } })

    // 话题计数回算（含主话题与多话题关联），避免 decrement 出现负数
    const topicIds = new Set<string>()
    if (existing.topicId) {
      topicIds.add(existing.topicId)
    }
    for (const link of existing.topicLinks) {
      topicIds.add(link.topicId)
    }
    for (const topicId of topicIds) {
      const remaining = await tx.postTopic.count({ where: { topicId } })
      await tx.topic.updateMany({ where: { id: topicId }, data: { postCount: remaining } })
    }

    const remainingPosts = await tx.post.count({ where: { userId } })
    await tx.user.updateMany({ where: { id: userId }, data: { postCount: remainingPosts } })
  })
}
