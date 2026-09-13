/**
 * 用户/资料/互动域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import { randomUUID } from 'node:crypto'
import type { CommentTargetType, FollowUserItem, InteractionBadges, InteractionItem, Post, PrivacyLevel, PrivacySettings, ProfileVisibility, ReceivedLikeItem, User, UserMePayload, UserReplyItem } from '../../../shared/contracts/index.js'
import { createUnsetPasswordHash, hashPassword, isLegacyPasswordHash, verifyPassword } from '../password.js'
import { initializeNewUserCredits } from '../credits.js'
import { evictUserBanCache } from '../auth-session.js'
import { normalizePhoneNumber } from '../phone.js'
import { DataAccessError, prisma } from '../prisma.js'
import { buildAutoNickname, commentInclude, conversationInclude, ensureNonEmptyText, ensureUserExists, excerptContent, isUserOnline, novelInclude, nowIso, postInclude, resolveEffectiveNovelTitle, toConversation, toCoverAsset, toIso, toNovel, toPost, toUser, toUserSummary, type UserRecord } from './internal.js'
import { getViewerLikedCommentIds } from './comment.js'
import { attachPostViewerFlags, getViewerPostFlags } from './post.js'
import { searchableNovelWhere } from './search.js'
import { activeChapterScope } from './internal.js'



export async function getMePayloadData(userId: string): Promise<UserMePayload> {
  const user = await ensureUserExists(userId)

  const [draftChapters, recentPosts, recentComments, recentConversations, recentCoverAssets, authoredNovels] = await prisma.$transaction([
      prisma.chapter.findMany({
        where: {
          ...activeChapterScope(),
          authorId: userId,
          status: 'draft',
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 6,
      }),
      prisma.post.findMany({
        where: { userId },
        include: postInclude,
        orderBy: [{ createdAt: 'desc' }],
        take: 3,
      }),
      prisma.comment.findMany({
        where: { userId },
        include: commentInclude,
        orderBy: [{ createdAt: 'desc' }],
        take: 3,
      }),
      prisma.conversation.findMany({
        where: {
          members: {
            some: {
              userId,
            },
          },
        },
        include: conversationInclude,
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        take: 3,
      }),
      prisma.coverAsset.findMany({
        where: {
          ownerUserId: userId,
        },
        orderBy: [{ createdAt: 'desc' }],
        take: 1,
      }),
      prisma.novel.findMany({
        where: {
          authorId: userId,
        },
        include: novelInclude,
        orderBy: [{ updatedAt: 'desc' }],
      }),
    ])

  return {
    user: { ...toUser(user), privacy: toPrivacySettings(user) },
    shelf: [],
    drafts: draftChapters.map((chapter) => ({
      id: `draft-${chapter.id}`,
      novelId: chapter.novelId,
      chapterId: chapter.id,
      title: chapter.title,
      summary: chapter.summary ?? '等待继续创作',
      updatedAt: toIso(chapter.updatedAt) ?? nowIso(),
      statusLabel: chapter.status === 'draft' ? '草稿' : chapter.status,
    })),
    activities: [
      ...recentPosts.map((post) => ({
        id: `activity-post-${post.id}`,
        type: 'post',
        title: '发布了动态',
        content: excerptContent(post.content),
        createdAt: toIso(post.createdAt) ?? nowIso(),
      })),
      ...recentComments.map((comment) => ({
        id: `activity-comment-${comment.id}`,
        type: 'comment',
        title: '留下了评论',
        content: excerptContent(comment.content),
        createdAt: toIso(comment.createdAt) ?? nowIso(),
      })),
    ].slice(0, 6),
    notifications: recentComments.map((comment) => ({
      id: `notification-${comment.id}`,
      category: '互动',
      title: '最新评论',
      content: excerptContent(comment.content),
      createdAt: toIso(comment.createdAt) ?? nowIso(),
      read: true,
    })),
    unreadMessageCount: user.unreadMessageCount ?? 0,
    unreadNotificationCount: user.unreadNotificationCount ?? 0,
    recentConversations: recentConversations.map((conversation) => toConversation(conversation, userId)),
    recentCoverAsset: recentCoverAssets[0] ? toCoverAsset(recentCoverAssets[0]) : null,
    authoredNovels: authoredNovels.map((novel) => toNovel(novel, userId)),
    statCards: [
      {
        id: 'stat-novels',
        label: '作品',
        value: String(user.novelCount ?? 0),
      },
      {
        id: 'stat-posts',
        label: '动态',
        value: String(user.postCount ?? 0),
      },
      {
        id: 'stat-messages',
        label: '私信',
        value: String(user.unreadMessageCount ?? 0),
      },
    ],
  }
}



export async function getUserByIdData(userId: string, viewerUserId?: string | null): Promise<User | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    return null
  }

  const payload = toUser(user)

  // 作者主页展示的作品数只统计对外可见的作品，不含草稿/私密/无公开章节的作品
  payload.novelCount = await prisma.novel.count({
    where: { authorId: user.id, ...searchableNovelWhere },
  })

  // 登录态下查看他人主页时，补充“我是否已关注 TA”，驱动关注按钮状态
  if (viewerUserId && viewerUserId !== user.id) {
    const follow = await prisma.userFollow.findUnique({
      where: { followerId_followingId: { followerId: viewerUserId, followingId: user.id } },
      select: { id: true },
    })
    payload.followedByViewer = Boolean(follow)
  }

  // 本人带上隐私设置；任意查看者都带上各隐私区块的可见性，驱动前端隐藏对应入口
  if (viewerUserId === user.id) {
    payload.privacy = toPrivacySettings(user)
  }
  payload.visibility = await resolveProfileVisibility(user, viewerUserId ?? null)

  return payload
}



export async function setUserFollowData(
  viewerUserId: string,
  targetUserId: string,
  following: boolean,
): Promise<{ following: boolean; followerCount: number } | null> {
  await ensureUserExists(viewerUserId)

  if (viewerUserId === targetUserId) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '不能关注自己。')
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } })
  if (!target) {
    return null
  }

  return prisma.$transaction(async (tx) => {
    if (following) {
      const existing = await tx.userFollow.findUnique({
        where: { followerId_followingId: { followerId: viewerUserId, followingId: targetUserId } },
      })
      if (!existing) {
        await tx.userFollow.create({ data: { followerId: viewerUserId, followingId: targetUserId } })
        await tx.user.update({ where: { id: targetUserId }, data: { followerCount: { increment: 1 } } })
        await tx.user.update({ where: { id: viewerUserId }, data: { followingCount: { increment: 1 } } })
      }
    } else {
      const deleted = await tx.userFollow.deleteMany({
        where: { followerId: viewerUserId, followingId: targetUserId },
      })
      if (deleted.count > 0) {
        await tx.user.update({ where: { id: targetUserId }, data: { followerCount: { decrement: 1 } } })
        await tx.user.update({ where: { id: viewerUserId }, data: { followingCount: { decrement: 1 } } })
      }
    }

    const updated = await tx.user.findUnique({ where: { id: targetUserId }, select: { followerCount: true } })
    return { following, followerCount: Math.max(0, updated?.followerCount ?? 0) }
  })
}



const PRIVACY_LEVELS: PrivacyLevel[] = ['public', 'private', 'mutual']

type PrivacyFieldKey = 'privacyFollowers' | 'privacyFollowing' | 'privacyLikes' | 'privacyFavorites' | 'privacyReplies'

type PrivacyFieldsUser = {
  id: string
} & Partial<Record<PrivacyFieldKey, string | null>>

function toPrivacySettings(user: PrivacyFieldsUser): PrivacySettings {
  return {
    followers: (user.privacyFollowers ?? 'public') as PrivacyLevel,
    following: (user.privacyFollowing ?? 'public') as PrivacyLevel,
    likes: (user.privacyLikes ?? 'public') as PrivacyLevel,
    favorites: (user.privacyFavorites ?? 'public') as PrivacyLevel,
    replies: (user.privacyReplies ?? 'public') as PrivacyLevel,
  }
}



/** 互相关注判定：双向 follow 记录都存在 */
async function areMutualFollows(userId: string, viewerUserId: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    prisma.userFollow.findUnique({
      where: { followerId_followingId: { followerId: viewerUserId, followingId: userId } },
      select: { id: true },
    }),
    prisma.userFollow.findUnique({
      where: { followerId_followingId: { followerId: userId, followingId: viewerUserId } },
      select: { id: true },
    }),
  ])
  return Boolean(a && b)
}



function canViewByLevel(level: PrivacyLevel, isSelf: boolean, isMutual: boolean): boolean {
  if (isSelf || level === 'public') {
    return true
  }
  if (level === 'mutual') {
    return isMutual
  }
  return false
}



/** 计算目标用户各隐私区块对查看者的可见性；仅在确实需要时才查互关关系 */
async function resolveProfileVisibility(targetUser: PrivacyFieldsUser, viewerUserId: string | null): Promise<ProfileVisibility> {
  const isSelf = Boolean(viewerUserId && viewerUserId === targetUser.id)
  const settings = toPrivacySettings(targetUser)
  const levels = [settings.followers, settings.following, settings.likes, settings.favorites, settings.replies]
  const needMutual = !isSelf && Boolean(viewerUserId) && levels.includes('mutual')
  const isMutual = needMutual ? await areMutualFollows(targetUser.id, viewerUserId as string) : false

  return {
    followers: canViewByLevel(settings.followers, isSelf, isMutual),
    following: canViewByLevel(settings.following, isSelf, isMutual),
    likes: canViewByLevel(settings.likes, isSelf, isMutual),
    favorites: canViewByLevel(settings.favorites, isSelf, isMutual),
    replies: canViewByLevel(settings.replies, isSelf, isMutual),
  }
}



/** 把一批关注关系记录映射为列表条目，并标记“查看者是否已关注对方/对方是否关注查看者” */
async function toFollowUserItems(
  records: Array<{ createdAt: Date; user: UserRecord }>,
  viewerUserId: string | null,
): Promise<FollowUserItem[]> {
  const userIds = records.map((record) => record.user.id)
  const followedIds = new Set<string>()
  const followerIds = new Set<string>()

  if (viewerUserId && userIds.length > 0) {
    const [followingRows, followerRows] = await Promise.all([
      prisma.userFollow.findMany({
        where: { followerId: viewerUserId, followingId: { in: userIds } },
        select: { followingId: true },
      }),
      prisma.userFollow.findMany({
        where: { followerId: { in: userIds }, followingId: viewerUserId },
        select: { followerId: true },
      }),
    ])
    followingRows.forEach((row) => followedIds.add(row.followingId))
    followerRows.forEach((row) => followerIds.add(row.followerId))
  }

  return records.map((record) => ({
    ...toUserSummary(record.user),
    followerCount: record.user.followerCount ?? 0,
    followedByViewer: followedIds.has(record.user.id),
    followsViewer: followerIds.has(record.user.id),
    followedAt: toIso(record.createdAt) ?? nowIso(),
    presence: isUserOnline(record.user.lastActiveAt) ? ('online' as const) : ('offline' as const),
  }))
}



export async function listUserFollowersData(
  userId: string,
  viewerUserId: string | null,
): Promise<{ items: FollowUserItem[]; total: number; restricted?: boolean }> {
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target) {
    return { items: [], total: 0 }
  }

  // 隐私拦截：目标用户把粉丝列表设为私密/仅互关时，无权查看者拿到 restricted 标记
  const visibility = await resolveProfileVisibility(target, viewerUserId)
  if (!visibility.followers) {
    return { items: [], total: 0, restricted: true }
  }

  const records = await prisma.userFollow.findMany({
    where: { followingId: userId },
    include: { follower: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const items = await toFollowUserItems(
    records.map((record) => ({ createdAt: record.createdAt, user: record.follower })),
    viewerUserId,
  )
  return { items, total: items.length }
}



export async function listUserFollowingData(
  userId: string,
  viewerUserId: string | null,
): Promise<{ items: FollowUserItem[]; total: number; restricted?: boolean }> {
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target) {
    return { items: [], total: 0 }
  }

  const visibility = await resolveProfileVisibility(target, viewerUserId)
  if (!visibility.following) {
    return { items: [], total: 0, restricted: true }
  }

  const records = await prisma.userFollow.findMany({
    where: { followerId: userId },
    include: { following: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const items = await toFollowUserItems(
    records.map((record) => ({ createdAt: record.createdAt, user: record.following })),
    viewerUserId,
  )
  return { items, total: items.length }
}



/** 更新我的隐私设置：只改传入的维度，返回最新全量设置 */
export async function updateMyPrivacyData(
  userId: string,
  input: Partial<PrivacySettings>,
): Promise<PrivacySettings> {
  await ensureUserExists(userId)

  const fieldMap: Record<keyof PrivacySettings, PrivacyFieldKey> = {
    followers: 'privacyFollowers',
    following: 'privacyFollowing',
    likes: 'privacyLikes',
    favorites: 'privacyFavorites',
    replies: 'privacyReplies',
  }

  const data: Partial<Record<PrivacyFieldKey, PrivacyLevel>> = {}
  for (const key of Object.keys(fieldMap) as Array<keyof PrivacySettings>) {
    const value = input[key]
    if (value === undefined) {
      continue
    }
    if (!PRIVACY_LEVELS.includes(value)) {
      throw new DataAccessError(400, 'VALIDATION_ERROR', '隐私级别不合法。')
    }
    data[fieldMap[key]] = value
  }

  if (Object.keys(data).length === 0) {
    const user = await ensureUserExists(userId)
    return toPrivacySettings(user)
  }

  const updated = await prisma.user.update({ where: { id: userId }, data })
  return toPrivacySettings(updated)
}



/** 喜欢列表：用户赞过的帖子，受 favorites 隐私级别管控 */
export async function listUserLikedPostsData(
  userId: string,
  viewerUserId: string | null,
): Promise<{ items: Post[]; total: number; restricted?: boolean }> {
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target) {
    throw new DataAccessError(404, 'USER_NOT_FOUND', '未找到用户。')
  }

  const visibility = await resolveProfileVisibility(target, viewerUserId)
  if (!visibility.favorites) {
    return { items: [], total: 0, restricted: true }
  }

  const records = await prisma.postLike.findMany({
    where: { userId },
    include: { post: { include: postInclude } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const flags = await getViewerPostFlags(viewerUserId, records.map((record) => record.post.id))
  const items = records.map((record) => attachPostViewerFlags(toPost(record.post), flags))
  return { items, total: items.length }
}



/** 收藏的帖子列表：个人收藏夹性质，仅本人可见 */
export async function listUserBookmarkedPostsData(
  userId: string,
  viewerUserId: string | null,
): Promise<{ items: Post[]; total: number; restricted?: boolean }> {
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target) {
    throw new DataAccessError(404, 'USER_NOT_FOUND', '未找到用户。')
  }

  if (!viewerUserId || viewerUserId !== userId) {
    return { items: [], total: 0, restricted: true }
  }

  const records = await prisma.postBookmark.findMany({
    where: { userId },
    include: { post: { include: postInclude } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const flags = await getViewerPostFlags(viewerUserId, records.map((record) => record.post.id))
  const items = records.map((record) => attachPostViewerFlags(toPost(record.post), flags))
  return { items, total: items.length }
}



/** 已回复列表：用户发出的帖子/作品/章节评论，受 replies 隐私级别管控 */
export async function listUserRepliesData(
  userId: string,
  viewerUserId: string | null,
): Promise<{ items: UserReplyItem[]; total: number; restricted?: boolean }> {
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target) {
    throw new DataAccessError(404, 'USER_NOT_FOUND', '未找到用户。')
  }

  const visibility = await resolveProfileVisibility(target, viewerUserId)
  if (!visibility.replies) {
    return { items: [], total: 0, restricted: true }
  }

  const records = await prisma.comment.findMany({
    where: { userId },
    include: {
      post: { select: { id: true, excerpt: true, content: true } },
      novel: { select: { id: true, title: true, displayTitle: true } },
      chapter: {
        select: {
          id: true,
          title: true,
          novelId: true,
          novel: { select: { id: true, title: true, displayTitle: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const likedCommentIds = await getViewerLikedCommentIds(viewerUserId, records.map((record) => record.id))

  const items: UserReplyItem[] = records.map((record) => {
    const novel = record.novel ?? record.chapter?.novel ?? null

    return {
      id: record.id,
      targetType: record.targetType as CommentTargetType,
      content: record.content,
      rating: record.rating ?? null,
      likeCount: record.likeCount ?? 0,
      likedByViewer: likedCommentIds.has(record.id),
      postId: record.postId ?? null,
      novelId: record.novelId ?? record.chapter?.novelId ?? null,
      novelTitle: novel ? resolveEffectiveNovelTitle(novel.title, novel.displayTitle) : null,
      chapterTitle: record.chapter?.title ?? null,
      targetExcerpt: record.post ? record.post.excerpt || excerptContent(record.post.content) : null,
      createdAt: toIso(record.createdAt) ?? nowIso(),
    }
  })

  return { items, total: items.length }
}



export async function listReceivedLikesData(userId: string): Promise<{ items: ReceivedLikeItem[]; total: number }> {
  await ensureUserExists(userId)

  // 别人给我的帖子/评论点的赞：各取最近 100 条后合并按时间降序
  const [postLikes, commentLikes] = await Promise.all([
    prisma.postLike.findMany({
      where: { post: { userId }, userId: { not: userId } },
      include: { user: true, post: { select: { id: true, excerpt: true, content: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.commentLike.findMany({
      where: { comment: { userId }, userId: { not: userId } },
      include: { user: true, comment: { select: { id: true, content: true, postId: true, novelId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ])

  const items: ReceivedLikeItem[] = [
    ...postLikes.map((record) => ({
      id: `post-like-${record.id}`,
      user: toUserSummary(record.user),
      targetType: 'post' as const,
      excerpt: record.post.excerpt || excerptContent(record.post.content),
      postId: record.post.id,
      novelId: null as string | null,
      likedAt: toIso(record.createdAt) ?? nowIso(),
    })),
    ...commentLikes.map((record) => ({
      id: `comment-like-${record.id}`,
      user: toUserSummary(record.user),
      targetType: 'comment' as const,
      excerpt: excerptContent(record.comment.content),
      postId: record.comment.postId ?? null,
      novelId: record.comment.novelId ?? null,
      likedAt: toIso(record.createdAt) ?? nowIso(),
    })),
  ]
    .sort((a, b) => (a.likedAt < b.likedAt ? 1 : -1))
    .slice(0, 100)

  return { items, total: items.length }
}



export async function listInteractionsData(userId: string): Promise<{ items: InteractionItem[]; total: number }> {
  await ensureUserExists(userId)

  // 互动消息全部从现有表派生：赞/收藏/作品评论/章节评论/回复我的评论，各取最近 100 条合并按时间降序
  const [postLikes, commentLikes, favorites, commentRecords, replyRecords] = await Promise.all([
    prisma.postLike.findMany({
      where: { post: { userId }, userId: { not: userId } },
      include: { user: true, post: { select: { id: true, excerpt: true, content: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.commentLike.findMany({
      where: { comment: { userId }, userId: { not: userId } },
      include: { user: true, comment: { select: { id: true, content: true, postId: true, novelId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.novelFavorite.findMany({
      where: { novel: { authorId: userId }, userId: { not: userId } },
      include: { user: true, novel: { select: { id: true, title: true, displayTitle: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.comment.findMany({
      where: {
        userId: { not: userId },
        OR: [
          { targetType: 'novel', novel: { authorId: userId } },
          { targetType: 'chapter', chapter: { authorId: userId } },
          { targetType: 'post', post: { userId } },
        ],
      },
      include: {
        author: true,
        novel: { select: { id: true, title: true, displayTitle: true } },
        chapter: {
          select: {
            id: true,
            title: true,
            novelId: true,
            novel: { select: { id: true, title: true, displayTitle: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    // 回复我的评论：父评论作者是我、非我本人发出；
    // 排除目标内容作者是我的情况（这类已作为作品/章节评论出现在 feed 里，避免重复）
    prisma.comment.findMany({
      where: {
        userId: { not: userId },
        parentId: { not: null },
        parent: { userId },
        NOT: [
          { targetType: 'novel', novel: { authorId: userId } },
          { targetType: 'chapter', chapter: { authorId: userId } },
          { targetType: 'post', post: { userId } },
        ],
      },
      include: {
        author: true,
        // 父评论的段落序号：被回复的段评可直达正文对应段落
        parent: { select: { id: true, paragraphIndex: true } },
        novel: { select: { id: true, title: true, displayTitle: true } },
        chapter: {
          select: {
            id: true,
            title: true,
            novelId: true,
            novel: { select: { id: true, title: true, displayTitle: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ])

  const items: InteractionItem[] = [
    ...postLikes.map((record) => ({
      id: `post-like-${record.id}`,
      user: toUserSummary(record.user),
      kind: 'postLike' as const,
      excerpt: record.post.excerpt || excerptContent(record.post.content),
      postId: record.post.id,
      novelId: null as string | null,
      happenedAt: toIso(record.createdAt) ?? nowIso(),
    })),
    ...commentLikes.map((record) => ({
      id: `comment-like-${record.id}`,
      user: toUserSummary(record.user),
      kind: 'commentLike' as const,
      excerpt: excerptContent(record.comment.content),
      postId: record.comment.postId ?? null,
      novelId: record.comment.novelId ?? null,
      happenedAt: toIso(record.createdAt) ?? nowIso(),
    })),
    ...favorites.map((record) => ({
      id: `novel-favorite-${record.id}`,
      user: toUserSummary(record.user),
      kind: 'novelFavorite' as const,
      excerpt: '',
      postId: null as string | null,
      novelId: record.novel.id,
      novelTitle: resolveEffectiveNovelTitle(record.novel.title, record.novel.displayTitle),
      happenedAt: toIso(record.createdAt) ?? nowIso(),
    })),
    ...commentRecords.map((record) => {
      const isPostComment = record.targetType === 'post'
      const isChapterComment = record.targetType === 'chapter'
      const novelMeta = isChapterComment ? record.chapter?.novel : record.novel
      return {
        id: `comment-${record.id}`,
        user: toUserSummary(record.author),
        kind: (isPostComment
          ? 'postComment'
          : isChapterComment
            ? 'chapterComment'
            : 'novelComment') as InteractionItem['kind'],
        excerpt: excerptContent(record.content),
        rating: record.rating ?? null,
        postId: isPostComment ? record.postId ?? null : null,
        novelId: novelMeta?.id ?? record.novelId ?? record.chapter?.novelId ?? null,
        chapterId: isChapterComment ? record.chapter?.id ?? null : null,
        // 段评带上段落序号：前端直达正文对应段落并高亮
        paragraphIndex: isChapterComment ? record.paragraphIndex ?? null : null,
        novelTitle: novelMeta ? resolveEffectiveNovelTitle(novelMeta.title, novelMeta.displayTitle) : null,
        chapterTitle: isChapterComment ? record.chapter?.title ?? null : null,
        happenedAt: toIso(record.createdAt) ?? nowIso(),
      }
    }),
    ...replyRecords.map((record) => {
      const isChapterReply = record.targetType === 'chapter'
      const novelMeta = isChapterReply ? record.chapter?.novel : record.novel
      return {
        id: `comment-reply-${record.id}`,
        user: toUserSummary(record.author),
        kind: 'commentReply' as const,
        excerpt: excerptContent(record.content),
        rating: null as number | null,
        postId: record.postId ?? null,
        novelId: novelMeta?.id ?? record.novelId ?? record.chapter?.novelId ?? null,
        chapterId: isChapterReply ? record.chapter?.id ?? null : null,
        // 回复本身不记段落，取被回复评论（我的段评）的段落序号用于直达定位
        paragraphIndex: isChapterReply ? record.parent?.paragraphIndex ?? null : null,
        novelTitle: novelMeta ? resolveEffectiveNovelTitle(novelMeta.title, novelMeta.displayTitle) : null,
        chapterTitle: isChapterReply ? record.chapter?.title ?? null : null,
        happenedAt: toIso(record.createdAt) ?? nowIso(),
      }
    }),
  ]
    .sort((a, b) => (a.happenedAt < b.happenedAt ? 1 : -1))
    .slice(0, 100)

  return { items, total: items.length }
}



export async function getInteractionBadgesData(userId: string): Promise<InteractionBadges> {
  const user = await ensureUserExists(userId)
  const interactionsSeenAt = user.interactionsSeenAt ?? null
  const followersSeenAt = user.followersSeenAt ?? null
  const interactionsAfter = interactionsSeenAt ? { createdAt: { gt: interactionsSeenAt } } : {}
  const followersAfter = followersSeenAt ? { createdAt: { gt: followersSeenAt } } : {}

  // 未读数 = 已读水位之后新产生的互动/新粉丝条数，与互动 feed 口径保持一致
  const [postLikeCount, commentLikeCount, favoriteCount, commentCount, replyCount, followerCount] =
    await prisma.$transaction([
      prisma.postLike.count({ where: { post: { userId }, userId: { not: userId }, ...interactionsAfter } }),
      prisma.commentLike.count({ where: { comment: { userId }, userId: { not: userId }, ...interactionsAfter } }),
      prisma.novelFavorite.count({ where: { novel: { authorId: userId }, userId: { not: userId }, ...interactionsAfter } }),
      prisma.comment.count({
        where: {
          userId: { not: userId },
          OR: [
            { targetType: 'novel', novel: { authorId: userId } },
            { targetType: 'chapter', chapter: { authorId: userId } },
            { targetType: 'post', post: { userId } },
          ],
          ...interactionsAfter,
        },
      }),
      prisma.comment.count({
        where: {
          userId: { not: userId },
          parentId: { not: null },
          parent: { userId },
          NOT: [
            { targetType: 'novel', novel: { authorId: userId } },
            { targetType: 'chapter', chapter: { authorId: userId } },
            { targetType: 'post', post: { userId } },
          ],
          ...interactionsAfter,
        },
      }),
      prisma.userFollow.count({ where: { followingId: userId, ...followersAfter } }),
    ])

  return {
    interactionsUnseen: postLikeCount + commentLikeCount + favoriteCount + commentCount + replyCount,
    interactionsSeenAt: toIso(interactionsSeenAt),
    followersUnseen: followerCount,
    followersSeenAt: toIso(followersSeenAt),
  }
}



export async function markInteractionSeenData(
  userId: string,
  target: 'interactions' | 'followers',
): Promise<InteractionBadges> {
  await ensureUserExists(userId)
  await prisma.user.update({
    where: { id: userId },
    data: target === 'interactions' ? { interactionsSeenAt: new Date() } : { followersSeenAt: new Date() },
  })
  return getInteractionBadgesData(userId)
}



export async function registerUserData(input: {
  email?: string
  phone?: string
  nickname?: string
  password?: string
  referralCode?: string
}): Promise<User> {
  const email = input.email?.trim() || undefined
  const phone = input.phone ? normalizePhoneNumber(input.phone) : undefined
  const password = input.password?.trim() ? ensureNonEmptyText(input.password, 'password') : undefined
  const nickname = input.nickname?.trim()
    ? ensureNonEmptyText(input.nickname, 'nickname')
    : await buildAutoNickname({ phone, email })

  if (!email && !phone) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '请至少填写邮箱或手机号。')
  }

  const duplicated = await prisma.user.findFirst({
    where: {
      OR: [
        ...(email ? [{ email }] : []),
        ...(phone ? [{ phone }] : []),
        { nickname },
      ],
    },
  })

  if (duplicated) {
    throw new DataAccessError(409, 'AUTH_ACCOUNT_EXISTS', '该账号或昵称已被使用。')
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email: email ?? null,
        phone: phone ?? null,
        passwordHash: password ? hashPassword(password) : createUnsetPasswordHash(),
        nickname,
        avatarUrl: null,
        bio: null,
        role: 'user',
        isAuthor: false,
      },
    })
    await initializeNewUserCredits(tx, user.id, input.referralCode)
    return user
  })

  return toUser(created)
}



export async function loginUserData(phone: string, password: string): Promise<User | null> {
  const normalizedPhone = normalizePhoneNumber(ensureNonEmptyText(phone, 'phone'))
  const normalizedPassword = ensureNonEmptyText(password, 'password')

  const user = await prisma.user.findFirst({
    where: {
      phone: normalizedPhone,
    },
  })

  if (!user) {
    return null
  }

  if (!verifyPassword(normalizedPassword, user.passwordHash)) {
    return null
  }

  // 存量明文（local:）哈希验证通过后立即升级为 scrypt 重写入库，逐步清退明文存储
  if (isLegacyPasswordHash(user.passwordHash)) {
    void prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: hashPassword(normalizedPassword) } })
      .catch(() => {})
  }

  return toUser(user)
}



export async function getUserByPhoneData(phone: string): Promise<User | null> {
  const user = await prisma.user.findFirst({
    where: {
      phone,
    },
  })

  return user ? toUser(user) : null
}



export async function getUserCredentialData(userId: string): Promise<{ phone: string | null; passwordHash: string | null }> {
  const user = await ensureUserExists(userId)
  return { phone: user.phone, passwordHash: user.passwordHash }
}



export async function updateMyPasswordData(userId: string, password: string): Promise<User> {
  await ensureUserExists(userId)
  const normalizedPassword = ensureNonEmptyText(password, 'password')

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: hashPassword(normalizedPassword),
      // 改密吊销全部旧会话令牌；调用方（路由层）会为当前设备静默重签
      tokenVersion: { increment: 1 },
    },
  })
  evictUserBanCache(userId)

  return toUser(updated)
}



export async function updateMyProfileData(
  userId: string,
  input: {
    nickname: string
    bio?: string
  },
): Promise<User> {
  await ensureUserExists(userId)
  const nickname = ensureNonEmptyText(input.nickname, 'nickname')
  const bio = input.bio?.trim() || null

  const duplicated = await prisma.user.findFirst({
    where: {
      nickname,
      id: {
        not: userId,
      },
    },
  })

  if (duplicated) {
    throw new DataAccessError(409, 'AUTH_ACCOUNT_EXISTS', '该昵称已被使用，请换一个。')
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      nickname,
      bio,
    },
  })

  return toUser(updated)
}



export async function updateMyAvatarData(userId: string, avatarUrl: string | null): Promise<{
  user: User
  previousAvatarUrl: string | null
}> {
  await ensureUserExists(userId)

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      avatarUrl: true,
    },
  })

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      avatarUrl,
    },
  })

  return {
    user: toUser(updated),
    previousAvatarUrl: currentUser?.avatarUrl ?? null,
  }
}



export async function updateMyProfileCoverData(userId: string, profileCoverUrl: string | null): Promise<{
  user: User
  previousProfileCoverUrl: string | null
}> {
  await ensureUserExists(userId)

  const currentUser = (await prisma.user.findUnique({
    where: { id: userId },
    select: {
      profileCoverUrl: true,
    },
  })) as { profileCoverUrl?: string | null } | null

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      profileCoverUrl,
    },
  })

  return {
    user: toUser(updated),
    previousProfileCoverUrl: currentUser?.profileCoverUrl ?? null,
  }
}
