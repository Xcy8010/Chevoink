import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { MobileView } from '../types'

type Surface = 'drawer' | 'tabs'
type PrimaryView = 'assistant' | 'editor'

type Swipe = {
  id: number
  x: number
  y: number
  width: number
  view: PrimaryView
  drawerOpen: boolean
  surface?: Surface
  extent: number
  originProgress: number
  progress: number
  lastX: number
  lastTime: number
  velocity: number
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
    const timeout = window.setTimeout(() => setKeepEditor(false), 290)
    return () => window.clearTimeout(timeout)
  }, [dragging, enabled, view])

  function reset(element: HTMLDivElement) {
    const surface = swipe.current?.surface
    swipe.current = null
    if (!surface) return
    element.removeAttribute('data-swipe-dragging')
    element.style.removeProperty('--studio-mobile-'+surface+'-progress')
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
      id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, view, drawerOpen,
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
      const fromLeftQuarter = active.x - element.getBoundingClientRect().left < active.width / 4
      if (active.drawerOpen ? dx < 0 : dx > 0 && (active.view === 'assistant' || fromLeftQuarter)) {
        active.surface = 'drawer'
        active.extent = Math.min(360, active.width * .82)
      } else if (!active.drawerOpen && (active.view === 'assistant' ? dx < 0 : dx > 0)) {
        active.surface = 'tabs'
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
    element.style.setProperty('--studio-mobile-'+active.surface+'-progress', String(active.progress))
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
