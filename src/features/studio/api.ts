import { buildApiUrl } from '@/app/api-base'
import { buildAuthHeader } from '@/lib/auth-token'
import type {
  AgentActionResultPayload,
  ApplyChangeSetRequest,
  ApiResponse,
  Chapter,
  ChangeSet,
  CreateChapterRequest,
  CreateVolumeRequest,
  DeleteVolumeRequest,
  CreateNovelRequest,
  CreateNovelResponse,
  CreateAgentSessionResponse,
  DeleteAgentSessionResponse,
  DeleteNovelResponse,
  DeleteChapterResponse,
  GenerateCoverImageRequest,
  GenerateCoverImageResponse,
  GenerateCoverPromptRequest,
  GenerateCoverPromptResponse,
  GetChapterResponse,
  ListAgentSessionHistoryResponse,
  ListAgentSessionsResponse,
  Novel,
  PublishNovelRequest,
  PublishNovelResponse,
  StudioPayload,
  Volume,
  UploadNovelCoverRequest,
  UploadNovelCoverResponse,
  UpdateChapterRequest,
  UpdateVolumeRequest,
  MoveChapterRequest,
  MoveVolumeRequest,
  SplitChapterRequest,
  MergeChaptersRequest,
  MemoryGraph,
  MemoryGraphJob,
  MemoryGraphJobStatus,
  NovelSkillsPayload,
  AgentSkillTestResult,
  AgentSkillDetail,
  CreateNovelSkillRequest,
  CreateNovelSkillVersionRequest,
  ImportThirdPartySkillRequest,
  TestNovelSkillRequest,
  StructureReport,
  BulkReplacePreviewRequest,
  ProjectSearchRequest,
  ProjectSearchResult,
  UpdateAgentSessionRequest,
  UpdateAgentSessionResponse,
  UpdateNovelRequest,
  UpdateNovelSkillRequest,
  AuthorStyleProfileView,
  StyleSampleRequest,
  ResearchWorkbenchPayload,
  AgentDataControlPatch,
  AgentDataControlView,
  SkillShareInviteView,
  SkillSharePayload,
} from '../../../shared/contracts/index.js'

type RequestDataOptions = RequestInit & {
  timeoutMs?: number
}

export type AgentSessionHistoryItem = AgentActionResultPayload

function normalizeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return '请求超时，请稍后再试。'
    }

    return error.message || '请求失败，请稍后再试。'
  }

  return '请求失败，请稍后再试。'
}

function normalizeResponseError(status: number, message?: string): string {
  if (status === 401 || status === 403) {
    return '登录状态已失效，请重新登录后再试。'
  }

  if (status >= 500) {
    return '服务暂时不可用，请稍后再试。'
  }

  return message || '请求失败，请稍后再试。'
}

export async function requestData<T>(path: string, options?: RequestDataOptions): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? 30000
  const timeoutId =
    timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const response = await fetch(buildApiUrl(path), {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeader(),
        ...(options?.headers ?? {}),
      },
      ...(timeoutMs > 0 ? { signal: controller.signal } : {}),
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

    if (!response.ok) {
      const message =
        result && typeof result === 'object' && 'error' in result
          ? result.error.message
          : rawText || undefined
      throw new Error(normalizeResponseError(response.status, message))
    }

    if (!result || !result.success) {
      const message =
        result && typeof result === 'object' && 'error' in result
          ? result.error.message
          : '服务返回异常，请稍后再试。'
      throw new Error(message)
    }

    return result.data
  } catch (error) {
    throw new Error(normalizeFetchError(error))
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  }
}

export async function listWritingAgentSessions(novelId: string): Promise<ListAgentSessionsResponse['data']['items']> {
  const data = await requestData<ListAgentSessionsResponse['data']>(
    `/api/agent/sessions?novelId=${encodeURIComponent(novelId)}`,
  )
  return data.items
}

export async function createWritingAgentSession(
  novelId: string,
  title?: string,
): Promise<CreateAgentSessionResponse['data']['session']> {
  const data = await requestData<CreateAgentSessionResponse['data']>('/api/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({
      novelId,
      title,
    }),
  })

  return data.session
}

export async function updateWritingAgentSession(
  sessionId: string,
  payload: UpdateAgentSessionRequest,
): Promise<UpdateAgentSessionResponse['data']['session']> {
  const data = await requestData<UpdateAgentSessionResponse['data']>(`/api/agent/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

  return data.session
}

export async function deleteWritingAgentSession(
  sessionId: string,
): Promise<DeleteAgentSessionResponse['data']> {
  return requestData<DeleteAgentSessionResponse['data']>(`/api/agent/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

export async function getWritingAgentSessionHistory(
  sessionId: string,
): Promise<ListAgentSessionHistoryResponse['data']['items']> {
  const data = await requestData<ListAgentSessionHistoryResponse['data']>(
    `/api/agent/sessions/${sessionId}/history`,
  )
  return data.items
}

export type NovelPlanFileItem = {
  id: string
  runId: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  orderIndex: number | null
}

/** 计划文件夹：作品维度拉取已存入云端的创作计划（跨会话聚合） */
export async function listNovelPlanFiles(novelId: string): Promise<NovelPlanFileItem[]> {
  const data = await requestData<{ items: NovelPlanFileItem[] }>(
    `/api/agent/plans?novelId=${encodeURIComponent(novelId)}`,
  )
  return data.items
}

/** 计划文件夹：手工新建一份空白计划 */
export async function createNovelPlanFile(
  novelId: string,
  title?: string,
): Promise<NovelPlanFileItem> {
  const data = await requestData<{ item: NovelPlanFileItem }>('/api/agent/plans', {
    method: 'POST',
    body: JSON.stringify({ novelId, ...(title ? { title } : {}) }),
  })
  return data.item
}

/** 计划文件夹：同步改名/改正文，saved=false 从云端文件夹移除 */
export async function updateNovelPlanFile(
  artifactId: string,
  patch: { title?: string; content?: string; saved?: boolean; position?: number },
): Promise<NovelPlanFileItem> {
  const data = await requestData<{ item: NovelPlanFileItem }>(`/api/agent/plans/${artifactId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return data.item
}

export function getStudioPayload(novelId: string): Promise<StudioPayload> {
  return requestData<StudioPayload>(`/api/novels/${novelId}/studio`)
}

export async function getNovelMemoryGraph(novelId: string): Promise<MemoryGraph> {
  const data = await requestData<{ graph: MemoryGraph }>(`/api/agent/novels/${novelId}/memory-graph`)
  return data.graph
}

export async function syncNovelMemoryGraph(novelId: string, force = false): Promise<{ jobId: string; status: MemoryGraphJobStatus }> {
  // 手动刷新改为异步任务：立即返回 jobId，前端轮询 getMemoryGraphJob 直到完成，避免同步等待 AI 重建到超时。
  const data = await requestData<{ jobId: string; status: MemoryGraphJobStatus }>(`/api/agent/novels/${novelId}/memory-graph/sync`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  })
  return data
}

export async function getMemoryGraphJob(novelId: string, jobId: string): Promise<MemoryGraphJob> {
  const data = await requestData<{ job: MemoryGraphJob }>(`/api/agent/novels/${novelId}/memory-graph/sync/${jobId}`)
  return data.job
}

export function getNovelSkills(novelId: string): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills`)
}

export async function getResearchWorkbenchApi(novelId: string): Promise<ResearchWorkbenchPayload> {
  const data = await requestData<{ workbench: ResearchWorkbenchPayload }>(`/api/agent/novels/${novelId}/research-workbench`)
  return data.workbench
}

export async function updateAgentDataControlApi(novelId: string, patch: AgentDataControlPatch): Promise<AgentDataControlView> {
  const data = await requestData<{ dataControl: AgentDataControlView }>(`/api/agent/novels/${novelId}/agent-data-control`, {
    method: 'PATCH', body: JSON.stringify(patch),
  })
  return data.dataControl
}

export async function getAuthorStyleProfileApi(novelId: string): Promise<AuthorStyleProfileView | null> {
  const data = await requestData<{ profile: AuthorStyleProfileView | null }>(`/api/agent/novels/${novelId}/style-profile`)
  return data.profile
}

export async function extractAuthorStyleProfileApi(novelId: string, input: StyleSampleRequest): Promise<{ profileId: string; sourceId: string; documentId: string; stats: AuthorStyleProfileView['stats'] }> {
  const data = await requestData<{ profile: { profileId: string; sourceId: string; documentId: string; stats: AuthorStyleProfileView['stats'] } }>(`/api/agent/novels/${novelId}/style-profile`, {
    method: 'POST', body: JSON.stringify(input),
  })
  return data.profile
}

export async function revokeAuthorStyleSourceApi(novelId: string, sourceId: string, reason: string): Promise<{ receiptHash: string }> {
  const data = await requestData<{ receipt: { receiptHash: string } }>(`/api/agent/novels/${novelId}/corpus-sources/${sourceId}`, {
    method: 'DELETE', body: JSON.stringify({ reason }),
  })
  return data.receipt
}

export function updateNovelSkill(
  novelId: string,
  skillId: string,
  patch: UpdateNovelSkillRequest,
): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function createSkillShareInviteApi(novelId: string, skillId: string, input: { recipientAccount: string; version?: string; message?: string }): Promise<SkillShareInviteView> {
  const data = await requestData<{ invite: SkillShareInviteView }>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}/share-invites`, {
    method: 'POST', body: JSON.stringify(input),
  })
  return data.invite
}

export function listSkillShareInvitesApi(): Promise<SkillSharePayload> {
  return requestData<SkillSharePayload>('/api/agent/skill-share-invites')
}

export function acceptSkillShareInviteApi(inviteId: string, destinationNovelId: string): Promise<{ skills: NovelSkillsPayload; invites: SkillSharePayload }> {
  return requestData<{ skills: NovelSkillsPayload; invites: SkillSharePayload }>(`/api/agent/skill-share-invites/${inviteId}/accept`, {
    method: 'POST', body: JSON.stringify({ destinationNovelId }),
  })
}

export function declineSkillShareInviteApi(inviteId: string): Promise<SkillSharePayload> {
  return requestData<SkillSharePayload>(`/api/agent/skill-share-invites/${inviteId}/decline`, { method: 'POST' })
}

export function createNovelSkill(novelId: string, payload: CreateNovelSkillRequest): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills`, {
    method: 'POST', body: JSON.stringify(payload),
  })
}

export function importThirdPartyNovelSkillApi(novelId: string, payload: ImportThirdPartySkillRequest): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills/import`, {
    method: 'POST', body: JSON.stringify(payload),
  })
}

export async function getNovelSkillDetailApi(novelId: string, skillId: string, version?: string): Promise<AgentSkillDetail> {
  const query = version ? `?version=${encodeURIComponent(version)}` : ''
  const data = await requestData<{ detail: AgentSkillDetail }>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}/detail${query}`)
  return data.detail
}

export function createNovelSkillVersion(
  novelId: string,
  skillId: string,
  payload: CreateNovelSkillVersionRequest,
): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}/versions`, {
    method: 'POST', body: JSON.stringify(payload),
  })
}

export async function testNovelSkillApi(
  novelId: string,
  skillId: string,
  payload: TestNovelSkillRequest,
): Promise<AgentSkillTestResult> {
  const data = await requestData<{ result: AgentSkillTestResult }>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}/test`, {
    method: 'POST', body: JSON.stringify(payload),
  })
  return data.result
}

export function publishNovelSkill(
  novelId: string,
  skillId: string,
  version: string,
): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}/publish`, {
    method: 'POST', body: JSON.stringify({ version }),
  })
}

export function deleteNovelSkillApi(novelId: string, skillId: string): Promise<NovelSkillsPayload> {
  return requestData<NovelSkillsPayload>(`/api/agent/novels/${novelId}/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' })
}

/** 发布作品：同时批量发布选中章节并设置可见范围 */
export async function publishNovelWorkspace(
  novelId: string,
  payload: PublishNovelRequest,
): Promise<PublishNovelResponse['data']> {
  return requestData<PublishNovelResponse['data']>(`/api/novels/${novelId}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function createNovelWorkspace(payload: CreateNovelRequest): Promise<Novel> {
  const data = await requestData<CreateNovelResponse['data']>('/api/novels', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return data.novel
}

export async function getChapterContent(novelId: string, chapterId: string): Promise<Chapter> {
  const data = await requestData<GetChapterResponse['data']>(
    `/api/novels/${novelId}/chapters/${chapterId}`,
  )

  return data.chapter
}

export async function updateNovelMeta(
  novelId: string,
  payload: UpdateNovelRequest,
): Promise<Novel> {
  const data = await requestData<{ novel: Novel }>(`/api/novels/${novelId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

  return data.novel
}

export async function uploadNovelCover(
  novelId: string,
  payload: UploadNovelCoverRequest,
): Promise<UploadNovelCoverResponse['data']> {
  return requestData<UploadNovelCoverResponse['data']>(`/api/novels/${novelId}/cover`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export async function deleteNovelWorkspace(novelId: string): Promise<void> {
  await requestData<DeleteNovelResponse['data']>(`/api/novels/${novelId}`, {
    method: 'DELETE',
  })
}

export async function createChapterDraft(
  novelId: string,
  payload: CreateChapterRequest,
): Promise<Chapter> {
  const data = await requestData<{ chapter: Chapter }>(`/api/novels/${novelId}/chapters`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return data.chapter
}

export async function createVolume(
  novelId: string,
  payload: CreateVolumeRequest,
): Promise<Volume> {
  const data = await requestData<{ volume: Volume }>(`/api/novels/${novelId}/volumes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.volume
}

export async function updateVolume(
  novelId: string,
  volumeId: string,
  payload: UpdateVolumeRequest,
): Promise<Volume> {
  const data = await requestData<{ volume: Volume }>(`/api/novels/${novelId}/volumes/${volumeId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
  return data.volume
}

export async function moveVolume(
  novelId: string,
  volumeId: string,
  payload: MoveVolumeRequest,
): Promise<Volume> {
  const data = await requestData<{ volume: Volume }>(`/api/novels/${novelId}/volumes/${volumeId}/move`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.volume
}

export async function deleteVolume(novelId: string, volumeId: string, payload?: DeleteVolumeRequest): Promise<void> {
  await requestData<{ deleted: true }>(`/api/novels/${novelId}/volumes/${volumeId}`, {
    method: 'DELETE',
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
}

export async function moveChapter(
  novelId: string,
  chapterId: string,
  payload: MoveChapterRequest,
): Promise<Chapter> {
  const data = await requestData<{ chapter: Chapter }>(`/api/novels/${novelId}/chapters/${chapterId}/move`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.chapter
}

export async function splitChapter(
  novelId: string,
  chapterId: string,
  payload: SplitChapterRequest,
): Promise<{ first: Chapter; second: Chapter }> {
  return requestData(`/api/novels/${novelId}/chapters/${chapterId}/split`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function mergeChapters(
  novelId: string,
  targetChapterId: string,
  payload: MergeChaptersRequest,
): Promise<Chapter> {
  const data = await requestData<{ chapter: Chapter }>(`/api/novels/${novelId}/chapters/${targetChapterId}/merge`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.chapter
}

export async function getStructureReport(novelId: string): Promise<StructureReport> {
  const data = await requestData<{ report: StructureReport }>(`/api/novels/${novelId}/structure`)
  return data.report
}

export function searchProject(novelId: string, payload: ProjectSearchRequest): Promise<ProjectSearchResult> {
  return requestData<ProjectSearchResult>(`/api/novels/${novelId}/search`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function previewBulkReplace(
  novelId: string,
  payload: BulkReplacePreviewRequest,
): Promise<ChangeSet> {
  const data = await requestData<{ changeSet: ChangeSet }>(`/api/novels/${novelId}/changesets/preview`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.changeSet
}

export async function listChangeSets(novelId: string): Promise<ChangeSet[]> {
  const data = await requestData<{ items: ChangeSet[] }>(`/api/novels/${novelId}/changesets`)
  return data.items
}

export async function getChangeSet(changeSetId: string): Promise<ChangeSet> {
  const data = await requestData<{ changeSet: ChangeSet }>(`/api/changesets/${changeSetId}`)
  return data.changeSet
}

export async function applyChangeSet(changeSetId: string, payload: ApplyChangeSetRequest): Promise<ChangeSet> {
  const data = await requestData<{ changeSet: ChangeSet }>(`/api/changesets/${changeSetId}/apply`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.changeSet
}

export async function rollbackChangeSet(changeSetId: string, reason?: string): Promise<ChangeSet> {
  const data = await requestData<{ changeSet: ChangeSet }>(`/api/changesets/${changeSetId}/rollback`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  })
  return data.changeSet
}

export async function updateChapterDraft(
  novelId: string,
  chapterId: string,
  payload: UpdateChapterRequest,
): Promise<Chapter> {
  const data = await requestData<{ chapter: Chapter }>(
    `/api/novels/${novelId}/chapters/${chapterId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  )

  return data.chapter
}

export async function deleteChapterDraft(
  novelId: string,
  chapterId: string,
  expectedRevision?: number,
): Promise<void> {
  const revisionQuery = expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`
  await requestData<DeleteChapterResponse['data']>(`/api/novels/${novelId}/chapters/${chapterId}${revisionQuery}`, {
    method: 'DELETE',
  })
}

export function generateCoverPrompt(
  request: GenerateCoverPromptRequest,
): Promise<GenerateCoverPromptResponse['data']> {
  return requestData<GenerateCoverPromptResponse['data']>('/api/ai/cover-prompt', {
    method: 'POST',
    body: JSON.stringify(request),
    timeoutMs: 60000,
  })
}

export function generateCoverImages(
  request: GenerateCoverImageRequest,
): Promise<GenerateCoverImageResponse['data']> {
  return requestData<GenerateCoverImageResponse['data']>('/api/ai/cover-image', {
    method: 'POST',
    body: JSON.stringify(request),
    timeoutMs: 0,
  })
}
