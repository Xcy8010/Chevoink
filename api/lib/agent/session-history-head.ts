import type { AgentRunStatus } from '@prisma/client'
import type { AgentHistoryHead } from '../../../shared/contracts/agent-queue.js'

export function sessionHistoryHead(sessionUpdatedAt: Date, latest?: { id: string; status: AgentRunStatus; updatedAt: Date } | null): AgentHistoryHead {
  const terminalRevision = latest && ['paused', 'completed', 'cancelled', 'failed'].includes(latest.status) ? latest.updatedAt.toISOString() : ''
  return { latestRunId: latest?.id ?? null, latestRunStatus: latest?.status ?? null, historyRevision: sessionUpdatedAt.toISOString() + '/' + terminalRevision }
}
