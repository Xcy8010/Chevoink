import { StudioPresence } from '@/features/studio/components/StudioPresence'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownRight, GitBranch, ListEnd, MoreHorizontal, Pencil, SquarePlus, Trash2 } from 'lucide-react'
import type { AgentQueueAction, AgentQueuedRequestView } from '../../../../../shared/contracts/agent-queue.js'

type Props = {
  items: AgentQueuedRequestView[]
  onAction: (item: AgentQueuedRequestView, action: AgentQueueAction, prompt?: string) => Promise<void>
}
export function AgentQueueTray({ items, onAction }: Props) {
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const [editing, setEditing] = useState<{ item: AgentQueuedRequestView; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenu(null); menuTrigger.current?.focus() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        event.preventDefault(); buttons[next]?.focus()
      }
      if (event.key === 'Tab') setMenu(null)
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [menu])
  async function act(item: AgentQueuedRequestView, action: AgentQueueAction, text?: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(null); setMenu(null)
    try { await onAction(item, action, text); setEditing(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，需求已保留。') }
    finally { busyRef.current = false; setBusy(false) }
  }
  const selected = items.find(item => item.id === menu?.id)
  if (!items.length && !error) return null
  const actionClass = 'inline-flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg px-1 text-[var(--text-secondary)] hover:bg-[var(--surface-default)] focus-visible:outline focus-visible:outline-2 disabled:opacity-40 mobile:h-11 mobile:min-w-11'
  return <section aria-label="待发需求" className="agent-queue-cap relative mx-3 -mb-5 rounded-t-[20px] border border-b-0 border-[var(--border-subtle)] bg-[var(--surface-muted)] pb-5 text-xs text-[var(--text-primary)]">
    <div className="max-h-40 overflow-y-auto overscroll-contain p-1 mobile:max-h-[24dvh]">
      {items.map(item => <div key={item.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
        <div className="flex min-w-0 items-center gap-1 pl-2">
          <ListEnd aria-hidden="true" className="mr-1 h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
          <span className="min-w-0 flex-1 truncate font-medium" title={item.prompt}>{item.prompt}</span>
          {item.attachmentCount > 0 ? <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">{item.attachmentCount} 附件</span> : null}
          <button type="button" disabled={busy} className={actionClass} aria-label="调整方向" title="停止当前任务，然后发送此需求" onClick={() => void act(item, 'steer')}><CornerDownRight className="h-4 w-4" /><span className="ml-1 mobile:hidden">调整方向</span></button>
          <button type="button" disabled={busy} className={actionClass} aria-label="删除待发需求" onClick={() => void act(item, 'delete')}><Trash2 className="h-4 w-4" /></button>
          <button type="button" disabled={busy} className={actionClass} aria-label="更多待发操作" aria-haspopup="menu" aria-expanded={menu?.id === item.id} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            menuTrigger.current = event.currentTarget
            setMenu({ id: item.id, left: Math.max(8, Math.min(rect.right - 208, window.innerWidth - 216)), top: Math.max(8, rect.top - 146) })
          }}><MoreHorizontal className="h-4 w-4" /></button>
        </div>
        {item.error ? <p className="px-3 pb-2 text-[11px] text-amber-600">{item.error}</p> : null}
      </div>)}
    </div>
    {error ? <p role="alert" className="px-3 pb-2 text-rose-600">{error}</p> : null}
    {editing ? <form className="border-t border-[var(--border-subtle)] p-2" onSubmit={event => { event.preventDefault(); void act(editing.item, 'edit', editing.text) }}>
      <textarea autoFocus aria-label="编辑待发需求" maxLength={20000} disabled={busy} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} className="max-h-32 min-h-20 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] p-2 text-sm" onKeyDown={event => { if (event.key === 'Escape' && !busy) setEditing(null) }} />
      <div className="flex justify-end gap-3"><button type="button" disabled={busy} className="min-h-11 px-2" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={busy || !editing.text.trim()} className="min-h-11 px-2 font-medium disabled:opacity-40">保存修改</button></div>
    </form> : null}
    {typeof document !== 'undefined' && createPortal(<StudioPresence kind="menu">{menu && selected ? <div ref={menuRef} role="menu" aria-label="待发操作" style={{ position: 'fixed', left: menu.left, top: menu.top, width: 208 }} className="studio-workspace z-[200] rounded-xl border border-[var(--border-subtle)] studio-popover-glass p-1 text-xs text-[var(--text-primary)] shadow-xl">
      {(['edit', 'new', 'fork'] as const).map(action => <button key={action} type="button" role="menuitem" className="flex min-h-11 w-full items-center rounded-lg px-3 text-left hover:bg-[var(--surface-muted)]" onClick={() => {
        setMenu(null)
        if (action === 'edit') setEditing({ item: selected, text: selected.prompt })
        else void act(selected, action)
      }}>{action === 'edit' ? <Pencil className="mr-2 h-4 w-4 shrink-0" /> : action === 'new' ? <SquarePlus className="mr-2 h-4 w-4 shrink-0" /> : <GitBranch className="mr-2 h-4 w-4 shrink-0" />}{action === 'edit' ? '编辑' : action === 'new' ? '在新任务窗口发送' : '创建分支并发送'}</button>)}
    </div> : null}</StudioPresence>, document.fullscreenElement ?? document.body)}
  </section>
}
