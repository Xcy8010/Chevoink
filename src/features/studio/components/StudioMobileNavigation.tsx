import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CirclePlus, Search, Settings, X } from 'lucide-react'
import AnnouncementBell from '@/features/site-content/AnnouncementBell'

type Props = {
  open: boolean
  onClose: () => void
  onCreateNovel: () => void
  creatingNovel?: boolean
  onOpenSettings: () => void
  accountCard: ReactNode
  novelSwitcher?: ReactNode
  children: (search: string) => ReactNode
}

const iconButton = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-primary)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] disabled:opacity-45'
const focusableSelector = ':is(button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]))'
function availableControl(control: HTMLElement) {
  if (control.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') && !(control.tagName === 'SUMMARY' && control.parentElement === ancestor)) return false
  }
  return true
}

/** Controlled mobile navigation; it never owns workspace, task or editor state. */
export default function StudioMobileNavigation({ open, onClose, onCreateNovel, creatingNovel, onOpenSettings, accountCard, novelSwitcher, children }: Props) {
  const [present, setPresent] = useState(open)
  const [search, setSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  // React 18 does not serialize the boolean inert attribute. Keep the closing
  // animation visible while immediately removing its controls from interaction.
  const navigationRef = useCallback((node: HTMLDivElement | null) => {
    node?.toggleAttribute('inert', !open)
  }, [open])
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (open) { setPresent(true); return }
    if (!present) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const timeout = window.setTimeout(() => {
      setPresent(false)
      setSearch('')
      setComposing(false)
    }, reduced ? 0 : 210)
    return () => window.clearTimeout(timeout)
  }, [open, present])
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current!
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const firstControl = () => panel.querySelector<HTMLElement>(focusableSelector) ?? panel
    // WorkspaceNovelSwitcher keeps its existing body portal. Keep it usable inside this modal.
    const novelMenu = () => document.querySelector<HTMLElement>('[role="region"][aria-label="我的作品"]')
    // This existing account-card dialog is above navigation (z260); unrelated portals stay outside.
    const inviteDialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="invite-credits-title"]')
    const contains = (target: Node | null) => inviteDialog()
      ? Boolean(inviteDialog()?.contains(target))
      : panel.contains(target) || Boolean(novelMenu()?.contains(target))
    const focusInside = (event: FocusEvent) => {
      if (!contains(event.target as Node)) (inviteDialog()?.querySelector<HTMLElement>(focusableSelector) ?? firstControl()).focus({ preventScroll: true })
    }
    const keydown = (event: KeyboardEvent) => {
      if (panel.querySelector('dialog[open]')) return
      if (event.key === 'Escape') {
        // The switcher's own Escape handler dismisses its nested menu first.
        if (novelMenu() || inviteDialog()) return
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
      }
      if (event.key !== 'Tab') return
      const controls = Array.from((inviteDialog() ?? panel).querySelectorAll<HTMLElement>(focusableSelector)).filter(availableControl)
      if (!inviteDialog()) controls.push(...Array.from(novelMenu()?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(availableControl))
      const first = controls[0] ?? panel
      const last = controls[controls.length - 1] ?? panel
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel || !contains(document.activeElement))) {
        event.preventDefault(); last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (document.activeElement === last || !contains(document.activeElement))) {
        event.preventDefault(); first.focus({ preventScroll: true })
      }
    }
    const resize = () => { if (window.innerWidth >= 1024) closeRef.current() }
    panel.focus({ preventScroll: true })
    document.addEventListener('focusin', focusInside)
    document.addEventListener('keydown', keydown)
    window.addEventListener('resize', resize)
    resize()
    return () => {
      document.removeEventListener('focusin', focusInside)
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', resize)
      document.body.style.overflow = previousOverflow
      const returnFocus = previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLElement>('[data-studio-mobile-primary-control]')
      returnFocus?.focus({ preventScroll: true })
    }
  }, [open])

  if (!open && !present) return null
  return createPortal(
    <div ref={navigationRef} data-state={open ? 'open' : 'closed'} aria-hidden={!open || undefined} className={`studio-workspace studio-mobile-navigation fixed inset-0 z-[100] lg:hidden ${!open ? 'pointer-events-none' : ''}`}>
      <button type="button" tabIndex={-1} aria-label="关闭导航遮罩" onClick={onClose} className="studio-mobile-backdrop absolute inset-0 h-full w-full bg-black/55" />
      <div ref={panelRef} id="studio-mobile-navigation" role="dialog" aria-modal="true" aria-label="创作区导航" tabIndex={-1} className="studio-mobile-drawer absolute inset-y-0 left-0 flex w-[min(360px,82%)] max-w-full flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--app-bg)] pl-[var(--safe-left,0px)] pt-[var(--safe-top,0px)] text-[var(--text-primary)] shadow-xl outline-none">
        <header className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-2">
          <div className="studio-mobile-drawer-search flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[14px] pl-3 pr-1 focus-within:outline focus-within:outline-1 focus-within:outline-[var(--border-strong)]">
            <Search aria-hidden="true" className="h-[19px] w-[19px] shrink-0" />
            <input
              ref={searchRef}
              type="search"
              aria-label="搜索作品、对话和功能"
              placeholder="搜索"
              autoComplete="off"
              maxLength={120}
              value={search}
              onChange={event => setSearch(event.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={event => { setSearch(event.currentTarget.value); setComposing(false) }}
              onKeyDown={event => {
                if (event.key === 'Escape' && search) { event.stopPropagation(); setSearch('') }
              }}
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[var(--text-tertiary)] [&::-webkit-search-cancel-button]:hidden"
            />
            {search && <button type="button" aria-label="清空搜索" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)]" onClick={() => { setSearch(''); searchRef.current?.focus() }}>
              <X aria-hidden="true" className="h-4 w-4" />
            </button>}
          </div>
          <button type="button" aria-label="新建作品" title="新建作品" className={iconButton} disabled={creatingNovel} onClick={() => { onClose(); onCreateNovel() }}>
            <CirclePlus aria-hidden="true" className="h-[25px] w-[25px]" />
          </button>
        </header>
        <div data-studio-mobile-navigation-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain [&_button]:min-h-11">
          {!search.trim() && novelSwitcher ? <div className="px-3 pb-3">{novelSwitcher}</div> : null}
          {children(composing ? '' : search.trim())}
        </div>
        <footer className="relative flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] bg-[var(--app-bg)] px-3 pt-2 pb-[max(8px,var(--safe-bottom,0px))]">
          {accountCard}
          <div className="ml-auto flex shrink-0 items-center">
            <AnnouncementBell placement="studio-mobile" />
            <button type="button" aria-label="创作区设置" title="创作区设置" className={iconButton} onClick={() => { onClose(); onOpenSettings() }}>
              <Settings aria-hidden="true" className="h-[21px] w-[21px]" />
            </button>
          </div>
        </footer>
      </div>
    </div>, document.body,
  )
}
