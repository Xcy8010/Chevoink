import { CornerDownRight, Heart, LoaderCircle, MessageSquare, Pencil, Send, Star, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import Empty from '@/components/Empty'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { useToast } from '@/components/ui/toast-context'
import { setCommentLike } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import { getAuthorName, getCommentBody } from '@/features/discover/api'
import { formatRelativeTime } from '@/features/community/utils'
import type { NovelDetailState } from '../useNovelDetailState'

type NovelCommentsProps = {
  state: NovelDetailState
}

const RATING_LABELS: Record<number, string> = {
  1: '不推荐',
  2: '一般般',
  3: '还不错',
  4: '很精彩',
  5: '神作必读',
}

/** 只读星级行：用于评分汇总与评论卡片 */
function StarRow({ value, sizeClass = 'h-4 w-4' }: { value: number; sizeClass?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`${sizeClass} ${
            star <= Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-[var(--border-strong)]'
          }`}
        />
      ))}
    </span>
  )
}

/** 作品评论区：评分汇总 + 评星输入 + 评论列表（点赞数 + 回复入口） */
export default function NovelComments({ state }: NovelCommentsProps) {
  const toast = useToast()
  // 点赞乐观状态：key=commentId，未记录时以服务端 likedByViewer 为准；给自己点赞也允许
  const [likedMap, setLikedMap] = useState<Record<string, boolean>>({})
  const {
    commentsQuery,
    novelComments,
    sessionUser,
    commentDraft,
    setCommentDraft,
    replyTarget,
    setReplyTarget,
    ratingDraft,
    setRatingDraft,
    createCommentMutation,
    deleteCommentMutation,
    editingComment,
    handleSubmitComment,
    handleStartEditComment,
    handleCancelEditComment,
    handleDeleteComment,
    detail,
  } = state

  const ratingCount = detail?.novel?.ratingCount ?? 0
  const ratingAverage = detail?.novel?.ratingAverage ?? null

  const handleToggleLike = (comment: (typeof novelComments)[number]) => {
    if (!sessionUser) {
      toast.error('登录后才能点赞')
      return
    }
    const current = likedMap[comment.id] ?? Boolean(comment.likedByViewer)
    const next = !current
    setLikedMap((prev) => ({ ...prev, [comment.id]: next }))
    setCommentLike(comment.id, next).catch((error) => {
      setLikedMap((prev) => ({ ...prev, [comment.id]: current }))
      toast.error(error instanceof Error ? error.message : '操作失败，请稍后再试')
    })
  }

  return (
    <div>
      <p className="text-sm font-semibold text-[var(--text-primary)]">
        读者评论
        {commentsQuery.data ? (
          <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)]">
            共 {commentsQuery.data.pagination.total} 条
          </span>
        ) : null}
      </p>

      {ratingCount > 0 && ratingAverage != null ? (
        <div className="mt-4 flex items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-4">
          <div className="text-center">
            <p className="text-3xl font-semibold leading-none text-[var(--text-primary)]">{ratingAverage.toFixed(1)}</p>
            <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">综合评分</p>
          </div>
          <div className="min-w-0">
            <StarRow value={ratingAverage} sizeClass="h-5 w-5" />
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">{ratingCount} 人参与评分</p>
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3">
        {editingComment ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-brand-soft)] px-3 py-2 text-xs text-[var(--color-brand)]">
            <span className="flex min-w-0 items-center gap-1.5">
              <Pencil className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">正在编辑我的评论</span>
            </span>
            <button
              type="button"
              onClick={handleCancelEditComment}
              className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-[var(--surface-default)]"
              aria-label="取消编辑"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        {replyTarget ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-brand-soft)] px-3 py-2 text-xs text-[var(--color-brand)]">
            <span className="flex min-w-0 items-center gap-1.5">
              <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">回复 {getAuthorName(replyTarget.author)}：{getCommentBody(replyTarget)}</span>
            </span>
            <button
              type="button"
              onClick={() => setReplyTarget(null)}
              className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-[var(--surface-default)]"
              aria-label="取消回复"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        {!replyTarget ? (
          <div className="mb-2 flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--surface-default)] px-3 py-2">
            <span className="mr-1 text-xs text-[var(--text-tertiary)]">为作品打分</span>
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRatingDraft(star === ratingDraft ? 0 : star)}
                className="press-feedback rounded p-0.5 transition-transform hover:scale-110"
                aria-label={`${star} 星`}
              >
                <Star
                  className={`h-5 w-5 transition-colors ${
                    star <= ratingDraft ? 'fill-amber-400 text-amber-400' : 'text-[var(--border-strong)]'
                  }`}
                />
              </button>
            ))}
            <span className="ml-1 text-xs font-medium text-amber-500">
              {ratingDraft > 0 ? RATING_LABELS[ratingDraft] : ''}
            </span>
          </div>
        ) : null}
        <div className="flex items-start gap-3">
          <Avatar name={sessionUser?.nickname ?? '游客'} src={sessionUser?.avatarUrl ?? null} size="sm" />
          <div className="min-w-0 flex-1">
            <textarea
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              rows={2}
              placeholder={sessionUser ? '写下你的想法，和作者聊聊这本书...' : '登录后参与讨论...'}
              className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--color-brand)]"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-tertiary)]">
                {commentDraft.length > 0 ? `${commentDraft.length} 字` : '友善交流，理性讨论'}
              </span>
              <button
                type="button"
                onClick={handleSubmitComment}
                disabled={!commentDraft.trim() || createCommentMutation.isPending}
                className="press-feedback inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createCommentMutation.isPending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {editingComment ? '保存修改' : '发表评论'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {commentsQuery.isRefetchError ? <AppStateRefreshNotice retry={commentsQuery.refetch} busy={commentsQuery.isFetching} /> : null}
      {commentsQuery.isLoading ? (
        <div className="mt-6 flex items-center gap-3 text-sm text-[var(--text-secondary)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          正在加载评论...
        </div>
      ) : commentsQuery.isError && !commentsQuery.data ? (
        <AppState compact tone="error" title="评论暂时没有加载" primaryAction={{ label: '重新加载', onClick: () => commentsQuery.refetch(), busy: commentsQuery.isFetching }} />
      ) : novelComments.length === 0 ? (
        <div className="mt-4">
          <Empty scene="welcome" title="还没有评论" />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {novelComments.map((comment) => (
            <article
              key={comment.id}
              className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-4"
            >
              <div className="flex items-center gap-3">
                <Avatar name={getAuthorName(comment.author)} src={comment.author.avatarUrl ?? null} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                    {getAuthorName(comment.author)}
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)]">{formatRelativeTime(comment.createdAt)}</p>
                </div>
                {typeof comment.rating === 'number' && comment.rating > 0 ? (
                  <StarRow value={comment.rating} sizeClass="h-3.5 w-3.5" />
                ) : null}
              </div>
              <p className="mt-3 text-sm leading-7 text-[var(--text-primary)]">{getCommentBody(comment)}</p>
              <div className="mt-3 flex items-center gap-4 text-xs text-[var(--text-tertiary)]">
                {(() => {
                  const liked = likedMap[comment.id] ?? Boolean(comment.likedByViewer)
                  const likeCount = Math.max(
                    0,
                    comment.likeCount + Number(liked) - Number(Boolean(comment.likedByViewer)),
                  )
                  return (
                    <button
                      type="button"
                      onClick={() => handleToggleLike(comment)}
                      className={`press-feedback inline-flex items-center gap-1 transition-colors ${
                        liked ? 'text-[var(--color-brand)]' : 'hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <Heart className={`h-3.5 w-3.5 ${liked ? 'fill-current' : ''}`} />
                      {likeCount > 0 ? likeCount : '点赞'}
                    </button>
                  )
                })()}
                <button
                  type="button"
                  onClick={() => {
                    handleCancelEditComment()
                    setReplyTarget(comment)
                  }}
                  className="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-brand)]"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {comment.replyCount > 0 ? `回复 ${comment.replyCount}` : '回复'}
                </button>
                {sessionUser?.id === comment.author?.id ? (
                  <>
                    {!comment.parentId ? (
                      <button
                        type="button"
                        onClick={() => handleStartEditComment(comment)}
                        className="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-brand)]"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={deleteCommentMutation.isPending}
                      onClick={() => handleDeleteComment(comment)}
                      className="inline-flex items-center gap-1 transition-colors hover:text-red-500 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
