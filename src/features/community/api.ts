import type {
  ApiResponse,
  CommentTargetType,
  Conversation,
  CreateCommentRequest,
  CreateConversationResponse,
  CreatePostRequest,
  CreatePostResponse,
  DeletePostResponse,
  GetMeResponse,
  GetInteractionBadgesResponse,
  GetPostDetailResponse,
  GetTopicsResponse,
  GetRecommendedTopicsResponse,
  GetTopicResponse,
  ListCommentsResponse,
  ListConversationsResponse,
  ListFollowUsersResponse,
  ListInteractionsResponse,
  ListFavoriteNovelsResponse,
  ListLikedPostsResponse,
  ListBookmarkedPostsResponse,
  ListMessagesResponse,
  ListNovelsResponse,
  ListPostsResponse,
  ListReadingProgressResponse,
  ListParagraphUnderlinesResponse,
  ListReceivedLikesResponse,
  ListUserRepliesResponse,
  MarkConversationReadResponse,
  MarkInteractionSeenRequest,
  MarkInteractionSeenResponse,
  PostStatsResponse,
  RemoveParagraphUnderlineResponse,
  RemoveReadingProgressResponse,
  SaveParagraphUnderlineRequest,
  SaveParagraphUnderlineResponse,
  SaveReadingProgressRequest,
  SaveReadingProgressResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetCommentLikeResponse,
  SetNovelFavoriteResponse,
  SetPostBookmarkResponse,
  SetPostLikeResponse,
  SetUserFollowResponse,
  UpdateCommentRequest,
  UpdateCommentResponse,
  DeleteCommentResponse,
  UpdatePrivacyRequest,
  UpdatePrivacyResponse,
  User,
} from '../../../shared/contracts/index.js'
import { buildApiUrl } from '@/app/api-base'
import { ApiClientError } from '@/app/api-client'
import { buildAuthHeader } from '@/lib/auth-token'

type RequestDataOptions = RequestInit & {
  timeoutMs?: number
}

function normalizeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return '请求超时，请稍后再试。'
    }

    return error.message || '请求失败，请稍后再试。'
  }

  return '请求失败，请稍后再试。'
}

async function requestData<T>(path: string, options?: RequestDataOptions): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? 30000
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(buildApiUrl(path), {
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeader(),
        ...(options?.headers ?? {}),
      },
      ...options,
      signal: controller.signal,
    })

    const rawText = await response.text()
    let result: ApiResponse<T> | null = null
    try {
      result = rawText ? (JSON.parse(rawText) as ApiResponse<T>) : null
    } catch (error) {
      if (response.ok) throw error
    }

    if (!response.ok) {
      const message =
        result && typeof result === 'object' && 'error' in result
          ? result.error.message
          : '请求失败，请稍后再试。'
      throw new ApiClientError(message, response.status)
    }

    if (!result || !result.success) {
      const message =
        result && typeof result === 'object' && 'error' in result
          ? result.error.message
          : '服务返回异常，请稍后再试。'
      throw new Error(message)
    }

    return result.data
  } catch (error) {
    if (error instanceof ApiClientError) throw error
    throw new Error(normalizeFetchError(error))
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export function getMe() {
  return requestData<GetMeResponse['data']>('/api/users/me')
}

export async function getUser(userId: string): Promise<User> {
  const data = await requestData<{ user: User }>(`/api/users/${userId}`)
  return data.user
}

export function listNovels(pageSize = 20, options?: { authorId?: string; publishedOnly?: boolean }) {
  const search = new URLSearchParams({ page: '1', pageSize: `${pageSize}` })

  if (options?.authorId) {
    search.set('authorId', options.authorId)
  }

  if (options?.publishedOnly) {
    search.set('status', 'published')
  }

  return requestData<ListNovelsResponse['data']>(`/api/novels?${search.toString()}`)
}

export function listPosts(
  pageSize = 20,
  options?: {
    page?: number
    topicId?: string
    authorId?: string
    sort?: 'recommended' | 'latest'
    /** 推荐流快照时间：翻页时回传首页返回的 snapshotAt */
    snapshotAt?: string
  },
) {
  const search = new URLSearchParams({
    page: `${options?.page ?? 1}`,
    pageSize: `${pageSize}`,
  })

  if (options?.topicId) {
    search.set('topicId', options.topicId)
  }

  if (options?.authorId) {
    search.set('authorId', options.authorId)
  }

  if (options?.sort) {
    search.set('sort', options.sort)
  }

  if (options?.snapshotAt) {
    search.set('snapshotAt', options.snapshotAt)
  }

  return requestData<ListPostsResponse['data']>(`/api/posts?${search.toString()}`)
}

export function listTopics() {
  return requestData<GetTopicsResponse['data']>('/api/topics')
}

/** 推荐话题：发帖区引导用，按近 7 天趋势分取前 3 个 */
export function listRecommendedTopics() {
  return requestData<GetRecommendedTopicsResponse['data']>('/api/topics/recommended')
}

/** 话题详情：按 slug/name/id 解析 */
export async function resolveTopic(topicKey: string) {
  const data = await requestData<GetTopicResponse['data']>(`/api/topics/${encodeURIComponent(topicKey)}`)
  return data.topic
}

export function setPostLike(postId: string, liked: boolean) {
  return requestData<SetPostLikeResponse['data']>(`/api/posts/${postId}/like`, {
    method: liked ? 'POST' : 'DELETE',
  })
}

export function setPostBookmark(postId: string, bookmarked: boolean) {
  return requestData<SetPostBookmarkResponse['data']>(`/api/posts/${postId}/bookmark`, {
    method: bookmarked ? 'POST' : 'DELETE',
  })
}

/** 删除自己的帖子（后端会连同评论/点赞/收藏一并清理） */
export function deletePost(postId: string) {
  return requestData<DeletePostResponse['data']>(`/api/posts/${postId}`, {
    method: 'DELETE',
  })
}

export function setCommentLike(commentId: string, liked: boolean) {
  return requestData<SetCommentLikeResponse['data']>(`/api/comments/${commentId}/like`, {
    method: liked ? 'POST' : 'DELETE',
  })
}

export function setUserFollow(userId: string, following: boolean) {
  return requestData<SetUserFollowResponse['data']>(`/api/users/${userId}/follow`, {
    method: following ? 'POST' : 'DELETE',
  })
}

export function listUserFollowers(userId: string) {
  return requestData<ListFollowUsersResponse['data']>(`/api/users/${userId}/followers`)
}

export function listUserFollowing(userId: string) {
  return requestData<ListFollowUsersResponse['data']>(`/api/users/${userId}/following`)
}

/** 喜欢列表：用户赞过的帖子 */
export function listUserLikedPosts(userId: string) {
  return requestData<ListLikedPostsResponse['data']>(`/api/users/${userId}/liked-posts`)
}

/** 收藏的帖子列表（仅本人可见） */
export function listUserBookmarkedPosts(userId: string) {
  return requestData<ListBookmarkedPostsResponse['data']>(`/api/users/${userId}/bookmarked-posts`)
}

/** 已回复列表：用户发出的各类评论 */
export function listUserReplies(userId: string) {
  return requestData<ListUserRepliesResponse['data']>(`/api/users/${userId}/replies`)
}

/** 更新隐私设置，返回最新全量设置 */
export function updateMyPrivacy(input: UpdatePrivacyRequest) {
  return requestData<UpdatePrivacyResponse['data']>('/api/users/me/privacy', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function listReceivedLikes() {
  return requestData<ListReceivedLikesResponse['data']>('/api/users/me/received-likes')
}

/** 互动消息明细：赞/收藏/作品评论/章节评论 */
export function listInteractions() {
  return requestData<ListInteractionsResponse['data']>('/api/users/me/interactions')
}

/** 互动/新关注未读徽标 */
export function getInteractionBadges() {
  return requestData<GetInteractionBadgesResponse['data']>('/api/users/me/interaction-badges')
}

/** 标记互动/新关注已读，返回最新徽标 */
export function markInteractionSeen(target: MarkInteractionSeenRequest['target']) {
  return requestData<MarkInteractionSeenResponse['data']>('/api/users/me/interaction-badges/seen', {
    method: 'POST',
    body: JSON.stringify({ target }),
  })
}

/** 收藏/取消收藏作品 */
export function setNovelFavorite(novelId: string, favorited: boolean) {
  return requestData<SetNovelFavoriteResponse['data']>(`/api/novels/${novelId}/favorite`, {
    method: favorited ? 'POST' : 'DELETE',
  })
}

/** 我收藏的作品列表（按收藏时间倒序） */
export function listFavoriteNovels() {
  return requestData<ListFavoriteNovelsResponse['data']>('/api/users/me/favorite-novels')
}

/** 拉取跨设备同步的书架 + 阅读进度（按更新时间倒序） */
export function listReadingProgress() {
  return requestData<ListReadingProgressResponse['data']>('/api/users/me/reading-progress')
}

/** 写回书架成员身份 / 阅读进度（章节 + 章内滚动位置） */
export function saveReadingProgress(body: SaveReadingProgressRequest) {
  return requestData<SaveReadingProgressResponse['data']>('/api/users/me/reading-progress', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 移出书架（同时清除该作品的阅读进度） */
export function removeReadingProgress(novelId: string) {
  return requestData<RemoveReadingProgressResponse['data']>(`/api/users/me/reading-progress/${novelId}`, {
    method: 'DELETE',
  })
}

/** 本章已划线的段落序号（方案 20 §2.7） */
export function listParagraphUnderlines(chapterId: string) {
  return requestData<ListParagraphUnderlinesResponse['data']>(
    `/api/users/me/underlines?chapterId=${encodeURIComponent(chapterId)}`,
  )
}

/** 新增段落划线（同段重复提交幂等） */
export function saveParagraphUnderline(body: SaveParagraphUnderlineRequest) {
  return requestData<SaveParagraphUnderlineResponse['data']>('/api/users/me/underlines', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** 取消段落划线 */
export function removeParagraphUnderline(chapterId: string, paragraphIndex: number) {
  return requestData<RemoveParagraphUnderlineResponse['data']>(
    `/api/users/me/underlines?chapterId=${encodeURIComponent(chapterId)}&paragraphIndex=${paragraphIndex}`,
    { method: 'DELETE' },
  )
}

/** 创建或复用与目标用户的双人直聊会话 */
export async function createDirectConversation(targetUserId: string): Promise<Conversation> {
  const data = await requestData<CreateConversationResponse['data']>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ targetUserId }),
  })

  return data.conversation
}

export function markConversationRead(conversationId: string) {
  return requestData<MarkConversationReadResponse['data']>(`/api/conversations/${conversationId}/read`, {
    method: 'POST',
  })
}

export function createPost(payload: CreatePostRequest) {
  return requestData<CreatePostResponse['data']>('/api/posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getPostDetail(postId: string) {
  return requestData<GetPostDetailResponse['data']>(`/api/posts/${postId}`)
}

export function listComments(targetType: CommentTargetType, targetId: string, pageSize = 50) {
  const search = new URLSearchParams({
    targetType,
    targetId,
    page: '1',
    pageSize: `${pageSize}`,
  })

  return requestData<ListCommentsResponse['data']>(`/api/comments?${search.toString()}`)
}

export function createComment(payload: CreateCommentRequest) {
  return requestData<{ comment: ListCommentsResponse['data']['items'][number] }>('/api/comments', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 编辑自己的评论；作品根评论可同步修改评星 */
export function updateComment(commentId: string, payload: UpdateCommentRequest) {
  return requestData<UpdateCommentResponse['data']>(`/api/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/** 删除自己的评论（后端会连同回复与点赞一并清理） */
export function deleteComment(commentId: string) {
  return requestData<DeleteCommentResponse['data']>(`/api/comments/${commentId}`, {
    method: 'DELETE',
  })
}

export const CONVERSATION_PAGE_SIZE = 30

export function listConversations(pageSize = CONVERSATION_PAGE_SIZE, page = 1) {
  return requestData<ListConversationsResponse['data']>(`/api/conversations?page=${page}&pageSize=${pageSize}`)
}

export function listMessages(conversationId: string, pageSize = 20, page = 1) {
  return requestData<ListMessagesResponse['data']>(
    `/api/conversations/${conversationId}/messages?page=${page}&pageSize=${pageSize}`,
  )
}

/** 社区面板统计：独立于分页的准确总数口径 */
export function getPostStats() {
  return requestData<PostStatsResponse['data']>('/api/posts/stats')
}

export async function sendMessage(
  conversationId: string,
  payload: SendMessageRequest,
): Promise<SendMessageResponse['data']['message']> {
  const data = await requestData<SendMessageResponse['data']>(
    `/api/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )

  return data.message
}

export function getDirectConversationByUserId(
  conversations: Conversation[],
  userId: string | null | undefined,
) {
  if (!userId) {
    return null
  }

  return (
    conversations.find(
      (conversation) =>
        conversation.type === 'direct' &&
        conversation.members.some((member) => member.id === userId),
    ) ?? null
  )
}
