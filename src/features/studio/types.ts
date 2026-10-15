import type {
  AiImageSize,
  AgentActionHandoff,
  AgentActionPlan,
  AgentArtifactApplyStrategy,
  AgentExecutionAgent,
  AgentExecutionMode,
  AgentExecutionStepResult,
  AgentRouteDecision,
  AgentRuleBundle,
  AgentStoryMemoryDigest,
  AgentWorkspaceToolPolicy,
  ChapterStatus,
  GenerateOutlineRequest,
  ProjectMemoryType,
  Visibility,
} from '../../../shared/contracts/index.js'

export type EditableNovelStatus = 'draft' | 'published' | 'completed' | 'archived'
export type MobileView = 'editor' | 'chapters' | 'assistant' | 'memory' | 'context' | 'skills' | 'cover' | 'meta'
export type ToolPanel = 'meta' | 'assistant' | 'cover'
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export type WorkspaceConfirmation = {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  onConfirm: () => void | Promise<void>
}
export type AgentTaskType =
  | 'workspace-agent'
  | 'generate-novel-title'
  | 'generate-chapter-titles'
  | 'read-story-context'
  | 'plan-chapter'
  | 'draft-chapter'
  | 'continue-chapter'
  | 'rewrite-selection'
  | 'polish-selection'
  | 'review-continuity'
  | 'generate-cover-prompt'
export type AgentArtifactType = 'chapter_plan' | 'draft_text' | 'review_report' | 'cover_prompt'

export type NovelFormState = {
  title: string
  displayTitle: string
  summary: string
  tagsText: string
  visibility: Visibility
  status: EditableNovelStatus
}

export type ProjectNotesState = {
  genre: string
  protagonist: string
  tone: string
  outlineLength: NonNullable<GenerateOutlineRequest['targetLength']>
  stylePreference: string
}

export type ChapterDraftState = {
  id: string
  title: string
  summary: string
  content: string
  status: ChapterStatus
  visibility: Visibility
  orderIndex: number
  revision: number
  localOnly: boolean
}

export type AgentArtifact = {
  id: string
  task: AgentTaskType
  type: AgentArtifactType
  title: string
  content: string
  rawContent?: string
  promptText?: string
  createdAt: string
  status: 'streaming' | 'ready'
  runId?: string | null
  sessionId?: string | null
  runStatusMode?: AgentRunStatusMode
  runStatuses?: AgentRunStatusItem[]
  memoryEntries?: AgentMemoryEntry[]
  backendArtifactId?: string | null
  availableApplyStrategies?: AgentArtifactApplyStrategy[]
  savedAsPlan?: boolean
  catalogUpdated?: boolean
  appliedToCover?: boolean
  replacedChapterContent?: boolean
  appendedToChapter?: boolean
  renamedNovel?: boolean
  renamedChapter?: boolean
  coverPreviewAssetIds?: string[]
  actionSummary?: string
  actionPlan?: AgentActionPlan | null
  handoff?: AgentActionHandoff | null
  activeAgent?: AgentExecutionAgent | null
  routeDecision?: AgentRouteDecision | null
  ruleBundle?: AgentRuleBundle | null
  storyMemoryDigest?: AgentStoryMemoryDigest | null
  executionMode?: AgentExecutionMode | null
  toolPolicy?: AgentWorkspaceToolPolicy | null
  stepResults?: AgentExecutionStepResult[] | null
  localRollbackSnapshot?: AgentLocalRollbackSnapshot | null
  pendingChapterReview?: ChapterPendingReview | null
}

export type AgentRunState = {
  active: boolean
  task: AgentTaskType | null
  title: string
  statusText: string
  activeAgent?: AgentExecutionAgent | null
  routeDecision?: AgentRouteDecision | null
  executionMode?: AgentExecutionMode | null
}

export type AgentRunStatusItem = {
  id: string
  event: string
  text: string
  createdAt: string
}

export type AgentRunStatusMode = 'none' | 'live' | 'history'

export type AgentMemoryEntry = {
  id: string
  memoryType: ProjectMemoryType
  title: string
  content: string
  importance: number
  createdAt: string
}

export type AgentLocalRollbackChapterSnapshot = {
  id: string
  title: string
  summary: string
  content: string
  status: ChapterStatus
  visibility: Visibility
  wordCount: number
  updatedAt: string | null
}

export type AgentLocalRollbackSnapshot =
  | {
      kind: 'restore_chapter'
      chapter: AgentLocalRollbackChapterSnapshot
      selectedChapterId: string | null
    }
  | {
      kind: 'remove_created_chapter'
      chapter: AgentLocalRollbackChapterSnapshot
      previousSelectedChapterId: string | null
      previousChapter?: AgentLocalRollbackChapterSnapshot | null
    }

export type ChapterPendingReview = {
  id: string
  chapterId: string
  artifactId?: string | null
  runId?: string | null
  before: ChapterDraftState | null
  after: ChapterDraftState
  rollbackSnapshot: AgentLocalRollbackSnapshot
  description: string
  createdAt: string
  lastAppliedEvent?: { runId: string; seq: number }
}

/** Agent plan_save 更新既有计划后的待审查态：✓保留 / ✕回写更新前的标题与内容 */
export type PlanPendingReview = {
  id: string
  /** 云端 AgentArtifact id，撤销时据此 PATCH 回写 */
  backendArtifactId: string
  title: string
  beforeTitle: string
  before: string
  after: string
  description: string
  /** 新建计划（空基线）：撤销时直接从计划夹移除而非回写空内容 */
  isCreate?: boolean
  runId?: string | null
  createdAt: string
  lastAppliedEvent?: { runId: string; seq: number }
}

export type EditorSelectionState = {
  start: number
  end: number
  text: string
}

export type CoverFormState = {
  novelTitle: string
  summary: string
  genre: string
  protagonist: string
  stylePreference: string
  prompt: string
  negativePrompt: string
  size: AiImageSize
  count: number
}

export type WorkspacePlanFile = {
  id: string
  title: string
  content: string
  createdAt: string
  artifactId: string
  /** 云端 AgentArtifact id：用于本地/服务端计划去重与同步 */
  backendArtifactId?: string | null
  orderIndex?: number | null
}

export type WorkspaceDocumentView = {
  kind: 'catalog' | 'plan'
  id: string
  title: string
  content: string
  description: string
  editableTitle?: boolean
  editableContent?: boolean
}

export const visibilityLabelMap: Record<Visibility, string> = {
  public: '公开',
  followers: '仅关注者',
  private: '仅自己',
}

export const chapterStatusLabelMap: Record<ChapterStatus, string> = {
  draft: '草稿',
  published: '已发布',
  scheduled: '定时发布',
  archived: '已下架',
}

export const novelStatusLabelMap: Record<EditableNovelStatus, string> = {
  draft: '草稿箱',
  published: '公开连载',
  completed: '已完结',
  archived: '已下架',
}
