export const WORK_SPLIT = { chat: 360, viewer: 220, inspector: 200, rail: 46, conversationRail: 44, hysteresis: 24, foldResistance: 84 }
export type WorkSplit = { viewer: number; inspector: number; chatCollapsed: boolean; viewerCollapsed: boolean; inspectorCollapsed: boolean }
export type WorkSplitGeometry = WorkSplit & { chat: number; rail: number }

/** Always resolve against the measured workspace, not the full screen / assumed sidebar width. */
export function fitWorkSplit(state: WorkSplit, width: number, hasViewer: boolean): WorkSplitGeometry {
  const room = Math.max(0, width)
  // Never leave an empty canvas after the last content pane disappears.
  const chatCollapsed = state.chatCollapsed && (hasViewer && !state.viewerCollapsed || !state.inspectorCollapsed)
  const chatReserve = chatCollapsed ? 0 : WORK_SPLIT.chat + WORK_SPLIT.conversationRail
  const viewerCollapsed = state.viewerCollapsed || (!chatCollapsed && room < chatReserve + WORK_SPLIT.viewer + WORK_SPLIT.rail)
  const viewerOpen = hasViewer && !viewerCollapsed
  const availableInspector = room - chatReserve - (viewerOpen ? WORK_SPLIT.viewer : 0)
  const inspectorCollapsed = state.inspectorCollapsed || availableInspector < WORK_SPLIT.inspector
  let inspector = inspectorCollapsed ? Math.min(room, WORK_SPLIT.rail) : Math.min(Math.max(WORK_SPLIT.inspector, state.inspector), availableInspector)
  const rail = chatCollapsed ? 0 : WORK_SPLIT.conversationRail
  if (chatCollapsed) inspector = viewerOpen ? Math.min(inspector, Math.max(WORK_SPLIT.rail, room - WORK_SPLIT.viewer)) : room
  const viewer = viewerOpen ? chatCollapsed ? Math.max(0, room - inspector) : Math.min(Math.max(WORK_SPLIT.viewer, state.viewer), room - rail - WORK_SPLIT.chat - inspector) : 0
  return { ...state, inspector, viewer, rail, chatCollapsed, viewerCollapsed, inspectorCollapsed, chat: chatCollapsed ? 0 : Math.max(0, room - rail - viewer - inspector) }
}

/** Pure mapping within one open/closed phase of a gesture. */
export function resizeWorkSplit(start: WorkSplitGeometry, previous: WorkSplit, width: number, delta: number, boundary: 'content' | 'inspector', hasViewer: boolean): WorkSplit {
  const { chat, viewer, inspector, hysteresis, foldResistance, rail, conversationRail } = WORK_SPLIT
  const viewerVisible = hasViewer && !start.viewerCollapsed
  if (boundary === 'inspector' && viewerVisible) {
    const raw = (start.inspectorCollapsed ? inspector : start.inspector) - delta
    const folded = raw < inspector + (previous.inspectorCollapsed ? hysteresis : -foldResistance)
    const combinedWidth = start.viewer + start.inspector
    const rawViewer = combinedWidth - raw
    const foldedViewer = !folded && !start.inspectorCollapsed && rawViewer <= viewer
    const nextInspector = folded ? rail : Math.max(inspector, Math.min(combinedWidth - viewer, raw))
    const nextViewer = foldedViewer ? previous.viewer : Math.max(viewer, combinedWidth - nextInspector)
    const nextChat = width - conversationRail - nextInspector - nextViewer
    return { ...start, inspector: nextInspector, viewer: nextViewer, viewerCollapsed: foldedViewer, inspectorCollapsed: folded, chatCollapsed: !foldedViewer && !folded && (nextChat < chat - foldResistance || start.chatCollapsed) }
  }
  if (!viewerVisible) {
    // Once the viewer folds, the held separator resizes the two remaining panes.
    const startingChat = start.chatCollapsed ? chat : start.inspectorCollapsed ? width - conversationRail - inspector : start.chat
    const rawChat = startingChat + delta
    const foldedChat = rawChat < chat + (previous.chatCollapsed ? hysteresis : -foldResistance)
    const rawInspector = width - conversationRail - rawChat
    const foldedInspector = rawInspector < inspector + (previous.inspectorCollapsed ? hysteresis : -foldResistance)
    return { ...start, viewer: previous.viewer, chatCollapsed: foldedChat, inspectorCollapsed: foldedInspector, inspector: foldedInspector ? rail : Math.max(inspector, rawInspector) }
  }
  const fixedInspector = start.inspector
  const startingViewer = start.chatCollapsed ? width - conversationRail - chat - fixedInspector : start.viewer
  const rawViewer = startingViewer - delta
  const rawChat = width - conversationRail - fixedInspector - rawViewer
  const foldedChat = rawChat < chat + (previous.chatCollapsed ? hysteresis : -foldResistance)
  const foldedViewer = !foldedChat && rawViewer <= viewer
  return { viewer: foldedViewer ? previous.viewer : Math.max(viewer, rawViewer), inspector: fixedInspector, chatCollapsed: foldedChat, viewerCollapsed: foldedViewer, inspectorCollapsed: start.inspectorCollapsed }
}

export type WorkSplitGesture = { x: number; left?: number; start: WorkSplitGeometry; width: number; boundary: 'content' | 'inspector'; hasViewer: boolean }

/** Ordinary resizing is 1:1; near an edge, fit the shrink + resistance distance
 * into the available pointer travel so another fold never requires leaving the window. */
function boundedDragDelta(gesture: WorkSplitGesture, x: number): number {
  const { start, boundary, hasViewer, width } = gesture
  const { viewer, inspector, chat, foldResistance } = WORK_SPLIT
  const delta = x - gesture.x
  const viewerVisible = hasViewer && !start.viewerCollapsed
  const shrinkingViewer = viewerVisible && (boundary === 'content' ? delta >= 0 : delta < 0)
  const available = delta >= 0 ? (gesture.left ?? 0) + width - 4 - gesture.x : gesture.x - (gesture.left ?? 0) - 4
  if (shrinkingViewer) {
    if (boundary === 'content' ? start.chatCollapsed : start.inspectorCollapsed) return delta
    return delta * Math.max(1, (Math.max(0, start.viewer - viewer) + 2) / Math.max(1, available))
  }
  if (start.chatCollapsed || (delta >= 0 ? start.inspectorCollapsed : viewerVisible && boundary === 'inspector')) return delta
  const free = delta >= 0 ? start.inspector - inspector : start.chat - chat
  return delta * Math.max(1, (Math.max(0, free) + foldResistance + 2) / Math.max(1, available))
}

/** Re-anchor at a fold and follow overshoot, so reversal never has to retrace dead travel. */
export function advanceWorkSplitGesture(gesture: WorkSplitGesture, previous: WorkSplit, x: number): WorkSplit {
  const next = resizeWorkSplit(gesture.start, previous, gesture.width, boundedDragDelta(gesture, x), gesture.boundary, gesture.hasViewer)
  const changed = next.chatCollapsed !== previous.chatCollapsed || next.viewerCollapsed !== previous.viewerCollapsed || next.inspectorCollapsed !== previous.inspectorCollapsed
  const viewerVisible = gesture.hasViewer && !gesture.start.viewerCollapsed
  const foldedTowardLeft = viewerVisible && gesture.boundary === 'inspector' ? next.viewerCollapsed : next.chatCollapsed
  const foldedTowardRight = viewerVisible && gesture.boundary === 'content' ? next.viewerCollapsed : next.inspectorCollapsed
  if (changed || foldedTowardLeft && x < gesture.x || foldedTowardRight && x > gesture.x) {
    gesture.x = x
    gesture.start = fitWorkSplit(next, gesture.width, gesture.hasViewer)
  }
  return next
}
