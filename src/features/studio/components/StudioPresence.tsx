import type { ReactNode } from 'react'
import { studioInert, useStudioPresence } from './use-studio-presence'

type SurfaceKind = 'menu' | 'dialog' | 'sheet' | 'fade'

export function StudioPresence({ kind, children }: { kind: SurfaceKind; children: ReactNode }) {
  const { rendered, phase } = useStudioPresence(children)
  if (rendered == null || rendered === false) return null
  return <div data-studio-presence={kind} data-phase={phase} {...studioInert(phase === 'closing')}>{rendered}</div>
}
