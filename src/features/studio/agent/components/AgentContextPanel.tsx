import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, CheckCircle2, ChevronRight, LoaderCircle, MessageSquareText, RefreshCw, ShieldCheck } from 'lucide-react'

import { compactAgentContext, fetchAgentContextState } from '../agentApi'
import { useAgentStore } from '../agentStore'
import { formatContextTokenCount } from '../lib/context-format'
import { isMemoryAccessError, readMemorySnapshot } from '../lib/memory-read'

type Props = {
  userId?: string
  novelId: string
  sessionId: string | null
  active?: boolean
  /** 记忆中心组合时由外层提供单一滚动容器，面板自身不再滚动 */
  scrollable?: boolean
  /** 占用卡右上角「查看详情」：打开上下文记录/压缩记录/最终上下文弹窗 */
  onOpenDetail?: () => void
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return <section className="space-y-1.5">
    <h4 className="text-[11px] font-medium text-[var(--text-tertiary)]">{title}</h4>
    <ul className="space-y-1 text-[11px] leading-5 text-[var(--text-secondary)]">
      {items.slice(-6).map((item, index) => <li key={`${title}-${index}`} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--text-tertiary)]" /><span>{item}</span></li>)}
    </ul>
  </section>
}

function Metric({ value, refreshing }: { value?: ReactNode; refreshing: boolean }) {
  if (value === undefined) return <span aria-hidden="true" className="studio-pending skeleton-shimmer inline-block h-[.75em] w-[3ch] rounded-sm" />
  return <span className={refreshing ? 'studio-metric-updating' : undefined}>{value}</span>
}

/** 当前用户与 Agent 会话的真实上下文窗口，不混入作品树或编辑器选区。 */
export default function AgentContextPanel({ userId, novelId, sessionId, active = false, scrollable = true, onOpenDetail }: Props) {
  const queryClient = useQueryClient()
  const queryKey = ['studio', 'memory-context', userId, novelId, sessionId] as const
  const { data: snapshot, error, isFetching, refetch } = useQuery({
    queryKey, queryFn: ({ signal }) => readMemorySnapshot(fetchAgentContextState(sessionId!, signal)),
    enabled: Boolean(userId && novelId && sessionId), staleTime: 30_000, refetchInterval: active ? 5_000 : false, retry: false,
  })
  const state = snapshot?.value
  const live = useAgentStore(store => active && store.activeSessionId === sessionId && store.requestContext?.runId === store.runId
    ? store.requestContext : null)
  const measured = state && live && !(state.requestSample?.runId === live.runId && state.requestSample.seq >= live.seq) ? live : null
  const windowTokens = measured?.contextWindowTokens ?? state?.contextWindowTokens
  const tokens = measured?.estimatedTokens ?? state?.estimatedTokens
  const usageRatio = measured ? measured.estimatedTokens / measured.contextWindowTokens : state?.usageRatio ?? 0
  const threshold = measured ? measured.compactAtTokens / measured.contextWindowTokens : state?.compactionThreshold ?? 0
  const hasRequest = Boolean(measured || state?.requestSample)
  const readError = snapshot?.denied || error?.message
  const refreshing = Boolean(state && isFetching)
  const compression = useMutation({ mutationFn: compactAgentContext })
  const compacting = compression.isPending
  const [message, setMessage] = useState<string | null>(null)
  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (wasActiveRef.current && !active && userId && sessionId) void refetch()
    wasActiveRef.current = active
  }, [userId, sessionId, active, refetch])

  const percent = Math.max(0, Math.round(usageRatio * 100))
  const cappedPercent = Math.min(100, percent)
  const checkpoint = state?.checkpoint ?? null

  const compact = () => {
    if (!sessionId || !state || active || compacting) return
    setMessage(null)
    compression.mutate(sessionId, {
      onSuccess: result => {
        if (!queryClient.getQueryData<typeof snapshot>(queryKey)?.value) return
        // Only a current authorized read can replace the displayed checkpoint.
        void queryClient.invalidateQueries({ queryKey, exact: true })
        setMessage(result.checkpoint ? `已生成第 ${result.checkpoint.version} 版上下文检查点。` : '当前有效对话较短，暂时无需压缩。')
      },
      onError: reason => {
        if (isMemoryAccessError(reason)) {
          void queryClient.cancelQueries({ queryKey, exact: true })
          queryClient.setQueryData(queryKey, { denied: reason.message || '当前内容已不可访问。' })
        } else setMessage(reason.message || '上下文压缩失败。')
      },
    })
  }

  if (!sessionId) return <div className={`${scrollable ? 'flex h-full items-center justify-center' : 'py-10 text-center'} px-6 text-xs leading-6 text-[var(--text-secondary)]`}>发送第一条消息后，这里会显示当前任务的对话上下文与压缩进度。</div>

  return <div className={`${scrollable ? 'h-full overflow-y-auto' : ''} px-4 py-4`}>
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)] text-[var(--text-secondary)]"><MessageSquareText className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">会话上下文</h3>
        <p className="mt-1 text-[11px] leading-5 text-[var(--text-secondary)]">同一任务切换模型时沿用会话历史与检查点。</p>
      </div>
      <button type="button" onClick={() => void refetch()} disabled={!userId || isFetching} className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] disabled:cursor-default" aria-label="刷新上下文状态"><RefreshCw className="h-3.5 w-3.5" /></button>
    </div>

    {!state && !readError && <span role="status" className="studio-pending sr-only">正在读取上下文状态</span>}
    {state || !readError ? <>
      <section className="relative mt-5 rounded-[14px] bg-[var(--surface-muted)] p-3.5">
        {onOpenDetail ? <button
          type="button"
          onClick={onOpenDetail} disabled={!state}
          className="absolute right-2.5 top-2.5 inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-[10px] text-[var(--text-tertiary)] transition-colors duration-200 hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]"
          aria-label="查看上下文详情"
        >查看详情<ChevronRight className="h-3 w-3" /></button> : null}
        <div className="flex items-end justify-between gap-3"><div><p className="text-[11px] text-[var(--text-secondary)]">上下文占用</p><p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--text-primary)]"><Metric value={state && `${percent}%`} refreshing={refreshing} /></p></div><p className="pb-1 pr-16 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]"><Metric value={tokens !== undefined && windowTokens !== undefined ? `${formatContextTokenCount(tokens)} / ${formatContextTokenCount(windowTokens)}` : undefined} refreshing={refreshing} /></p></div>
        <div className={`relative mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-default)] ${state ? '' : 'studio-pending skeleton-shimmer'}`}>
          {state && <>
            <div className={`relative h-full overflow-hidden rounded-full transition-[width] duration-500 ${usageRatio >= threshold ? 'bg-rose-500' : usageRatio >= state.warningThreshold ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${cappedPercent}%` }}>
              {refreshing && <span aria-hidden="true" className="studio-pending skeleton-shimmer absolute inset-0 opacity-25" />}
            </div>
            <span className="absolute inset-y-0 w-px bg-[var(--text-tertiary)]/70" style={{ left: `${Math.min(100, threshold * 100)}%` }} />
          </>}
        </div>
        <div className="mt-2 flex justify-between text-[9px] text-[var(--text-tertiary)]"><span>{hasRequest ? '最近一次模型输入估算' : '已保存的会话历史估算'}</span><span>自动压缩阈值 <Metric value={state && `${Math.round(threshold * 100)}%`} refreshing={refreshing} /></span></div>
      </section>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded-[10px] border border-[var(--border-subtle)] px-3 py-2.5"><p className="text-[var(--text-tertiary)]">有效要求</p><p className="mt-1 text-sm font-medium tabular-nums text-[var(--text-primary)]"><Metric value={state?.activeDirectiveCount} refreshing={refreshing} /></p></div>
        <div className="rounded-[10px] border border-[var(--border-subtle)] px-3 py-2.5"><p className="text-[var(--text-tertiary)]">会话历史检查点</p><p className="mt-1 text-sm font-medium tabular-nums text-[var(--text-primary)]"><Metric value={state && (checkpoint ? `v${checkpoint.version}` : '暂无')} refreshing={refreshing && Boolean(checkpoint)} /></p></div>
      </div>

      <button type="button" onClick={compact} disabled={!state || compacting || active} className="mt-3 inline-flex h-8 w-full items-center justify-center gap-2 rounded-[9px] bg-[var(--surface-contrast)] px-3 text-xs font-medium text-[var(--text-contrast)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40" title={active ? 'Agent 运行结束后可手动压缩' : '压缩当前会话'}>{compacting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}{compacting ? '正在压缩…' : '手动压缩当前会话'}</button>
      {active ? <p className="mt-1.5 text-center text-[9px] text-[var(--text-tertiary)]">为保证本轮事件完整，运行结束后开放手动压缩。</p> : null}

      {message ? <p className="mt-3 rounded-[9px] bg-[var(--surface-muted)] px-3 py-2 text-[10px] leading-5 text-[var(--text-secondary)]">{message}</p> : null}

      {checkpoint ? <section className="mt-5 space-y-4 border-t border-[var(--border-subtle)] pt-4">
        <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /><div><p className="text-xs font-medium text-[var(--text-primary)]">已验证检查点 v{checkpoint.version}</p><p className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">{checkpoint.sourceMessageCount} 条历史消息 · {formatContextTokenCount(checkpoint.sourceTokens)} → {formatContextTokenCount(checkpoint.summaryTokens)}</p></div></div>
        {checkpoint.version >= 2 ? <p className="rounded-[9px] bg-[var(--surface-muted)] px-3 py-2 text-[10px] leading-5 text-[var(--text-secondary)]">该任务已多次压缩。目标、硬约束和工具凭据会保留，但很早的措辞细节可能逐步淡化；需要逐字延续时建议新建任务并附上原文。</p> : null}
        <SummaryList title="目标" items={checkpoint.summary.goals} />
        <SummaryList title="约束" items={checkpoint.summary.constraints} />
        <SummaryList title="关键决策" items={checkpoint.summary.decisions} />
        <SummaryList title="已完成" items={checkpoint.summary.completed} />
        <SummaryList title="待处理" items={checkpoint.summary.pending} />
        <p className="flex items-center gap-1.5 text-[9px] text-emerald-600"><CheckCircle2 className="h-3 w-3" />硬约束保留率 {Math.round(checkpoint.validation.hardConstraintRetention * 100)}%</p>
      </section> : null}
    </> : null}
    {readError && <p role="alert" className="mt-3 text-xs text-[var(--text-secondary)]">{readError}</p>}
  </div>
}
