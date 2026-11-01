import { useAdminNumberQuery } from './admin-page-query'
import { useAdminQueryState } from '../admin-query-state'
import { AdminCommunityTabs, AdminRowActions } from './AdminPageControls'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import type { AdminPostRow } from '../../../../shared/contracts/index.js'
import { deleteAdminPost, listAdminPosts } from '../api'
import { AdminCard, AdminConfirmDialog, AdminPageHeader, AdminPager, AdminPanelState } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'

export default function AdminPostsPage() {
  const location = useLocation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const [pendingDelete, setPendingDelete] = useState<AdminPostRow | null>(null)

  const query = useQuery({
    queryKey: ['admin', 'posts', search, page, pageSize],
    queryFn: () => listAdminPosts({ search: search || undefined, page, pageSize }),
  })

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  const deleteMutation = useMutation({
    mutationFn: (postId: string) => deleteAdminPost(postId),
    onSuccess: () => {
      toast.success('帖子已删除')
      void queryClient.invalidateQueries({ queryKey: ['admin', 'posts'] })
      setPendingDelete(null)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '删除失败'),
  })

  const data = query.data

  return (
    <div>
      <AdminPageHeader title="社区管理" description="检索社区帖子，对违规内容执行删除" />

      <AdminCommunityTabs />

      <AdminCard className="mb-4">
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
      </AdminCard>

      <AdminCard>
        <AdminPanelState
          state={query.isLoading ? 'loading' : query.isError ? 'error' : data && data.items.length === 0 ? 'empty' : 'ready'}
        >
          {data ? (
            <>
              <ul className="divide-y divide-[var(--border-default)]">
                {data.items.map((post) => (
                  <li key={post.id} className="flex items-start justify-between gap-3 py-3">
                    <Link to={`/admin/posts/${post.id}`} state={{ adminReturnTo: location.pathname + location.search }} className="min-w-0 flex-1 transition-opacity hover:opacity-75">
                      <p className="break-words text-sm leading-relaxed">{post.excerpt}</p>
                      <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
                        {post.author.nickname}
                        {post.topicTitle ? <span className="mx-1.5">·</span> : null}
                        {post.topicTitle ? `#${post.topicTitle}` : null}
                        <span className="mx-1.5">·</span>
                        {post.imageCount > 0 ? `${post.imageCount} 图 · ` : ''}
                        {post.likeCount} 赞 · {post.commentCount} 评论
                        <span className="mx-1.5">·</span>
                        {formatDateTime(post.createdAt)}
                      </p>
                    </Link>
                    <AdminRowActions><Button size="sm" variant="ghost" className="shrink-0" onClick={() => setPendingDelete(post)}>
                      删除
                    </Button></AdminRowActions>
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
        title="删除帖子"
        description={
          pendingDelete ? (
            <>
              将永久删除该帖子及其全部评论，无法恢复。
              <span className="mt-2 block rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                {pendingDelete.excerpt}
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
