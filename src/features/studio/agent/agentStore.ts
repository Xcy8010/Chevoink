import { create } from 'zustand'

import type {
  AgentAttachmentMeta,
  AgentMessagePart,
  AgentSessionRunStatus,
  AgentStreamEvent,
  AgentTodoItem,
  AgentTokenUsage,
  AgentToolDisplayPayload,
  AgentToolDraft,
  AgentUIMessage,
} from '../../../../shared/contracts/index.js'

/**
 * Agent Loop 前端状态（plan/13 §5）：
 * - messages 由 SSE 事件流实时构建（parts 结构），历史用 /sessions/:id/messages 恢复
 * - lastSeq 用于断线重连（Last-Event-ID）
 */

export type AgentRunPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type PendingApproval = {
  approvalId?: string
  callId: string
  toolName: string
  title: string
  args: unknown
  allowAlways: boolean
  expiresAt: string
}

/** 任务窗口侧栏状态信号：done=任务完成（绿）、attention=待作者确认（黄）、failed=异常中止（红）。
 * 仅记录本页面会话内实时收到的事件；切走窗口后的运行/挂起状态由服务端 run-status 轮询兑底。 */
export type SessionSignalKind = 'done' | 'attention' | 'failed'
export type SessionSignal = { runId: string; kind: SessionSignalKind; at: number }

/** ask_user 工具挂起中的提问，驱动专门的提问卡片 UI */
export type PendingQuestion = {
  requestId?: string
  callId: string
  question: string
  options: Array<{ label: string; detail?: string }>
}

/** 从 ask_user 的 tool.call args 中防御性解析提问内容 */
function parseQuestionArgs(callId: string, args: unknown): PendingQuestion | null {
  if (!args || typeof args !== 'object') {
    return null
  }
  const payload = args as { question?: unknown; options?: unknown; requestId?: unknown }
  if (typeof payload.question !== 'string' || !payload.question.trim()) {
    return null
  }
  const options = Array.isArray(payload.options)
    ? payload.options
        .filter((option): option is { label: string; detail?: string } =>
          Boolean(option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string'),
        )
        .map((option) => ({
          label: option.label,
          detail: typeof option.detail === 'string' ? option.detail : undefined,
        }))
    : []
  return { callId, question: payload.question, options, ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}) }
}

/** 本次 run 对工作区（章节/作品）的写入活动，驱动变更条 UI 与动效 */
export type WorkspaceActivity = {
  callId: string
  toolName: string
  label: string
  chapterId: string | null
  deltaChars: number | null
  display?: AgentToolDisplayPayload
  before?: string
  after?: string
  summary?: string
  status: 'running' | 'done' | 'failed'
  accepted?: boolean
}

/** 记忆工具卡点击请求：记忆中心打开对应卡片集并定位闪一下该卡片 */
export type MemorySpotlightRequest = {
  nonce: number
  memoryType: string
  title: string
}

export type ToolNavigationRequest = {
  nonce: number
  toolName: string
  args: unknown
  display?: AgentToolDisplayPayload
}

/** 从章节/计划查看器或记忆卡片选入输入框的结构化引用；正文独立保存，避免删除引用时污染草稿换行。 */
export type ComposerReference = {
  id: string
  kind: 'chapter' | 'catalog' | 'plan' | 'memory'
  name: string
  startLine: number
  endLine: number
  text: string
  /** 在纯文本草稿中的插入位置；用于 Work/IDE 切换后恢复行内引用位置。 */
  offset: number
}

/** 本轮服务端技能路由结果的可视化投影：作者需要看见 Agent 到底用了哪些技能。 */
export type AgentSkillRouteState = {
  runId: string
  phase: string
  selected: Array<{ id: string; name: string }>
  /** 本轮含 MANUAL_PIN 时说明是作者手动指定而不是自动召回。 */
  reasonCodes: string[]
}

/** 会对工作区（章节树/正文/作品信息）产生写入的工具集合 */
export const WORKSPACE_WRITE_TOOLS = new Set([
  'chapter_create',
  'chapter_write',
  'chapter_append',
  'chapter_edit_range',
  'chapter_rename',
  'chapter_move',
  'chapter_move_to_volume',
  'chapter_split',
  'chapter_merge',
  'volume_create',
  'volume_update',
  'volume_move',
  'volume_delete',
  'changeset_apply',
  'changeset_rollback',
  'plan_save',
  'plan_rename',
  'plan_delete',
  'directive_save',
  'directive_supersede',
  'memory_save',
  'memory_relation_save',
  'memory_event_save',
  'novel_create',
  'novel_rename',
  'novel_update_meta',
  'cover_prompt_set',
  'cover_apply',
  'novel_publish',
  'novel_archive',
  'novel_delete',
])

const WRITE_TOOL_LABELS: Record<string, string> = {
  chapter_create: '新建章节',
  chapter_write: '写入正文',
  chapter_append: '追加正文',
  chapter_edit_range: '改写片段',
  chapter_rename: '重命名章节',
  chapter_move: '移动章节',
  chapter_move_to_volume: '章节移入卷',
  chapter_split: '拆分章节',
  chapter_merge: '合并章节',
  volume_create: '新建卷',
  volume_update: '更新卷',
  volume_move: '移动卷',
  volume_delete: '删除卷',
  changeset_apply: '应用全书变更',
  changeset_rollback: '回滚全书变更',
  plan_save: '保存计划',
  plan_rename: '重命名计划',
  plan_delete: '删除计划',
  directive_save: '保存创作要求',
  directive_supersede: '更新创作要求',
  memory_save: '更新作品记忆',
  memory_relation_save: '更新人物关系',
  memory_event_save: '记录故事事件',
  novel_create: '创建作品',
  novel_rename: '重命名作品',
  novel_update_meta: '更新作品设置',
  cover_prompt_set: '设置封面描述',
  cover_apply: '应用封面',
  novel_publish: '发布作品',
  novel_archive: '下架作品',
  novel_delete: '删除作品',
}

type AgentStoreState = {
  runId: string | null
  /** 刷新后从 DB 派生的可续跑 run（无活跃 run 但上一轮 failed/paused）：
      支撑「继续执行」按钮在刷新后仍显示，不依赖活体 store 状态 */
  resumeableRunId: string | null
  phase: AgentRunPhase
  agentTitle: string
  messages: AgentUIMessage[]
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
  /** 本页面内发起过且尚未收到终态的会话：切走窗口后 SSE 已断，侧栏先按运行中展示，轮询纠正 */
  runningSessionIds: Set<string>
  /** 各会话未读状态信号（绿/黄/红点）；激活该会话时由宿主 dismiss 清除 */
  sessionSignals: Record<string, SessionSignal>
  usage: AgentTokenUsage
  currentTurn: number
  lastSeq: number
  lastVisibleOutput: { runId: string; at: number } | null
  outputSummary: string
  errorMessage: string | null
  errorCode: string | null
  /** 当前 run 所属会话：面板重挂载（沉浸切换/路由往返）时用于判断能否续接直播而非重置 */
  activeSessionId: string | null
  /** 当前 messages 已完成恢复的会话；用于 Work/IDE 切换时复用同一份会话而不闪烁重载。 */
  loadedSessionId: string | null
  /** 正在拉取历史的会话 id：加载态的全局唯一真相。
      旧实现靠各面板实例各自的布尔标记，一旦标记与全局 messages 失配就会误渲染空态欢迎页 */
  hydratingSessionId: string | null
  /** 输入框草稿：提升到全局 store，避免面板重挂载时丢失未发送内容 */
  composerDraft: string
  /** 输入框附件（已上传成功的元数据）：同草稿提升全局，沉浸/普通视图重挂载不丢 */
  composerAttachments: AgentAttachmentMeta[]
  /** 查看器选区引用：以附件标签展示，发送时才序列化进提示词。 */
  composerReferences: ComposerReference[]
  /** 正在上传中的附件数量：上传完成前禁止发送 */
  composerUploading: number
  /** 输入框里手动指定的技能 id；同草稿提升全局，面板重挂载不丢 */
  composerSkillIds: string[]
  composerSubagent: { id: string; name: string; novelId: string } | null
  /** 本轮技能路由：仅 live 事件写入，给作者一个“何时调用了哪些技能”的可见答案 */
  skillRoute: AgentSkillRouteState | null
  /** 正文已定稿（text.final 已到达）的消息 id：定稿后正文尾部不再画流式光标，
      避免等作者答题/审批或工具执行期间光标在已完成正文后常闪 */
  finalizedTextIds: string[]
  /** 自动追踪：Agent 写入章节时编辑器自动跳转到对应正文（默认开启） */
  autoFollow: boolean
  /** 当前任务窗口（会话）累计的工作区写入活动（变更区） */
  workspaceActivities: WorkspaceActivity[]
  /** 工作区变更触发版本：仅 live 事件递增，驱动变更区自动展开（历史恢复不触发） */
  activitiesVersion: number
  /** 当前会话的任务待办清单（todo_write 全量维护） */
  todos: AgentTodoItem[]
  /** 待办触发版本：仅 live 事件递增，驱动待办区自动展开（历史恢复不触发） */
  todosVersion: number
  /** 长文本写工具参数的实时只读预览；tool.result 后移除。 */
  liveToolDrafts: Record<string, AgentToolDraft>
  /** 工具卡点击后的内容导航请求，由 StudioWorkspace 消费。 */
  toolNavigationRequest: ToolNavigationRequest | null
  /** 记忆工具卡点击后的卡片定位请求，由 StudioWorkspace（切页签）与 AgentMemoryCards（开覆层闪卡）消费。 */
  memorySpotlight: MemorySpotlightRequest | null
  /** 事件 reducer：live 与 replay 共用同一构建逻辑 */
  applyEvent: (event: AgentStreamEvent) => void
  beginRun: (runId: string, userPrompt: string, sessionId: string | null, attachments?: AgentAttachmentMeta[]) => void
  /** 续接服务端仍在进行的 run（刷新后恢复）：不追加用户消息，从 seq 0 重放事件重建直播 */
  resumeRun: (runId: string, sessionId: string | null) => void
  /** 记录刷新后从服务端派生的可续跑 run（拉历史消息时写入，续跑成功后清空） */
  noteResumeableRun: (runId: string | null) => void
  restoreMessages: (messages: AgentUIMessage[], sessionId?: string | null) => void
  /** 加载更早对话：把更早轮次前插合并（按 id 去重），不触碰进行中的 run */
  prependMessages: (messages: AgentUIMessage[]) => void
    /** 标记指定会话开始/结束历史水合：与 loadedSessionId 一同构成加载态判定依据 */
  beginSessionHydration: (sessionId: string) => void
  endSessionHydration: (sessionId: string) => void
  resetRun: () => void
  clearError: () => void
  /** 作者回到该任务窗口：清除完成/待确认未读信号与运行中登记（异常中止的红点持久保留） */
  dismissSessionSignal: (sessionId: string) => void
  /** 侧栏轮询兑底：同步服务端 run 状态，维护运行中登记并产出完成/失败未读信号 */
  syncRemoteRunStatuses: (statuses: Record<string, AgentSessionRunStatus | null>) => void
  setComposerDraft: (value: string) => void
  setComposerAttachments: (list: AgentAttachmentMeta[]) => void
  addComposerAttachment: (meta: AgentAttachmentMeta) => void
  removeComposerAttachment: (id: string) => void
  addComposerReference: (reference: ComposerReference) => void
  removeComposerReference: (id: string) => void
  clearComposerReferences: () => void
  setComposerContent: (draft: string, references: ComposerReference[]) => void
  bumpComposerUploading: (delta: number) => void
  setComposerSkillIds: (ids: string[]) => void
  /** 输入框“+”菜单里勾选/取消一个技能；上限与后端 schema 一致为 3 个。 */
  toggleComposerSkill: (skillId: string) => void
  setAutoFollow: (value: boolean) => void
  requestToolNavigation: (toolName: string, args: unknown, display?: AgentToolDisplayPayload) => void
  clearToolNavigationRequest: () => void
  requestMemorySpotlight: (memoryType: string, title: string) => void
  /** 将刚通过作者审查的写入活动标记为已接受；执行成功本身仍只是已完成。 */
  markWorkspaceActivitiesAccepted: (criteria: { chapterId?: string; toolNames?: string[]; all?: boolean }) => void
}

const emptyUsage: AgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

/** 把终态/挂起信号写入对应会话；无归属会话时静默跳过 */
function noteSessionSignal(state: { activeSessionId: string | null; runId: string | null; sessionSignals: Record<string, SessionSignal> }, kind: SessionSignalKind) {
  const sessionId = state.activeSessionId
  if (!sessionId) return {}
  return { sessionSignals: { ...state.sessionSignals, [sessionId]: { runId: state.runId ?? '', kind, at: Date.now() } } }
}

function withoutRunningSession(state: { activeSessionId: string | null; runningSessionIds: Set<string> }) {
  if (!state.activeSessionId || !state.runningSessionIds.has(state.activeSessionId)) return {}
  const next = new Set(state.runningSessionIds)
  next.delete(state.activeSessionId)
  return { runningSessionIds: next }
}

/** 任务不再需要确认（已回答/已审批/自动兜底继续）时撤下当前会话的未读黄点 */
function withoutActiveSessionSignal(state: { activeSessionId: string | null; sessionSignals: Record<string, SessionSignal> }) {
  const sessionId = state.activeSessionId
  if (!sessionId || !state.sessionSignals[sessionId]) return {}
  const next = { ...state.sessionSignals }
  delete next[sessionId]
  return { sessionSignals: next }
}

// 自动追踪开关持久化：刷新/重开页面后保持用户上次的选择（默认开启）
const AUTO_FOLLOW_STORAGE_KEY = 'chevoink-agent-auto-follow'
const ACCEPTED_TOOL_CALLS_STORAGE_KEY = 'chevoink-agent-accepted-tool-calls'

function readAcceptedToolCalls(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ACCEPTED_TOOL_CALLS_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

let acceptedToolCalls = readAcceptedToolCalls()

function persistAcceptedToolCalls() {
  try {
    const recent = Array.from(acceptedToolCalls).slice(-500)
    acceptedToolCalls = new Set(recent)
    window.localStorage.setItem(ACCEPTED_TOOL_CALLS_STORAGE_KEY, JSON.stringify(recent))
  } catch {
    // 持久化不可用时，本会话内仍保留正确状态。
  }
}

function decorateAcceptedMessages(messages: AgentUIMessage[]): AgentUIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'tool-call' && acceptedToolCalls.has(part.callId) ? { ...part, accepted: true } : part,
    ),
  }))
}

function readStoredAutoFollow(): boolean {
  try {
    return window.localStorage.getItem(AUTO_FOLLOW_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

function writeStoredAutoFollow(value: boolean) {
  try {
    window.localStorage.setItem(AUTO_FOLLOW_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // localStorage 不可用时降级为会话内开关
  }
}

/** 从工具事件提取变更条所需的章节/字数信息 */
function activityFromDisplay(display: unknown): { label: string | null; chapterId: string | null; deltaChars: number | null; before?: string; after?: string } {
  if (display && typeof display === 'object' && 'kind' in display) {
    const payload = display as { kind: string; [key: string]: unknown }
    if (payload.kind === 'chapterDiff') {
      const before = typeof payload.before === 'string' ? payload.before : ''
      const after = typeof payload.after === 'string' ? payload.after : ''
      return {
        label: typeof payload.chapterTitle === 'string' ? payload.chapterTitle : null,
        chapterId: typeof payload.chapterId === 'string' ? payload.chapterId : null,
        deltaChars: after.length - before.length,
        before,
        after,
      }
    }
    if (payload.kind === 'chapterRef') {
      return {
        label: typeof payload.title === 'string' ? payload.title : null,
        chapterId: typeof payload.chapterId === 'string' ? payload.chapterId : null,
        deltaChars: typeof payload.wordCount === 'number' && payload.wordCount > 0 ? payload.wordCount : null,
      }
    }
  }
  return { label: null, chapterId: null, deltaChars: null }
}

/** 从历史消息的工具轨迹推导会话级的工作区变更与待办清单（刷新/切换会话后恢复） */
function deriveSessionStateFromMessages(messages: AgentUIMessage[]): {
  workspaceActivities: WorkspaceActivity[]
  todos: AgentTodoItem[]
} {
  const workspaceActivities: WorkspaceActivity[] = []
  let todos: AgentTodoItem[] = []

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool-call') {
        continue
      }
      if (part.display?.kind === 'todoList') {
        todos = part.display.items
      }
      if (!WORKSPACE_WRITE_TOOLS.has(part.toolName) && part.display?.kind !== 'chapterDiff' && part.display?.kind !== 'planDiff') {
        continue
      }
      const extracted = activityFromDisplay(part.display)
      workspaceActivities.push({
        callId: part.callId,
        toolName: part.toolName,
        label: extracted.label ?? WRITE_TOOL_LABELS[part.toolName] ?? part.title,
        chapterId: extracted.chapterId,
        deltaChars: extracted.deltaChars,
        display: part.display,
        before: extracted.before,
        after: extracted.after,
        summary: part.summary,
        status: part.status === 'failed' ? 'failed' : 'done',
        accepted: Boolean(part.accepted || acceptedToolCalls.has(part.callId)),
      })
    }
  }

  return { workspaceActivities, todos }
}

function updateMessageParts(
  messages: AgentUIMessage[],
  messageId: string,
  update: (parts: AgentMessagePart[]) => AgentMessagePart[],
): AgentUIMessage[] {
  return messages.map((message) =>
    message.id === messageId ? { ...message, parts: update(message.parts) } : message,
  )
}

/** 追加流式 delta：最后一个同类 part 存在则拼接，否则新建 */
function appendDelta(
  parts: AgentMessagePart[],
  type: 'text' | 'reasoning',
  delta: string,
): AgentMessagePart[] {
  const last = parts[parts.length - 1]

  if (last && last.type === type) {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }]
  }

  return [...parts, { type, text: delta }]
}

/** 任务停止/结束后把仍处于「执行中」的工具卡片就地收尾：
 * 被中止的工具永远收不到 tool.result 事件，不收尾会导致卡片无限转圈 */
function settleRunningToolParts(messages: AgentUIMessage[], summary: string): AgentUIMessage[] {
  return messages.map((message) => {
    if (!message.parts.some((part) => part.type === 'tool-call' && part.status === 'running')) {
      return message
    }
    return {
      ...message,
      parts: message.parts.filter((part) => !(part.type === 'tool-call' && part.preparing)).map((part) =>
        part.type === 'tool-call' && part.status === 'running'
          ? { ...part, status: 'failed' as const, summary }
          : part,
      ),
    }
  })
}

/** 同步收尾变更区里还在转圈的写入活动 */
function settleRunningActivities(activities: WorkspaceActivity[]): WorkspaceActivity[] {
  return activities.map((activity) =>
    activity.status === 'running' ? { ...activity, status: 'failed' as const } : activity,
  )
}

/** 会话消息缓存：切回读过的任务窗口时同步复原，做到「有缓存直接显示」而不是重新拉取闪加载态。
    store 只能持有当前会话一份 messages，因此缓存放在模块层（不参与订阅，不引发重渲染） */
const SESSION_MESSAGES_CACHE_LIMIT = 12
const sessionMessagesCache = new Map<string, AgentUIMessage[]>()

function writeSessionMessagesCache(sessionId: string | null, messages: AgentUIMessage[]) {
  if (!sessionId || messages.length === 0) {
    return
  }
  // 重新插入以维持访问顺序，超出上限时淘汰最久未用的会话
sessionMessagesCache.delete(sessionId)
  sessionMessagesCache.set(sessionId, messages)
  while (sessionMessagesCache.size > SESSION_MESSAGES_CACHE_LIMIT) {
    const oldest = sessionMessagesCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    sessionMessagesCache.delete(oldest)
  }
}

export function readSessionMessagesCache(sessionId: string): AgentUIMessage[] | null {
  return sessionMessagesCache.get(sessionId) ?? null
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  runId: null,
  resumeableRunId: null,
  phase: 'idle',
  agentTitle: '写作主控',
  messages: [],
  pendingApproval: null,
  pendingQuestion: null,
  runningSessionIds: new Set<string>(),
  sessionSignals: {},
  usage: emptyUsage,
  currentTurn: 0,
  lastSeq: 0,
  lastVisibleOutput: null,
  outputSummary: '',
  errorMessage: null,
  errorCode: null,
  activeSessionId: null,
  loadedSessionId: null,
  hydratingSessionId: null,
  composerDraft: '',
  composerAttachments: [],
  composerReferences: [],
  composerUploading: 0,
  composerSkillIds: [],
  composerSubagent: null,
  skillRoute: null,
  finalizedTextIds: [],
  autoFollow: readStoredAutoFollow(),
  workspaceActivities: [],
  activitiesVersion: 0,
  todos: [],
  todosVersion: 0,
  liveToolDrafts: {},
  toolNavigationRequest: null,
  memorySpotlight: null,

  beginRun: (runId, userPrompt, sessionId, attachments) =>
    set((state) => ({
      runId,
      phase: 'starting',
      activeSessionId: sessionId,
      loadedSessionId: sessionId,
      pendingApproval: null,
      pendingQuestion: null,
      usage: emptyUsage,
      currentTurn: 0,
      lastSeq: 0,
      outputSummary: '',
      errorMessage: null,
      errorCode: null,
      liveToolDrafts: {},
      toolNavigationRequest: null,
      // 新一轮重新路由技能：上一轮的技能标识不能留到本轮
      skillRoute: null,
      finalizedTextIds: [],
      // 开新 run 后旧的「可续跑」派生状态失效，避免按钮误留
      resumeableRunId: null,
      // 新 run 开跑：登记运行中供侧栏展示；同一会话的旧终态信号视为已消费
      ...(sessionId
        ? {
            runningSessionIds: new Set(state.runningSessionIds).add(sessionId),
            ...(state.sessionSignals[sessionId] ? (() => { const next = { ...state.sessionSignals }; delete next[sessionId]; return { sessionSignals: next } })() : {}),
          }
        : {}),
      // 工作区变更与待办按任务窗口（会话）累计，新 run 不清空；
      // 上一个任务若被停止后遗留了「执行中」的工具卡片（终态事件丢失时），开新任务前一并收尾
      workspaceActivities: settleRunningActivities(state.workspaceActivities),
      messages: [
        ...settleRunningToolParts(state.messages, '已停止'),
        {
          id: `local-${Date.now()}`,
          runId,
          role: 'user',
          // 附件随提示词一起发送：本地用户消息即时回显附件 part
          parts: [
            { type: 'text', text: userPrompt },
            ...(attachments ?? []).map((attachment) => ({
              type: 'attachment' as const,
              kind: attachment.kind,
              name: attachment.name,
              url: attachment.url,
              size: attachment.size,
            })),
          ],
          createdAt: new Date().toISOString(),
        },
      ],
    })),

  resumeRun: (runId, sessionId) =>
    set((state) => ({
      runId,
      resumeableRunId: null,
      phase: 'starting',
      activeSessionId: sessionId,
      loadedSessionId: sessionId,
      pendingApproval: null,
      pendingQuestion: null,
      usage: emptyUsage,
      currentTurn: 0,
      lastSeq: 0,
      outputSummary: '',
      errorMessage: null,
      errorCode: null,
      liveToolDrafts: {},
      toolNavigationRequest: null,
      // 续接仍在进行的 run：侧栏保持运行中展示（刷新后恢复场景）；
      // 任务重新跑起来后上一轮的异常中止红点不再成立，一并撤下
      ...(sessionId
        ? {
            runningSessionIds: new Set(state.runningSessionIds).add(sessionId),
            ...(state.sessionSignals[sessionId] ? (() => { const next = { ...state.sessionSignals }; delete next[sessionId]; return { sessionSignals: next } })() : {}),
          }
        : {}),
      // 不清空变更/待办：历史部分由 restoreMessages 推导，活跃 run 部分由事件重放按 callId 去重补齐
    })),

  restoreMessages: (messages, sessionId = null) => {
    const restored = decorateAcceptedMessages(messages)
    writeSessionMessagesCache(sessionId, restored)
    set((state) => ({
      messages: restored,
      phase: 'idle',
      runId: null,
      resumeableRunId: null,
      activeSessionId: null,
      loadedSessionId: sessionId,
      pendingApproval: null,
      pendingQuestion: null,
      errorMessage: null,
      errorCode: null,
      liveToolDrafts: {},
      toolNavigationRequest: null,
      // 从历史工具轨迹恢复会话级变更与待办；不递增触发版本，避免历史恢复误自动展开
      ...deriveSessionStateFromMessages(restored),
      // 只清除属于本会话的水合标记，避免覆盖后发起的其它会话
      hydratingSessionId: state.hydratingSessionId === sessionId ? null : state.hydratingSessionId,
    }))
  },

  beginSessionHydration: (sessionId) => set({ hydratingSessionId: sessionId }),

  endSessionHydration: (sessionId) =>
    set((state) => (state.hydratingSessionId === sessionId ? { hydratingSessionId: null } : {})),

  prependMessages: (incoming) =>
    set((state) => {
      const known = new Set(state.messages.map((message) => message.id))
      const older = decorateAcceptedMessages(incoming).filter((message) => !known.has(message.id))
      if (older.length === 0) {
        return {}
      }
      const merged = [...older, ...state.messages]
      return {
        messages: merged,
        // 更早轮次含写工具轨迹：重派生变更/待办但不递增触发版本，避免历史误自动展开
        ...deriveSessionStateFromMessages(merged),
      }
    }),

  resetRun: () => {
    // 离开旧会话前把最新消息（含刚直播完的内容）快照进缓存：切回来可零延迟复原
    const { loadedSessionId: leavingSessionId, messages: leavingMessages } = get()
    writeSessionMessagesCache(leavingSessionId, leavingMessages)
    set({
      runId: null,
      resumeableRunId: null,
      phase: 'idle',
      activeSessionId: null,
      loadedSessionId: null,
      pendingApproval: null,
      pendingQuestion: null,
      usage: emptyUsage,
      currentTurn: 0,
      lastSeq: 0,
      outputSummary: '',
      errorMessage: null,
      errorCode: null,
      workspaceActivities: [],
      todos: [],
      liveToolDrafts: {},
      toolNavigationRequest: null,
      skillRoute: null,
      finalizedTextIds: [],
      // 切换会话视为“离开旧对话”：清空消息，由渲染层按「未水合」展示图标流光；
      // 同会话重挂载/续活走早退路径（loadedSessionId 命中）不会经过这里
      messages: [],
    })
  },

  clearError: () => set({ errorMessage: null, errorCode: null }),

  noteResumeableRun: (runId) =>
    set((state) => (state.resumeableRunId === runId ? {} : { resumeableRunId: runId })),

  dismissSessionSignal: (sessionId) =>
    set((state) => {
      const signal = state.sessionSignals[sessionId]
      // 异常中止（红点）是必须被处理的事实，进入任务窗口不算已消费：
      // 红点持续显示到作者发出新提示词（beginRun）或任务恢复运行（resumeRun / 轮询到 running）为止
      const dropSignal = Boolean(signal) && signal.kind !== 'failed'
      const isRunning = state.runningSessionIds.has(sessionId)
      if (!dropSignal && !isRunning) return state
      const signals = { ...state.sessionSignals }
      if (dropSignal) delete signals[sessionId]
      const running = new Set(state.runningSessionIds)
      running.delete(sessionId)
      return { sessionSignals: signals, runningSessionIds: running }
    }),
  syncRemoteRunStatuses: (statuses) =>
    set((state) => {
      const running = new Set(state.runningSessionIds)
      const signals = { ...state.sessionSignals }
      let changed = false
      for (const [sessionId, entry] of Object.entries(statuses)) {
        if (!entry) continue
        if (entry.status === 'running' || entry.status === 'queued' || entry.status === 'awaiting_approval') {
          if (!running.has(sessionId)) { running.add(sessionId); changed = true }
          if (entry.status === 'awaiting_approval') {
            // 挂起持续提示：兜底刷新或跨窗口期间丢失的本地黄点
            if (signals[sessionId]?.kind !== 'attention') {
              signals[sessionId] = { runId: entry.runId, kind: 'attention', at: Date.now() }
              changed = true
            }
          } else if (signals[sessionId]) {
            // 任务已从挂起/异常中止恢复运行，未读黄点与红点都不再成立
            delete signals[sessionId]
            changed = true
          }
          continue
        }
        // 终态：仅此前已登记运行中的会话才产出一次性信号（历史终态不回传，避免误报未读）；
        // paused 为作者主动停止，只撤登记不提示
        if (!running.has(sessionId)) continue
        running.delete(sessionId)
        changed = true
        const kind: SessionSignalKind | null =
          entry.status === 'completed' ? 'done' : entry.status === 'failed' || entry.status === 'cancelled' ? 'failed' : null
        if (!kind) continue
        // 已完成（绿）不打扰正在查看该任务的作者；异常中止（红）当前窗口内同样要显示
        if (kind === 'done' && sessionId === state.activeSessionId) continue
        signals[sessionId] = { runId: entry.runId, kind, at: Date.now() }
      }
      return changed ? { runningSessionIds: running, sessionSignals: signals } : {}
    }),

  setComposerDraft: (value) => set({ composerDraft: value }),

  setComposerAttachments: (list) => set({ composerAttachments: list }),

  addComposerAttachment: (meta) =>
    set((state) => ({ composerAttachments: [...state.composerAttachments, meta] })),

  removeComposerAttachment: (id) =>
    set((state) => ({
      composerAttachments: state.composerAttachments.filter((attachment) => attachment.id !== id),
    })),

  addComposerReference: (reference) =>
    set((state) => ({
      composerReferences: [
        ...state.composerReferences.filter((item) => item.id !== reference.id),
        reference,
      ],
    })),

  removeComposerReference: (id) =>
    set((state) => ({ composerReferences: state.composerReferences.filter((item) => item.id !== id) })),

  clearComposerReferences: () => set({ composerReferences: [] }),

  setComposerContent: (draft, references) =>
    set({ composerDraft: draft, composerReferences: references }),

  bumpComposerUploading: (delta) =>
    set((state) => ({ composerUploading: Math.max(0, state.composerUploading + delta) })),

  setComposerSkillIds: (ids) => set({ composerSkillIds: ids.slice(0, 3) }),

  toggleComposerSkill: (skillId) =>
    set((state) => {
      if (state.composerSkillIds.includes(skillId)) {
        return { composerSkillIds: state.composerSkillIds.filter((id) => id !== skillId) }
      }
      // 超过上限时丢掉最早选的一个，避免作者先去取消才能换
      const next = [...state.composerSkillIds, skillId]
      return { composerSkillIds: next.slice(-3) }
    }),

  setAutoFollow: (value) => {
    writeStoredAutoFollow(value)
    set({ autoFollow: value })
  },

  requestToolNavigation: (toolName, args, display) => set({
    toolNavigationRequest: { nonce: Date.now(), toolName, args, display },
  }),

  clearToolNavigationRequest: () => set({ toolNavigationRequest: null }),

  requestMemorySpotlight: (memoryType, title) => set({
    memorySpotlight: { nonce: Date.now(), memoryType, title },
  }),

  markWorkspaceActivitiesAccepted: (criteria) =>
    set((state) => {
      const matching = state.workspaceActivities.filter((activity) => {
        if (activity.status !== 'done' || activity.accepted) return false
        if (criteria.all) return true
        if (criteria.chapterId && activity.chapterId === criteria.chapterId) return true
        return Boolean(criteria.toolNames?.includes(activity.toolName))
      })
      const selected = criteria.all || criteria.chapterId ? matching : matching.slice(-1)
      const callIds = new Set(selected.map((activity) => activity.callId))
      if (callIds.size === 0) return state
      for (const callId of callIds) acceptedToolCalls.add(callId)
      persistAcceptedToolCalls()
      return {
        workspaceActivities: state.workspaceActivities.map((activity) =>
          callIds.has(activity.callId) ? { ...activity, accepted: true } : activity,
        ),
        messages: state.messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) =>
            part.type === 'tool-call' && callIds.has(part.callId) ? { ...part, accepted: true } : part,
          ),
        })),
      }
    }),

  applyEvent: (event) =>
    set((state) => {
      // 重放/重连去重：只接受更新的 seq
      if (event.seq <= state.lastSeq && event.runId === state.runId) {
        return {}
      }

      const base = { lastSeq: event.seq }

      switch (event.type) {
        case 'run.started':
          return { ...base, phase: 'running', agentTitle: event.agent.title }

        // 技能路由已由服务端完成：落到 store 才能告诉作者本轮到底用了哪些技能
        case 'skill.route':
          return {
            ...base,
            skillRoute: {
              runId: event.runId,
              phase: event.phase,
              selected: event.selected.map(({ id, name }) => ({ id, name })),
              reasonCodes: event.reasonCodes,
            },
          }

        case 'message.start':
          if (state.messages.some(message => message.id === event.messageId)) return base
          return {
            ...base,
            messages: [
              ...state.messages,
              {
                id: event.messageId,
                runId: event.runId,
                role: 'assistant',
                parts: [],
                createdAt: event.ts,
              },
            ],
          }

        case 'text.delta':
          return {
            ...base,
            ...(event.runId === state.runId && event.delta.trim() ? { lastVisibleOutput: { runId: event.runId, at: Date.now() } } : {}),
            messages: updateMessageParts(state.messages, event.messageId, (parts) =>
              appendDelta(parts, 'text', event.delta),
            ),
          }

        case 'execution.progress':
          return base

        case 'text.final':
          return {
            ...base,
            // 正文定稿：登记 id，渲染层即刻停掉该消息正文尾部的流式光标
            finalizedTextIds: state.finalizedTextIds.includes(event.messageId)
              ? state.finalizedTextIds
              : [...state.finalizedTextIds, event.messageId],
            messages: updateMessageParts(state.messages, event.messageId, (parts) => {
              const withoutText = parts.filter((part) => part.type !== 'text')
              if (!event.text) return withoutText
              if (!event.asReasoning) {
                // Final prose must stay before parameter-preview cards, not jump below them.
                const previewIndex = withoutText.findIndex(part => part.type === 'tool-call' && part.preparing)
                const at = previewIndex < 0 ? withoutText.length : previewIndex
                return [...withoutText.slice(0, at), { type: 'text' as const, text: event.text }, ...withoutText.slice(at)]
              }
              let reasoningIndex = -1
              for (let index = withoutText.length - 1; index >= 0; index -= 1) {
                if (withoutText[index]?.type === 'reasoning') {
                  reasoningIndex = index
                  break
                }
              }
              if (reasoningIndex < 0) return [...withoutText, { type: 'reasoning' as const, text: event.text }]
              return withoutText.map((part, index) => index === reasoningIndex && part.type === 'reasoning'
                ? { ...part, text: [part.text, event.text].filter(Boolean).join('\n') }
                : part)
            }),
          }

        case 'reasoning.delta':
          return {
            ...base,
            ...(event.runId === state.runId && event.delta.trim() ? { lastVisibleOutput: { runId: event.runId, at: Date.now() } } : {}),
            messages: updateMessageParts(state.messages, event.messageId, (parts) =>
              appendDelta(parts, 'reasoning', event.delta),
            ),
          }

        case 'tool.call': {
          const isWrite = WORKSPACE_WRITE_TOOLS.has(event.toolName)
          // 子 Agent 内嵌执行内部的写工具不进主活动区（卡片已嵌套在子 Agent 容器内展示）
          const isSubagentInternal = Boolean(event.subagentCallId)
          const question = event.toolName === 'ask_user' ? parseQuestionArgs(event.callId, event.args) : null
          // 同一 callId 可能先收到参数生成中的预告事件（args 为 null），再收到执行时的正式事件：按 callId upsert 保证只有一张卡片
          const existingActivity = state.workspaceActivities.some((activity) => activity.callId === event.callId)
          return {
            ...base,
            // 进入工具执行即证明该消息正文流已结束：登记定稿，text.final 因断线重连等丢失时光标也不残留
            ...(state.finalizedTextIds.includes(event.messageId) ? {} : { finalizedTextIds: [...state.finalizedTextIds, event.messageId] }),
            ...(question ? { phase: 'awaiting_input' as const, pendingQuestion: question } : {}),
            ...(event.importWaiting ? { phase: 'awaiting_input' as const } : {}),
            ...(question || event.importWaiting ? noteSessionSignal(state, 'attention') : {}),
            ...(isWrite && !isSubagentInternal && !existingActivity
              ? {
                  activitiesVersion: state.activitiesVersion + 1,
                  workspaceActivities: [
                    ...state.workspaceActivities,
                    {
                      callId: event.callId,
                      toolName: event.toolName,
                      label: WRITE_TOOL_LABELS[event.toolName] ?? event.title,
                      chapterId: null,
                      deltaChars: null,
                      status: 'running' as const,
                    },
                  ],
                }
              : {}),
            messages: updateMessageParts(state.messages, event.messageId, (parts) => {
              const index = parts.findIndex((part) => part.type === 'tool-call' && part.callId === event.callId)
              if (index >= 0) {
                return parts.map((part, at) =>
                  at === index && part.type === 'tool-call'
                    ? {
                        ...part,
                        toolName: event.toolName,
                        title: event.title,
                        args: event.args ?? part.args,
                        preparing: false,
                        ...(event.importWaiting ? { importWaiting: event.importWaiting } : {}),
                        ...(event.subagentCallId && !part.subagentCallId ? { subagentCallId: event.subagentCallId } : {}),
                      }
                    : part,
                )
              }
              return [
                ...parts,
                {
                  type: 'tool-call',
                  callId: event.callId,
                  toolName: event.toolName,
                  title: event.title,
                  args: event.args,
                  status: 'running',
                  ...(event.importWaiting ? { importWaiting: event.importWaiting } : {}),
                  ...(event.subagentCallId ? { subagentCallId: event.subagentCallId } : {}),
                },
              ]
            }),
          }
        }

        case 'tool.delta': {
          // Late or foreign previews cannot resurrect stopped tasks or settled calls.
          if (event.runId !== state.runId || !isRunActive(state.phase)) return {}
          const existing = state.messages.find(message => message.id === event.messageId)?.parts
            .find(part => part.type === 'tool-call' && part.callId === event.callId)
          if (existing?.type === 'tool-call' && existing.status !== 'running') return base
          return {
            ...base,
            ...(event.draft ? { liveToolDrafts: { ...state.liveToolDrafts, [event.callId]: event.draft } } : {}),
            messages: updateMessageParts(state.messages, event.messageId, (parts) => {
              if (!existing && event.toolName && event.title) return [...parts, {
                type: 'tool-call', callId: event.callId, toolName: event.toolName, title: event.title,
                args: null, status: 'running', preparing: true, progressChars: event.argsChars,
              }]
              return parts.map((part) =>
                part.type === 'tool-call' && part.callId === event.callId && part.status === 'running'
                  ? { ...part, progressChars: event.argsChars }
                  : part,
              )
            }),
          }
        }

        case 'subagent.progress':
          // 子 Agent 内嵌执行进度：更新到对应的 subagent_run 容器卡片
          return {
            ...base,
            messages: updateMessageParts(state.messages, event.messageId, (parts) =>
              parts.map((part) =>
                part.type === 'tool-call' && part.callId === event.callId
                  ? { ...part, subagentProgress: { step: event.step, message: event.message } }
                  : part,
              ),
            ),
          }

        case 'tool.result': {
          const extracted = activityFromDisplay(event.display)
          const clearQuestion = state.pendingQuestion?.callId === event.callId
          const clearImport = event.toolName === 'novel_import' && state.messages.some(message => message.parts.some(part =>
            part.type === 'tool-call' && part.callId === event.callId && part.importWaiting))
          // todo_write 成功后同步待办快照并递增触发版本（驱动待办区自动展开）
          const todoUpdate =
            event.ok && event.display?.kind === 'todoList'
              ? { todos: event.display.items, todosVersion: state.todosVersion + 1 }
              : {}
          return {
            ...base,
            // 工具结果到达同样证明正文流早已结束：兜底登记定稿，确保光标不残留
            ...(state.finalizedTextIds.includes(event.messageId) ? {} : { finalizedTextIds: [...state.finalizedTextIds, event.messageId] }),
            ...(clearQuestion ? { phase: 'running' as const, pendingQuestion: null, ...withoutActiveSessionSignal(state) } : {}),
            ...(clearImport ? { phase: 'running' as const, ...withoutActiveSessionSignal(state) } : {}),
            ...todoUpdate,
            liveToolDrafts: Object.fromEntries(Object.entries(state.liveToolDrafts).filter(([callId]) => callId !== event.callId)),
            workspaceActivities: [...state.workspaceActivities, ...(event.ok && (event.display?.kind === 'chapterDiff' || event.display?.kind === 'planDiff') && !state.workspaceActivities.some(activity => activity.callId === event.callId)
              ? [{ callId: event.callId, toolName: 'body_edit', label: extracted.label ?? '正文变更', chapterId: extracted.chapterId, deltaChars: extracted.deltaChars, status: 'done' as const }] : [])].map((activity) =>
              activity.callId === event.callId
                ? {
                    ...activity,
                    status: event.ok ? ('done' as const) : ('failed' as const),
                    label: extracted.label ?? activity.label,
                    chapterId: extracted.chapterId ?? activity.chapterId,
                    deltaChars: extracted.deltaChars ?? activity.deltaChars,
                    display: event.display,
                    before: extracted.before ?? activity.before,
                    after: extracted.after ?? activity.after,
                    summary: event.summary,
                  }
                : activity,
            ),
            messages: updateMessageParts(state.messages, event.messageId, (parts) =>
              parts.map((part) =>
                part.type === 'tool-call' && part.callId === event.callId
                  ? {
                      ...part,
                      status: event.ok ? 'success' : 'failed',
                      preparing: false,
                      summary: event.summary,
                      display: event.display,
                      durationMs: event.durationMs,
                    }
                  : part,
              ),
            ),
          }
        }

        case 'permission.ask':
          return {
            ...base,
            phase: 'awaiting_approval',
            pendingApproval: {
              approvalId: event.approvalId,
              callId: event.callId,
              toolName: event.toolName,
              title: event.title,
              args: event.args,
              allowAlways: event.allowAlways,
              expiresAt: event.expiresAt,
            },
            ...noteSessionSignal(state, 'attention'),
          }

        case 'permission.resolved':
          if (!state.pendingApproval || state.pendingApproval.callId !== event.callId
            || state.pendingApproval.approvalId !== event.approvalId) return base
          return { ...base, phase: 'running', pendingApproval: null, ...withoutActiveSessionSignal(state) }

        case 'step.finish':
          return {
            ...base,
            // All admitted tools have settled at a step boundary. Reconcile old/speculative
            // events and discard parameter-only drafts even when admission was blocked.
            messages: settleRunningToolParts(state.messages, '本轮已结束，未收到工具完成结果'),
            liveToolDrafts: {},
            currentTurn: event.turn,
            usage: {
              promptTokens: state.usage.promptTokens + event.usage.promptTokens,
              completionTokens: state.usage.completionTokens + event.usage.completionTokens,
              totalTokens: state.usage.totalTokens + event.usage.totalTokens,
            },
          }

        case 'run.paused':
          // 停止时正在执行的工具永远等不到 tool.result，就地收尾避免卡片一直「执行中」；
          // 用户主动停止不产生未读信号，仅撤下运行中登记
          return {
            ...base,
            phase: 'paused',
            ...(event.reason === 'model_stalled' ? { outputSummary: '模型暂未完成任务，已保留进度并暂停。请补充指示后继续。' } : {}),
            pendingApproval: null,
            pendingQuestion: null,
            liveToolDrafts: {},
            messages: settleRunningToolParts(state.messages, '已停止'),
            workspaceActivities: settleRunningActivities(state.workspaceActivities),
            ...withoutRunningSession(state),
          }

        case 'run.finished':
          // 完成（绿）不写未读信号：SSE 连着当前会话，收到 finished 时作者必然正在看，
          // 若写入信号，切走后信号才显现（绿点“突然亮”假象）；切走后才完成的绿点由 run-status 轮询层产生。
          // 异常中止（红）相反：必须当场写入并持续提示，直到作者发新提示词或任务恢复运行
          return {
            ...base,
            phase: event.status,
            usage: event.usage,
            outputSummary: event.outputSummary,
            pendingApproval: null,
            pendingQuestion: null,
            liveToolDrafts: {},
            messages: settleRunningToolParts(state.messages, '已中断').map(message => message.role === 'assistant' && message.runId === event.runId
              ? { ...message, completedAt: event.status === 'succeeded' ? event.ts : null } : message),
            workspaceActivities: settleRunningActivities(state.workspaceActivities),
            ...withoutRunningSession(state),
            ...(event.status === 'succeeded' ? withoutActiveSessionSignal(state) : noteSessionSignal(state, 'failed')),
          }

        case 'error':
          return {
            ...base,
            errorMessage: event.message,
            errorCode: event.code,
            ...(event.recoverable
              ? {}
              : {
                  phase: 'failed' as const,
                  messages: settleRunningToolParts(state.messages, '已中断'),
                  workspaceActivities: settleRunningActivities(state.workspaceActivities),
                  // 不可恢复错误可能没有后续的 run.finished，这里就把红点落下
                  ...noteSessionSignal(state, 'failed'),
                }),
          }

        default:
          return base
      }
    }),
}))

export function isRunActive(phase: AgentRunPhase): boolean {
  return phase === 'starting' || phase === 'running' || phase === 'awaiting_approval' || phase === 'awaiting_input'
}
