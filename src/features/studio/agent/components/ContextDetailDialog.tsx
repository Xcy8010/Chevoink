import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArchiveRestore, FileClock, Layers, LoaderCircle, MessageSquareText, X } from 'lucide-react'

import { fetchAgentContextDetail } from '../agentApi'
import { formatContextTokenCount } from '../lib/context-format'
import type { ContextCheckpoint, ContextDetailRecord } from '../../../../../shared/contracts/index.js'

type Props = {
  sessionId: string
  onClose: () => void
}

type DetailView = 'records' | 'checkpoints' | 'final'

const PAGE_SIZE = 20

const VIEW_TABS: Array<{ key: DetailView; label: string; icon: typeof FileClock }> = [
  { key: 'records', label: '上下文记录', icon: FileClock },
  { key: 'checkpoints', label: '压缩记录', icon: ArchiveRestore },
  { key: 'final', label: '最终上下文', icon: Layers },
]

const ROLE_META: Record<string, { label: string; className: string }> = {
  user: { label: '用户', className: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
  assistant: { label: 'Agent', className: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
  system: { label: '系统', className: 'bg-slate-500/12 text-[var(--text-secondary)]' },
}

function formatDetailTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function RecordRow({ record }: { record: ContextDetailRecord }) {
  const role = ROLE_META[record.role] ?? { label: record.role, className: 'bg-slate-500/12 text-[var(--text-secondary)]' }
  return (
    <li className={`flex gap-3 border-b border-[var(--border-subtle)] px-4 py-3 last:border-b-0 ${record.inWindow ? '' : 'opacity-55'}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-1.5 py-px text-[9px] font-medium ${role.className}`}>{role.label}</span>
          <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">{formatDetailTime(record.createdAt)}</span>
          {!record.inWindow ? <span className="rounded-full bg-[var(--surface-muted)] px-1.5 py-px text-[9px] text-[var(--text-tertiary)]">已压缩出窗口</span> : null}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--text-secondary)]">{record.excerpt || '（无文本内容）'}{record.excerpt.length >= 160 ? '…' : ''}</p>
      </div>
      <span className="shrink-0 pt-0.5 text-[9px] tabular-nums text-[var(--text-tertiary)]">{formatContextTokenCount(record.estimatedTokens)} tok</span>
    </li>
  )
}

function CheckpointCard({ checkpoint }: { checkpoint: ContextCheckpoint }) {
  const summary = checkpoint.summary
  const groups: Array<{ title: string; items: string[] }> = [
    { title: '目标', items: summary.goals },
    { title: '约束', items: summary.constraints },
    { title: '关键决策', items: summary.decisions },
    { title: '已完成', items: summary.completed },
    { title: '待处理', items: summary.pending },
  ]
  return (
    <li className="border-b border-[var(--border-subtle)] px-4 py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-[var(--text-primary)]">检查点 v{checkpoint.version}</span>
        <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">{formatDetailTime(checkpoint.createdAt)}</span>
        <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">{checkpoint.sourceMessageCount} 条消息 · {formatContextTokenCount(checkpoint.sourceTokens)} → {formatContextTokenCount(checkpoint.summaryTokens)} tok</span>
        <span className={`ml-auto text-[9px] ${checkpoint.validation.valid ? 'text-emerald-600' : 'text-rose-500'}`}>硬约束保留 {Math.round(checkpoint.validation.hardConstraintRetention * 100)}%</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {groups.filter((group) => group.items.length > 0).map((group) => (
          <p key={group.title} className="text-[10px] leading-5 text-[var(--text-secondary)]">
            <span className="text-[var(--text-tertiary)]">{group.title}：</span>
            {group.items.slice(-4).join('；')}
          </p>
        ))}
      </div>
    </li>
  )
}

/**
 * 上下文详情弹窗：上下文记录 / 压缩记录 / 最终上下文三视图。
 * 大量数据一律分页拉取（每页 20 条，底部「加载更多」追加），final 视图与占用卡同 token 口径。
 */
export default function ContextDetailDialog({ sessionId, onClose }: Props) {
  const [view, setView] = useState<DetailView>('records')
  const [records, setRecords] = useState<ContextDetailRecord[]>([])
  const [checkpoints, setCheckpoints] = useState<ContextCheckpoint[]>([])
  const [finalState, setFinalState] = useState<{ estimatedTokens: number; checkpointTokens: number; checkpointDigest: string | null; directiveDigest: string | null } | null>(null)
  const [finalWindow, setFinalWindow] = useState<ContextDetailRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (targetView: DetailView, targetPage: number) => {
    if (targetPage === 1) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    try {
      const result = await fetchAgentContextDetail(sessionId, targetView, targetPage, PAGE_SIZE)
      setPage(targetPage)
      if (result.view === 'records') {
        setRecords((current) => (targetPage === 1 ? result.items : [...current, ...result.items]))
        setTotal(result.total)
      } else if (result.view === 'checkpoints') {
        setCheckpoints((current) => (targetPage === 1 ? result.items : [...current, ...result.items]))
        setTotal(result.total)
      } else {
        setFinalState({ estimatedTokens: result.estimatedTokens, checkpointTokens: result.checkpointTokens, checkpointDigest: result.checkpointDigest, directiveDigest: result.directiveDigest })
        setFinalWindow((current) => (targetPage === 1 ? result.window.items : [...current, ...result.window.items]))
        setTotal(result.window.total)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '上下文详情读取失败。')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [sessionId])

  useEffect(() => {
    setRecords([])
    setCheckpoints([])
    setFinalWindow([])
    setFinalState(null)
    setTotal(0)
    setPage(0)
    void load(view, 1)
  }, [view, load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const items = view === 'records' ? records : view === 'checkpoints' ? checkpoints : finalWindow
  const hasMore = items.length < total

  return createPortal(
    <div
      className="studio-workspace fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(15,23,42,0.32)] px-4 backdrop-blur-[3px]"
      style={{ animation: 'ctx-detail-fade-in 180ms ease-out' }}
      onClick={onClose}
    >
      <style>{`
        @keyframes ctx-detail-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ctx-detail-pop-in { from { opacity: 0; transform: scale(0.97) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      `}</style>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="上下文详情"
        className="flex h-[min(700px,88dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_28px_80px_rgba(15,23,42,0.28)]"
        style={{ animation: 'ctx-detail-pop-in 220ms cubic-bezier(0.16,1,0.3,1)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)] text-[var(--text-secondary)]"><MessageSquareText className="h-4 w-4" /></span>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">上下文详情</h3>
          <div className="ml-2 flex items-center gap-1 rounded-full bg-[var(--surface-muted)] p-1">
            {VIEW_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                className={`rounded-full px-3 py-1 text-[11px] transition-colors duration-200 ${view === key ? 'bg-[var(--surface-default)] font-medium text-[var(--text-primary)] shadow-[0_1px_4px_rgba(15,23,42,0.12)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >{label}</button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭上下文详情" className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'final' && finalState ? (
            <div className="border-b border-[var(--border-subtle)] px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <p className="text-[11px] text-[var(--text-secondary)]">装配总量 <span className="text-base font-semibold tabular-nums text-[var(--text-primary)]">{formatContextTokenCount(finalState.estimatedTokens)}</span> tok</p>
                <p className="text-[10px] tabular-nums text-[var(--text-tertiary)]">其中检查点摘要 {formatContextTokenCount(finalState.checkpointTokens)} tok · 窗口消息 {formatContextTokenCount(finalState.estimatedTokens - finalState.checkpointTokens)} tok</p>
              </div>
              {finalState.checkpointDigest ? (
                <details className="group mt-3">
                  <summary className="cursor-pointer list-none text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]">检查点摘要注入（发送给模型的原文）<span className="ml-1 text-[9px] text-[var(--text-tertiary)] group-open:hidden">点击展开</span></summary>
                  <pre className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-[var(--surface-muted)] px-3 py-2.5 text-[10px] leading-5 text-[var(--text-secondary)]">{finalState.checkpointDigest}</pre>
                </details>
              ) : null}
              {finalState.directiveDigest ? (
                <details className="group mt-2">
                  <summary className="cursor-pointer list-none text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]">作者指令账本注入（发送给模型的原文）<span className="ml-1 text-[9px] text-[var(--text-tertiary)] group-open:hidden">点击展开</span></summary>
                  <pre className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-[var(--surface-muted)] px-3 py-2.5 text-[10px] leading-5 text-[var(--text-secondary)]">{finalState.directiveDigest}</pre>
                </details>
              ) : null}
              <p className="mt-3 text-[10px] text-[var(--text-tertiary)]">窗口内消息（正序，共 {finalState ? total : 0} 条）：</p>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-[var(--text-secondary)]"><LoaderCircle className="h-4 w-4 animate-spin" />读取中…</div>
          ) : error ? (
            <div className="py-14 text-center">
              <p className="text-xs text-[var(--text-secondary)]">{error}</p>
              <button type="button" onClick={() => void load(view, 1)} className="mt-2 text-[11px] text-[var(--text-primary)] underline underline-offset-4">重试</button>
            </div>
          ) : items.length === 0 ? (
            <p className="py-14 text-center text-[11px] leading-6 text-[var(--text-secondary)]">
              {view === 'checkpoints' ? '当前会话尚未产生压缩检查点。' : view === 'final' ? '当前上下文窗口内还没有消息。' : '当前会话还没有对话记录。'}
            </p>
          ) : (
            <ul>
              {view === 'checkpoints'
                ? (checkpoints).map((checkpoint) => <CheckpointCard key={checkpoint.id} checkpoint={checkpoint} />)
                : (items as ContextDetailRecord[]).map((record) => <RecordRow key={record.id} record={record} />)}
            </ul>
          )}
        </div>

        {!loading && !error && hasMore ? (
          <footer className="shrink-0 border-t border-[var(--border-subtle)] px-5 py-3 text-center">
            <button
              type="button"
              onClick={() => void load(view, page + 1)}
              disabled={loadingMore}
              className="inline-flex h-8 items-center gap-2 rounded-full px-4 text-[11px] text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >{loadingMore ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}{loadingMore ? '加载中…' : `加载更多（已显示 ${items.length} / ${total}）`}</button>
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  )
}
