import { useLayoutEffect, useState } from 'react'
import type { WorkInspectorTab } from './WorkInspector'

export type WorkPanelUiState = {
  rightOpen: boolean
  viewer: 'chapter' | 'document' | null
  inspectorTab: WorkInspectorTab
  selectedTreeItemId?: string | null
  selectedChapterId?: string | null
}
const STORAGE_KEY = 'chevoink:studio-work-panel-ui'

export function resolveWorkViewer(viewer: WorkPanelUiState['viewer'], treeItemId: string | null, chapterId: string | null) {
  if (!viewer) return null
  if (treeItemId === 'catalog' || treeItemId?.startsWith('plan:')) return 'document'
  if (treeItemId?.startsWith('chapter:') || chapterId) return 'chapter'
  return null
}

export function readWorkPanelUi(scope: string): WorkPanelUiState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = (JSON.parse(raw) as Record<string, WorkPanelUiState | undefined>)[scope]
    return value && typeof value.rightOpen === 'boolean' ? value : null
  } catch { return null }
}

export function writeWorkPanelUi(scope: string, state: WorkPanelUiState) {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const map = raw ? JSON.parse(raw) as Record<string, WorkPanelUiState> : {}
    map[scope] = state
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch { /* Unavailable storage must not block layout changes. */ }
}

type Setters = {
  setRightOpen: (value: boolean) => void
  setViewer: (value: WorkPanelUiState['viewer']) => void
  setInspectorTab: (value: WorkInspectorTab) => void
  setSelectedTreeItemId: (value: string | null) => void
  setSelectedChapterId: (value: string | null) => void
}

/** Restore before paint; never persist the previous task's values into a new scope. */
export function useWorkPanelState(scope: string | undefined, state: WorkPanelUiState, setters: Setters) {
  const [hydratedScope, setHydratedScope] = useState<string>()
  const { rightOpen, viewer, inspectorTab, selectedTreeItemId, selectedChapterId } = state
  const { setRightOpen, setViewer, setInspectorTab, setSelectedTreeItemId, setSelectedChapterId } = setters
  useLayoutEffect(() => {
    if (!scope) { setHydratedScope(undefined); return }
    const restored = readWorkPanelUi(scope)
    const treeItemId = restored?.selectedTreeItemId ?? null
    const chapterId = treeItemId?.startsWith('chapter:') ? treeItemId.slice('chapter:'.length) : restored?.selectedChapterId ?? null
    setRightOpen(restored?.rightOpen ?? false)
    setViewer(restored?.viewer ?? null)
    setInspectorTab(restored?.inspectorTab ?? 'work')
    setSelectedTreeItemId(treeItemId)
    setSelectedChapterId(chapterId)
    setHydratedScope(scope)
  }, [scope, setRightOpen, setViewer, setInspectorTab, setSelectedTreeItemId, setSelectedChapterId])
  useLayoutEffect(() => {
    // The first commit after a scope change still contains the outgoing values.
    // This also excludes StrictMode's repeated mount effects until restoration commits.
    if (!scope || hydratedScope !== scope) return
    writeWorkPanelUi(scope, { rightOpen, viewer, inspectorTab, selectedTreeItemId, selectedChapterId })
  }, [scope, hydratedScope, rightOpen, viewer, inspectorTab, selectedTreeItemId, selectedChapterId])
  return hydratedScope
}
