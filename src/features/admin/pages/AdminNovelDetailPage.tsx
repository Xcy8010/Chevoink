import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Eye, History } from 'lucide-react'

import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import {
  deleteAdminChapter,
  deleteAdminNovel,
  getAdminNovelDetail,
  restoreAdminNovel,
  takeDownAdminNovel,
} from '../api'
import { AdminCard, AdminConfirmDialog, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime, formatTokens, isNovelTakenDown, NOVEL_STATUS_LABELS } from '../admin-shared'

export default function AdminNovelDetailPage() {
  const location = useLocation()
  const returnTo = (location.state as { adminReturnTo?: string } | null)?.adminReturnTo
  const { novelId = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pendingChapter, setPendingChapter] = useState<{ id: string; title: string } | null>(null)
  const [showTakeDown, setShowTakeDown] = useState(false)
  const [showDelete, setShowDelete] = useState(false)

  const query = useQuery({
    queryKey: ['admin', 'novels', novelId],
    queryFn: () => getAdminNovelDetail(novelId),
    enabled: Boolean(novelId),
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'novels'] })
  }

  const takeDownMutation = useMutation({
    mutationFn: () => takeDownAdminNovel(novelId),
    onSuccess: () => {
      toast.success('已下架')
      invalidate()
      setShowTakeDown(false)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '下架失败'),
  })

  const restoreMutation = useMutation({
    mutationFn: () => restoreAdminNovel(novelId),
    onSuccess: () => {
      toast.success('已恢复上架')
      invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '恢复失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (confirmTitle: string) => deleteAdminNovel(novelId, confirmTitle),
    onSuccess: () => {
      toast.success('作品已删除')
      navigate('/admin/novels', { replace: true })
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '删除失败'),
  })

  const chapterMutation = useMutation({
    mutationFn: (chapterId: string) => deleteAdminChapter(chapterId),
    onSuccess: () => {
      toast.success('章节已删除')
      invalidate()
      setPendingChapter(null)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '章节删除失败'),
  })

  const detail = query.data
  const novel = detail?.novel
  const takenDown = novel ? isNovelTakenDown(novel) : false
  const confirmTitle = novel ? (novel.displayTitle ?? novel.title) : ''

  return (
    <div>
      <Link to={returnTo?.startsWith('/admin/novels') ? returnTo : '/admin/novels'} className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ArrowLeft size={15} />
        返回作品列表
      </Link>

      <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
        {novel && detail ? (
          <div className="space-y-4">
            <AdminCard>
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="flex min-w-0 gap-4 md:flex-1">
                  {novel.coverUrl ? (
                    <img
                      src={novel.coverUrl}
                      alt="作品封面"
                      className="aspect-[3/4] w-24 shrink-0 self-start rounded-lg border border-[var(--border-default)] bg-[var(--surface-muted)] object-cover"
                    />
                  ) : (
                    <div className="flex aspect-[3/4] w-24 shrink-0 self-start items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-muted)] text-xs text-[var(--text-secondary)]">
                      暂无封面
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h1 className="min-w-0 break-words text-lg font-semibold">{novel.displayTitle ?? novel.title}</h1>
                    {takenDown ? (
                      <StatusPill tone="danger">已下架</StatusPill>
                    ) : (
                      <StatusPill tone={novel.status === 'published' || novel.status === 'completed' ? 'success' : 'neutral'}>
                        {NOVEL_STATUS_LABELS[novel.status] ?? novel.status}
                      </StatusPill>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    作者：
                    <Link to={`/admin/users/${novel.author.id}`} className="underline hover:text-[var(--text-primary)]">
                      {novel.author.nickname}
                    </Link>
                    <span className="mx-1.5">·</span>
                    {novel.categoryName ?? '未分类'}
                    <span className="mx-1.5">·</span>
                    {novel.wordCount.toLocaleString('zh-CN')} 字 · {novel.chapterCount} 章
                  </p>
                  {novel.summary ? (
                    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">{novel.summary}</p>
                  ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 md:shrink-0 md:justify-end">
                  <Link
                    to={`/admin/novels/${novel.id}/preview`}
                    className="inline-flex h-9 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-strong)] px-3 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                  >
                    <Eye size={14} />
                    内部预览
                  </Link>
                  <a
                    href={`/novel/${novel.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-strong)] px-3 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                  >
                    <ExternalLink size={14} />
                    前台预览
                  </a>
                  <Link
                    to={`/admin/users/${novel.author.id}/creation-records`}
                    className="inline-flex h-9 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-strong)] px-3 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                  >
                    <History size={14} />
                    查看创作记录
                  </Link>
                  {takenDown ? (
                    <Button onClick={() => restoreMutation.mutate()} disabled={restoreMutation.isPending}>
                      恢复上架
                    </Button>
                  ) : (
                    <Button onClick={() => setShowTakeDown(true)}>下架</Button>
                  )}
                  <Button
                    variant="ghost"
                    className="text-[var(--color-error)]"
                    onClick={() => setShowDelete(true)}
                  >
                    删除作品
                  </Button>
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                {[
                  ['评论数', String(novel.commentCount)],
                  ['收藏数', String(novel.favoriteCount)],
                  ['首次发布', formatDateTime(novel.publishedAt)],
                  ['最近更新', formatDateTime(novel.updatedAt)],
                  ['总 Token', formatTokens(detail.usage.totalTokens)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-[var(--text-secondary)]">{label}</dt>
                    <dd className="mt-0.5">{value}</dd>
                  </div>
                ))}
              </dl>
            </AdminCard>

            <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">章节列表（{detail.chapters.length}）</h2>
              {detail.chapters.length === 0 ? (
                <p className="py-6 text-center text-sm text-[var(--text-secondary)]">暂无章节</p>
              ) : (
                <ul className="divide-y divide-[var(--border-default)] md:max-h-[52vh] md:overflow-y-auto md:pr-1">
                  {detail.chapters.map((chapter) => (
                    <li key={chapter.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate">
                          {chapter.orderIndex}. {chapter.title}
                        </p>
                        <p className="text-xs text-[var(--text-secondary)]">
                          {chapter.wordCount.toLocaleString('zh-CN')} 字 · {chapter.status === 'published' ? '已发布' : '草稿'} · 更新于{' '}
                          {formatDateTime(chapter.updatedAt)}
                        </p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setPendingChapter({ id: chapter.id, title: chapter.title })}>
                        删除
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </AdminCard>
          </div>
        ) : null}
      </AdminPanelState>

      <AdminConfirmDialog
        open={showTakeDown}
        title="下架作品"
        description="下架后该作品将从前台列表、搜索和详情页消失，可随时恢复。"
        confirmLabel="确认下架"
        loading={takeDownMutation.isPending}
        onCancel={() => setShowTakeDown(false)}
        onConfirm={() => takeDownMutation.mutate()}
      />

      <AdminConfirmDialog
        open={showDelete}
        title="删除作品"
        description={
          <>
            将<span className="font-medium text-[var(--color-error)]">永久删除</span>
            该作品及其全部章节、评论和 AI 创作记录，且无法恢复。
          </>
        }
        confirmLabel="永久删除"
        confirmText={confirmTitle}
        loading={deleteMutation.isPending}
        onCancel={() => setShowDelete(false)}
        onConfirm={() => deleteMutation.mutate(confirmTitle)}
      />

      <AdminConfirmDialog
        open={pendingChapter !== null}
        title="删除章节"
        description={
          pendingChapter ? (
            <>
              将删除章节 <span className="font-medium text-[var(--text-primary)]">{pendingChapter.title}</span>
              ，其正文与段评将一并移除，后续章节序号自动前移。
            </>
          ) : null
        }
        confirmLabel="确认删除"
        loading={chapterMutation.isPending}
        onCancel={() => setPendingChapter(null)}
        onConfirm={() => pendingChapter && chapterMutation.mutate(pendingChapter.id)}
      />
    </div>
  )
}
