import { readAgentActivityTitle } from '../../../shared/agent-activity-title.js'
import { getAgentToolPresentation, sameAgentToolStage, type AgentToolPresentation } from '../../../shared/agent-tool-presentation.js'

export type ToolActivity = AgentToolPresentation & { title?: string }

export function toolActivity(name: string, title?: string): ToolActivity {
  return { ...getAgentToolPresentation(name), title }
}

/** A model can emit only tool calls. Give the author a short statement about
 * the upcoming action at the same boundaries where prose is expected. */
export function toolActivityReport(next: ToolActivity, previous?: ToolActivity): string {
  if (previous) {
    const changesGoal = next.title ? next.title !== previous.title
      : !sameAgentToolStage(next, previous)
    if (!changesGoal) return ''
  }
  if (next.label === '等待作者决定') return '这一步需要和你确认一个问题。'
  const action = next.title ?? (next.label.endsWith('复查') ? `复查${next.label.slice(0, -2)}` : next.label)
  return `${previous ? '接下来' : '我先'}${action}。`
}

export function previousToolActivity(messages: readonly (
  { role: 'assistant'; content: string | null; toolCalls?: readonly { name: string }[] } | { role: 'user' | 'system' | 'tool' }
)[]): ToolActivity | undefined {
  let activity: ToolActivity | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const call = message.toolCalls?.find(item => item.name !== 'task_respond')
    if (!call) continue
    const { title } = readAgentActivityTitle(message.content ?? '')
    const current = toolActivity(call.name)
    if (activity && !sameAgentToolStage(activity, current)) return activity
    activity ??= current
    if (title) return { ...activity, title }
  }
  return activity
}
