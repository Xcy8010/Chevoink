import { Heart, MessageSquareMore, Share2, Trash2 } from 'lucide-react'
import ReportAction from '@/features/governance/ReportAction'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Comment } from '../../../../shared/contracts/index.js'
import { useToast } from '@/components/ui/toast-context'
import { createComment, deleteComment, setCommentLike } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import ShareToFriendSheet from '@/features/community/components/ShareToFriendSheet'
import { formatCompactCount, formatRelativeTime } from '@/features/community/utils'
import { useShellStore } from '@/store/useShellStore'
import { cn } from '@/lib/utils'

type CommentListProps = {
  comments: Comment[]
  /** 回复成功后的回调（供上层刷新评论列表） */
  onReplied?: () => void
  /** 提供时（手机端）回复按钮交给上层底部评论栏接管，不再展开内联回复框 */
  onReply?: (comment: Comment, anchor: HTMLElement) => void
}

type CommentThread = {
  root: Comment
  replies: Comment[]
}

/**
 * 平铺评论组织成 X 式线程：顶层评论按服务端时间倒序，
 * 回复沿 parent 链归并到顶层评论下并按时间正序；父链断裂（父评论已删）时按顶层展示。
 */
function buildThreads(comments: Comment[]): { threads: CommentThread[]; byId: Map<string, Comment> } {
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const repliesByRoot = new Map<string, Comment[]>()
  const topLevel: Comment[] = []

  for (const comment of comments) {
    if (!comment.parentId) {
      topLevel.push(comment)
      continue
    }

    let cursor: Comment | undefined = comment
    const visited = new Set<string>()
    while (cursor && cursor.parentId && byId.has(cursor.parentId) && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      cursor = byId.get(cursor.parentId)
    }

    const rootId =
      cursor && !cursor.parentId && cursor.id !== comment.id
        ? cursor.id
        : comment.rootId && byId.has(comment.rootId)
          ? comment.rootId
          : null

    if (rootId) {
      const list = repliesByRoot.get(rootId) ?? []
      list.push(comment)
      repliesByRoot.set(rootId, list)
    } else {
      topLevel.push(comment)
    }
  }

  for (const list of repliesByRoot.values()) {
    list.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  return {
    threads: topLevel.map((root) => ({ root, replies: repliesByRoot.get(root.id) ?? [] })),
    byId,
  }
}

export default function CommentList({ comments, onReplied, onReply }: CommentListProps) {
  const toast = useToast()
  const sessionUser = useShellStore((shell) => shell.sessionUser)
  // 点赞乐观状态：key=commentId，未记录时以服务端 likedByViewer 为准
  const [likedMap, setLikedMap] = useState<Record<string, boolean>>({})
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [isReplying, setIsReplying] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // 分享评论给好友：选中的目标评论，非空时弹出好友选择弹层
  const [shareTarget, setShareTarget] = useState<Comment | null>(null)

  const { threads, byId } = useMemo(() => buildThreads(comments), [comments])

  const handleToggleLike = (comment: Comment) => {
    const current = likedMap[comment.id] ?? Boolean(comment.likedByViewer)
    const next = !current
    setLikedMap((prev) => ({ ...prev, [comment.id]: next }))
    setCommentLike(comment.id, next).catch((error) => {
      setLikedMap((prev) => ({ ...prev, [comment.id]: current }))
      toast.error(error instanceof Error ? error.message : '操作失败，请稍后再试')
    })
  }

  const handleToggleReply = (comment: Comment) => {
    setReplyTargetId((prev) => (prev === comment.id ? null : comment.id))
    setReplyDraft('')
  }

  const handleSubmitReply = async (comment: Comment) => {
    const content = replyDraft.trim()
    if (!content || isReplying) return

    setIsReplying(true)
    try {
      await createComment({
        targetType: comment.targetType,
        targetId: comment.targetId,
        parentId: comment.id,
        content,
      })
      setReplyTargetId(null)
      setReplyDraft('')
      toast.success('回复已发布')
      onReplied?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '回复失败，请稍后再试')
    } finally {
      setIsReplying(false)
    }
  }

  const handleDelete = async (comment: Comment) => {
    if (deletingId) return
    if (!window.confirm('确定删除这条评论吗？它的回复也会一并删除。')) return

    setDeletingId(comment.id)
    try {
      await deleteComment(comment.id)
      toast.success('评论已删除')
      onReplied?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败，请稍后再试')
    } finally {
      setDeletingId(null)
    }
  }

  const renderCommentRow = (
    comment: Comment,
    options: { isReply: boolean; isLastReply?: boolean; hasReplies?: boolean },
  ) => {
    const liked = likedMap[comment.id] ?? Boolean(comment.likedByViewer)
    const likeCount = Math.max(
      0,
      comment.likeCount + Number(liked) - Number(Boolean(comment.likedByViewer)),
    )
    const parent = options.isReply && comment.parentId ? byId.get(comment.parentId) ?? null : null

    return (
      <div key={comment.id} className={cn('relative flex gap-3', options.isReply && 'pt-4')}>
        {/* X 式关系线：顶层评论有回复时从头像下方引出，回复行的线穿过左侧连到下一条 */}
        {!options.isReply && options.hasReplies ? (
          <span aria-hidden className="absolute bottom-0 left-[17px] top-10 w-0.5 bg-[var(--border-subtle)]" />
        ) : null}
        {options.isReply ? (
          <span
            aria-hidden
            className={cn(
              'absolute left-[17px] top-0 w-0.5 bg-[var(--border-subtle)]',
              options.isLastReply ? 'h-7' : 'bottom-0',
            )}
          />
        ) : null}

        {/* 头像与昵称可点进入评论作者主页 */}
        <Link
          to={`/author/${comment.author.id}`}
          aria-label={`查看 ${comment.author.nickname} 的主页`}
          className="relative shrink-0 self-start"
        >
          <Avatar name={comment.author.nickname} src={comment.author.avatarUrl} size="sm" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
            <Link
              to={`/author/${comment.author.id}`}
              className="font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--color-brand)]"
            >
              {comment.author.nickname}
            </Link>
            <span>{formatRelativeTime(comment.createdAt)}</span>
          </div>
          {parent ? (
            <p className="mt-1 truncate text-xs text-[var(--text-tertiary)]">
              回复 <span className="text-[var(--color-brand)]">@{parent.author.nickname}</span>
            </p>
          ) : null}
          <p className="mt-2 text-sm leading-7 text-[var(--text-primary)]">{comment.content}</p>
          <div className="mt-3 flex items-center gap-4 text-xs text-[var(--text-tertiary)]">
            <button
              type="button"
              onClick={() => handleToggleLike(comment)}
              className={cn(
                'press-feedback inline-flex items-center gap-1 transition-colors',
                liked ? 'text-[var(--color-brand)]' : 'hover:text-[var(--text-primary)]',
              )}
            >
              <Heart className={cn('h-3.5 w-3.5', liked && 'fill-current')} />
              {formatCompactCount(likeCount)}
            </button>
            <button
              type="button"
              onClick={(event) => {
                if (onReply) onReply(comment, event.currentTarget)
                else handleToggleReply(comment)
              }}
              className={cn(
                'press-feedback inline-flex items-center gap-1 transition-colors',
                replyTargetId === comment.id
                  ? 'text-[var(--color-brand)]'
                  : 'hover:text-[var(--text-primary)]',
              )}
            >
              <MessageSquareMore className="h-3.5 w-3.5" />
              {formatCompactCount(comment.replyCount)}
            </button>
            <button
              type="button"
              onClick={() => setShareTarget(comment)}
              className="press-feedback inline-flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]"
            >
              <Share2 className="h-3.5 w-3.5" />
              分享
            </button>
            <ReportAction menu target={{kind:'comment',id:comment.id}}/>
            {sessionUser?.id === comment.author.id ? (
              <button
                type="button"
                disabled={deletingId === comment.id}
                onClick={() => void handleDelete(comment)}
                className="press-feedback inline-flex items-center gap-1 transition-colors hover:text-red-500 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </button>
            ) : null}
          </div>

          {replyTargetId === comment.id && !onReply ? (
            <div className="mt-3 space-y-2">
              <textarea
                value={replyDraft}
                onChange={(event) => setReplyDraft(event.target.value.slice(0, 500))}
                rows={2}
                placeholder={`回复 ${comment.author.nickname}…`}
                className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--color-brand)]"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReplyTargetId(null)}
                  className="press-feedback rounded-[var(--radius-pill)] px-3 py-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!replyDraft.trim() || isReplying}
                  onClick={() => void handleSubmitReply(comment)}
                  className="press-feedback rounded-[var(--radius-pill)] bg-[var(--color-brand)] px-4 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-50"
                >
                  {isReplying ? '发送中…' : '回复'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="divide-y divide-[var(--border-subtle)]">
      {threads.map(({ root, replies }) => (
        <article key={root.id} className="py-4 first:pt-1 last:pb-0">
          {renderCommentRow(root, { isReply: false, hasReplies: replies.length > 0 })}
          {replies.map((reply, index) =>
            renderCommentRow(reply, { isReply: true, isLastReply: index === replies.length - 1 }),
          )}
        </article>
      ))}

      {shareTarget ? (
        <ShareToFriendSheet
          message={{
            type: 'commentCard',
            content: `分享评论：${shareTarget.content.replace(/\s+/g, ' ').slice(0, 60)}`,
            relatedId: String(shareTarget.id),
          }}
          onClose={() => setShareTarget(null)}
        />
      ) : null}
    </div>
  )
}
