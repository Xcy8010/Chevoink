import { useEffect, useState } from 'react'
import { useAgentStore } from './agentStore'
import { shouldShowProcessingHint } from './lib/panel-helpers'
import type { AgentUIMessage } from '../../../../shared/contracts/index.js'

export const OUTPUT_SILENCE_MS = 1500

/** Actual output deltas suppress fallback feedback; an unfinished reasoning
 * part alone cannot. One expiring timer restores feedback even without SSE. */
export function useProcessingHint(messages: AgentUIMessage[], runId: string | null, phase: string, waitingForUser: boolean, enabled = true) {
  const activity = useAgentStore(state => state.lastVisibleOutput)
  const [, tick] = useState(0)
  const eligible = enabled && shouldShowProcessingHint(messages, runId, phase, waitingForUser)
  const expiresAt = activity?.runId === runId ? activity.at + OUTPUT_SILENCE_MS : 0
  const recent = Date.now() < expiresAt
  useEffect(() => {
    if (!eligible || !recent) return
    const timer = window.setTimeout(() => tick(value => value + 1), Math.max(0, expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [eligible, recent, expiresAt])
  return eligible && !recent
}
