/**
 * 管理后台域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type {
  AdminAgentSessionMessagesPayload,
  AdminBriefUser,
  AdminCreationRecordsIndexPayload,
  AdminCreationRecordsPayload,
  AdminTokenManagementPayload,
  AdminUserFavoriteNovelRow,
  AdminUserFollowRow,
  Pagination,
} from '../../../shared/contracts/index.js'
import { hashPassword, isLegacyPasswordHash, verifyPassword } from '../password.js'
import { evictUserBanCache } from '../auth-session.js'
import { prisma } from '../prisma.js'
import { buildPagination, excerptContent, isUserOnline, onlineWindowStart, toIso } from './internal.js'

type AgentUsageSummary = { promptTokens: number; completionTokens: number; totalTokens: number }

function parseAgentUsage(value: Prisma.JsonValue | null | undefined): AgentUsageSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const record = value as Record<string, unknown>
  const promptTokens = Number(record.promptTokens) || 0
  const completionTokens = Number(record.completionTokens) || 0
  return { promptTokens, completionTokens, totalTokens: Number(record.totalTokens) || promptTokens + completionTokens }
}

function totalRunTokens(runs: Array<{ usage: Prisma.JsonValue | null }>): number {
  return runs.reduce((total, run) => total + parseAgentUsage(run.usage).totalTokens, 0)
}

const trackedToolResultWhere = (toolName: 'web_search' | 'cover_generate', userId?: string): Prisma.AgentRunEventWhereInput => ({
  type: 'tool.result',
  payload: { path: ['toolName'], equals: toolName },
  ...(userId ? { run: { userId } } : {}),
})



/* ========================================================================== */
/* 后台管理数据层（方案 18）                                                    */
/* 所有写操作必须在路由层配套 recordAdminAuditLog 审计记录                          */
/* ========================================================================== */

export type AdminUserRow = {
  id: string
  nickname: string
  avatarUrl: string | null
  phone: string | null
  email: string | null
  role: string
  bannedAt: string | null
  createdAt: string
  lastActiveAt: string | null
  isOnline: boolean
  novelCount: number
  postCount: number
  followerCount: number
}



export type AdminDashboardPayload = {
  totals: {
    users: number
    publishedNovels: number
    posts: number
    comments: number
  }
  trend: Array<{ date: string; users: number; novels: number; posts: number; comments: number }>
  recentLogs: Array<{
    id: string
    action: string
    targetType: string | null
    targetId: string | null
    adminNickname: string | null
    createdAt: string
  }>
}



export type AdminNovelRow = {
  id: string
  title: string
  displayTitle: string | null
  status: string
  visibility: string
  categoryName: string | null
  wordCount: number
  chapterCount: number
  commentCount: number
  favoriteCount: number
  publishedAt: string | null
  updatedAt: string
  author: { id: string; nickname: string; avatarUrl: string | null }
}



export type AdminPostRow = {
  id: string
  excerpt: string
  imageCount: number
  likeCount: number
  commentCount: number
  createdAt: string
  topicTitle: string | null
  author: { id: string; nickname: string; avatarUrl: string | null }
}



export type AdminCommentRow = {
  id: string
  content: string
  targetType: string
  paragraphIndex: number | null
  targetTitle: string | null
  likeCount: number
  replyCount: number
  createdAt: string
  author: { id: string; nickname: string; avatarUrl: string | null }
  targetHref: string | null
}



export type AdminPostDetailPayload = {
  post: {
    id: string
    content: string
    imageUrls: string[]
    likeCount: number
    commentCount: number
    createdAt: string
    topicTitle: string | null
    author: { id: string; nickname: string; avatarUrl: string | null }
  }
  comments: Array<{
    id: string
    content: string
    likeCount: number
    replyCount: number
    createdAt: string
    author: { id: string; nickname: string; avatarUrl: string | null }
    replies: Array<{
      id: string
      content: string
      createdAt: string
      author: { id: string; nickname: string; avatarUrl: string | null }
    }>
  }>
}



export type AdminConversationRow = {
  id: string
  type: string
  title: string | null
  lastMessagePreview: string | null
  lastMessageAt: string | null
  messageCount: number
  members: Array<{ id: string; nickname: string; avatarUrl: string | null }>
}



export type AdminMessageRow = {
  id: string
  content: string
  type: string
  createdAt: string
  sender: { id: string; nickname: string; avatarUrl: string | null }
}



export type AdminAuditLogRow = {
  id: string
  adminId: string
  adminNickname: string | null
  action: string
  targetType: string | null
  targetId: string | null
  detail: Record<string, unknown>
  ip: string | null
  createdAt: string
}



export async function recordAdminAuditLog(input: {
  adminId: string
  action: string
  targetType?: string | null
  targetId?: string | null
  detail?: Record<string, unknown>
  ip?: string | null
}): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      id: randomUUID(),
      adminId: input.adminId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detail: (input.detail ?? {}) as Prisma.InputJsonValue,
      ip: input.ip ?? null,
    },
  })
}



/** 管理后台登录：邮箱 + 密码，仅放行 admin 角色且未封禁的账号 */
export async function adminLoginByEmailData(
  email: string,
  password: string,
): Promise<{ userId: string; nickname: string } | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  })

  if (!user || user.role !== 'admin' || user.bannedAt !== null) {
    return null
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return null
  }

  // 存量明文哈希验证通过后升级为 scrypt
  if (isLegacyPasswordHash(user.passwordHash)) {
    void prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } })
      .catch(() => {})
  }

  return { userId: user.id, nickname: user.nickname }
}



/** 手机号登录管理后台：可选校验密码（验证码模式由路由层先校验短信码） */
export async function adminLoginByPhoneData(
  phone: string,
  password?: string,
): Promise<{ userId: string; nickname: string } | null> {
  const user = await prisma.user.findUnique({
    where: { phone },
  })

  if (!user || user.role !== 'admin' || user.bannedAt !== null) {
    return null
  }
  if (password !== undefined && !verifyPassword(password, user.passwordHash)) {
    return null
  }

  // 存量明文哈希验证通过后升级为 scrypt
  if (password !== undefined && isLegacyPasswordHash(user.passwordHash)) {
    void prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } })
      .catch(() => {})
  }

  return { userId: user.id, nickname: user.nickname }
}



/** 查询手机号是否绑定有效管理员（用于发码前置校验，避免给非管理员手机号发短信） */
export async function findAdminByPhoneData(phone: string): Promise<{ id: string } | null> {
  const user = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, role: true, bannedAt: true },
  })

  if (!user || user.role !== 'admin' || user.bannedAt !== null) {
    return null
  }
  return { id: user.id }
}



/** 手机号是否已被其他账号绑定（绑定发码前置校验，避免浪费短信） */
export async function isPhoneTakenByOtherData(phone: string, excludeUserId: string): Promise<boolean> {
  const occupied = await prisma.user.findFirst({
    where: { phone, id: { not: excludeUserId } },
    select: { id: true },
  })
  return occupied !== null
}



/** 管理员绑定手机号：手机号未被其他账号占用时写入 */
export async function bindAdminPhoneData(
  adminId: string,
  phone: string,
): Promise<{ ok: boolean; reason?: 'taken' }> {
  const occupied = await prisma.user.findFirst({
    where: { phone, id: { not: adminId } },
    select: { id: true },
  })
  if (occupied) {
    return { ok: false, reason: 'taken' }
  }

  await prisma.user.update({ where: { id: adminId }, data: { phone } })
  return { ok: true }
}



export async function getAdminUserBySessionData(userId: string): Promise<{
  id: string
  nickname: string
  email: string | null
  phone: string | null
  role: string
  isSuperAdmin: boolean
} | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, email: true, phone: true, role: true, bannedAt: true, isSuperAdmin: true },
  })

  if (!user || user.role !== 'admin' || user.bannedAt !== null) {
    return null
  }

  return {
    id: user.id,
    nickname: user.nickname,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin,
  }
}



/** 管理员改自己的密码：先校验旧密码 */
export async function adminChangeMyPasswordData(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    return false
  }
  if (!verifyPassword(oldPassword, user.passwordHash)) {
    return false
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: hashPassword(newPassword),
      // 改密吊销全部旧会话令牌；调用方（路由层）会为当前设备静默重签
      tokenVersion: { increment: 1 },
    },
  })
  evictUserBanCache(userId)
  return true
}



/** 重置某用户密码：生成一次性临时密码返回给管理员，线下交付 */
export async function resetUserPasswordData(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) {
    return null
  }

  const tempPassword = `Cv-${randomBytes(9).toString('base64url')}`
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: hashPassword(tempPassword),
      // 管理员重置密码后原会话全部吊销，用户凭临时密码重新登录
      tokenVersion: { increment: 1 },
    },
  })
  evictUserBanCache(userId)
  return tempPassword
}



export async function setUserBannedData(
  userId: string,
  banned: boolean,
): Promise<{ nickname: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, nickname: true } })
  if (!user) {
    return null
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      bannedAt: banned ? new Date() : null,
      // 封禁即吊销全部会话令牌；解封也 +1，避免解封后旧会话自动复活
      tokenVersion: { increment: 1 },
    },
  })
  evictUserBanCache(userId)
  return { nickname: user.nickname }
}



export async function setUserRoleData(
  userId: string,
  role: 'user' | 'admin',
): Promise<{ nickname: string; role: string } | null | { blocked: 'super' }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, isSuperAdmin: true },
  })
  if (!user) {
    return null
  }
  // 超级管理身份唯一且不可被他人改动
  if (user.isSuperAdmin) {
    return { blocked: 'super' }
  }

  await prisma.user.update({ where: { id: userId }, data: { role } })
  return { nickname: user.nickname, role }
}



export async function listAdminUsersData(input: {
  search?: string
  role?: string
  banned?: boolean
  online?: boolean
  page: number
  pageSize: number
}): Promise<{ items: AdminUserRow[]; pagination: Pagination }> {
  const where: Prisma.UserWhereInput = {}

  if (input.search?.trim()) {
    const keyword = input.search.trim()
    where.OR = [
      { nickname: { contains: keyword, mode: 'insensitive' } },
      { phone: { contains: keyword } },
      { email: { contains: keyword, mode: 'insensitive' } },
    ]
  }
  if (input.role) {
    where.role = input.role as Prisma.UserWhereInput['role']
  }
  if (input.banned === true) {
    where.bannedAt = { not: null }
  } else if (input.banned === false) {
    where.bannedAt = null
  }
  if (input.online === true) {
    // 「在线」取与 isUserOnline 相同的时间窗；封禁用户不计入在线，与状态列展示（已封禁优先）保持一致
    where.bannedAt = null
    where.lastActiveAt = { gte: onlineWindowStart() }
  }

  const [total, records] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        nickname: true,
        avatarUrl: true,
        phone: true,
        email: true,
        role: true,
        bannedAt: true,
        createdAt: true,
        lastActiveAt: true,
        novelCount: true,
        postCount: true,
        followerCount: true,
      },
    }),
  ])

  const items: AdminUserRow[] = records.map((record) => ({
    id: record.id,
    nickname: record.nickname,
    avatarUrl: record.avatarUrl,
    phone: record.phone,
    email: record.email,
    role: record.role,
    bannedAt: toIso(record.bannedAt),
    createdAt: record.createdAt.toISOString(),
    lastActiveAt: toIso(record.lastActiveAt),
    isOnline: isUserOnline(record.lastActiveAt),
    novelCount: record.novelCount,
    postCount: record.postCount,
    followerCount: record.followerCount,
  }))

  return { items, pagination: buildPagination(input.page, input.pageSize, total) }
}



export async function getAdminUserDetailData(userId: string): Promise<{
  user: AdminUserRow & { bio: string | null }
  stats: { novels: number; posts: number; comments: number; favorites: number; totalTokens: number; webSearchCalls: number; imageCalls: number }
} | null> {
  const record = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      nickname: true,
      avatarUrl: true,
      phone: true,
      email: true,
      bio: true,
      role: true,
      bannedAt: true,
      createdAt: true,
      lastActiveAt: true,
      novelCount: true,
      postCount: true,
      followerCount: true,
    },
  })
  if (!record) {
    return null
  }

  const [novels, posts, comments, favorites, usage, webSearchCalls, imageCalls] = await Promise.all([
    prisma.novel.count({ where: { authorId: userId } }),
    prisma.post.count({ where: { userId } }),
    prisma.comment.count({ where: { userId } }),
    prisma.novelFavorite.count({ where: { userId } }),
    prisma.aiUsageLog.aggregate({ where: { userId }, _sum: { requestTokens: true, responseTokens: true } }),
    prisma.agentRunEvent.count({ where: trackedToolResultWhere('web_search', userId) }),
    prisma.agentRunEvent.count({ where: trackedToolResultWhere('cover_generate', userId) }),
  ])

  return {
    user: {
      id: record.id,
      nickname: record.nickname,
      avatarUrl: record.avatarUrl,
      phone: record.phone,
      email: record.email,
      role: record.role,
      bannedAt: toIso(record.bannedAt),
      createdAt: record.createdAt.toISOString(),
      lastActiveAt: toIso(record.lastActiveAt),
      isOnline: isUserOnline(record.lastActiveAt),
      novelCount: record.novelCount,
      postCount: record.postCount,
      followerCount: record.followerCount,
      bio: record.bio,
    },
    stats: {
      novels,
      posts,
      comments,
      favorites,
      totalTokens: (usage._sum.requestTokens ?? 0) + (usage._sum.responseTokens ?? 0),
      webSearchCalls,
      imageCalls,
    },
  }
}



/** 管理端：查看某用户的粉丝列表（管理端不受隐私级别管控，忽略粉丝可见性） */
export async function listAdminUserFollowersData(
  userId: string,
): Promise<{ user: AdminBriefUser; items: AdminUserFollowRow[]; total: number } | null> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, avatarUrl: true },
  })
  if (!target) {
    return null
  }

  const records = await prisma.userFollow.findMany({
    where: { followingId: userId },
    include: { follower: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  const items: AdminUserFollowRow[] = records.map((record) => ({
    id: record.follower.id,
    nickname: record.follower.nickname,
    avatarUrl: record.follower.avatarUrl,
    followerCount: record.follower.followerCount,
    isOnline: isUserOnline(record.follower.lastActiveAt),
    followedAt: toIso(record.createdAt) ?? new Date().toISOString(),
  }))

  return {
    user: { id: target.id, nickname: target.nickname, avatarUrl: target.avatarUrl },
    items,
    total: items.length,
  }
}



/** 管理端：查看某用户收藏的作品列表 */
export async function listAdminUserFavoriteNovelsData(
  userId: string,
): Promise<{ user: AdminBriefUser; items: AdminUserFavoriteNovelRow[]; total: number } | null> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, avatarUrl: true },
  })
  if (!target) {
    return null
  }

  const records = await prisma.novelFavorite.findMany({
    where: { userId },
    include: {
      novel: {
        include: {
          author: { select: { id: true, nickname: true, avatarUrl: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const items: AdminUserFavoriteNovelRow[] = records.map((record) => ({
    id: record.novel.id,
    title: record.novel.title,
    displayTitle: record.novel.displayTitle,
    status: record.novel.status,
    wordCount: record.novel.wordCount,
    chapterCount: record.novel.chapterCount,
    favoriteCount: record.novel.favoriteCount,
    favoritedAt: toIso(record.createdAt) ?? new Date().toISOString(),
    author: {
      id: record.novel.author.id,
      nickname: record.novel.author.nickname,
      avatarUrl: record.novel.author.avatarUrl,
    },
  }))

  return {
    user: { id: target.id, nickname: target.nickname, avatarUrl: target.avatarUrl },
    items,
    total: items.length,
  }
}



/** 管理端创作记录索引：仅列出有 Agent 会话记录的作者，支持按昵称/手机号/邮箱过滤；
 *  按用户聚合会话统计（每人一行）后内存排序分页，避免把全部会话拉进内存 */
export async function getAdminCreationRecordsIndexData(input: {
  search?: string
  page?: number
  pageSize?: number
}): Promise<AdminCreationRecordsIndexPayload> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 24))

  const sessionGroups = await prisma.agentSession.groupBy({
    by: ['userId'],
    _max: { updatedAt: true },
    _count: { _all: true },
  })

  let groups = sessionGroups
  const keyword = input.search?.trim()
  if (keyword) {
    const matched = await prisma.user.findMany({
      where: {
        OR: [
          { nickname: { contains: keyword, mode: 'insensitive' } },
          { phone: { contains: keyword } },
          { email: { contains: keyword, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    })
    const matchedIds = new Set(matched.map((user) => user.id))
    groups = sessionGroups.filter((group) => matchedIds.has(group.userId))
  }

  groups.sort(
    (a, b) => (b._max.updatedAt ?? new Date(0)).getTime() - (a._max.updatedAt ?? new Date(0)).getTime(),
  )
  const total = groups.length
  const pageGroups = groups.slice((page - 1) * pageSize, page * pageSize)

  const users = await prisma.user.findMany({
    where: { id: { in: pageGroups.map((group) => group.userId) } },
    select: { id: true, nickname: true, avatarUrl: true, novelCount: true },
  })
  const userById = new Map(users.map((user) => [user.id, user]))

  const items = pageGroups.flatMap((group) => {
    const user = userById.get(group.userId)
    if (!user) {
      return []
    }
    return [
      {
        id: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        novelCount: user.novelCount,
        sessionCount: group._count._all,
        lastSessionAt: group._max.updatedAt ? group._max.updatedAt.toISOString() : null,
      },
    ]
  })

  return { items, total, page, pageSize, hasMore: page * pageSize < total }
}

/** 管理端：某用户的创作记录（按作品分组，作品下挂 Agent 会话列表，不含具体消息） */
export async function getAdminCreationRecordsData(userId: string): Promise<AdminCreationRecordsPayload | null> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, avatarUrl: true },
  })
  if (!target) {
    return null
  }

  const novels = await prisma.novel.findMany({
    where: { authorId: userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      agentSessions: {
        orderBy: { updatedAt: 'desc' },
        include: { _count: { select: { runs: true } }, runs: { select: { usage: true } } },
      },
    },
  })
  const novelUsage = await prisma.aiUsageLog.groupBy({
    by: ['novelId'],
    where: { userId, novelId: { not: null } },
    _sum: { requestTokens: true, responseTokens: true },
  })
  const novelTokens = new Map(novelUsage.map((item) => [item.novelId, (item._sum.requestTokens ?? 0) + (item._sum.responseTokens ?? 0)]))

  return {
    user: { id: target.id, nickname: target.nickname, avatarUrl: target.avatarUrl },
    novels: novels.map((novel) => ({
      novelId: novel.id,
      title: novel.title,
      displayTitle: novel.displayTitle,
      status: novel.status,
      chapterCount: novel.chapterCount,
      wordCount: novel.wordCount,
      updatedAt: novel.updatedAt.toISOString(),
      totalTokens: novelTokens.get(novel.id) ?? 0,
      sessions: novel.agentSessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        runCount: session._count.runs,
        lastRunAt: toIso(session.lastRunAt),
        createdAt: session.createdAt.toISOString(),
        totalTokens: totalRunTokens(session.runs),
      })),
    })),
  }
}



/** 管理端：查看单个 Agent 会话的聊天记录（run + 消息）；按 run 轮次游标分页，
 *  默认返回最新 pageSize 轮，before 传本页最早 run id 加载更早一轮，避免长会话一次性拉全量消息 */
export async function getAdminAgentSessionMessagesData(
  sessionId: string,
  input: { before?: string; pageSize?: number } = {},
): Promise<AdminAgentSessionMessagesPayload | null> {
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 20))
  const cursor = input.before ? { id: input.before } : undefined
  const loadRecord = (withCursor: boolean) =>
    prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        title: true,
        createdAt: true,
        novel: { select: { id: true, title: true, displayTitle: true } },
        runs: {
          // 倒序多取一条判断 hasMore；游标存在时从该 run 往前（不含自身）
          orderBy: { createdAt: 'desc' },
          ...(withCursor && cursor ? { cursor, skip: 1 } : {}),
          take: pageSize + 1,
          select: {
            id: true,
            mode: true,
            action: true,
            status: true,
            inputSummary: true,
            outputSummary: true,
            errorMessage: true,
            createdAt: true,
            finishedAt: true,
            usage: true,
            messages: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, runId: true, role: true, parts: true, createdAt: true },
            },
          },
        },
      },
    })

  const record = await loadRecord(true).catch((error: unknown) => {
    // 游标 run 已被用户删除等场景：回退首页重新加载，避免管理端查看直接报错
    if (cursor) {
      return loadRecord(false)
    }
    throw error
  })
  if (!record) {
    return null
  }

  const hasMore = record.runs.length > pageSize
  const runs = record.runs.slice(0, pageSize).reverse()

  return {
    session: {
      id: record.id,
      title: record.title,
      novelTitle: record.novel.title,
      displayTitle: record.novel.displayTitle,
      createdAt: record.createdAt.toISOString(),
    },
    runs: runs.map((run) => ({
      id: run.id,
      mode: run.mode,
      action: run.action,
      status: run.status,
      inputSummary: run.inputSummary,
      outputSummary: run.outputSummary,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      finishedAt: toIso(run.finishedAt),
      usage: parseAgentUsage(run.usage),
      messages: run.messages.map((message) => ({
        id: message.id,
        runId: message.runId,
        role: (message.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        parts: message.parts as unknown[],
        createdAt: message.createdAt.toISOString(),
      })),
    })),
    hasMore,
    nextCursor: runs.length > 0 ? runs[0].id : null,
  }
}


type AdminTokenPeriod = 'today' | 'week' | 'month'

function utc8PeriodStart(period: AdminTokenPeriod, now = new Date()): Date {
  const local = new Date(now.getTime() + 8 * 3_600_000)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth()
  let day = local.getUTCDate()
  if (period === 'week') {
    const weekday = local.getUTCDay() || 7
    day -= weekday - 1
  } else if (period === 'month') {
    day = 1
  }
  return new Date(Date.UTC(year, month, day) - 8 * 3_600_000)
}

/** 全站 AI 用量总览：AiUsageLog 是模型 Token 的唯一计量源，固定价工具次数来自 Credits 账本。 */
export async function getAdminTokenManagementData(period: AdminTokenPeriod = 'today'): Promise<AdminTokenManagementPayload> {
  const startedAt = utc8PeriodStart(period)
  const usageWhere = { createdAt: { gte: startedAt } }
  const [summary, userGroups, actionGroups, modelGroups, toolEntries, rawTrend, runGroups, mainTurnGroups, runTurns] = await Promise.all([
    prisma.aiUsageLog.aggregate({ where: usageWhere, _sum: { requestTokens: true, responseTokens: true, promptCacheHitTokens: true, promptCacheMissTokens: true } }),
    prisma.aiUsageLog.groupBy({ where: usageWhere, by: ['userId'], _sum: { requestTokens: true, responseTokens: true }, _count: { _all: true } }),
    prisma.aiUsageLog.groupBy({ where: usageWhere, by: ['action'], _sum: { requestTokens: true, responseTokens: true }, _count: { _all: true } }),
    prisma.aiUsageLog.groupBy({ where: usageWhere, by: ['providerName', 'modelName', 'modelTier'], _sum: { requestTokens: true, responseTokens: true, promptCacheHitTokens: true, promptCacheMissTokens: true }, _count: { _all: true } }),
    prisma.creditLedgerEntry.findMany({
      where: { createdAt: { gte: startedAt }, sourceType: { in: ['web_search', 'image_generation'] }, deltaMilli: { lte: 0 } },
      select: { userId: true, sourceType: true },
    }),
    prisma.aiUsageLog.findMany({ where: usageWhere, select: { createdAt: true, requestTokens: true, responseTokens: true } }),
    // 主/子 Agent 均按 agentRunId 归并；数据库侧仅返回输入量最高的 20 个 Run。
    prisma.aiUsageLog.groupBy({
      by: ['agentRunId'],
      where: { ...usageWhere, agentRunId: { not: null } },
      _sum: { requestTokens: true, responseTokens: true, promptCacheHitTokens: true, promptCacheMissTokens: true, creditChargeMilli: true },
      _min: { createdAt: true },
      _count: { _all: true },
      orderBy: { _sum: { requestTokens: 'desc' } },
      take: 20,
    }),
    prisma.aiUsageLog.groupBy({
      by: ['targetId'],
      where: { ...usageWhere, targetType: 'agentRun', targetId: { not: null } },
      _max: { turn: true },
    }),
    // 最近逐轮明细用于定位具体哪一轮前缀断裂；null/null 明确代表供应商未提供缓存观测。
    prisma.aiUsageLog.findMany({
      where: { ...usageWhere, agentRunId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, agentRunId: true, targetType: true, targetId: true, turn: true,
        providerName: true, modelName: true, requestTokens: true, responseTokens: true,
        promptCacheHitTokens: true, promptCacheMissTokens: true, creditChargeMilli: true, createdAt: true,
      },
    }),
  ])
  const toolCounts = new Map<string, { webSearchCalls: number; imageCalls: number }>()
  for (const entry of toolEntries) {
    const counts = toolCounts.get(entry.userId) ?? { webSearchCalls: 0, imageCalls: 0 }
    if (entry.sourceType === 'web_search') counts.webSearchCalls += 1
    if (entry.sourceType === 'image_generation') counts.imageCalls += 1
    toolCounts.set(entry.userId, counts)
  }
  const usageByUser = new Map(userGroups.map((item) => [item.userId, item]))
  const rankedUserIds = [...new Set([...usageByUser.keys(), ...toolCounts.keys()])]
    .sort((leftId, rightId) => {
      const left = usageByUser.get(leftId)
      const right = usageByUser.get(rightId)
      const leftTokens = (left?._sum.requestTokens ?? 0) + (left?._sum.responseTokens ?? 0)
      const rightTokens = (right?._sum.requestTokens ?? 0) + (right?._sum.responseTokens ?? 0)
      if (rightTokens !== leftTokens) return rightTokens - leftTokens
      const leftTools = toolCounts.get(leftId)
      const rightTools = toolCounts.get(rightId)
      return ((rightTools?.webSearchCalls ?? 0) + (rightTools?.imageCalls ?? 0))
        - ((leftTools?.webSearchCalls ?? 0) + (leftTools?.imageCalls ?? 0))
    })
    .slice(0, 100)
  const users = await prisma.user.findMany({
    where: { id: { in: rankedUserIds } },
    select: { id: true, nickname: true, avatarUrl: true },
  })
  const userMap = new Map(users.map((user) => [user.id, user]))
  const requestTokens = summary._sum.requestTokens ?? 0
  const responseTokens = summary._sum.responseTokens ?? 0
  const cacheHitTokens = summary._sum.promptCacheHitTokens ?? 0
  const cacheMissTokens = summary._sum.promptCacheMissTokens ?? 0
  const mainTurnsByRun = new Map(mainTurnGroups.flatMap((item) => item.targetId ? [[item.targetId, item._max.turn ?? 0] as const] : []))
  const webSearchCalls = [...toolCounts.values()].reduce((total, item) => total + item.webSearchCalls, 0)
  const imageCalls = [...toolCounts.values()].reduce((total, item) => total + item.imageCalls, 0)
  const modelLabels: Record<string, string> = { lite: '轻量', speed: '极速', standard: '标准', performance: '性能', ultimate: '极致', custom: '自定义' }
  const trendMap = new Map<string, { requestTokens: number; responseTokens: number }>()
  for (const item of rawTrend) {
    const date = new Date(item.createdAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
    const current = trendMap.get(date) ?? { requestTokens: 0, responseTokens: 0 }
    current.requestTokens += item.requestTokens ?? 0
    current.responseTokens += item.responseTokens ?? 0
    trendMap.set(date, current)
  }
  return {
    period,
    periodStartedAt: startedAt.toISOString(),
    summary: { totalTokens: requestTokens + responseTokens, requestTokens, responseTokens, cacheHitTokens, cacheMissTokens, cacheObservedTokens: cacheHitTokens + cacheMissTokens, users: rankedUserIds.length, webSearchCalls, imageCalls },
    users: rankedUserIds.flatMap((userId) => {
      const user = userMap.get(userId)
      if (!user) return []
      const usage = usageByUser.get(userId)
      const userRequestTokens = usage?._sum.requestTokens ?? 0
      const userResponseTokens = usage?._sum.responseTokens ?? 0
      const counts = toolCounts.get(userId) ?? { webSearchCalls: 0, imageCalls: 0 }
      return [{ user, totalTokens: userRequestTokens + userResponseTokens, requestTokens: userRequestTokens, responseTokens: userResponseTokens, requestCount: usage?._count._all ?? 0, ...counts }]
    }),
    actions: actionGroups.map((item) => {
      const actionRequestTokens = item._sum.requestTokens ?? 0
      const actionResponseTokens = item._sum.responseTokens ?? 0
      const totalTokens = actionRequestTokens + actionResponseTokens
      return { action: item.action, totalTokens, requestTokens: actionRequestTokens, responseTokens: actionResponseTokens, requestCount: item._count._all, averageTokens: item._count._all ? Math.round(totalTokens / item._count._all) : 0 }
    }).sort((left, right) => right.totalTokens - left.totalTokens),
    models: modelGroups.map((item) => {
      const modelRequestTokens = item._sum.requestTokens ?? 0
      const modelResponseTokens = item._sum.responseTokens ?? 0
      return {
        modelTier: item.modelTier ?? 'unclassified',
        modelLabel: modelLabels[item.modelTier ?? ''] ?? '未分类',
        providerName: item.providerName,
        modelName: item.modelName,
        totalTokens: modelRequestTokens + modelResponseTokens,
        requestTokens: modelRequestTokens,
        responseTokens: modelResponseTokens,
        cacheHitTokens: item._sum.promptCacheHitTokens ?? 0,
        cacheMissTokens: item._sum.promptCacheMissTokens ?? 0,
        cacheObservedTokens: (item._sum.promptCacheHitTokens ?? 0) + (item._sum.promptCacheMissTokens ?? 0),
        requestCount: item._count._all,
      }
    }).sort((left, right) => right.totalTokens - left.totalTokens),
    runs: runGroups
      .filter((item): item is typeof item & { agentRunId: string } => Boolean(item.agentRunId))
      .map((item) => ({
        runId: item.agentRunId,
        promptTokens: item._sum.requestTokens ?? 0,
        responseTokens: item._sum.responseTokens ?? 0,
        hitTokens: item._sum.promptCacheHitTokens ?? 0,
        missTokens: item._sum.promptCacheMissTokens ?? 0,
        cacheObservedTokens: (item._sum.promptCacheHitTokens ?? 0) + (item._sum.promptCacheMissTokens ?? 0),
        chargedMilli: item._sum.creditChargeMilli ?? 0,
        turns: mainTurnsByRun.get(item.agentRunId) ?? 0,
        requests: item._count._all,
        startedAt: (item._min.createdAt ?? new Date(0)).toISOString(),
      }))
      .sort((left, right) => (right.promptTokens + right.responseTokens) - (left.promptTokens + left.responseTokens)),
    runTurns: runTurns.flatMap((item) => item.agentRunId ? [{
      id: item.id,
      runId: item.agentRunId,
      scope: item.targetType === 'agentSubtaskRun' ? 'subagent' as const : 'main' as const,
      targetId: item.targetId,
      turn: item.turn,
      providerName: item.providerName,
      modelName: item.modelName,
      promptTokens: item.requestTokens ?? 0,
      responseTokens: item.responseTokens ?? 0,
      hitTokens: item.promptCacheHitTokens,
      missTokens: item.promptCacheMissTokens,
      chargedMilli: item.creditChargeMilli,
      createdAt: item.createdAt.toISOString(),
    }] : []),
    trend: [...trendMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, ...value })),
  }
}



function buildRecentDays(dates: Date[]): Map<string, number> {
  const counter = new Map<string, number>()
  for (const date of dates) {
    const key = date.toISOString().slice(0, 10)
    counter.set(key, (counter.get(key) ?? 0) + 1)
  }
  return counter
}



export async function getAdminDashboardData(): Promise<AdminDashboardPayload> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [userTotal, novelTotal, postTotal, commentTotal, recentUsers, recentNovels, recentPosts, recentComments, recentLogs] =
    await Promise.all([
      prisma.user.count(),
      prisma.novel.count({ where: { status: { in: ['published', 'completed'] } } }),
      prisma.post.count(),
      prisma.comment.count(),
      prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.novel.findMany({
        where: { status: { in: ['published', 'completed'] }, lastPublishedAt: { gte: since } },
        select: { lastPublishedAt: true },
      }),
      prisma.post.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.comment.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ])

  const userCounter = buildRecentDays(recentUsers.map((item) => item.createdAt))
  const novelCounter = buildRecentDays(
    recentNovels.map((item) => item.lastPublishedAt).filter((item): item is Date => item !== null),
  )
  const postCounter = buildRecentDays(recentPosts.map((item) => item.createdAt))
  const commentCounter = buildRecentDays(recentComments.map((item) => item.createdAt))

  const trend: AdminDashboardPayload['trend'] = []
  for (let day = 6; day >= 0; day -= 1) {
    const key = new Date(Date.now() - day * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    trend.push({
      date: key,
      users: userCounter.get(key) ?? 0,
      novels: novelCounter.get(key) ?? 0,
      posts: postCounter.get(key) ?? 0,
      comments: commentCounter.get(key) ?? 0,
    })
  }

  const adminIds = [...new Set(recentLogs.map((log) => log.adminId))]
  const admins = adminIds.length
    ? await prisma.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, nickname: true } })
    : []
  const adminNames = new Map(admins.map((admin) => [admin.id, admin.nickname]))

  return {
    totals: { users: userTotal, publishedNovels: novelTotal, posts: postTotal, comments: commentTotal },
    trend,
    recentLogs: recentLogs.map((log) => ({
      id: log.id,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      adminNickname: adminNames.get(log.adminId) ?? null,
      createdAt: log.createdAt.toISOString(),
    })),
  }
}



export async function listAdminNovelsData(input: {
  search?: string
  status?: string
  page: number
  pageSize: number
}): Promise<{ items: AdminNovelRow[]; pagination: Pagination }> {
  const where: Prisma.NovelWhereInput = {}

  if (input.status) {
    where.status = input.status as Prisma.NovelWhereInput['status']
  }
  if (input.search?.trim()) {
    const keyword = input.search.trim()
    where.OR = [
      { title: { contains: keyword, mode: 'insensitive' } },
      { displayTitle: { contains: keyword, mode: 'insensitive' } },
      { author: { nickname: { contains: keyword, mode: 'insensitive' } } },
    ]
  }

  const [total, records] = await Promise.all([
    prisma.novel.count({ where }),
    prisma.novel.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { author: { select: { id: true, nickname: true, avatarUrl: true } } },
    }),
  ])

  const items: AdminNovelRow[] = records.map((record) => ({
    id: record.id,
    title: record.title,
    displayTitle: record.displayTitle,
    status: record.status,
    visibility: record.visibility,
    categoryName: record.categoryName,
    wordCount: record.wordCount,
    chapterCount: record.chapterCount,
    commentCount: record.commentCount,
    favoriteCount: record.favoriteCount,
    publishedAt: toIso(record.publishedAt),
    updatedAt: record.updatedAt.toISOString(),
    author: { id: record.author.id, nickname: record.author.nickname, avatarUrl: record.author.avatarUrl },
  }))

  return { items, pagination: buildPagination(input.page, input.pageSize, total) }
}



export async function getAdminNovelDetailData(novelId: string): Promise<{
  novel: AdminNovelRow & { summary: string; author: AdminUserRow; coverUrl: string | null }
  usage: { totalTokens: number; requestTokens: number; responseTokens: number }
  chapters: Array<{
    id: string
    title: string
    orderIndex: number
    status: string
    wordCount: number
    publishedAt: string | null
    updatedAt: string
  }>
} | null> {
  const record = await prisma.novel.findUnique({
    where: { id: novelId },
    include: {
      author: true,
      coverAsset: { select: { imageUrl: true } },
      chapters: { orderBy: { orderIndex: 'asc' } },
    },
  })
  if (!record) {
    return null
  }
  const usage = await prisma.aiUsageLog.aggregate({
    where: { novelId },
    _sum: { requestTokens: true, responseTokens: true },
  })
  const requestTokens = usage._sum.requestTokens ?? 0
  const responseTokens = usage._sum.responseTokens ?? 0

  return {
    novel: {
      id: record.id,
      title: record.title,
      displayTitle: record.displayTitle,
      status: record.status,
      visibility: record.visibility,
      categoryName: record.categoryName,
      wordCount: record.wordCount,
      chapterCount: record.chapterCount,
      commentCount: record.commentCount,
      favoriteCount: record.favoriteCount,
      publishedAt: toIso(record.publishedAt),
      updatedAt: record.updatedAt.toISOString(),
      summary: record.summary,
      coverUrl: record.coverAsset?.imageUrl ?? null,
      author: {
        id: record.author.id,
        nickname: record.author.nickname,
        avatarUrl: record.author.avatarUrl,
        phone: record.author.phone,
        email: record.author.email,
        role: record.author.role,
        bannedAt: toIso(record.author.bannedAt),
        createdAt: record.author.createdAt.toISOString(),
        lastActiveAt: toIso(record.author.lastActiveAt),
        isOnline: isUserOnline(record.author.lastActiveAt),
        novelCount: record.author.novelCount,
        postCount: record.author.postCount,
        followerCount: record.author.followerCount,
      },
    },
    usage: { totalTokens: requestTokens + responseTokens, requestTokens, responseTokens },
    chapters: record.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      orderIndex: chapter.orderIndex,
      status: chapter.status,
      wordCount: chapter.wordCount,
      publishedAt: toIso(chapter.publishedAt),
      updatedAt: chapter.updatedAt.toISOString(),
    })),
  }
}



/** 管理端内部预览：取作品任意章节正文（含草稿/已下架），仅管理后台预览页使用 */
export async function getAdminChapterContentData(
  novelId: string,
  chapterId: string,
): Promise<{
  id: string
  title: string
  orderIndex: number
  status: string
  wordCount: number
  content: string
  publishedAt: string | null
  updatedAt: string
} | null> {
  const record = await prisma.chapter.findFirst({
    where: { id: chapterId, novelId },
  })
  if (!record) {
    return null
  }

  return {
    id: record.id,
    title: record.title,
    orderIndex: record.orderIndex,
    status: record.status,
    wordCount: record.wordCount,
    content: record.content,
    publishedAt: toIso(record.publishedAt),
    updatedAt: record.updatedAt.toISOString(),
  }
}



export async function listAdminPostsData(input: {
  search?: string
  page: number
  pageSize: number
}): Promise<{ items: AdminPostRow[]; pagination: Pagination }> {
  const where: Prisma.PostWhereInput = {}

  if (input.search?.trim()) {
    const keyword = input.search.trim()
    where.OR = [
      { content: { contains: keyword, mode: 'insensitive' } },
      { author: { nickname: { contains: keyword, mode: 'insensitive' } } },
    ]
  }

  const [total, records] = await Promise.all([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        author: { select: { id: true, nickname: true, avatarUrl: true } },
        topic: { select: { name: true } },
      },
    }),
  ])

  const items: AdminPostRow[] = records.map((record) => ({
    id: record.id,
    excerpt: excerptContent(record.content),
    imageCount: record.imageUrls.length,
    likeCount: record.likeCount,
    commentCount: record.commentCount,
    createdAt: record.createdAt.toISOString(),
    topicTitle: record.topic?.name ?? null,
    author: { id: record.author.id, nickname: record.author.nickname, avatarUrl: record.author.avatarUrl },
  }))

  return { items, pagination: buildPagination(input.page, input.pageSize, total) }
}



export async function listAdminCommentsData(input: {
  /** 评论分类：novel=作品评论（含章节评论/段落评论），post=帖子评论 */
  category?: string
  search?: string
  page: number
  pageSize: number
}): Promise<{ items: AdminCommentRow[]; pagination: Pagination }> {
  const where: Prisma.CommentWhereInput = {}

  if (input.category === 'novel') {
    where.targetType = { in: ['novel', 'chapter'] }
  } else if (input.category === 'post') {
    where.targetType = 'post'
  }
  if (input.search?.trim()) {
    const keyword = input.search.trim()
    where.OR = [
      { content: { contains: keyword, mode: 'insensitive' } },
      { author: { nickname: { contains: keyword, mode: 'insensitive' } } },
    ]
  }

  const [total, records] = await Promise.all([
    prisma.comment.count({ where }),
    prisma.comment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        author: { select: { id: true, nickname: true, avatarUrl: true } },
        novel: { select: { id: true, title: true, displayTitle: true } },
        chapter: { select: { id: true, title: true, novelId: true, novel: { select: { id: true, title: true } } } },
        post: { select: { id: true, content: true } },
      },
    }),
  ])

  const items: AdminCommentRow[] = records.map((record) => {
    let targetTitle: string | null = null
    let targetHref: string | null = null

    if (record.targetType === 'novel' && record.novel) {
      targetTitle = record.novel.displayTitle ?? record.novel.title
      targetHref = `/novel/${record.novel.id}`
    } else if (record.targetType === 'chapter' && record.chapter) {
      targetTitle = `《${record.chapter.novel.title}》${record.chapter.title}`
      targetHref = `/novel/${record.chapter.novelId}/read/${record.chapter.id}`
    } else if (record.targetType === 'post' && record.post) {
      targetTitle = excerptContent(record.post.content)
      targetHref = `/post/${record.post.id}`
    }

    return {
      id: record.id,
      content: excerptContent(record.content),
      targetType: record.targetType,
      paragraphIndex: record.paragraphIndex ?? null,
      targetTitle,
      likeCount: record.likeCount,
      replyCount: record.replyCount,
      createdAt: record.createdAt.toISOString(),
      author: { id: record.author.id, nickname: record.author.nickname, avatarUrl: record.author.avatarUrl },
      targetHref,
    }
  })

  return { items, pagination: buildPagination(input.page, input.pageSize, total) }
}



export async function getAdminPostDetailData(postId: string): Promise<AdminPostDetailPayload | null> {
  const record = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      author: { select: { id: true, nickname: true, avatarUrl: true } },
      topic: { select: { name: true } },
      comments: {
        where: { parentId: null },
        orderBy: { createdAt: 'asc' },
        include: {
          author: { select: { id: true, nickname: true, avatarUrl: true } },
          replies: {
            orderBy: { createdAt: 'asc' },
            include: { author: { select: { id: true, nickname: true, avatarUrl: true } } },
          },
        },
      },
    },
  })
  if (!record) {
    return null
  }

  return {
    post: {
      id: record.id,
      content: record.content,
      imageUrls: record.imageUrls,
      likeCount: record.likeCount,
      commentCount: record.commentCount,
      createdAt: record.createdAt.toISOString(),
      topicTitle: record.topic?.name ?? null,
      author: record.author,
    },
    comments: record.comments.map((comment) => ({
      id: comment.id,
      content: comment.content,
      likeCount: comment.likeCount,
      replyCount: comment.replyCount,
      createdAt: comment.createdAt.toISOString(),
      author: comment.author,
      replies: comment.replies.map((reply) => ({
        id: reply.id,
        content: reply.content,
        createdAt: reply.createdAt.toISOString(),
        author: reply.author,
      })),
    })),
  }
}



export async function listAdminConversationsData(input: {
  search?: string
  page: number
  pageSize: number
}): Promise<{ items: AdminConversationRow[]; pagination: Pagination }> {
  const where: Prisma.ConversationWhereInput = {}

  if (input.search?.trim()) {
    const keyword = input.search.trim()
    where.members = { some: { user: { nickname: { contains: keyword, mode: 'insensitive' } } } }
  }

  const [total, records] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        members: { include: { user: { select: { id: true, nickname: true, avatarUrl: true } } } },
        _count: { select: { messages: true } },
      },
    }),
  ])

  const items: AdminConversationRow[] = records.map((record) => ({
    id: record.id,
    type: record.type,
    title: record.title,
    lastMessagePreview: record.lastMessagePreview,
    lastMessageAt: toIso(record.lastMessageAt),
    messageCount: record._count.messages,
    members: record.members.map((member) => member.user),
  }))

  return { items, pagination: buildPagination(input.page, input.pageSize, total) }
}



export async function getAdminConversationMessagesData(conversationId: string): Promise<AdminMessageRow[] | null> {
  const exists = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } })
  if (!exists) {
    return null
  }

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: 2000,
    include: { sender: { select: { id: true, nickname: true, avatarUrl: true } } },
  })

  return messages.map((message) => ({
    id: message.id,
    content: message.content,
    type: message.type,
    createdAt: message.createdAt.toISOString(),
    sender: message.sender,
  }))
}



export async function listAdminAuditLogsData(input: {
  action?: string
  targetType?: string
  page: number
  pageSize: number
}): Promise<{ items: AdminAuditLogRow[]; pagination: Pagination }> {
  const where: Prisma.AdminAuditLogWhereInput = {}

  if (input.action?.trim()) {
    where.action = input.action.trim()
  }
  if (input.targetType?.trim()) {
    where.targetType = input.targetType.trim()
  }

  const [total, records] = await Promise.all([
    prisma.adminAuditLog.count({ where }),
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ])

  const adminIds = [...new Set(records.map((record) => record.adminId))]
  const admins = adminIds.length
    ? await prisma.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, nickname: true } })
    : []
  const adminNames = new Map(admins.map((admin) => [admin.id, admin.nickname]))

  const items: AdminAuditLogRow[] = records.map((record) => ({
    id: record.id,
    adminId: record.adminId,
    adminNickname: adminNames.get(record.adminId) ?? null,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    detail: (record.detail ?? {}) as Record<string, unknown>,
    ip: record.ip,
    createdAt: record.createdAt.toISOString(),
  }))

  return { items, pagination: buildPagination(input.page, input.pageSize, total) }
}
