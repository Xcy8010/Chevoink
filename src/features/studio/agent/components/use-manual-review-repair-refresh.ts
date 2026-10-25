import { useCallback, useLayoutEffect, useRef } from 'react'
import { fetchAgentSessionMessages, fetchSessionsRunStatus } from '../agentApi'
import { useAgentStore } from '../agentStore'
import type { ManualReviewRepairStatus } from '../../../../../shared/contracts/manual-review-repair.js'

/** Manual repair has a durable status, not a second replay of the old SSE run. */
export function useManualReviewRepairRefresh({ runId, resumeableRunId, sessionId, disconnect }: {
  runId: string | null; resumeableRunId: string | null; sessionId: string | null; disconnect?: () => void
}) {
  const epoch = useRef(0)
  useLayoutEffect(() => { const owner = ++epoch.current; return () => { epoch.current = owner + 1 } }, [sessionId, runId, resumeableRunId])
  return useCallback((repair?: ManualReviewRepairStatus) => {
    const target = runId ?? resumeableRunId
    if (!target || !sessionId) return
    const owner = epoch.current
    const live = useAgentStore.getState()
    if (live.loadedSessionId === sessionId && (!live.runId || live.runId === target)
      && repair && ['running', 'unknown'].includes(repair.state)) disconnect?.()
    void Promise.all([fetchAgentSessionMessages(sessionId, { runLimit: 50 }), fetchSessionsRunStatus([sessionId])]).then(([payload, remote]) => {
      if (owner !== epoch.current) return
      const current = useAgentStore.getState()
      if (current.loadedSessionId !== sessionId || (current.runId && current.runId !== target)) return
      const status = remote.statuses[sessionId]
      if (!status || status.runId !== target || (payload.activeRunId && payload.activeRunId !== target)) return
      current.restoreMessages(payload.messages, sessionId, payload.todoSnapshot)
      current.resumeRun(target, sessionId, payload.runGoalId)
      useAgentStore.getState().syncRemoteRunStatuses(remote.statuses)
      if (payload.activeRunId === target && ['running', 'queued', 'awaiting_approval'].includes(status.status)) {
        useAgentStore.setState({ phase: status.status === 'awaiting_approval' ? 'awaiting_approval' : 'running' })
      } else {
        useAgentStore.getState().setAuthorEnded(payload.authorEnded ?? null)
        useAgentStore.getState().setRunOutcome(payload.outcome ?? null)
        useAgentStore.getState().noteResumeableRun(payload.resumeRunId ?? null)
      }
    }).catch(() => { /* Keep the visible repair status; never infer completion from a lost refresh. */ })
  }, [runId, resumeableRunId, sessionId, disconnect])
}