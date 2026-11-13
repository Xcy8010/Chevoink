import { ChevronLeft, Heart } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { useDevice } from '@/components/layout/device-context'
import { Skeleton, SkeletonAvatar } from '@/components/ui/Skeleton'
import Avatar from '@/features/community/components/Avatar'

export const messagePanelClass = 'flex min-h-0 flex-1 overflow-hidden md:rounded-[var(--radius-lg)] md:border md:border-[var(--border-subtle)] md:bg-[var(--surface-default)] md:shadow-[var(--shadow-card)]'
export const conversationListPaneClass = 'h-full w-full shrink-0 overflow-hidden md:w-[300px] md:border-r md:border-[var(--border-subtle)] xl:w-[360px]'
export const conversationPaneClass = 'flex h-full min-w-0 flex-1 flex-col overflow-hidden'
export const conversationHeaderClass = 'flex items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-3 mobile:gap-2 mobile:px-1.5'
export const conversationListHeaderClass = 'flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 pb-3 pt-2'
export const detailLayoutClass = 'mx-auto w-full max-w-[640px] lg:grid lg:max-w-[1020px] lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start lg:gap-12'
export const detailRowClass = 'flex gap-3 px-1 py-3.5 sm:rounded-[var(--radius-lg)] sm:px-3'
const detailBackClass = 'press-feedback -ml-1 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-1 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]'

export function ConversationBackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="返回会话列表"
      className="touch-target press-feedback inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
    >
      <ChevronLeft className="h-5 w-5" />
    </button>
  )
}

export function ConversationRowsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-busy="true" aria-label="会话列表加载中">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex w-full items-center gap-3 px-2 py-2.5">
          <SkeletonAvatar size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex h-5 items-center justify-between gap-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-2.5 w-10 shrink-0" />
            </div>
            <div className="mt-1 flex h-4 items-center">
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function MutualFriendsSkeleton() {
  return (
    <div className="border-b border-[var(--border-subtle)] py-2" aria-hidden="true">
      <div className="px-4 text-xs font-medium text-[var(--text-tertiary)]">互关好友</div>
      <div className="mt-1.5 flex gap-2.5 px-4 pb-1">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex w-12 flex-col items-center gap-1">
            <SkeletonAvatar size={44} />
            <Skeleton className="my-[3px] h-2.5 w-8" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ConversationBubblesSkeleton() {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-hidden px-4 py-5" aria-busy="true" aria-label="会话加载中">
      <Skeleton className="h-10 w-3/5 rounded-[16px]" />
      <Skeleton className="ml-auto h-10 w-1/2 rounded-[16px]" />
      <Skeleton className="h-16 w-2/3 rounded-[16px]" />
      <Skeleton className="ml-auto h-10 w-2/5 rounded-[16px]" />
    </div>
  )
}

export function PendingConversationHeader({ onBack, person }: {
  onBack?: () => void
  person?: { nickname: string; avatarUrl: string | null }
}) {
  return (
    <div className={conversationHeaderClass}>
      {onBack && <ConversationBackButton onBack={onBack} />}
      {person ? (
        <>
          <Avatar name={person.nickname} src={person.avatarUrl} size="sm" />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">{person.nickname}</h3>
        </>
      ) : (
        <>
          <SkeletonAvatar size={36} />
          <Skeleton className="h-3.5 w-24" />
        </>
      )}
    </div>
  )
}

export function ChatInputSkeleton() {
  return (
    <div className="flex items-end gap-1.5 bg-[var(--surface-default)] px-2.5 pb-[calc(var(--safe-bottom)+10px)] pt-2 md:border-t md:border-[var(--border-subtle)] md:px-3 md:pb-3 md:pt-3" aria-hidden="true">
      <SkeletonAvatar size={40} />
      <Skeleton className="h-10 flex-1 rounded-[20px]" />
      <SkeletonAvatar size={40} />
    </div>
  )
}

export function MessagesRouteSkeleton() {
  const { isMobile } = useDevice()
  const [params, setParams] = useSearchParams()
  const showChat = params.has('conversationId')
  return (
    <div className={messagePanelClass} aria-busy="true">
      {(!isMobile || !showChat) && (
        <aside className={conversationListPaneClass}>
          <div className={conversationListHeaderClass}>
            <p className="text-base font-semibold text-[var(--text-primary)]">消息</p>
          </div>
          <MutualFriendsSkeleton />
          <div className="p-2"><ConversationRowsSkeleton count={5} /></div>
        </aside>
      )}
      {(!isMobile || showChat) && (
        <section className={conversationPaneClass}>
          <PendingConversationHeader onBack={isMobile ? () => setParams({}) : undefined} />
          <ConversationBubblesSkeleton />
          <ChatInputSkeleton />
        </section>
      )}
    </div>
  )
}

export function MessageDetailRowsSkeleton({ variant }: { variant: 'follows' | 'interactions' }) {
  const follows = variant === 'follows'
  return (
    <div className="divide-y divide-[var(--border-subtle)]" aria-busy="true" aria-label="列表加载中">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className={`${detailRowClass} ${follows ? 'items-center' : 'items-start'}`}>
          <SkeletonAvatar size={44} />
          <div className="min-w-0 flex-1">
            <div className={`flex items-center ${follows ? 'h-5' : 'h-6'}`}><Skeleton className="h-3.5 w-2/5" /></div>
            <div className={`flex h-4 items-center ${follows ? 'mt-0.5' : 'mt-1'}`}><Skeleton className="h-3 w-24" /></div>
          </div>
          {follows ? (
            <><Skeleton className="h-8 w-16" /><Skeleton className="h-4 w-4" /></>
          ) : <Skeleton className="mt-1.5 h-4 w-4 shrink-0" />}
        </div>
      ))}
    </div>
  )
}

export function MessageDetailRouteSkeleton({ variant }: { variant: 'follows' | 'interactions' }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const follows = variant === 'follows'
  return (
    <div className={detailLayoutClass}>
      <div className="lg:sticky lg:top-24 lg:self-start">
        <button type="button" onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/me')} className={detailBackClass}>
          <ChevronLeft className="h-4 w-4" />
          返回
        </button>
        {follows ? (
          <>
            <h1 className="mt-3 text-xl font-bold tracking-tight text-[var(--text-primary)]">关注与粉丝</h1>
            <p className="mt-1 hidden text-sm text-[var(--text-tertiary)] lg:block">随时回访、回关或取消关注。</p>
          </>
        ) : (
          <>
            <h1 className="mt-3 flex items-baseline gap-2 text-xl font-bold tracking-tight text-[var(--text-primary)]">
              <Heart className="h-4 w-4 self-center text-[var(--color-brand)]" />
              互动消息
            </h1>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">谁赞了、收藏了、评论了你的内容，都在这里。</p>
          </>
        )}
      </div>
      <div className={follows ? 'min-w-0' : 'mt-4 min-w-0 lg:mt-0'}>
        {follows && (
          <div className="my-4 flex gap-2" aria-hidden="true">
            {['关注', '粉丝'].map((label, index) => (
              <span key={label} className={`inline-flex rounded-[var(--radius-pill)] border px-4 py-2 text-sm font-medium ${(params.get('tab') === 'followers') === (index === 1) ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white' : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>
                {label}
              </span>
            ))}
          </div>
        )}
        <MessageDetailRowsSkeleton variant={variant} />
      </div>
    </div>
  )
}
