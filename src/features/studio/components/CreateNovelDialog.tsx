import { BookOpenText, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  open: boolean
  busy: boolean
  onCancel: () => void
  onCreate: (title: string) => void
}

export default function CreateNovelDialog({ open, busy, onCancel, onCreate }: Props) {
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (open) setTitle('')
  }, [open])

  if (!open) return null
  const normalizedTitle = title.trim()

  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[175] flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]" onMouseDown={() => { if (!busy) onCancel() }}>
      <form className="w-full max-w-md rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-[0_26px_80px_rgba(15,23,42,.24)] motion-safe:animate-[agent-menu-in_160ms_cubic-bezier(.22,1,.36,1)]" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onCreate(normalizedTitle) }}>
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[var(--surface-muted)]"><BookOpenText className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">新建作品</h2><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">作品会拥有独立的任务、对话与创作内容，之后仍可随时重命名。</p></div>
          <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-tertiary)] hover:bg-[var(--surface-muted)] disabled:opacity-40" aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>
        <label className="mt-5 block text-xs font-medium">作品名称<input autoFocus maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：雾港来信（可暂不命名）" className="mt-2 h-11 w-full rounded-[11px] border border-[var(--border-subtle)] bg-transparent px-3 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] focus:shadow-[0_0_0_3px_rgba(15,23,42,.05)]" /></label>
        <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">留空将创建“未命名作品”，有对话或任务后也会一直保留。</p>
        <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onCancel} disabled={busy} className="h-9 rounded-[9px] px-3 text-xs hover:bg-[var(--surface-muted)] disabled:opacity-40">取消</button><button type="submit" disabled={busy} className="h-9 rounded-[9px] bg-[var(--surface-contrast)] px-4 text-xs font-medium text-[var(--text-contrast)] transition-opacity hover:opacity-90 disabled:opacity-45">{busy ? '正在创建…' : '创建作品'}</button></div>
      </form>
    </div>,
    document.body,
  )
}
