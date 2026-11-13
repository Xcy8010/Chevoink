import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Heart, MessageCircle, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { getInteractionBadges, listInteractions, markInteractionSeen } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import { formatRelativeTime } from '@/features/community/utils'
import { MessageDetailRowsSkeleton, detailLayoutClass, detailRowClass } from '@/features/messages/components/MessagesLoading'
import { cn } from '@/lib/utils'
import type { InteractionItem } from '../../shared/contracts'

/** 互动类型 → 动作文案 + 行尾图标 */
const KIND_META: Record<
  InteractionItem['kind'],
  { action: string; icon: typeof Heart; iconClass: string }
> = {
  postLike: { action: ' 赞了你的帖子', icon: Heart, iconClass: 'fill-[var(--color-brand)] text-[var(--color-brand)]' },
  commentLike: { action: ' 赞了你的评论', icon: Heart, iconClass: 'fill-[var(--color-brand)] text-[var(--color-brand)]' },
  novelFavorite: { action: ' 收藏了你的作品', icon: Heart, iconClass: 'fill-rose-500 text-rose-500' },
  novelComment: { action: ' 点评了你的作品', icon: MessageCircle, iconClass: 'text-[var(--color-brand)]' },
  chapterComment: { action: ' 评论了你的章节', icon: MessageCircle, iconClass: 'text-[var(--color-brand)]' },
  commentReply: { action: ' 回复了你的评论', icon: MessageCircle, iconClass: 'text-[var(--color-brand)]' },
  postComment: { action: ' 评论了你的帖子', icon: MessageCircle, iconClass: 'text-[var(--color-brand)]' },
}

/** 明细行的跳转目标：章节评论/回复直达阅读器并自动展开评论面板，帖子进帖子，作品进作品页 */
function getInteractionTargetPath(item: InteractionItem): string | null {
  if (item.chapterId && item.novelId) {
    // 段评带上段落序号：阅读器直达对应段落并高亮闪一下
    const paragraph = typeof item.paragraphIndex === 'number' ? `&paragraph=${item.paragraphIndex}` : ''
    return `/novel/${item.novelId}/read/${item.chapterId}?panel=comments${paragraph}`
  }
  if (item.postId) {
    return `/post/${item.postId}`
  }
  if (item.novelId) {
    return `/novel/${item.novelId}`
  }
  return null
}

/** 上下文行：作品/章节标题（收藏、作品评论、章节评论时展示） */
function getInteractionContext(item: InteractionItem): string | null {
  if (!item.novelTitle) {
    return null
  }
  if (item.kind === 'chapterComment' && item.chapterTitle) {
    return `《${item.novelTitle}》· ${item.chapterTitle}`
  }
  return `《${item.novelTitle}》`
}

/**
 * 互动消息页（/me/likes）：赞、收藏、作品评论、章节评论统一通知流，
 * TikTok 通知流风格——头像 + 昵称动作行 + 内容摘要 + 时间，行点击直达内容。
 * 进入即标记已读（消息页红点归零），本次新增的互动会高亮闪烁提示。
 */
export default function LikesListPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  /** 优先回到上一页（可能来自消息页/个人中心），没有历史记录时回个人中心 */
  function handleBack() {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate('/me')
  }

  const interactionsQuery = useQuery({
    queryKey: ['community', 'interactions'],
    queryFn: listInteractions,
  })

  // 进入页面：先记住旧的已读水位（判定哪些是新消息），再标记已读并同步红点缓存
  const [seenBefore, setSeenBefore] = useState<string | null | undefined>(undefined)
  const markedRef = useRef(false)
  useEffect(() => {
    if (markedRef.current) return
    markedRef.current = true

    void getInteractionBadges()
      .then((badges) => {
        setSeenBefore(badges.interactionsSeenAt)
        return markInteractionSeen('interactions')
      })
      .then((latest) => {
        queryClient.setQueryData(['community', 'interaction-badges'], latest)
      })
      .catch(() => {
        // 已读标记失败不阻断浏览，红点会在下次进入时重新对齐
      })
  }, [queryClient])

  const items = interactionsQuery.data?.items ?? []

  return (
    // 壳层大标题已隐藏；lg 起双栏：左侧 sticky 返回/标题栏 + 右侧明细列表，避免大屏左右留白
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

        <h1 className="mt-3 flex items-baseline gap-2 text-xl font-bold tracking-tight text-[var(--text-primary)]">
          <Heart className="h-4 w-4 self-center text-[var(--color-brand)]" />
          互动消息
          {interactionsQuery.data && <span className="text-sm font-normal tabular-nums text-[var(--text-tertiary)]">{items.length}</span>}
        </h1>
      </div>

      <div className="mt-4 min-w-0 lg:mt-0">
        {interactionsQuery.isRefetchError ? <AppStateRefreshNotice retry={interactionsQuery.refetch} busy={interactionsQuery.isFetching} /> : null}
        {interactionsQuery.isLoading ? (
          <MessageDetailRowsSkeleton variant="interactions" />
        ) : interactionsQuery.isError && !interactionsQuery.data ? (
          <AppState
            compact
            tone="error"
            title="互动消息暂时没有加载"
            primaryAction={{ label: '重新加载', onClick: () => interactionsQuery.refetch(), busy: interactionsQuery.isFetching }}
          />
        ) : items.length === 0 ? (
          <AppState
            compact
            scene="message"
            title="还没有收到互动"
            primaryAction={{ label: '去社区', href: '/community' }}
          />
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {items.map((item) => {
              const meta = KIND_META[item.kind]
              const TrailingIcon = meta.icon
              const targetPath = getInteractionTargetPath(item)
              const context = getInteractionContext(item)
              // 新消息判定：晚于进入前的已读水位（从未看过则全部视为新）
              const isNew =
                seenBefore !== undefined && (!seenBefore || item.happenedAt > seenBefore)

              return (
                <div
                  key={item.id}
                  role={targetPath ? 'button' : undefined}
                  tabIndex={targetPath ? 0 : undefined}
                  onClick={targetPath ? () => navigate(targetPath) : undefined}
                  onKeyDown={
                    targetPath
                      ? (event) => {
                          if (event.key === 'Enter') {
                            navigate(targetPath)
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    detailRowClass,
                    'items-start',
                    targetPath ? 'cursor-pointer transition-colors hover:bg-[var(--surface-muted)]' : null,
                    isNew ? 'animate-unseen-flash' : null,
                  )}
                >
                  <span
                    role="link"
                    aria-label={`查看 ${item.user.nickname} 的主页`}
                    onClick={(event) => {
                      event.stopPropagation()
                      navigate(`/author/${item.user.id}`)
                    }}
                    className="shrink-0"
                  >
                    <Avatar name={item.user.nickname} src={item.user.avatarUrl} size="md" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 text-sm leading-6 text-[var(--text-primary)]">
                      <span>
                        <span className="font-medium">{item.user.nickname}</span>
                        <span className="text-[var(--text-secondary)]">{meta.action}</span>
                      </span>
                      {typeof item.rating === 'number' && item.rating > 0 ? (
                        <span className="inline-flex items-center gap-0.5">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <Star
                              key={star}
                              className={`h-3 w-3 ${
                                star <= item.rating! ? 'fill-amber-400 text-amber-400' : 'text-[var(--border-strong)]'
                              }`}
                            />
                          ))}
                        </span>
                      ) : null}
                    </p>
                    {item.excerpt ? (
                      <p className="mt-0.5 line-clamp-2 text-[13px] leading-6 text-[var(--text-tertiary)]">
                        {item.excerpt}
                      </p>
                    ) : null}
                    <p className="mt-1 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                      <span>{formatRelativeTime(item.happenedAt)}</span>
                      {context ? <span className="line-clamp-1">{context}</span> : null}
                    </p>
                  </div>
                  <TrailingIcon className={cn('mt-1.5 h-4 w-4 shrink-0', meta.iconClass)} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
