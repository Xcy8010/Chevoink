/**
 * 首页聚合域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import type { NovelCard } from '../../../shared/contracts/index.js'
import { hotScore, totalScore, RECOMMEND_ALGORITHM_VERSIONS } from '../../../shared/recommend/scoring.js'
import { prisma } from '../prisma.js'
import { novelInclude, postInclude, toNovelCard, toPost, toTopic } from './internal.js'
import { attachPostViewerFlags, computePostRecommendScore, getViewerPostFlags } from './post.js'
import { searchableNovelWhere } from './search.js'



async function buildHomePayload() {
  const [recentPool, popularPool, hotTopics, hotPostRecords] = await prisma.$transaction([
    // 候选池通道一：最近更新作品
    prisma.novel.findMany({
      include: novelInclude,
      where: searchableNovelWhere,
      orderBy: [{ lastPublishedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
    }),
    // 候选池通道二：历史热门作品（修复旧版只按更新取 120 本时，热门但久未更新作品进不了首页推荐位）
    prisma.novel.findMany({
      include: novelInclude,
      where: searchableNovelWhere,
      orderBy: [{ viewCount: 'desc' }, { favoriteCount: 'desc' }],
      take: 200,
    }),
    prisma.topic.findMany({
      orderBy: [{ postCount: 'desc' }, { name: 'asc' }],
      take: 8,
    }),
    prisma.post.findMany({
      include: postInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    }),
  ])

  // 双通道去重合并，候选池覆盖「近期更新 ∪ 历史热门」，逼近全量作品语义（推荐算法优化方案 Phase 0）
  const poolById = new Map<string, (typeof recentPool)[number]>()
  for (const record of [...recentPool, ...popularPool]) {
    if (!poolById.has(record.id)) poolById.set(record.id, record)
  }
  const cards = [...poolById.values()].map((record) => toNovelCard(record))
  const now = Date.now()

  // 热度分/累计口碑分统一使用 shared/recommend/scoring 纯函数（客户端同源，消除权重漂移）

  const rankingHot = [...cards].sort((left, right) => hotScore(right, now) - hotScore(left, now)).slice(0, 10)
  const rankingNew = [...cards]
    .sort(
      (left, right) =>
        new Date(right.publishedAt ?? right.updatedAt).getTime() - new Date(left.publishedAt ?? left.updatedAt).getTime(),
    )
    .slice(0, 10)
  const finished = cards.filter((novel) => novel.status === 'completed')
  const rankingFinished = finished.sort((left, right) => totalScore(right) - totalScore(left)).slice(0, 10)

  const latestUpdated = [...cards]
    .sort(
      (left, right) =>
        new Date(right.lastPublishedAt ?? right.updatedAt).getTime() - new Date(left.lastPublishedAt ?? left.updatedAt).getTime(),
    )
    .slice(0, 8)

  // 热门讨论：与社区推荐流同一套打分，服务端即唯一排序来源（方案 18 §2.3）
  const hotPosts = hotPostRecords
    .map((record) => ({ record, score: computePostRecommendScore(record, now) }))
    .sort((a, b) => b.score - a.score || b.record.createdAt.getTime() - a.record.createdAt.getTime())
    .slice(0, 8)
    .map((entry) => toPost(entry.record))

  return {
    /** 推荐算法版本（方案 Phase 0）：曝光归因与结果解释用 */
    algorithmVersion: RECOMMEND_ALGORITHM_VERSIONS.home,
    continueReading: latestUpdated.slice(0, 1),
    recommendedNovels: rankingHot.slice(0, 8),
    latestUpdatedNovels: latestUpdated,
    rankingHot,
    rankingNew,
    rankingFinished,
    hotTopics: hotTopics.map(toTopic),
    hotPosts,
  }
}



/** 首页榜单 60s 内存缓存：只缓存与 viewer 无关的基础 payload，viewer flags 每请求另行附加 */
const HOME_PAYLOAD_CACHE_TTL_MS = 60_000


let homePayloadCache: { payload: Awaited<ReturnType<typeof buildHomePayload>>; expiresAt: number } | null = null



export async function getHomePayloadData(viewerUserId?: string | null) {
  const nowMs = Date.now()
  if (!homePayloadCache || homePayloadCache.expiresAt <= nowMs) {
    homePayloadCache = { payload: await buildHomePayload(), expiresAt: nowMs + HOME_PAYLOAD_CACHE_TTL_MS }
  }

  const payload = homePayloadCache.payload
  const flags = await getViewerPostFlags(
    viewerUserId,
    payload.hotPosts.map((post) => post.id),
  )

  return {
    ...payload,
    hotPosts: payload.hotPosts.map((post) => attachPostViewerFlags(post, flags)),
  }
}



/**
 * 批量拉取作品卡片（首页继续阅读等轻量场景，方案 20 §2.5）：
 * 一次查询代替逐本拉完整详情；可见性口径与详情页一致（公开作品或 viewer 自己的作品），
 * 已下架/无权限的静默过滤，返回顺序与传入 id 顺序一致。
 */
export async function listNovelCardsByIdsData(
  novelIds: string[],
  viewerUserId?: string | null,
  allowOwnerAccess = true,
): Promise<NovelCard[]> {
  const ids = [...new Set(novelIds.filter(Boolean))].slice(0, 20)
  if (ids.length === 0) {
    return []
  }

  const records = await prisma.novel.findMany({
    where: {
      id: { in: ids },
      OR: [searchableNovelWhere, ...(viewerUserId && allowOwnerAccess ? [{ authorId: viewerUserId }] : [])],
    },
    include: novelInclude,
  })

  const cardById = new Map(records.map((record) => [record.id, toNovelCard(record, viewerUserId)]))
  return ids
    .map((id) => cardById.get(id))
    .filter((card): card is NovelCard => Boolean(card))
}
