import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown, Compass, Feather, House, MessageCircle, Settings } from 'lucide-react'
import { Link, NavLink, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
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

export function DesktopHistory() {
  const action = useNavigationType()
  const navigate = useNavigate()
  const index = window.history.state?.idx ?? 0
  const lastIndex = action === 'PUSH' ? index : Math.max(index, historyTails.get(window.history) ?? index)
  historyTails.set(window.history, lastIndex)
  const navigation = (window as Window & { navigation?: { canGoForward: boolean } }).navigation
  const forward = navigation?.canGoForward ?? index < lastIndex
  return (
    <div className="desktop-history">
      <button type="button" disabled={index < 1} aria-label="后退" title="后退" onClick={() => navigate(-1)}><ChevronLeft /></button>
      <button type="button" disabled={!forward} aria-label="前进" title="前进" onClick={() => navigate(1)}><ChevronRight /></button>
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
