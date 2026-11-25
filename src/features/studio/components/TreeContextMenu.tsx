import { StudioPresence } from '@/features/studio/components/StudioPresence'
import { studioInert } from '@/features/studio/components/use-studio-presence'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Ellipsis, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

type TreeMenuAction = { label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean }
export type TreeMenuItem = TreeMenuAction | { label: string; icon: LucideIcon; children: TreeMenuAction[] }
export type TreeMenuAnchor = { x: number; y: number; trigger: HTMLElement }

const cardClass = 'fixed z-[190] overflow-y-auto rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-1 shadow-[0_18px_50px_rgba(15,23,42,.18)]'
const itemClass = 'flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs text-[var(--text-primary)] outline-none transition hover:bg-[var(--surface-muted)] focus:bg-[var(--surface-muted)]'
const viewportPadding = 8

export function TreeMenuButton({ title, expanded, onClick }: { title: string; expanded: boolean; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      data-tree-menu-trigger
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-label={`${title}的更多操作`}
      title="更多操作"
      onClick={onClick}
      className="inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--text-tertiary)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <Ellipsis className="h-3.5 w-3.5" />
    </button>
  )
}

function menuButtons(menu: HTMLDivElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
}

export default function TreeContextMenu({ title, anchor, items, onClose, phase = 'open' }: { phase?: 'open' | 'closing'; title: string; anchor: TreeMenuAnchor; items: TreeMenuItem[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const submenu = useRef<HTMLDivElement>(null)
  const submenuTrigger = useRef<HTMLButtonElement>(null)
  const submenuId = useId()
  const focusSubmenu = useRef(false)
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const branch = items.find((item) => 'children' in item)
  const hasSubmenu = Boolean(branch)

  useLayoutEffect(() => {
    const place = () => {
      if (!menu.current) return
      const width = Math.min(160, (window.innerWidth - viewportPadding * 2) / (hasSubmenu ? 2 : 1))
      const maxHeight = window.innerHeight - viewportPadding * 2
      const rightEdge = window.innerWidth - viewportPadding
      const bottomEdge = window.innerHeight - viewportPadding
      let left = Math.max(viewportPadding, Math.min(anchor.x, rightEdge - width))
      if (hasSubmenu && left + 2 * width > rightEdge && left - width < viewportPadding) {
        left = rightEdge - 2 * width
      }
      Object.assign(menu.current.style, { width: `${width}px`, maxHeight: `${maxHeight}px` })
      const top = Math.max(viewportPadding, Math.min(anchor.y, bottomEdge - menu.current.offsetHeight))
      Object.assign(menu.current.style, { left: `${left}px`, top: `${top}px` })
      if (submenu.current && submenuTrigger.current) {
        const childLeft = left + 2 * width <= rightEdge ? left + width : left - width
        Object.assign(submenu.current.style, { width: `${width}px`, maxHeight: `${maxHeight}px` })
        const childTop = Math.max(viewportPadding, Math.min(submenuTrigger.current.getBoundingClientRect().top, bottomEdge - submenu.current.offsetHeight))
        Object.assign(submenu.current.style, { left: `${childLeft}px`, top: `${childTop}px` })
      }
    }
    place()
    window.addEventListener('resize', place)
    const root = menu.current
    root?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      root?.removeEventListener('scroll', place)
    }
  }, [anchor, hasSubmenu, submenuOpen])

  useLayoutEffect(() => {
    setSubmenuOpen(false)
    menuButtons(menu.current)[0]?.focus()
  }, [anchor])

  useLayoutEffect(() => {
    if (!submenuOpen || !focusSubmenu.current) return
    focusSubmenu.current = false
    menuButtons(submenu.current)[0]?.focus()
  }, [submenuOpen])

  useEffect(() => {
    if (phase === 'closing') return
    function closeOnOutsidePress(event: PointerEvent) {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !submenu.current?.contains(target) && !anchor.trigger.contains(target)) onClose()
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [anchor, onClose, phase])

  function openSubmenuWithFocus() {
    if (submenuOpen) menuButtons(submenu.current)[0]?.focus()
    else {
      focusSubmenu.current = true
      setSubmenuOpen(true)
    }
  }

  function close(restoreFocus: boolean) {
    onClose()
    if (restoreFocus) anchor.trigger.focus({ preventScroll: true })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const inSubmenu = submenu.current?.contains(event.target as Node)
    if (event.key === 'Tab') {
      close(true)
      return
    }
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && inSubmenu)) {
      event.preventDefault()
      event.stopPropagation()
      if (inSubmenu) {
        setSubmenuOpen(false)
        submenuTrigger.current?.focus()
      } else close(true)
      return
    }
    if (event.key === 'ArrowRight' && event.target === submenuTrigger.current) {
      event.preventDefault()
      openSubmenuWithFocus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = menuButtons(inSubmenu ? submenu.current : menu.current)
    const currentIndex = buttons.findIndex((button) => button === event.target)
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    if (!inSubmenu && buttons[nextIndex] !== submenuTrigger.current) setSubmenuOpen(false)
    buttons[nextIndex]?.focus()
  }

  function renderAction(item: TreeMenuAction, insideSubmenu = false) {
    return (
      <button
        key={item.label}
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={cn(itemClass, item.danger && 'text-rose-600')}
        onMouseEnter={insideSubmenu ? undefined : (event) => {
          if (submenu.current?.contains(document.activeElement)) event.currentTarget.focus()
          setSubmenuOpen(false)
        }}
        onClick={() => { close(true); item.onSelect() }}
      >
        <item.icon className={cn('h-3.5 w-3.5 shrink-0', !item.danger && 'text-[var(--text-tertiary)]')} />
        {item.label}
      </button>
    )
  }

  return createPortal(
    <div className="studio-workspace" onKeyDown={handleKeyDown} onContextMenu={(event) => event.preventDefault()}>
      <div data-studio-surface="menu" data-phase={phase} {...studioInert(phase === 'closing')} ref={menu} role="menu" aria-label={`${title}的操作`} className={cardClass}>
        {items.map((item) => 'children' in item ? (
          <button
            key={item.label}
            ref={submenuTrigger}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-haspopup="menu"
            aria-expanded={submenuOpen}
            aria-controls={submenuOpen ? submenuId : undefined}
            className={cn(itemClass, submenuOpen && 'bg-[var(--surface-muted)]')}
            onMouseEnter={() => setSubmenuOpen(true)}
            onClick={openSubmenuWithFocus}
          >
            <item.icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
            {item.label}
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
          </button>
        ) : renderAction(item))}
      </div>
      <StudioPresence kind="menu">{branch && submenuOpen && phase === 'open' ? (
        <div ref={submenu} id={submenuId} role="menu" aria-label={branch.label} className={cardClass}>
          {branch.children.map((item) => renderAction(item, true))}
        </div>
      ) : null}</StudioPresence>
    </div>,
    document.body,
  )
}
