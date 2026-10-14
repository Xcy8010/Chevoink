import { useEffect, useState } from 'react'
import { useAgentStore } from './agentStore'
import { shouldShowProcessingHint } from './lib/panel-helpers'
import type { AgentUIMessage } from '../../../../shared/contracts/index.js'

export const OUTPUT_SILENCE_MS = 1500

/** One model-stage hint, sourced only from actual argument/draft events. */
export function useModelStageFeedback(messages: AgentUIMessage[], runId: string | null, phase: string, waitingForUser: boolean, enabled = true) {
  const drafts = useAgentStore(state => state.liveToolDrafts)
  if (!enabled || !shouldShowProcessingHint(messages, runId, phase, waitingForUser)) return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || message.runId !== runId) continue
    for (let at = message.parts.length - 1; at >= 0; at--) {
      const part = message.parts[at]
      if (part.type !== 'tool-call' || !part.preparing || part.status !== 'running') continue
      const draft = drafts[part.callId]
      if (draft?.content.length) return `正在生成${draft.kind === 'chapter' ? '正文' : '计划'}草稿 · ${draft.content.length} 字（未保存）`
      if (part.progressChars && part.progressChars > 0) return `正在生成操作参数 · ${part.progressChars} 字符`
    }
  }
  return null
}

/** Actual output deltas suppress fallback feedback; an unfinished reasoning
 * part alone cannot. One expiring timer restores feedback even without SSE. */
export function useProcessingHint(messages: AgentUIMessage[], runId: string | null, phase: string, waitingForUser: boolean, enabled = true) {
  const activity = useAgentStore(state => state.lastVisibleOutput)
  const stage = useModelStageFeedback(messages, runId, phase, waitingForUser, enabled)
  const [, tick] = useState(0)
  const eligible = enabled && shouldShowProcessingHint(messages, runId, phase, waitingForUser)
  const expiresAt = activity?.runId === runId ? activity.at + OUTPUT_SILENCE_MS : 0
  const recent = Date.now() < expiresAt
  useEffect(() => {
    if (!eligible || !recent || stage) return
    const timer = window.setTimeout(() => tick(value => value + 1), Math.max(0, expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [eligible, recent, expiresAt, stage])
  return eligible && (Boolean(stage) || !recent)
}
