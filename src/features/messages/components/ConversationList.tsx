import { BellRing, ChevronLeft, ChevronRight, Heart, User, UserPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import AppState from '@/components/ui/AppState'
import Avatar from '@/features/community/components/Avatar'
import { formatRelativeTime } from '@/features/community/utils'
import { cn } from '@/lib/utils'
import { ConversationRowsSkeleton, MutualFriendsSkeleton, conversationListHeaderClass } from './MessagesLoading'
import type { Conversation, FollowUserItem, InteractionItem } from '../../../../shared/contracts/index.js'

type ConversationListProps = {
  conversations: Conversation[]
  selectedId: string | null
  onSelect: (conversationId: string) => void
  totalUnread: number
  /** 互相关注的好友（可直接发起私聊） */
  mutualFriends: FollowUserItem[]
  /** 最新关注我的人（用于「新关注我的」固定入口副标题） */
  latestFollower: FollowUserItem | null
  /** 最新互动（赞/收藏/评论，用于「互动消息」固定入口副标题） */
  latestInteraction: InteractionItem | null
  /** 互动消息未读数（红点徽标） */
  interactionsUnseen: number
  /** 新关注我的未读数（红点徽标） */
  followersUnseen: number
  onOpenFriend: (userId: string) => void
  openingFriendId: string | null
  /** 会话分页：是否还有更早的会话可加载 */
  hasMoreConversations: boolean
  /** 会话分页：正在加载下一页 */
  loadingMoreConversations: boolean
  /** 会话分页：滚动触底时加载下一页 */
  onLoadMoreConversations: () => void
  loadingConversations: boolean
  loadingFriends: boolean
  conversationError: ReactNode
  refreshNotice?: ReactNode
}

function formatUnreadBadge(count: number) {
  // 产品规则：所有红点数字上限 99，超过也只显示 99
  return count > 99 ? '99' : `${count}`
}

const listScrollClass = 'messages-list-scroll min-h-0 flex-1 overflow-y-auto'

/** 未读红点徽标：leading-none + 等宽数字保证数字落在圆圈正中心 */
function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-rose-500 px-1 text-center text-[11px] font-semibold leading-none tabular-nums text-white">
      {formatUnreadBadge(count)}
    </span>
  )
}

/** 互动类型 → 副标题动作文案 */
const INTERACTION_ACTION_TEXT: Record<InteractionItem['kind'], string> = {
  postLike: '赞了你的帖子',
  commentLike: '赞了你的评论',
  novelFavorite: '收藏了你的作品',
  novelComment: '点评了你的作品',
  chapterComment: '评论了你的章节',
  commentReply: '回复了你的评论',
  postComment: '评论了你的帖子',
}

/**
 * 消息列表面板（参考 TikTok/Facebook Messenger）：
 * - 顶部互关好友横向头像栏，点头像直接开聊
 * - 「新关注我的」「互动消息」蓝/粉固定入口 + 系统消息固定置顶
 * - 未互关的直聊归入「陌生消息」入口，点开后在子列表里查看
 * - 下方为按最近消息排序的互关私聊会话
 */
export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
  totalUnread,
  mutualFriends,
  latestFollower,
  latestInteraction,
  interactionsUnseen,
  followersUnseen,
  onOpenFriend,
  openingFriendId,
  hasMoreConversations,
  loadingMoreConversations,
  onLoadMoreConversations,
  loadingConversations,
  loadingFriends,
  conversationError,
  refreshNotice,
}: ConversationListProps) {
  const navigate = useNavigate()
  // 陌生消息子列表视图：主列表 ↔ 陌生会话列表
  const [view, setView] = useState<'main' | 'strangers'>('main')

  // 滚动触底自动加载下一页会话（参照社交媒体的无限流体验）
  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasMoreConversations || loadingMoreConversations) return
    const element = event.currentTarget
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) {
      onLoadMoreConversations()
    }
  }

  const systemConversations = conversations.filter((item) => item.type === 'system')
  const directConversations = conversations.filter((item) => item.type !== 'system')
  // 后端回填 isMutualFollow；未互关归入陌生消息，缺失标记时按互关处理避免误判
  const strangerConversations = directConversations.filter((item) => item.isMutualFollow === false)
  const friendConversations = directConversations.filter((item) => item.isMutualFollow !== false)
  const latestStranger = strangerConversations[0] ?? null
  const strangerUnread = strangerConversations.reduce((sum, item) => sum + item.unreadCount, 0)

  /** 直聊会话行：主列表与陌生消息子列表共用 */
  const renderDirectRow = (conversation: Conversation) => {
    const isActive = conversation.id === selectedId
    const isOnline = conversation.presence === 'online' || conversation.presence === 'typing'
    const displayTitle = conversation.title ?? conversation.counterpart?.nickname ?? '对方'
    // 直聊会话的头像单独点击进入对方主页，不触发选中会话
    const counterpartId = conversation.counterpart?.id ?? null

    return (
      <button
        key={conversation.id}
        type="button"
        onClick={() => onSelect(conversation.id)}
        className={cn(
          'press-feedback relative flex w-full items-center gap-3 rounded-[var(--radius-md)] py-2.5 pl-2 pr-3 text-left transition-colors',
          isActive ? 'bg-[var(--color-brand-soft)]' : 'hover:bg-[var(--surface-muted)]',
        )}
      >
        {isActive ? (
          <span className="absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-[var(--color-brand)]" />
        ) : null}

        <span
          className="relative shrink-0"
          role={counterpartId ? 'link' : undefined}
          aria-label={counterpartId ? `查看 ${displayTitle} 的主页` : undefined}
          onClick={
            counterpartId
              ? (event) => {
                  event.stopPropagation()
                  navigate(`/author/${counterpartId}`)
                }
              : undefined
          }
        >
          <Avatar name={displayTitle} src={conversation.avatarUrl ?? conversation.counterpart?.avatarUrl ?? null} size="md" />
          {isOnline ? (
            <span className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--surface-default)] bg-emerald-500" />
          ) : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                'line-clamp-1 text-sm font-medium',
                isActive ? 'text-[var(--color-brand)]' : 'text-[var(--text-primary)]',
              )}
            >
              {displayTitle}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
              {conversation.lastMessageAt ? formatRelativeTime(conversation.lastMessageAt) : ''}
            </span>
          </span>
          <span className="mt-1 flex items-center justify-between gap-2">
            <span className="line-clamp-1 text-xs text-[var(--text-secondary)]">
              {conversation.lastMessagePreview ?? '开始聊天吧'}
            </span>
            {conversation.unreadCount > 0 ? <UnreadBadge count={conversation.unreadCount} /> : null}
          </span>
        </span>
      </button>
    )
  }

  // 陌生消息子列表：带返回栏，只展示未互关会话
  if (view === 'strangers') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-2 pb-3 pt-2">
          <button
            type="button"
            onClick={() => setView('main')}
            aria-label="返回消息列表"
            className="press-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <p className="text-base font-semibold text-[var(--text-primary)]">陌生消息</p>
        </div>
        <div className={listScrollClass}>
          <p className="px-4 pb-1 pt-3 text-xs text-[var(--text-tertiary)]">互相关注前，最多给对方发送 3 条消息。</p>
          <div className="space-y-1 px-2 pb-2">
            {strangerConversations.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-[var(--text-tertiary)]">暂时没有陌生消息。</p>
            ) : (
              strangerConversations.map(renderDirectRow)
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={conversationListHeaderClass}>
        <p className="text-base font-semibold text-[var(--text-primary)]">消息</p>
        {totalUnread > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
            <BellRing className="h-3.5 w-3.5" />
            {totalUnread} 条未读
          </span>
        ) : null}
      </div>

      <div className={listScrollClass} onScroll={handleListScroll}>
        {/* 互关好友横向栏：点击头像直接发起/进入私聊 */}
        {loadingFriends ? <MutualFriendsSkeleton /> : mutualFriends.length > 0 ? (
          <div className="border-b border-[var(--border-subtle)] py-2">
            <p className="px-4 text-xs font-medium text-[var(--text-tertiary)]">互关好友</p>
            <div className="rail-scroll mt-1.5 flex gap-2.5 overflow-x-auto px-4 pb-1">
              {mutualFriends.map((friend) => (
                <button
                  key={friend.id}
                  type="button"
                  onClick={() => onOpenFriend(friend.id)}
                  aria-busy={openingFriendId === friend.id}
                  className={cn(
                    'press-feedback flex w-12 shrink-0 flex-col items-center gap-1',
                    openingFriendId === friend.id ? 'opacity-60' : null,
                  )}
                  aria-label={`给 ${friend.nickname} 发消息`}
                >
                  <span className="relative">
                    <Avatar name={friend.nickname} src={friend.avatarUrl} size="md" />
                    {friend.presence === 'online' ? (
                      <span className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--surface-default)] bg-emerald-500" />
                    ) : null}
                  </span>
                  <span className="w-full truncate text-center text-[11px] text-[var(--text-secondary)]">
                    {friend.nickname}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-1 p-2">
          {/* 固定入口：新关注我的 */}
          <button
            type="button"
            onClick={() => navigate('/me/follows?tab=followers')}
            className="press-feedback flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-500">
              <UserPlus className="h-5 w-5 text-white" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="text-sm font-medium text-[var(--text-primary)]">新关注我的</span>
                  {followersUnseen > 0 ? <UnreadBadge count={followersUnseen} /> : null}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                  {latestFollower ? formatRelativeTime(latestFollower.followedAt) : ''}
                </span>
              </span>
              <span className="mt-1 block">
                <span className="line-clamp-1 text-xs text-[var(--text-secondary)]">
                  {latestFollower ? `${latestFollower.nickname} 关注了你` : '关注你的人会出现在这里'}
                </span>
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
          </button>

          {/* 固定入口：互动消息（赞/收藏提醒，进获赞明细） */}
          <button
            type="button"
            onClick={() => navigate('/me/likes')}
            className="press-feedback flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-500">
              <Heart className="h-5 w-5 text-white" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="text-sm font-medium text-[var(--text-primary)]">互动消息</span>
                  {interactionsUnseen > 0 ? <UnreadBadge count={interactionsUnseen} /> : null}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                  {latestInteraction ? formatRelativeTime(latestInteraction.happenedAt) : ''}
                </span>
              </span>
              <span className="mt-1 block">
                <span className="line-clamp-1 text-xs text-[var(--text-secondary)]">
                  {latestInteraction
                    ? `${latestInteraction.user.nickname} ${INTERACTION_ACTION_TEXT[latestInteraction.kind]}`
                    : '收到的赞、收藏和评论会出现在这里'}
                </span>
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
          </button>

          {/* 固定置顶：系统消息 */}
          {systemConversations.map((conversation) => {
            const isActive = conversation.id === selectedId

            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelect(conversation.id)}
                className={cn(
                  'press-feedback flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left transition-colors',
                  isActive ? 'bg-[var(--color-brand-soft)]' : 'hover:bg-[var(--surface-muted)]',
                )}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-500">
                  <BellRing className="h-5 w-5 text-white" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        'line-clamp-1 text-sm font-medium',
                        isActive ? 'text-[var(--color-brand)]' : 'text-[var(--text-primary)]',
                      )}
                    >
                      {conversation.title ?? '系统通知'}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                      {conversation.lastMessageAt ? formatRelativeTime(conversation.lastMessageAt) : ''}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs text-[var(--text-secondary)]">
                      {conversation.lastMessagePreview ?? '系统提醒'}
                    </span>
                    {conversation.unreadCount > 0 ? <UnreadBadge count={conversation.unreadCount} /> : null}
                  </span>
                </span>
              </button>
            )
          })}

          {/* 固定入口：陌生消息（未互关的直聊统一收在这里） */}
          {strangerConversations.length > 0 ? (
            <button
              type="button"
              onClick={() => setView('strangers')}
              className="press-feedback flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500">
                <User className="h-5 w-5 text-white" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-sm font-medium text-[var(--text-primary)]">陌生消息</span>
                    {strangerUnread > 0 ? <UnreadBadge count={strangerUnread} /> : null}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                    {latestStranger?.lastMessageAt ? formatRelativeTime(latestStranger.lastMessageAt) : ''}
                  </span>
                </span>
                <span className="mt-1 block">
                  <span className="line-clamp-1 text-xs text-[var(--text-secondary)]">
                    {latestStranger?.lastMessagePreview ?? '没有新消息'}
                  </span>
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
            </button>
          ) : null}
        </div>

        {/* 互关私聊会话 */}
        <div className="space-y-1 px-2 pb-2">
          {refreshNotice}
          {loadingConversations ? <ConversationRowsSkeleton /> : conversationError || (friendConversations.length === 0 ? (
            <AppState compact scene="message" title="还没有私聊" description={mutualFriends.length > 0 ? '选择好友开始聊天。' : undefined} />
          ) : (
            friendConversations.map(renderDirectRow)
          ))}

          {/* 会话分页：加载中提示（触底自动加载下一页） */}
          {loadingMoreConversations ? (
            <p className="px-2 py-3 text-center text-xs text-[var(--text-tertiary)]">正在加载更多会话...</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
