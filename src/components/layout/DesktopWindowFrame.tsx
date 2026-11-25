import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, Minus, Square, X } from 'lucide-react'
import { matchPath, useLocation } from 'react-router-dom'
import { appRoutes } from '@/app/route-config'
import DesktopNavigation from './DesktopNavigation'
import './desktop-window.css'

type CaptionState = { maximized: boolean; fullscreen: boolean }
type WindowAction = 'attach' | 'system' | 'state' | 'drag' | 'minimize' | 'toggleMaximize' | 'close'

async function control(action: WindowAction) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<CaptionState>('desktop_caption', { action })
}

const sections: Record<string, string> = { studio: '创作区', community: '社区', search: '搜索', me: '个人中心', messages: '消息', settings: '设置', novel: '作品', post: '帖子', login: '登录', register: '注册', create: '创作', discover: '发现', rankings: '榜单' }

export default function DesktopWindowFrame({ onContentHost }: { onContentHost?: (host: HTMLDivElement | null) => void }) {
  const { pathname } = useLocation()
  const [state, setState] = useState<CaptionState>()
  const [systemCaption, setSystemCaption] = useState(false)
  const [wide, setWide] = useState(() => window.innerWidth >= 1024)
  const [hasStudioCommands, setHasStudioCommands] = useState(false)
  const frameActive = useRef(false)
  const hasAttached = useRef(false)
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
          if (!wanted) hasAttached.current = true
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
      setWide(window.innerWidth >= 1024)
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => {
        if (applied !== undefined && !switching) void control('state').then(next => { if (!disposed && !switching) setState(next) }).catch(() => {})
      })
    }
    // A top-layer HTML dialog makes controls outside it inert. Return that
    // interval to the system so the user can still move, minimize or close.
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === 'childList' && record.target instanceof Element
        && (record.target.matches('.desktop-commands') || Array.from(record.removedNodes).some(node => node instanceof Element && node.matches('.desktop-commands'))))) {
        setHasStudioCommands(Boolean(document.querySelector('.desktop-commands.studio-workspace > [data-studio-command-bar]')))
      }
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
  // Announcement dialogs belong to the portaled header. Keep its host
  // mounted while Windows temporarily supplies system controls for the modal.
  const keepHost = systemCaption && hasAttached.current && !state?.fullscreen
  if (!visible && !keepHost) return null
  const act = (action: WindowAction) => { void control(action).then(setState).catch(() => {}) }
  const showNavigation = !studio || !wide || !hasStudioCommands
  const maximizeLabel = state?.maximized ? '还原窗口' : '最大化窗口'
  return <>
    {visible && !state?.maximized && <div className="desktop-window-outline" aria-hidden="true" />}
    <div className={keepHost ? 'desktop-system-caption' : 'desktop-caption'} role={visible ? 'region' : undefined} aria-label={visible ? '桌面窗口' : undefined}>
      {showNavigation && <DesktopNavigation />}
      {(!studio || wide) && <div ref={onContentHost} className={studio ? 'desktop-commands studio-workspace' : keepHost ? 'desktop-system-tools' : 'desktop-site-tools'} />}
      <div className="desktop-drag" onMouseDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        act(event.detail === 2 ? 'toggleMaximize' : 'drag')
      }}>{showNavigation && <><ChevronRight aria-hidden="true" /><span>{page}</span></>}</div>
      <div className="desktop-window-controls">
        <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => act('minimize')}><Minus /></button>
        <button type="button" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => act('toggleMaximize')}>{state?.maximized ? <Copy /> : <Square />}</button>
        <button type="button" aria-label="关闭窗口" title="关闭" onClick={() => act('close')}><X /></button>
      </div>
    </div>
  </>
}
