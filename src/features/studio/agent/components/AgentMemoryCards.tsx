import { useStudioPresence, studioInert } from '@/features/studio/components/use-studio-presence'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, ArrowUpRight, BookMarked, BookOpen, ChevronLeft, ChevronRight, Clapperboard,
  Feather, Globe, HeartHandshake, History, Library, LoaderCircle, MapPin, Package, PenLine, PencilLine,
  Quote, Route, ScrollText, Search, ShieldCheck, Telescope, Trash2, UserRound, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { fetchStoryMemories, fetchStoryMemorySets } from '../agentApi'
import { isMemoryAccessError, readMemorySnapshot, refreshMemoryAfterWrite } from '../lib/memory-read'
import MemoryCardEditor, { MemoryCardDeleteDialog } from './MemoryCardEditor'
import { MemoryMarkdown, MemorySnippet } from './MemoryMarkdown'
import { useAgentStore } from '../agentStore'
import { useShellStore } from '@/store/useShellStore'
import type { StoryMemoryCard, StoryMemorySet } from '../../../../../shared/contracts/index.js'
import './memory-catalog.css'

const PAGE_SIZE = 12

const MEMORY_TYPE_META: Record<string, { label: string; icon: LucideIcon }> = {
  novelSummary: { label: '作品概要', icon: BookOpen },
  volumeSummary: { label: '卷摘要', icon: Library },
  chapterSummary: { label: '章节摘要', icon: ScrollText },
  characterCard: { label: '人物', icon: UserRound },
  itemCard: { label: '物品', icon: Package },
  locationCard: { label: '地点', icon: MapPin },
  sceneCard: { label: '场景', icon: Clapperboard },
  relationshipState: { label: '人物关系', icon: HeartHandshake },
  worldbuilding: { label: '世界观', icon: Globe },
  storyBible: { label: '设定集', icon: BookMarked },
  timelineEvent: { label: '时间线', icon: History },
  storyArc: { label: '故事线', icon: Route },
  foreshadowing: { label: '伏笔', icon: Telescope },
  sceneState: { label: '场景状态', icon: Clapperboard },
  continuityRule: { label: '连贯性规则', icon: ShieldCheck },
  stylePreference: { label: '文风偏好', icon: Feather },
  authorProfile: { label: '作者画像', icon: PenLine },
}
const MEMORY_ORDER = new Map(Object.keys(MEMORY_TYPE_META).map((type, index) => [type, index]))

function typeMeta(memoryType: string) {
  return MEMORY_TYPE_META[memoryType] ?? { label: memoryType, icon: BookMarked }
}

function formatMemoryDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

type CatalogLocation = { memoryType: string; card?: StoryMemoryCard }
type CardPage = { items: StoryMemoryCard[]; page: number; total: number; loading: boolean; error: string | null }
const EMPTY_PAGE: CardPage = { items: [], page: 0, total: 0, loading: true, error: null }

type ShelfProps = { novelId: string; sessionId?: string | null; active?: boolean }

export default function AgentMemoryCards(props: ShelfProps) {
  const userId = useShellStore(state => state.sessionUser?.id)
  return <MemoryShelf key={JSON.stringify([userId, props.novelId])} userId={userId} {...props} />
}

function MemoryShelf({ userId, novelId, sessionId, active }: ShelfProps & { userId?: string }) {
  const queryClient = useQueryClient()
  const queryKey = useMemo(() => ['studio', 'memory-sets', userId, novelId], [userId, novelId])
  const { data: snapshot, error: failure, isFetching, isStale, refetch } = useQuery({
    queryKey,
    queryFn: ({ signal }) => readMemorySnapshot(fetchStoryMemorySets(novelId, signal).then(result =>
      [...result.sets].sort((left, right) =>
        (MEMORY_ORDER.get(left.memoryType) ?? MEMORY_ORDER.size) - (MEMORY_ORDER.get(right.memoryType) ?? MEMORY_ORDER.size)),
    )),
    enabled: Boolean(userId && novelId), staleTime: 30_000, retry: false,
  })
  const sets = snapshot?.value
  const error = snapshot?.denied || failure?.message
  const lastTask = useRef({ sessionId, active })
  const [location, setLocation] = useState<CatalogLocation | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const section = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const spotlightNonce = useRef(0)
  const memorySpotlight = useAgentStore(state => state.memorySpotlight)
  const addComposerReference = useAgentStore(state => state.addComposerReference)
  const composerDraft = useAgentStore(state => state.composerDraft)
  const denyCatalog = useCallback((reason: string) => {
    void queryClient.cancelQueries({ queryKey, exact: true })
    queryClient.setQueryData(queryKey, { denied: reason || '当前作品已不可访问。' })
    setLocation(null)
  }, [queryClient, queryKey])

  useEffect(() => {
    if (snapshot?.denied) setLocation(null)
  }, [snapshot?.denied])

  useEffect(() => {
    const previous = lastTask.current
    lastTask.current = { sessionId, active }
    if (!userId) return
    if (previous.sessionId === sessionId && previous.active && !active) void refreshMemoryAfterWrite(queryClient, queryKey)
    else if (previous.sessionId !== sessionId && isStale) void refetch({ cancelRefetch: false })
  }, [sessionId, active, refetch, isStale, userId, queryClient, queryKey])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 4500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!userId || snapshot?.denied || !memorySpotlight || memorySpotlight.nonce === spotlightNonce.current) return
    if (Date.now() - memorySpotlight.nonce > 8000 || !section.current || section.current.offsetParent === null) return
    const { memoryType, title, nonce, memoryId } = memorySpotlight
    let cancelled = false
    const unavailable = () => {
      if (cancelled) return
      spotlightNonce.current = nonce
      setToast('未能唯一定位该记忆，请在创作记忆中查找。')
    }
    if (!memoryId && !title.trim()) unavailable()
    else void fetchStoryMemories(novelId, { memoryType, ...(memoryId ? { memoryId } : { title }), page: 1, pageSize: 2 }).then(result => {
      if (cancelled) return
      if (result.total === 1 && result.items.length === 1 && (!memoryId || result.items[0].id === memoryId)) {
        spotlightNonce.current = nonce
        trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setLocation({ memoryType, card: result.items[0] })
      } else unavailable()
    }).catch((reason: unknown) => {
      if (!cancelled && isMemoryAccessError(reason)) denyCatalog(reason.message)
      else unavailable()
    })
    return () => { cancelled = true }
  }, [memorySpotlight, novelId, userId, snapshot?.denied, denyCatalog])

  const { rendered: visibleLocation, phase } = useStudioPresence(location)
  const open = (memoryType: string, button: HTMLButtonElement) => {
    trigger.current = button
    setLocation({ memoryType })
  }
  const quote = (card: StoryMemoryCard) => {
    addComposerReference({
      id: `memory:${card.id}`, kind: 'memory', name: card.title, startLine: 0, endLine: 0,
      text: card.content.slice(0, 4000), offset: composerDraft.length,
    })
    setLocation(null)
    setToast('已引用到对话')
  }
  const changed = (message: string) => {
    void refetch()
    setToast(message)
  }
  const total = sets?.reduce((sum, set) => sum + set.count, 0) ?? 0
  const countClass = sets && isFetching ? 'studio-metric-updating' : undefined

  return (
    <section ref={section} aria-label="创作记忆" className="memory-shelf">
      <header className="memory-shelf-header">
        <h3><BookMarked aria-hidden="true" size={16} />创作记忆</h3>
        {total > 0 && <span><span className={countClass}>{total}</span> 张</span>}
      </header>
      {!sets && !error ? <div className="studio-pending memory-shelf-index" role="status" aria-label="正在读取创作记忆">
        {Array.from({ length: 6 }, (_, i) => <div className="memory-shelf-tile" key={i} aria-hidden="true">
          <span className="memory-shelf-tile-label"><span className="skeleton-shimmer h-4 w-4 rounded" /><span className="skeleton-shimmer h-3 w-16 rounded" /></span>
          <span className="memory-shelf-tile-caption"><span className="skeleton-shimmer inline-block h-2.5 w-9 rounded" /></span>
        </div>)}
      </div> : !sets ? null
          : sets.length === 0 ? <p className="memory-notice">还没有创作记忆。</p>
            : <div className="memory-shelf-index">
              {sets.map(set => {
                const { label, icon: Icon } = typeMeta(set.memoryType)
                return <button key={set.memoryType} type="button" onClick={event => open(set.memoryType, event.currentTarget)}
                  aria-label={`${label}卡片集 ${set.count} 张`} className="memory-shelf-tile">
                  <span className="memory-shelf-tile-label">
                    <Icon size={16} aria-hidden="true" />
                    <span className="memory-shelf-tile-title">{label}</span>
                    <ArrowUpRight size={15} aria-hidden="true" className="memory-tile-arrow" />
                  </span>
                  <span className="memory-shelf-tile-caption">共 <span className={countClass}>{set.count}</span> 个</span>
                </button>
              })}
            </div>}
      {error && <div className="memory-notice"><p role="alert">{error}</p><button type="button" onClick={() => void refetch()}>重试</button></div>}
      {visibleLocation && sets && <MemoryCatalog phase={phase}
        key={JSON.stringify([visibleLocation.memoryType, visibleLocation.card?.id])}
        novelId={novelId} sets={sets} location={visibleLocation} trigger={trigger.current} feedback={toast}
        onClose={() => setLocation(null)}
        onChanged={changed} onQuote={quote} onDenied={denyCatalog}
      />}
      {!location && <>
        <div role="status" className="sr-only">{toast}</div>
        {toast && createPortal(<div aria-hidden="true" className="studio-workspace memory-feedback">{toast}</div>, document.body)}
      </>}
    </section>
  )
}

type CatalogProps = {
  phase: 'open' | 'closing'
  novelId: string
  sets: StoryMemorySet[]
  location: CatalogLocation
  trigger: HTMLElement | null
  feedback: string | null
  onClose: () => void
  onChanged: (message: string) => void
  onQuote: (card: StoryMemoryCard) => void
  onDenied: (message: string) => void
}

function MemoryCatalog({ phase, novelId, sets, location, trigger, feedback, onClose, onChanged, onQuote, onDenied }: CatalogProps) {
  const navigate = useAgentStore(state => state.requestToolNavigation)
  const { card: startCard } = location
  const [memoryType, setMemoryType] = useState(location.memoryType)
  const { label } = typeMeta(memoryType)
  const [page, setPage] = useState(EMPTY_PAGE)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<StoryMemoryCard | null>(startCard ?? null)
  const [reading, setReading] = useState(Boolean(startCard))
  const [editing, setEditing] = useState<StoryMemoryCard | null>(null)
  const [deleting, setDeleting] = useState<StoryMemoryCard | null>(null)
  const editor = useStudioPresence(editing)
  const deletion = useStudioPresence(deleting)
  const request = useRef({ id: 0 }).current
  const modal = useRef<HTMLDialogElement>(null)
  const catalogHeading = useRef<HTMLHeadingElement>(null)
  const readerHeading = useRef<HTMLHeadingElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const indexScroll = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const shouldMoveFocus = useRef(false)
  const titleId = useId()

  const loadPage = useCallback(async (target: number) => {
    const id = ++request.id
    setPage(current => target === 1 ? EMPTY_PAGE : { ...current, loading: true, error: null })
    try {
      const result = await fetchStoryMemories(novelId, { memoryType, ...(query ? { query } : {}), page: target, pageSize: PAGE_SIZE })
      if (id !== request.id) return
      setPage(current => ({
        items: target === 1 ? result.items : [...current.items, ...result.items.filter(item => !current.items.some(existing => existing.id === item.id))],
        total: result.total, page: target, loading: false, error: null,
      }))
    } catch (reason) {
      if (id !== request.id) return
      if (isMemoryAccessError(reason)) {
        onDenied(reason.message)
        return
      }
      setPage(current => ({ ...current, loading: false, error: reason instanceof Error ? reason.message : '卡片读取失败。' }))
    }
  }, [novelId, memoryType, query, request, onDenied])

  useEffect(() => {
    void loadPage(1)
    return () => { request.id++ }
  }, [loadPage, request])

  useEffect(() => {
    const dialog = modal.current!
    dialog.showModal()
    catalogHeading.current?.focus({ preventScroll: true })
    dialog.querySelector('.memory-categories [aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return () => {
      dialog.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [trigger])

  useEffect(() => {
    if (!shouldMoveFocus.current) return
    shouldMoveFocus.current = false
    if (window.matchMedia?.('(max-width: 767px)').matches) {
      (reading ? readerHeading : listHeading).current?.focus({ preventScroll: true })
    }
  }, [reading])

  const selected = selection ? page.items.find(card => card.id === selection.id) ?? selection : page.items[0]
  const appearances = selected?.appearances ?? []
  const sourceChapter = selected?.sourceChapter ?? (appearances.length === 1 ? appearances[0] : undefined)
  const openChapter = (id: string) => {
    onClose()
    navigate('chapter_read', { chapterId: id })
  }
  const selectedIndex = page.items.findIndex(item => item.id === selected?.id)
  const canLoadMore = page.items.length < page.total
  useEffect(() => {
    if (selectedIndex >= 0 && !window.matchMedia?.('(max-width: 767px)').matches) {
      indexScroll.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [selectedIndex])
  useEffect(() => {
    if (!reading || !canLoadMore || page.loading || page.error || selectedIndex < 0 || selectedIndex < page.items.length - 2) return
    void loadPage(page.page + 1)
  }, [canLoadMore, loadPage, page.error, page.items.length, page.loading, page.page, reading, selectedIndex])
  const select = (card: StoryMemoryCard) => {
    setSelection(card)
    shouldMoveFocus.current = !reading
    setReading(true)
  }
  const back = () => {
    shouldMoveFocus.current = true
    setReading(false)
  }
  const switchCategory = (next: string) => {
    if (next === memoryType) return
    request.id++
    setMemoryType(next)
    setInput('')
    setQuery('')
    setPage(EMPTY_PAGE)
    setSelection(null)
    setReading(false)
    if (indexScroll.current) indexScroll.current.scrollTop = 0
  }
  const step = (direction: number) => {
    if (selectedIndex < 0) return
    const card = page.items[selectedIndex + direction]
    if (card) select(card)
  }
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (query === input.trim()) return
    setSelection(null)
    setQuery(input.trim())
  }
  const clearSearch = () => {
    setInput('')
    searchInput.current?.focus()
    if (!query) return
    setSelection(null)
    setQuery('')
  }
  const onSaved = (updated: StoryMemoryCard) => {
    setPage(current => ({
      ...current, items: current.items.map(item => item.id === updated.id ? updated : item),
    }))
    setSelection(updated)
    setEditing(null)
    onChanged('记忆卡片已保存')
  }
  const onDeleted = () => {
    setDeleting(null)
    setSelection(null)
    back()
    void loadPage(1)
    onChanged('记忆卡片已删除')
  }
  const categories = !sets.some(set => set.memoryType === memoryType)
    ? [{ memoryType, count: page.total }, ...sets] : sets

  return <>
    {createPortal(<dialog data-studio-surface="dialog" data-phase={phase} {...studioInert(phase === 'closing')} ref={modal} aria-labelledby={titleId} data-native-back-dismiss data-reading={reading || undefined}
      className="studio-workspace memory-catalog"
      onCancel={event => {
        event.preventDefault()
        event.stopPropagation()
        if (editing || deleting) return
        if (reading && window.matchMedia?.('(max-width: 767px)').matches) back()
        else onClose()
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); return }
        if (editing || deleting || (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable], .memory-categories, .memory-markdown'))) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          step(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <header className="memory-catalog-header">
        <h2 id={titleId} tabIndex={-1} ref={catalogHeading}>创作记忆</h2>
        <button type="button" onClick={onClose} className="memory-icon" aria-label="关闭创作记忆" title="关闭创作记忆"><X aria-hidden="true" size={20} /></button>
      </header>
      <nav aria-label="记忆分类" className="memory-categories">
        {categories.map(category => {
          return <button key={category.memoryType} type="button" aria-pressed={category.memoryType === memoryType}
            onClick={() => switchCategory(category.memoryType)}>
            {typeMeta(category.memoryType).label}<span>{category.count}</span>
          </button>
        })}
      </nav>
      <div className="memory-catalog-content">
        <aside className="memory-index">
          <form className="memory-search" role="search" onSubmit={search}>
            <input ref={searchInput} aria-label="搜索本分类记忆" placeholder="搜索标题或内容" type="text" maxLength={160}
              value={input} onChange={event => setInput(event.target.value)} />
            {input && <button type="button" className="memory-icon" aria-label="清除搜索" title="清除搜索" onClick={clearSearch}><X size={16} aria-hidden="true" /></button>}
            <button type="submit" className="memory-icon" aria-label="搜索" title="搜索"><Search size={17} aria-hidden="true" /></button>
          </form>
          <h3 ref={listHeading} tabIndex={-1} className="memory-index-heading">{label}<span>{page.loading && page.page === 0 ? '' : `${page.total} 张`}</span></h3>
          <div className="memory-index-scroll" ref={indexScroll}>
            {page.page === 0 && page.loading
              ? <div className="studio-pending memory-notice" role="status"><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />读取记忆…</div>
              : page.items.length === 0 && !page.error && <p className="memory-notice">{query ? '没有找到匹配的记忆。' : '这个分类还没有记忆。'}</p>}
            {page.items.length > 0 && <ul className="memory-card-list">
              {page.items.map(card => <li key={card.id}>
                <button type="button" onClick={() => select(card)} aria-current={selected?.id === card.id || undefined}
                  aria-label={card.title} aria-describedby={`${titleId}-snippet-${card.id}`}>
                  <span className="memory-card-list-title">{card.title}</span>
                  <span id={`${titleId}-snippet-${card.id}`} className="memory-card-list-snippet"><MemorySnippet title={card.title} content={card.content} /></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>)}
            </ul>}
            {page.error && <div className="memory-notice"><p role="alert">{page.error}</p><button type="button" onClick={() => void loadPage(page.page + 1)}>重试</button></div>}
            {canLoadMore && !page.error && <button type="button" className="memory-more" disabled={page.loading}
              onClick={() => void loadPage(page.page + 1)}>{page.loading ? '读取中…' : '加载更多'}</button>}
          </div>
        </aside>
        <div className="memory-reader">
          <button type="button" className="memory-reader-back" onClick={back}><ArrowLeft size={17} aria-hidden="true" />卡片列表</button>
          {selected ? <>
            <article key={selected.id} tabIndex={0} aria-label="卡片正文" className="memory-reader-scroll">
              <div className="memory-note">
                <h3 ref={readerHeading} tabIndex={-1}>{selected.title}</h3>
                <p className="memory-note-date">更新于 {formatMemoryDate(selected.updatedAt)}</p>
                <div className="memory-note-text"><MemoryMarkdown title={selected.title} content={selected.content} /></div>
                {sourceChapter && (appearances.length < 2 || !appearances.some(chapter => chapter.id === sourceChapter.id)) &&
                  <button type="button" className="memory-note-source" onClick={() => openChapter(sourceChapter.id)}>
                    来源章节 · 《{sourceChapter.title}》<ArrowUpRight aria-hidden="true" size={15} />
                  </button>}
                {appearances.length > 1 && <details className="memory-appearances">
                  <summary>出场记录 · {appearances.length} 章</summary>
                  <ul>{appearances.map(chapter => <li key={chapter.id}>
                    <button type="button" className="memory-note-source" onClick={() => openChapter(chapter.id)}>
                      {chapter.title}<ArrowUpRight aria-hidden="true" size={15} />
                    </button>
                  </li>)}</ul>
                </details>}
              </div>
            </article>
            <footer className="memory-reader-actions">
              {(page.items.length > 1 || canLoadMore) && <nav aria-label="卡片切换">
                <button type="button" className="memory-icon" aria-label="上一张" title="上一张"
                  disabled={selectedIndex <= 0} onClick={() => step(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
                <button type="button" className="memory-icon" aria-label="下一张" title="下一张"
                  disabled={selectedIndex < 0 || selectedIndex >= page.items.length - 1} onClick={() => step(1)}><ChevronRight size={18} aria-hidden="true" /></button>
              </nav>}
              <div role="group" aria-label="卡片操作">
                <button type="button" className="memory-icon" aria-label="删除卡片" title="删除卡片" onClick={() => setDeleting(selected)}><Trash2 size={17} aria-hidden="true" /></button>
                <button type="button" className="memory-action" aria-label="引用到对话" title="引用到对话" onClick={() => onQuote(selected)}><Quote size={16} aria-hidden="true" /><span className="memory-quote-label">引用</span></button>
                <button type="button" className="memory-action memory-action-primary" aria-label="编辑卡片" title="编辑卡片" onClick={() => setEditing(selected)}><PencilLine size={16} aria-hidden="true" />编辑</button>
              </div>
            </footer>
          </> : null}
        </div>
      </div>
      <div role="status" className={feedback ? 'memory-catalog-feedback' : 'sr-only'}>{feedback}</div>
    </dialog>, document.body)}
    {editor.rendered && <MemoryCardEditor key={editor.rendered.id} phase={editor.phase} novelId={novelId} card={editor.rendered} onClose={() => setEditing(null)} onSaved={onSaved} />}
    {deletion.rendered && <MemoryCardDeleteDialog key={deletion.rendered.id} phase={deletion.phase} card={deletion.rendered} onClose={() => setDeleting(null)} onDeleted={onDeleted} />}
  </>
}
