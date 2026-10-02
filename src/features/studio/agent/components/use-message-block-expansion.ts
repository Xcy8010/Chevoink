import { useCallback, useLayoutEffect, useState } from 'react'
import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'

import type { AgentGoalView } from '../goal-selectors'
import { keepInterruptedRunExpanded } from '../goal-selectors'
import type { AgentRunPhase } from '../agentStore'
import type { MessageBlock } from '../lib/message-projection'

type Expansion = { value: boolean; sessionId: string | null; goalId: string | null }
type ExpansionState = { blocks: Record<string, Expansion>; completedGoals: ReadonlySet<string> }
const scopeKey = (sessionId: string | null, id: string) => JSON.stringify([sessionId, id])

/** Manual history choices belong to a conversation; completion belongs to a goal. */
export function useMessageBlockExpansion({ sessionId, messages, blocks, goalView, phase, runId }: {
  sessionId: string | null
  messages: readonly AgentUIMessage[]
  blocks: ReadonlyMap<string, MessageBlock>
  goalView: AgentGoalView
  phase: AgentRunPhase
  runId: string | null
}) {
  const [state, setState] = useState<ExpansionState>(() => ({ blocks: {}, completedGoals: new Set() }))
  const goal = goalView.goal
  const goalId = goal?.id ?? null
  const goalStatus = goal?.status ?? null

  useLayoutEffect(() => {
    if (!goalId) return
    const key = scopeKey(sessionId, goalId)
    setState(current => {
      if (goalStatus === 'completed') {
        if (current.completedGoals.has(key)) return current
        const nextBlocks = { ...current.blocks }
        for (const [blockKey, entry] of Object.entries(nextBlocks)) {
          if (entry.sessionId === sessionId && entry.goalId === goalId) delete nextBlocks[blockKey]
        }
        return { blocks: nextBlocks, completedGoals: new Set(current.completedGoals).add(key) }
      }
      // Remember the open process before leaving this goal/session. Returning to
      // it must not silently close its interrupted work or erase manual choices.
      let nextBlocks = current.blocks
      for (const block of blocks.values()) {
        const blockKey = scopeKey(sessionId, block.firstId)
        if (block.goalId !== goalId || nextBlocks[blockKey]) continue
        if (nextBlocks === current.blocks) nextBlocks = { ...current.blocks }
        nextBlocks[blockKey] = { value: true, sessionId, goalId }
      }
      return nextBlocks === current.blocks ? current : { ...current, blocks: nextBlocks }
    })
  }, [blocks, goalId, goalStatus, sessionId])

  const isExpanded = useCallback((block: MessageBlock | undefined, messageRunId: string) => {
    if (!block) return keepInterruptedRunExpanded(phase, messageRunId, runId)
    const currentGoalBlock = Boolean(goalId && block.goalId === goalId)
    // Do not show one frame of an old explicit expansion when committed
    // completion arrives. Cleanup runs before paint, once per goal identity.
    if (currentGoalBlock && goalStatus === 'completed' && !state.completedGoals.has(scopeKey(sessionId, goalId!))) return false
    return state.blocks[scopeKey(sessionId, block.firstId)]?.value
      ?? (currentGoalBlock && goalStatus !== 'completed' || keepInterruptedRunExpanded(phase, messageRunId, runId))
  }, [goalId, goalStatus, phase, runId, sessionId, state])

  const toggle = useCallback((blockId: string) => {
    const block = blocks.get(blockId)
    if (!block) return
    const key = scopeKey(sessionId, block.firstId)
    setState(current => ({ ...current, blocks: { ...current.blocks, [key]: {
      value: !isExpanded(block, messages.find(message => message.id === block.firstId)?.runId ?? ''), sessionId, goalId: block.goalId ?? null,
    } } }))
  }, [blocks, isExpanded, messages, sessionId])

  return { isExpanded, toggle }
}
