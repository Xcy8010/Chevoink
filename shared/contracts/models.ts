export type EntityId = string

export type AiImageSize =
  | '768x1024'
  | '1024x1024'
  | '1024x1536'
  | '1536x1024'

export const FIXED_NOVEL_COVER_SIZE: AiImageSize = '768x1024'
export const FIXED_NOVEL_COVER_WIDTH = 768
export const FIXED_NOVEL_COVER_HEIGHT = 1024

export type AiProviderMode = 'mock' | 'provider' | 'fallback' | 'hybrid' | string
export type AiProviderType = 'text' | 'image'
export type UserRole = 'user' | 'author' | 'admin'
export type NovelStatus = 'draft' | 'published' | 'completed' | 'archived'
export type ChapterStatus = 'draft' | 'published' | 'scheduled' | 'archived'
export type Visibility = 'public' | 'followers' | 'private'
export type CommentTargetType = 'novel' | 'chapter' | 'post'
export type MessageType = 'text' | 'image' | 'novelCard' | 'postCard' | 'authorCard' | 'commentCard' | 'system'
export type ConversationType = 'direct' | 'system'
export type CoverSourceType = 'upload' | 'ai_generated'
export type ContentAuditStatus = 'pending' | 'approved' | 'rejected'
export type AgentSessionStatus = 'active' | 'archived'
export type AgentRunMode = 'plan' | 'act' | 'review'
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type AgentType =
  | 'writingOrchestrator'
  | 'storyPlanner'
  | 'draftWriter'
  | 'continuityEditor'
  | 'styleEditor'
  | 'loreLibrarian'
  | 'coverPromptAgent'
export type AgentActionKind =
  | 'planChapter'
  | 'draftChapter'
  | 'continueChapter'
  | 'rewriteSelection'
  | 'polishSelection'
  | 'reviewContinuity'
  | 'generateCoverPrompt'
export type AgentWorkspaceToolName =
  | 'novel.rename'
  | 'chapter.rename'
  | 'chapter.create'
  | 'chapter.write'
  | 'chapter.append'
  | 'novel.update_meta'
  | 'novel.publish'
  | 'novel.archive'
  | 'novel.delete'
  | 'cover.prompt.set'
  | 'cover.generate'
  | 'cover.apply'
  | 'workspace.open_meta'
  | 'workspace.open_cover'
export type AgentArtifactType =
  | 'researchReport'
  | 'chapterPlan'
  | 'chapterDraft'
  | 'chapterContinuation'
  | 'rewriteSelection'
  | 'polishSelection'
  | 'continuityReview'
  | 'coverPrompt'
  | 'searchResult'
  | 'contextCheckpoint'
export type ProjectMemoryType =
  | 'novelSummary'
  | 'worldbuilding'
  | 'characterCard'
  | 'chapterSummary'
  | 'timelineEvent'
  | 'foreshadowing'
  | 'stylePreference'
  | 'continuityRule'
  | 'volumeSummary'
  | 'storyArc'
  | 'sceneState'
  | 'relationshipState'
  | 'storyBible'
  | 'authorProfile'
export type AgentArtifactApplyStrategy = string
export type ConversationPresence = 'online' | 'offline' | 'typing' | string

export interface Pagination {
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  [key: string]: unknown
}

export interface UserSummary {
  id: EntityId
  nickname: string
  avatarUrl: string | null
  profileCoverUrl?: string | null
  bio?: string | null
  role?: UserRole
  isAuthor?: boolean
  [key: string]: unknown
}

export interface User extends UserSummary {
  email: string | null
  phone: string | null
  passwordConfigured: boolean
  followerCount: number
  followingCount: number
  novelCount: number
  postCount: number
  unreadMessageCount: number
  unreadNotificationCount: number
  /** 查看他人主页时：当前登录用户是否已关注该用户 */
  followedByViewer?: boolean
  /** 仅本人可见：自己的隐私设置 */
  privacy?: PrivacySettings
  /** 查看他人主页时：各隐私区块对当前查看者是否可见 */
  visibility?: ProfileVisibility
  createdAt: string
  updatedAt: string
}

export interface AuthorSummary extends UserSummary {
  followerCount: number
  novelCount: number
  isFollowed: boolean
}

/** 关注列表（粉丝/关注中）里的单个用户条目 */
export interface FollowUserItem extends UserSummary {
  followerCount: number
  /** 当前登录用户是否已关注该用户 */
  followedByViewer: boolean
  /** 该用户是否关注了当前登录用户（用于互相关注标记） */
  followsViewer: boolean
  followedAt: string
  /** 在线状态：最近 5 分钟内活跃为 online，前端据此在头像下方显示小绿点 */
  presence?: 'online' | 'offline'
}

/** 获赞明细条目：谁赞了你的什么内容 */
export interface ReceivedLikeItem {
  id: EntityId
  /** 点赞的用户 */
  user: UserSummary
  targetType: 'post' | 'comment'
  /** 被赞内容摘要 */
  excerpt: string
  /** 帖子赞/帖子评论赞：对应帖子 id，用于跳转 */
  postId: EntityId | null
  /** 小说/章节评论赞：对应小说 id，用于跳转 */
  novelId: EntityId | null
  likedAt: string
  [key: string]: unknown
}

/** 互动消息类型：赞/收藏/作品评论/章节评论 */
export type InteractionKind = 'postLike' | 'commentLike' | 'novelFavorite' | 'novelComment' | 'chapterComment' | 'commentReply' | 'postComment'

/** 互动消息条目：谁对你的内容做了什么 */
export interface InteractionItem {
  id: EntityId
  /** 发起互动的用户 */
  user: UserSummary
  kind: InteractionKind
  /** 相关内容摘要（被赞内容/评论正文） */
  excerpt: string
  /** 作品评论的评星（1-5） */
  rating?: number | null
  /** 跳转用：帖子 id */
  postId: EntityId | null
  /** 跳转用：作品 id */
  novelId: EntityId | null
  /** 跳转用：章节 id（章节评论/回复直达阅读器评论面板） */
  chapterId?: EntityId | null
  /** 跳转用：段落序号（段评直达正文对应段落并高亮） */
  paragraphIndex?: number | null
  /** 作品标题（收藏/作品评论/章节评论时带上） */
  novelTitle?: string | null
  /** 章节标题（章节评论时带上） */
  chapterTitle?: string | null
  happenedAt: string
  [key: string]: unknown
}

/** 消息中心固定入口的未读徽标：互动消息/新关注我的 */
export interface InteractionBadges {
  /** 未读互动消息数 */
  interactionsUnseen: number
  /** 上次查看互动消息的时间（用于新消息高亮） */
  interactionsSeenAt: string | null
  /** 未读新粉丝数 */
  followersUnseen: number
  /** 上次查看新关注的时间（用于新粉丝高亮） */
  followersSeenAt: string | null
  [key: string]: unknown
}

/** 隐私可见级别：公开 / 仅自己 / 仅互关可见 */
export type PrivacyLevel = 'public' | 'private' | 'mutual'

/** 用户隐私设置：谁可以查看我的粉丝/关注/获赞/喜欢/已回复 */
export interface PrivacySettings {
  followers: PrivacyLevel
  following: PrivacyLevel
  /** 获赞 */
  likes: PrivacyLevel
  /** 喜欢（我赞过的帖子） */
  favorites: PrivacyLevel
  /** 已回复（我发出的评论） */
  replies: PrivacyLevel
}

/** 查看他人主页时：各隐私区块对当前查看者是否可见 */
export interface ProfileVisibility {
  followers: boolean
  following: boolean
  likes: boolean
  favorites: boolean
  replies: boolean
}

/** 已回复条目：用户发出的一条评论及其上下文 */
export interface UserReplyItem {
  id: EntityId
  targetType: CommentTargetType
  content: string
  /** 作品点评的评星（1-5） */
  rating?: number | null
  likeCount: number
  /** viewer 是否已赞该条评论 */
  likedByViewer?: boolean
  /** 跳转用：帖子 id */
  postId: EntityId | null
  /** 跳转用：作品 id */
  novelId: EntityId | null
  novelTitle?: string | null
  chapterTitle?: string | null
  /** 被回复内容摘要（帖子正文/上级评论） */
  targetExcerpt?: string | null
  createdAt: string
  [key: string]: unknown
}

export interface TopicSummary {
  id: EntityId
  name: string
  slug: string
  postCount: number
  [key: string]: unknown
}

export interface NovelRelatedSummary {
  id: EntityId
  title: string
  coverUrl: string | null
  [key: string]: unknown
}

export interface Novel {
  id: EntityId
  title: string
  displayTitle: string | null
  slug: string
  summary: string
  categoryId: string | null
  categoryName: string | null
  tags: string[]
  status: NovelStatus
  visibility: Visibility
  coverUrl: string | null
  coverAssetId: string | null
  coverPrompt: string | null
  wordCount: number
  chapterCount: number
  commentCount: number
  favoriteCount: number
  likeCount: number
  /** 读者数（UV 口径：一人一作品仅计一次，匿名阅读不计；历史数据已由 reading_progress 回填校准） */
  viewCount: number
  /** 作品评分：平均星级（1-5，保留一位小数）；没有评分时为 null */
  ratingAverage?: number | null
  /** 参与评星的人数 */
  ratingCount?: number
  /** 当前登录用户是否已收藏（未登录缺省 false） */
  favoritedByViewer?: boolean
  lastChapterTitle: string | null
  lastPublishedAt: string | null
  publishedAt: string | null
  pinnedAt: string | null
  author: AuthorSummary
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface NovelCard {
  id: EntityId
  title: string
  displayTitle: string | null
  slug: string
  summary: string
  tags: string[]
  status: NovelStatus
  coverUrl: string | null
  wordCount: number
  chapterCount: number
  lastPublishedAt: string | null
  publishedAt?: string | null
  /** 读者数（UV 口径，同 Novel.viewCount） */
  viewCount?: number
  likeCount?: number
  favoriteCount?: number
  commentCount?: number
  updatedAt: string
  author: {
    id: EntityId
    nickname: string
    avatarUrl: string | null
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface Chapter {
  id: EntityId
  novelId: EntityId
  authorId: EntityId
  title: string
  summary: string | null
  content: string
  orderIndex: number
  volumeId: EntityId
  orderInVolume: number
  wordCount: number
  status: ChapterStatus
  visibility: Visibility
  commentCount: number
  /** 内容与结构写入版本；客户端保存与 Agent 工具写入必须据此做乐观并发校验。 */
  revision: number
  /** 最近一次发布快照对应的创作稿版本；与 revision 不同表示有待发布更新。 */
  publishedRevision?: number | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface ChapterListItem {
  id: EntityId
  novelId: EntityId
  title: string
  summary: string | null
  orderIndex: number
  volumeId: EntityId
  orderInVolume: number
  wordCount: number
  status: ChapterStatus
  visibility: Visibility
  commentCount: number
  revision: number
  publishedRevision?: number | null
  publishedAt: string | null
  [key: string]: unknown
}

export interface Comment {
  id: EntityId
  targetType: CommentTargetType
  targetId: EntityId
  parentId: EntityId | null
  rootId: EntityId | null
  content: string
  /** 作品评论的评星（1-5）；仅根评论携带 */
  rating?: number | null
  /** 段评：评论所属正文段落序号（0 起）；仅章节根评论携带，null 表示整章评论 */
  paragraphIndex?: number | null
  likeCount: number
  replyCount: number
  auditStatus: ContentAuditStatus
  /** 当前登录用户是否已点赞（未登录时缺省 false） */
  likedByViewer?: boolean
  author: {
    id: EntityId
    nickname: string
    avatarUrl: string | null
    [key: string]: unknown
  }
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface Post {
  id: EntityId
  content: string
  excerpt: string
  topic: TopicSummary | null
  imageUrls: string[]
  relatedNovel: NovelRelatedSummary | null
  /** 分享的作者（分享作者主页到社区时携带） */
  sharedUser?: {
    id: EntityId
    nickname: string
    avatarUrl: string | null
    bio: string | null
  } | null
  likeCount: number
  commentCount: number
  favoriteCount: number
  auditStatus: ContentAuditStatus
  /** 当前登录用户是否已点赞/收藏（未登录时缺省 false） */
  likedByViewer?: boolean
  bookmarkedByViewer?: boolean
  author: {
    id: EntityId
    nickname: string
    avatarUrl: string | null
    [key: string]: unknown
  }
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface ConversationMemberSummary {
  id: EntityId
  nickname: string
  avatarUrl: string | null
  /** 该成员对本会话的最后已读时间：用于判断自己发的消息对方是否已读 */
  lastReadAt?: string | null
  [key: string]: unknown
}

export interface Conversation {
  id: EntityId
  type: ConversationType
  title: string | null
  avatarUrl: string | null
  unreadCount: number
  lastMessagePreview: string | null
  lastMessageAt: string | null
  members: ConversationMemberSummary[]
  counterpart?: ConversationMemberSummary | null
  /** 直聊会话：我是否关注了对方 */
  viewerFollowsCounterpart?: boolean
  /** 直聊会话：对方是否关注了我 */
  counterpartFollowsViewer?: boolean
  /** 直聊会话：是否互相关注；未互关属于陌生消息，单方最多发 3 条 */
  isMutualFollow?: boolean
  presence?: ConversationPresence
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

/** 私信卡片消息的富数据：后端按 relatedId 批量回填；源内容被删除时为 null，前端降级为文本气泡 */
export type MessageCard =
  | {
      kind: 'novel'
      id: EntityId
      title: string
      coverUrl: string | null
      summary: string
      authorName: string
    }
  | {
      kind: 'author'
      id: EntityId
      nickname: string
      avatarUrl: string | null
      bio: string | null
      followerCount: number
      novelCount: number
    }
  | {
      kind: 'post'
      id: EntityId
      excerpt: string
      imageUrl: string | null
      authorName: string
      authorAvatarUrl: string | null
    }
  | {
      kind: 'comment'
      id: EntityId
      content: string
      authorName: string
      authorAvatarUrl: string | null
      postId: EntityId | null
      novelId: EntityId | null
    }

export interface Message {
  id: EntityId
  conversationId: EntityId
  senderId: EntityId
  type: MessageType
  content: string
  relatedId: EntityId | null
  /** 卡片消息（novelCard/postCard/authorCard/commentCard）的富数据 */
  card?: MessageCard | null
  createdAt: string
  [key: string]: unknown
}

export interface CoverAsset {
  id: EntityId
  novelId: EntityId | null
  ownerUserId: EntityId
  sourceType: CoverSourceType
  imageUrl: string
  prompt: string | null
  negativePrompt: string | null
  modelName: string | null
  width: number | null
  height: number | null
  createdAt: string
  [key: string]: unknown
}

export interface AiUsageLog {
  id: EntityId
  userId: EntityId
  novelId?: EntityId | null
  chapterId?: EntityId | null
  coverAssetId?: EntityId | null
  targetType: string
  targetId: EntityId | null
  providerType: AiProviderType
  providerMode: AiProviderMode
  modelName: string
  action: string
  requestTokens: number | null
  responseTokens: number | null
  durationMs: number
  createdAt: string
  [key: string]: unknown
}

export interface StatCardItem {
  id: string
  label: string
  value: string
  hint?: string
  tone?: string
  [key: string]: unknown
}

export interface ProfileShelfItem {
  id: string
  novelId?: EntityId
  title: string
  coverUrl?: string | null
  summary?: string | null
  updatedAt: string
  [key: string]: unknown
}

/**
 * 云端书架 + 阅读进度条目：每个用户对每本书一条。
 * chapterId 为空表示已加入书架但还未开始读；非空则携带当前章节与章内位置。
 */
export interface ReadingProgressItem {
  novelId: EntityId
  novelTitle: string
  coverUrl?: string | null
  chapterId?: string | null
  chapterTitle?: string | null
  chapterOrder: number
  totalChapters: number
  /** 章内滚动进度 0-1，用于重新进入时定位到上次读到的位置 */
  scrollPercent: number
  addedAt: string
  updatedAt: string
}

export interface ProfileDraftItem {
  id: string
  novelId: EntityId
  chapterId: EntityId
  title: string
  summary: string
  updatedAt: string
  statusLabel: string
  [key: string]: unknown
}

export interface ProfileActivityItem {
  id: string
  type?: string
  title?: string
  label?: string
  content?: string
  summary?: string
  createdAt?: string
  time?: string
  [key: string]: unknown
}

export interface NotificationItem {
  id: string
  title?: string
  category?: string
  content: string
  createdAt?: string
  time?: string
  read?: boolean
  [key: string]: unknown
}

export interface AuthorPageNote {
  id?: string
  label?: string
  title?: string
  content?: string
  location?: string
  activeWindow?: string
  specialties?: string[]
  joinedLabel?: string
  workbenchLine?: string
  [key: string]: unknown
}

export interface HomePagePayload {
  continueReading: NovelCard[]
  recommendedNovels: NovelCard[]
  latestUpdatedNovels: NovelCard[]
  /** 服务端计算的热度榜（互动加权 + 时间衰减） */
  rankingHot?: NovelCard[]
  /** 服务端计算的新书榜（按首发时间） */
  rankingNew?: NovelCard[]
  /** 服务端计算的完结榜（已完结作品按累计热度） */
  rankingFinished?: NovelCard[]
  /** 推荐算法版本（推荐算法优化方案 Phase 0），曝光归因与结果解释用 */
  algorithmVersion?: string
  hotTopics: TopicSummary[]
  hotPosts: Post[]
  [key: string]: unknown
}

export interface NovelDetailPayload {
  novel: Novel
  volumes: import('./volume-contracts.js').VolumeListItem[]
  chapters: ChapterListItem[]
  topComments: Comment[]
  relatedNovels: NovelCard[]
  /** 相关推荐算法版本（推荐算法优化方案 Phase 0） */
  relatedAlgorithmVersion?: string
  [key: string]: unknown
}

/** 全局搜索联想项：书名 / 作者 / 帖子 */
export interface SearchSuggestItem {
  type: 'novel' | 'author' | 'post'
  id: EntityId
  text: string
  subText?: string | null
  imageUrl?: string | null
}

export interface SearchSuggestPayload {
  items: SearchSuggestItem[]
  [key: string]: unknown
}

/** 全局搜索结果：按类型分组 */
export interface SearchResultPayload {
  novels: NovelCard[]
  authors: UserSummary[]
  posts: Post[]
  [key: string]: unknown
}

export interface HotSearchPayload {
  keywords: string[]
  [key: string]: unknown
}

export interface ReaderPayload {
  novel: {
    id: EntityId
    title: string
    displayTitle: string | null
    slug: string
    coverUrl: string | null
    [key: string]: unknown
  }
  currentChapter: Chapter
  chapterList: ChapterListItem[]
  volumes: import('./volume-contracts.js').VolumeListItem[]
  previousChapterId: EntityId | null
  nextChapterId: EntityId | null
  [key: string]: unknown
}

export interface StudioPayload {
  novel: Novel
  volumes: import('./volume-contracts.js').VolumeListItem[]
  chapters: ChapterListItem[]
  draftChapter: Chapter | null
  coverAssets: CoverAsset[]
  featureFlags?: import('./feature-flags.js').Agent2FeatureFlags
  [key: string]: unknown
}

export interface PostDetailPayload {
  post: Post
  comments: Comment[]
  relatedPosts: Post[]
  [key: string]: unknown
}

export interface UserMePayload {
  user: User | null
  shelf: ProfileShelfItem[]
  drafts: ProfileDraftItem[]
  authoredNovels?: Novel[]
  activities: ProfileActivityItem[]
  notifications: NotificationItem[]
  unreadMessageCount?: number
  unreadNotificationCount?: number
  recentConversations?: Conversation[]
  recentCoverAsset?: CoverAsset | null
  stats?: StatCardItem[]
  statCards?: StatCardItem[]
  [key: string]: unknown
}

export interface AuthorPagePayload {
  author: AuthorSummary
  authorNovels: NovelCard[]
  authorPosts: Post[]
  note: AuthorPageNote
  featuredNovel?: NovelCard | null
  recentNovels?: NovelCard[]
  recentPosts?: Post[]
  notes?: AuthorPageNote[]
  stats?: StatCardItem[]
  [key: string]: unknown
}

export interface AgentActionPlanStep {
  id: string
  toolName: AgentWorkspaceToolName
  title: string
  requiresConfirm: boolean
  target: {
    scope: 'workspace' | 'novel' | 'chapter'
    novelId?: EntityId
    chapterId?: EntityId | null
  }
  payload: Record<string, unknown>
}

export interface AgentActionPlan {
  mode: 'plan' | 'execute' | 'review'
  summary: string
  thinking?: string[]
  steps: AgentActionPlanStep[]
}

export type AgentExecutionStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface AgentExecutionStepResult {
  stepId: string
  toolName: AgentWorkspaceToolName
  title: string
  status: AgentExecutionStepStatus
  target: AgentActionPlanStep['target']
  resultSummary?: string | null
  errorMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export type AgentExecutionMode = 'plan' | 'build' | 'review'
export type AgentExecutionAgentRole = 'primary' | 'specialist'
export type AgentRouteStatusEvent = 'agent.selected' | 'route.decided' | 'specialist.started'

export interface AgentExecutionAgent {
  agentType: AgentType
  role: AgentExecutionAgentRole
  title: string
  description: string
}

export interface AgentRouteDecision {
  sourceAgent: AgentExecutionAgent
  targetAgent: AgentExecutionAgent
  task: string
  intentLabel: string
  summary: string
  factors?: string[]
}

export interface AgentRuleBundle {
  summary: string
  rules: string[]
}

export interface AgentStoryMemoryDigestItem {
  title: string
  memoryType: ProjectMemoryType
  excerpt: string
}

export interface AgentStoryMemoryDigest {
  summary: string
  items: AgentStoryMemoryDigestItem[]
}

export interface AgentActionHandoff {
  sourceMode: AgentExecutionMode
  targetMode: AgentExecutionMode
  title: string
  summary: string
  confirmLabel: string
  actionHint?: string | null
  sourceRunId?: EntityId | null
  sourceArtifactId?: EntityId | null
}

export type AgentWorkspaceToolPermission = 'allow' | 'ask' | 'deny'

export interface AgentWorkspaceToolAvailability {
  toolName: AgentWorkspaceToolName
  title: string
  description: string
  permission: AgentWorkspaceToolPermission
}

export interface AgentWorkspaceToolPolicy {
  mode: AgentExecutionMode
  tools: AgentWorkspaceToolAvailability[]
}

export interface AgentSession {
  id: EntityId
  userId: EntityId
  novelId: EntityId
  title: string
  status: AgentSessionStatus
  pinnedAt: string | null
  toolPolicy: import('./agent-productivity.js').AgentSessionToolPolicy | null
  sandboxMode: import('./agent-productivity.js').AgentSandboxMode
  novelTitle?: string
  lastRunAt: string | null
  /** 分支来源任务 ID：非空表示本任务是某个任务的分支副本 */
  forkedFromSessionId: string | null
  /** 分支切出的对话消息 ID：整任务复制时为空 */
  forkedFromMessageId: string | null
  /** 切分支的时刻：晚于它的消息即分支内新增对话 */
  forkedAt: string | null
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface AgentRun {
  authorEnded?: { fulfilled: boolean; todoItems?: import('./agent-events.js').AgentTodoItem[] }
  id: EntityId
  sessionId: EntityId
  userId: EntityId
  novelId: EntityId
  chapterId: EntityId | null
  mode: AgentRunMode
  action: AgentActionKind
  agentType: AgentType
  status: AgentRunStatus
  inputSummary: string | null
  outputSummary: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface AgentArtifact {
  id: EntityId
  runId: EntityId
  artifactType: AgentArtifactType
  title: string
  summary: string | null
  content: string
  metadata?: Record<string, unknown> | null
  availableApplyStrategies?: AgentArtifactApplyStrategy[]
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface ProjectMemoryEntry {
  id: EntityId
  runId: EntityId | null
  novelId: EntityId
  sourceChapterId: EntityId | null
  memoryType: ProjectMemoryType
  title: string
  content: string
  importance: number
  embeddingRef: string | null
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}
