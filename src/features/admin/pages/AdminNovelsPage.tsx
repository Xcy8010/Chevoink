import { useAdminNumberQuery } from './admin-page-query'
import { useAdminQueryState } from '../admin-query-state'
import { AdminRowActions } from './AdminPageControls'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import { listAdminNovels, restoreAdminNovel, takeDownAdminNovel } from '../api'
import { AdminCard, AdminConfirmDialog, AdminPageHeader, AdminPager, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime, isNovelTakenDown, NOVEL_STATUS_LABELS } from '../admin-shared'
import type { AdminNovelRow } from '../../../../shared/contracts/index.js'

export default function AdminNovelsPage() {
  const location = useLocation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [status, setStatus] = useAdminQueryState('status', '')
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const [pendingTakeDown, setPendingTakeDown] = useState<AdminNovelRow | null>(null)

  const query = useQuery({
    queryKey: ['admin', 'novels', search, status, page, pageSize],
    queryFn: () =>
      listAdminNovels({
        search: search || undefined,
        status: status || undefined,
        page,
        pageSize,
      }),
  })

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'novels'] })
  }

  const takeDownMutation = useMutation({
    mutationFn: (novelId: string) => takeDownAdminNovel(novelId),
    onSuccess: () => {
      toast.success('已下架，前台不再展示该作品')
      invalidate()
      setPendingTakeDown(null)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '下架失败'),
  })

  const restoreMutation = useMutation({
    mutationFn: (novelId: string) => restoreAdminNovel(novelId),
    onSuccess: () => {
      toast.success('已恢复上架')
      invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '恢复失败'),
  })

  const data = query.data

  return (
    <div>
      <AdminPageHeader title="作品管理" description="检索全站作品，对违规内容执行下架、恢复或删除" />

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
            <TextInput
              value={keyword}
              placeholder="书名 / 作者名"
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button type="submit" variant="primary">
              搜索
            </Button>
          </form>

          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
              setPage(1)
            }}
            aria-label="筛选条件" className="h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-primary)] outline-none"
          >
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="published">连载中</option>
            <option value="completed">已完结</option>
            <option value="archived">已归档</option>
          </select>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminPanelState
          state={query.isLoading ? 'loading' : query.isError ? 'error' : data && data.items.length === 0 ? 'empty' : 'ready'}
        >
          {data ? (
            <>
              <ul className="space-y-3 md:hidden">{data.items.map(novel => <li key={novel.id} className="rounded-xl border border-[var(--border-default)] p-4"><div className="flex items-start justify-between gap-3"><Link to={`/admin/novels/${novel.id}`} state={{ adminReturnTo: location.pathname + location.search }} className="min-w-0 break-words font-semibold">{novel.displayTitle ?? novel.title}</Link><StatusPill tone={isNovelTakenDown(novel) ? 'danger' : 'neutral'}>{isNovelTakenDown(novel) ? '已下架' : NOVEL_STATUS_LABELS[novel.status] ?? novel.status}</StatusPill></div><p className="mt-2 text-sm text-[var(--text-secondary)]">{novel.author.nickname} · {novel.categoryName ?? '未分类'}</p><p className="mt-1 text-sm text-[var(--text-secondary)]">{novel.wordCount.toLocaleString('zh-CN')} 字 · {novel.chapterCount} 章</p><p className="mt-1 text-xs text-[var(--text-secondary)]">更新 {formatDateTime(novel.updatedAt)}</p><div className="mt-3 flex items-center justify-between gap-2"><Link to={`/admin/novels/${novel.id}`} state={{ adminReturnTo: location.pathname + location.search }} className="inline-flex min-h-11 items-center text-sm underline">查看详情</Link><AdminRowActions>{isNovelTakenDown(novel) ? <Button size="sm" disabled={restoreMutation.isPending} onClick={() => restoreMutation.mutate(novel.id)}>恢复上架</Button> : <Button size="sm" onClick={() => setPendingTakeDown(novel)}>下架</Button>}</AdminRowActions></div></li>)}</ul>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[var(--text-secondary)]">
                      <th className="pb-2 font-normal">作品</th>
                      <th className="pb-2 font-normal">作者</th>
                      <th className="pb-2 font-normal">状态</th>
                      <th className="pb-2 font-normal">分类</th>
                      <th className="pb-2 font-normal">字数 / 章节</th>
                      <th className="pb-2 font-normal">更新时间</th>
                      <th className="pb-2 font-normal">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((novel) => {
                      const takenDown = isNovelTakenDown(novel)
                      return (
                        <tr key={novel.id} className="border-t border-[var(--border-default)]">
                          <td className="py-2.5">
                            <Link to={`/admin/novels/${novel.id}`} state={{ adminReturnTo: location.pathname + location.search }} className="font-medium hover:underline">
                              {novel.displayTitle ?? novel.title}
                            </Link>
                          </td>
                          <td className="py-2.5 text-[var(--text-secondary)]">{novel.author.nickname}</td>
                          <td className="py-2.5">
                            {takenDown ? (
                              <StatusPill tone="danger">已下架</StatusPill>
                            ) : (
                              <StatusPill tone={novel.status === 'published' || novel.status === 'completed' ? 'success' : 'neutral'}>
                                {NOVEL_STATUS_LABELS[novel.status] ?? novel.status}
                              </StatusPill>
                            )}
                          </td>
                          <td className="py-2.5 text-[var(--text-secondary)]">{novel.categoryName ?? '—'}</td>
                          <td className="py-2.5 text-[var(--text-secondary)]">
                            {novel.wordCount.toLocaleString('zh-CN')} / {novel.chapterCount}
                          </td>
                          <td className="py-2.5 text-[var(--text-secondary)]">{formatDateTime(novel.updatedAt)}</td>
                          <td className="py-2.5"><AdminRowActions>
                            {takenDown ? (
                              <Button size="sm" onClick={() => restoreMutation.mutate(novel.id)} disabled={restoreMutation.isPending}>
                                恢复上架
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => setPendingTakeDown(novel)}>
                                下架
                              </Button>
                            )}
                          </AdminRowActions></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
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
        open={pendingTakeDown !== null}
        title="下架作品"
        description={
          pendingTakeDown ? (
            <>
              下架后 <span className="font-medium text-[var(--text-primary)]">{pendingTakeDown.displayTitle ?? pendingTakeDown.title}</span>{' '}
              将从前台列表、搜索和详情页消失，作者本人也无法继续阅读发布态。可随时恢复。
            </>
          ) : null
        }
        confirmLabel="确认下架"
        loading={takeDownMutation.isPending}
        onCancel={() => setPendingTakeDown(null)}
        onConfirm={() => pendingTakeDown && takeDownMutation.mutate(pendingTakeDown.id)}
      />
    </div>
  )
}
