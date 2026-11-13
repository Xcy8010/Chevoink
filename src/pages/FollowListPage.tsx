import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { createDirectConversation, getInteractionBadges, getMe, getUser, listUserFollowers, listUserFollowing, markInteractionSeen, setUserFollow } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import { formatRelativeTime } from '@/features/community/utils'
import { MessageDetailRowsSkeleton, detailLayoutClass, detailRowClass } from '@/features/messages/components/MessagesLoading'
import { cn } from '@/lib/utils'
import type { FollowUserItem } from '../../shared/contracts'

const followTabs = [
  { id: 'following', label: '关注' },
  { id: 'followers', label: '粉丝' },
] as const

type FollowTab = (typeof followTabs)[number]['id']

/** 作者模式下的独立页面骨架：sticky 返回栏 + 单列容器，与作者主页保持一致 */
function StandaloneChrome({
  headerTitle,
  onBack,
  children,
}: {
  headerTitle: string
  onBack: () => void
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[color:var(--app-bg)]/85 backdrop-blur">
        <div className="mx-auto flex h-12 w-full max-w-[680px] items-center gap-2 px-2 sm:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回上一页"
            className="touch-target press-feedback inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-[var(--text-primary)]">{headerTitle}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[680px] px-4 pb-16">{children}</main>
    </div>
  )
}

/**
 * 关注·粉丝列表页，两种入口共用：
 * - /me/follows?tab=…：看自己的关注与粉丝（壳层内渲染）
 * - /author/:authorId/follows?tab=…：看某位作者的关注与粉丝（独立页面，sticky 返回栏）
 * 平铺行式列表（头像 + 昵称/简介 + 关注按钮），行点击进入对方主页，关注/取关走乐观更新。
 */
export default function FollowListPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const { authorId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab: FollowTab = searchParams.get('tab') === 'followers' ? 'followers' : 'following'

  const isAuthorMode = Boolean(authorId)
  const targetId = authorId ?? 'me'

  // 关注状态乐观覆盖：key 为用户 id
  const [followOverrides, setFollowOverrides] = useState<Record<string, boolean>>({})
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [messagingId, setMessagingId] = useState<string | null>(null)

  const meQuery = useQuery({
    queryKey: ['community', 'me'],
    queryFn: getMe,
  })
  const viewerId = meQuery.data?.user?.id ?? null

  const authorQuery = useQuery({
    queryKey: ['community', 'author', authorId],
    queryFn: () => getUser(authorId ?? ''),
    enabled: isAuthorMode,
  })

  const followingQuery = useQuery({
    queryKey: ['community', 'following', targetId],
    queryFn: () => listUserFollowing(targetId),
    enabled: activeTab === 'following',
  })
  const followersQuery = useQuery({
    queryKey: ['community', 'followers', targetId],
    queryFn: () => listUserFollowers(targetId),
    enabled: activeTab === 'followers',
  })

  const activeQuery = activeTab === 'following' ? followingQuery : followersQuery
  const items = activeQuery.data?.items ?? []

  // 看自己（/me/follows 或者点进了自己的作者主页）时才用「你」的文案与回关按钮
  const isViewingSelf = Boolean(viewerId && (targetId === 'me' || targetId === viewerId))

  // 看自己的粉丝 tab：先记住旧的已读水位（判定新粉丝高亮），再标记已读并同步红点缓存
  const [followersSeenBefore, setFollowersSeenBefore] = useState<string | null | undefined>(undefined)
  const followersMarkedRef = useRef(false)
  const shouldMarkFollowersSeen = !isAuthorMode && activeTab === 'followers' && Boolean(viewerId)
  useEffect(() => {
    if (!shouldMarkFollowersSeen || followersMarkedRef.current) return
    followersMarkedRef.current = true

    void getInteractionBadges()
      .then((badges) => {
        setFollowersSeenBefore(badges.followersSeenAt)
        return markInteractionSeen('followers')
      })
      .then((latest) => {
        queryClient.setQueryData(['community', 'interaction-badges'], latest)
      })
      .catch(() => {
        // 已读标记失败不阻断浏览，红点会在下次进入时重新对齐
      })
  }, [queryClient, shouldMarkFollowersSeen])

  /**
   * 关注状态写回 React Query 列表缓存：离开页面后本地 overrides 会丢失，
   * 不写缓存的话 30s 内再进来仍是旧状态（回关后按钮不变「发消息」）
   */
  function syncFollowCaches(userId: string, following: boolean) {
    const updateList = (data: { items: FollowUserItem[] } | undefined) =>
      data
        ? {
            ...data,
            items: data.items.map((item) =>
              item.id === userId ? { ...item, followedByViewer: following } : item,
            ),
          }
        : data
    queryClient.setQueryData(['community', 'following', targetId], updateList)
    queryClient.setQueryData(['community', 'followers', targetId], updateList)
    // 消息页互关好友栏与个人信息（关注数）共用的缓存一并刷新
    void queryClient.invalidateQueries({ queryKey: ['community', 'followers', 'me'] })
    void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
  }

  async function handleToggleFollow(item: FollowUserItem, currentFollowing: boolean) {
    if (submittingId) {
      return
    }

    if (!viewerId) {
      const currentPath = isAuthorMode ? `/author/${authorId}/follows` : '/me/follows'
      navigate(`/login?redirect=${encodeURIComponent(`${currentPath}?tab=${activeTab}`)}`)
      return
    }

    const next = !currentFollowing
    setSubmittingId(item.id)
    setFollowOverrides((current) => ({ ...current, [item.id]: next }))

    try {
      const payload = await setUserFollow(item.id, next)
      setFollowOverrides((current) => ({ ...current, [item.id]: payload.following }))
      syncFollowCaches(item.id, payload.following)
    } catch {
      setFollowOverrides((current) => ({ ...current, [item.id]: currentFollowing }))
    } finally {
      setSubmittingId(null)
    }
  }

  function handleBack() {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate(isAuthorMode ? `/author/${authorId}` : '/me')
  }

  /** 互关好友直接开聊：创建/复用直聊会话后进入消息页 */
  async function handleOpenChat(item: FollowUserItem) {
    if (messagingId) {
      return
    }

    if (!viewerId) {
      const currentPath = isAuthorMode ? `/author/${authorId}/follows` : '/me/follows'
      navigate(`/login?redirect=${encodeURIComponent(`${currentPath}?tab=${activeTab}`)}`)
      return
    }

    setMessagingId(item.id)
    try {
      const conversation = await createDirectConversation(item.id)
      navigate(`/messages?conversationId=${conversation.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '会话暂时没有打开，请稍后再试。')
    } finally {
      setMessagingId(null)
    }
  }

  const listContent = (
    <>
      {/* tab 切换：写回 URL，刷新/回退后停留在同一列表 */}
      <div className="mt-4 flex gap-2">
        {followTabs.map((tab) => {
          const count =
            tab.id === 'following'
              ? followingQuery.data?.items.length
              : followersQuery.data?.items.length

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSearchParams({ tab: tab.id }, { replace: true })}
              className={cn(
                'press-feedback inline-flex items-center gap-2 rounded-[var(--radius-pill)] border px-4 py-2 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                  : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
              )}
            >
              {tab.label}
              {typeof count === 'number' ? <span className="text-xs opacity-75">{count}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="mt-4">
        {activeQuery.isRefetchError ? <AppStateRefreshNotice retry={activeQuery.refetch} busy={activeQuery.isFetching} /> : null}
        {activeQuery.isLoading ? (
          <MessageDetailRowsSkeleton variant="follows" />
        ) : activeQuery.isError && !activeQuery.data ? (
          <AppState
            compact
            tone="error"
            title="关注列表暂时没有加载"
            primaryAction={{ label: '重新加载', onClick: () => activeQuery.refetch(), busy: activeQuery.isFetching }}
          />
        ) : items.length === 0 ? (
          <AppState
            compact
            scene="message"
            title={
              activeTab === 'following'
                ? isViewingSelf
                  ? '你还没有关注任何人'
                  : 'TA 还没有关注任何人'
                : isViewingSelf
                  ? '还没有人关注你'
                  : '还没有人关注 TA'
            }
            primaryAction={
              activeTab === 'following' && isViewingSelf
                ? { label: '去发现', href: '/discover' }
                : undefined
            }
          />
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {items.map((item) => {
              const following = followOverrides[item.id] ?? item.followedByViewer
              const isSelfRow = viewerId === item.id
              const isMutual = following && item.followsViewer
              // 新粉丝判定：晚于进入前的已读水位（从未看过则全部视为新），高亮闪烁提示
              const isNewFollower =
                activeTab === 'followers' &&
                isViewingSelf &&
                followersSeenBefore !== undefined &&
                (!followersSeenBefore || item.followedAt > followersSeenBefore)

              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/author/${item.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      navigate(`/author/${item.id}`)
                    }
                  }}
                  className={cn(
                    detailRowClass,
                    'cursor-pointer items-center transition-colors hover:bg-[var(--surface-muted)]',
                    isNewFollower ? 'animate-unseen-flash' : null,
                  )}
                >
                  <span className="relative shrink-0">
                    <Avatar name={item.nickname} src={item.avatarUrl} size="md" />
                    {item.presence === 'online' ? (
                      <span className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--surface-default)] bg-emerald-500" />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-[var(--text-primary)]">{item.nickname}</span>
                      {isMutual ? (
                        <span className="shrink-0 rounded-[4px] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--text-tertiary)]">
                          互相关注
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">
                      {activeTab === 'following'
                        ? `${formatRelativeTime(item.followedAt)}关注`
                        : isViewingSelf
                          ? `${formatRelativeTime(item.followedAt)}关注了你`
                          : `${formatRelativeTime(item.followedAt)}关注了 TA`}
                    </p>
                  </div>
                  {isSelfRow ? null : isMutual ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      disabled={messagingId === item.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleOpenChat(item)
                      }}
                    >
                      发消息
                    </Button>
                  ) : (
                    <Button
                      variant={following ? 'secondary' : 'primary'}
                      size="sm"
                      className="shrink-0"
                      disabled={submittingId === item.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleToggleFollow(item, following)
                      }}
                    >
                      {following ? '已关注' : item.followsViewer ? '回关' : '关注'}
                    </Button>
                  )}
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )

  if (isAuthorMode) {
    const authorName = authorQuery.data?.nickname
    return (
      <StandaloneChrome headerTitle={authorName ? `${authorName}的关注与粉丝` : '关注与粉丝'} onBack={handleBack}>
        {listContent}
      </StandaloneChrome>
    )
  }

  return (
    // 壳层大标题已隐藏；lg 起双栏：左侧 sticky 返回/标题栏 + 右侧列表，避免大屏左右留白
    <div className={detailLayoutClass}>
      <div className="lg:sticky lg:top-24 lg:self-start">
        <button
          type="button"
          onClick={handleBack}
          className="press-feedback -ml-1 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-1 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <ChevronLeft className="h-4 w-4" />
          返回
        </button>

        <h1 className="mt-3 text-xl font-bold tracking-tight text-[var(--text-primary)]">关注与粉丝</h1>
      </div>

      <div className="min-w-0">{listContent}</div>
    </div>
  )
}
