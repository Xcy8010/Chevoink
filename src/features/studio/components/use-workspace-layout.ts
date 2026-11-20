import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { WORK_CONVERSATION_WIDTH_LIMITS, useStudioPanelWidths, type ResizablePanel, type StudioPanelWidths } from '../panel-widths'
import type { WorkInspectorTab } from './WorkInspector'

// Match the studio's Tailwind lg layout. React only rerenders when crossing
// the breakpoint, including when rotating a tablet or resizing a desktop.
function subscribeWidth(notify: () => void) {
  window.addEventListener('resize', notify)
  return () => window.removeEventListener('resize', notify)
}

export function useDesktopStudioLayout() {
  return useSyncExternalStore(subscribeWidth, () => window.innerWidth >= 1024, () => true)
}

/** Layout ownership only: preserves storage keys, size limits and collapse semantics. */
export function useWorkspaceLayout(activeNovelId: string) {
  const [workspacePerspective, setWorkspacePerspective] = useState<'work' | 'ide'>(() => {
    if (typeof window === 'undefined') return 'work'
    return window.localStorage.getItem(`chevoink:perspective:${activeNovelId}`) === 'ide' ? 'ide' : 'work'
  })
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('chevoink:workspace-sidebar') !== 'collapsed'
  })
  // 左侧创作栏宽度（首帧从持久化读，后续由侧栏稳定后上报）：
  // 侧栏折叠后用它动态收窄聊天区最小宽度，给查看器让出更大的向左拉伸空间
  const [workspaceSidebarWidth, setWorkspaceSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return 280
    const value = Number(window.localStorage.getItem('chevoink:studio-sidebar-width'))
    return Number.isFinite(value) && value >= 200 ? value : 280
  })
  const [workRightOpen, setWorkRightOpen] = useState(false)
  const [workInspectorTab, setWorkInspectorTab] = useState<WorkInspectorTab>('work')
  const [workViewer, setWorkViewer] = useState<'chapter' | 'document' | null>(null)
  // 切换作品时保存上一作品的检查区布局、恢复当前作品上次的布局（右侧栏开关/页签/查看器，
  // 含刷新后首次进入），像 Codex 一样每个作品回到自己当时的界面
  const [ideTreeOpen, setIdeTreeOpen] = useState(true)
  const [ideSidebarTab, setIdeSidebarTab] = useState<WorkInspectorTab>('work')
  const [ideAgentOpen, setIdeAgentOpen] = useState(true)

  // Work 对话展开时统一保留 360px；越过阈值后由 WorkPerspective 切为浮动输入。
  const conversationMinWidth = WORK_CONVERSATION_WIDTH_LIMITS.collapsedMin
  const getPanelMaximum = useCallback((panel: ResizablePanel, widths: StudioPanelWidths) => {
    const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
    // Work 必须同时为最左创作栏（最大 392）、聊天轨（44）和可完整操作的 Agent 对话
    // 保留空间；IDE 没有外层创作栏，但仍保证正文/编辑器不会被两侧面板夹没。
    // 侧栏折叠后保留收窄为「聊天轨 44 + 压缩后的聊天区最小宽度」，
    // 查看器拖拽上限同步放大；侧栏展开后由 normalizeForViewport 自动回弹。
    const centerReserve = workspacePerspective === 'work'
      ? (workspaceSidebarOpen ? workspaceSidebarWidth : 0) + 44 + conversationMinWidth
      : 520
    if (panel === 'tree') {
      return viewportWidth - centerReserve - (ideAgentOpen ? widths.agent : 46)
    }
    if (panel === 'agent') {
      return viewportWidth - centerReserve - (ideTreeOpen ? widths.tree : 46)
    }
    const inspectorWidth = workRightOpen ? widths.workInspector : 46
    const viewerWidth = workViewer ? widths.workViewer : 0
    if (panel === 'workTask') return viewportWidth - centerReserve - inspectorWidth - viewerWidth
    if (panel === 'workInspector') return viewportWidth - centerReserve - viewerWidth
    return viewportWidth - centerReserve - inspectorWidth
  }, [ideAgentOpen, ideTreeOpen, workRightOpen, workViewer, workspacePerspective, workspaceSidebarOpen, workspaceSidebarWidth, conversationMinWidth])
  const { panelWidths, beginPanelResize } = useStudioPanelWidths({
    onCollapse: (panel) => {
      if (panel === 'tree') setIdeTreeOpen(false)
      if (panel === 'agent') setIdeAgentOpen(false)
      if (panel === 'workInspector') setWorkRightOpen(false)
      if (panel === 'workViewer') setWorkViewer(null)
    },
    getMaximum: getPanelMaximum,
  })

  useEffect(() => {
    window.localStorage.setItem(`chevoink:perspective:${activeNovelId}`, workspacePerspective)
  }, [activeNovelId, workspacePerspective])

  useEffect(() => {
    window.localStorage.setItem('chevoink:workspace-sidebar', workspaceSidebarOpen ? 'open' : 'collapsed')
  }, [workspaceSidebarOpen])

  return { workspacePerspective, setWorkspacePerspective, workspaceSidebarOpen, setWorkspaceSidebarOpen, workspaceSidebarWidth, setWorkspaceSidebarWidth, workRightOpen, setWorkRightOpen, workInspectorTab, setWorkInspectorTab, workViewer, setWorkViewer, ideTreeOpen, setIdeTreeOpen, ideSidebarTab, setIdeSidebarTab, ideAgentOpen, setIdeAgentOpen, panelWidths, beginPanelResize }
}
