import { useInfiniteQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, Copy, History, LoaderCircle } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { AuthorActivityParts, AuthorActivitySummary, AuthorProgressText } from '@/features/studio/agent/components/AuthorActivityParts'
import { AgentProcessRegion } from '@/features/studio/agent/components/AgentProcessRegion'
import { AuthorRequestBubble } from '@/features/studio/agent/components/AuthorRequestBubble'
import { activityAnswerText, projectActivityGroups } from '@/features/studio/agent/lib/activity-groups'
import { getMessageText } from '@/features/studio/agent/lib/panel-helpers'
import { projectBlockTimings, projectMessages, shouldRenderAuthorMessage } from '@/features/studio/agent/lib/message-projection'
import ImageLightbox from '@/features/studio/components/ImageLightbox'
import type { AdminAgentRunRow } from '../../../../shared/contracts/index.js'
import { formatReplayTime } from '../admin-shared'
import { getAdminAgentRunDetails, getAdminAgentSessionMessages } from '../api'
import { AdminPageHeader, AdminPanelState, StatusPill } from '../AdminLayout'

const runStatus: Record<string, string> = {
  queued: '排队中', running: '进行中', awaiting_approval: '等待确认', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}

const toolOutcome = {
  dispatched: '已调用', success: '成功', failed: '失败', unanswered: '未获回答', unknown: '结果未知',
}

function ReplayCopy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return <button type="button" aria-label={label} title={copied ? '已复制' : label}
    onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}
    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]">
    {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
  </button>
}

function ReplayMessageTime({ value, label, focusable }: { value: string; label: string; focusable: boolean }) {
  const time = formatReplayTime(value)
  return <time dateTime={value} aria-label={`${label} ${time}`} tabIndex={focusable ? 0 : undefined}
    className="text-xs tabular-nums text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover/replay-message:opacity-100 group-focus-within/replay-message:opacity-100 [@media(hover:none)]:opacity-100">
    {time}
  </time>
}

function RunDetails({ sessionId, runs }: { sessionId: string; runs: AdminAgentRunRow[] }) {
  const [runId, setRunId] = useState('')
  const run = runs.find(item => item.id === runId) ?? runs.at(-1)!
  const query = useInfiniteQuery({
    queryKey: ['admin', 'agent-sessions', sessionId, 'run-details', run.id],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => getAdminAgentRunDetails(sessionId, run.id, pageParam),
    getNextPageParam: page => page.nextAfter ?? undefined,
  })
  const details = query.data?.pages[0]
  const events = query.data?.pages.flatMap(page => page.events) ?? []
  // Older histories may only have a tool part on a saved message. Its
  // position is known, while the actual event sequence/time is unavailable.
  const messageReceipts = details && !events.length && !query.hasNextPage
    ? run.messages.flatMap(message => message.parts.flatMap(part => part.type === 'tool-call' && !part.preparing ? [part] : []))
    : []
  return <aside id="admin-replay-run-details" aria-label="运行详情" className="min-w-0 self-start rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 xl:order-last">
    <label className="block text-sm font-medium" htmlFor="admin-replay-run">运行详情</label>
    <select id="admin-replay-run" value={run.id} onChange={event => setRunId(event.target.value)}
      className="mt-2 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-2 py-2 text-xs">
      {runs.map(item => <option key={item.id} value={item.id}>{formatReplayTime(item.createdAt)} · {runStatus[item.status] ?? item.status}</option>)}
    </select>
    <dl className="mt-3 grid gap-1.5 break-words text-xs leading-5">
      <div><dt className="inline text-[var(--text-secondary)]">运行 ID </dt><dd className="inline font-mono">{run.id}</dd></div>
      <div><dt className="inline text-[var(--text-secondary)]">开始 </dt><dd className="inline">{formatReplayTime(run.startedAt)}</dd></div>
      <div><dt className="inline text-[var(--text-secondary)]">结束 </dt><dd className="inline">{formatReplayTime(run.finishedAt)}</dd></div>
      <div><dt className="inline text-[var(--text-secondary)]">Token </dt><dd className="inline">{run.usageRecorded === false ? '未记录'
        : `${run.usage.totalTokens.toLocaleString('zh-HK')}（输入 ${run.usage.promptTokens.toLocaleString('zh-HK')} · 输出 ${run.usage.completionTokens.toLocaleString('zh-HK')}）`}</dd></div>
      {details ? <>
        <div><dt className="inline text-[var(--text-secondary)]">实际模型 </dt><dd className="inline">{details.models.join('、') || '未记录'}</dd></div>
        <div><dt className="inline text-[var(--text-secondary)]">已记 Credits </dt><dd className="inline">{details.creditsMilli === null ? '未记录'
          : (details.creditsMilli / 1000).toLocaleString('zh-HK', { maximumFractionDigits: 3 })}</dd></div>
      </> : null}
    </dl>
    <h3 className="mt-4 text-sm font-medium">工具回执</h3>
    {query.isLoading ? <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">正在加载工具回执…</p> : null}
    {query.isError ? <Button type="button" variant="secondary" className="mt-2" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}>重新加载工具回执</Button> : null}
    {details && !events.length && !messageReceipts.length && !query.hasNextPage ? <p className="mt-2 text-xs text-[var(--text-secondary)]">没有已保存的工具回执。</p> : null}
    {events.length ? <ol className="mt-1 max-h-[55vh] divide-y divide-[var(--border-subtle)] overflow-y-auto text-xs">
      {events.map(event => <li key={event.seq} className="space-y-0.5 break-words py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-mono">{event.toolName}</span>
          <span className={cn('text-[var(--text-secondary)]', event.outcome === 'failed' && 'text-[var(--color-error)]')}>{toolOutcome[event.outcome]}</span>
        </div>
        <p className="text-[var(--text-secondary)]">#{event.seq} · {formatReplayTime(event.at)}{event.durationMs === null ? '' : ` · ${event.durationMs.toLocaleString('zh-HK')} ms`}</p>
        <p className="font-mono text-[var(--text-tertiary)]">{event.callId}</p>
        {event.summary ? <p>{event.summary}</p> : null}
        {event.failureCode ? <p className="font-mono text-[var(--color-error)]">{event.failureCode}</p> : null}
      </li>)}
    </ol> : null}
    {messageReceipts.length ? <>
      <p className="mt-2 text-xs text-[var(--text-secondary)]">以下来自保存的消息，原始事件时间未记录。</p>
      <ol className="mt-1 max-h-[55vh] divide-y divide-[var(--border-subtle)] overflow-y-auto text-xs">
        {messageReceipts.map((part, index) => <li key={index} className="break-words py-2">
          <span className="font-mono">{part.toolName}</span> · {part.display?.kind === 'question' && part.display.cancelled ? '作者已取消'
            : part.display?.kind === 'question' && part.display.unanswered ? '未获回答'
            : part.status === 'success' ? '成功' : part.status === 'failed' ? '失败' : part.status === 'denied' ? '未获准' : '结果未知'}
          {part.summary ? <p>{part.summary}</p> : null}
        </li>)}
      </ol>
    </> : null}
    {query.hasNextPage && !query.isFetchNextPageError ? <Button type="button" variant="secondary" className="mt-2" disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '正在加载…' : '加载更多工具回执'}</Button> : null}
  </aside>
}

export function AdminCreationReplay({ userId, sessionId }: { userId: string; sessionId: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [attachmentPreview, setAttachmentPreview] = useState<{ url: string; name: string } | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const firstMessage = useRef<HTMLDivElement | null>(null)
  const prependAnchor = useRef<{ node: HTMLDivElement; top: number } | null>(null)
  const query = useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'agent-session-replay', sessionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getAdminAgentSessionMessages(sessionId, { userId, before: pageParam }),
    getNextPageParam: page => page.hasMore ? page.nextCursor ?? undefined : undefined,
  })
  const session = query.data?.pages[0]?.session
  const runs = useMemo(() => [...new Map(query.data?.pages.slice().reverse().flatMap(page => page.runs)
    .map(run => [run.id, run])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [query.data])
  const messages = useMemo(() => runs.flatMap(run => run.messages), [runs])
  const projection = useMemo(() => projectMessages(messages), [messages])
  const timings = useMemo(() => projectBlockTimings(messages, projection.blockInfoById, null), [messages, projection])
  const activities = useMemo(() => projectActivityGroups(messages), [messages])
  useLayoutEffect(() => {
    if (query.isFetchingNextPage || !prependAnchor.current) return
    const { node, top } = prependAnchor.current
    prependAnchor.current = null
    const scroller = node.closest('main')
    if (node.isConnected && scroller) scroller.scrollTop += node.getBoundingClientRect().top - top
  }, [query.isFetchingNextPage, query.data])
  const loadEarlier = () => {
    const node = firstMessage.current
    if (node) prependAnchor.current = { node, top: node.getBoundingClientRect().top }
    void query.fetchNextPage()
  }
  const toggle = (id: string) => setExpanded(current => ({ ...current, [id]: !current[id] }))
  return <div>
    <Link to={`/admin/users/${encodeURIComponent(userId)}/creation-records`}
      className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
      <ArrowLeft size={15} /> 返回创作记录
    </Link>
    <AdminPageHeader title={session?.title ?? '会话回看'} description={session ? session.displayTitle || session.novelTitle : undefined}
      extra={runs.length ? <Button type="button" variant="secondary" aria-expanded={showDetails} aria-controls="admin-replay-run-details"
        onClick={() => setShowDetails(value => !value)}>运行详情</Button> : undefined} />
    <AdminPanelState state={query.isLoading ? 'loading' : query.isError && !session ? 'error' : !runs.length ? 'empty' : 'ready'}>
      <div className={cn('grid min-w-0 gap-6', showDetails && 'xl:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)]')}>
        {showDetails && runs.length ? <RunDetails sessionId={sessionId} runs={runs} /> : null}
        <div aria-label="会话回看" className="agent-conversation-width flex flex-col gap-4 pb-8">
          {query.data?.pages.some(page => page.historyPending) ? <p role="status" className="agent-reading-column text-sm text-[var(--text-secondary)]">
            部分创作活动尚未进入历史记录。当前显示已保存的消息。
          </p> : null}
          {query.hasNextPage ? <div className="flex justify-center pb-1">
            <button type="button" onClick={loadEarlier} disabled={query.isFetchingNextPage}
              className="flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-60">
              {query.isFetchingNextPage ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
              {query.isFetchingNextPage ? '正在载入更早对话…' : query.isFetchNextPageError ? '重试加载更早对话' : '加载更早对话'}
            </button>
          </div> : null}
          {runs.map((run, index) => <div key={run.id} ref={index === 0 ? firstMessage : undefined} className="flex min-w-0 flex-col gap-4">
            {run.messages.map(message => {
              if (message.role === 'user') {
                if (!shouldRenderAuthorMessage(message)) return null
                const block = projection.blockByAuthorId.get(message.id)
                const timing = block ? timings.get(block.firstId) : undefined
                const text = getMessageText(message.parts, 'user')
                return <div key={message.id} className="flex min-w-0 max-w-full flex-col items-end gap-1.5">
                  <div className="group/replay-message flex min-w-0 max-w-[82%] flex-col items-end gap-1.5">
                    <AuthorRequestBubble parts={message.parts} onPreview={setAttachmentPreview} />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <ReplayMessageTime value={message.createdAt} label="发送时间" focusable={!text} />
                      {text ? <ReplayCopy text={text} label="复制消息" /> : null}
                    </div>
                  </div>
                  {timing && (block?.ops || timing.elapsedMs !== null) ? <div className="agent-reading-column pt-3">
                    <AuthorActivitySummary timing={timing} active={false} open={Boolean(block && expanded[block.firstId])}
                      onToggle={block?.ops ? () => toggle(block.firstId) : undefined} />
                  </div> : null}
                </div>
              }
              const block = projection.blockInfoById.get(message.id)
              const isFirst = block?.firstId === message.id
              const isLast = block?.lastId === message.id
              const hasProcess = Boolean(block?.ops)
              const open = !hasProcess || Boolean(block && expanded[block.firstId])
              const timing = isFirst && !block?.authorId ? timings.get(message.id) : undefined
              const summary = timing && (timing.elapsedMs !== null || hasProcess)
              const groups = activities.byMessage.get(message.id)
              const hasActivity = groups && [...groups.values()].some(group => group.messageId === message.id)
              const text = getMessageText(message.parts, 'assistant')
              const finalText = isLast ? activityAnswerText(message.parts) : ''
              const receipt = isLast && message.completedAt && !finalText ? activities.savedReplyByRun.get(message.runId) : undefined
              const opening = isFirst && hasProcess ? activities.openingByRun.get(block?.runIds?.[0] ?? message.runId) : undefined
              if (!summary && !hasActivity && !opening && !receipt && !text) return null
              const wholeMessageIsProcess = hasProcess && !summary && !finalText && !receipt
              const showReplyTime = Boolean(finalText || receipt || text && open)
              const completedAt = isLast ? message.completedAt : null
              const copyText = completedAt ? finalText || receipt : null
              return <AgentProcessRegion key={message.id} open={!wholeMessageIsProcess || open}
                className={cn('agent-reading-column min-w-0', message.id !== projection.lastAssistantId && 'agent-msg-cv')}>
                {summary ? <AuthorActivitySummary timing={timing} active={false} open={open} onToggle={block?.ops ? () => toggle(block.firstId) : undefined} /> : null}
                <div className="group/replay-message">
                  {opening ? <AgentProcessRegion open={open} className="mb-4"><AuthorProgressText text={opening} /></AgentProcessRegion> : null}
                  <AuthorActivityParts parts={message.parts} groups={groups} messageId={message.id} runActive={false} readOnly
                    processOpen={hasProcess && !wholeMessageIsProcess ? open : undefined}
                    collapseText={hasProcess && !isLast && !wholeMessageIsProcess} />
                  {receipt ? <AuthorProgressText text={receipt} /> : null}
                  {showReplyTime ? <div className="mt-1 flex flex-wrap items-center gap-2">
                    {copyText ? <ReplayCopy text={copyText} label="复制回复" /> : null}
                    <ReplayMessageTime value={completedAt ?? message.createdAt} label={completedAt ? '完成时间' : '回复时间'} focusable={!copyText} />
                  </div> : null}
                </div>
              </AgentProcessRegion>
            })}
            {run.status === 'failed' || run.status === 'cancelled' || run.status === 'paused' ? <div className="agent-reading-column flex flex-wrap items-baseline gap-2 border-t border-[var(--border-subtle)] pt-2 text-sm">
              <StatusPill tone={run.status === 'failed' ? 'danger' : 'neutral'}>{runStatus[run.status]}</StatusPill>
              {run.errorMessage ? <p className="break-words text-[var(--text-secondary)]">{run.errorMessage}</p> : null}
            </div> : null}
          </div>)}
        </div>
      </div>
    </AdminPanelState>
    {attachmentPreview ? <ImageLightbox src={attachmentPreview.url} alt={attachmentPreview.name} downloadName={attachmentPreview.name}
      onClose={() => setAttachmentPreview(null)} /> : null}
  </div>
}
