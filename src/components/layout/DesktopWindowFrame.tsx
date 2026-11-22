import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, Compass, Copy, Feather, House, MessageCircle, Minus, Settings, Square, X } from 'lucide-react'
import { Link, NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom'
import { appRoutes } from '@/app/route-config'
import './desktop-window.css'

type CaptionState = { maximized: boolean; fullscreen: boolean }
type WindowAction = 'attach' | 'system' | 'state' | 'drag' | 'minimize' | 'toggleMaximize' | 'close'

async function control(action: WindowAction) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<CaptionState>('desktop_caption', { action })
}

const destinations = [
  { to: '/', name: '首页', icon: House },
  { to: '/discover', name: '发现', icon: Compass },
  { to: '/studio', name: '创作区', icon: Feather },
  { to: '/community', name: '社区', icon: MessageCircle },
  { to: '/settings', name: '设置', icon: Settings },
]
const sections: Record<string, string> = { studio: '创作区', community: '社区', search: '搜索', me: '个人中心', messages: '消息', settings: '设置', novel: '作品', post: '帖子', login: '登录', register: '注册', create: '创作', discover: '发现', rankings: '榜单' }

export default function DesktopWindowFrame({ onCommandsHost }: { onCommandsHost?: (host: HTMLDivElement | null) => void }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [state, setState] = useState<CaptionState>()
  const [systemCaption, setSystemCaption] = useState(false)
  const [wide, setWide] = useState(() => window.innerWidth >= 1280)
  const frameActive = useRef(false)
  const menu = useRef<HTMLDetailsElement>(null)
  const route = pathname.split('/')[1]
  const studio = route === 'studio'
  const page = !route ? '首页' : sections[route] ?? appRoutes.find(item => matchPath(item.path, pathname))?.title ?? '启创墨域'
  useEffect(() => {
    let disposed = false
    let applied: boolean | undefined
    let switching = false
    const hasDialog = () => Boolean(document.querySelector('dialog[open]'))
    async function syncCaption() {
      if (disposed || switching || !frameActive.current) return
      switching = true
      try {
        let wanted = hasDialog()
        while (!disposed && wanted !== applied) {
          const next = await control(wanted ? 'system' : 'attach')
          if (disposed) return
          applied = wanted
          wanted = hasDialog()
          if (wanted === applied) { setSystemCaption(wanted); setState(next) }
        }
      } catch { /* Keep the last acknowledged frame. */ }
      finally { switching = false }
    }
    // No browser or old host loses its system frame if this capability is absent.
    void import('@tauri-apps/api/core').then(async ({ invoke }) => {
      const info = await invoke<{ windowCaption?: number }>('desktop_get_info')
      if (disposed || info.windowCaption !== 1) return
      frameActive.current = true
      await syncCaption()
    }).catch(() => {})
    let pending = 0
    function refresh() {
      setWide(window.innerWidth >= 1280)
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => {
        if (applied !== undefined && !switching) void control('state').then(next => { if (!disposed && !switching) setState(next) }).catch(() => {})
      })
    }
    // A top-layer HTML dialog makes controls outside it inert. Return that
    // interval to the system so the user can still move, minimize or close.
    const observer = new MutationObserver(records => {
      if (frameActive.current && records.some(record => record.target instanceof HTMLDialogElement
        || ((applied || switching) && record.removedNodes.length > 0)
        || Array.from(record.addedNodes).some(node => node instanceof HTMLDialogElement && node.open))) void syncCaption()
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
    window.addEventListener('resize', refresh)
    return () => {
      disposed = true
      frameActive.current = false
      observer.disconnect()
      cancelAnimationFrame(pending)
      window.removeEventListener('resize', refresh)
    }
  }, [])
  const visible = Boolean(state && !state.fullscreen && !systemCaption)
  useEffect(() => {
    if (!visible) return
    document.documentElement.dataset.desktopFrame = studio ? 'studio' : 'site'
    return () => { delete document.documentElement.dataset.desktopFrame }
  }, [visible, studio])
  useEffect(() => {
    if (menu.current) menu.current.open = false
    if (!visible) return
    const outside = (event: PointerEvent) => {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [visible, pathname])
  if (!visible) return null
  const back = Number(window.history.state?.idx) > 0
  const forward = (window as Window & { navigation?: { canGoForward: boolean } }).navigation?.canGoForward === true
  const act = (action: WindowAction) => { void control(action).then(setState).catch(() => {}) }
  const maximizeLabel = state?.maximized ? '还原窗口' : '最大化窗口'
  return <>
    <div className="desktop-caption" role="region" aria-label="桌面窗口">
      <Link to="/" className="desktop-product" title="启创墨域首页"><img src="/favicon-48.png" alt="" width="19" height="19" /><span>启创墨域</span></Link>
      <div className="desktop-history"><button type="button" disabled={!back} aria-label="后退" title="后退" onClick={() => navigate(-1)}><ArrowLeft /></button><button type="button" disabled={!forward} aria-label="前进" title="前进" onClick={() => navigate(1)}><ArrowRight /></button></div>
      <details className="desktop-go" ref={menu} onKeyDown={event => {
        if (event.key === 'Escape' && menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus() }
      }}>
        <summary>前往<ChevronDown aria-hidden="true" /></summary>
        <nav aria-label="前往页面">{destinations.map(({ to, icon: Icon, name }) =>
          <NavLink key={to} to={to} end={to === '/'} onClick={() => { if (menu.current) menu.current.open = false }}><Icon />{name}</NavLink>)}</nav>
      </details>
      {studio && wide && <div ref={onCommandsHost} className="desktop-commands studio-workspace" />}
      <div className="desktop-drag" onMouseDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        act(event.detail === 2 ? 'toggleMaximize' : 'drag')
      }}><ChevronRight aria-hidden="true" /><span>{page}</span></div>
      <div className="desktop-window-controls">
        <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => act('minimize')}><Minus /></button>
        <button type="button" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => act('toggleMaximize')}>{state?.maximized ? <Copy /> : <Square />}</button>
        <button type="button" aria-label="关闭窗口" title="关闭" onClick={() => act('close')}><X /></button>
      </div>
    </div>
    {studio && <nav className="desktop-studio-rail" aria-label="桌面工作区导航">{destinations.map(({ to, icon: Icon, name }) =>
      <NavLink to={to} key={to} end={to === '/'} aria-label={name} title={name}><Icon /></NavLink>)}
      <Link to="/me" aria-label="个人书架" title="个人书架"><BookOpen /></Link>
    </nav>}
  </>
}
