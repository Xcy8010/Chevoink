import { buildApiUrl } from '@/app/api-base'
import { buildAuthHeader } from '@/lib/auth-token'
import type { AgentQueueAction, AgentQueueSnapshot, EnqueueAgentRequest } from '../../../../shared/contracts/agent-queue.js'
import type {
  AgentSession,
  AgentSessionRunStatusPayload,
  AgentTodoItem,
  AgentUIMessage,
  ApiResponse,
  ContextDetail,
  ContextState,
  CreditModelTier,
  ModelReasoningEffort,
  ResolveAgentApprovalRequest,
  ResolveAgentQuestionRequest,
  AgentRollbackImpactPreview,
  AgentRollbackResult,
  StartAgentLoopRunRequest,
  StartAgentLoopRunResponse,
  StoryMemoryCard,
  StoryMemoryList,
  StoryMemorySets,
  UploadAgentAttachmentRequest,
  UploadAgentAttachmentResponse,
  AgentEvalComparisonView,
  AgentScheduleView,
  AgentSessionToolPolicy,
  AgentSandboxMode,
  AgentSubtaskRole,
  AgentSubtaskLogsView,
  AgentSubtaskView,
  StoryBranchDiffView,
  StoryBranchView,
} from '../../../../shared/contracts/index.js'

/** Agent Loop 新链路 API 客户端（与旧 api.ts 并行，迁移完成后旧链路下线） */

/** 带 HTTP 状态码与业务错误码的请求错误：供调用方区分「会话已不存在」等可自愈场景 */
export class AgentApiError extends Error {
  status: number
  code: string | null

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'AgentApiError'
    this.status = status
    this.code = code
  }
}

async function requestData<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeader(),
      ...(options?.headers ?? {}),
    },
  })

  const rawText = await response.text()
  let result: ApiResponse<T> | null = null

  if (rawText) {
    try {
      result = JSON.parse(rawText) as ApiResponse<T>
    } catch {
      result = null
    }
  }

  if (!response.ok || !result || !result.success) {
    const message =
      result && typeof result === 'object' && 'error' in result
        ? result.error.message
        : response.status >= 500
          ? '服务暂时不可用，请稍后再试。'
          : '请求失败，请稍后再试。'
    const code = result && typeof result === 'object' && 'error' in result ? result.error.code : null
    throw new AgentApiError(message, response.status, code)
  }

  return result.data
}

export function startAgentLoopRun(input: StartAgentLoopRunRequest): Promise<StartAgentLoopRunResponse> {
  return requestData<StartAgentLoopRunResponse>('/api/agent/runs', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** 上传单个对话附件（选件即传，run 请求只携带返回的元数据） */
export function uploadAgentAttachment(
  input: UploadAgentAttachmentRequest,
): Promise<UploadAgentAttachmentResponse> {
  return requestData<UploadAgentAttachmentResponse>('/api/agent/attachments', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function stopAgentLoopRun(runId: string): Promise<{ stopped: boolean }> {
  return requestData<{ stopped: boolean }>(`/api/agent/runs/${runId}/stop`, { method: 'POST' })
}

/** 续跑时携带的模型选择：缺省沿用原任务档位 */
export type ContinueAgentLoopRunModel = {
  modelTier: CreditModelTier
  customModelId?: string | null
  reasoningEffort?: ModelReasoningEffort
}

export function continueAgentLoopRun(runId: string, model?: ContinueAgentLoopRunModel | null): Promise<StartAgentLoopRunResponse> {
  return requestData<StartAgentLoopRunResponse>(`/api/agent/runs/${runId}/continue`, {
    method: 'POST',
    ...(model ? { body: JSON.stringify(model) } : {}),
  })
}

export function resolveAgentApproval(
  runId: string,
  input: ResolveAgentApprovalRequest,
): Promise<{ resolved: boolean }> {
  return requestData<{ resolved: boolean }>(`/api/agent/runs/${runId}/approvals`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function resolveAgentQuestion(
  runId: string,
  input: ResolveAgentQuestionRequest,
): Promise<{ resolved: boolean }> {
  return requestData<{ resolved: boolean }>(`/api/agent/runs/${runId}/questions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** 会话消息 + activeRunId（服务端仍在进行的 run，刷新后据此续接直播）；
 * runLimit 时按 run 轮次分页（50 轮/页，用户端手动加载更早），不传则全量 */
export type AgentSessionMessagesPagination = { hasMore: boolean; earliestRunStartedAt: string | null }
export type AgentAuthorEndedPayload = { fulfilled: boolean; todoItems?: AgentTodoItem[] }
/** 分支溯源：非空说明本任务是副本，forkedAt 之后的对话属于分支内新增 */
export type AgentSessionForkInfo = { forkedFromSessionId: string; forkedFromMessageId: string | null; forkedAt: string | null }

export function fetchAgentSessionMessages(
  sessionId: string,
  options?: { runLimit?: number; beforeRunStartedAt?: string | null },
): Promise<{ messages: AgentUIMessage[]; activeRunId: string | null; resumeRunId?: string | null; authorEnded?: AgentAuthorEndedPayload | null; pagination?: AgentSessionMessagesPagination; fork?: AgentSessionForkInfo | null }> {
  const query = new URLSearchParams()
  if (options?.runLimit != null) query.set('runLimit', String(options.runLimit))
  if (options?.beforeRunStartedAt) query.set('before', options.beforeRunStartedAt)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return requestData<{ messages: AgentUIMessage[]; activeRunId: string | null; resumeRunId?: string | null; authorEnded?: AgentAuthorEndedPayload | null; pagination?: AgentSessionMessagesPagination; fork?: AgentSessionForkInfo | null }>(
    `/api/agent/sessions/${sessionId}/messages${suffix}`,
  )
}

/** 历史任务对话列表（后端已过滤空且未命名的会话） */
export function fetchAgentSessions(novelId?: string, options?: { query?: string; includeArchived?: boolean }): Promise<{ items: AgentSession[] }> {
  const query = new URLSearchParams()
  if (novelId) query.set('novelId', novelId)
  if (options?.query?.trim()) query.set('q', options.query.trim())
  if (options?.includeArchived) query.set('includeArchived', 'true')
  return requestData<{ items: AgentSession[] }>(
    `/api/agent/sessions?${query.toString()}`,
  )
}

export function enqueueAgentRequest(input: EnqueueAgentRequest): Promise<{ id: string }> {
  return requestData('/api/agent/queue', { method: 'POST', body: JSON.stringify(input) })
}
export function fetchAgentQueue(sessionId: string): Promise<AgentQueueSnapshot> {
  return requestData(`/api/agent/sessions/${sessionId}/queue`)
}
export function actOnAgentQueue(sessionId: string, id: string, action: AgentQueueAction, revision: number, prompt?: string): Promise<{ session?: AgentSession }> {
  return requestData(`/api/agent/sessions/${sessionId}/queue/${id}`, { method: 'POST', body: JSON.stringify({ action, revision, prompt }) })
}

/** 侧栏任务窗口状态轮询：批量查各会话最新 run 状态（运行中/挂起），驱动绿黄红点与转圈 */
export function fetchSessionsRunStatus(sessionIds: string[]): Promise<AgentSessionRunStatusPayload> {
  if (sessionIds.length === 0) return Promise.resolve({ statuses: {} })
  return requestData<AgentSessionRunStatusPayload>(`/api/agent/sessions/run-status?ids=${encodeURIComponent(sessionIds.join(','))}`)
}

export function fetchAgentContextState(sessionId: string): Promise<ContextState> {
  return requestData<ContextState>(`/api/agent/sessions/${sessionId}/context-state`)
}

export function compactAgentContext(sessionId: string): Promise<{ checkpoint: ContextState['checkpoint']; state: ContextState }> {
  return requestData<{ checkpoint: ContextState['checkpoint']; state: ContextState }>(
    `/api/agent/sessions/${sessionId}/compact`,
    { method: 'POST' },
  )
}

/** 上下文详情弹窗：三视图分页拉取（records 倒序 / checkpoints 倒序 / final 窗口正序） */
export function fetchAgentContextDetail(
  sessionId: string,
  view: 'records' | 'checkpoints' | 'final',
  page: number,
  pageSize = 20,
): Promise<ContextDetail> {
  return requestData<ContextDetail>(
    `/api/agent/sessions/${sessionId}/context-detail?view=${view}&page=${page}&pageSize=${pageSize}`,
  )
}

/** 记忆中心：分页拉取 Agent 沉淀的创作记忆卡片 */
export function fetchStoryMemories(
  novelId: string,
  options?: { memoryType?: string; title?: string; page?: number; pageSize?: number },
): Promise<StoryMemoryList> {
  const query = new URLSearchParams()
  if (options?.memoryType) query.set('memoryType', options.memoryType)
  if (options?.title !== undefined) query.set('title', options.title)
  query.set('page', String(options?.page ?? 1))
  query.set('pageSize', String(options?.pageSize ?? 12))
  return requestData<StoryMemoryList>(`/api/agent/novels/${novelId}/memories?${query.toString()}`)
}

/** 记忆卡片集封面墙：每类型一叠牌的数量/最近更新/标题预览，一次拿全 */
export function fetchStoryMemorySets(novelId: string): Promise<StoryMemorySets> {
  return requestData<StoryMemorySets>(`/api/agent/novels/${novelId}/memory-sets`)
}

/** 记忆中心：作者就地编辑卡片（后端记录修订历史并重算向量，后续写作按最新设定召回） */
export function updateStoryMemory(
  memoryId: string,
  patch: { title?: string; content?: string; importance?: number; expectedVersion: number },
): Promise<{ memory: StoryMemoryCard }> {
  return requestData<{ memory: StoryMemoryCard }>(`/api/agent/memory/${memoryId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteStoryMemory(memoryId: string, expectedVersion: number): Promise<{ id: string; deleted: boolean }> {
  return requestData(`/api/agent/memory/${memoryId}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion }) })
}

export type MemoryReviewItem = {
  id: string
  title: string
  content: string
  status: string
  reviewStatus: string
  confidence: number
  evidence: Array<{ id: string; sourceType: string; sourceId: string; revision: number | null }>
}

export function fetchMemoryReviewInbox(novelId: string): Promise<{ items: MemoryReviewItem[] }> {
  return requestData<{ items: MemoryReviewItem[] }>(`/api/agent/novels/${novelId}/memory-review`)
}

export function resolveMemoryReviewItem(memoryId: string, accepted: boolean): Promise<{ memory: MemoryReviewItem }> {
  return requestData<{ memory: MemoryReviewItem }>(`/api/agent/memory/${memoryId}/review`, {
    method: 'POST', body: JSON.stringify({ accepted }),
  })
}

export function resolveQualityFindingFeedback(
  findingId: string,
  accepted: boolean,
  reason?: string,
): Promise<{ finding: { id: string; authorFeedback: 'accepted' | 'rejected' | null } }> {
  return requestData<{ finding: { id: string; authorFeedback: 'accepted' | 'rejected' | null } }>(`/api/agent/quality-findings/${findingId}/feedback`, {
    method: 'POST', body: JSON.stringify({ accepted, reason }),
  })
}

export type QualityReportState = {
  id: string
  chapterId: string
  chapterRevision: number
  status: string
  repairRound: number
  findings: Array<{ id: string; disposition: 'pending' | 'selected' | 'repaired'; authorFeedback: 'accepted' | 'rejected' | null }>
}

export function fetchQualityReportState(reportId: string): Promise<{ report: QualityReportState }> {
  return requestData<{ report: QualityReportState }>(`/api/agent/quality-reports/${reportId}`)
}

export function renameAgentSession(sessionId: string, title: string): Promise<{ session: AgentSession }> {
  return requestData<{ session: AgentSession }>(`/api/agent/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export function updateAgentSessionSettings(sessionId: string, patch: { status?: 'active' | 'archived'; pinned?: boolean; toolPolicy?: AgentSessionToolPolicy; sandboxMode?: AgentSandboxMode }): Promise<{ session: AgentSession }> {
  return requestData<{ session: AgentSession }>(`/api/agent/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function fetchStoryBranches(novelId: string): Promise<{ items: StoryBranchView[] }> {
  return requestData(`/api/agent/branches?novelId=${encodeURIComponent(novelId)}`)
}
export function createStoryBranchRequest(input: { novelId: string; chapterId: string; sourceRunId?: string | null; name: string }): Promise<{ item: StoryBranchView }> {
  return requestData('/api/agent/branches', { method: 'POST', body: JSON.stringify(input) })
}
export function updateStoryBranchRequest(branchId: string, patch: { name?: string; content?: string }): Promise<{ item: StoryBranchView }> {
  return requestData(`/api/agent/branches/${branchId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}
export function fetchStoryBranchDiff(branchId: string): Promise<{ diff: StoryBranchDiffView }> {
  return requestData(`/api/agent/branches/${branchId}/diff`)
}
export function mergeStoryBranchRequest(branchId: string): Promise<{ item: StoryBranchView }> {
  return requestData(`/api/agent/branches/${branchId}/merge`, { method: 'POST' })
}

export function fetchAgentSubtasks(novelId: string): Promise<{ items: AgentSubtaskView[] }> {
  return requestData(`/api/agent/subtasks?novelId=${encodeURIComponent(novelId)}`)
}
export function createAgentSubtaskRequest(input: { novelId: string; parentSessionId?: string | null; chapterId?: string | null; name: string; role: AgentSubtaskRole; triggerCondition: string; prompt: string }): Promise<{ item: AgentSubtaskView }> {
  return requestData('/api/agent/subtasks', { method: 'POST', body: JSON.stringify(input) })
}
export function updateAgentSubtaskRequest(subtaskId: string, input: { name?: string; role?: AgentSubtaskRole; triggerCondition?: string; prompt?: string; enabled?: boolean }): Promise<{ item: AgentSubtaskView }> {
  return requestData(`/api/agent/subtasks/${subtaskId}`, { method: 'PATCH', body: JSON.stringify(input) })
}
export function deleteAgentSubtaskRequest(subtaskId: string): Promise<{ deleted: true }> {
  return requestData(`/api/agent/subtasks/${subtaskId}`, { method: 'DELETE' })
}
export function fetchAgentSubtaskLogs(subtaskId: string): Promise<AgentSubtaskLogsView> {
  return requestData(`/api/agent/subtasks/${subtaskId}/logs`)
}
export function cancelAgentSubtaskRequest(subtaskId: string): Promise<{ item: AgentSubtaskView }> {
  return requestData(`/api/agent/subtasks/${subtaskId}/cancel`, { method: 'POST' })
}

export function fetchAgentSchedules(novelId: string): Promise<{ items: AgentScheduleView[] }> {
  return requestData(`/api/agent/schedules?novelId=${encodeURIComponent(novelId)}`)
}
export function createAgentScheduleRequest(input: { novelId: string; sessionId: string; name: string; prompt: string; cadenceMinutes: number }): Promise<{ item: AgentScheduleView }> {
  return requestData('/api/agent/schedules', { method: 'POST', body: JSON.stringify(input) })
}
export function updateAgentScheduleRequest(scheduleId: string, patch: { status?: 'active' | 'paused'; nextRunAt?: string }): Promise<{ item: AgentScheduleView }> {
  return requestData(`/api/agent/schedules/${scheduleId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function fetchEvalComparisons(novelId: string): Promise<{ items: AgentEvalComparisonView[] }> {
  return requestData(`/api/agent/eval-comparisons?novelId=${encodeURIComponent(novelId)}`)
}
export function createEvalComparisonRequest(input: { novelId: string; name: string; runIds: string[] }): Promise<{ item: AgentEvalComparisonView }> {
  return requestData('/api/agent/eval-comparisons', { method: 'POST', body: JSON.stringify(input) })
}

export function deleteAgentSession(sessionId: string): Promise<{ sessionId: string; deleted: true }> {
  return requestData<{ sessionId: string; deleted: true }>(`/api/agent/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

/** 切任务分支：复制一份同名带角标的任务，传 fromMessageId 则只复制到该条对话为止 */
export function forkAgentSession(
  sessionId: string,
  fromMessageId?: string,
): Promise<{ session: AgentSession; sourceSessionId: string; copiedRunCount: number; copiedMessageCount: number }> {
  return requestData(`/api/agent/sessions/${sessionId}/fork`, {
    method: 'POST',
    body: JSON.stringify(fromMessageId ? { fromMessageId } : {}),
  })
}

/** 删除某轮对话（按消息所属 run 整轮删除，不恢复已写入内容） */
export function deleteAgentSessionMessage(
  sessionId: string,
  messageId: string,
): Promise<{ deleted: true; runId: string }> {
  return requestData<{ deleted: true; runId: string }>(
    `/api/agent/sessions/${sessionId}/messages/${messageId}`,
    { method: 'DELETE' },
  )
}

/** 回退到某轮对话之前：逆序恢复写操作快照并删除该轮及之后的对话；已发布章节保留不改动 */
export function rollbackAgentSessionMessage(
  sessionId: string,
  messageId: string,
): Promise<AgentRollbackResult> {
  return requestData<AgentRollbackResult>(
    `/api/agent/sessions/${sessionId}/messages/${messageId}/rollback`,
    { method: 'POST' },
  )
}

/** 回退影响预览：确认弹窗展示将删除/还原/保留的章节与对话记录（与服务端执行同一分类逻辑） */
export function fetchRollbackImpactPreview(
  sessionId: string,
  messageId: string,
): Promise<AgentRollbackImpactPreview> {
  return requestData<AgentRollbackImpactPreview>(
    `/api/agent/sessions/${sessionId}/messages/${messageId}/rollback-preview`,
  )
}

export function buildAgentStreamUrl(runId: string, sinceSeq?: number): string {
  const suffix = sinceSeq && sinceSeq > 0 ? `?since=${sinceSeq}` : ''
  return buildApiUrl(`/api/agent/runs/${runId}/stream${suffix}`)
}
