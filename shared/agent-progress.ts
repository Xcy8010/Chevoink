import type { AgentMessagePart, AgentStreamEvent } from './contracts/index.js'
import { getAgentToolPresentation } from './agent-tool-presentation.js'

/** Only progress/reasoning presentation decodes escapes; manuscripts and arguments do not. */
export function normalizeAgentProgressText(text: string): string {
  return text.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n').trim()
}

/** Publish only the provider-returned reasoning and its public timing/activity. */
export function publicAgentProgressPart(part: AgentMessagePart): AgentMessagePart {
  if (part.type === 'reasoning') return {
    type: 'reasoning', text: part.text,
    ...(part.durationMs !== undefined ? { durationMs: part.durationMs } : {}),
    ...(part.activity || part.text.trim() ? { activity: true as const } : {}),
  }
  if (part.type !== 'tool-call' || !part.summary) return part
  const summary = normalizeAgentProgressText(part.summary)
  return summary === part.summary ? part : { ...part, summary }
}

export function publicAgentProgressEvent(event: AgentStreamEvent): AgentStreamEvent {
  // Keep deltas verbatim: an escape or a word can span transport chunks.
  if (event.type === 'reasoning.delta') return {
    type: event.type, runId: event.runId, seq: event.seq, ts: event.ts,
    messageId: event.messageId, delta: event.delta,
    ...(event.activity || event.delta.trim() ? { activity: true as const } : {}),
  }
  if (event.type === 'tool.result') return { ...event, summary: normalizeAgentProgressText(event.summary) }
  return event
}

export function agentRunningToolLabel(toolName: string, chapterTitle?: string, detailLabel?: string): string {
  const { phase, label } = getAgentToolPresentation(toolName)
  const chapter = chapterTitle ? `《${chapterTitle}》` : ''
  if (toolName === 'chapter_write' || toolName === 'chapter_append') return `正在写入${chapter}正文`
  if (toolName === 'chapter_edit_range') return chapter ? `正在写入${chapter}的正文修改` : '正在写入正文修改'
  if (toolName === 'plan_rename') return '正在重命名计划'
  if (toolName === 'plan_delete') return '正在删除计划'
  if (phase === 'save') return `正在写入${label.replace(/^保存/, '')}`
  if (phase === 'review' && label.endsWith('复查')) return `正在进行${label}`
  return `正在${detailLabel ?? label}`
}

/** Tool execution state is the witness; a model's intention is never completion. */
export function agentToolProgress(part: Extract<AgentMessagePart, { type: 'tool-call' }>): string {
  if (part.status === 'running') return agentRunningToolLabel(part.toolName)
  const label = getAgentToolPresentation(part.toolName).label
  const summary = normalizeAgentProgressText(part.summary ?? '')
  if (part.status === 'failed' || part.status === 'denied') {
    return `${label}${part.status === 'denied' ? '未获准' : '未完成'}${summary ? `：${summary}` : ''}`
  }
  const receipt = summary || `${label}已执行`
  return part.reviewOutcome && part.reviewOutcome !== 'complete' ? `${receipt}（仍需处理）` : receipt
}
