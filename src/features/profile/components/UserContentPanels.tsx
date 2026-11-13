import { useQuery } from '@tanstack/react-query'
import { Heart, Star } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { ApiClientError } from '@/app/api-client'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { PostListSkeleton } from '@/components/ui/Skeleton'
import { listUserBookmarkedPosts, listUserLikedPosts, listUserReplies } from '@/features/community/api'
import PostCard from '@/features/community/components/PostCard'
import { formatRelativeTime } from '@/features/community/utils'
import type { UserReplyItem } from '../../../../shared/contracts'

/**
 * 「喜欢」「已回复」内容面板：个人中心与作者主页共用。
 * 后端按隐私设置返回 restricted 标记时展示占位，不抛错误。
 */

function RestrictedState({ label }: { label: string }) {
  return (
    <AppState
      compact
      scene="privacy"
      title={`${label}未公开`}
    />
  )
}

function canShowCachedPanel(error: Error | null) {
  return !(error instanceof ApiClientError && [401, 403, 404].includes(error.status))
}

export function LikedPostsPanel({ userId, isSelf = false }: { userId: string; isSelf?: boolean }) {
  const query = useQuery({
    queryKey: ['community', 'liked-posts', userId],
    queryFn: () => listUserLikedPosts(userId),
    enabled: Boolean(userId),
  })

  if (query.isLoading) {
    return (
      <div className="pt-3">
        <PostListSkeleton count={2} />
      </div>
    )
  }

  if (query.isError && (!query.data || !canShowCachedPanel(query.error))) {
    return (
      <AppState
        compact
        tone="error"
        title="喜欢列表加载失败"
        primaryAction={{ label: '重新加载', onClick: () => query.refetch(), busy: query.isFetching }}
      />
    )
  }

  if (query.data?.restricted) {
    return <RestrictedState label="喜欢列表" />
  }

  const items = query.data?.items ?? []
  const refreshNotice = query.isRefetchError ? <AppStateRefreshNotice retry={query.refetch} busy={query.isFetching} /> : null

  if (items.length === 0) {
    return (
      <>
        {refreshNotice}
        <AppState
          compact
          scene="message"
          title={isSelf ? '你还没有喜欢的内容' : 'TA 还没有喜欢的内容'}
          primaryAction={isSelf ? { label: '去社区', href: '/community' } : undefined}
        />
      </>
    )
  }

  return (
    <div className="space-y-3 pt-3">
      {refreshNotice}
      {items.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  )
}

/** 收藏的帖子面板：个人中心收藏页的「帖子」子栏，仅本人可见 */
export function BookmarkedPostsPanel({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ['community', 'bookmarked-posts', userId],
    queryFn: () => listUserBookmarkedPosts(userId),
    enabled: Boolean(userId),
  })

  if (query.isLoading) {
    return (
      <div className="pt-3">
        <PostListSkeleton count={2} />
      </div>
    )
  }

  if (query.isError && (!query.data || !canShowCachedPanel(query.error))) {
    return (
      <AppState
        compact
        tone="error"
        title="收藏的帖子加载失败"
        primaryAction={{ label: '重新加载', onClick: () => query.refetch(), busy: query.isFetching }}
      />
    )
  }

  if (query.data?.restricted) {
    return <RestrictedState label="收藏列表" />
  }

  const items = query.data?.items ?? []
  const refreshNotice = query.isRefetchError ? <AppStateRefreshNotice retry={query.refetch} busy={query.isFetching} /> : null

  if (items.length === 0) {
    return (
      <>
        {refreshNotice}
        <AppState compact scene="reading" title="还没有收藏帖子" primaryAction={{ label: '去社区', href: '/community' }} />
      </>
    )
  }

  return (
    <div className="space-y-3 pt-3">
      {refreshNotice}
      {items.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  )
}

/** 单条回复的动作描述：按评论目标类型区分帖子 / 作品 / 章节 */
function replyActionLabel(item: UserReplyItem) {
  if (item.targetType === 'post') {
    return '回复了帖子'
  }
  if (item.targetType === 'chapter') {
    return '评论了章节'
  }
  return '评价了作品'
}

function replyTargetLabel(item: UserReplyItem) {
  if (item.targetType === 'post') {
    return item.targetExcerpt ?? null
  }

  const novelTitle = item.novelTitle ? `《${item.novelTitle}》` : null
  if (item.targetType === 'chapter') {
    return [novelTitle, item.chapterTitle].filter(Boolean).join(' · ') || null
  }
  return novelTitle
}

export function RepliesPanel({ userId, isSelf = false }: { userId: string; isSelf?: boolean }) {
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: ['community', 'user-replies', userId],
    queryFn: () => listUserReplies(userId),
    enabled: Boolean(userId),
  })

  if (query.isLoading) {
    return (
      <div className="pt-3">
        <PostListSkeleton count={2} />
      </div>
    )
  }

  if (query.isError && (!query.data || !canShowCachedPanel(query.error))) {
    return (
      <AppState
        compact
        tone="error"
        title="回复列表加载失败"
        primaryAction={{ label: '重新加载', onClick: () => query.refetch(), busy: query.isFetching }}
      />
    )
  }

  if (query.data?.restricted) {
    return <RestrictedState label="已回复列表" />
  }

  const items = query.data?.items ?? []
  const refreshNotice = query.isRefetchError ? <AppStateRefreshNotice retry={query.refetch} busy={query.isFetching} /> : null

  if (items.length === 0) {
    return (
      <>
        {refreshNotice}
        <AppState
          compact
          scene="message"
          title={isSelf ? '你还没有回复过内容' : 'TA 还没有回复过内容'}
          primaryAction={isSelf ? { label: '去社区', href: '/community' } : undefined}
        />
      </>
    )
  }

  function openReplyTarget(item: UserReplyItem) {
    if (item.targetType === 'post' && item.postId) {
      navigate(`/post/${item.postId}`)
      return
    }
    if (item.novelId) {
      navigate(`/novel/${item.novelId}`)
    }
  }

  return (
    <div className="divide-y divide-[var(--border-subtle)]">
      {refreshNotice}
      {items.map((item) => {
        const targetLabel = replyTargetLabel(item)

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => openReplyTarget(item)}
            className="block w-full px-1 py-3.5 text-left transition-colors hover:bg-[var(--surface-muted)] sm:rounded-[var(--radius-lg)] sm:px-2"
          >
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-tertiary)]">
              <span>{replyActionLabel(item)}</span>
              {item.targetType !== 'post' && targetLabel ? (
                <span className="truncate font-medium text-[var(--text-secondary)]">{targetLabel}</span>
              ) : null}
              {typeof item.rating === 'number' && item.rating > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-[var(--color-brand)]">
                  <Star className="h-3 w-3 fill-current" />
                  {item.rating}
                </span>
              ) : null}
              <span>·</span>
              <span>{formatRelativeTime(item.createdAt)}</span>
            </p>

            {item.targetType === 'post' && targetLabel ? (
              <p className="mt-1.5 line-clamp-1 border-l-2 border-[var(--border-subtle)] pl-2.5 text-xs leading-5 text-[var(--text-tertiary)]">
                {targetLabel}
              </p>
            ) : null}

            <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-[var(--text-primary)]">
              {item.content}
            </p>

            {item.likeCount > 0 ? (
              <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                <Heart
                  className={
                    item.likedByViewer
                      ? 'h-3.5 w-3.5 fill-[var(--color-brand)] text-[var(--color-brand)]'
                      : 'h-3.5 w-3.5'
                  }
                />
                {item.likeCount}
              </p>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
