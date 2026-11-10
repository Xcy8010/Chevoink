export const WORK_ACTIVITY_DOCK_WIDTH = 296
export const WORK_ACTIVITY_DOCK_EDGE_GAP = 12
const MIN_CENTERED_CONVERSATION_WIDTH = 640

/** Keep the activity card separate only while the centered conversation has room. */
export function shouldShowWorkActivityDock({
  containerWidth,
  leftWidth,
  rightWidth,
  hasActivity,
  hasViewer,
}: {
  containerWidth: number
  leftWidth: number
  rightWidth: number
  hasActivity: boolean
  hasViewer: boolean
}) {
  if (!hasActivity || hasViewer) return false
  const workWidth = containerWidth - rightWidth
  const dockReserve = WORK_ACTIVITY_DOCK_WIDTH + WORK_ACTIVITY_DOCK_EDGE_GAP
  return Math.min(workWidth - 2 * dockReserve, workWidth - leftWidth - 32) >= MIN_CENTERED_CONVERSATION_WIDTH
}
