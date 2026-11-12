import type { ReactNode } from 'react'

type IdePerspectiveProps = {
  children: ReactNode
  treeWidth: number
  treeOpen?: boolean
  agentWidth: number
  agentOpen?: boolean
}

/** 写作优先 IDE：边到边三栏，容器只表达真实分区，避免多层圆角卡片。 */
export default function IdePerspective({ children, treeWidth, treeOpen = true, agentWidth, agentOpen = true }: IdePerspectiveProps) {
  return (
    <div
      data-studio-layout="ide"
      className="studio-resizable-grid grid h-full min-h-0 overflow-hidden bg-[var(--surface-default)]"
      style={{ gridTemplateColumns: `${treeOpen ? treeWidth : 46}px minmax(0,1fr) ${agentOpen ? agentWidth : 46}px` }}
    >
      {children}
    </div>
  )
}
