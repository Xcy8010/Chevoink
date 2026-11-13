import { useMemo, useState } from 'react'
import { AlignLeft, Trash2, X } from 'lucide-react'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import Button from '@/components/ui/Button'
import { SkeletonText } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/toast-context'
import { createComment, deleteComment } from '@/features/community/api'
import { getAuthorName, getCommentBody } from '@/features/discover/api'
import { useShellStore } from '@/store/useShellStore'
import type { Comment } from '../../../../shared/contracts'
import type { ReaderState } from '../useReaderState'

type ReaderCommentsPanelProps = {
  state: ReaderState
}

/** 回复目标：点任意评论的「回复」进入回复模式 */
type ReplyTarget = {
  commentId: string
  nickname: string
}

const COMMENT_MAX_LENGTH = 500

/** 章节评论面板：章评总合 + 段评筛选（方案 6.3 / 任务9），根评论下挂回复树，底部支持直接发表与回复 */
export default function ReaderCommentsPanel({ state }: ReaderCommentsPanelProps) {
  const { commentsQuery, chapterComments, chapterId, activeParagraphIndex, openParagraphComments, locateParagraph } =
    state
  const authStatus = useShellStore((shell) => shell.authStatus)
  const sessionUser = useShellStore((shell) => shell.sessionUser)
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)

  const isParagraphView = activeParagraphIndex !== null

  // 评论树：根评论保持后端排序，回复按 rootId（兜底 parentId）归组到根评论下
  const commentById = useMemo(() => {
    const map = new Map<string, Comment>()
    for (const comment of chapterComments) {
      map.set(comment.id, comment)
    }
    return map
  }, [chapterComments])
  const roots = useMemo(() => chapterComments.filter((comment) => !comment.parentId), [chapterComments])
  const repliesByRoot = useMemo(() => {
    const map = new Map<string, Comment[]>()
    for (const comment of chapterComments) {
      if (!comment.parentId) continue
      const key = comment.rootId && commentById.has(comment.rootId) ? comment.rootId : comment.parentId
      const bucket = map.get(key)
      if (bucket) {
        bucket.push(comment)
      } else {
        map.set(key, [comment])
      }
    }
    return map
  }, [chapterComments, commentById])

  // 段评视图只看当前段的根评论（回复跟随根评论展示）；总合视图汇集本章全部根评论
  const visibleRoots = isParagraphView
    ? roots.filter((comment) => comment.paragraphIndex === activeParagraphIndex)
    : roots

  const handleDelete = async (commentId: string) => {
    if (deletingId) return
    if (!window.confirm('确定删除这条评论吗？')) return

    setDeletingId(commentId)
    try {
      await deleteComment(commentId)
      toast.success('评论已删除')
      if (replyTarget?.commentId === commentId) {
        setReplyTarget(null)
      }
      await commentsQuery.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败，请稍后再试')
    } finally {
      setDeletingId(null)
    }
  }

  const handleSubmit = async () => {
    const content = draft.trim()
    if (!content || !chapterId || isSubmitting) return

    if (authStatus !== 'authenticated') {
      toast.error('登录后才能发表评论')
      return
    }

    const isReply = Boolean(replyTarget)
    setIsSubmitting(true)
    try {
      await createComment({
        targetType: 'chapter',
        targetId: chapterId,
        content,
        // 回复模式挂 parentId，后端派生 rootId 并累加父评论回复数
        parentId: replyTarget?.commentId,
        // 段评视图下发表的根评论自动标注所属段落，回复不记段落
        paragraphIndex: isReply ? undefined : activeParagraphIndex ?? undefined,
      })
      setDraft('')
      setReplyTarget(null)
      toast.success(isReply ? '回复已发布' : '评论已发布')
      await commentsQuery.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '评论发布失败，请稍后再试')
    } finally {
      setIsSubmitting(false)
    }
  }

  /** 评论行右侧动作：回复（登录后可用）+ 删除（仅本人） */
  const renderActions = (comment: Comment, replyCount?: number) => (
    <span className="inline-flex items-center gap-3">
      {typeof replyCount === 'number' ? <span>{replyCount} 回复</span> : null}
      {authStatus === 'authenticated' ? (
        <button
          type="button"
          onClick={() => setReplyTarget({ commentId: comment.id, nickname: getAuthorName(comment.author) })}
          className="press-feedback transition-colors hover:text-[var(--color-brand)]"
        >
          回复
        </button>
      ) : null}
      {sessionUser?.id === comment.author?.id ? (
        <button
          type="button"
          disabled={deletingId === comment.id}
          onClick={() => void handleDelete(comment.id)}
          className="press-feedback inline-flex items-center gap-1 transition-colors hover:text-red-500 disabled:opacity-50"
          aria-label="删除评论"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </button>
      ) : null}
    </span>
  )

  /** 单条评论：作者（回复带「回复 @xx」前缀）+ 动作行 + 正文 */
  const renderComment = (comment: Comment, replyToNickname?: string | null) => (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-tertiary)]">
        <span className="min-w-0 truncate font-medium text-[var(--text-secondary)]">
          {getAuthorName(comment.author)}
          {replyToNickname ? <span className="ml-1 font-normal">回复 @{replyToNickname}</span> : null}
        </span>
        {renderActions(comment)}
      </div>
      <p className="mt-1.5 text-sm leading-6 text-[var(--text-primary)]">{getCommentBody(comment)}</p>
    </div>
  )

  // 段评视图顶部：X 风格纯文本行，左侧标注段落、右侧一键回到全部评论
  const paragraphHeader = isParagraphView ? (
    <div className="flex items-center justify-between pb-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-brand)]">
        <AlignLeft className="h-3.5 w-3.5" />
        第 {activeParagraphIndex! + 1} 段的评论
      </span>
      <button
        type="button"
        onClick={() => openParagraphComments(null)}
        className="press-feedback text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
      >
        查看全部评论
      </button>
    </div>
  ) : null

  // 扁平的发评论区：回复模式顶部挂「回复 @xx」提示条，可一键取消
  const composer = (
    <div className="border-t border-[var(--border-subtle)] pt-3">
      {replyTarget ? (
        <div className="mb-1.5 flex items-center justify-between rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-2.5 py-1.5">
          <span className="min-w-0 truncate text-xs text-[var(--text-secondary)]">
            回复 <span className="text-[var(--color-brand)]">@{replyTarget.nickname}</span>
          </span>
          <button
            type="button"
            onClick={() => setReplyTarget(null)}
            className="press-feedback ml-2 inline-flex shrink-0 items-center gap-0.5 text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
            aria-label="取消回复"
          >
            <X className="h-3.5 w-3.5" />
            取消
          </button>
        </div>
      ) : null}
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value.slice(0, COMMENT_MAX_LENGTH))}
        rows={3}
        placeholder={
          authStatus !== 'authenticated'
            ? '登录后即可发表评论'
            : replyTarget
              ? `回复 @${replyTarget.nickname}…`
              : isParagraphView
                ? `对第 ${activeParagraphIndex! + 1} 段说点什么…`
                : '说说你对这一章的看法…'
        }
        className="w-full resize-none rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:ring-1 focus:ring-[var(--color-brand)]"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-xs text-[var(--text-tertiary)]">
          {draft.length}/{COMMENT_MAX_LENGTH}
        </span>
        <Button variant="primary" size="sm" disabled={!draft.trim() || isSubmitting} onClick={() => void handleSubmit()}>
          {isSubmitting ? '发布中…' : replyTarget ? '发布回复' : '发表评论'}
        </Button>
      </div>
    </div>
  )

  if (commentsQuery.isLoading) {
    return (
      <div className="space-y-5 px-1 py-4" aria-busy="true" aria-label="评论加载中">
        <SkeletonText lines={2} />
        <SkeletonText lines={2} />
      </div>
    )
  }

  if (commentsQuery.isError && !commentsQuery.data) {
    return (
      <AppState compact tone="error" title="评论暂时没有加载" primaryAction={{ label: '重新加载评论', onClick: () => commentsQuery.refetch(), busy: commentsQuery.isFetching }} />
    )
  }

  const refreshNotice = commentsQuery.isRefetchError ? <AppStateRefreshNotice retry={commentsQuery.refetch} busy={commentsQuery.isFetching} /> : null

  if (visibleRoots.length === 0) {
    return (
      <div className="px-1">
        {paragraphHeader}
        {refreshNotice}
        <AppState compact scene="welcome" title={isParagraphView ? '这段还没有评论' : '还没有评论'} />
        {composer}
      </div>
    )
  }

  return (
    <div className="px-1">
      {paragraphHeader}
      {refreshNotice}
      {/* 根评论分行，回复挂根评论下的浅色块内形成评论树 */}
      <div className="divide-y divide-[var(--border-subtle)]">
        {visibleRoots.map((root) => {
          const replies = repliesByRoot.get(root.id) ?? []
          return (
            <div key={root.id} className="py-3">
              <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-tertiary)]">
                <span className="font-medium text-[var(--text-secondary)]">{getAuthorName(root.author)}</span>
                {renderActions(root, root.replyCount)}
              </div>
              {/* 段评在总合视图里标注所属段落，点击定位到正文并高亮闪一下 */}
              {!isParagraphView && typeof root.paragraphIndex === 'number' ? (
                <button
                  type="button"
                  onClick={() => locateParagraph(root.paragraphIndex!)}
                  className="press-feedback mt-1.5 inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--surface-muted)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--color-brand)]"
                >
                  <AlignLeft className="h-3 w-3" />
                  第 {root.paragraphIndex + 1} 段
                </button>
              ) : null}
              <p className="mt-1.5 text-sm leading-6 text-[var(--text-primary)]">{getCommentBody(root)}</p>
              {replies.length > 0 ? (
                <div className="mt-2 space-y-2.5 rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-3 py-2.5">
                  {replies.map((reply) => {
                    const parent = reply.parentId ? commentById.get(reply.parentId) : null
                    // 直接回复根评论不重复标注，回复别人的回复才带「回复 @xx」
                    const replyTo = parent && parent.id !== root.id ? getAuthorName(parent.author) : null
                    return <div key={reply.id}>{renderComment(reply, replyTo)}</div>
                  })}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {composer}
    </div>
  )
}
