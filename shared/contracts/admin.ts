import type { Pagination } from './models.js'

/* ========================================================================== */
/* 后台管理系统契约（方案 18）—— /api/admin/* 命名空间                            */
/* ========================================================================== */

export type AdminBriefUser = {
  id: string
  nickname: string
  avatarUrl: string | null
}

export type AdminUserRow = {
  id: string
  nickname: string
  avatarUrl: string | null
  phone: string | null
  email: string | null
  role: 'user' | 'author' | 'admin'
  bannedAt: string | null
  createdAt: string
  lastActiveAt: string | null
  isOnline: boolean
  novelCount: number
  postCount: number
  followerCount: number
}

export type AdminUserDetailPayload = {
  user: AdminUserRow & { bio: string | null }
  stats: { novels: number; posts: number; comments: number; favorites: number; totalTokens: number; webSearchCalls: number; imageCalls: number }
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
  status: 'draft' | 'published' | 'completed' | 'archived'
  visibility: 'public' | 'followers' | 'private'
  categoryName: string | null
  wordCount: number
  chapterCount: number
  commentCount: number
  favoriteCount: number
  publishedAt: string | null
  updatedAt: string
  author: AdminBriefUser
}

export type AdminNovelDetailPayload = {
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
}

export type AdminChapterContentPayload = {
  id: string
  title: string
  orderIndex: number
  status: string
  wordCount: number
  content: string
  publishedAt: string | null
  updatedAt: string
}

export type AdminPostRow = {
  id: string
  excerpt: string
  imageCount: number
  likeCount: number
  commentCount: number
  createdAt: string
  topicTitle: string | null
  author: AdminBriefUser
}

export type AdminCommentRow = {
  id: string
  content: string
  targetType: 'novel' | 'chapter' | 'post'
  /** 段评所属正文段落序号（仅章节评论）；非空即段落评论 */
  paragraphIndex: number | null
  targetTitle: string | null
  likeCount: number
  replyCount: number
  createdAt: string
  author: AdminBriefUser
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
    author: AdminBriefUser
  }
  comments: Array<{
    id: string
    content: string
    likeCount: number
    replyCount: number
    createdAt: string
    author: AdminBriefUser
    replies: Array<{
      id: string
      content: string
      createdAt: string
      author: AdminBriefUser
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
  members: AdminBriefUser[]
}

export type AdminMessageRow = {
  id: string
  content: string
  type: string
  createdAt: string
  sender: AdminBriefUser
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

export type AdminListPayload<T> = {
  items: T[]
  pagination: Pagination
}

export type AdminMePayload = {
  id: string
  nickname: string
  email: string | null
  phone: string | null
  role: string
  /** 超级管理（唯一）：仅超级管理可设置用户身份 */
  isSuperAdmin: boolean
}

/** 管理后台登录：邮箱+密码 / 手机号+密码 / 手机号+短信验证码（后两者 captcha 仅在发码环节校验） */
export type AdminLoginRequest = {
  email?: string
  phone?: string
  password?: string
  code?: string
  captchaId?: string
  captchaAnswer?: string
}

export type AdminCaptchaPayload = {
  captchaId: string
  imageBase64: string
  expiresInSeconds: number
}

/* ========================================================================== */
/* 管理端：用户详情可下钻的关联内容（粉丝/收藏作品/创作记录）                     */
/* ========================================================================== */

/** 管理端查看某用户的粉丝列表条目 */
export type AdminUserFollowRow = {
  id: string
  nickname: string
  avatarUrl: string | null
  followerCount: number
  isOnline: boolean
  followedAt: string
}

/** 管理端查看某用户收藏的作品条目 */
export type AdminUserFavoriteNovelRow = {
  id: string
  title: string
  displayTitle: string | null
  status: string
  wordCount: number
  chapterCount: number
  favoriteCount: number
  favoritedAt: string
  author: AdminBriefUser
}

/** 管理端创作记录：单部作品下的一个 Agent 会话 */
export type AdminCreationSessionRow = {
  id: string
  title: string
  status: string
  runCount: number
  lastRunAt: string | null
  createdAt: string
  totalTokens: number
}

/** 管理端创作记录：单部作品 + 其下 Agent 会话列表 */
export type AdminCreationRecordNovelRow = {
  novelId: string
  title: string
  displayTitle: string | null
  status: string
  chapterCount: number
  wordCount: number
  updatedAt: string
  totalTokens: number
  sessions: AdminCreationSessionRow[]
}

export type AdminCreationRecordsPayload = {
  user: AdminBriefUser
  novels: AdminCreationRecordNovelRow[]
}

/** 管理端创作记录索引：有 Agent 会话记录的作者（含作品/会话统计，供免搜索列表展示） */
export type AdminCreationRecordsIndexRow = {
  id: string
  nickname: string
  avatarUrl: string | null
  novelCount: number
  sessionCount: number
  lastSessionAt: string | null
}

export type AdminCreationRecordsIndexPayload = {
  items: AdminCreationRecordsIndexRow[]
  /** 符合筛选条件的创作者总数（用于管理端分页） */
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

/** 管理端查看单个 Agent 会话的聊天记录：run 与消息 */
export type AdminAgentRunRow = {
  id: string
  mode: string
  action: string
  status: string
  inputSummary: string | null
  outputSummary: string | null
  errorMessage: string | null
  createdAt: string
  finishedAt: string | null
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  messages: Array<{
    id: string
    runId: string
    role: 'user' | 'assistant'
    parts: unknown[]
    createdAt: string
  }>
}

export type AdminAgentSessionMessagesPayload = {
  session: {
    id: string
    title: string
    novelTitle: string
    displayTitle: string | null
    createdAt: string
  }
  runs: AdminAgentRunRow[]
  /** 是否还有更早的 run（轮次分页） */
  hasMore: boolean
  /** 加载更早一轮时回传的游标（本页最早 run 的 id） */
  nextCursor: string | null
}

export type AdminTokenManagementPayload = {
  period?: 'today' | 'week' | 'month'
  periodStartedAt?: string
  summary: {
    totalTokens: number
    requestTokens: number
    responseTokens: number
    /** 已观测到的缓存命中/未命中输入 token；是否可观测由 cacheObservedTokens 与 requestTokens 对比。 */
    cacheHitTokens: number
    cacheMissTokens: number
    cacheObservedTokens: number
    users: number
    webSearchCalls: number
    imageCalls: number
  }
  users: Array<{
    user: AdminBriefUser
    totalTokens: number
    requestTokens: number
    responseTokens: number
    requestCount: number
    webSearchCalls: number
    imageCalls: number
  }>
  actions: Array<{
    action: string
    totalTokens: number
    requestTokens: number
    responseTokens: number
    requestCount: number
    averageTokens: number
  }>
  models?: Array<{
    modelTier: string
    modelLabel: string
    providerName: string | null
    modelName: string
    totalTokens: number
    requestTokens: number
    responseTokens: number
    cacheHitTokens: number
    cacheMissTokens: number
    cacheObservedTokens: number
    requestCount: number
  }>
  /** Agent 运行级缓存聚合（按 runId 分组，取消耗前 20） */
  runs?: Array<{
    runId: string
    promptTokens: number
    responseTokens: number
    hitTokens: number
    missTokens: number
    cacheObservedTokens: number
    chargedMilli: number
    turns: number
    requests: number
    startedAt: string
  }>
  /** 最近 Agent 调用逐轮明细；缓存字段为 null 表示供应商未返回，而 0 表示已观测但未命中。 */
  runTurns?: Array<{
    id: string
    runId: string
    scope: 'main' | 'subagent'
    targetId: string | null
    turn: number | null
    providerName: string | null
    modelName: string
    promptTokens: number
    responseTokens: number
    hitTokens: number | null
    missTokens: number | null
    chargedMilli: number
    createdAt: string
  }>
  trend?: Array<{ date: string; requestTokens: number; responseTokens: number }>
}

export type AdminCreditsManagementPayload = {
  summary: {
    globallyPaused: boolean
    users: number
    dailyAllowance: number
    dailyUsed: number
    bonusBalance: number
    exhaustedUsers: number
  }
  users: Array<{
    user: AdminBriefUser
    planLabel: '公测版'
    dailyAllowance: number
    dailyUsed: number
    dailyRemaining: number
    bonusBalance: number
    totalRemaining: number
    usedPercent: number
    resetsAt: string
    suspended: boolean
  }>
}

export type AdminModelManagementPayload = {
  models: Array<{
    routes?: import('./model-routes.js').ModelRouteView[]
    id: string
    pricing?: import('./credits.js').CreditLedgerItem['pricing']
    tier: string | null
    modelKind: 'text' | 'image_generation' | 'vision' | 'web_search'
    provider: string
    displayName: string
    modelName: string
    baseUrl: string | null
    multiplier: number
    enabled: boolean
    selectable: boolean
    isDefault: boolean
    apiKeyConfigured: boolean
    requestCount: number
    requestTokens: number
    responseTokens: number
    reasoningEfforts: import('./credits.js').ModelReasoningEffort[]
    defaultReasoningEffort: import('./credits.js').ModelReasoningEffort
    visionEnabled: boolean
    contextWindowTokens: number | null
    configurationReady: boolean
    updatedAt: string
  }>
  trend: Array<{ date: string; requests: number; totalTokens: number }>
}
