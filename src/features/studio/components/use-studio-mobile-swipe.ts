import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { MobileView } from '../types'

type Surface = 'drawer' | 'tabs'
type PrimaryView = 'assistant' | 'editor'

type Swipe = {
  id: number
  x: number
  y: number
  left: number
  width: number
  view: PrimaryView
  drawerOpen: boolean
  reducedMotion: boolean
  surface?: Surface
  extent: number
  originProgress: number
  progress: number
  lastX: number
  lastTime: number
  velocity: number
  targets?: HTMLElement[]
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))
const ignored = 'input:focus, textarea:focus, input[type="range"], select, [contenteditable]:focus-within, pre, [data-studio-ignore-swipe]'
const primary = (view: MobileView): view is PrimaryView => view === 'assistant' || view === 'editor'

export function useStudioMobileSwipe(
  enabled: boolean,
  view: MobileView,
  drawerOpen: boolean,
  onDrawer: (open: boolean) => void,
  onView: (view: PrimaryView) => void,
) {
  const root = useRef<HTMLDivElement>(null)
  const swipe = useRef<Swipe | null>(null)
  const frame = useRef<number>()
  const settle = useRef<number>()
  const [dragging, setDragging] = useState<Surface | null>(null)
  const [keepEditor, setKeepEditor] = useState(false)

  useEffect(() => {
    if (!enabled || !primary(view)) {
      setKeepEditor(false)
      return
    }
    if (view === 'editor' || dragging === 'tabs') {
      setKeepEditor(true)
      return
    }
    if (window.requestIdleCallback) {
      const idle = window.requestIdleCallback(() => setKeepEditor(true))
      return () => window.cancelIdleCallback(idle)
    }
    const timeout = window.setTimeout(() => setKeepEditor(true), 350)
    return () => window.clearTimeout(timeout)
  }, [dragging, enabled, view])

  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    window.clearTimeout(settle.current)
  }, [])

  function paint(element: HTMLDivElement, active: Swipe) {
    if (swipe.current !== active) return
    const drawer = active.surface === 'drawer'
    const targets = active.targets?.length === (drawer ? 2 : 3)
      ? active.targets
      : Array.from(element.querySelectorAll<HTMLElement>(drawer
        ? '.studio-mobile-motion-main, .studio-mobile-push-navigation > .studio-mobile-drawer'
        : '.studio-mobile-tab-page, .studio-mobile-tab-indicator'))
    active.targets = targets
    for (const target of targets) {
      let x: number
      let y = 0
      if (target.classList.contains('studio-mobile-motion-main')) {
        x = active.extent * active.progress
        if (!active.reducedMotion) y = -10 * active.progress
      } else if (target.classList.contains('studio-mobile-drawer')) {
        x = active.extent * (active.progress - 1)
      } else if (target.dataset.page) {
        x = active.extent * ((target.dataset.page === 'editor' ? 1 : 0) - active.progress)
      } else {
        x = 84 * active.progress
      }
      target.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
  }

  function reset(element: HTMLDivElement) {
    const active = swipe.current
    swipe.current = null
    if (!active?.surface) return
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
    element.removeAttribute('data-swipe-dragging')
    for (const target of active.targets ?? []) target.style.removeProperty('transform')
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => element.removeAttribute('data-swipe-moving'), 290)
    setDragging(null)
  }

  function down(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || event.pointerType !== 'touch' || !primary(view)) return
    const element = event.currentTarget
    if (!event.isPrimary) {
      reset(element)
      return
    }
    const target = event.target
    if (!(target instanceof Element) || !element.contains(target) || target.closest(ignored)) return
    const dialog = target.closest('[role="dialog"], dialog[open]')
    if (dialog && dialog.id !== 'studio-mobile-navigation') return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const rect = element.getBoundingClientRect()
    swipe.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, width: rect.width, view, drawerOpen,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      extent: rect.width, originProgress: 0, progress: 0, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0,
    }
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = swipe.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    const element = event.currentTarget
    if (!active.surface) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 9) return
      if (Math.abs(dx) < Math.abs(dy) * 1.25) {
        reset(element)
        return
      }
      const fromLeftQuarter = active.x - active.left < active.width / 4
      if (active.drawerOpen ? dx < 0 : dx > 0 && (active.view === 'assistant' || fromLeftQuarter)) {
        active.surface = 'drawer'
        active.extent = Math.min(360, active.width * .82)
      } else if (!active.drawerOpen && (active.view === 'assistant' ? dx < 0 : dx > 0)) {
        active.surface = 'tabs'
        active.extent = element.querySelector('.studio-mobile-tab-pages')?.clientWidth || active.width
      } else {
        reset(element)
        return
      }
      // A new swipe can take over a panel before its settlement has finished.
      const moving = element.querySelector(active.surface === 'drawer' ? '.studio-mobile-motion-main' : '[data-page="assistant"]')
      const transform = moving ? getComputedStyle(moving).transform : 'none'
      const x = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41
      active.originProgress = clamp((active.surface === 'drawer' ? x : -x) / active.extent)
      // Once the direction owns the gesture, keep receiving events over either pane.
      element.setPointerCapture(event.pointerId)
      window.clearTimeout(settle.current)
      element.setAttribute('data-swipe-moving', active.surface)
      element.setAttribute('data-swipe-dragging', active.surface)
      setDragging(active.surface)
    }
    const deltaTime = event.timeStamp - active.lastTime
    if (deltaTime > 0) {
      active.velocity = (event.clientX - active.lastX) / deltaTime
      active.lastX = event.clientX
      active.lastTime = event.timeStamp
    }
    active.progress = active.surface === 'drawer'
      ? clamp(active.originProgress + dx / active.extent)
      : clamp(active.originProgress - dx / active.extent)
    if (frame.current === undefined) {
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined
        paint(element, active)
      })
    }
  }

  function up(event: PointerEvent<HTMLDivElement>) {
    const active = swipe.current
    if (!active || active.id !== event.pointerId) return
    reset(event.currentTarget)
    if (!active.surface) return
    const velocity = event.timeStamp - active.lastTime < 100 ? active.velocity : 0
    const fling = Math.abs(event.clientX - active.x) >= 30 && Math.abs(velocity) > .45
    if (active.surface === 'drawer') {
      onDrawer(fling ? velocity > 0 : active.progress >= (active.drawerOpen ? .68 : .32))
    } else {
      const editor = fling ? velocity < 0 : active.progress >= (active.view === 'editor' ? .68 : .32)
      const next = editor ? 'editor' : 'assistant'
      if (next !== active.view) onView(next)
    }
  }

  function cancel(event: PointerEvent<HTMLDivElement>) {
    if (swipe.current?.id === event.pointerId) reset(event.currentTarget)
  }

  return {
    root, dragging, showEditor: view === 'editor' || dragging === 'tabs' || keepEditor,
    handlers: {
      onPointerDownCapture: down, onPointerMoveCapture: move, onPointerUpCapture: up,
      onPointerCancelCapture: cancel,
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) cancel(event)
      },
    },
  }
}
