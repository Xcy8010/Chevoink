import { useEffect, useId, useRef } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown, Compass, Feather, House, MessageCircle, Settings } from 'lucide-react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAppNavigationType } from '@/app/navigation-type'
import { agentMarkUrl } from '@/lib/brand-assets'

const desktopDestinations = [
  { to: '/', name: '首页', icon: House },
  { to: '/discover', name: '发现', icon: Compass },
  { to: '/studio', name: '创作区', icon: Feather },
  { to: '/community', name: '社区', icon: MessageCircle },
  { to: '/settings', name: '设置', icon: Settings },
]

// A route can replace the entire caption. Keep the observed upper bound for
// this document on browsers without the Navigation API.
const historyTails = new WeakMap<History, number>()

export function DesktopDestinationLinks({ compact = false, onSelect }: {
  compact?: boolean
  onSelect?: () => void
}) {
  const destinations = compact ? desktopDestinations.filter(item => item.to !== '/settings') : desktopDestinations
  return <>{destinations.map(({ to, name, icon: Icon }) =>
    <NavLink key={to} to={to} end={to === '/'} onClick={onSelect}
      className={compact ? 'studio-rail-button' : undefined}
      aria-label={compact ? name : undefined}>
      <Icon />{!compact && name}
    </NavLink>
  )}</>
}

function HistoryButton({ direction, disabled, mac, onClick }: {
  direction: 'back' | 'forward'
  disabled: boolean
  mac: boolean
  onClick: () => void
}) {
  const id = useId()
  const back = direction === 'back'
  const label = back ? '后退' : '前进'
  const key = back ? '[' : ']'
  const Icon = back ? ChevronLeft : ChevronRight
  return <span className="desktop-history-action">
    <button type="button" disabled={disabled} aria-label={label} aria-describedby={id}
      aria-keyshortcuts={`${mac ? 'Meta' : 'Control'}+${key}`} onClick={onClick}><Icon /></button>
    <span className="desktop-history-tip" id={id} role="tooltip">{label} <kbd>{mac ? '⌘' : 'Ctrl+'}{key}</kbd></span>
  </span>
}

export function DesktopHistory({ onDismiss, blocked = false }: { onDismiss?: () => void; blocked?: boolean } = {}) {
  const action = useAppNavigationType()
  const navigate = useNavigate()
  const index = window.history.state?.idx ?? 0
  const lastIndex = action === 'PUSH' ? index : Math.max(index, historyTails.get(window.history) ?? index)
  historyTails.set(window.history, lastIndex)
  const navigation = (window as Window & { navigation?: { canGoForward: boolean } }).navigation
  const back = !blocked && (Boolean(onDismiss) || index > 0)
  const forward = !blocked && !onDismiss && (navigation?.canGoForward ?? index < lastIndex)
  const mac = /Mac/.test(navigator.platform)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return
      if (event.key !== '[' && event.key !== ']') return
      if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, dialog[open]'))) return
      event.preventDefault()
      if (event.key === '[' && back) { if (onDismiss) onDismiss(); else navigate(-1) }
      if (event.key === ']' && forward) navigate(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [back, forward, mac, navigate, onDismiss])

  return (
    <div className="desktop-history">
      <HistoryButton direction="back" disabled={!back} mac={mac} onClick={onDismiss ?? (() => navigate(-1))} />
      <HistoryButton direction="forward" disabled={!forward} mac={mac} onClick={() => navigate(1)} />
    </div>
  )
}

export default function DesktopNavigation() {
  const { pathname } = useLocation()
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (menu.current) menu.current.open = false
    const outside = (event: PointerEvent) => {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [pathname])
  return <>
    <Link to="/" className="desktop-product" title="启创墨域首页"><img src={agentMarkUrl} alt="" width="19" height="19" /><span>启创墨域</span></Link>
    <DesktopHistory />
    <details className="desktop-go" ref={menu} onKeyDown={event => {
      if (event.key === 'Escape' && menu.current) {
        menu.current.open = false
        menu.current.querySelector('summary')?.focus()
      }
    }}>
      <summary>前往<ChevronDown aria-hidden="true" /></summary>
      <nav aria-label="前往页面"><DesktopDestinationLinks onSelect={() => { if (menu.current) menu.current.open = false }} /></nav>
    </details>
  </>
}
