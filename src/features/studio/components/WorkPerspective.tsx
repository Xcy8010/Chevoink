import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookCopy, Brain, ChevronLeft, GitCompareArrows, Network, PanelRightClose, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkInspectorTab } from './WorkInspector'
import { FLOATING_DOCK_MIN_CLEARANCE, shouldShowWorkActivityDock } from './work-layout'
import { advanceWorkSplitGesture, fitWorkSplit, resizeWorkSplit, WORK_SPLIT, type WorkSplit, type WorkSplitGesture } from './work-split'
import { WorkConversationContext } from './work-conversation-context'
import { useWorkSplitMotion } from './use-work-split-motion'
import { WORK_OPEN_DOCUMENT } from './work-viewer-events'

type Props = {
  conversationRail: ReactNode; conversation: ReactNode; activityDock?: ReactNode
  inspector: ReactNode; viewer?: ReactNode; viewerIdentity?: string | null; scopeKey?: string
  outerSidebarOpen?: boolean; rightOpen: boolean; inspectorWidth: number; viewerWidth: number
  onToggleRight: () => void; inspectorTab: WorkInspectorTab; onSelectInspectorTab: (tab: WorkInspectorTab) => void
}
const items = [
  { key: 'work' as const, label: '作品', icon: BookCopy }, { key: 'context' as const, label: '记忆', icon: Brain },
  { key: 'changes' as const, label: '变更', icon: GitCompareArrows }, { key: 'memory' as const, label: '关系网', icon: Network }, { key: 'skills' as const, label: '技能', icon: Wrench },
]
const storageKey = 'chevoink:work-split-v2:'
function restoreSplit(scope: string | undefined, fallback: WorkSplit): WorkSplit {
  if (!scope) return fallback
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey + scope) || 'null')
    if (saved && Number.isFinite(saved.viewer) && Number.isFinite(saved.inspector)
      && ['chatCollapsed', 'viewerCollapsed', 'inspectorCollapsed'].every(key => typeof saved[key] === 'boolean')) {
      return { viewer: Math.max(WORK_SPLIT.viewer, Math.min(2000, saved.viewer)), inspector: Math.max(WORK_SPLIT.inspector, Math.min(1000, saved.inspector)), chatCollapsed: saved.chatCollapsed, viewerCollapsed: saved.viewerCollapsed, inspectorCollapsed: saved.inspectorCollapsed }
    }
  } catch { /* Optional preferences. */ }
  return fallback
}
type Gesture = WorkSplitGesture & { pointer: number }

export default function WorkPerspective({ conversationRail, conversation, activityDock, inspector, viewer, scopeKey, outerSidebarOpen = true, rightOpen, inspectorWidth, viewerWidth, onToggleRight, onSelectInspectorTab }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [split, setSplit] = useState<WorkSplit>(() => {
    return restoreSplit(scopeKey, { viewer: viewerWidth, inspector: inspectorWidth === 520 ? 320 : inspectorWidth, chatCollapsed: false, viewerCollapsed: false, inspectorCollapsed: !rightOpen })
  })
  const splitRef = useRef(split)
  splitRef.current = split
  const drag = useRef<Gesture | null>(null)
  const previousScope = useRef(scopeKey)
  const pendingX = useRef<number | null>(null)
  const frame = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [retainedViewer, setRetainedViewer] = useState(viewer)
  const hasViewer = Boolean(viewer)
  const geometry = fitWorkSplit(split, width || 1600, hasViewer)
  const inspectorOpen = !geometry.inspectorCollapsed
  const viewerOpen = hasViewer && !geometry.viewerCollapsed
  const dockVisible = !geometry.chatCollapsed && shouldShowWorkActivityDock({ containerWidth: width, leftWidth: 44, rightWidth: geometry.inspector, hasActivity: Boolean(activityDock), hasViewer: viewerOpen })
  const floatDock = !outerSidebarOpen && dockVisible && width - geometry.inspector >= FLOATING_DOCK_MIN_CLEARANCE
  const motion = useWorkSplitMotion({ rail: geometry.rail, chat: Math.max(0, geometry.chat - (dockVisible && !floatDock ? 296 : 0)), viewer: viewerOpen ? geometry.viewer : 0, inspector: geometry.inspector, dock: dockVisible ? 296 : 0 }, `${geometry.chatCollapsed}:${viewerOpen}:${inspectorOpen}:${dockVisible}:${floatDock}`)
  const update = useCallback((value: WorkSplit) => {
    splitRef.current = value; setSplit(value)
    if (previousScope.current && !drag.current) {
      try { localStorage.setItem(storageKey + previousScope.current, JSON.stringify(value)) } catch { /* Optional preferences. */ }
    }
  }, [])
  const expand = useCallback(() => update({ ...splitRef.current, chatCollapsed: false, viewerCollapsed: true, inspectorCollapsed: true }), [update])
  const context = useMemo(() => ({ collapsed: geometry.chatCollapsed, expand }), [geometry.chatCollapsed, expand])
  useEffect(() => {
    const openDocument = (event: Event) => {
      if (!scopeKey || (event as CustomEvent<{ scope?: string }>).detail?.scope !== scopeKey) return
      if (!splitRef.current.viewerCollapsed && !splitRef.current.inspectorCollapsed) return
      update({ ...splitRef.current, viewerCollapsed: false, inspectorCollapsed: false })
    }
    window.addEventListener(WORK_OPEN_DOCUMENT, openDocument)
    return () => window.removeEventListener(WORK_OPEN_DOCUMENT, openDocument)
  }, [scopeKey, update])
  // Prop changes caused by task hydration are not user open/close commands.
  const inputs = useRef({ scopeKey, rightOpen, hasViewer })
  useEffect(() => {
    const old = inputs.current
    inputs.current = { scopeKey, rightOpen, hasViewer }
    if (old.scopeKey !== scopeKey) return
    if (old.rightOpen !== rightOpen) update({ ...splitRef.current, inspectorCollapsed: !rightOpen, ...(!rightOpen ? { chatCollapsed: false } : {}) })
    if (old.hasViewer !== hasViewer && !hasViewer) update({ ...splitRef.current, chatCollapsed: false })
  }, [scopeKey, rightOpen, hasViewer, update])
  useEffect(() => {
    if (viewer) { setRetainedViewer(viewer); return }
    const timer = window.setTimeout(() => setRetainedViewer(undefined), 240)
    return () => clearTimeout(timer)
  }, [viewer])
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const measure = () => setWidth(node.getBoundingClientRect().width)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  const flush = useCallback(() => {
    const gesture = drag.current
    if (!gesture || pendingX.current === null) return
    update(advanceWorkSplitGesture(gesture, splitRef.current, pendingX.current))
    pendingX.current = null
  }, [update])
  const finish = useCallback(() => {
    if (!drag.current) return
    cancelAnimationFrame(frame.current); frame.current = 0
    flush()
    const gesture = drag.current
    drag.current = null
    if (gesture && root.current?.hasPointerCapture(gesture.pointer)) root.current.releasePointerCapture(gesture.pointer)
    if (gesture) delete document.documentElement.dataset.studioResizing
    setDragging(false)
    if (previousScope.current) {
      try { localStorage.setItem(storageKey + previousScope.current, JSON.stringify(splitRef.current)) } catch { /* Optional preferences. */ }
    }
  }, [flush])
  useLayoutEffect(() => {
    if (previousScope.current === scopeKey) return
    finish()
    previousScope.current = scopeKey
    const value = restoreSplit(scopeKey, { viewer: viewerWidth, inspector: inspectorWidth === 520 ? 320 : inspectorWidth, chatCollapsed: false, viewerCollapsed: false, inspectorCollapsed: !rightOpen })
    splitRef.current = value; setSplit(value)
  }, [scopeKey, rightOpen, viewerWidth, inspectorWidth, finish])
  useEffect(() => {
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('blur', finish)
      cancelAnimationFrame(frame.current)
      if (drag.current) delete document.documentElement.dataset.studioResizing
      drag.current = null
    }
  }, [finish])
  const toggleInspector = () => {
    if (!inspectorOpen) {
      update({ ...splitRef.current, inspectorCollapsed: false, viewerCollapsed: false })
      if (!rightOpen) onToggleRight()
    } else {
      update({ ...splitRef.current, inspectorCollapsed: true, chatCollapsed: false })
      if (rightOpen) onToggleRight()
    }
  }
  const separator = (boundary: 'content' | 'inspector', left: number, label: string) => <div
    role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={Math.round(left)} aria-valuemin={0} aria-valuemax={Math.round(width)} tabIndex={0}
    className="work-split-handle absolute inset-y-0 z-50 w-2 -translate-x-1/2 cursor-col-resize touch-none hover:bg-[var(--border-strong)] focus-visible:bg-[var(--border-strong)] focus-visible:outline-none" style={{ left: Math.max(4, Math.min((width || 1600) - 4, left)) }}
    onPointerDown={event => {
      if (event.button !== 0 || !root.current) return
      event.preventDefault()
      const bounds = root.current.getBoundingClientRect()
      const measured = bounds.width
      const start = fitWorkSplit(splitRef.current, measured, hasViewer)
      // Start from actual on-screen geometry, even in the middle of an animation.
      const viewerNode = root.current.querySelector<HTMLElement>('[data-studio-panel="workViewer"]')
      const inspectorNode = root.current.querySelector<HTMLElement>('[data-studio-panel="workInspector"]')
      if (viewerNode && !start.viewerCollapsed) start.viewer = viewerNode.getBoundingClientRect().width
      if (inspectorNode && !start.inspectorCollapsed) start.inspector = inspectorNode.getBoundingClientRect().width
      start.chat = start.chatCollapsed ? 0 : measured - start.rail - start.viewer - start.inspector
      drag.current = { x: event.clientX, left: bounds.left, start, width: measured, boundary, pointer: event.pointerId, hasViewer }
      root.current.setPointerCapture(event.pointerId)
      document.documentElement.dataset.studioResizing = 'true'
      setDragging(true)
    }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Home') update({ ...split, ...(boundary === 'content' ? { chatCollapsed: true } : { inspectorCollapsed: true, chatCollapsed: false }) })
      else if (event.key === 'End') {
        if (boundary === 'content') expand()
        else update({ ...split, inspectorCollapsed: false })
      }
      else update(resizeWorkSplit(geometry, split, width, event.key === 'ArrowLeft' ? -32 : 32, boundary, hasViewer))
    }}
  />
  return <WorkConversationContext.Provider value={context}><div ref={root} data-studio-layout="work" data-activity-dock={dockVisible ? 'visible' : 'hidden'} data-chat-collapsed={geometry.chatCollapsed} data-dragging={dragging} className="work-perspective relative flex h-full min-h-0 overflow-hidden bg-[var(--surface-default)]"
    onPointerMove={event => {
      if (!drag.current || drag.current.pointer !== event.pointerId) return
      pendingX.current = event.clientX
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; flush() })
    }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { if (drag.current) finish() }}>
    <aside className="work-split-column h-full shrink-0 overflow-hidden" style={{ width: motion.rail }} aria-hidden={geometry.chatCollapsed} {...(geometry.chatCollapsed ? { inert: '' } : {})}>{conversationRail}</aside>
    <main data-work-conversation className="work-split-column min-w-0 bg-[var(--surface-default)]" style={{ flex: `0 0 ${motion.chat}px` }}>{conversation}</main>
    <aside aria-hidden={!dockVisible} {...(!dockVisible ? { inert: '' } : {})} className={cn('work-activity-dock h-full min-h-0 shrink-0 overflow-hidden', dockVisible ? 'is-visible' : '', floatDock && 'absolute top-0 z-40')} style={{ width: motion.dock, ...(floatDock ? { right: motion.inspector } : {}) }}><div className="h-full w-[296px] px-3 py-4">{activityDock}</div></aside>
    <section data-studio-panel="workViewer" aria-hidden={!viewerOpen} {...(!viewerOpen ? { inert: '' } : {})} className="work-split-column h-full min-h-0 shrink-0 overflow-hidden border-[var(--border-subtle)]" style={{ width: motion.viewer, borderLeftWidth: motion.viewer > 0 ? 1 : 0 }}><div className="h-full" style={{ minWidth: WORK_SPLIT.viewer }}>{retainedViewer}</div></section>
    <aside data-studio-panel="workInspector" className="work-split-column work-inspector-column relative ml-auto h-full min-h-0 shrink-0 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--app-bg)]" style={{ width: motion.inspector }}>
      <div aria-hidden={!inspectorOpen} {...(!inspectorOpen ? { inert: '' } : {})} className={cn('absolute inset-0 overflow-hidden transition-opacity duration-200', inspectorOpen ? 'opacity-100' : 'pointer-events-none opacity-0')}>{inspector}</div>
      {!inspectorOpen ? <div className="absolute inset-0 flex flex-col items-center py-2"><button type="button" onClick={toggleInspector} className="flex h-9 w-9 items-center justify-center" aria-label="展开检查区"><ChevronLeft className="h-4 w-4" /></button>{items.map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-label={label} title={label} className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[var(--surface-muted)]" onClick={() => { onSelectInspectorTab(key); toggleInspector() }}><Icon className="h-4 w-4" /></button>)}</div> : <button type="button" onClick={toggleInspector} className="absolute left-1 top-2 z-20 rounded p-1.5 text-[var(--text-secondary)]" aria-label="收起检查区"><PanelRightClose className="h-4 w-4" /></button>}
    </aside>
    {separator('content', width - motion.viewer - motion.inspector, hasViewer ? '调整查看器与对话宽度' : '调整对话宽度')}
    {viewerOpen ? separator('inspector', width - motion.inspector, '调整检查区宽度') : null}
  </div></WorkConversationContext.Provider>
}
