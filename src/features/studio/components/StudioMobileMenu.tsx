import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Plus, type LucideIcon } from 'lucide-react'
import type { Novel } from '../../../../shared/contracts/index.js'
import { cn } from '@/lib/utils'

type Action = { key: string; label: string; icon: LucideIcon; action: () => void; danger?: boolean; disabled?: boolean; sectionLabel?: string }
type Props = { currentNovel: Novel; novels: Novel[]; loading: boolean; busy: boolean; view: string; actions: Action[]; accountCard: ReactNode; onClose: () => void; onSelectNovel: (id: string) => void; onCreateNovel: () => void }

function Section({ title, children, initialOpen = false }: { title: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="studio-mobile-section">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="studio-mobile-section-chevron h-3.5 w-3.5 transition-transform motion-reduce:transition-none" />{title}
    </summary>
    <div className="studio-mobile-section-body space-y-0.5 pb-2">{children}</div>
  </details>
}

const groups = [
  { title: '创作内容', keys: ['assistant', 'editor', 'chapters', 'create-chapter'], open: true },
  { title: '创作资料', keys: ['meta', 'cover', 'memory', 'context', 'skills'] },
  { title: '作品操作', keys: ['publish', 'completion', 'detail', 'import', 'export', 'preview', 'delete-novel'] },
  { title: '创作区', keys: ['studio-settings', 'feedback-suggestion', 'feedback-bug', 'exit'] },
] as const

/** Presentation only: selection and every operation retain the workspace's existing handlers. */
export default function StudioMobileMenu({ currentNovel, novels, loading, busy, view, actions, accountCard, onClose, onSelectNovel, onCreateNovel }: Props) {
  const [expandedBooks, setExpandedBooks] = useState(() => new Set([currentNovel.id]))
  useEffect(() => { setExpandedBooks(previous => new Set([...previous, currentNovel.id])) }, [currentNovel.id])
  const books = novels.some(novel => novel.id === currentNovel.id) ? novels : [currentNovel, ...novels]
  const toggleBook = (id: string) => setExpandedBooks(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const actionRow = ({ key, label, icon: Icon, action, danger, disabled }: Action) => <button key={key} type="button" disabled={disabled} aria-current={view === key ? 'page' : undefined} onClick={() => { onClose(); action() }} className={cn('flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none disabled:opacity-45', view === key && 'bg-[var(--surface-muted)] font-medium', danger ? 'text-[var(--color-error)]' : 'text-[var(--text-primary)]', 'hover:bg-[var(--surface-muted)] active:bg-[var(--surface-muted)]')}><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" /><span className="min-w-0 break-words">{label}</span></button>
  const renderGroup = (group: typeof groups[number]) => <Section key={group.title} title={group.title} initialOpen={'open' in group && group.open}>{actions.filter(action => (group.keys as readonly string[]).includes(action.key)).map(actionRow)}</Section>
  const known = new Set<string>(groups.flatMap(group => [...group.keys]))
  return <div className="px-3 pb-4">
    <button type="button" disabled={busy} onClick={() => { onClose(); onCreateNovel() }} className="mb-2 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] disabled:opacity-45"><Plus aria-hidden="true" className="h-4 w-4" />新建作品</button>
    <Section title="我的作品" initialOpen>
      {loading && !novels.length ? <p role="status" className="px-3 py-2 text-xs text-[var(--text-tertiary)]">作品加载中…</p> : null}
      {books.map(novel => {
        const title = novel.displayTitle?.trim() || novel.title || '未命名作品', active = novel.id === currentNovel.id, expanded = expandedBooks.has(novel.id), Icon = expanded ? FolderOpen : Folder
        return <div key={novel.id}>
          <div className={cn('flex items-center rounded-lg', active && 'bg-[var(--surface-muted)]')}>
            <button type="button" aria-label={`选择作品：${title}`} aria-current={active ? 'page' : undefined} onClick={() => { if (active) toggleBook(novel.id); else { onClose(); onSelectNovel(novel.id) } }} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-1 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]"><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" /><span className="min-w-0 break-words font-medium">{title}</span></button>
            <button type="button" aria-label={`${expanded ? '收起' : '展开'}作品：${title}`} aria-expanded={expanded} onClick={() => toggleBook(novel.id)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]"><ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform motion-reduce:transition-none', !expanded && '-rotate-90')} /></button>
          </div>
          {expanded ? <div className="ml-5 border-l border-[var(--border-subtle)] pl-2">
            <p className="px-3 py-2 text-[11px] text-[var(--text-tertiary)]">{novel.chapterCount} 章 · {novel.wordCount} 字</p>
            {active ? groups.slice(0, 3).map(renderGroup) : <button type="button" onClick={() => { onClose(); onSelectNovel(novel.id) }} className="min-h-11 w-full rounded-lg px-3 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]">进入作品</button>}
          </div> : null}
        </div>
      })}
    </Section>
    <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">{renderGroup(groups[3])}<Section title="账户与用量">{accountCard}</Section></div>
    {actions.some(action => !known.has(action.key)) ? <Section title="其他操作">{actions.filter(action => !known.has(action.key)).map(actionRow)}</Section> : null}
  </div>
}
