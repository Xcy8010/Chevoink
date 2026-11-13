import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, MessageSquareMore, Send, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import type { Comment } from '../../shared/contracts/index.js'
import { ApiClientError } from '@/app/api-client'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { PostDetailSkeleton } from '@/components/ui/Skeleton'
import Button from '@/components/ui/Button'
import { createComment, getPostDetail, listPosts } from '@/features/community/api'
import { formatCompactCount, formatRelativeTime } from '@/features/community/utils'
import CommentList from '@/features/community/components/CommentList'
import PostCard from '@/features/community/components/PostCard'
import { useDeviceType } from '@/hooks/useDeviceType'

/**
 * 帖子详情页：正文平铺为页面主体，评论线程与输入框保持单层结构，
 * 桌面端右侧挂一列扁平的相关讨论，不做卡片套卡片。
 */
export default function PostDetailPage() {
  const queryClient = useQueryClient()
  const { postId } = useParams()
  const { state } = useLocation()
  const communitySearch = typeof state?.communitySearch === 'string' && state.communitySearch.startsWith('?')
    ? state.communitySearch
    : ''
  const [draftComment, setDraftComment] = useState('')
  // 手机端回复目标：非空时底部评论栏切换为「回复 @xx」模式（桌面端仍用评论列表内联回复框）
  const [replyTarget, setReplyTarget] = useState<{ id: string; nickname: string } | null>(null)
  const mobileComposerRef = useRef<HTMLTextAreaElement>(null)
  const isDesktop = useDeviceType() === 'desktop'

  const detailQuery = useQuery({
    queryKey: ['community', 'post-detail', postId],
    queryFn: () => getPostDetail(postId ?? ''),
    enabled: Boolean(postId),
  })

  const postsQuery = useQuery({
    queryKey: ['community', 'posts'],
    queryFn: () => listPosts(30),
  })

  const createCommentMutation = useMutation({
    mutationFn: createComment,
    onSuccess: async () => {
      setDraftComment('')
      setReplyTarget(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['community', 'post-detail', postId] }),
        queryClient.invalidateQueries({ queryKey: ['community', 'posts'] }),
      ])
    },
  })

  const relatedPosts = useMemo(() => {
    const currentPost = detailQuery.data?.post
    if (!currentPost) {
      return []
    }

    const allPosts = postsQuery.data?.items ?? []

    return allPosts
      .filter((post) => post.id !== currentPost.id)
      .sort((left, right) => {
        const leftScore =
          (left.topic?.id === currentPost.topic?.id ? 1000 : 0) + left.commentCount + left.likeCount
        const rightScore =
          (right.topic?.id === currentPost.topic?.id ? 1000 : 0) + right.commentCount + right.likeCount

        return rightScore - leftScore
      })
      .slice(0, 4)
  }, [detailQuery.data?.post, postsQuery.data?.items])

  const handleCreateComment = () => {
    const content = draftComment.trim()
    if (!postId || !content) {
      return
    }

    createCommentMutation.mutate({
      targetType: 'post',
      targetId: postId,
      parentId: replyTarget?.id,
      content,
    })
  }

  // 手机端点评论的回复按钮：先把被回复评论滚到可视区中部（键盘弹起视口收缩后
  // 仍保持在键盘上方），再聚焦底部评论栏弹起键盘，占位符切换为「回复 @xx」
  const handleReplyComment = (comment: Comment, anchor: HTMLElement) => {
    setReplyTarget({ id: comment.id, nickname: comment.author.nickname })
    anchor.scrollIntoView({ block: 'center', behavior: 'smooth' })
    window.setTimeout(() => mobileComposerRef.current?.focus(), 250)
  }

  const error = detailQuery.error
  const missing = error instanceof ApiClientError && error.status === 404
  if (!postId || missing) {
    return (
      <AppState
        scene="search"
        title="找不到这条讨论"
        primaryAction={{ label: '返回社区', href: `/community${communitySearch}` }}
      />
    )
  }

  if (detailQuery.isLoading) {
    return <PostDetailSkeleton />
  }

  const accessDenied = error instanceof ApiClientError && (error.status === 401 || error.status === 403)
  if (!detailQuery.data || accessDenied) {
    return (
      <AppState
        tone="error"
        title="这条讨论暂时没有打开"
        description={accessDenied ? error.message : '请稍后重试。'}
        primaryAction={{ label: '重新加载', onClick: () => detailQuery.refetch(), busy: detailQuery.isFetching }}
        secondaryAction={{ label: '返回社区', href: `/community${communitySearch}` }}
      />
    )
  }

  const comments = detailQuery.data.comments

  return (
    <div className="animate-fade-in-up mx-auto w-full max-w-[720px] xl:mx-0 xl:max-w-none">
      {detailQuery.isError ? <AppStateRefreshNotice retry={detailQuery.refetch} busy={detailQuery.isFetching} /> : null}
      <div className="grid items-start gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* 主内容列：返回入口 + 帖子正文 + 评论线程，全部平铺 */}
        <div className="min-w-0">
          <Link
            to={{ pathname: '/community', search: communitySearch }}
            className="press-feedback -ml-1 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-1 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ChevronLeft className="h-4 w-4" />
            返回社区
          </Link>

          <div className="mt-3">
            <PostCard post={detailQuery.data.post} flat />
          </div>

          <section className="mt-8 border-t border-[var(--border-subtle)] pt-6" aria-label="评论线程">
            <h2 className="flex items-baseline gap-2 text-base font-bold tracking-tight text-[var(--text-primary)]">
              <MessageSquareMore className="h-4 w-4 self-center text-[var(--text-tertiary)]" />
              评论
              <span className="text-sm font-normal tabular-nums text-[var(--text-tertiary)]">
                {formatCompactCount(comments.length)}
              </span>
            </h2>

            {/* 输入区：单层轻量输入框，聚焦时描边提亮（仅桌面；手机端改用底部评论栏） */}
            <div className="mt-4 hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-muted)]/50 transition-colors focus-within:border-[var(--color-brand)] focus-within:bg-[var(--surface-default)] xl:block">
              <textarea
                value={draftComment}
                onChange={(event) => setDraftComment(event.target.value)}
                rows={3}
                placeholder="写下你的想法，让讨论继续展开。"
                className="w-full resize-none bg-transparent px-4 pt-3 text-sm leading-7 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
              <div className="flex items-center justify-end px-3 pb-3">
                <Button
                  variant="primary"
                  onClick={handleCreateComment}
                  disabled={!draftComment.trim() || createCommentMutation.isPending}
                >
                  {createCommentMutation.isPending ? '发布中' : '发表评论'}
                </Button>
              </div>
            </div>

            <div className="mt-5">
              {comments.length > 0 ? (
                <CommentList
                  comments={comments}
                  onReplied={() => {
                    void queryClient.invalidateQueries({ queryKey: ['community', 'post-detail', postId] })
                  }}
                  onReply={isDesktop ? undefined : handleReplyComment}
                />
              ) : (
                <AppState compact scene="welcome" title="还没有评论" />
              )}
            </div>
          </section>
        </div>

        {/* 相关讨论：仅桌面展示，扁平分隔列表，跟随右侧黏滞 */}
        <aside className="hidden xl:block">
          <div className="sticky top-[calc(var(--app-header-height,132px)+12px)]">
            <h2 className="text-base font-bold tracking-tight text-[var(--text-primary)]">相关讨论</h2>
            {postsQuery.isLoading ? null : postsQuery.isError && !postsQuery.data ? (
              <AppState compact tone="error" title="相关讨论加载失败" primaryAction={{ label: '重试', onClick: () => postsQuery.refetch(), busy: postsQuery.isFetching }} />
            ) : relatedPosts.length > 0 ? (
              <div className="mt-2 divide-y divide-[var(--border-subtle)]">
                {postsQuery.isError ? <AppStateRefreshNotice retry={postsQuery.refetch} busy={postsQuery.isFetching} /> : null}
                {relatedPosts.map((post) => (
                  <Link key={post.id} to={`/post/${post.id}`} className="group block py-3">
                    <p className="line-clamp-2 text-sm leading-6 text-[var(--text-primary)] transition-colors group-hover:text-[var(--color-brand)]">
                      {post.excerpt}
                    </p>
                    <p className="mt-1.5 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                      <span className="truncate">{post.author.nickname}</span>
                      <span className="shrink-0">{formatCompactCount(post.commentCount)} 评论</span>
                      <span className="ml-auto shrink-0">{formatRelativeTime(post.createdAt)}</span>
                    </p>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--text-tertiary)]">暂无相关讨论</p>
            )}
          </div>
        </aside>
      </div>

      {/* 手机端评论栏：与评论列表拆成两个区域，sticky 贴住滚动容器底部——
          键盘弹起时容器随视口收缩，评论栏整体被顶到键盘上方（与聊天页同一布局机制，
          不依赖滚动 JS）；键盘收起时避开底部导航悬浮在列表上方。
          形态为横向胶囊输入框 + 发表按钮，无背景卡片层；
          data-kb-reveal="off" 让 reveal 补滚跳过它（齐平贴底会被误判为遮挡） */}
      <div className="post-composer-bar sticky z-20 mt-4 px-4 pb-[calc(10px+var(--safe-bottom))] pt-2 xl:hidden">
        {replyTarget ? (
          <div className="mb-2 flex w-fit max-w-full items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-solid)] px-3 py-1 text-xs text-[var(--text-secondary)] shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
            <span className="truncate">
              回复 <span className="text-[var(--color-brand)]">@{replyTarget.nickname}</span>
            </span>
            <button
              type="button"
              aria-label="取消回复"
              onClick={() => setReplyTarget(null)}
              className="press-feedback shrink-0 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <textarea
            ref={mobileComposerRef}
            value={draftComment}
            onChange={(event) => setDraftComment(event.target.value)}
            rows={1}
            data-kb-reveal="off"
            placeholder={replyTarget ? `回复 @${replyTarget.nickname}` : '写下你的想法…'}
            className="scrollbar-none h-10 max-h-24 flex-1 resize-none overflow-y-auto rounded-full border border-[var(--border-strong)] bg-[var(--surface-solid)] px-4 py-2.5 text-sm leading-5 text-[var(--text-primary)] shadow-[0_2px_12px_rgba(0,0,0,0.16)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--color-brand)]"
          />
          <Button
            variant="primary"
            size="sm"
            aria-label="发表评论"
            onClick={handleCreateComment}
            disabled={!draftComment.trim() || createCommentMutation.isPending}
            className="h-10 w-10 shrink-0 px-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
