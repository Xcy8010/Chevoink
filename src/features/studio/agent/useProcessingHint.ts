import { useEffect, useState } from 'react'
import { useAgentStore } from './agentStore'
import { shouldShowProcessingHint } from './lib/panel-helpers'
import { activityReportVisibility, type projectActivityGroups } from './lib/activity-groups'
import type { AgentUIMessage } from '../../../../shared/contracts/index.js'

export const OUTPUT_SILENCE_MS = 1500

/** Actual output deltas suppress fallback feedback; an unfinished reasoning
 * part alone cannot. One expiring timer restores feedback even without SSE. */
export function useProcessingHint(messages: AgentUIMessage[], runId: string | null, phase: string, waitingForUser: boolean, enabled = true) {
  const activity = useAgentStore(state => state.lastVisibleOutput)
  const eligible = enabled && shouldShowProcessingHint(messages, runId, phase, waitingForUser)
  return useOutputSilence(eligible, activity?.runId === runId ? activity.at : undefined)
}

function useOutputSilence(eligible: boolean, lastOutputAt?: number) {
  const [, tick] = useState(0)
  const expiresAt = lastOutputAt === undefined ? 0 : lastOutputAt + OUTPUT_SILENCE_MS
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
  const hasStarted = Boolean(runId && (groups.authorSpokeByRun.has(runId) || groups.lastGroupByRun.has(runId)))
  const textOutput = useAgentStore(state => state.lastAuthorTextOutput)
  // Private reasoning and a paragraph held behind a tool can both stream
  // while the author sees only the last settled receipt.
  const reports = textOutput ? groups.reportsByMessage.get(textOutput.messageId) : undefined
  const lastReport = reports && [...reports.keys()].at(-1)
  const hidden = lastReport !== undefined && activityReportVisibility(reports, enabled)?.hidden.has(lastReport)
  const eligible = enabled && hasStarted && shouldShowProcessingHint(messages, runId, phase)
  const silent = useOutputSilence(eligible, !hidden && textOutput?.runId === runId ? textOutput.at : undefined)
  if (!enabled) return undefined
  if (!hasStarted) return '正在思考'
  return silent ? '正在处理…' : undefined
}
