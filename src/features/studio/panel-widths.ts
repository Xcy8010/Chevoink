import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * 三区布局（章节树 / 内容区 / Agent 对话区）拖拽调宽的共享实现：
 * 创作中心与沉浸区共用同一份宽度限制、localStorage 持久化与指针拖拽逻辑。
 */

const STUDIO_PANEL_WIDTHS_STORAGE_KEY = 'studio-panel-widths'

const LEGACY_TREE_PANEL_FALLBACK = 264
// Preserve the editor's 520px center while accounting for its shared 52px activity rail.
export const EDITOR_CENTER_RESERVE = 520 + 52 - 46
export const TREE_PANEL_WIDTH_LIMITS = { min: 240, fallback: 420 }
export const AGENT_PANEL_WIDTH_LIMITS = { min: 400, fallback: 440 }
export const WORK_TASK_PANEL_WIDTH_LIMITS = { min: 200, fallback: 232 }
export const WORK_INSPECTOR_PANEL_WIDTH_LIMITS = { min: 260, fallback: 520 }
export const WORK_VIEWER_PANEL_WIDTH_LIMITS = { min: 320, fallback: 900 }
/** Work 模式的 Agent 对话列必须始终可完成阅读、输入和工具确认。 */
export const WORK_CONVERSATION_WIDTH_LIMITS = { expanded: 420, collapsedMin: 360 }

export type StudioPanelWidths = { tree: number; agent: number; workTask: number; workInspector: number; workViewer: number }
export type ResizablePanel = keyof StudioPanelWidths

type PanelResizeOptions = {
  onCollapse?: (panel: ResizablePanel) => void
  /** 按当前布局实时计算该面板最多能占多少宽度，必须为中间工作区保留可用空间。 */
  getMaximum?: (panel: ResizablePanel, widths: StudioPanelWidths) => number
}

const PANEL_LIMITS = {
  tree: TREE_PANEL_WIDTH_LIMITS,
  agent: AGENT_PANEL_WIDTH_LIMITS,
  workTask: WORK_TASK_PANEL_WIDTH_LIMITS,
  workInspector: WORK_INSPECTOR_PANEL_WIDTH_LIMITS,
  workViewer: WORK_VIEWER_PANEL_WIDTH_LIMITS,
} satisfies Record<ResizablePanel, { min: number; fallback: number }>

function viewportMaximum(): number {
  return typeof window === 'undefined' ? 1920 : Math.max(420, window.innerWidth - 320)
}

function clampPanelWidth(value: number, limits: { min: number }, maximum = viewportMaximum()): number {
  return Math.min(Math.max(limits.min, maximum), Math.max(limits.min, Math.round(value)))
}

/**
 * 相邻面板共享固定总宽度时，把主面板的拖拽增量从相邻面板中等量取回。
 * 这用于 Work 模式的「查看器 + 右侧栏」边界，避免查看器占满可用空间后
 * 右侧栏只能缩小、无法继续向左放大。
 */
export function resizeLinkedPanels({
  requestedPrimaryWidth,
  primaryStartWidth,
  linkedStartWidth,
  primaryMin,
  linkedMin,
}: {
  requestedPrimaryWidth: number
  primaryStartWidth: number
  linkedStartWidth: number
  primaryMin: number
  linkedMin: number
}): { primaryWidth: number; linkedWidth: number; collapseLinked: boolean } {
  const totalWidth = Math.max(primaryMin + linkedMin, Math.round(primaryStartWidth + linkedStartWidth))
  const collapseLinked = totalWidth - requestedPrimaryWidth <= Math.round(linkedMin * 0.62)
  const primaryWidth = Math.min(
    totalWidth - linkedMin,
    Math.max(primaryMin, Math.round(requestedPrimaryWidth)),
  )
  return { primaryWidth, linkedWidth: totalWidth - primaryWidth, collapseLinked }
}

function readStoredPanelWidths(): StudioPanelWidths {
  const fallback: StudioPanelWidths = {
    tree: TREE_PANEL_WIDTH_LIMITS.fallback,
    agent: AGENT_PANEL_WIDTH_LIMITS.fallback,
    workTask: WORK_TASK_PANEL_WIDTH_LIMITS.fallback,
    workInspector: WORK_INSPECTOR_PANEL_WIDTH_LIMITS.fallback,
    workViewer: WORK_VIEWER_PANEL_WIDTH_LIMITS.fallback,
  }

  if (typeof window === 'undefined') {
    return fallback
  }

  try {
    const raw = window.localStorage.getItem(STUDIO_PANEL_WIDTHS_STORAGE_KEY)
    if (!raw) {
      return fallback
    }
    const parsed = JSON.parse(raw) as Partial<StudioPanelWidths>
    return {
      // 2.0 旧默认 264px 对卷→章的层级树过窄；只迁移精确旧默认，保留用户主动拖拽的宽度。
      tree: clampPanelWidth(
        Number(parsed.tree) === LEGACY_TREE_PANEL_FALLBACK ? fallback.tree : Number(parsed.tree) || fallback.tree,
        TREE_PANEL_WIDTH_LIMITS,
      ),
      agent: clampPanelWidth(Number(parsed.agent) || fallback.agent, AGENT_PANEL_WIDTH_LIMITS),
      workTask: clampPanelWidth(Number(parsed.workTask) || fallback.workTask, WORK_TASK_PANEL_WIDTH_LIMITS),
      workInspector: clampPanelWidth(
        Number(parsed.workInspector) >= 360 ? Number(parsed.workInspector) : fallback.workInspector,
        WORK_INSPECTOR_PANEL_WIDTH_LIMITS,
      ),
      // 2.0 旧默认只有 420px，会把四区布局挤成“小预览”。低于可用阅读宽度的旧值
      // 自动升级到新版比例；用户后续主动拖拽的新值仍会正常持久化。
      workViewer: clampPanelWidth(
        Number(parsed.workViewer) >= 520 ? Number(parsed.workViewer) : fallback.workViewer,
        WORK_VIEWER_PANEL_WIDTH_LIMITS,
      ),
    }
  } catch {
    return fallback
  }
}

export function readInitialEditorColumns() {
  const widths = readStoredPanelWidths()
  const viewport = typeof window === 'undefined' ? 1920 : window.innerWidth
  const available = viewport - EDITOR_CENTER_RESERVE
  const tree = clampPanelWidth(widths.tree, TREE_PANEL_WIDTH_LIMITS, available - widths.agent)
  const agent = clampPanelWidth(widths.agent, AGENT_PANEL_WIDTH_LIMITS, available - tree)
  return `${tree - 46}px minmax(0,1fr) ${agent}px`
}

function storePanelWidths(widths: StudioPanelWidths) {
  try {
    window.localStorage.setItem(STUDIO_PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(widths))
  } catch {
    // 存储不可用时忽略，仅影响下次打开的默认宽度
  }
}

export function useStudioPanelWidths(options: PanelResizeOptions = {}) {
  const [panelWidths, setPanelWidths] = useState<StudioPanelWidths>(readStoredPanelWidths)
  const panelWidthsRef = useRef(panelWidths)
  const optionsRef = useRef(options)
  panelWidthsRef.current = panelWidths
  optionsRef.current = options

  const normalizeForViewport = useCallback(() => {
    setPanelWidths((current) => {
      let next = current
      // 多跑两轮，让彼此依赖的面板上限稳定收敛，旧版存下的超宽值也不会挤出屏幕。
      for (let pass = 0; pass < 2; pass += 1) {
        for (const panel of Object.keys(PANEL_LIMITS) as ResizablePanel[]) {
          const limits = PANEL_LIMITS[panel]
          const maximum = optionsRef.current.getMaximum?.(panel, next) ?? viewportMaximum()
          const width = clampPanelWidth(next[panel], limits, maximum)
          if (width !== next[panel]) next = { ...next, [panel]: width }
        }
      }
      if (next !== current) {
        panelWidthsRef.current = next
        storePanelWidths(next)
      }
      return next
    })
  }, [])

  useEffect(() => {
    normalizeForViewport()
    window.addEventListener('resize', normalizeForViewport)
    return () => window.removeEventListener('resize', normalizeForViewport)
  }, [normalizeForViewport, options.getMaximum])

  // 拖拽调宽：触达折叠阈值即刻收起，不再要求用户松开鼠标后才看到结果。
  const beginPanelResize = useCallback(
    (panel: ResizablePanel, event: ReactPointerEvent<HTMLDivElement>, linkedPanel?: ResizablePanel) => {
      event.preventDefault()
      const handle = event.currentTarget
      const startX = event.clientX
      // 某些组合布局会按视口比例收敛默认宽度；拖拽必须从用户眼前的实际宽度起步，
      // 不能从尚未收敛的持久化值起步，否则第一像素移动就会发生面板跳变。
      const renderedWidth = handle.parentElement?.getBoundingClientRect().width
      const startWidth = renderedWidth && renderedWidth > 0 ? renderedWidth : panelWidthsRef.current[panel]
      const limits = PANEL_LIMITS[panel]
      const layout = handle.closest<HTMLElement>('[data-studio-layout]')
      const linkedElement = linkedPanel
        ? layout?.querySelector<HTMLElement>(`[data-studio-panel="${linkedPanel}"]`)
        : null
      const renderedLinkedWidth = linkedElement?.getBoundingClientRect().width
      const startLinkedWidth = linkedPanel
        ? renderedLinkedWidth && renderedLinkedWidth > 0
          ? renderedLinkedWidth
          : panelWidthsRef.current[linkedPanel]
        : null
      handle.setPointerCapture(event.pointerId)
      document.documentElement.dataset.studioResizing = 'true'
      let rawWidth = startWidth
      let finished = false

      const finish = (collapse: boolean) => {
        if (finished) return
        finished = true
        handle.removeEventListener('pointermove', handleMove)
        handle.removeEventListener('pointerup', handleUp)
        handle.removeEventListener('pointercancel', handleUp)
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId)
        }
        delete document.documentElement.dataset.studioResizing
        if (collapse) {
          optionsRef.current.onCollapse?.(panel)
        } else {
          storePanelWidths(panelWidthsRef.current)
        }
      }

      const handleMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX
        const growsRight = panel === 'tree' || panel === 'workTask'
        rawWidth = growsRight ? startWidth + delta : startWidth - delta
        if (rawWidth <= Math.round(limits.min * 0.62)) {
          finish(true)
          return
        }
        if (linkedPanel && startLinkedWidth !== null) {
          const linked = resizeLinkedPanels({
            requestedPrimaryWidth: rawWidth,
            primaryStartWidth: startWidth,
            linkedStartWidth: startLinkedWidth,
            primaryMin: limits.min,
            linkedMin: PANEL_LIMITS[linkedPanel].min,
          })
          if (linked.collapseLinked) {
            const next = {
              ...panelWidthsRef.current,
              [panel]: linked.primaryWidth,
              [linkedPanel]: linked.linkedWidth,
            }
            panelWidthsRef.current = next
            setPanelWidths(next)
            finish(false)
            optionsRef.current.onCollapse?.(linkedPanel)
            return
          }
        }
        setPanelWidths((current) => {
          if (linkedPanel && startLinkedWidth !== null) {
            const linked = resizeLinkedPanels({
              requestedPrimaryWidth: rawWidth,
              primaryStartWidth: startWidth,
              linkedStartWidth: startLinkedWidth,
              primaryMin: limits.min,
              linkedMin: PANEL_LIMITS[linkedPanel].min,
            })
            if (current[panel] === linked.primaryWidth && current[linkedPanel] === linked.linkedWidth) return current
            const next = { ...current, [panel]: linked.primaryWidth, [linkedPanel]: linked.linkedWidth }
            panelWidthsRef.current = next
            return next
          }
          const maximum = optionsRef.current.getMaximum?.(panel, current) ?? viewportMaximum()
          const nextWidth = clampPanelWidth(rawWidth, limits, maximum)
          if (current[panel] === nextWidth) return current
          const next = { ...current, [panel]: nextWidth }
          panelWidthsRef.current = next
          return next
        })
      }
      const handleUp = () => {
        finish(false)
      }

      handle.addEventListener('pointermove', handleMove)
      handle.addEventListener('pointerup', handleUp)
      handle.addEventListener('pointercancel', handleUp)
    },
    [],
  )

  return { panelWidths, beginPanelResize }
}
