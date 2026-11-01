import { Link, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import { getAdminPostDetail } from '../api'
import { AdminCard, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'

export default function AdminPostDetailPage() {
  const location = useLocation()
  const returnTo = (location.state as { adminReturnTo?: string } | null)?.adminReturnTo
  const { postId = '' } = useParams()

  const query = useQuery({
    queryKey: ['admin', 'posts', postId],
    queryFn: () => getAdminPostDetail(postId),
    enabled: Boolean(postId),
  })

  const detail = query.data

  return (
    <div>
      <Link
        to={returnTo?.startsWith('/admin/posts') ? returnTo : '/admin/posts'}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft size={15} />
        返回帖子列表
      </Link>

      <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
        {detail ? (
          <div className="space-y-4">
            <AdminCard>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                <StatusPill>{detail.post.author.nickname}</StatusPill>
                {detail.post.topicTitle ? <span>#{detail.post.topicTitle}</span> : null}
                <span>·</span>
                <span>{formatDateTime(detail.post.createdAt)}</span>
                <span>·</span>
                <span>
                  {detail.post.likeCount} 赞 · {detail.post.commentCount} 评论
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{detail.post.content}</p>
              {detail.post.imageUrls.length > 0 ? (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {detail.post.imageUrls.map((url) => (
                    <img
                      key={url}
                      src={url}
                      alt="帖子图片"
                      className="aspect-square w-full rounded-lg border border-[var(--border-default)] object-cover"
                    />
                  ))}
                </div>
              ) : null}
            </AdminCard>

            <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">评论列表（{detail.comments.length}）</h2>
              {detail.comments.length === 0 ? (
                <p className="py-6 text-center text-sm text-[var(--text-secondary)]">暂无评论</p>
              ) : (
                <ul className="divide-y divide-[var(--border-default)] md:max-h-[60vh] md:overflow-y-auto md:pr-1">
                  {detail.comments.map((comment) => (
                    <li key={comment.id} className="py-3">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                        <span className="text-sm text-[var(--text-primary)]">{comment.author.nickname}</span>
                        <span>·</span>
                        <span>{formatDateTime(comment.createdAt)}</span>
                        <span>·</span>
                        <span>
                          {comment.likeCount} 赞 · {comment.replyCount} 回复
                        </span>
                      </div>
                      <p className="mt-1.5 break-words text-sm leading-relaxed">{comment.content}</p>
                      {comment.replies.length > 0 ? (
                        <ul className="mt-2 space-y-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2">
                          {comment.replies.map((reply) => (
                            <li key={reply.id}>
                              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                                <span className="text-[var(--text-primary)]">{reply.author.nickname}</span>
                                <span>·</span>
                                <span>{formatDateTime(reply.createdAt)}</span>
                              </div>
                              <p className="mt-0.5 break-words text-sm leading-relaxed">{reply.content}</p>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </AdminCard>
          </div>
        ) : null}
      </AdminPanelState>
    </div>
  )
}
