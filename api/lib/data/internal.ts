/**
 * 跨域共享的数据转换与校验助手
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import type { Prisma } from '@prisma/client'
import type { Chapter, ChapterListItem, Comment, CommentTargetType, Conversation, CoverAsset, Message, MessageCard, Novel, NovelCard, Pagination, Post, TopicSummary, User, UserSummary, Volume, VolumeListItem } from '../../../shared/contracts/index.js'
import { hasConfiguredPassword } from '../password.js'
import { DataAccessError, prisma } from '../prisma.js'

// Creative scope only. Public readers and historical/moderation paths must not
// inherit this predicate: import archival does not unpublish retained snapshots.
export const activeVolumeWhere = { archivedAt: null } satisfies Prisma.VolumeWhereInput

export function activeChapterScope(novelId?: string): Prisma.ChapterWhereInput {
  return {
    ...(novelId === undefined ? {} : { novelId }),
    archivedAt: null,
    volume: { ...activeVolumeWhere, ...(novelId === undefined ? {} : { novelId }) },
  }
}

export function assertActiveWriteCount(count: number, entity: 'chapter' | 'volume') {
  if (count === 1) return
  throw new DataAccessError(409, entity === 'chapter' ? 'CHAPTER_REVISION_CONFLICT' : 'VOLUME_REVISION_CONFLICT',
    '目标已归档或发生变化，请刷新后重试。')
}

/** Guard the mutation itself, including callers that observed the row before import. */
export async function updateActiveChapter(
  tx: Prisma.TransactionClient,
  where: Prisma.ChapterWhereInput & { id: string },
  data: Prisma.ChapterUpdateManyArgs['data'],
) {
  const result = await tx.chapter.updateMany({
    where: { AND: [where, activeChapterScope(typeof where.novelId === 'string' ? where.novelId : undefined)] }, data,
  })
  assertActiveWriteCount(result.count, 'chapter')
}

export async function updateActiveVolume(
  tx: Prisma.TransactionClient,
  where: Prisma.VolumeWhereInput & { id: string },
  data: Prisma.VolumeUpdateManyMutationInput,
) {
  const result = await tx.volume.updateMany({ where: { AND: [where, activeVolumeWhere] }, data })
  assertActiveWriteCount(result.count, 'volume')
}

// 行映射器的最小输入结构：字段以映射器实际访问为准，Prisma 查询结果（含对应 include）天然满足
export type UserRecord = {
  id: string
  nickname: string
  avatarUrl?: string | null
  profileCoverUrl?: string | null
  bio?: string | null
  role: UserSummary['role']
  isAuthor: boolean
  email?: string | null
  phone?: string | null
  passwordHash?: string | null
  followerCount?: number | null
  followingCount?: number | null
  novelCount?: number | null
  postCount?: number | null
  unreadMessageCount?: number | null
  unreadNotificationCount?: number | null
  lastActiveAt?: Date | string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

type NovelRecord = {
  id: string
  title: string
  displayTitle?: string | null
  slug: string
  summary: string
  categoryId?: string | null
  categoryName?: string | null
  tagNames?: string[] | null
  status: Novel['status']
  visibility: Novel['visibility']
  coverAsset?: { imageUrl?: string | null } | null
  coverAssetId?: string | null
  coverPrompt?: string | null
  wordCount?: number | null
  chapterCount?: number | null
  commentCount?: number | null
  favoriteCount?: number | null
  likeCount?: number | null
  viewCount?: number | null
  lastChapterTitle?: string | null
  lastPublishedAt?: Date | string | null
  publishedAt?: Date | string | null
  pinnedAt?: Date | string | null
  author: UserRecord
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

type ChapterRecord = {
  id: string
  novelId: string
  authorId: string
  title: string
  summary?: string | null
  // 列表查询（chapterListItemSelect）不含 content，仅章节数据携带
  content?: string
  orderIndex: number
  volumeId: string
  orderInVolume: number
  wordCount?: number | null
  status: Chapter['status']
  visibility: Chapter['visibility']
  commentCount?: number | null
  revision?: number | null
  publishedTitle?: string | null
  publishedSummary?: string | null
  publishedContent?: string | null
  publishedWordCount?: number | null
  publishedRevision?: number | null
  publishedAt?: Date | string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

type VolumeRecord = {
  id: string
  novelId: string
  title: string
  summary?: string | null
  orderIndex: number
  revision?: number | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
  _count?: { chapters?: number | null } | null
  chapters?: Array<{
    wordCount?: number | null
    publishedWordCount?: number | null
    publishedRevision?: number | null
  }> | null
}

type CommentRecord = {
  id: string
  targetType: Comment['targetType']
  targetId: string
  parentId?: string | null
  rootId?: string | null
  content: string
  rating?: number | null
  paragraphIndex?: number | null
  likeCount?: number | null
  replyCount?: number | null
  auditStatus: Comment['auditStatus']
  author: { id: string; nickname: string; avatarUrl?: string | null }
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

type TopicRecord = {
  id: string
  name: string
  slug: string
  postCount?: number | null
}

type PostRecord = {
  id: string
  content: string
  excerpt: string
  topic?: TopicRecord | null
  imageUrls?: string[] | null
  relatedNovel?: { id: string; title: string; coverAsset?: { imageUrl?: string | null } | null } | null
  sharedUser?: { id: string; nickname: string; avatarUrl?: string | null; bio?: string | null } | null
  likeCount?: number | null
  commentCount?: number | null
  favoriteCount?: number | null
  auditStatus: Post['auditStatus']
  author: { id: string; nickname: string; avatarUrl?: string | null }
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

type ConversationMemberRecord = {
  lastReadAt?: Date | string | null
  user: { id: string; nickname: string; avatarUrl?: string | null; lastActiveAt?: Date | string | null }
}

type ConversationRecord = {
  id: string
  type: Conversation['type']
  title?: string | null
  avatarUrl?: string | null
  unreadCount?: number | null
  lastMessagePreview?: string | null
  lastMessageAt?: Date | string | null
  members?: ConversationMemberRecord[] | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

type MessageRecord = {
  id: string
  conversationId: string
  senderId: string
  type: Message['type']
  content: string
  relatedId?: string | null
  createdAt?: Date | string | null
}

type CoverAssetRecord = {
  id: string
  novelId?: string | null
  ownerUserId: string
  sourceType: CoverAsset['sourceType']
  imageUrl: string
  prompt?: string | null
  negativePrompt?: string | null
  modelName?: string | null
  width?: number | null
  height?: number | null
  createdAt?: Date | string | null
}



export const novelInclude = {
  author: true,
  coverAsset: true,
} satisfies Prisma.NovelInclude



export const postInclude = {
  author: true,
  topic: true,
  relatedNovel: {
    include: {
      coverAsset: true,
      author: true,
    },
  },
  sharedUser: true,
} satisfies Prisma.PostInclude



export const commentInclude = {
  author: true,
} satisfies Prisma.CommentInclude



export const conversationInclude = {
  members: {
    include: {
      user: true,
    },
  },
} satisfies Prisma.ConversationInclude



export function nowIso(): string {
  return new Date().toISOString()
}



// 在线判定：最近 5 分钟内有过带登录态请求（app 层中间件刷新 lastActiveAt）即视为在线
const ONLINE_WINDOW_MS = 5 * 60 * 1000



export function isUserOnline(lastActiveAt: Date | string | null | undefined): boolean {
  if (!lastActiveAt) {
    return false
  }
  return Date.now() - new Date(lastActiveAt).getTime() <= ONLINE_WINDOW_MS
}



export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null
  }

  return typeof value === 'string' ? value : value.toISOString()
}



export function buildPagination(page: number, pageSize: number, total: number): Pagination {
  return {
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
  }
}



export function excerptContent(content: string): string {
  const normalized = content.trim()

  if (normalized.length <= 120) {
    return normalized
  }

  return `${normalized.slice(0, 117)}...`
}



export function buildSlug(title: string): string {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || `novel-${Date.now()}`
}



export function toUserSummary(user: UserRecord): UserSummary {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl ?? null,
    profileCoverUrl: user.profileCoverUrl ?? null,
    bio: user.bio ?? null,
    role: user.role,
    isAuthor: user.isAuthor,
  }
}



export function toUser(user: UserRecord): User {
  return {
    ...toUserSummary(user),
    email: user.email ?? null,
    phone: user.phone ?? null,
    passwordConfigured: hasConfiguredPassword(user.passwordHash),
    followerCount: user.followerCount ?? 0,
    followingCount: user.followingCount ?? 0,
    novelCount: user.novelCount ?? 0,
    postCount: user.postCount ?? 0,
    unreadMessageCount: user.unreadMessageCount ?? 0,
    unreadNotificationCount: user.unreadNotificationCount ?? 0,
    createdAt: toIso(user.createdAt) ?? nowIso(),
    updatedAt: toIso(user.updatedAt) ?? nowIso(),
  }
}



function toAuthorSummary(user: UserRecord, viewerUserId?: string | null) {
  return {
    ...toUserSummary(user),
    followerCount: user.followerCount ?? 0,
    novelCount: user.novelCount ?? 0,
    isFollowed: Boolean(viewerUserId && viewerUserId !== user.id),
  }
}



// 历史自动保存回滚 bug 曾把 title 覆盖回占位默认值，而 displayTitle 里仍保留真实书名；
// 读取时统一归一化，避免作者页/卡片等直接读 title 的地方显示“未命名作品”
export const PLACEHOLDER_NOVEL_TITLES = new Set(['未命名作品', '我的第一部作品'])



export function resolveEffectiveNovelTitle(title: string, displayTitle?: string | null): string {
  const display = displayTitle?.trim()
  if (display && PLACEHOLDER_NOVEL_TITLES.has(title.trim())) {
    return display
  }
  return title
}



export function toNovel(record: NovelRecord, viewerUserId?: string | null): Novel {
  return {
    id: record.id,
    title: resolveEffectiveNovelTitle(record.title, record.displayTitle),
    displayTitle: record.displayTitle ?? null,
    slug: record.slug,
    summary: record.summary,
    categoryId: record.categoryId ?? null,
    categoryName: record.categoryName ?? null,
    tags: record.tagNames ?? [],
    status: record.status,
    visibility: record.visibility,
    coverUrl: record.coverAsset?.imageUrl ?? null,
    coverAssetId: record.coverAssetId ?? null,
    coverPrompt: record.coverPrompt ?? null,
    wordCount: record.wordCount ?? 0,
    chapterCount: record.chapterCount ?? 0,
    commentCount: record.commentCount ?? 0,
    favoriteCount: record.favoriteCount ?? 0,
    likeCount: record.likeCount ?? 0,
    viewCount: record.viewCount ?? 0,
    lastChapterTitle: record.lastChapterTitle ?? null,
    lastPublishedAt: toIso(record.lastPublishedAt),
    publishedAt: toIso(record.publishedAt),
    pinnedAt: toIso(record.pinnedAt),
    author: toAuthorSummary(record.author, viewerUserId),
    createdAt: toIso(record.createdAt) ?? nowIso(),
    updatedAt: toIso(record.updatedAt) ?? nowIso(),
  }
}



export function toNovelCard(record: NovelRecord, viewerUserId?: string | null): NovelCard {
  const novel = toNovel(record, viewerUserId)

  return {
    id: novel.id,
    title: novel.title,
    displayTitle: novel.displayTitle,
    slug: novel.slug,
    summary: novel.summary,
    tags: novel.tags,
    status: novel.status,
    coverUrl: novel.coverUrl,
    wordCount: novel.wordCount,
    chapterCount: novel.chapterCount,
    lastPublishedAt: novel.lastPublishedAt,
    publishedAt: novel.publishedAt,
    viewCount: novel.viewCount,
    likeCount: novel.likeCount,
    favoriteCount: novel.favoriteCount,
    commentCount: novel.commentCount,
    updatedAt: novel.updatedAt,
    author: {
      id: novel.author.id,
      nickname: novel.author.nickname,
      avatarUrl: novel.author.avatarUrl,
    },
  }
}



export function toChapter(record: ChapterRecord): Chapter {
  return {
    id: record.id,
    novelId: record.novelId,
    authorId: record.authorId,
    title: record.title,
    summary: record.summary ?? null,
    content: record.content ?? '',
    orderIndex: record.orderIndex,
    volumeId: record.volumeId,
    orderInVolume: record.orderInVolume,
    wordCount: record.wordCount ?? 0,
    status: record.status,
    visibility: record.visibility,
    commentCount: record.commentCount ?? 0,
    revision: record.revision ?? 1,
    publishedRevision: record.publishedRevision ?? null,
    publishedAt: toIso(record.publishedAt),
    createdAt: toIso(record.createdAt) ?? nowIso(),
    updatedAt: toIso(record.updatedAt) ?? nowIso(),
  }
}



export function toChapterListItem(record: ChapterRecord): ChapterListItem {
  const chapter = toChapter(record)

  return {
    id: chapter.id,
    novelId: chapter.novelId,
    title: chapter.title,
    summary: chapter.summary,
    orderIndex: chapter.orderIndex,
    volumeId: chapter.volumeId,
    orderInVolume: chapter.orderInVolume,
    wordCount: chapter.wordCount,
    status: chapter.status,
    visibility: chapter.visibility,
    commentCount: chapter.commentCount,
    revision: chapter.revision,
    publishedRevision: chapter.publishedRevision,
    publishedAt: chapter.publishedAt,
  }
}

/** 阅读侧只消费最近一次显式发布的不可变快照；历史数据无快照时兼容回退到当前字段。 */
export function toPublishedChapter(record: ChapterRecord): Chapter {
  const chapter = toChapter(record)
  if (record.status !== 'published' || record.publishedRevision == null) {
    return chapter
  }
  return {
    ...chapter,
    title: record.publishedTitle ?? chapter.title,
    summary: record.publishedSummary ?? null,
    content: record.publishedContent ?? '',
    wordCount: record.publishedWordCount ?? 0,
    revision: record.publishedRevision,
  }
}

export function toPublishedChapterListItem(record: ChapterRecord): ChapterListItem {
  const chapter = toPublishedChapter(record)
  return {
    id: chapter.id,
    novelId: chapter.novelId,
    title: chapter.title,
    summary: chapter.summary,
    orderIndex: chapter.orderIndex,
    volumeId: chapter.volumeId,
    orderInVolume: chapter.orderInVolume,
    wordCount: chapter.wordCount,
    status: chapter.status,
    visibility: chapter.visibility,
    commentCount: chapter.commentCount,
    revision: chapter.revision,
    publishedRevision: chapter.publishedRevision,
    publishedAt: chapter.publishedAt,
  }
}



// 章节列表只需要元数据：排除 content，避免把整本书的正文从数据库拉出来拖慢接口
export const chapterListItemSelect = {
  id: true,
  novelId: true,
  authorId: true,
  title: true,
  summary: true,
  orderIndex: true,
  volumeId: true,
  orderInVolume: true,
  wordCount: true,
  status: true,
  visibility: true,
  commentCount: true,
  revision: true,
  publishedTitle: true,
  publishedSummary: true,
  publishedWordCount: true,
  publishedRevision: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChapterSelect

export function toVolume(record: VolumeRecord): Volume {
  return {
    id: record.id,
    novelId: record.novelId,
    title: record.title,
    summary: record.summary ?? null,
    orderIndex: record.orderIndex,
    revision: record.revision ?? 1,
    createdAt: toIso(record.createdAt) ?? nowIso(),
    updatedAt: toIso(record.updatedAt) ?? nowIso(),
  }
}

export function toVolumeListItem(record: VolumeRecord): VolumeListItem {
  const volume = toVolume(record)
  return {
    id: volume.id,
    novelId: volume.novelId,
    title: volume.title,
    summary: volume.summary,
    orderIndex: volume.orderIndex,
    revision: volume.revision,
    chapterCount: record._count?.chapters ?? record.chapters?.length ?? 0,
    wordCount: record.chapters?.reduce((total, chapter) => total + (chapter.wordCount ?? 0), 0) ?? 0,
  }
}

/** 非作者目录中的卷统计同样锁定在最近一次发布快照，避免创作稿字数提前泄露。 */
export function toPublishedVolumeListItem(record: VolumeRecord): VolumeListItem {
  return toVolumeListItem({
    ...record,
    chapters: record.chapters?.map((chapter) => ({
      wordCount:
        chapter.publishedRevision == null
          ? chapter.wordCount
          : chapter.publishedWordCount ?? 0,
    })),
  })
}

export const volumeListItemInclude = {
  _count: { select: { chapters: { where: activeChapterScope() } } },
  chapters: { where: activeChapterScope(), select: { wordCount: true } },
} satisfies Prisma.VolumeInclude



export function toComment(record: CommentRecord): Comment {
  return {
    id: record.id,
    targetType: record.targetType,
    targetId: record.targetId,
    parentId: record.parentId ?? null,
    rootId: record.rootId ?? null,
    content: record.content,
    rating: record.rating ?? null,
    paragraphIndex: record.paragraphIndex ?? null,
    likeCount: record.likeCount ?? 0,
    replyCount: record.replyCount ?? 0,
    auditStatus: record.auditStatus,
    author: {
      id: record.author.id,
      nickname: record.author.nickname,
      avatarUrl: record.author.avatarUrl ?? null,
    },
    createdAt: toIso(record.createdAt) ?? nowIso(),
    updatedAt: toIso(record.updatedAt) ?? nowIso(),
  }
}



export function toTopic(record: TopicRecord): TopicSummary {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    postCount: record.postCount ?? 0,
  }
}



export function toPost(record: PostRecord): Post {
  return {
    id: record.id,
    content: record.content,
    excerpt: record.excerpt,
    topic: record.topic ? toTopic(record.topic) : null,
    imageUrls: record.imageUrls ?? [],
    relatedNovel: record.relatedNovel
      ? {
          id: record.relatedNovel.id,
          title: record.relatedNovel.title,
          coverUrl: record.relatedNovel.coverAsset?.imageUrl ?? null,
        }
      : null,
    sharedUser: record.sharedUser
      ? {
          id: record.sharedUser.id,
          nickname: record.sharedUser.nickname,
          avatarUrl: record.sharedUser.avatarUrl ?? null,
          bio: record.sharedUser.bio ?? null,
        }
      : null,
    likeCount: record.likeCount ?? 0,
    commentCount: record.commentCount ?? 0,
    favoriteCount: record.favoriteCount ?? 0,
    auditStatus: record.auditStatus,
    author: {
      id: record.author.id,
      nickname: record.author.nickname,
      avatarUrl: record.author.avatarUrl ?? null,
    },
    createdAt: toIso(record.createdAt) ?? nowIso(),
    updatedAt: toIso(record.updatedAt) ?? nowIso(),
  }
}



export function toConversation(record: ConversationRecord, viewerUserId: string): Conversation {
  const members = (record.members ?? []).map((member: ConversationMemberRecord) => ({
    id: member.user.id,
    nickname: member.user.nickname,
    avatarUrl: member.user.avatarUrl ?? null,
    // 成员维度的会话已读时间：前端据此判断自己发的消息对方是否已读
    lastReadAt: toIso(member.lastReadAt),
  }))
  const counterpart = members.find((member) => member.id !== viewerUserId) ?? members[0] ?? null
  // 直聊会话的在线状态取自对方的最近活跃时间
  const counterpartUser =
    (record.members ?? []).find((member: ConversationMemberRecord) => member.user.id !== viewerUserId)?.user ?? null

  return {
    id: record.id,
    type: record.type,
    // 直聊会话未设标题/头像时，回退到对方昵称与头像，保证双方视角各自正确
    title: record.title ?? (record.type === 'direct' ? counterpart?.nickname ?? null : null),
    avatarUrl: record.avatarUrl ?? (record.type === 'direct' ? counterpart?.avatarUrl ?? null : null),
    unreadCount: record.unreadCount ?? 0,
    lastMessagePreview: record.lastMessagePreview ?? null,
    lastMessageAt: toIso(record.lastMessageAt),
    members,
    counterpart,
    presence: record.type === 'direct' && isUserOnline(counterpartUser?.lastActiveAt) ? 'online' : 'offline',
    createdAt: toIso(record.createdAt) ?? nowIso(),
    updatedAt: toIso(record.updatedAt) ?? nowIso(),
  }
}



/** 给直聊会话回填与对方的关注关系标记；未互关的会话在前端归入「陌生消息」 */
export async function attachDirectFollowRelations(conversations: Conversation[], viewerUserId: string): Promise<Conversation[]> {
  const counterpartIds = conversations
    .filter((item) => item.type === 'direct' && item.counterpart && item.counterpart.id !== viewerUserId)
    .map((item) => String(item.counterpart!.id))

  if (counterpartIds.length === 0) {
    return conversations
  }

  const [followingRecords, followerRecords] = await Promise.all([
    prisma.userFollow.findMany({
      where: { followerId: viewerUserId, followingId: { in: counterpartIds } },
      select: { followingId: true },
    }),
    prisma.userFollow.findMany({
      where: { followerId: { in: counterpartIds }, followingId: viewerUserId },
      select: { followerId: true },
    }),
  ])

  const followingIds = new Set(followingRecords.map((record) => record.followingId))
  const followerIds = new Set(followerRecords.map((record) => record.followerId))

  return conversations.map((item) => {
    if (item.type !== 'direct' || !item.counterpart || item.counterpart.id === viewerUserId) {
      return item
    }

    const viewerFollowsCounterpart = followingIds.has(String(item.counterpart.id))
    const counterpartFollowsViewer = followerIds.has(String(item.counterpart.id))

    return {
      ...item,
      viewerFollowsCounterpart,
      counterpartFollowsViewer,
      isMutualFollow: viewerFollowsCounterpart && counterpartFollowsViewer,
    }
  })
}



export function toMessage(record: MessageRecord): Message {
  return {
    id: record.id,
    conversationId: record.conversationId,
    senderId: record.senderId,
    type: record.type,
    content: record.content,
    relatedId: record.relatedId ?? null,
    createdAt: toIso(record.createdAt) ?? nowIso(),
  }
}



/** 给卡片消息批量回填富数据（封面/标题/简介等）；源内容已删除时 card 保持 null，前端降级为文本气泡 */
export async function attachMessageCards(messages: Message[]): Promise<Message[]> {
  const novelIds = new Set<string>()
  const postIds = new Set<string>()
  const authorIds = new Set<string>()
  const commentIds = new Set<string>()

  for (const message of messages) {
    if (!message.relatedId) continue
    if (message.type === 'novelCard') novelIds.add(message.relatedId)
    else if (message.type === 'postCard') postIds.add(message.relatedId)
    else if (message.type === 'authorCard') authorIds.add(message.relatedId)
    else if (message.type === 'commentCard') commentIds.add(message.relatedId)
  }

  if (novelIds.size === 0 && postIds.size === 0 && authorIds.size === 0 && commentIds.size === 0) {
    return messages
  }

  const [novels, posts, authors, comments] = await Promise.all([
    novelIds.size
      ? prisma.novel.findMany({
          where: { id: { in: [...novelIds] } },
          select: {
            id: true,
            title: true,
            displayTitle: true,
            summary: true,
            coverAsset: { select: { imageUrl: true } },
            author: { select: { nickname: true } },
          },
        })
      : Promise.resolve([]),
    postIds.size
      ? prisma.post.findMany({
          where: { id: { in: [...postIds] } },
          select: {
            id: true,
            excerpt: true,
            content: true,
            imageUrls: true,
            author: { select: { nickname: true, avatarUrl: true } },
          },
        })
      : Promise.resolve([]),
    authorIds.size
      ? prisma.user.findMany({
          where: { id: { in: [...authorIds] } },
          select: {
            id: true,
            nickname: true,
            avatarUrl: true,
            bio: true,
            followerCount: true,
            novelCount: true,
          },
        })
      : Promise.resolve([]),
    commentIds.size
      ? prisma.comment.findMany({
          where: { id: { in: [...commentIds] } },
          select: {
            id: true,
            content: true,
            postId: true,
            novelId: true,
            author: { select: { nickname: true, avatarUrl: true } },
          },
        })
      : Promise.resolve([]),
  ])

  const cardByRelatedId = new Map<string, MessageCard>()
  for (const novel of novels) {
    cardByRelatedId.set(novel.id, {
      kind: 'novel',
      id: novel.id,
      title: resolveEffectiveNovelTitle(novel.title, novel.displayTitle),
      coverUrl: novel.coverAsset?.imageUrl ?? null,
      summary: novel.summary,
      authorName: novel.author.nickname,
    })
  }
  for (const post of posts) {
    cardByRelatedId.set(post.id, {
      kind: 'post',
      id: post.id,
      excerpt: post.excerpt || post.content.slice(0, 120),
      imageUrl: post.imageUrls[0] ?? null,
      authorName: post.author.nickname,
      authorAvatarUrl: post.author.avatarUrl ?? null,
    })
  }
  for (const author of authors) {
    cardByRelatedId.set(author.id, {
      kind: 'author',
      id: author.id,
      nickname: author.nickname,
      avatarUrl: author.avatarUrl ?? null,
      bio: author.bio ?? null,
      followerCount: author.followerCount ?? 0,
      novelCount: author.novelCount ?? 0,
    })
  }
  for (const comment of comments) {
    cardByRelatedId.set(comment.id, {
      kind: 'comment',
      id: comment.id,
      content: comment.content,
      authorName: comment.author.nickname,
      authorAvatarUrl: comment.author.avatarUrl ?? null,
      postId: comment.postId ?? null,
      novelId: comment.novelId ?? null,
    })
  }

  return messages.map((message) => {
    if (
      message.type !== 'novelCard' &&
      message.type !== 'postCard' &&
      message.type !== 'authorCard' &&
      message.type !== 'commentCard'
    ) {
      return message
    }
    return { ...message, card: (message.relatedId && cardByRelatedId.get(message.relatedId)) || null }
  })
}



export function toCoverAsset(record: CoverAssetRecord): CoverAsset {
  return {
    id: record.id,
    novelId: record.novelId ?? null,
    ownerUserId: record.ownerUserId,
    sourceType: record.sourceType,
    imageUrl: record.imageUrl,
    prompt: record.prompt ?? null,
    negativePrompt: record.negativePrompt ?? null,
    modelName: record.modelName ?? null,
    width: record.width ?? null,
    height: record.height ?? null,
    createdAt: toIso(record.createdAt) ?? nowIso(),
  }
}



export function ensureNonEmptyText(value: string, field: string): string {
  const normalized = value.trim()

  if (!normalized) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', `${field}不能为空。`)
  }

  return normalized
}



async function buildAvailableNickname(baseNickname: string): Promise<string> {
  const normalizedBase = ensureNonEmptyText(baseNickname, 'nickname')
  const duplicateCount = await prisma.user.count({
    where: {
      nickname: {
        startsWith: normalizedBase,
      },
    },
  })

  return duplicateCount === 0 ? normalizedBase : `${normalizedBase}${duplicateCount + 1}`
}



export async function buildAutoNickname(input: { phone?: string; email?: string }): Promise<string> {
  const phoneDigits = input.phone?.replace(/\D/g, '') ?? ''
  const emailPrefix = input.email?.split('@')[0]?.trim() ?? ''

  if (phoneDigits.length >= 4) {
    return buildAvailableNickname(`书友${phoneDigits.slice(-4)}`)
  }

  if (emailPrefix) {
    return buildAvailableNickname(emailPrefix.slice(0, 12))
  }

  return buildAvailableNickname(`书友${Date.now().toString().slice(-6)}`)
}



export async function ensureUserExists(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new DataAccessError(401, 'AUTH_INVALID_SESSION', '登录状态已失效，请重新登录。')
  }

  return user
}



export async function ensureNovelOwner(userId: string, novelId: string, transaction: Prisma.TransactionClient = prisma) {
  const novel = await transaction.novel.findUnique({
    where: { id: novelId },
    include: novelInclude,
  })

  if (!novel) {
    throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '未找到对应作品。')
  }

  if (novel.authorId !== userId) {
    throw new DataAccessError(403, 'NOVEL_FORBIDDEN', '当前账号无权访问该作品。')
  }

  return novel
}



export async function ensureConversationMember(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: conversationInclude,
  })

  if (!conversation) {
    throw new DataAccessError(404, 'CONVERSATION_NOT_FOUND', '未找到会话。')
  }

  const isMember = conversation.members.some((member) => member.userId === userId)
  if (!isMember) {
    throw new DataAccessError(403, 'CONVERSATION_FORBIDDEN', '当前账号无权访问该会话。')
  }

  return conversation
}



export async function recalculateNovelStats(tx: Prisma.TransactionClient, novelId: string) {
  const chapters = await tx.chapter.findMany({
    where: activeChapterScope(novelId),
    orderBy: { orderIndex: 'asc' },
  })

  const latestChapter = chapters[chapters.length - 1] ?? null
  // Preserve the existing publication-date/order semantics across both active
  // and archived records; replacing the creative draft must not clear this date.
  const latestPublished = await tx.chapter.findFirst({
    where: { novelId, status: 'published', publishedAt: { not: null } },
    orderBy: { orderIndex: 'desc' },
    select: { publishedAt: true },
  })

  const wordCount = chapters.reduce((total, chapter) => total + (chapter.wordCount ?? 0), 0)

  await tx.novel.update({
    where: { id: novelId },
    data: {
      chapterCount: chapters.length,
      wordCount,
      lastChapterTitle: latestChapter?.title ?? null,
      lastPublishedAt: latestPublished?.publishedAt ?? null,
    },
  })
}



export function buildCommentTargetIds(targetType: CommentTargetType, targetId: string): {
  novelId: string | null
  chapterId: string | null
  postId: string | null
} {
  if (targetType === 'novel') {
    return { novelId: targetId, chapterId: null, postId: null }
  }

  if (targetType === 'chapter') {
    return { novelId: null, chapterId: targetId, postId: null }
  }

  return { novelId: null, chapterId: null, postId: targetId }
}



export function clampPercent(value: number | undefined | null): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
