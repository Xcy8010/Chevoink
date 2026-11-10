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

function contentViewerWidth(start: WorkSplitGeometry, width: number): number {
  return start.chatCollapsed ? width - WORK_SPLIT.conversationRail - WORK_SPLIT.chat - start.inspector : start.viewer
}

/** Pure mapping within one open/closed phase of a gesture. */
export function resizeWorkSplit(start: WorkSplitGeometry, previous: WorkSplit, width: number, delta: number, boundary: 'content' | 'inspector', hasViewer: boolean, viewerFoldResistance = WORK_SPLIT.foldResistance): WorkSplit {
  const { chat, viewer, inspector, hysteresis, foldResistance, rail, conversationRail } = WORK_SPLIT
  const viewerVisible = hasViewer && !start.viewerCollapsed
  if (boundary === 'inspector' && viewerVisible) {
    const raw = (start.inspectorCollapsed ? inspector : start.inspector) - delta
    const folded = raw < inspector + (previous.inspectorCollapsed ? hysteresis : -foldResistance)
    const combinedWidth = start.viewer + start.inspector
    const rawViewer = combinedWidth - raw
    const foldedViewer = !folded && !start.inspectorCollapsed && rawViewer < viewer - viewerFoldResistance
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
  const rawViewer = contentViewerWidth(start, width) - delta
  const rawChat = width - conversationRail - fixedInspector - rawViewer
  const foldedChat = rawChat < chat + (previous.chatCollapsed ? hysteresis : -foldResistance)
  const foldedViewer = !foldedChat && rawViewer < viewer - viewerFoldResistance
  return { viewer: foldedViewer ? previous.viewer : Math.max(viewer, rawViewer), inspector: fixedInspector, chatCollapsed: foldedChat, viewerCollapsed: foldedViewer, inspectorCollapsed: start.inspectorCollapsed }
}

export type WorkSplitGesture = { x: number; left?: number; start: WorkSplitGeometry; width: number; boundary: 'content' | 'inspector'; hasViewer: boolean; viewerFold?: { x: number; inspectorOpen: boolean } }

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
    const viewerTravel = Math.max(0, start.viewer - viewer) + foldResistance
    const inspectorTravel = boundary === 'content' && !start.inspectorCollapsed ? Math.max(0, start.inspector - inspector) + foldResistance : 0
    return delta * Math.max(1, (viewerTravel + inspectorTravel + 2) / Math.max(1, available))
  }
  if (start.chatCollapsed || (delta >= 0 ? start.inspectorCollapsed : viewerVisible && boundary === 'inspector')) return delta
  const free = delta >= 0 ? start.inspector - inspector : start.chat - chat
  return delta * Math.max(1, (Math.max(0, free) + foldResistance + 2) / Math.max(1, available))
}

/** Re-anchor at a fold and follow overshoot, so reversal never has to retrace dead travel. */
export function advanceWorkSplitGesture(gesture: WorkSplitGesture, previous: WorkSplit, x: number): WorkSplit {
  const viewerVisible = gesture.hasViewer && !gesture.start.viewerCollapsed
  const { viewerFold } = gesture
  const reversal = (viewerFold?.x ?? x) - x
  let next: WorkSplit
  if (viewerFold && reversal > WORK_SPLIT.hysteresis) {
    const reopenInspector = viewerFold.inspectorOpen && previous.inspectorCollapsed
    next = {
      ...previous,
      viewer: WORK_SPLIT.viewer + reversal,
      viewerCollapsed: false,
      ...(reopenInspector ? { inspector: WORK_SPLIT.inspector, inspectorCollapsed: false } : {}),
    }
    gesture.viewerFold = undefined
  } else {
    // Only the same capture of the viewer's left seam can reverse its fold.
    if (reversal > 0) return previous
    const { start, width, boundary, hasViewer } = gesture
    const delta = boundedDragDelta(gesture, x)
    next = resizeWorkSplit(start, previous, width, delta, boundary, hasViewer)
    if (viewerFold) viewerFold.x = x
    else if (viewerVisible && boundary === 'content' && next.viewerCollapsed) {
      gesture.viewerFold = { x, inspectorOpen: !next.inspectorCollapsed }
      if (!next.inspectorCollapsed) {
        // A single pointer sample can cross both folds. Start the inspector at the viewer's threshold.
        const viewerThreshold = contentViewerWidth(start, width) - WORK_SPLIT.viewer + WORK_SPLIT.foldResistance
        const foldTravel = Math.max(start.chatCollapsed ? WORK_SPLIT.hysteresis : 0, viewerThreshold)
        gesture.x += (x - gesture.x) * foldTravel / delta
        gesture.start = fitWorkSplit(next, width, hasViewer)
        next = resizeWorkSplit(gesture.start, next, width, boundedDragDelta(gesture, x), boundary, hasViewer)
        if (!next.inspectorCollapsed) return next
      }
    }
  }
  const changed = next.chatCollapsed !== previous.chatCollapsed || next.viewerCollapsed !== previous.viewerCollapsed || next.inspectorCollapsed !== previous.inspectorCollapsed
  const foldedTowardLeft = viewerVisible && gesture.boundary === 'inspector' ? next.viewerCollapsed : next.chatCollapsed
  const foldedTowardRight = viewerVisible && gesture.boundary === 'content' ? next.viewerCollapsed : next.inspectorCollapsed
  if (changed || foldedTowardLeft && x < gesture.x || foldedTowardRight && x > gesture.x) {
    gesture.x = x
    gesture.start = fitWorkSplit(next, gesture.width, gesture.hasViewer)
  }
  return next
}
