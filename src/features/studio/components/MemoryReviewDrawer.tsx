import { useEffect, useRef, useState } from 'react'
import { BrainCircuit, Check, LoaderCircle, X } from 'lucide-react'

import { fetchMemoryReviewInbox, resolveMemoryReviewItem, type MemoryReviewItem } from '../agent/agentApi'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

export default function MemoryReviewDrawer({ open, novelId, onClose }: { open: boolean; novelId: string; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null)
  useDialogFocusTrap({ panel, open, onClose })
  const [items, setItems] = useState<MemoryReviewItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    void fetchMemoryReviewInbox(novelId)
      .then((result) => setItems(result.items))
      .catch((reason) => setError(reason instanceof Error ? reason.message : '记忆审核箱加载失败。'))
      .finally(() => setLoading(false))
  }, [novelId, open])

  async function resolve(item: MemoryReviewItem, accepted: boolean) {
    setBusyId(item.id)
    setError(null)
    try {
      await resolveMemoryReviewItem(item.id, accepted)
      setItems((current) => current.filter((candidate) => candidate.id !== item.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '处理失败，请稍后再试。')
    } finally {
      setBusyId(null)
    }
  }

  if (!open) return null
  return (
    <div className="studio-tool-overlay fixed inset-0 z-[125] bg-[rgba(15,23,42,0.3)] md:flex md:justify-end lg:justify-center" onClick={onClose}>
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="记忆审核箱"
        tabIndex={-1}
        className="studio-tool-dialog flex h-full min-h-0 w-full flex-col bg-[var(--surface-default)] md:max-w-[34rem] md:border-l md:border-[var(--border-subtle)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 pb-3 pt-[max(var(--safe-top),14px)] md:px-5 md:pt-4">
          <BrainCircuit className="h-5 w-5 text-[var(--text-secondary)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">记忆审核箱</h2>
            <p className="text-xs text-[var(--text-secondary)]">冲突不会自动覆盖，确认后才升级为故事事实。</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-[var(--text-secondary)]" aria-label="关闭记忆审核箱"><X className="h-4 w-4" /></button>
        </header>
        <div className="studio-tool-body min-h-0 flex-auto overflow-y-auto px-4 py-4 md:px-5">
          {loading ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取证据…</p> : null}
          {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}
          {!loading && !error && items.length === 0 ? <p className="py-12 text-center text-sm text-[var(--text-secondary)]">没有待处理的记忆冲突</p> : null}
          <div className="divide-y divide-[var(--border-subtle)]">
            {items.map((item) => (
              <article key={item.id} className="py-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">{item.title}</h3>
                    <p className="mt-1 text-[11px] text-amber-700">{item.status} · 可信度 {Math.round(item.confidence * 100)}%</p>
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--text-primary)]">{item.content}</p>
                <div className="mt-3 space-y-1 text-[11px] text-[var(--text-tertiary)]">
                  {item.evidence.map((evidence) => <p key={evidence.id}>依据 {evidence.sourceType}:{evidence.sourceId}{evidence.revision ? ` @r${evidence.revision}` : ''}</p>)}
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" disabled={busyId === item.id} onClick={() => void resolve(item, false)} className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] disabled:opacity-45"><X className="h-3.5 w-3.5" />拒绝</button>
                  <button type="button" disabled={busyId === item.id} onClick={() => void resolve(item, true)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--surface-contrast)] px-4 text-sm text-[var(--text-contrast)] disabled:opacity-45"><Check className="h-3.5 w-3.5" />确认为事实</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
