import { useAdminQueryState } from '../admin-query-state'
import { useAdminNumberQuery } from './admin-page-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, History } from 'lucide-react'

import { getAdminCreationRecords, getAdminCreationRecordsIndex } from '../api'
import Button from '@/components/ui/Button'
import AdminAnalytics from '../components/AdminAnalytics'
import { AdminRunRecords } from '../components/AdminOperationsLists'
import TextInput from '../components/AdminTextInput'
import { AdminCard, AdminPageHeader, AdminPanelState, AdminSectionTabs, StatusPill } from '../AdminLayout'
import { formatReplayTime } from '../admin-shared'
import { AdminCreationReplay } from '../components/AdminCreationReplay'
import type { AdminCreationRecordsIndexRow } from '../../../../shared/contracts/index.js'
export default function AdminCreationRecordsPage() {
  const { userId = '' } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const sessionId = params.get('session')
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [tab, setTab] = useAdminQueryState('tab', 'tasks')
  const [indexItems, setIndexItems] = useState<AdminCreationRecordsIndexRow[]>([])
  const [indexHasMore, setIndexHasMore] = useState(false)
  const [indexTotal, setIndexTotal] = useState(0)

  const recordsQuery = useQuery({
    queryKey: ['admin', 'users', userId, 'creation-records'],
    queryFn: () => getAdminCreationRecords(userId),
    enabled: Boolean(userId) && !sessionId,
  })

  // 无 userId：默认分页列出有 Agent 会话记录的创作者，无需先搜索；输入关键词时可即时过滤
  const searchQuery = useQuery({
    queryKey: ['admin', 'creation-records', 'index', search, page],
    queryFn: () => getAdminCreationRecordsIndex(search || undefined, page),
    enabled: !userId && tab === 'creators',
    placeholderData: (previous) => previous,
  })

  // 分页结果增量合并进列表：第 1 页重置，后续页追加
  useEffect(() => {
    const data = searchQuery.data
    if (!data) {
      return
    }
    setIndexItems((previous) => (data.page === 1 ? data.items : [...previous, ...data.items]))
    setIndexHasMore(data.hasMore)
    setIndexTotal(data.total)
  }, [searchQuery.data])

  const payload = recordsQuery.data

  const sessionCount = useMemo(
    () => payload?.novels.reduce((total, novel) => total + novel.sessions.length, 0) ?? 0,
    [payload],
  )

  if (userId && sessionId) return <AdminCreationReplay key={JSON.stringify([userId, sessionId])} userId={userId} sessionId={sessionId} />

  // 无 userId：直接分页列出创作者（免搜索），点击进入对应创作记录详情
  if (!userId) {
    return (
      <div>
        <AdminPageHeader
          title="创作运行"
          description={indexTotal > 0 ? `共 ${indexTotal} 位创作者有 Agent 记录` : '按创作者定位执行记录；选择会话后打开只读回看。'}
        />
        <AdminSectionTabs tabs={[{id:'tasks',label:'任务记录'},{id:'creators',label:'创作者'},{id:'tools',label:'工具与导入'},{id:'stats',label:'统计'}]} value={tab} onChange={setTab} label="创作运行分区" />
        {tab === 'tools' || tab === 'stats' ? <AdminAnalytics scope="creation" view={tab === 'tools' ? 'tools' : 'stats'} /> : null}
        {tab === 'tasks' ? <AdminRunRecords /> : null}
        {tab === 'creators' ? <>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">按创作者进入会话详情，选择会话后打开只读回看。</p>
        <form
          className="mb-4 flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setIndexItems([])
            setPage(1)
            setSearch(keyword.trim())
          }}
        >
          <TextInput value={keyword} placeholder="昵称 / 手机号 / 邮箱（留空显示全部）" onChange={(event) => setKeyword(event.target.value)} />
          <Button type="submit" variant="primary">
            搜索
          </Button>
        </form>

        <AdminPanelState state={searchQuery.isLoading && page === 1 ? 'loading' : searchQuery.isError ? 'error' : indexItems.length === 0 ? 'empty' : 'ready'}>
          <AdminCard>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {indexItems.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => navigate(`/admin/users/${user.id}/creation-records`)}
                  className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] p-3 text-left transition-colors hover:bg-[var(--surface-muted)]"
                >
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt={user.nickname} className="h-11 w-11 shrink-0 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-base font-semibold">
                      {user.nickname.slice(0, 1)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{user.nickname}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                      {user.novelCount} 作品 · {user.sessionCount} 会话
                      {user.lastSessionAt ? ` · 最近 ${formatReplayTime(user.lastSessionAt).slice(0, 10)}` : ''}
                    </p>
                  </div>
                  <ChevronRight size={15} className="text-[var(--text-tertiary)]" />
                </button>
              ))}
            </div>
            {indexHasMore ? (
              <div className="mt-3 flex justify-center">
                <Button type="button" variant="secondary" disabled={searchQuery.isFetching} onClick={() => setPage((current) => current + 1)}>
                  {searchQuery.isFetching ? '加载中…' : '加载更多创作者'}
                </Button>
              </div>
            ) : null}
          </AdminCard>
        </AdminPanelState>
        </> : null}
      </div>
    )
  }

  return (
    <div>
      <Link to={`/admin/users/${userId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ArrowLeft size={15} />
        返回用户详情
      </Link>

      <AdminPageHeader
        title={payload ? `${payload.user.nickname} 的创作记录` : '创作记录'}
        description={payload ? `共 ${payload.novels.length} 部作品 · ${sessionCount} 个 Agent 会话` : undefined}
      />

      <AdminPanelState state={recordsQuery.isLoading ? 'loading' : recordsQuery.isError ? 'error' : payload && payload.novels.length === 0 ? 'empty' : 'ready'}>
        {payload ? (
          <div className="space-y-3">
            {payload.novels.map((novel) => (
              <AdminCard key={novel.novelId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">{novel.displayTitle ?? novel.title}</h2>
                    <StatusPill tone={novel.status === 'published' || novel.status === 'completed' ? 'success' : 'neutral'}>
                      {novel.status === 'published' ? '连载中' : novel.status === 'completed' ? '已完结' : novel.status === 'draft' ? '草稿' : novel.status}
                    </StatusPill>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {novel.wordCount.toLocaleString('zh-CN')} 字 · {novel.chapterCount} 章 · {novel.sessions.length} 个会话
                  </p>
                </div>

                {novel.sessions.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--text-tertiary)]">该作品暂无 Agent 对话会话</p>
                ) : (
                  <div className="mt-3 space-y-1.5">
                    {novel.sessions.map(session => (
                      <Link key={session.id} to={`?session=${encodeURIComponent(session.id)}`}
                        className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm transition-colors hover:bg-[var(--surface-muted)]">
                        <History className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                        <span className="min-w-0 flex-1 truncate">{session.title}</span>
                        <span className="shrink-0 text-xs text-[var(--text-secondary)]">{session.runCount} 轮</span>
                        <time className="hidden text-xs text-[var(--text-secondary)] sm:block" dateTime={session.lastRunAt ?? session.createdAt}
                          title={formatReplayTime(session.lastRunAt ?? session.createdAt)}>
                          {formatReplayTime(session.lastRunAt ?? session.createdAt).slice(0, 10)}
                        </time>
                        <ChevronRight size={15} className="shrink-0 text-[var(--text-tertiary)]" />
                      </Link>
                    ))}
                  </div>
                )}
              </AdminCard>
            ))}
          </div>
        ) : null}
      </AdminPanelState>
    </div>
  )
}
