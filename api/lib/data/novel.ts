/**
 * 作品域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import type { Prisma, Visibility as PrismaVisibility } from '@prisma/client'
import type { CreateNovelRequest, Novel, NovelCard, NovelDetailPayload, UpdateNovelRequest, Visibility } from '../../../shared/contracts/index.js'
import { NOVEL_TAG_GROUPS } from '../../../shared/contracts/novel-tags.js'
import { hotScore, RECOMMEND_ALGORITHM_VERSIONS } from '../../../shared/recommend/scoring.js'
import { storeNovelCoverDataUrl, storeNovelCoverFromRemoteUrl } from '../novel-cover-storage.js'
import { DataAccessError, prisma } from '../prisma.js'
import { buildPagination, buildSlug, chapterListItemSelect, commentInclude, ensureNonEmptyText, ensureNovelOwner, ensureUserExists, novelInclude, recalculateNovelStats, toChapterListItem, toComment, toNovel, toNovelCard, toPublishedChapterListItem, toPublishedVolumeListItem, toVolumeListItem } from './internal.js'
import { publicChapterWhere } from './chapter.js'
import { searchableNovelWhere } from './search.js'
import { DEFAULT_VOLUME_TITLE } from './volume.js'
import { activeChapterScope, activeVolumeWhere, updateActiveChapter } from './internal.js'



export async function listNovelsData(
  page: number,
  pageSize: number,
  options?: { authorId?: string; publishedOnly?: boolean; tag?: string },
) {
  const where: Prisma.NovelWhereInput = {}
  if (options?.authorId) {
    where.authorId = options.authorId
  }
  if (options?.publishedOnly) {
    where.visibility = 'public'
    where.status = { in: ['published', 'completed', 'archived'] }
    // 没有任何公开章节的作品不对外展示（例如发布后又全部改成仅自己可见）
    where.chapters = { some: publicChapterWhere }
  }
  if (options?.tag) {
    where.tagNames = { has: options.tag }
  }

  const [items, total] = await prisma.$transaction([
    prisma.novel.findMany({
      include: novelInclude,
      where,
      orderBy: [{ updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.novel.count({ where }),
  ])

  return {
    items: items.map((record) => toNovelCard(record)),
    pagination: buildPagination(page, pageSize, total),
  }
}



export async function getNovelByIdData(novelId: string): Promise<Novel | null> {
  const novel = await prisma.novel.findUnique({
    where: { id: novelId },
    include: novelInclude,
  })

  return novel ? toNovel(novel) : null
}



export async function createNovelData(userId: string, input: CreateNovelRequest): Promise<Novel> {
  await ensureUserExists(userId)
  const baseSlug = buildSlug(input.title)
  // 靠 count 推算后缀会撞车：删过中间的作品后，count+1 可能正好是还存在的 slug（唯一约束报错）。
  // 这里把同前缀的已占用 slug 全拿回来，逐个试到第一个空位为止。
  const occupiedSlugs = new Set(
    (
      await prisma.novel.findMany({
        where: { slug: { startsWith: baseSlug } },
        select: { slug: true },
      })
    ).map((item) => item.slug),
  )
  let slug = baseSlug
  for (let suffix = 2; occupiedSlugs.has(slug); suffix += 1) {
    slug = `${baseSlug}-${suffix}`
  }

  const novel = await prisma.$transaction(async (tx) => {
    const created = await tx.novel.create({
      data: {
        title: ensureNonEmptyText(input.title, 'title'),
        displayTitle: input.displayTitle?.trim() || null,
        slug,
        summary: ensureNonEmptyText(input.summary, 'summary'),
        categoryId: input.categoryId ?? null,
        categoryName: null,
        tagNames: input.tags ?? [],
        visibility: input.visibility ?? 'public',
        status: input.status ?? 'draft',
        authorId: userId,
        publishedAt: input.status === 'published' ? new Date() : null,
      },
      include: novelInclude,
    })

    await tx.user.update({
      where: { id: userId },
      data: {
        novelCount: {
          increment: 1,
        },
      },
    })

    await tx.volume.create({
      data: { novelId: created.id, title: DEFAULT_VOLUME_TITLE, orderIndex: 1 },
    })

    return created
  })

  return toNovel(novel, userId)
}



export async function updateNovelData(
  userId: string,
  novelId: string,
  input: UpdateNovelRequest,
): Promise<Novel | null> {
  await ensureNovelOwner(userId, novelId)

  const existing = await prisma.novel.findUnique({
    where: { id: novelId },
  })

  if (!existing) {
    return null
  }

  const nextTitle = input.title === undefined ? undefined : ensureNonEmptyText(input.title, 'title')
  const inputDisplayTitle = input.displayTitle === undefined ? undefined : input.displayTitle?.trim() || null
  // 各展示端统一优先读 displayTitle（它兼作 title 被占位名回滚时的备份），改书名时若调用方
  // 未显式给出新的展示名、或给出的仍是改名前的旧值，则让 displayTitle 跟随新书名，
  // 否则首页/切换器等会继续显示旧 displayTitle
  const nextDisplayTitle =
    nextTitle !== undefined && (inputDisplayTitle === undefined || inputDisplayTitle === (existing.displayTitle ?? null))
      ? nextTitle
      : inputDisplayTitle

  const updated = await prisma.novel.update({
    where: { id: novelId },
    data: {
      title: nextTitle,
      displayTitle: nextDisplayTitle,
      summary: input.summary === undefined ? undefined : ensureNonEmptyText(input.summary, 'summary'),
      categoryId: input.categoryId === undefined ? undefined : input.categoryId,
      tagNames: input.tags ?? undefined,
      visibility: input.visibility ?? undefined,
      status: input.status ?? undefined,
      pinnedAt: input.pinned === undefined ? undefined : input.pinned ? new Date() : null,
      coverAssetId: input.coverAssetId === undefined ? undefined : input.coverAssetId,
      coverPrompt: input.coverPrompt === undefined ? undefined : input.coverPrompt,
      publishedAt:
        input.status === 'published'
          ? existing.publishedAt ?? new Date()
          : input.status === 'draft'
            ? null
            : undefined,
    },
    include: novelInclude,
  })

  // 封面变更同步云端书架快照：ReadingProgress.coverUrl 是各设备书架的封面来源，
  // 不跟随更新会导致换封面后所有设备的书架继续显示旧路径（旧域名失效即封面消失）
  if (input.coverAssetId !== undefined && input.coverAssetId !== existing.coverAssetId) {
    await prisma.readingProgress.updateMany({
      where: { novelId },
      data: { coverUrl: updated.coverAsset?.imageUrl ?? null },
    })
  }

  return toNovel(updated, userId)
}



export async function publishNovelData(
  userId: string,
  novelId: string,
  chapterIds: string[],
  visibility: Visibility = 'public',
): Promise<{ novel: Novel; publishedChapterIds: string[] } | null> {
  await ensureNovelOwner(userId, novelId)

  const existing = await prisma.novel.findUnique({
    where: { id: novelId },
  })

  if (!existing) {
    return null
  }

  const now = new Date()

  const updated = await prisma.$transaction(async (tx) => {
    if (chapterIds.length > 0) {
      const selectedChapters = await tx.chapter.findMany({
        where: { ...activeChapterScope(novelId), id: { in: chapterIds } },
        select: {
          id: true,
          title: true,
          summary: true,
          content: true,
          wordCount: true,
          revision: true,
          publishedAt: true,
        },
      })
      if (selectedChapters.length !== new Set(chapterIds).size) {
        throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '所选章节已归档、已删除或不属于当前作品，请刷新后重新选择。')
      }
      await Promise.all(
        selectedChapters.map((chapter) =>
          updateActiveChapter(tx, { id: chapter.id, novelId, revision: chapter.revision }, {
            status: 'published',
            visibility,
            publishedTitle: chapter.title,
            publishedSummary: chapter.summary,
            publishedContent: chapter.content,
            publishedWordCount: chapter.wordCount,
            publishedRevision: chapter.revision + 1,
            revision: { increment: 1 },
            publishedAt: chapter.publishedAt ?? now,
          }),
        ),
      )
    }

    // 发布前置校验：作品至少要有一个公开的已发布章节，否则 0 章节/全私密的作品会对外展示空壳
    const publicChapterCount = await tx.chapter.count({
      where: { novelId, ...publicChapterWhere },
    })
    if (publicChapterCount === 0) {
      throw new DataAccessError(
        400,
        'VALIDATION_ERROR',
        '发布失败：请至少选择一个章节并设为公开，读者才能看到这部作品。',
      )
    }

    const novel = await tx.novel.update({
      where: { id: novelId },
      data: {
        status: 'published',
        visibility: existing.visibility === 'private' ? 'public' : undefined,
        publishedAt: existing.publishedAt ?? now,
      },
      include: novelInclude,
    })

    await recalculateNovelStats(tx, novelId)
    return novel
  })

  const { recordWritingSignal } = await import('../agent/writing-experiments.js')
  await recordWritingSignal(userId, novelId, 'chapter_published', chapterIds.length)
  const firstThreePublished = await prisma.chapter.count({ where: { ...activeChapterScope(novelId), orderIndex: { lte: 3 }, status: 'published', publishedContent: { not: null } } })
  if (firstThreePublished >= 3) {
    const passed = await prisma.chapterQualityReport.groupBy({
      by: ['chapterId'],
      where: { userId, novelId, status: { in: ['passed', 'repaired'] }, chapter: { ...activeChapterScope(novelId), orderIndex: { lte: 3 } } },
    })
    const prototype = await prisma.firstThreePrototype.findFirst({ where: { userId, novelId, status: { notIn: ['completed', 'abandoned'] } }, orderBy: { version: 'desc' } })
    if (prototype) await prisma.firstThreePrototype.update({ where: { id: prototype.id }, data: { status: 'completed', completedChapters: 3, passedChapters: Math.min(3, passed.length) } })
    await recordWritingSignal(userId, novelId, 'first_three_published')
  }

  return { novel: toNovel(updated, userId), publishedChapterIds: chapterIds }
}



/** 标签 → 所属分组下标：用于「相似标签」（同组不同名）判定 */
const NOVEL_TAG_GROUP_INDEX = new Map<string, number>()



const RELATED_CANDIDATE_LIMIT = 200


const RELATED_NOVEL_COUNT = 4



type RelatedNovelSignals = {
  authorId: string
  categoryName: string | null
  tagNames: string[]
  likeCount: number
  commentCount: number
  favoriteCount: number
  viewCount: number
  chapterCount: number
  wordCount: number
  lastPublishedAt: Date | null
  updatedAt: Date
}



/** 热度分统一使用 shared/recommend/scoring 纯函数（与首页榜单/客户端同源，方案 Phase 0） */



/** 标签亲和分：同名标签 3 分/个、同分类 2 分、同组相似标签 1 分/个 */
function computeTagAffinity(source: RelatedNovelSignals, candidate: RelatedNovelSignals): number {
  const sourceTags = new Set(source.tagNames)
  const sourceGroups = new Set(
    source.tagNames
      .map((tag) => NOVEL_TAG_GROUP_INDEX.get(tag))
      .filter((index): index is number => index !== undefined),
  )

  let score = 0

  if (source.categoryName && candidate.categoryName && source.categoryName === candidate.categoryName) {
    score += 2
  }

  for (const tag of new Set(candidate.tagNames)) {
    if (sourceTags.has(tag)) {
      score += 3
      continue
    }

    const group = NOVEL_TAG_GROUP_INDEX.get(tag)
    if (group !== undefined && sourceGroups.has(group)) {
      score += 1
    }
  }

  return score
}



/** 相关推荐排序：标签相同/相似且热门 > 标签相同/相似 > 同作者 > 其它，各档内按热度降序 */
function rankRelatedNovels<T extends RelatedNovelSignals & { id: string }>(
  source: RelatedNovelSignals,
  candidates: T[],
): T[] {
  const nowMs = Date.now()

  const scored = candidates.map((candidate) => {
    const affinity = computeTagAffinity(source, candidate)
    const tier = affinity > 0 ? 0 : candidate.authorId === source.authorId ? 1 : 2
    return { candidate, affinity, tier, hot: hotScore(candidate, nowMs) }
  })

  return scored
    .sort((left, right) => {
      if (left.tier !== right.tier) return left.tier - right.tier
      if (right.hot !== left.hot) return right.hot - left.hot
      return right.affinity - left.affinity
    })
    .slice(0, RELATED_NOVEL_COUNT)
    .map((item) => item.candidate)
}



export async function getNovelDetailData(
  novelId: string,
  viewerUserId?: string | null,
): Promise<NovelDetailPayload | null> {
  const novel = await prisma.novel.findUnique({
    where: { id: novelId },
    include: novelInclude,
  })

  if (!novel) {
    return null
  }

  const isOwner = Boolean(viewerUserId && novel.authorId === viewerUserId)

  // 非作者只能看公开的已发布/已完结作品，与首页榜单候选池口径保持一致
  if (!isOwner && (novel.visibility !== 'public' || (novel.status !== 'published' && novel.status !== 'completed'))) {
    return null
  }

  const chapterWhere: Prisma.ChapterWhereInput = isOwner
    ? activeChapterScope(novelId)
    : {
        novelId,
        status: 'published',
        visibility: 'public',
        OR: [{ publishedAt: null }, { publishedAt: { lte: new Date() } }],
      }

  const [chapterRecords, volumeRecords, commentRecords, relatedPoolRecords, authorNovelRecords, authorPublicNovelCount, ratingAggregate] = await prisma.$transaction([
    prisma.chapter.findMany({
      where: chapterWhere,
      select: chapterListItemSelect,
      orderBy: { orderIndex: 'asc' },
    }),
    prisma.volume.findMany({
      where: { novelId, ...(isOwner ? activeVolumeWhere : {}) },
      include: {
        chapters: {
          where: chapterWhere,
          select: { wordCount: true, publishedWordCount: true, publishedRevision: true },
        },
      },
      orderBy: { orderIndex: 'asc' },
    }),
    prisma.comment.findMany({
      where: {
        targetType: 'novel',
        targetId: novelId,
      },
      include: commentInclude,
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    // 相关推荐候选池：按更新时间取近期作品，内存中按标签亲和/热度/同作者分档排序
    prisma.novel.findMany({
      where: {
        id: { not: novelId },
        ...searchableNovelWhere,
      },
      include: novelInclude,
      orderBy: [{ updatedAt: 'desc' }],
      take: RELATED_CANDIDATE_LIMIT,
    }),
    // 同作者作品单独兜底取一份，避免候选池按更新时间截断后漏掉
    prisma.novel.findMany({
      where: {
        id: { not: novelId },
        authorId: novel.authorId,
        ...searchableNovelWhere,
      },
      include: novelInclude,
      orderBy: [{ updatedAt: 'desc' }],
      take: 20,
    }),
    // 作者卡片的「X 部作品」只统计对外可见的作品，与作者主页口径一致
    prisma.novel.count({
      where: { authorId: novel.authorId, ...searchableNovelWhere },
    }),
    // 作品评分聚合：只统计带评星的作品根评论
    prisma.comment.aggregate({
      where: { targetType: 'novel', targetId: novelId, rating: { not: null } },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ])

  const viewerFavorite = viewerUserId
    ? await prisma.novelFavorite.findUnique({
        where: { novelId_userId: { novelId, userId: viewerUserId } },
        select: { id: true },
      })
    : null

  // 合并候选池与同作者兜底后去重，再按分档策略排序取前 4 本
  const relatedCandidates = new Map<string, (typeof relatedPoolRecords)[number]>()
  for (const record of [...relatedPoolRecords, ...authorNovelRecords]) {
    relatedCandidates.set(record.id, record)
  }
  const relatedRecords = rankRelatedNovels(novel, [...relatedCandidates.values()])

  const novelPayload = toNovel(novel, viewerUserId)
  novelPayload.author.novelCount = authorPublicNovelCount
  novelPayload.ratingCount = ratingAggregate._count.rating
  novelPayload.ratingAverage =
    ratingAggregate._avg.rating == null ? null : Math.round(ratingAggregate._avg.rating * 10) / 10
  novelPayload.favoritedByViewer = Boolean(viewerFavorite)

  return {
    novel: novelPayload,
    volumes: volumeRecords.map((volume) =>
      isOwner ? toVolumeListItem(volume) : toPublishedVolumeListItem(volume),
    ),
    chapters: chapterRecords.map((chapter) =>
      isOwner ? toChapterListItem(chapter) : toPublishedChapterListItem(chapter),
    ),
    topComments: commentRecords.map(toComment),
    relatedNovels: relatedRecords.map((record) => toNovelCard(record)),
    /** 相关推荐算法版本（方案 Phase 0） */
    relatedAlgorithmVersion: RECOMMEND_ALGORITHM_VERSIONS.related,
  }
}



/** 封面图若是 base64 data URL 或生图服务远程直链，落盘转为静态文件路径；失败（超限/磁盘异常/下载超时）时保留原值不阻断主流程 */
export async function normalizeCoverImageUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:image/')) {
    try {
      return await storeNovelCoverDataUrl(imageUrl)
    } catch {
      return imageUrl
    }
  }
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    try {
      return await storeNovelCoverFromRemoteUrl(imageUrl)
    } catch {
      return imageUrl
    }
  }
  return imageUrl
}



export async function deleteNovelData(userId: string, novelId: string): Promise<boolean> {
  const existing = await ensureNovelOwner(userId, novelId)

  if (!existing) {
    return false
  }

  await purgeNovelData(novelId, userId)
  return true
}



/** 后台管理删除作品：不做归属校验，级联清理与普通删除一致 */
export async function adminDeleteNovelData(novelId: string): Promise<boolean> {
  const existing = await prisma.novel.findUnique({ where: { id: novelId }, select: { authorId: true } })
  if (!existing) {
    return false
  }

  await purgeNovelData(novelId, existing.authorId)
  return true
}



/** 删除作品核心事务（普通删除与后台管理删除共用） */
async function purgeNovelData(novelId: string, authorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const chapters = await tx.chapter.findMany({
      where: { novelId },
      select: { id: true },
    })
    const chapterIds = chapters.map((chapter) => chapter.id)

    const runs = await tx.agentRun.findMany({
      where: { novelId },
      select: { id: true },
    })
    const runIds = runs.map((run) => run.id)

    if (runIds.length > 0) {
      await tx.projectMemoryEntry.deleteMany({
        where: {
          OR: [{ novelId }, { runId: { in: runIds } }],
        },
      })

      await tx.agentArtifact.deleteMany({
        where: { runId: { in: runIds } },
      })
    } else {
      await tx.projectMemoryEntry.deleteMany({
        where: { novelId },
      })
    }

    await tx.agentRun.deleteMany({
      where: { novelId },
    })
    await tx.agentSession.deleteMany({
      where: { novelId },
    })

    await tx.aiUsageLog.deleteMany({
      where: chapterIds.length > 0 ? { OR: [{ novelId }, { chapterId: { in: chapterIds } }] } : { novelId },
    })

    await tx.comment.deleteMany({
      where: chapterIds.length > 0 ? { OR: [{ novelId }, { chapterId: { in: chapterIds } }] } : { novelId },
    })
    await tx.post.updateMany({
      where: { relatedNovelId: novelId },
      data: { relatedNovelId: null },
    })
    await tx.novel.update({
      where: { id: novelId },
      data: {
        coverAssetId: null,
      },
    })
    await tx.coverAsset.deleteMany({
      where: { novelId },
    })
    await tx.chapter.deleteMany({
      where: { novelId },
    })
    await tx.novel.delete({
      where: { id: novelId },
    })
    await tx.user.update({
      where: { id: authorId },
      data: {
        novelCount: {
          decrement: 1,
        },
      },
    })
  })
}



export async function setNovelFavoriteData(
  userId: string,
  novelId: string,
  favorited: boolean,
): Promise<{ favorited: boolean; favoriteCount: number } | null> {
  await ensureUserExists(userId)
  const novel = await prisma.novel.findUnique({ where: { id: novelId }, select: { id: true } })
  if (!novel) {
    return null
  }

  return prisma.$transaction(async (tx) => {
    if (favorited) {
      const existing = await tx.novelFavorite.findUnique({
        where: { novelId_userId: { novelId, userId } },
      })
      if (!existing) {
        await tx.novelFavorite.create({ data: { novelId, userId } })
        await tx.novel.update({ where: { id: novelId }, data: { favoriteCount: { increment: 1 } } })
      }
    } else {
      const deleted = await tx.novelFavorite.deleteMany({ where: { novelId, userId } })
      if (deleted.count > 0) {
        await tx.novel.update({ where: { id: novelId }, data: { favoriteCount: { decrement: 1 } } })
      }
    }

    const updated = await tx.novel.findUnique({ where: { id: novelId }, select: { favoriteCount: true } })
    return { favorited, favoriteCount: Math.max(0, updated?.favoriteCount ?? 0) }
  })
}



/** 我收藏的作品列表（按收藏时间倒序，只返回仍对外可见的作品） */
export async function listFavoriteNovelsData(userId: string): Promise<NovelCard[]> {
  const favorites = await prisma.novelFavorite.findMany({
    where: { userId, novel: { visibility: 'public' } },
    orderBy: { createdAt: 'desc' },
    include: { novel: { include: novelInclude } },
    take: 100,
  })

  return favorites.map((item) => toNovelCard(item.novel, userId))
}



export function toPrismaVisibility(visibility: Visibility | PrismaVisibility | undefined): PrismaVisibility {
  return (visibility ?? 'public') as PrismaVisibility
}



/** 下架：转私有 + 归档，前台列表/搜索/详情对普通用户不可见 */
export async function takeDownNovelData(novelId: string): Promise<{ title: string; previousVisibility: string } | null> {
  const record = await prisma.novel.findUnique({
    where: { id: novelId },
    select: { id: true, title: true, visibility: true },
  })
  if (!record) {
    return null
  }

  await prisma.novel.update({
    where: { id: novelId },
    data: { visibility: 'private', status: 'archived' },
  })
  return { title: record.title, previousVisibility: record.visibility }
}



/** 恢复上架：转公开 + 发布态 */
export async function restoreNovelData(novelId: string): Promise<{ title: string } | null> {
  const record = await prisma.novel.findUnique({ where: { id: novelId }, select: { id: true, title: true } })
  if (!record) {
    return null
  }

  await prisma.novel.update({
    where: { id: novelId },
    data: { visibility: 'public', status: 'published' },
  })
  return { title: record.title }
}


NOVEL_TAG_GROUPS.forEach((group, index) => {
  for (const tag of group.tags) {
    if (!NOVEL_TAG_GROUP_INDEX.has(tag)) {
      NOVEL_TAG_GROUP_INDEX.set(tag, index)
    }
  }
})
