import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Copy, FileText, History, Loader2, MessageSquareText } from 'lucide-react'

import { getAdminAgentSessionMessages, getAdminCreationRecords, getAdminCreationRecordsIndex } from '../api'
import Button from '@/components/ui/Button'
import AdminAnalytics from '../components/AdminAnalytics'
import TextInput from '@/components/ui/TextInput'
import { AdminCard, AdminPageHeader, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatTokens } from '../admin-shared'
// 创作区消息渲染组件只读复用：思考折叠、工具卡片、待办清单等与作者侧看到的内容完全一致
import { AgentMessageParts } from '@/features/studio/agent/components/AgentMessageParts'
import ImageLightbox from '@/features/studio/components/ImageLightbox'
import type {
  AdminAgentRunRow,
  AdminCreationRecordsIndexRow,
  AgentMessagePart,
} from '../../../../shared/contracts/index.js'

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  awaiting_approval: '待审批',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const RUN_MODE_LABELS: Record<string, string> = {
  plan: '规划',
  act: '执行',
  review: '审查',
}

const ACTION_LABELS: Record<string, string> = {
  planChapter: '规划章节',
  draftChapter: '起草章节',
  continueChapter: '续写章节',
  rewriteSelection: '重写选中',
  polishSelection: '润色选中',
  reviewContinuity: '连贯性审查',
  generateCoverPrompt: '生成封面提示词',
  workspaceAgent: '工作区辅助',
}

type TranscriptMessage = AdminAgentRunRow['messages'][number]

/** 连续助手消息归为一个对话块（与创作区 AgentPanel 的块级摘要口径一致） */
type BlockInfo = { firstId: string; lastId: string; ops: number }
function buildBlockInfo(messages: TranscriptMessage[]): Map<string, BlockInfo> {
  const map = new Map<string, BlockInfo>()
  let firstId: string | null = null
  let ops = 0
  let ids: string[] = []
  const flush = () => {
    if (!firstId) {
      return
    }
    const blockFirst = firstId
    const blockLast = ids[ids.length - 1] ?? blockFirst
    for (const id of ids) {
      map.set(id, { firstId: blockFirst, lastId: blockLast, ops })
    }
    firstId = null
    ops = 0
    ids = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (!firstId) {
        firstId = message.id
      }
      ids.push(message.id)
      ops += message.parts.filter((part) => (part as AgentMessagePart).type !== 'text').length
    } else {
      flush()
    }
  }
  flush()
  return map
}

function getMessageText(parts: unknown[]): string {
  return parts
    .map((part) => {
      const typed = part as AgentMessagePart
      return typed.type === 'text' ? typed.text : ''
    })
    .join('')
}

/** 会话聊天记录：run 卡片内嵌创作区同款消息渲染；支持「加载更早轮次」游标分页 */
function SessionTranscript({
  runs,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
}: {
  runs: AdminAgentRunRow[]
  hasMore: boolean
  loadingEarlier: boolean
  onLoadEarlier: () => void
}) {
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [attachmentPreview, setAttachmentPreview] = useState<{ url: string; name: string } | null>(null)

  const flattened = useMemo(() => runs.flatMap((run) => run.messages), [runs])
  const blockInfoById = useMemo(() => buildBlockInfo(flattened), [flattened])

  const handleToggleBlockSummary = useCallback((blockId: string) => {
    setExpandedBlocks((current) => ({ ...current, [blockId]: !current[blockId] }))
  }, [])

  const handleCopyText = useCallback((messageId: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(messageId)
      window.setTimeout(() => setCopiedId((current) => (current === messageId ? null : current)), 1600)
    })
  }, [])

  return (
    <div className="mt-2 space-y-3">
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadEarlier}
          disabled={loadingEarlier}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingEarlier ? <Loader2 size={13} className="animate-spin" /> : <ChevronDown size={13} />}
          {loadingEarlier ? '加载更早轮次…' : '加载更早轮次'}
        </button>
      ) : null}

      {runs.map((run) => (
        <div key={run.id} className="rounded-xl border border-[var(--border-subtle)] p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{RUN_MODE_LABELS[run.mode] ?? run.mode}</span>
            <span>{ACTION_LABELS[run.action] ?? run.action}</span>
            <StatusPill tone={run.status === 'completed' || run.status === 'running' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral'}>
              {RUN_STATUS_LABELS[run.status] ?? run.status}
            </StatusPill>
            <span>{formatTokens(run.usage.totalTokens)} Token</span>
            <span className="ml-auto">{run.createdAt.slice(0, 16).replace('T', ' ')}</span>
          </div>
          {run.errorMessage ? <p className="mt-1 text-sm text-[var(--color-error)]">错误：{run.errorMessage}</p> : null}

          <div className="mt-3 space-y-3">
            {run.messages.map((message) => {
              if (message.role === 'user') {
                const attachments = message.parts.filter((part) => (part as AgentMessagePart).type === 'attachment')
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="flex max-w-[82%] flex-col items-end gap-1.5">
                      {attachments.length > 0 ? (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {attachments.map((part, partIndex) => {
                            const attachment = part as Extract<AgentMessagePart, { type: 'attachment' }>
                            if (attachment.kind === 'image') {
                              return (
                                <button
                                  key={`${message.id}-attach-${partIndex}`}
                                  type="button"
                                  onClick={() => setAttachmentPreview({ url: attachment.url, name: attachment.name })}
                                  className="cursor-zoom-in overflow-hidden rounded-[10px] border border-[var(--border-subtle)] transition hover:opacity-90"
                                  aria-label={`放大查看图片 ${attachment.name}`}
                                >
                                  <img src={attachment.url} alt={attachment.name} className="h-16 w-16 object-cover" loading="lazy" />
                                </button>
                              )
                            }
                            return (
                              <a
                                key={`${message.id}-attach-${partIndex}`}
                                href={attachment.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex max-w-52 items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-default)] hover:underline"
                                title={`打开文件 ${attachment.name}`}
                              >
                                <FileText className="h-3 w-3 shrink-0 text-[var(--text-secondary)]" />
                                <span className="truncate">{attachment.name}</span>
                              </a>
                            )
                          })}
                        </div>
                      ) : null}
                      <div className="whitespace-pre-wrap break-words rounded-[20px] bg-[var(--surface-contrast)] px-4 py-3 text-sm leading-7 text-[var(--text-contrast)]">
                        {getMessageText(message.parts)}
                      </div>
                    </div>
                  </div>
                )
              }

              const block = blockInfoById.get(message.id)
              const isBlockFirst = block?.firstId === message.id
              const isBlockLast = block?.lastId === message.id
              const blockExpanded = block ? !!expandedBlocks[block.firstId] : false
              const blockCollapsed = !blockExpanded
              const hasTextPart = message.parts.some((part) => (part as AgentMessagePart).type === 'text')
              const textCollapsible = !isBlockLast && (block?.ops ?? 0) > 0
              // 与创作区一致：折叠态下块内非首条且不再贡献内容的消息不渲染空壳
              if (blockCollapsed && !isBlockFirst && (!hasTextPart || textCollapsible)) {
                return null
              }

              return (
                <div key={message.id} className="min-w-0">
                  <AgentMessageParts
                    parts={message.parts as AgentMessagePart[]}
                    streaming={false}
                    runActive={false}
                    blockId={block?.firstId}
                    summaryCount={isBlockFirst ? block?.ops : undefined}
                    summaryExpanded={blockExpanded}
                    onToggleSummary={handleToggleBlockSummary}
                    textCollapsible={textCollapsible}
                  />
                  {isBlockLast && getMessageText(message.parts) ? (
                    <div className="mt-1 flex justify-start gap-0.5">
                      <button
                        type="button"
                        onClick={() => handleCopyText(message.id, getMessageText(message.parts))}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                        aria-label="复制回复"
                        title={copiedId === message.id ? '已复制' : '复制'}
                      >
                        {copiedId === message.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {attachmentPreview ? (
        <ImageLightbox
          src={attachmentPreview.url}
          alt={attachmentPreview.name}
          downloadName={attachmentPreview.name}
          onClose={() => setAttachmentPreview(null)}
        />
      ) : null}
    </div>
  )
}

/** 单个会话的轮次分页状态：首页最新 20 轮，「加载更早」按游标向前翻页并前置合并 */
type SessionPageState = { runs: AdminAgentRunRow[]; hasMore: boolean; nextCursor: string | null }

export default function AdminCreationRecordsPage() {
  const { userId = '' } = useParams()
  const navigate = useNavigate()
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [indexItems, setIndexItems] = useState<AdminCreationRecordsIndexRow[]>([])
  const [indexHasMore, setIndexHasMore] = useState(false)
  const [indexTotal, setIndexTotal] = useState(0)

  const [sessionPages, setSessionPages] = useState<Record<string, SessionPageState>>({})
  const [sessionLoading, setSessionLoading] = useState<Record<string, 'first' | 'earlier'>>({})
  const [sessionError, setSessionError] = useState<Record<string, boolean>>({})

  const recordsQuery = useQuery({
    queryKey: ['admin', 'users', userId, 'creation-records'],
    queryFn: () => getAdminCreationRecords(userId),
    enabled: Boolean(userId),
  })

  // 无 userId：默认分页列出有 Agent 会话记录的创作者，无需先搜索；输入关键词时可即时过滤
  const searchQuery = useQuery({
    queryKey: ['admin', 'creation-records', 'index', search, page],
    queryFn: () => getAdminCreationRecordsIndex(search || undefined, page),
    enabled: !userId,
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

  const loadSessionPage = useCallback(async (sessionId: string, before?: string) => {
    setSessionLoading((current) => ({ ...current, [sessionId]: before ? 'earlier' : 'first' }))
    setSessionError((current) => ({ ...current, [sessionId]: false }))
    try {
      const payload = await getAdminAgentSessionMessages(sessionId, before ? { before } : undefined)
      setSessionPages((current) => {
        const existing = current[sessionId]
        const runs = before && existing ? [...payload.runs, ...existing.runs] : payload.runs
        return { ...current, [sessionId]: { runs, hasMore: payload.hasMore, nextCursor: payload.nextCursor } }
      })
    } catch {
      setSessionError((current) => ({ ...current, [sessionId]: true }))
    } finally {
      setSessionLoading((current) => {
        const next = { ...current }
        delete next[sessionId]
        return next
      })
    }
  }, [])

  const handleToggleSession = useCallback(
    (sessionId: string) => {
      setExpandedSessionId((current) => {
        const next = current === sessionId ? null : sessionId
        if (next && !sessionPages[next] && !sessionLoading[next]) {
          void loadSessionPage(next)
        }
        return next
      })
    },
    [loadSessionPage, sessionPages, sessionLoading],
  )

  const payload = recordsQuery.data

  const sessionCount = useMemo(
    () => payload?.novels.reduce((total, novel) => total + novel.sessions.length, 0) ?? 0,
    [payload],
  )

  // 无 userId：直接分页列出创作者（免搜索），点击进入对应创作记录详情
  if (!userId) {
    return (
      <div>
        <AdminPageHeader
          title="创作记录"
          description={indexTotal > 0 ? `共 ${indexTotal} 位创作者有 Agent 创作记录，点击进入查看完整对话` : '无需搜索即可查看已有创作记录的创作者，点击进入其创作记录'}
        />
        <AdminAnalytics scope="creation" />
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
                      {user.lastSessionAt ? ` · 最近 ${user.lastSessionAt.slice(0, 10)}` : ''}
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
                    {novel.wordCount.toLocaleString('zh-CN')} 字 · {novel.chapterCount} 章 · {novel.sessions.length} 个会话 · {formatTokens(novel.totalTokens)} Token
                  </p>
                </div>

                {novel.sessions.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--text-tertiary)]">该作品暂无 Agent 对话会话</p>
                ) : (
                  <div className="mt-3 space-y-1.5">
                    {novel.sessions.map((session) => {
                      const expanded = expandedSessionId === session.id
                      const pageState = sessionPages[session.id]
                      const loading = sessionLoading[session.id]
                      return (
                        <div key={session.id} className="rounded-lg border border-[var(--border-subtle)]">
                          <button
                            type="button"
                            onClick={() => handleToggleSession(session.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-muted)]"
                          >
                            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            <History className="h-4 w-4 text-[var(--text-secondary)]" />
                            <span className="min-w-0 flex-1 truncate">{session.title}</span>
                            <MessageSquareText className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                            <span className="text-xs text-[var(--text-secondary)]">{session.runCount} 轮</span>
                            <span className="text-xs text-[var(--text-secondary)]">{formatTokens(session.totalTokens)} Token</span>
                            <span className="text-xs text-[var(--text-secondary)]">{session.lastRunAt ? session.lastRunAt.slice(0, 10) : session.createdAt.slice(0, 10)}</span>
                          </button>
                          {expanded ? (
                            <div className="border-t border-[var(--border-subtle)] px-3 py-2">
                              {loading === 'first' ? (
                                <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                                  <Loader2 size={13} className="animate-spin" />
                                  加载聊天记录…
                                </p>
                              ) : sessionError[session.id] ? (
                                <div className="space-y-2">
                                  <p className="text-sm text-[var(--color-error)]">加载失败。</p>
                                  <Button type="button" variant="secondary" onClick={() => void loadSessionPage(session.id)}>
                                    重试
                                  </Button>
                                </div>
                              ) : pageState ? (
                                <SessionTranscript
                                  runs={pageState.runs}
                                  hasMore={pageState.hasMore}
                                  loadingEarlier={loading === 'earlier'}
                                  onLoadEarlier={() => {
                                    if (pageState.nextCursor) {
                                      void loadSessionPage(session.id, pageState.nextCursor)
                                    }
                                  }}
                                />
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
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
