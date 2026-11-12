import { useEffect, useState } from 'react'
import { useAgentStore } from './agentStore'
import { shouldShowProcessingHint } from './lib/panel-helpers'
import { activityWorkingLabel, type projectActivityGroups } from './lib/activity-groups'
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

export function useActivityWorkingLabel(messages: AgentUIMessage[], runId: string | null, phase: string, enabled: boolean,
  groups: ReturnType<typeof projectActivityGroups>) {
  const lastCall = runId ? groups.lastCallByRun.get(runId) : undefined
  // The null opening is an actual author-visible paragraph, not the projected
  // opening shown when the run starts with a tool.
  const wroteOpening = Boolean(runId && !lastCall && groups.openingByRun.get(runId) === null)
  const silent = useProcessingHint(messages, runId, phase, false, enabled && wroteOpening)
  if (!enabled) return undefined
  if (wroteOpening) return silent ? '正在处理…' : undefined
  return activityWorkingLabel(lastCall)
}
