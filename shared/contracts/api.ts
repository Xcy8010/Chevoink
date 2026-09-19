import type {
  AiImageSize,
  AiProviderMode,
  AiUsageLog,
  AgentArtifact,
  AgentRun,
  AgentSession,
  AuthorPagePayload,
  AuthorSummary,
  Chapter,
  ChapterStatus,
  Comment,
  CommentTargetType,
  Conversation,
  CoverAsset,
  FollowUserItem,
  HomePagePayload,
  InteractionBadges,
  InteractionItem,
  PrivacySettings,
  UserReplyItem,
  Message,
  Novel,
  NovelCard,
  NovelDetailPayload,
  Pagination,
  PostDetailPayload,
  Post,
  AgentRunStatus,
  ProjectMemoryEntry,
  ReaderPayload,
  ReadingProgressItem,
  ReceivedLikeItem,
  StudioPayload,
  User,
  UserMePayload,
  Visibility,
} from './models.js'

export type ApiSuccess<T> = {
  success: true
  data: T
  requestId: string
}

export type ApiFailure = {
  success: false
  error: {
    code: string
    message: string
    fieldErrors?: Record<string, string>
  }
  requestId: string
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

export type AuthTokenPair = {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

export type RegisterRequest = {
  email?: string
  phone?: string
  password?: string
  nickname: string
  referralCode?: string
}

export type LoginRequest = {
  phone: string
  password: string
}

export type AuthSessionPayload = {
  user: User
  tokens: AuthTokenPair
}

export type SmsAuthPurpose = 'login' | 'register' | 'auth' | 'reset_password'

export type SmsAccountStatus = 'existing' | 'new'

export type GetAuthCaptchaResponse = ApiSuccess<{
  captchaId: string
  imageBase64: string
  expiresInSeconds: number
}>

export type SendSmsCodeRequest = {
  phone: string
  purpose: SmsAuthPurpose
  captchaId: string
  captchaAnswer: string
}

export type SendSmsCodeResponse = ApiSuccess<{
  ok: true
  expireInSeconds: number
  cooldownSeconds: number
  provider: 'tencentcloud'
  accountStatus: SmsAccountStatus
  normalizedPhone: string
}>

export type SmsLoginRequest = {
  phone: string
  code: string
}

export type SmsRegisterRequest = {
  phone: string
  code: string
  password?: string
  referralCode?: string
}

export type UpdateMyProfileRequest = {
  nickname: string
  bio?: string
}

export type UpdateMyProfileResponse = ApiSuccess<{
  user: User
}>

export type UpdateMyAvatarRequest = {
  avatarDataUrl: string | null
}

export type UpdateMyAvatarResponse = ApiSuccess<{
  user: User
}>

export type UpdateMyCoverRequest = {
  coverDataUrl: string | null
}

export type UpdateMyCoverResponse = ApiSuccess<{
  user: User
}>

export type UpdateMyPasswordRequest = {
  password: string
  /** 已设置密码的账号修改密码：需提供旧密码或手机验证码二选一 */
  oldPassword?: string
  code?: string
}

export type SendPasswordResetCodeResponse = ApiSuccess<{
  ok: true
  expireInSeconds: number
  cooldownSeconds: number
  provider: 'tencentcloud'
}>

export type UpdateMyPasswordResponse = ApiSuccess<{
  user: User
}>

export type GetMeResponse = ApiSuccess<UserMePayload>

export type GetHomeResponse = ApiSuccess<HomePagePayload>

export type ListNovelsResponse = ApiSuccess<{
  items: NovelCard[]
  pagination: Pagination
}>

/** 批量拉取作品卡片（首页继续阅读等轻量场景，方案 20 §2.5） */
export type ListNovelCardsResponse = ApiSuccess<{
  items: NovelCard[]
}>

/** 我收藏的作品列表（按收藏时间倒序） */
export type ListFavoriteNovelsResponse = ApiSuccess<{
  items: NovelCard[]
}>

export type GetNovelDetailResponse = ApiSuccess<NovelDetailPayload>

export type GetReaderResponse = ApiSuccess<ReaderPayload>

export type GetStudioResponse = ApiSuccess<StudioPayload>

export type CreateNovelRequest = {
  title: string
  displayTitle?: string
  summary: string
  categoryId?: string
  tags: string[]
  visibility?: Visibility
  status?: Extract<Novel['status'], 'draft' | 'published'>
}

export type UpdateNovelRequest = Omit<Partial<CreateNovelRequest>, 'status'> & {
  status?: Novel['status']
  pinned?: boolean
  coverAssetId?: string | null
  coverPrompt?: string | null
}

export type CreateNovelResponse = ApiSuccess<{ novel: Novel }>
export type UpdateNovelResponse = ApiSuccess<{ novel: Novel }>
export type UploadNovelCoverRequest = {
  coverDataUrl: string
}
export type UploadNovelCoverResponse = ApiSuccess<{
  novel: Novel
  asset: CoverAsset
}>
export type DeleteNovelResponse = ApiSuccess<{
  deleted: true
  novelId: string
}>

export type PublishNovelRequest = {
  chapterIds: string[]
  visibility?: Visibility
}

export type PublishNovelResponse = ApiSuccess<{
  novel: Novel
  publishedChapterIds: string[]
}>

export type CreateChapterRequest = {
  title: string
  summary?: string
  content: string
  status: ChapterStatus
  visibility?: Visibility
  /** 缺省时追加到最后一卷；保留缺省以兼容 Agent 1.0 与旧 APP。 */
  volumeId?: string
  /** 卷内插入位置；缺省时追加。 */
  orderInVolume?: number
}

export type UpdateChapterRequest = Partial<CreateChapterRequest> & {
  /** 新客户端必须回传；旧 APP 缺省时服务端走兼容写入，但仍递增 revision。 */
  expectedRevision?: number
}

export type GetChapterResponse = ApiSuccess<{ chapter: Chapter }>
export type CreateChapterResponse = ApiSuccess<{ chapter: Chapter }>
export type UpdateChapterResponse = ApiSuccess<{ chapter: Chapter }>
export type DeleteChapterResponse = ApiSuccess<{ deleted: true }>

export type ListCommentsResponse = ApiSuccess<{
  items: Comment[]
  pagination: Pagination
}>

export type CreateCommentRequest = {
  targetType: CommentTargetType
  targetId: string
  content: string
  parentId?: string
  /** 作品评论的评星（1-5）；仅 targetType=novel 的根评论必填 */
  rating?: number
  /** 章节段评：所属段落序号（0 起）；仅 targetType=chapter 的根评论有效 */
  paragraphIndex?: number | null
}

export type CreateCommentResponse = ApiSuccess<{ comment: Comment }>

export type UpdateCommentRequest = {
  content: string
  /** 作品根评论可同步修改评星（1-5） */
  rating?: number
}

export type UpdateCommentResponse = ApiSuccess<{ comment: Comment }>

export type DeleteCommentResponse = ApiSuccess<{ deletedCount: number }>

export type ListPostsResponse = ApiSuccess<{
  items: Post[]
  pagination: Pagination
  /** 推荐流快照时间：翻页时回传，同一轮浏览榜单冻结不跳位 */
  snapshotAt?: string
}>

/** 社区面板统计：独立于分页的准确总数口径 */
export type PostStatsResponse = ApiSuccess<{
  totalPosts: number
  linkedNovelCount: number
  lastPostAt: string | null
}>

export type GetPostDetailResponse = ApiSuccess<PostDetailPayload>

export type GetTopicsResponse = ApiSuccess<{
  items: import('./models.js').TopicSummary[]
}>

/** 推荐话题（方案 18 §3.4）：按近 7 天趋势分取前 3 个 */
export type GetRecommendedTopicsResponse = ApiSuccess<{
  items: import('./models.js').TopicSummary[]
}>

/** 话题详情：按 slug/name/id 解析 */
export type GetTopicResponse = ApiSuccess<{
  topic: import('./models.js').TopicSummary
}>

export type CreatePostRequest = {
  content: string
  topicId?: string
  imageUrls?: string[]
  /** 发帖配图（base64 data URL，最多 9 张），服务端落盘后写入 imageUrls */
  imageDataUrls?: string[]
  relatedNovelId?: string
  /** 分享作者主页到社区时携带的作者 id */
  sharedUserId?: string
}

export type CreatePostResponse = ApiSuccess<{ post: Post }>

/** 删除自己的帖子（连同评论/点赞/收藏一并清理） */
export type DeletePostResponse = ApiSuccess<{ deleted: boolean }>

/** 帖子点赞：POST/DELETE /api/posts/:postId/like */
export type SetPostLikeResponse = ApiSuccess<{ liked: boolean; likeCount: number }>

/** 帖子收藏：POST/DELETE /api/posts/:postId/bookmark */
export type SetPostBookmarkResponse = ApiSuccess<{ bookmarked: boolean; favoriteCount: number }>

/** 作品收藏：POST/DELETE /api/novels/:novelId/favorite */
export type SetNovelFavoriteResponse = ApiSuccess<{ favorited: boolean; favoriteCount: number }>

/** 云端书架+阅读进度列表：GET /api/users/me/reading-progress（按 updatedAt 倒序） */
export type ListReadingProgressResponse = ApiSuccess<{ items: ReadingProgressItem[] }>

/** 保存书架/阅读进度：POST /api/users/me/reading-progress */
export type SaveReadingProgressRequest = {
  novelId: string
  novelTitle: string
  coverUrl?: string | null
  chapterId?: string | null
  chapterTitle?: string | null
  chapterOrder?: number
  totalChapters?: number
  scrollPercent?: number
  /** 仅更新章内滚动位置时置 true：章节不匹配则忽略，不新建行 */
  scrollOnly?: boolean
  /** 仅加入书架（未开始阅读）时置 true：已存在则保留原有进度不重置 */
  shelfOnly?: boolean
}

export type SaveReadingProgressResponse = ApiSuccess<{ item: ReadingProgressItem }>

/** 从书架移除（删除该书的进度行）：DELETE /api/users/me/reading-progress/:novelId */
export type RemoveReadingProgressResponse = ApiSuccess<{ removed: boolean }>

/** 本章划线段落列表：GET /api/users/me/underlines?chapterId= */
export type ListParagraphUnderlinesResponse = ApiSuccess<{ paragraphIndexes: number[] }>

/** 新增划线（幂等）：PUT /api/users/me/underlines */
export type SaveParagraphUnderlineRequest = {
  novelId: string
  chapterId: string
  paragraphIndex: number
}

export type SaveParagraphUnderlineResponse = ApiSuccess<{ saved: boolean }>

/** 取消划线：DELETE /api/users/me/underlines?chapterId=&paragraphIndex= */
export type RemoveParagraphUnderlineResponse = ApiSuccess<{ removed: boolean }>

/** 评论点赞：POST/DELETE /api/comments/:commentId/like */
export type SetCommentLikeResponse = ApiSuccess<{ liked: boolean; likeCount: number }>

/** 关注/取关用户：POST/DELETE /api/users/:userId/follow */
export type SetUserFollowResponse = ApiSuccess<{ following: boolean; followerCount: number }>

/** 粉丝/关注中列表：GET /api/users/:userId/followers | /api/users/:userId/following */
export type ListFollowUsersResponse = ApiSuccess<{ items: FollowUserItem[]; total: number; restricted?: boolean }>

/** 隐私设置更新：PATCH /api/users/me/privacy */
export type UpdatePrivacyRequest = Partial<PrivacySettings>

export type UpdatePrivacyResponse = ApiSuccess<PrivacySettings>

/** 喜欢（赞过的帖子）：GET /api/users/:userId/liked-posts */
export type ListLikedPostsResponse = ApiSuccess<{ items: Post[]; total: number; restricted?: boolean }>

/** 收藏的帖子（仅本人可见）：GET /api/users/:userId/bookmarked-posts */
export type ListBookmarkedPostsResponse = ApiSuccess<{ items: Post[]; total: number; restricted?: boolean }>

/** 已回复（发出的评论）：GET /api/users/:userId/replies */
export type ListUserRepliesResponse = ApiSuccess<{ items: UserReplyItem[]; total: number; restricted?: boolean }>

/** 获赞明细：GET /api/users/me/received-likes */
export type ListReceivedLikesResponse = ApiSuccess<{ items: ReceivedLikeItem[]; total: number }>

/** 互动消息（赞/收藏/作品评论/章节评论）：GET /api/users/me/interactions */
export type ListInteractionsResponse = ApiSuccess<{ items: InteractionItem[]; total: number }>

/** 互动/新关注未读徽标：GET /api/users/me/interaction-badges */
export type GetInteractionBadgesResponse = ApiSuccess<InteractionBadges>

/** 标记互动/新关注已读：POST /api/users/me/interaction-badges/seen */
export type MarkInteractionSeenRequest = {
  target: 'interactions' | 'followers'
}

export type MarkInteractionSeenResponse = ApiSuccess<InteractionBadges>

/** 创建/复用双人直聊会话：POST /api/conversations */
export type CreateConversationRequest = {
  targetUserId: string
}

export type CreateConversationResponse = ApiSuccess<{ conversation: Conversation }>

export type ListConversationsResponse = ApiSuccess<{
  items: Conversation[]
  pagination: Pagination
}>

export type ListMessagesResponse = ApiSuccess<{
  conversation: Conversation | null
  items: Message[]
  pagination: Pagination
}>

export type SendMessageRequest = {
  type: Message['type']
  content: string
  relatedId?: string
}

export type SendMessageResponse = ApiSuccess<{ message: Message }>

/** 会话已读：POST /api/conversations/:conversationId/read */
export type MarkConversationReadResponse = ApiSuccess<{ conversationId: string; lastReadAt: string }>

export type GetAuthorPageResponse = ApiSuccess<AuthorPagePayload>

export type GenerateOutlineRequest = {
  theme: string
  genre: string
  tone?: string
  targetLength?: 'short' | 'medium' | 'long'
}

export type GenerateOutlineResponse = ApiSuccess<{
  outline: string
  providerMode: AiProviderMode
}>

export type ChapterAssistRequest = {
  mode: 'continue' | 'rewrite' | 'polish' | 'summarize'
  content: string
  novelId?: string
  chapterId?: string
}

export type ChapterAssistResponse = ApiSuccess<{
  result: string
  summary?: string
  providerMode: AiProviderMode
}>

export type GenerateCoverPromptRequest = {
  novelTitle: string
  summary: string
  genre: string
  protagonist?: string
  stylePreference?: string
}

export type GenerateCoverPromptResponse = ApiSuccess<{
  prompt: string
  negativePrompt?: string
  visualKeywords: string[]
  providerMode: AiProviderMode
}>

export type GenerateCoverImageRequest = {
  prompt: string
  size: AiImageSize
  count: number
  novelId?: string | null
}

export type GenerateCoverImageResponse = ApiSuccess<{
  images: CoverAsset[]
  providerMode: AiProviderMode
}>

export type ListAgentSessionsResponse = ApiSuccess<{
  items: AgentSession[]
}>

/** 侧栏任务窗口状态轮询：每个会话最新一条 run 的状态（近期无 run 为 null）。
 * running/queued→转圈、awaiting_approval→黄点（同时覆盖权限审批与 ask_user 挂起）、
 * completed/failed/cancelled→终态（绿/红点，仅本页面会话内由事件层实时记录，此接口不回传历史终态）。 */
export type AgentSessionRunStatus = {
  authorEnded?: { fulfilled: boolean; todoItems?: import('./agent-events.js').AgentTodoItem[] }
  runId: string
  status: AgentRunStatus
  finishedAt: string | null
}

export type AgentSessionRunStatusPayload = {
  statuses: Record<string, AgentSessionRunStatus | null>
}

export type CreateAgentSessionRequest = {
  novelId: string
  title?: string
}

export type CreateAgentSessionResponse = ApiSuccess<{
  session: AgentSession
}>

export type UpdateAgentSessionRequest = {
  title?: string
  status?: 'active' | 'archived'
  pinned?: boolean
  toolPolicy?: import('./agent-productivity.js').AgentSessionToolPolicy
  sandboxMode?: import('./agent-productivity.js').AgentSandboxMode
}

export type UpdateAgentSessionResponse = ApiSuccess<{
  session: AgentSession
}>

export type DeleteAgentSessionResponse = ApiSuccess<{
  sessionId: string
  deleted: true
}>

export type AgentRunResultPayload = {
  run: AgentRun
  artifacts: AgentArtifact[]
  memoryEntries: ProjectMemoryEntry[]
}

export type AgentActionResultPayload = AgentRunResultPayload & {
  artifact: AgentArtifact | null
  title: string
  content: string
  summary: string | null
  artifactType: AgentArtifact['artifactType'] | null
  activeAgent?: import('./models.js').AgentExecutionAgent | null
  routeDecision?: import('./models.js').AgentRouteDecision | null
  ruleBundle?: import('./models.js').AgentRuleBundle | null
  storyMemoryDigest?: import('./models.js').AgentStoryMemoryDigest | null
  executionMode?: import('./models.js').AgentExecutionMode | null
  actionPlan?: import('./models.js').AgentActionPlan | null
  stepResults?: import('./models.js').AgentExecutionStepResult[] | null
  handoff?: import('./models.js').AgentActionHandoff | null
  toolPolicy?: import('./models.js').AgentWorkspaceToolPolicy | null
  stream?: {
    liveUrl?: string
    replayUrl?: string
  } | null
  result?: string
  prompt?: string
  outline?: string
}

export type ListAgentSessionHistoryResponse = ApiSuccess<{
  items: AgentActionResultPayload[]
}>

export type AgentActionResponse = ApiSuccess<AgentActionResultPayload>

export type GetAiConfigResponse = ApiSuccess<{
  textModelLabel: string
  imageModelLabel: string
  providerMode: AiProviderMode
  contextWindow: {
    maxTokens: number
    softLimit: number
    compressLevel1: number
    compressLevel2: number
  }
}>

export type GetApiContractSummaryResponse = ApiSuccess<{
  version: string
  resources: string[]
  endpoints: ApiEndpointDefinition[]
  entityNames: string[]
  snapshot: LocalContractSnapshot
}>

export type ApiEndpointDefinition = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  summary: string
}

export const apiEndpointCatalog: ApiEndpointDefinition[] = [
  { method: 'GET', path: '/api/health', summary: '服务健康检查' },
  { method: 'GET', path: '/api/meta', summary: '项目元信息与模块状态' },
  { method: 'GET', path: '/api/meta/contracts', summary: '接口契约清单与实体索引' },
  { method: 'GET', path: '/api/auth/captcha', summary: '获取登录注册前的人机验证挑战' },
  { method: 'POST', path: '/api/auth/register', summary: '本地注册并建立服务端会话' },
  { method: 'POST', path: '/api/auth/login', summary: '本地登录并建立服务端会话' },
  { method: 'POST', path: '/api/auth/sms/send-code', summary: '完成人机验证后发送短信验证码' },
  { method: 'POST', path: '/api/auth/sms/register', summary: '通过手机号验证码注册并建立服务端会话' },
  { method: 'POST', path: '/api/auth/sms/login', summary: '通过手机号验证码登录并建立服务端会话' },
  { method: 'POST', path: '/api/auth/logout', summary: '退出当前服务端会话' },
  { method: 'GET', path: '/api/users/me', summary: '当前用户信息与未读统计' },
  { method: 'PATCH', path: '/api/users/me/profile', summary: '更新当前用户的个人信息' },
  { method: 'PATCH', path: '/api/users/me/avatar', summary: '更新当前用户头像' },
  { method: 'PATCH', path: '/api/users/me/password', summary: '为当前账号设置登录密码' },
  { method: 'GET', path: '/api/users/:userId', summary: '用户或作者主页摘要信息' },
  { method: 'GET', path: '/api/users/:userId/author-page', summary: '作者主页聚合数据' },
  { method: 'GET', path: '/api/home', summary: '首页发现聚合数据' },
  { method: 'GET', path: '/api/topics', summary: '社区话题列表' },
  { method: 'GET', path: '/api/novels', summary: '小说列表与筛选结果' },
  { method: 'POST', path: '/api/novels', summary: '新建小说' },
  { method: 'PATCH', path: '/api/novels/:novelId', summary: '更新小说元信息' },
  { method: 'PATCH', path: '/api/novels/:novelId/cover', summary: '上传并设置作品封面' },
  { method: 'GET', path: '/api/novels/:novelId/detail', summary: '小说详情页数据' },
  { method: 'GET', path: '/api/novels/:novelId/studio', summary: '创作工作台聚合数据' },
  { method: 'GET', path: '/api/novels/:novelId/reader/:chapterId', summary: '阅读页数据' },
  { method: 'GET', path: '/api/novels/:novelId/chapters/:chapterId', summary: '创作区单章详情' },
  { method: 'POST', path: '/api/novels/:novelId/chapters', summary: '新建章节' },
  { method: 'PATCH', path: '/api/novels/:novelId/chapters/:chapterId', summary: '更新章节' },
  { method: 'DELETE', path: '/api/novels/:novelId', summary: '删除作品' },
  { method: 'DELETE', path: '/api/novels/:novelId/chapters/:chapterId', summary: '删除章节' },
  { method: 'GET', path: '/api/comments', summary: '按目标获取评论列表' },
  { method: 'POST', path: '/api/comments', summary: '发表评论或回复' },
  { method: 'GET', path: '/api/posts', summary: '社区帖子列表' },
  { method: 'GET', path: '/api/posts/:postId', summary: '帖子详情与评论' },
  { method: 'POST', path: '/api/posts', summary: '发布帖子' },
  { method: 'GET', path: '/api/conversations', summary: '会话列表' },
  { method: 'GET', path: '/api/conversations/:conversationId/messages', summary: '消息列表' },
  { method: 'POST', path: '/api/conversations/:conversationId/messages', summary: '发送消息' },
  { method: 'GET', path: '/api/ai/config', summary: 'AI 公开档位与上下文配置' },
  { method: 'POST', path: '/api/ai/novel-outline', summary: 'AI 大纲生成' },
  { method: 'POST', path: '/api/ai/chapter-assist', summary: 'AI 章节辅助' },
  { method: 'POST', path: '/api/ai/cover-prompt', summary: 'AI 封面提示词优化' },
  { method: 'POST', path: '/api/ai/cover-image', summary: 'AI 封面生成' },
  { method: 'GET', path: '/api/agent/sessions', summary: '按小说获取 Agent 会话列表' },
  { method: 'POST', path: '/api/agent/sessions', summary: '创建小说 Agent 会话' },
  { method: 'PATCH', path: '/api/agent/sessions/:sessionId', summary: '更新 Agent 会话标题' },
  { method: 'DELETE', path: '/api/agent/sessions/:sessionId', summary: '删除 Agent 会话' },
  { method: 'POST', path: '/api/agent/runs', summary: '创建并执行一次 Agent 任务' },
  { method: 'GET', path: '/api/agent/runs/:runId/stream', summary: '以 SSE 获取 Agent 执行流' },
]

export const contractEntityNames = [
  'User',
  'AuthorSummary',
  'Novel',
  'NovelCard',
  'Chapter',
  'ChapterListItem',
  'Comment',
  'Post',
  'Conversation',
  'Message',
  'CoverAsset',
  'AiUsageLog',
  'AgentSession',
  'AgentRun',
  'AgentArtifact',
  'ProjectMemoryEntry',
]

export type LocalContractSnapshot = {
  currentUser: User
  featuredAuthor: AuthorSummary
  highlightedNovel: Novel
  highlightedChapter: Chapter
  highlightedPost: Post
  highlightedConversation: Conversation
  highlightedMessage: Message
  highlightedCoverAsset: CoverAsset
  latestAiUsage: AiUsageLog
}
