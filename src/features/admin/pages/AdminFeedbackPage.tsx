import { useAdminDialog } from '../admin-dialog'
import { useAdminQueryState } from '../admin-query-state'
import { useAdminNumberQuery } from './admin-page-query'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import { cn } from '@/lib/utils'
import type { AdminFeedbackRow, FeedbackKind, FeedbackStatus } from '../../../../shared/contracts/index.js'
import { getAdminFeedbackDetail, listAdminFeedbacks, setAdminFeedbackStatus } from '../api'
import { AdminCard, AdminPageHeader, AdminPager, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'

const KIND_LABELS: Record<FeedbackKind, string> = { bug: '问题反馈', suggestion: '建议' }
const STATUS_TABS: { status: FeedbackStatus; label: string }[] = [
  { status: 'pending', label: '待处理' },
  { status: 'accepted', label: '已采纳' },
  { status: 'ignored', label: '已忽略' },
]
const SOURCE_LABELS: Record<string, string> = {
  'studio-work': '创作区 Work',
  'studio-ide': '创作区 IDE',
  'studio-mobile': '创作区手机端',
}

function sourceLabel(source: string | null): string {
  if (!source) return '未知来源'
  return SOURCE_LABELS[source] ?? source
}

/** 反馈处理页：三个状态页签，已采纳/已忽略页签内可撤销回待处理 */
export default function AdminFeedbackPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [statusValue, setStatus] = useAdminQueryState('status', 'pending')
  const status: FeedbackStatus = statusValue === 'accepted' || statusValue === 'ignored' ? statusValue : 'pending'
  const [kind, setKind] = useState<'' | FeedbackKind>('')
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const [detailId, setDetailId] = useState<string | null>(null)
  const dialogRef = useAdminDialog(detailId !== null, () => setDetailId(null))

  const query = useQuery({
    queryKey: ['admin', 'feedback', status, kind, search, page, pageSize],
    queryFn: () =>
      listAdminFeedbacks({
        status,
        kind: kind || undefined,
        search: search || undefined,
        page,
        pageSize,
      }),
  })

  const detailQuery = useQuery({
    queryKey: ['admin', 'feedback', 'detail', detailId],
    queryFn: () => getAdminFeedbackDetail(detailId ?? ''),
    enabled: detailId !== null,
  })

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; next: FeedbackStatus }) => setAdminFeedbackStatus(input.id, input.next),
    onSuccess: (_result, input) => {
      toast.success(input.next === 'accepted' ? '已标记为采纳' : input.next === 'ignored' ? '已忽略该反馈' : '已撤销，回到待处理')
      void queryClient.invalidateQueries({ queryKey: ['admin', 'feedback'] })
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '操作失败'),
  })

  const data = query.data
  const detail = detailQuery.data?.feedback ?? null

  const rowActions = (row: Pick<AdminFeedbackRow, 'id' | 'status'>) =>
    row.status === 'pending' ? (
      <>
        <Button size="sm" variant="primary" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: row.id, next: 'accepted' })}>
          已采纳
        </Button>
        <Button size="sm" variant="ghost" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: row.id, next: 'ignored' })}>
          忽略
        </Button>
      </>
    ) : (
      <Button size="sm" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: row.id, next: 'pending' })}>
        撤销
      </Button>
    )

  return (
    <div>
      <AdminPageHeader title="用户反馈 / 建议" description="陈列创作区提交的问题反馈与功能建议，可查看联系方式与截图，并标记采纳或忽略" />

      <AdminCard className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.status}
                type="button"
                onClick={() => {
                  setStatus(tab.status)
                  setPage(1)
                }}
                className={cn(
                  'inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-pill)] border px-3.5 text-sm transition-colors',
                  status === tab.status
                    ? 'border-[var(--surface-contrast)] bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
                    : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                {tab.label}
                <span className="text-xs tabular-nums opacity-80">{data?.counts[tab.status] ?? 0}</span>
              </button>
            ))}
          </div>

          <form
            className="flex w-full max-w-sm gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSearch(keyword.trim())
              setPage(1)
            }}
          >
            <TextInput value={keyword} placeholder="内容 / 联系方式 / 用户昵称" onChange={(event) => setKeyword(event.target.value)} />
            <Button type="submit" variant="primary">
              搜索
            </Button>
          </form>

          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as '' | FeedbackKind)
              setPage(1)
            }}
            aria-label="筛选条件" className="h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-primary)] outline-none"
          >
            <option value="">全部类别</option>
            <option value="bug">问题反馈</option>
            <option value="suggestion">建议</option>
          </select>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminPanelState
          state={query.isLoading ? 'loading' : query.isError ? 'error' : data && data.items.length === 0 ? 'empty' : 'ready'}
        >
          {data ? (
            <>
              <ul className="divide-y divide-[var(--border-default)] md:max-h-[60vh] md:overflow-y-auto md:pr-1">
                {data.items.map((row) => (
                  <li key={row.id} className="flex items-start justify-between gap-3 py-3">
                    <button type="button" onClick={() => setDetailId(row.id)} className="min-w-0 flex-1 text-left">
                      <p className="break-words text-sm leading-relaxed">{row.excerpt}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                        <StatusPill tone={row.kind === 'bug' ? 'warning' : 'neutral'}>{KIND_LABELS[row.kind]}</StatusPill>
                        <span>{row.user.nickname}</span>
                        <span>·</span>
                        <span>{formatDateTime(row.createdAt)}</span>
                        <span>·</span>
                        <span>{sourceLabel(row.source)}</span>
                        {row.imageCount > 0 ? (
                          <>
                            <span>·</span>
                            <span>{row.imageCount} 张图</span>
                          </>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">联系方式：{row.contact?.trim() || '未填写'}</p>
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setDetailId(row.id)}>
                        详情
                      </Button>
                      {rowActions(row)}
                    </div>
                  </li>
                ))}
              </ul>
              <AdminPager
                pagination={data.pagination}
                page={page}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size)
                  setPage(1)
                }}
              />
            </>
          ) : null}
        </AdminPanelState>
      </AdminCard>

      {detailId !== null ? (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="admin-feedback-detail-title" ref={dialogRef} tabIndex={-1}>
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5">
            <div className="mb-3 flex items-center justify-between gap-3"><h2 id="admin-feedback-detail-title" className="font-semibold">反馈详情</h2><Button variant="ghost" onClick={() => setDetailId(null)}>关闭</Button></div>
            <AdminPanelState state={detailQuery.isLoading ? 'loading' : detailQuery.isError ? 'error' : 'ready'}>
              {detail ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold">{KIND_LABELS[detail.kind]}详情</h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                        <StatusPill tone={detail.status === 'accepted' ? 'success' : detail.status === 'ignored' ? 'danger' : 'neutral'}>
                          {STATUS_TABS.find((tab) => tab.status === detail.status)?.label ?? detail.status}
                        </StatusPill>
                        <span>{detail.user.nickname}</span>
                        <span>·</span>
                        <span>{formatDateTime(detail.createdAt)}</span>
                        <span>·</span>
                        <span>{sourceLabel(detail.source)}</span>
                      </div>
                    </div>

                  </div>

                  <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{detail.content}</p>

                  <dl className="mt-4 grid gap-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2.5 text-xs text-[var(--text-secondary)] sm:grid-cols-2">
                    <div>
                      <dt className="text-[var(--text-secondary)]">联系方式</dt>
                      <dd className="mt-0.5 break-all text-[var(--text-primary)]">{detail.contact?.trim() || '未填写'}</dd>
                    </div>
                    <div>
                      <dt>用户 ID</dt>
                      <dd className="mt-0.5 break-all text-[var(--text-primary)]">{detail.user.id}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt>提交页面</dt>
                      <dd className="mt-0.5 break-all text-[var(--text-primary)]">{detail.pageUrl ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>处理人</dt>
                      <dd className="mt-0.5 text-[var(--text-primary)]">{detail.handledByNickname ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>处理时间</dt>
                      <dd className="mt-0.5 text-[var(--text-primary)]">{formatDateTime(detail.handledAt)}</dd>
                    </div>
                    {Object.keys(detail.clientInfo).length > 0 ? (
                      <div className="sm:col-span-2">
                        <dt>客户端信息</dt>
                        <dd className="mt-0.5 break-all text-[var(--text-primary)]">{JSON.stringify(detail.clientInfo)}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {detail.imageUrls.length > 0 ? (
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      {detail.imageUrls.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          <img
                            src={url}
                            alt="反馈截图"
                            className="aspect-square w-full rounded-lg border border-[var(--border-default)] object-cover"
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-5 flex justify-end gap-2">{rowActions(detail)}</div>
                </>
              ) : null}
            </AdminPanelState>
          </div>
        </div>
      ) : null}
    </div>
  )
}
