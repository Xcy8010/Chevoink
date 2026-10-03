import { useEffect, useState } from 'react'
import { Bot, Check, ChevronDown } from 'lucide-react'
import type { AgentSubtaskView } from '../../../../../shared/contracts/index.js'
import { fetchAgentSubtasks } from '../agentApi'

export function SubagentPicker({ novelId, selectedId, disabled, onSelect, open: controlledOpen, onOpenChange, hideTrigger = false }: {
  novelId: string
  selectedId?: string
  disabled?: boolean
  onSelect: (item: AgentSubtaskView) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (value: boolean) => { setInternalOpen(value); onOpenChange?.(value) }
  const [attempt, setAttempt] = useState(0)
  const [items, setItems] = useState<AgentSubtaskView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true); setError(false); setItems([])
    void fetchAgentSubtasks(novelId).then(result => {
      if (active) setItems(result.items.filter(item => item.enabled))
    }).catch(() => { if (active) setError(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [novelId, open, attempt])
  return <>
    {hideTrigger ? null : <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--surface-muted)] disabled:opacity-40">
      <Bot className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">指定子 Agent<span className="mt-0.5 block text-[10px] text-[var(--text-tertiary)]">选择后随需求发送，不立即执行</span></span><ChevronDown className="h-3.5 w-3.5" />
    </button>}
    {open ? <div className="border-t border-[var(--border-subtle)] px-2 py-2 text-[11px]">
      <p className="mb-2 px-1 leading-5 text-[var(--text-secondary)]">主 Agent 在本任务内调用；沿用当前模型、费用及审批。一次指定一个，不另开任务窗口。</p>
      {loading ? <p role="status">正在加载子 Agent…</p> : error ? <p role="alert">加载失败。<button type="button" onClick={() => setAttempt(value => value + 1)} className="ml-2 underline">重试</button></p> : items.length === 0 ? <p className="px-1 py-3 text-[var(--text-tertiary)]">当前作品没有已启用的子 Agent。可在设置 → Agent 操作中创建或启用。</p> : <div className="max-h-56 overflow-y-auto overscroll-contain" aria-label="可指定的子 Agent">
        {items.map(item => <button key={item.id} type="button" disabled={disabled} aria-pressed={selectedId === item.id} onClick={() => { onSelect(item); setOpen(false) }} className="flex min-h-11 w-full items-start gap-2 rounded-md p-2 text-left hover:bg-[var(--surface-muted)] disabled:opacity-40">
          <span className="min-w-0 flex-1"><span className="block font-medium">{item.name}</span><span className="mt-1 block break-words text-[10px] text-[var(--text-tertiary)]">{item.triggerCondition}</span></span>{selectedId === item.id ? <Check className="h-4 w-4 shrink-0" /> : null}
        </button>)}
      </div>}
    </div> : null}
  </>
}
