import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Folder, FolderOpen, MessageSquareText, Pin, Plus, type LucideIcon } from 'lucide-react'
import type { AgentSession, Novel } from '../../../../shared/contracts/index.js'
import { cn } from '@/lib/utils'
import { searchAgentSessions } from '../agent/agentApi'
import StudioMobileConversationActions, { type MobileConversationChange } from './StudioMobileConversationActions'

type Action = { key: string; label: string; icon: LucideIcon; action: () => void; danger?: boolean; disabled?: boolean; sectionLabel?: string }
type Props = {
  currentNovel: Novel
  novels: Novel[]
  loading: boolean
  busy: boolean
  view: string
  actions: Action[]
  search: string
  viewerId: string
  recentSessions: AgentSession[]
  onClose: () => void
  onSelectNovel: (id: string) => void
  onSelectSession: (session: AgentSession) => void
  onSessionChange: (change: MobileConversationChange) => void
  onCreateNovel: () => void
}

const match = (value: string, query: string) => value.toLocaleLowerCase().includes(query)
const bookTitle = (novel: Novel) => novel.displayTitle?.trim() || novel.title || '未命名作品'
const rowClass = 'flex min-h-12 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[15px] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]'

type ConversationTarget = { session: AgentSession; trigger: HTMLButtonElement }

function ConversationRow({ item, onSelect, onActions }: {
  item: AgentSession
  onSelect: (item: AgentSession) => void
  onActions?: (target: ConversationTarget) => void
}) {
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  function clearHold() {
    if (hold.current) window.clearTimeout(hold.current.timer)
    hold.current = null
  }
  useEffect(() => () => {
    if (hold.current) window.clearTimeout(hold.current.timer)
  }, [])
  function showActions(trigger: HTMLButtonElement) {
    clearHold()
    suppressClick.current = true
    onActions?.({ session: item, trigger })
  }
  return <button
    type="button"
    aria-haspopup={onActions ? 'dialog' : undefined}
    className={cn(rowClass, onActions && 'touch-pan-y select-none')}
    onClick={event => {
      if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return }
      onSelect(item)
    }}
    onPointerDown={event => {
      if (!onActions || event.button !== 0 || event.isPrimary === false) return
      clearHold()
      suppressClick.current = false
      const trigger = event.currentTarget
      hold.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => showActions(trigger), 500) }
    }}
    onPointerMove={event => {
      const start = hold.current
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearHold()
    }}
    onPointerUp={clearHold}
    onPointerCancel={clearHold}
    onPointerLeave={clearHold}
    onContextMenu={event => {
      if (!onActions) return
      event.preventDefault()
      showActions(event.currentTarget)
    }}
    onKeyDown={event => {
      if (!onActions || (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))) return
      event.preventDefault()
      showActions(event.currentTarget)
    }}
  >
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)]">
      <MessageSquareText aria-hidden="true" className="h-[17px] w-[17px]" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate">{item.title}</span>
      {item.novelTitle && <span className="block truncate text-xs text-[var(--text-secondary)]">{item.novelTitle}</span>}
    </span>
    {item.pinnedAt && <Pin aria-label="已置顶" className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />}
  </button>
}

function ConversationRows({ items, onSelect, onActions }: {
  items: AgentSession[]
  onSelect: (item: AgentSession) => void
  onActions?: (target: ConversationTarget) => void
}) {
  return items.map(item => <ConversationRow key={item.id} item={item} onSelect={onSelect} onActions={onActions} />)
}

function MobileSearchResults({ search, viewerId, books, archivedNovelIds, actions, actionRow, onNovel, onSession }: {
  search: string
  viewerId: string
  books: Novel[]
  archivedNovelIds: Set<string>
  actions: Action[]
  actionRow: (action: Action) => ReactNode
  onNovel: (id: string) => void
  onSession: (session: AgentSession) => void
}) {
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])
  const ready = debounced === search && Boolean(viewerId)
  const query = useQuery({
    queryKey: ['agent', 'sessions', 'studio-mobile-search', viewerId, debounced],
    queryFn: ({ signal }) => searchAgentSessions(debounced, signal),
    enabled: ready,
    staleTime: 10_000,
    gcTime: 60_000,
  })
  const keyword = search.toLocaleLowerCase()
  const foundBooks = books.filter(book => match(bookTitle(book), keyword) || match(book.title, keyword))
  const foundActions = actions.filter(action => match(action.label, keyword) || match(action.sectionLabel ?? '', keyword))
  const foundSessions = ready ? (query.data?.items ?? []).filter(item => item.userId === viewerId && item.status !== 'archived' && !archivedNovelIds.has(item.novelId)) : []
  const pending = Boolean(viewerId) && (!ready || query.isPending)
  return <div className="space-y-3 px-3 pb-4">
    {foundBooks.length > 0 && <section aria-label="匹配作品">
      <h3 className="px-3 py-1 text-xs font-medium text-[var(--text-secondary)]">作品</h3>
      {foundBooks.map(book => <button key={book.id} type="button" className={rowClass} onClick={() => onNovel(book.id)}>
        <Folder aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 truncate">{bookTitle(book)}</span>
      </button>)}
    </section>}
    {foundActions.length > 0 && <section aria-label="匹配功能">
      <h3 className="px-3 py-1 text-xs font-medium text-[var(--text-secondary)]">功能</h3>
      {foundActions.map(actionRow)}
    </section>}
    {foundSessions.length > 0 && <section aria-label="匹配对话">
      <h3 className="px-3 py-1 text-xs font-medium text-[var(--text-secondary)]">对话</h3>
      <ConversationRows items={foundSessions} onSelect={onSession} />
    </section>}
    {pending && <p role="status" className="px-3 py-3 text-xs text-[var(--text-secondary)]">正在搜索对话…</p>}
    {ready && query.isError && <button type="button" className={rowClass} onClick={() => { void query.refetch() }}>对话搜索失败，点击重试</button>}
    {!pending && !query.isError && !foundBooks.length && !foundActions.length && !foundSessions.length
      && <p className="px-3 py-8 text-center text-sm text-[var(--text-secondary)]">没有找到相关作品、对话或功能</p>}
  </div>
}

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
export default function StudioMobileMenu({ currentNovel, novels, loading, busy, view, actions, search, viewerId, recentSessions, onClose, onSelectNovel, onSelectSession, onSessionChange, onCreateNovel }: Props) {
  const [expandedBooks, setExpandedBooks] = useState(() => new Set([currentNovel.id]))
  const [conversationTarget, setConversationTarget] = useState<ConversationTarget | null>(null)
  useEffect(() => { setExpandedBooks(previous => new Set([...previous, currentNovel.id])) }, [currentNovel.id])
  const knownBooks = novels.some(novel => novel.id === currentNovel.id) ? novels : [currentNovel, ...novels]
  const books = knownBooks.filter(novel => novel.status !== 'archived')
  const archivedNovelIds = new Set(knownBooks.filter(novel => novel.status === 'archived').map(novel => novel.id))
  const toggleBook = (id: string) => setExpandedBooks(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const actionRow = ({ key, label, icon: Icon, action, danger, disabled }: Action) => <button key={key} type="button" disabled={disabled} aria-current={view === key ? 'page' : undefined} onClick={() => { onClose(); action() }} className={cn('flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none disabled:opacity-45', view === key && 'bg-[var(--surface-muted)] font-medium', danger ? 'text-[var(--color-error)]' : 'text-[var(--text-primary)]', 'hover:bg-[var(--surface-muted)] active:bg-[var(--surface-muted)]')}><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" /><span className="min-w-0 break-words">{label}</span></button>
  const renderGroup = (group: typeof groups[number]) => <Section key={group.title} title={group.title} initialOpen={'open' in group && group.open}>{actions.filter(action => (group.keys as readonly string[]).includes(action.key)).map(actionRow)}</Section>
  const known = new Set<string>(groups.flatMap(group => [...group.keys]))
  const selectNovel = (id: string) => { onClose(); onSelectNovel(id) }
  const selectSession = (session: AgentSession) => { onClose(); onSelectSession(session) }
  if (search) return <MobileSearchResults
    search={search} viewerId={viewerId} books={books} archivedNovelIds={archivedNovelIds}
    actions={[{ key: 'create-novel', label: '新建作品', icon: Plus, action: onCreateNovel, disabled: busy }, ...actions]}
    actionRow={actionRow} onNovel={selectNovel} onSession={selectSession}
  />

  const recent = recentSessions
    .filter(item => item.userId === viewerId && item.lastRunAt && item.status !== 'archived' && !archivedNovelIds.has(item.novelId))
    .sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '') || a.id.localeCompare(b.id))
    .slice(0, 6)
  return <div className="px-3 pb-4">
    {recent.length > 0 && <section aria-label="最近对话" className="mb-2 border-b border-[var(--border-subtle)] pb-2">
      <h3 className="px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)]">最近对话</h3>
      <ConversationRows items={recent} onSelect={selectSession} onActions={setConversationTarget} />
    </section>}
    <Section title="我的作品" initialOpen>
      {loading && !novels.length ? <p role="status" className="px-3 py-2 text-xs text-[var(--text-tertiary)]">作品加载中…</p> : null}
      {books.map(novel => {
        const title = bookTitle(novel), active = novel.id === currentNovel.id, expanded = expandedBooks.has(novel.id), Icon = expanded ? FolderOpen : Folder
        return <div key={novel.id}>
          <div className={cn('flex items-center rounded-lg', active && 'bg-[var(--surface-muted)]')}>
            <button type="button" aria-label={`选择作品：${title}`} aria-current={active ? 'page' : undefined} onClick={() => { if (active) toggleBook(novel.id); else { onClose(); onSelectNovel(novel.id) } }} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-1 text-left text-[15px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]"><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" /><span className="min-w-0 break-words font-medium">{title}</span></button>
            <button type="button" aria-label={`${expanded ? '收起' : '展开'}作品：${title}`} aria-expanded={expanded} onClick={() => toggleBook(novel.id)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]"><ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform motion-reduce:transition-none', !expanded && '-rotate-90')} /></button>
          </div>
          {expanded ? <div className="ml-5 border-l border-[var(--border-subtle)] pl-2">
            <p className="px-3 py-2 text-[11px] text-[var(--text-tertiary)]">{novel.chapterCount} 章 · {novel.wordCount} 字</p>
            {active ? groups.slice(0, 3).map(renderGroup) : <button type="button" onClick={() => { onClose(); onSelectNovel(novel.id) }} className="min-h-11 w-full rounded-lg px-3 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]">进入作品</button>}
          </div> : null}
        </div>
      })}
    </Section>
    <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">{renderGroup(groups[3])}</div>
    {actions.some(action => !known.has(action.key)) ? <Section title="其他操作">{actions.filter(action => !known.has(action.key)).map(actionRow)}</Section> : null}
    {conversationTarget && <StudioMobileConversationActions
      session={conversationTarget.session}
      trigger={conversationTarget.trigger}
      onChange={onSessionChange}
      onClose={() => setConversationTarget(null)}
    />}
  </div>
}
