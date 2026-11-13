import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, MessageSquareMore, Share2, UserCheck2, UserPlus2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import AppImage from '@/components/ui/AppImage'
import { ApiClientError } from '@/app/api-client'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import Button from '@/components/ui/Button'
import { PostListSkeleton, Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/toast-context'
import { createDirectConversation, getDirectConversationByUserId, getMe, getUser, listConversations, listNovels, listPosts, setUserFollow } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import PostCard from '@/features/community/components/PostCard'
import ShareMenu from '@/features/community/components/ShareMenu'
import { formatRelativeTime } from '@/features/community/utils'
import { getCoverUrl, getDisplayTitle } from '@/features/discover/api'
import { LikedPostsPanel, RepliesPanel } from '@/features/profile/components/UserContentPanels'
import { cn } from '@/lib/utils'

const authorTabs = [
  { id: 'novels', label: '作品' },
  { id: 'posts', label: '动态' },
  { id: 'liked', label: '喜欢' },
  { id: 'replies', label: '已回复' },
] as const

type AuthorTab = (typeof authorTabs)[number]['id']

const CONTENT_MAX_WIDTH = 'max-w-[680px] md:max-w-[840px] lg:max-w-[1080px] xl:max-w-[1200px]'

/**
 * 独立页面骨架：sticky 返回栏 + 整页滚动容器。
 * body 为 overflow:hidden，本页自己做满屏滚动容器（隐藏滚动条），
 * headerContent（封面/资料/tab）与 children（列表）在同一滚动流里整页一起滚动。
 */
function PageChrome({
  onBack,
  headerContent,
  children,
  centered = false,
}: {
  onBack: () => void
  headerContent?: ReactNode
  children: ReactNode
  centered?: boolean
}) {
  return (
    <div className="app-main-scroll relative h-dvh overflow-y-auto">
      {/* X 风格：返回按钮以浮层圆钮压在封面左上角，随封面一起滚动 */}
      <button
        type="button"
        onClick={onBack}
        aria-label="返回上一页"
        className="press-feedback absolute left-3 top-3 z-40 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition-colors hover:bg-black/50"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className={cn('mx-auto w-full px-4', centered ? 'flex min-h-full flex-col py-12' : 'pb-16', CONTENT_MAX_WIDTH)}>
        {headerContent}
        {children}
      </div>
    </div>
  )
}

/**
 * 作者主页：独立全屏页面（无导航壳层），X 风格平铺结构——
 * sticky 返回栏 + 封面 + 头像压边 + 纯文本资料与数据行 + 作品/动态 tab，
 * 不做卡片套卡片，小屏封面全出血。
 */
export default function AuthorPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const { authorId } = useParams()
  const [activeTab, setActiveTab] = useState<AuthorTab>('novels')

  // 关注状态本地乐观覆盖：接口返回前先按点击结果展示，失败再回滚
  const [followOverride, setFollowOverride] = useState<{ following: boolean; followerCount: number } | null>(null)
  const [followSubmitting, setFollowSubmitting] = useState(false)
  const [messagingSubmitting, setMessagingSubmitting] = useState(false)

  // 切换到另一位作者时清掉上一位的乐观覆盖与 tab 状态，避免串页
  useEffect(() => {
    setFollowOverride(null)
    setActiveTab('novels')
  }, [authorId])

  const meQuery = useQuery({
    queryKey: ['community', 'me'],
    queryFn: getMe,
  })

  const authorQuery = useQuery({
    queryKey: ['community', 'author', authorId],
    queryFn: () => getUser(authorId ?? ''),
    enabled: Boolean(authorId),
  })

  const novelsQuery = useQuery({
    queryKey: ['community', 'novels', 'author', authorId],
    queryFn: () => listNovels(20, { authorId, publishedOnly: true }),
    enabled: Boolean(authorId),
  })

  const postsQuery = useQuery({
    queryKey: ['community', 'posts', 'author', authorId],
    queryFn: () => listPosts(10, { authorId }),
    enabled: Boolean(authorId),
  })

  const conversationsQuery = useQuery({
    queryKey: ['community', 'conversations'],
    queryFn: () => listConversations(),
    // 未登录时不请求会话列表，避免无意义的接口开销
    enabled: Boolean(meQuery.data?.user),
  })

  const authorNovels = useMemo(() => {
    const author = authorQuery.data
    if (!author) {
      return []
    }

    return (novelsQuery.data?.items ?? []).filter((novel) => novel.author.id === author.id)
  }, [authorQuery.data, novelsQuery.data?.items])

  const authorPosts = useMemo(() => {
    const author = authorQuery.data
    if (!author) {
      return []
    }

    return (postsQuery.data?.items ?? []).filter((post) => post.author.id === author.id)
  }, [authorQuery.data, postsQuery.data?.items])

  const isOwnProfile = Boolean(authorQuery.data && meQuery.data?.user && authorQuery.data.id === meQuery.data.user.id)
  const isLoggedIn = Boolean(meQuery.data?.user)
  const isFollowing = followOverride?.following ?? Boolean(authorQuery.data?.followedByViewer)
  const followerCount = followOverride?.followerCount ?? authorQuery.data?.followerCount ?? 0
  const likesCount = useMemo(
    () => authorPosts.reduce((total, post) => total + post.likeCount + post.favoriteCount, 0),
    [authorPosts],
  )

  async function handleToggleFollow() {
    const author = authorQuery.data
    if (!author || followSubmitting) {
      return
    }

    if (!isLoggedIn) {
      navigate(`/login?redirect=${encodeURIComponent(`/author/${author.id}`)}`)
      return
    }

    const nextFollowing = !isFollowing
    setFollowSubmitting(true)
    setFollowOverride({
      following: nextFollowing,
      followerCount: Math.max(0, followerCount + (nextFollowing ? 1 : -1)),
    })

    try {
      const payload = await setUserFollow(author.id, nextFollowing)
      setFollowOverride(payload)
    } catch {
      setFollowOverride(null)
    } finally {
      setFollowSubmitting(false)
    }
  }

  function handleBack() {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate('/')
  }

  const directConversation = useMemo(
    () => getDirectConversationByUserId(conversationsQuery.data?.items ?? [], authorQuery.data?.id),
    [authorQuery.data?.id, conversationsQuery.data?.items],
  )

  /** 私信入口：已有直聊会话直接进，否则先创建；未互关时后端会按陌生消息限 3 条 */
  async function handleOpenMessage() {
    const author = authorQuery.data
    if (!author || messagingSubmitting) {
      return
    }

    if (!isLoggedIn) {
      navigate(`/login?redirect=${encodeURIComponent(`/author/${author.id}`)}`)
      return
    }

    if (directConversation) {
      navigate(`/messages?conversationId=${directConversation.id}`)
      return
    }

    setMessagingSubmitting(true)
    try {
      const conversation = await createDirectConversation(author.id)
      // 新建会话可能不在 staleTime 内的会话列表缓存里，先失效再跳转，避免消息页选不中
      await queryClient.invalidateQueries({ queryKey: ['community', 'conversations'] })
      navigate(`/messages?conversationId=${conversation.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '会话暂时没有打开，请稍后再试。')
    } finally {
      setMessagingSubmitting(false)
    }
  }

  const error = authorQuery.error
  const missing = error instanceof ApiClientError && error.status === 404
  if (!authorId || missing) {
    return (
      <PageChrome onBack={handleBack} centered>
        <AppState
          scene="search"
          title="找不到这位作者"
          primaryAction={{ label: '返回社区', href: '/community' }}
          className="flex-1"
        />
      </PageChrome>
    )
  }

  if (authorQuery.isLoading) {
    return (
      <PageChrome onBack={handleBack}>
        <div className="-mx-4 sm:mx-0 sm:pt-3">
          <Skeleton className="aspect-[3/1] w-full sm:rounded-[var(--radius-xl)]" />
        </div>
        <div className="px-1 sm:px-2">
          <Skeleton className="-mt-9 h-[76px] w-[76px] rounded-full border-4 border-[var(--app-bg)] sm:-mt-12 sm:h-24 sm:w-24" />
          <Skeleton className="mt-4 h-6 w-40" />
          <Skeleton className="mt-3 h-4 w-64" />
        </div>
      </PageChrome>
    )
  }

  const accessDenied = error instanceof ApiClientError && (error.status === 401 || error.status === 403)
  if (!authorQuery.data || accessDenied) {
    return (
      <PageChrome onBack={handleBack} centered>
        <AppState
          tone="error"
          title="作者主页暂时没有打开"
          description={accessDenied ? error.message : '请稍后重试。'}
          primaryAction={{ label: '重新加载', onClick: () => authorQuery.refetch(), busy: authorQuery.isFetching }}
          secondaryAction={{ label: '返回社区', href: '/community' }}
          className="flex-1"
        />
      </PageChrome>
    )
  }

  const author = authorQuery.data

  // 数据行可点：作品/获赞切到对应 tab（tab 已固定，无需滚动），粉丝进入该作者的关注·粉丝列表页
  function scrollToTabs(tab: AuthorTab) {
    setActiveTab(tab)
  }

  const stats = [
    { label: '作品', value: authorNovels.length, onClick: () => scrollToTabs('novels') },
    { label: '粉丝', value: followerCount, onClick: () => navigate(`/author/${author.id}/follows?tab=followers`) },
    { label: '获赞', value: likesCount, onClick: () => scrollToTabs('posts') },
  ]

  // 按隐私设置隐藏不可见的 tab（X 式：直接不展示入口），本人永远可见
  const visibleTabs = authorTabs.filter((tab) => {
    if (tab.id === 'liked') {
      return isOwnProfile || author.visibility?.favorites !== false
    }
    if (tab.id === 'replies') {
      return isOwnProfile || author.visibility?.replies !== false
    }
    return true
  })

  // 头部：封面 + 资料（头像/昵称/简介/数据行）+ tab 栏，与下方列表整页一起滚动
  const headerContent = (
    <>
      {/* 封面占顶部区域：与上传裁切比例（3:1）一致，避免 object-cover 把手机端封面裁掉；
          小屏全出血、sm 起圆角；lg 宽屏压扁比例避免过高；无封面用与个人中心一致的渐变。
          外层 relative 不裁剪，供右上角分享浮层按钮的下拉菜单不被封面 overflow-hidden 截断 */}
      <div className="relative -mx-4 sm:mx-0 sm:mt-3">
        <div className="relative aspect-[3/1] overflow-hidden sm:rounded-[var(--radius-xl)] lg:aspect-[4/1]">
          {author.profileCoverUrl ? (
            <AppImage src={author.profileCoverUrl} alt="作者封面" className="absolute inset-0 h-full w-full" />
          ) : (
            <div className="absolute inset-0 bg-[linear-gradient(135deg,#28435f_0%,#16233a_58%,#1f2f47_100%)]" />
          )}
        </div>
        {/* 分享按钮：X 风格浮层圆钮，压在封面右上角 */}
        <div className="absolute right-3 top-3 z-10">
          <ShareMenu
            share={{
              kind: 'author',
              author: {
                id: author.id,
                nickname: author.nickname,
                avatarUrl: author.avatarUrl ?? null,
                bio: author.bio ?? null,
              },
            }}
            url={`${window.location.origin}/author/${author.id}`}
            placement="down"
            triggerClassName="press-feedback inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition-colors hover:bg-black/50"
            triggerContent={<Share2 className="h-4 w-4" />}
            ariaLabel="分享作者主页"
          />
        </div>
      </div>

      {/* 头像压住封面下缘，操作按钮右对齐——同一行 */}
      <div className="flex items-start justify-between px-1 sm:px-2">
        <Avatar
          name={author.nickname}
          src={author.avatarUrl}
          size="lg"
          className="relative z-10 -mt-9 h-[76px] w-[76px] border-4 border-[var(--app-bg)] bg-[var(--surface-muted)] sm:-mt-12 sm:h-24 sm:w-24"
        />
        <div className="mt-3 flex shrink-0 items-center gap-2">
          {isOwnProfile ? (
            <Button variant="secondary" size="sm" onClick={() => navigate('/studio')}>
              继续创作
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={messagingSubmitting}
                onClick={() => void handleOpenMessage()}
              >
                <MessageSquareMore className="h-4 w-4" />
                私信
              </Button>
              <Button
                variant={isFollowing ? 'secondary' : 'primary'}
                size="sm"
                disabled={followSubmitting}
                onClick={() => void handleToggleFollow()}
              >
                {isFollowing ? <UserCheck2 className="h-4 w-4" /> : <UserPlus2 className="h-4 w-4" />}
                {isFollowing ? '已关注' : '关注'}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-2.5 space-y-2 px-1 sm:px-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="truncate text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">
            {author.nickname}
          </h1>
          {author.isAuthor ? (
            <span className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)]">
              创作者
            </span>
          ) : null}
        </div>

        <p className="max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
          {author.bio || '这位作者还没有留下简介。'}
        </p>

        <p className="text-xs text-[var(--text-tertiary)]">
          {author.createdAt ? `${formatRelativeTime(author.createdAt)}加入启创墨域` : '最近加入启创墨域'}
        </p>

        {/* 数据行：可点击，作品/获赞切 tab，粉丝进列表页 */}
        <div className="flex items-center gap-4 text-[13px] text-[var(--text-tertiary)] sm:gap-5 sm:text-sm">
          {stats.map((stat) => (
            <button
              key={stat.label}
              type="button"
              onClick={stat.onClick}
              className="press-feedback whitespace-nowrap transition-colors hover:text-[var(--text-primary)]"
            >
              <span className="font-semibold tabular-nums text-[var(--text-primary)]">{stat.value}</span> {stat.label}
            </button>
          ))}
        </div>
      </div>

      {/* 作品 / 动态 tab：X 风格文字 + 活动下划线，无胶囊容器 */}
      <div className="mt-4 flex border-b border-[var(--border-subtle)]">
        {visibleTabs.map((tab) => {
          const count = tab.id === 'novels' ? authorNovels.length : tab.id === 'posts' ? authorPosts.length : null
          const active = activeTab === tab.id

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="press-feedback relative flex-1 px-2 py-3 text-center transition-colors hover:bg-[var(--surface-muted)] sm:flex-none sm:px-6"
            >
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 text-[15px] transition-colors',
                  active ? 'font-bold text-[var(--text-primary)]' : 'font-medium text-[var(--text-tertiary)]',
                )}
              >
                {tab.label}
                {count !== null ? <span className="text-xs font-normal opacity-75">{count}</span> : null}
              </span>
              {active ? (
                <span className="absolute inset-x-0 bottom-0 mx-auto h-1 w-14 rounded-full bg-[var(--color-brand)]" />
              ) : null}
            </button>
          )
        })}
      </div>
    </>
  )

  return (
    <PageChrome onBack={handleBack} headerContent={headerContent}>
      {authorQuery.isError ? <AppStateRefreshNotice retry={authorQuery.refetch} busy={authorQuery.isFetching} /> : null}
      <div className="pt-2">
        {activeTab === 'novels' && novelsQuery.isRefetchError ? <AppStateRefreshNotice retry={novelsQuery.refetch} busy={novelsQuery.isFetching} /> : null}
        {activeTab === 'posts' && postsQuery.isRefetchError ? <AppStateRefreshNotice retry={postsQuery.refetch} busy={postsQuery.isFetching} /> : null}
        {activeTab === 'novels' ? (
          novelsQuery.isLoading ? (
            <div className="space-y-3 px-1 pt-3 sm:px-2">
              <Skeleton className="h-24 w-full rounded-[var(--radius-lg)]" />
              <Skeleton className="h-24 w-full rounded-[var(--radius-lg)]" />
            </div>
          ) : novelsQuery.isError && !novelsQuery.data ? (
            <AppState compact tone="error" title="作品加载失败" primaryAction={{ label: '重试', onClick: () => novelsQuery.refetch(), busy: novelsQuery.isFetching }} />
          ) : authorNovels.length > 0 ? (
            <div className="divide-y divide-[var(--border-subtle)] md:grid md:grid-cols-2 md:gap-x-4 md:divide-y-0">
              {authorNovels.map((novel) => {
                const coverUrl = getCoverUrl(novel.coverUrl)

                return (
                <Link
                  key={novel.id}
                  to={`/novel/${novel.id}`}
                  className="group flex items-center gap-3.5 px-1 py-3.5 transition-colors hover:bg-[var(--surface-muted)] sm:rounded-[var(--radius-lg)] sm:px-2"
                >
                  {coverUrl ? (
                    <AppImage
                      src={coverUrl}
                      alt={getDisplayTitle(novel)}
                      className="aspect-[20/27] w-[64px] shrink-0 rounded-[8px] border border-[var(--border-subtle)]"
                    />
                  ) : (
                    <div className="flex aspect-[20/27] w-[64px] shrink-0 items-end rounded-[8px] bg-[var(--surface-muted)] p-1.5">
                      <span className="line-clamp-3 text-[10px] font-medium leading-snug text-[var(--text-secondary)]">
                        {getDisplayTitle(novel)}
                      </span>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] font-semibold text-[var(--text-primary)] transition-colors group-hover:text-[var(--color-brand)]">
                      {getDisplayTitle(novel)}
                    </h3>
                    <p className="mt-1 line-clamp-2 text-[13px] leading-6 text-[var(--text-secondary)]">
                      {novel.summary}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                </Link>
                )
              })}
            </div>
          ) : (
            <AppState
              compact
              scene="writing"
              title="还没有公开作品"
            />
          )
        ) : activeTab === 'posts' ? (
          postsQuery.isLoading ? (
            <div className="pt-3">
              <PostListSkeleton count={2} />
            </div>
          ) : postsQuery.isError && !postsQuery.data ? (
            <AppState compact tone="error" title="动态加载失败" primaryAction={{ label: '重试', onClick: () => postsQuery.refetch(), busy: postsQuery.isFetching }} />
          ) : authorPosts.length > 0 ? (
            <div className="divide-y divide-[var(--border-subtle)]">
              {authorPosts.map((post) => (
                <div key={post.id} className="py-1">
                  <PostCard post={post} flat />
                </div>
              ))}
            </div>
          ) : (
            <AppState
              compact
              scene="message"
              title="还没有公开讨论"
            />
          )
        ) : activeTab === 'liked' ? (
          <LikedPostsPanel userId={author.id} isSelf={isOwnProfile} />
        ) : (
          <RepliesPanel userId={author.id} isSelf={isOwnProfile} />
        )}
      </div>
    </PageChrome>
  )
}
