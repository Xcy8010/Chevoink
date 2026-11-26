import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, Minus, Square, X } from 'lucide-react'
import { matchPath, useLocation } from 'react-router-dom'
import { appRoutes } from '@/app/route-config'
import { captionLogoFinished, captionWaitingForLogo } from '@/lib/desktop-caption'
import DesktopNavigation from './DesktopNavigation'
import './desktop-window.css'

type CaptionState = { decorated: boolean; maximized: boolean; fullscreen: boolean }
type WindowAction = 'attach' | 'system' | 'state' | 'drag' | 'minimize' | 'toggleMaximize' | 'close'
const CAPTION_HANDOVER_TIMEOUT_MS = 3000

async function control(action: WindowAction) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<CaptionState>('desktop_caption', { action })
}

const sections: Record<string, string> = { studio: '创作区', community: '社区', search: '搜索', me: '个人中心', messages: '消息', settings: '设置', novel: '作品', post: '帖子', login: '登录', register: '注册', create: '创作', discover: '发现', rankings: '榜单' }

export default function DesktopWindowFrame({ onContentHost }: { onContentHost?: (host: HTMLDivElement | null) => void }) {
  const { pathname } = useLocation()
  const [state, setState] = useState<CaptionState>()
  const [awaitingCaption, setAwaitingCaption] = useState(true)
  const [wide, setWide] = useState(() => window.innerWidth >= 1024)
  const [hasStudioCommands, setHasStudioCommands] = useState(false)
  const frameActive = useRef(false)
  const hasAttached = useRef(false)
  const route = pathname.split('/')[1]
  const studio = route === 'studio'
  const page = !route ? '首页' : sections[route] ?? appRoutes.find(item => matchPath(item.path, pathname))?.title ?? '启创墨域'
  useLayoutEffect(() => {
    const root = document.documentElement
    const hide = () => root.setAttribute('data-desktop-page-leaving', '')
    const show = () => root.removeAttribute('data-desktop-page-leaving')
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    return () => {
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
      show()
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let applied: boolean | undefined
    let switching = false
    let stateRead = 0
    let pending = 0
    let awaitingFirstCaption = true
    let deferredSplash: HTMLElement | null = null
    let logoObserver: MutationObserver | undefined
    const hasDialog = () => Boolean(document.querySelector('dialog[open]:not([data-desktop-notice])'))
    // Older or unresponsive shells must retain access to the local Studio menu.
    let timeout = window.setTimeout(finishHandover, CAPTION_HANDOVER_TIMEOUT_MS)
    function finishHandover() {
      if (disposed || !awaitingFirstCaption) return
      awaitingFirstCaption = false
      window.clearTimeout(timeout)
      setAwaitingCaption(false)
    }
    function acknowledge(next: CaptionState) {
      if (!next.decorated) hasAttached.current = true
      setState(next)
      if (!next.decorated || next.fullscreen || (applied && deferredSplash?.hasAttribute(captionLogoFinished))) finishHandover()
    }
    async function syncCaption() {
      if (disposed || switching || !frameActive.current) return
      if (deferredSplash && !deferredSplash.hasAttribute(captionLogoFinished)) return
      switching = true
      stateRead++
      try {
        let wanted = hasDialog()
        while (!disposed && wanted !== applied) {
          if (awaitingFirstCaption) {
            // A startup dialog deliberately keeps the system caption. Give the
            // custom caption a fresh handover window once the dialog closes.
            window.clearTimeout(timeout)
            if (!wanted) timeout = window.setTimeout(finishHandover, CAPTION_HANDOVER_TIMEOUT_MS)
          }
          const next = await control(wanted ? 'system' : 'attach')
          if (disposed) return
          applied = wanted
          wanted = hasDialog()
          if (wanted === applied) {
            acknowledge(next)
            if (next.decorated !== applied) refresh()
          }
        }
      } catch { finishHandover() }
      finally { switching = false }
    }
    // No browser or old host loses its system frame if this capability is absent.
    void import('@tauri-apps/api/core').then(async ({ invoke }) => {
      const info = await invoke<{ windowCaption?: number }>('desktop_get_info')
      if (disposed) return
      if (info.windowCaption !== 1) { finishHandover(); return }
      const splash = document.getElementById('app-loading')
      const initial = splash ? await control('state').catch(() => null) : null
      if (disposed) return
      frameActive.current = true
      if (awaitingFirstCaption && splash?.isConnected && initial?.decorated && !initial.fullscreen) {
        // Windows moves the old WebView frame before Chromium can repaint it.
        // Keep the native caption until the startup logo has left that frame.
        window.clearTimeout(timeout)
        deferredSplash = splash
        logoObserver = new MutationObserver(() => {
          if (!splash.hasAttribute(captionLogoFinished)) return
          logoObserver?.disconnect()
          void syncCaption()
        })
        logoObserver.observe(splash, { attributes: true, attributeFilter: [captionLogoFinished] })
        splash.setAttribute(captionWaitingForLogo, '')
        return
      }
      await syncCaption()
    }).catch(finishHandover)
    function refresh() {
      setWide(window.innerWidth >= 1024)
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => {
        if (applied === undefined || switching) return
        const read = ++stateRead
        void control('state').then(next => {
          if (!disposed && read === stateRead) acknowledge(next)
        }).catch(() => {})
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
      logoObserver?.disconnect()
      deferredSplash?.removeAttribute(captionWaitingForLogo)
      cancelAnimationFrame(pending)
      window.clearTimeout(timeout)
      window.removeEventListener('resize', refresh)
    }
  }, [])
  const desktopLayout = Boolean(state && !state.fullscreen && hasAttached.current)
  const systemCaption = state?.decorated !== false
  const visible = desktopLayout && !systemCaption
  useLayoutEffect(() => {
    const root = document.documentElement
    root.toggleAttribute('data-desktop-caption-pending', awaitingCaption)
    return () => root.removeAttribute('data-desktop-caption-pending')
  }, [awaitingCaption])
  useLayoutEffect(() => {
    if (!desktopLayout) return
    const root = document.documentElement
    root.dataset.desktopFrame = studio ? 'studio' : 'site'
    root.toggleAttribute('data-system-caption', systemCaption)
    return () => {
      delete root.dataset.desktopFrame
      root.removeAttribute('data-system-caption')
    }
  }, [desktopLayout, studio, systemCaption])
  // Announcement dialogs belong to the portaled header. Keep its host
  // mounted while Windows temporarily supplies system controls for the modal.
  const keepHost = systemCaption && hasAttached.current && !state?.fullscreen
  if (!visible && !keepHost) return null
  const act = (action: WindowAction) => { void control(action).then(({ maximized, fullscreen }) => {
    setState(current => current && { ...current, maximized, fullscreen })
  }).catch(() => {}) }
  const showNavigation = !studio || !wide || !hasStudioCommands
  const maximizeLabel = state?.maximized ? '还原窗口' : '最大化窗口'
  return <>
    {visible && !state?.maximized && <div className="desktop-window-outline" aria-hidden="true" />}
    <div className={keepHost ? 'desktop-caption desktop-system-caption' : 'desktop-caption'} data-window-maximized={state?.maximized || undefined} role={visible ? 'region' : undefined} aria-label={visible ? '桌面窗口' : undefined}>
      {showNavigation && <DesktopNavigation />}
      {(!studio || wide) && <div ref={onContentHost} className={studio ? 'desktop-commands studio-workspace' : 'desktop-site-tools'} />}
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
