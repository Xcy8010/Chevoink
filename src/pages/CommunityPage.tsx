import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { useToast } from '@/components/ui/toast-context'
import { createPost, listPosts, listTopics } from '@/features/community/api'
import { CommunityFeedRows, CommunityFeedSkeleton, CommunityPageLayout } from '@/features/community/components/CommunityPageLayout'
import PostCard from '@/features/community/components/PostCard'
import PostComposer from '@/features/community/components/PostComposer'
import TopicChannelBar, { type CommunityTopic } from '@/features/community/components/TopicChannelBar'
import { readShareDraftFromState, type CommunityShareDraft } from '@/features/community/share'
import { cn } from '@/lib/utils'

const feedModes = [
  { id: 'recommended', label: '推荐' },
  { id: 'latest', label: '最新' },
] as const

type FeedMode = (typeof feedModes)[number]['id']

export default function CommunityPage() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const location = useLocation()
  const navigate = useNavigate()
  const search = new URLSearchParams(location.search)
  const activeTopicId = search.get('topic') || 'all'
  const activeFeedMode: FeedMode = search.get('sort') === 'latest' ? 'latest' : 'recommended'
  const feedRef = useRef<HTMLDivElement>(null)
  const feedSentinelRef = useRef<HTMLDivElement>(null)
  const [shareDraft, setShareDraft] = useState<CommunityShareDraft | null>(() =>
    readShareDraftFromState(location.state),
  )

  useEffect(() => {
    const draft = readShareDraftFromState(location.state)
    if (draft) {
      setShareDraft(draft)
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null })
    }
  }, [location.pathname, location.search, location.state, navigate])

  const selectFeed = (mode: FeedMode, topicId: string) => {
    const nextSearch = new URLSearchParams(location.search)
    if (topicId === 'all') nextSearch.delete('topic')
    else nextSearch.set('topic', topicId)
    if (mode === 'recommended') nextSearch.delete('sort')
    else nextSearch.set('sort', mode)
    if (mode !== activeFeedMode || topicId !== activeTopicId) {
      navigate({ pathname: location.pathname, search: nextSearch.toString() }, { replace: true })
    }
    // AppShell owns the scrollable element and restores it when the user returns from a post.
    feedRef.current?.closest<HTMLElement>('[data-app-main-scroll]')?.scrollTo({ top: 0 })
  }

  const postsQuery = useInfiniteQuery({
    queryKey: ['community', 'posts', activeTopicId, activeFeedMode],
    queryFn: ({ pageParam }) =>
      listPosts(10, {
        page: pageParam.page,
        topicId: activeTopicId === 'all' ? undefined : activeTopicId,
        sort: activeFeedMode,
        snapshotAt: pageParam.snapshotAt,
      }),
    initialPageParam: { page: 1 } as { page: number; snapshotAt?: string },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.pagination.hasMore ? { page: allPages.length + 1, snapshotAt: lastPage.snapshotAt } : undefined,
  })

  const topicsQuery = useQuery({
    queryKey: ['community', 'topics'],
    queryFn: listTopics,
  })

  const createPostMutation = useMutation({
    mutationFn: createPost,
    onSuccess: () => {
      toast.success('发布成功，你的讨论已上线')
      if (feedRef.current) {
        setShareDraft(null)
        // 显示最新的全部讨论，让不属于原筛选话题的新帖也能看到。
        selectFeed('latest', 'all')
      }
      void queryClient.invalidateQueries({ queryKey: ['community', 'posts'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '发布失败，请稍后再试')
    },
  })

  const posts = useMemo(() => postsQuery.data?.pages.flatMap((page) => page.items) ?? [], [postsQuery.data])

  const topics = useMemo<CommunityTopic[]>(
    () => [
      { id: 'all', name: '全部' },
      ...(topicsQuery.data?.items ?? []),
    ],
    [topicsQuery.data],
  )

  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = postsQuery
  useEffect(() => {
    const element = feedSentinelRef.current
    if (!element || !hasNextPage || isFetching || isFetchNextPageError || typeof IntersectionObserver === 'undefined') {
      return
    }
    const root = element.closest('[data-app-main-scroll]')
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.unobserve(element)
          void fetchNextPage({ cancelRefetch: false })
        }
      },
      { root, rootMargin: '240px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [activeFeedMode, activeTopicId, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage])

  const selectTopic = (topicId: string) => {
    if (topicId !== activeTopicId) selectFeed(activeFeedMode, topicId)
  }

  return (
    <CommunityPageLayout
      toolbar={(
        <div className="grid w-full grid-cols-2 md:w-40" role="group" aria-label="讨论排序">
          {feedModes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              aria-pressed={activeFeedMode === mode.id}
              onClick={() => {
                if (mode.id !== activeFeedMode) selectFeed(mode.id, activeTopicId)
              }}
              className={cn(
                'relative min-w-11 px-2 text-sm font-semibold transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full md:after:inset-x-4',
                activeFeedMode === mode.id
                  ? 'text-[var(--text-primary)] after:bg-[var(--color-brand)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>
      )}
      topicRail={<TopicChannelBar topics={topics} activeTopicId={activeTopicId} onChange={selectTopic} />}
    >
      <PostComposer
        isSubmitting={createPostMutation.isPending}
        initialShare={shareDraft}
        onSubmit={async (payload) => {
          try {
            await createPostMutation.mutateAsync(payload)
            return true
          } catch {
            return false
          }
        }}
      />
      <div ref={feedRef} data-community-feed>
        {postsQuery.isRefetchError ? <AppStateRefreshNotice retry={postsQuery.refetch} busy={isFetching} /> : null}
        {postsQuery.isPending ? (
          <CommunityFeedSkeleton />
        ) : postsQuery.isError && !postsQuery.data ? (
          <AppState
            compact
            tone="error"
            title="社区内容暂时没有打开"
            description="请检查连接后重试。"
            primaryAction={{ label: '重新加载', onClick: () => postsQuery.refetch(), busy: isFetching }}
          />
        ) : posts.length > 0 ? (
          <CommunityFeedRows>
            {posts.map((post) => <PostCard key={post.id} post={post} timeline />)}
          </CommunityFeedRows>
        ) : (
          <AppState
            compact
            scene="welcome"
            title={activeTopicId === 'all' ? '还没有讨论' : '这个话题还没有讨论'}
            description="可以在上方发起讨论。"
          />
        )}
        {hasNextPage ? (
          <div className="border-t border-[var(--border-subtle)] px-3 py-3 text-center">
            <button
              type="button"
              disabled={isFetching}
              onClick={() => void fetchNextPage({ cancelRefetch: false })}
              className="press-feedback min-h-10 rounded-full px-4 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] disabled:opacity-60"
            >
              {postsQuery.isFetchingNextPage ? '正在加载…' : isFetchNextPageError ? '重试加载更多' : '加载更多讨论'}
            </button>
            <div ref={feedSentinelRef} aria-hidden className="h-px" />
          </div>
        ) : null}
      </div>
    </CommunityPageLayout>
  )
}
