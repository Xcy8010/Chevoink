import type { StartAgentLoopRunRequest } from './index.js'

export type AgentQueuedRequestView = {
  id: string
  sessionId: string
  prompt: string
  attachmentCount: number
  status: string
  revision: number
  error: string | null
}
export type AgentHistoryHead = {
  latestRunId: string | null
  latestRunStatus: import('./models.js').AgentRunStatus | null
  historyRevision: string
}
export type AgentQueueSnapshot = {
  items: AgentQueuedRequestView[]
  latestRunId: string | null
  latestRunStatus?: import('./models.js').AgentRunStatus | null
  historyRevision?: string
}
export type AgentQueueAction = 'edit' | 'delete' | 'steer' | 'new' | 'fork'
export type EnqueueAgentRequest = { id: string; input: StartAgentLoopRunRequest }
