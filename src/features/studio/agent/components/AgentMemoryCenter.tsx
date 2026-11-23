import AgentContextPanel from './AgentContextPanel'
import AgentMemoryCards from './AgentMemoryCards'
import { isRunActive, useAgentStore } from '../agentStore'
import { useShellStore } from '@/store/useShellStore'

type Props = {
  sessionId: string | null
  novelId: string
  active?: boolean
  /** 外层已有滚动容器（如移动端视图）时传 false，避免双滚动条 */
  scrollable?: boolean
  onOpenDetail?: () => void
}

/**
 * 「记忆」总合面板：上半是当前任务的会话上下文（占用/压缩/检查点），
 * 下半是整部作品的创作记忆卡片轨。单一滚动容器，不做嵌套滚动。
 */
export default function AgentMemoryCenter({ sessionId, novelId, active: workspaceActive = false, scrollable = true, onOpenDetail }: Props) {
  const userId = useShellStore(state => state.sessionUser?.id)
  const streamActive = useAgentStore(state => Boolean(sessionId && state.activeSessionId === sessionId && isRunActive(state.phase)))
  const active = workspaceActive || streamActive
  return (
    <div className={scrollable ? 'h-full overflow-y-auto' : ''}>
      <AgentContextPanel key={JSON.stringify([userId, novelId, sessionId])} userId={userId} novelId={novelId} sessionId={sessionId} active={active} scrollable={false} onOpenDetail={onOpenDetail} />
      <div className="mx-4 border-t border-[var(--border-subtle)]" />
      <AgentMemoryCards novelId={novelId} sessionId={sessionId} active={active} />
    </div>
  )
}
