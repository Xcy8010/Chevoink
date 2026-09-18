import type {
  AdminAgentEvalResults,
  AdminAgentEvalSuiteRow,
  AdminAgentSessionMessagesPayload,
  AdminAgent3OperationsMetrics,
  AdminAuditLogRow,
  AdminBriefUser,
  AdminCaptchaPayload,
  AdminChapterContentPayload,
  AdminCommentRow,
  AdminConversationRow,
  AdminCorpusDocumentImportResult,
  AdminCorpusSourceRow,
  AdminCreateAgentEvalSampleRequest,
  AdminCreationRecordsIndexPayload,
  AdminCreationRecordsPayload,
  AdminDashboardPayload,
  AdminFeedbackDetailPayload,
  AdminFeedbackListPayload,
  AdminListPayload,
  AdminLoginRequest,
  AdminMePayload,
  AdminMessageRow,
  AdminNovelDetailPayload,
  AdminNovelRow,
  AdminPostDetailPayload,
  AdminPostRow,
  AdminTokenManagementPayload,
  AdminCreditsManagementPayload,
  AdminModelManagementPayload,
  AdminUserDetailPayload,
  AdminUserFavoriteNovelRow,
  AdminUserFollowRow,
  AdminUserRow,
  AgentBlindReviewAssignment,
  AgentBlindReviewSubmission,
  CorpusDocumentImport,
  CorpusSourceCreate,
  FeedbackKind,
  FeedbackStatus,
} from '../../../shared/contracts/index.js'
import { requestJson } from '@/app/api-client'

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '',
  )
  if (entries.length === 0) {
    return ''
  }
  return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`
}

/* ---------------- 认证 ---------------- */

export function getAdminCaptcha(): Promise<AdminCaptchaPayload> {
  return requestJson<AdminCaptchaPayload>('/api/admin/captcha')
}

export function adminLogin(
  payload: AdminLoginRequest,
): Promise<{ admin: { id: string; nickname: string }; tokens: { sessionToken: string } }> {
  return requestJson('/api/admin/auth/login', { method: 'POST', body: JSON.stringify(payload) })
}

/** 手机号登录发码：需人机验证 */
export function adminSendLoginSmsCode(payload: {
  phone: string
  captchaId: string
  captchaAnswer: string
}): Promise<{ ok: boolean; cooldownSeconds: number }> {
  return requestJson('/api/admin/auth/sms/send-code', { method: 'POST', body: JSON.stringify(payload) })
}

/** 绑定手机号发码：需人机验证 */
export function adminSendBindSmsCode(payload: {
  phone: string
  captchaId: string
  captchaAnswer: string
}): Promise<{ ok: boolean; cooldownSeconds: number }> {
  return requestJson('/api/admin/me/sms/send-code', { method: 'POST', body: JSON.stringify(payload) })
}

export function adminBindPhone(payload: { phone: string; code: string }): Promise<{ ok: boolean; phone: string }> {
  return requestJson('/api/admin/me/bind-phone', { method: 'POST', body: JSON.stringify(payload) })
}

export function getAdminMe(): Promise<AdminMePayload> {
  return requestJson<AdminMePayload>('/api/admin/me')
}

export function adminLogout(): Promise<{ ok: boolean }> {
  return requestJson('/api/admin/logout', { method: 'POST', body: '{}' })
}

export function adminChangeMyPassword(
  oldPassword: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return requestJson('/api/admin/me/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  })
}

/* ---------------- 仪表盘 ---------------- */

export function getAdminDashboard(): Promise<AdminDashboardPayload> {
  return requestJson<AdminDashboardPayload>('/api/admin/dashboard')
}

export function getAdminTokenManagement(period: 'today' | 'week' | 'month' = 'today'): Promise<AdminTokenManagementPayload> {
  return requestJson<AdminTokenManagementPayload>(`/api/admin/token-usage?period=${period}`)
}

export function getAdminCreditsManagement(): Promise<AdminCreditsManagementPayload> {
  return requestJson<AdminCreditsManagementPayload>('/api/admin/credits')
}

export function resetAdminUserCredits(userId: string, payload: { captchaId: string; captchaAnswer: string; confirmation: string; requestKey?: string }): Promise<{ stoppedRuns: number }> {
  return requestJson(`/api/admin/credits/users/${userId}/reset`, { method: 'POST', body: JSON.stringify(payload) })
}

export function resetAllAdminCredits(payload: { captchaId: string; captchaAnswer: string; confirmation: string; requestKey?: string }): Promise<{ users: number; stoppedRuns: number }> {
  return requestJson('/api/admin/credits/reset-all', { method: 'POST', body: JSON.stringify(payload) })
}

export function resetSelectedAdminCredits(payload: { userIds: string[]; captchaId: string; captchaAnswer: string; confirmation: string; requestKey?: string }): Promise<{ users: number; stoppedRuns: number }> {
  return requestJson('/api/admin/credits/users/reset-selected', { method: 'POST', body: JSON.stringify(payload) })
}

export function setAdminUserCreditsPaused(userId: string, payload: { paused: boolean; captchaId: string; captchaAnswer: string; confirmation: string }): Promise<{ users: number; paused: boolean; stoppedRuns: number }> {
  return requestJson(`/api/admin/credits/users/${userId}/pause`, { method: 'POST', body: JSON.stringify(payload) })
}

export function setSelectedAdminCreditsPaused(payload: { userIds: string[]; paused: boolean; captchaId: string; captchaAnswer: string; confirmation: string }): Promise<{ users: number; paused: boolean; stoppedRuns: number }> {
  return requestJson('/api/admin/credits/users/pause-selected', { method: 'POST', body: JSON.stringify(payload) })
}

export function setAdminCreditsPaused(payload: { paused: boolean; captchaId: string; captchaAnswer: string; confirmation: string }): Promise<{ paused: boolean; stoppedRuns: number }> {
  return requestJson('/api/admin/credits/pause', { method: 'POST', body: JSON.stringify(payload) })
}

export function getAdminModelManagement(): Promise<AdminModelManagementPayload> {
  return requestJson<AdminModelManagementPayload>('/api/admin/models')
}

export function updateAdminModel(modelId: string, payload: {
  provider?: string; displayName?: string; modelName?: string; baseUrl?: string | null; apiKey?: string
  multiplier?: number; enabled?: boolean; selectable?: boolean; isDefault?: boolean
  reasoningEfforts?: import('../../../shared/contracts').ModelReasoningEffort[]
  defaultReasoningEffort?: import('../../../shared/contracts').ModelReasoningEffort
  visionEnabled?: boolean
  contextWindowTokens?: number
}): Promise<{ ok: true }> {
  return requestJson(`/api/admin/models/${modelId}`, { method: 'PATCH', body: JSON.stringify(payload) })
}

/* ---------------- Agent 3.0 专家盲评 ---------------- */

export function listAdminAgentEvalSuites(): Promise<{ suites: AdminAgentEvalSuiteRow[] }> {
  return requestJson('/api/admin/evals/suites')
}

export function createAdminAgentEvalSuite(payload: {
  name: string
  datasetVersion: string
  rubricVersion: string
}): Promise<AdminAgentEvalSuiteRow> {
  return requestJson('/api/admin/evals/suites', { method: 'POST', body: JSON.stringify(payload) })
}

export function addAdminAgentEvalSample(
  suiteId: string,
  payload: AdminCreateAgentEvalSampleRequest,
): Promise<{ id: string; code: string }> {
  return requestJson(`/api/admin/evals/suites/${suiteId}/samples`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateAdminAgentEvalSuiteStatus(
  suiteId: string,
  status: 'active' | 'completed',
): Promise<AdminAgentEvalSuiteRow> {
  return requestJson(`/api/admin/evals/suites/${suiteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function getNextAdminBlindReview(suiteId?: string): Promise<{ assignment: AgentBlindReviewAssignment | null }> {
  return requestJson(`/api/admin/evals/review/next${buildQueryString({ suiteId })}`)
}

export function submitAdminBlindReview(
  sampleId: string,
  payload: AgentBlindReviewSubmission,
): Promise<{ ok: true }> {
  return requestJson(`/api/admin/evals/samples/${sampleId}/reviews`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getAdminAgentEvalResults(suiteId: string): Promise<AdminAgentEvalResults> {
  return requestJson(`/api/admin/evals/suites/${suiteId}/results`)
}

export function getAdminAgent3OperationsMetrics(): Promise<AdminAgent3OperationsMetrics> {
  return requestJson('/api/admin/agent3/operations')
}

/* ---------------- Agent 3.0 合法文笔库 ---------------- */

export function listAdminCorpusSources(): Promise<{ sources: AdminCorpusSourceRow[] }> {
  return requestJson('/api/admin/craft/sources')
}

export function createAdminCorpusSource(payload: CorpusSourceCreate): Promise<{ source: AdminCorpusSourceRow }> {
  return requestJson('/api/admin/craft/sources', { method: 'POST', body: JSON.stringify(payload) })
}

export function verifyAdminCorpusSource(
  sourceId: string,
  payload: { decision: 'approved' | 'rejected'; auditNote: string },
): Promise<{ source: AdminCorpusSourceRow }> {
  return requestJson(`/api/admin/craft/sources/${sourceId}/verify`, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function importAdminCorpusDocument(
  sourceId: string,
  payload: CorpusDocumentImport,
): Promise<{ document: AdminCorpusDocumentImportResult }> {
  return requestJson(`/api/admin/craft/sources/${sourceId}/documents`, { method: 'POST', body: JSON.stringify(payload) })
}

export function revokeAdminCorpusSource(sourceId: string, reason: string): Promise<{ receipt: { receiptHash: string } }> {
  return requestJson(`/api/admin/craft/sources/${sourceId}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) })
}

/* ---------------- 用户管理 ---------------- */

export function listAdminUsers(input: {
  search?: string
  role?: string
  banned?: 'true' | 'false'
  online?: 'true'
  page: number
  pageSize: number
}): Promise<AdminListPayload<AdminUserRow>> {
  return requestJson(`/api/admin/users${buildQueryString(input)}`)
}

export function getAdminUserDetail(userId: string): Promise<AdminUserDetailPayload> {
  return requestJson<AdminUserDetailPayload>(`/api/admin/users/${userId}`)
}

export function listAdminUserFollowers(
  userId: string,
): Promise<{ user: AdminBriefUser; items: AdminUserFollowRow[]; total: number }> {
  return requestJson(`/api/admin/users/${userId}/followers`)
}

export function listAdminUserFavoriteNovels(
  userId: string,
): Promise<{ user: AdminBriefUser; items: AdminUserFavoriteNovelRow[]; total: number }> {
  return requestJson(`/api/admin/users/${userId}/favorites`)
}

export function getAdminCreationRecords(userId: string): Promise<AdminCreationRecordsPayload> {
  return requestJson<AdminCreationRecordsPayload>(`/api/admin/users/${userId}/creation-records`)
}

/** 免搜索创作记录：仅列出有 Agent 会话记录的作者；分页加载避免一次性拉全量创作者 */
export function getAdminCreationRecordsIndex(
  search?: string,
  page = 1,
  pageSize = 24,
): Promise<AdminCreationRecordsIndexPayload> {
  return requestJson<AdminCreationRecordsIndexPayload>(
    `/api/admin/creation-records${buildQueryString({ search, page, pageSize })}`,
  )
}

/** 单个会话聊天记录：按 run 轮次游标分页，before 传本页最早 run id 加载更早一轮 */
export function getAdminAgentSessionMessages(
  sessionId: string,
  options?: { before?: string; pageSize?: number },
): Promise<AdminAgentSessionMessagesPayload> {
  return requestJson<AdminAgentSessionMessagesPayload>(
    `/api/admin/agent-sessions/${sessionId}/messages${buildQueryString({ before: options?.before, pageSize: options?.pageSize })}`,
  )
}

export function banAdminUser(userId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/users/${userId}/ban`, { method: 'POST', body: '{}' })
}

export function unbanAdminUser(userId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/users/${userId}/unban`, { method: 'POST', body: '{}' })
}

export function setAdminUserRole(userId: string, role: 'user' | 'admin'): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/users/${userId}/role`, { method: 'POST', body: JSON.stringify({ role }) })
}

export function resetAdminUserPassword(userId: string): Promise<{ tempPassword: string }> {
  return requestJson(`/api/admin/users/${userId}/reset-password`, { method: 'POST', body: '{}' })
}

/* ---------------- 作品管理 ---------------- */

export function listAdminNovels(input: {
  search?: string
  status?: string
  page: number
  pageSize: number
}): Promise<AdminListPayload<AdminNovelRow>> {
  return requestJson(`/api/admin/novels${buildQueryString(input)}`)
}

export function getAdminNovelDetail(novelId: string): Promise<AdminNovelDetailPayload> {
  return requestJson<AdminNovelDetailPayload>(`/api/admin/novels/${novelId}`)
}

export function getAdminChapterContent(novelId: string, chapterId: string): Promise<AdminChapterContentPayload> {
  return requestJson<AdminChapterContentPayload>(`/api/admin/novels/${novelId}/chapters/${chapterId}`)
}

export function takeDownAdminNovel(novelId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/novels/${novelId}/take-down`, { method: 'POST', body: '{}' })
}

export function restoreAdminNovel(novelId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/novels/${novelId}/restore`, { method: 'POST', body: '{}' })
}

export function deleteAdminNovel(novelId: string, confirmTitle: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/novels/${novelId}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmTitle }),
  })
}

export function deleteAdminChapter(chapterId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/chapters/${chapterId}`, { method: 'DELETE' })
}

/* ---------------- 帖子与评论管理 ---------------- */

export function listAdminPosts(input: {
  search?: string
  page: number
  pageSize: number
}): Promise<AdminListPayload<AdminPostRow>> {
  return requestJson(`/api/admin/posts${buildQueryString(input)}`)
}

export function deleteAdminPost(postId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/posts/${postId}`, { method: 'DELETE' })
}

export function getAdminPostDetail(postId: string): Promise<AdminPostDetailPayload> {
  return requestJson<AdminPostDetailPayload>(`/api/admin/posts/${postId}`)
}

export function listAdminComments(input: {
  category?: string
  search?: string
  page: number
  pageSize: number
}): Promise<AdminListPayload<AdminCommentRow>> {
  return requestJson(`/api/admin/comments${buildQueryString(input)}`)
}

export function deleteAdminComment(commentId: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/admin/comments/${commentId}`, { method: 'DELETE' })
}

/* ---------------- 用户反馈 / 建议 ---------------- */

export function listAdminFeedbacks(input: {
  status?: FeedbackStatus
  kind?: FeedbackKind
  search?: string
  page: number
  pageSize: number
}): Promise<AdminFeedbackListPayload> {
  return requestJson(`/api/admin/feedback${buildQueryString(input)}`)
}

export function getAdminFeedbackDetail(feedbackId: string): Promise<AdminFeedbackDetailPayload> {
  return requestJson<AdminFeedbackDetailPayload>(`/api/admin/feedback/${feedbackId}`)
}

/** 标记已采纳/已忽略；status 传 pending 即撤销回待处理 */
export function setAdminFeedbackStatus(feedbackId: string, status: FeedbackStatus): Promise<{ ok: true }> {
  return requestJson(`/api/admin/feedback/${feedbackId}/status`, { method: 'POST', body: JSON.stringify({ status }) })
}

/* ---------------- 审计日志 ---------------- */

export function listAdminAuditLogs(input: {
  action?: string
  targetType?: string
  page: number
  pageSize: number
}): Promise<AdminListPayload<AdminAuditLogRow>> {
  return requestJson(`/api/admin/logs${buildQueryString(input)}`)
}

/* ---------------- 消息管理 ---------------- */

export function listAdminConversations(input: {
  search?: string
  page: number
  pageSize: number
}): Promise<AdminListPayload<AdminConversationRow>> {
  return requestJson(`/api/admin/conversations${buildQueryString(input)}`)
}

export function getAdminConversationMessages(conversationId: string): Promise<{ messages: AdminMessageRow[] }> {
  return requestJson(`/api/admin/conversations/${conversationId}/messages`)
}
