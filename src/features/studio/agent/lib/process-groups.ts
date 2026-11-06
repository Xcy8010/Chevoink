import type { AgentUIMessage } from '../../../../../shared/contracts/index'
import { isResearchCall } from './research-groups'
import { projectAgentAuthorParts } from '../../../../../shared/agent-author-view'
import { agentToolProgress, normalizeAgentProgressText } from '../../../../../shared/agent-progress'

export type AnalysisGroup = { id: string; messageId: string; firstIndex: number; count: number; labels: string[]; actions: string[]; text: string; title: string; lastMessageId: string; lastIndex: number }
export type MessageAnalysisGroups = ReadonlyMap<number, AnalysisGroup>

/** Reasoning episodes keep their full body; only real receipts supply a title. */
export function projectAnalysisGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts'>[], _activeMessageId?: string) {
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
        active ??= { id: `${message.id}:analysis:${index}`, messageId: message.id, firstIndex: index, count: 0, labels: [], actions: [], text: '', title: '', lastMessageId: message.id, lastIndex: index }
        active.count++; active.lastMessageId = message.id; active.lastIndex = index
        const text = normalizeAgentProgressText(part.text)
        if (text) active.text += `${active.text ? '\n\n' : ''}${text}`
        groups.set(index, active)
      } else if (part.type === 'tool-call') {
        if (active) {
          if (part.toolName !== 'task_respond' && !part.subagentCallId) {
            const visible = projectAgentAuthorParts([part], false, { includePreparing: true })[0]
            if (visible?.type === 'tool-call') {
              const label = agentToolProgress(visible)
              // The same call is upgraded in place by the store; duplicate receipts
              // cannot create additional completed actions in this episode.
              const prior = active.labels.indexOf(part.callId)
              if (prior < 0) { active.labels.push(part.callId); active.actions.push(label) }
              else active.actions[prior] = label
              active.title = label.split('\n')[0]
            }
          }
        }
        if (!isResearchCall(part)) active = undefined
      } else if (!(part.type === 'text' && !part.text.trim())) active = undefined
    })
  }
  return result
}
