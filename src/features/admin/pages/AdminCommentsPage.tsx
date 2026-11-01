import { useAdminNumberQuery } from './admin-page-query'
import { useAdminQueryState } from '../admin-query-state'
import { AdminCommunityTabs, AdminRowActions } from './AdminPageControls'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import type { AdminCommentRow } from '../../../../shared/contracts/index.js'
import { deleteAdminComment, listAdminComments } from '../api'
import { AdminCard, AdminConfirmDialog, AdminPageHeader, AdminPager, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'

const TARGET_TYPE_LABELS: Record<string, string> = {
  novel: '作品评论',
  chapter: '章节评论',
  post: '帖子评论',
}

/** 作品评论下细分：章节评论 / 段落评论（paragraphIndex 非空） */
function commentTypeLabel(comment: AdminCommentRow): string {
  if (comment.targetType === 'chapter' && comment.paragraphIndex !== null && comment.paragraphIndex !== undefined) {
    return '段落评论'
  }
  return TARGET_TYPE_LABELS[comment.targetType] ?? comment.targetType
}

export default function AdminCommentsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [category, setCategory] = useAdminQueryState('category', '')
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const [pendingDelete, setPendingDelete] = useState<AdminCommentRow | null>(null)

  const query = useQuery({
    queryKey: ['admin', 'comments', search, category, page, pageSize],
    queryFn: () =>
      listAdminComments({
        search: search || undefined,
        category: category || undefined,
        page,
        pageSize,
      }),
  })

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  const deleteMutation = useMutation({
    mutationFn: (commentId: string) => deleteAdminComment(commentId),
    onSuccess: () => {
      toast.success('评论已删除')
      void queryClient.invalidateQueries({ queryKey: ['admin', 'comments'] })
      setPendingDelete(null)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '删除失败'),
  })

  const data = query.data

  return (
    <div>
      <AdminPageHeader title="社区管理" description="检索全站评论（作品评、章节评、帖子评论），对违规内容执行删除" />

      <AdminCommunityTabs />

      <AdminCard className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <form
            className="flex w-full max-w-sm gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSearch(keyword.trim())
              setPage(1)
            }}
          >
            <TextInput value={keyword} placeholder="内容 / 作者昵称" onChange={(event) => setKeyword(event.target.value)} />
            <Button type="submit" variant="primary">
              搜索
            </Button>
          </form>

          <select
            value={category}
            onChange={(event) => {
              setCategory(event.target.value)
              setPage(1)
            }}
            aria-label="筛选条件" className="h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-primary)] outline-none"
          >
            <option value="">全部类型</option>
            <option value="novel">作品评论（含章节/段落评论）</option>
            <option value="post">帖子评论</option>
          </select>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminPanelState
          state={query.isLoading ? 'loading' : query.isError ? 'error' : data && data.items.length === 0 ? 'empty' : 'ready'}
        >
          {data ? (
            <>
              <ul className="divide-y divide-[var(--border-default)]">
                {data.items.map((comment) => (
                  <li key={comment.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm leading-relaxed">{comment.content}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                        <StatusPill>{commentTypeLabel(comment)}</StatusPill>
                        <span>{comment.author.nickname}</span>
                        <span>·</span>
                        <span>{formatDateTime(comment.createdAt)}</span>
                        <span>·</span>
                        <span>
                          {comment.likeCount} 赞 · {comment.replyCount} 回复
                        </span>
                      </div>
                      {comment.targetTitle ? (
                        <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">目标：{comment.targetTitle}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {comment.targetHref ? (
                        <a
                          href={comment.targetHref}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center rounded-[var(--radius-pill)] border border-[var(--border-strong)] px-3 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                        >
                          查看
                        </a>
                      ) : null}
                      <AdminRowActions><Button size="sm" variant="ghost" onClick={() => setPendingDelete(comment)}>
                        删除
                      </Button></AdminRowActions>
                    </div>
                  </li>
                ))}
              </ul>
              <AdminPager
                pagination={data.pagination}
                page={page}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={handlePageSizeChange}
              />
            </>
          ) : null}
        </AdminPanelState>
      </AdminCard>

      <AdminConfirmDialog
        open={pendingDelete !== null}
        title="删除评论"
        description={
          pendingDelete ? (
            <>
              将删除该评论及其全部回复，无法恢复。
              <span className="mt-2 block rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                {pendingDelete.content}
              </span>
            </>
          ) : null
        }
        confirmLabel="确认删除"
        loading={deleteMutation.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
      />
    </div>
  )
}
