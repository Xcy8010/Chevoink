import type { StudioSettingsSection } from '../components/StudioSettingsDialog'

export type StudioSurface =
  | { kind: 'settings'; section: StudioSettingsSection; depth: number }
  | { kind: 'invite' | 'export' | 'meta' | 'cover' }
  | { kind: 'context'; sessionId: string }

export type WorkspaceVisit = {
  owner: string
  novelId: string
  taskId: string | null
  perspective: 'work' | 'ide'
  blankTask: boolean
}

export function readWorkspaceVisit(state: unknown, owner: string, novelId: string): WorkspaceVisit | null {
  if (typeof state !== 'object' || !state || !('workspaceVisit' in state)) return null
  const visit = state.workspaceVisit as Partial<WorkspaceVisit> | null
  if (!visit || visit.owner !== owner || visit.novelId !== novelId ||
    (visit.perspective !== 'work' && visit.perspective !== 'ide') ||
    !(visit.taskId === null || typeof visit.taskId === 'string')) return null
  return { owner, novelId, taskId: visit.taskId, perspective: visit.perspective, blankTask: visit.blankTask === true }
}

/** Annotate the current React Router entry without triggering navigation or truncating forward history. */
export function rememberWorkspaceVisit(visit: WorkspaceVisit) {
  const entry = window.history.state
  if (typeof entry?.idx !== 'number') return
  window.history.replaceState({ ...entry, usr: { ...entry.usr, workspaceVisit: visit } }, '')
}

/** Browser and caption Back both dispatch popstate. A foreground write must
 * finish before the router unmounts its owning task and aborts that write. */
export function protectWritingTask(onBlocked: () => void): () => void {
  const origin = window.history.state
  const originIndex = origin?.idx
  if (typeof originIndex !== 'number') return () => {}
  let returning = false
  const guard = (event: PopStateEvent) => {
    const index = event.state?.idx
    if (typeof index !== 'number') return
    if (index === originIndex) {
      if (returning) event.stopImmediatePropagation()
      returning = false
      return
    }
    const current = origin.usr?.workspaceVisit as WorkspaceVisit | undefined
    const next = current && readWorkspaceVisit(event.state.usr, current.owner, current.novelId)
    if (next?.taskId && next.taskId === current?.taskId) return
    event.stopImmediatePropagation()
    returning = true
    window.history.go(originIndex - index)
    onBlocked()
  }
  window.addEventListener('popstate', guard, true)
  return () => window.removeEventListener('popstate', guard, true)
}
