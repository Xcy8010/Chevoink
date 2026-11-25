export const WORKSPACE_SIDEBAR_MIN = 216
export const WORKSPACE_SIDEBAR_MAX = 392

export function readWorkspaceSidebarWidth() {
  try {
    const width = typeof window === 'undefined' ? null : Number(window.localStorage.getItem('chevoink:studio-sidebar-width'))
    // 304 was the previous default, and collapsed widths should reopen at the current default.
    if (width && Number.isFinite(width) && width !== 304 && width > WORKSPACE_SIDEBAR_MIN + 16) {
      return Math.min(WORKSPACE_SIDEBAR_MAX, width)
    }
  } catch { /* Storage may be unavailable during startup. */ }
  return 280
}

export function readWorkspaceSidebarOpen() {
  try {
    return typeof window === 'undefined' || window.localStorage.getItem('chevoink:workspace-sidebar') !== 'collapsed'
  } catch { return true }
}
