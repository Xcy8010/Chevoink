import type { AgentMessagePart, AgentStreamEvent } from './contracts/index.js'
import { getAgentToolPresentation } from './agent-tool-presentation.js'

/** Only progress receipts decode transport escapes; manuscripts and arguments do not. */
export function normalizeAgentProgressText(text: string): string {
  return text.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n').trim()
}

/** Reasoning is private protocol/accounting data. Keep only its episode marker. */
export function publicAgentProgressPart(part: AgentMessagePart): AgentMessagePart {
  if (part.type === 'reasoning') return part.text
    ? { ...part, text: '', ...(part.text.trim() ? { activity: true as const } : {}) } : part
  if (part.type !== 'tool-call' || !part.summary) return part
  const summary = normalizeAgentProgressText(part.summary)
  return summary === part.summary ? part : { ...part, summary }
}

export function publicAgentProgressEvent(event: AgentStreamEvent): AgentStreamEvent {
  if (event.type === 'reasoning.delta') return event.delta
    ? { ...event, delta: '', ...(event.delta.trim() ? { activity: true as const } : {}) } : event
  if (event.type === 'tool.result') return { ...event, summary: normalizeAgentProgressText(event.summary) }
  return event
}

/** Tool execution state is the witness; a model's intention is never completion. */
export function agentToolProgress(part: Extract<AgentMessagePart, { type: 'tool-call' }>): string {
  const label = getAgentToolPresentation(part.toolName).label
  if (part.preparing) return `正在准备${label}`
  if (part.status === 'running') return `正在${label}`
  const summary = normalizeAgentProgressText(part.summary ?? '')
  if (part.status === 'failed' || part.status === 'denied') {
    return `${label}${part.status === 'denied' ? '未获准' : '未完成'}${summary ? `：${summary}` : ''}`
  }
  const receipt = summary || `${label}已执行`
  return part.reviewOutcome && part.reviewOutcome !== 'complete' ? `${receipt}（仍需处理）` : receipt
}
