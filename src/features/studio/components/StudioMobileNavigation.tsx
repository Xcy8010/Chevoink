import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

type Props = { open: boolean; onClose: () => void; novelSwitcher?: ReactNode; children: ReactNode }
const focusableSelector = 'button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
function availableControl(control: HTMLElement) {
  if (control.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') && !(control.tagName === 'SUMMARY' && control.parentElement === ancestor)) return false
  }
  return true
}

/** Controlled mobile navigation; it never owns workspace, task or editor state. */
export default function StudioMobileNavigation({ open, onClose, novelSwitcher, children }: Props) {
  const [present, setPresent] = useState(open)
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
    const timeout = window.setTimeout(() => setPresent(false), reduced ? 0 : 210)
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
      if (event.shiftKey && (document.activeElement === first || !contains(document.activeElement))) {
        event.preventDefault(); last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (document.activeElement === last || !contains(document.activeElement))) {
        event.preventDefault(); first.focus({ preventScroll: true })
      }
    }
    const resize = () => { if (window.innerWidth >= 1024) closeRef.current() }
    firstControl().focus({ preventScroll: true })
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
      <button type="button" tabIndex={-1} aria-label="关闭导航遮罩" onClick={onClose} className="studio-mobile-backdrop absolute inset-0 h-full w-full bg-black/45" />
      <div ref={panelRef} id="studio-mobile-navigation" role="dialog" aria-modal="true" aria-label="创作区导航" tabIndex={-1} className="studio-mobile-drawer absolute inset-y-0 left-0 flex w-[min(330px,calc(100%_-_44px))] max-w-full flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--app-bg)] pb-[max(12px,var(--safe-bottom,0px))] pl-[var(--safe-left,0px)] pr-[var(--safe-right,0px)] pt-[var(--safe-top,0px)] text-[var(--text-primary)] shadow-xl">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 px-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><img src="/chevoink-agent.png" alt="" className="h-6 w-6 object-contain" />Chevoink</h2>
          <button type="button" aria-label="关闭创作区导航" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none"><X className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [&_button]:min-h-11">
          {novelSwitcher ? <div className="px-4 pb-3">{novelSwitcher}</div> : null}
          {children}
        </div>
      </div>
    </div>, document.body,
  )
}
