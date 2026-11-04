import type { AgentUIMessage } from '../../../../../shared/contracts/index'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation'
import { isResearchCall } from './research-groups'

export type AnalysisGroup = { id: string; messageId: string; firstIndex: number; count: number; labels: string[]; lastMessageId: string; lastIndex: number }
export type MessageAnalysisGroups = ReadonlyMap<number, AnalysisGroup>

/** Analysis activity is grouped without inspecting or publishing private reasoning text. */
export function projectAnalysisGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts'>[]) {
  const result = new Map<string, Map<number, AnalysisGroup>>()
  let active: AnalysisGroup | undefined
  let run: string | undefined, goal: string | null | undefined
  for (const message of messages) {
    if (message.role !== 'assistant' || run !== message.runId || goal !== (message.goalId ?? null)) active = undefined
    run = message.runId; goal = message.goalId ?? null
    if (message.role !== 'assistant') continue
    const groups = new Map<number, AnalysisGroup>()
    result.set(message.id, groups)
    message.parts.forEach((part, index) => {
      if (part.type === 'reasoning') {
        active ??= { id: `${message.id}:analysis:${index}`, messageId: message.id, firstIndex: index, count: 0, labels: [], lastMessageId: message.id, lastIndex: index }
        active.count++; active.lastMessageId = message.id; active.lastIndex = index
        groups.set(index, active)
      } else if (part.type === 'tool-call') {
        if (active) {
          const label = getAgentToolPresentation(part.toolName).label
          if (!active.labels.includes(label)) active.labels.push(label)
        }
        if (!isResearchCall(part)) active = undefined
      } else if (!(part.type === 'text' && !part.text.trim())) active = undefined
    })
  }
  return result
}
