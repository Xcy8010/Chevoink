import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { hasComposerDraft, promoteComposerDraft } from './agent/composer-drafts'
import { shouldRetainAgentTaskWindow } from './lib/agent-session'
import { useShellStore } from '@/store/useShellStore'
import { BookOpen, BookOpenText, Brain, Bug, ChevronLeft, FileText, Flag, FolderDown, ImagePlus, Lightbulb, LogOut, MessageSquareText, MoreHorizontal, Network, PanelRightOpen, PenLine, RefreshCcw, Settings2, SlidersHorizontal, Trash2, Upload, Wrench } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import BottomSheet from '@/components/ui/BottomSheet'
import Button from '@/components/ui/Button'
import Surface from '@/components/ui/Surface'
import { useToast } from '@/components/ui/toast-context'
import { useAutoHideScrollbars } from '@/hooks/useAutoHideScrollbars'
import { updateShelfCover } from '@/features/home/local-shelf'
import FeedbackDialog from '@/features/feedback/components/FeedbackDialog'
import { cn } from '@/lib/utils'
import { DEFAULT_AGENT2_FEATURE_FLAGS } from '../../../shared/contracts/index.js'
import type { AgentSession, AgentStreamEvent, Chapter, CoverAsset, FeedbackKind, Novel, StudioPayload, UserMePayload, Visibility } from '../../../shared/contracts/index.js'
import { createWritingAgentSession, createNovelWorkspace, createChapterDraft, deleteNovelWorkspace, deleteChapterDraft, getChapterContent, getStudioPayload, getWritingAgentSessionHistory, listNovelPlanFiles, listWritingAgentSessions, publishNovelWorkspace, updateChapterDraft, updateWritingAgentSession, updateNovelMeta } from './api'
import { downloadCoverAssetImage } from './cover-image'
import { getMe } from '../community/api'
import ChapterSettingsPanel from './components/ChapterSettingsPanel'
import ChapterSidebar from './components/ChapterSidebar'
import ChangeSetDrawer from './components/ChangeSetDrawer'
import PlanSettingsPanel from './components/PlanSettingsPanel'
import { StudioSkeleton } from '@/components/ui/Skeleton'
import ConfirmDialog from './components/ConfirmDialog'
import CoverPanel from './components/CoverPanel'
import EditorCanvas from './components/EditorCanvas'
import ExportDialog from './components/ExportDialog'
import ImportDialog from './components/ImportDialog'
import { useImportCapabilities } from './components/use-import-capabilities'
import { readImportHandoff, readImportJobId, clearImportHandoff, type ImportAgentAttachment } from './lib/import-handoff'
import type { NovelImportModelSelection } from '../../../shared/contracts/novel-import.js'
import { buildReviewDiff, resolveReviewHunk } from './components/diff'
import MetaPanel from './components/MetaPanel'
import NovelCoverCropDialog from './components/NovelCoverCropDialog'
import PublishNovelDialog from './components/PublishNovelDialog'
import StudioCommandBar from './components/StudioCommandBar'
import StudioMobileAccountCard from './components/StudioMobileAccountCard'
import CreateNovelDialog from './components/CreateNovelDialog'
import StudioWorkspaceSidebar from './components/StudioWorkspaceSidebar'
import { AgentConversationRail } from './components/AgentTaskSidebar'
import StudioSettingsDialog, { type StudioSettingsSection } from './components/StudioSettingsDialog'
import WorkspaceNovelSwitcher from './components/WorkspaceNovelSwitcher'
import WorkPerspective from './components/WorkPerspective'
import WorkInspector from './components/WorkInspector'
import IdePerspective from './components/IdePerspective'
import IdeNavigationRail from './components/IdeNavigationRail'
import StudioChapterViewer from './components/StudioChapterViewer'
import MemoryGraph from './components/MemoryGraph'
import SkillsPanel from './components/SkillsPanel'
import { AgentPanel } from './agent/components/AgentPanel'
import { fetchAgentSessions, updateAgentSessionSettings } from './agent/agentApi'
import { AgentActivityBar } from './agent/components/AgentActivityBar'
import AgentMemoryCenter from './agent/components/AgentMemoryCenter'
import ContextDetailDialog from './agent/components/ContextDetailDialog'
import { WORKSPACE_WRITE_TOOLS, useAgentStore, type ComposerReference } from './agent/agentStore'
import { getMessageText } from './agent/lib/panel-helpers'
import { PanelResizeHandle } from './panel-resize'
import type { AgentArtifact, AgentLocalRollbackSnapshot, AgentRunState, ChapterDraftState, ChapterPendingReview, CoverFormState, EditableNovelStatus, EditorSelectionState, MobileView, NovelFormState, PlanPendingReview, ProjectNotesState, SaveState, ToolPanel, WorkspaceDocumentView, WorkspacePlanFile } from './types'



import { buildArtifactsFromHistory, mergeRestoredArtifactsWithSnapshot, readStoredAgentWorkspace } from './lib/agent-persistence.js'
import { BOOTSTRAP_NOVEL_SUMMARY, BOOTSTRAP_NOVEL_TITLE, DEFAULT_NOVEL_ID, STUDIO_LAST_NOVEL_STORAGE_KEY, buildAgentTaskWindowFromSession, createLocalAgentTaskWindow, dedupeAgentTaskWindows, formatDateTime, formatWordCount, getAgentWorkspaceStorageKey, isBootstrapNovel, pickFallbackAgentTaskWindow, resolveNovelTitleState, shouldDisplayListedAgentSession, shouldShowWorkspaceNovel } from './lib/agent-session.js'
import { buildChapterDraft, buildCoverForm, buildNovelFormState, buildNovelUpdatePayload, buildProjectNotes, createIdleAgentRunState, isNovelFormDirty } from './lib/form-state.js'
import { buildCatalogPreview, buildChapterReviewDescription, buildPendingChapterReview, buildServerPlanFile, buildWorkspacePlanFiles, mergeCatalogContentWithChapters, removeChapterAndCompact, replaceChapterItem, toChapterListItem, upsertChapterItem } from './lib/plan-review.js'
import { usePendingReviewStorage } from './components/use-pending-review-storage'
import type { AgentTaskWindowState, StoredAgentWorkspaceSnapshot } from './lib/workspace-types.js'
import { getPlatformCapabilities, subscribePlatformLifecycle } from './platform-capabilities.js'
import { useWorkPanelState, writeWorkPanelUi } from './components/use-work-panel-state'
import { reconcilePlanSelection, stablePlanId } from './components/work-plan-selection'
import { consumeSessionDeepLink, initialTaskWindows, selectInitialTask, selectTaskFallback } from './lib/initial-task-selection'
import { createCatalogActions } from './components/catalog-actions'
import { useChapterPersistence } from './components/use-chapter-persistence'
import { useWorkspaceLayout } from './components/use-workspace-layout'
import { useCoverActions } from './components/use-cover-actions'
import { usePlanSync } from './components/use-plan-sync'
import { createPlanDocumentActions } from './components/plan-document-actions'
import { createPlanReviewActions } from './components/plan-review-actions'

export default function StudioWorkspace() {
  const { novelId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeNovelId = novelId ?? DEFAULT_NOVEL_ID
  const taskUiUserId = useShellStore(state => state.sessionUser?.id)
  const queryClient = useQueryClient()

  const studioQuery = useQuery({
    queryKey: ['studio', activeNovelId],
    queryFn: () => getStudioPayload(activeNovelId),
    refetchOnWindowFocus: false,
    // 跨作品切换时沿用上一个作品的载荷渲染（Codex 式无骨架切换）：整个工作区不卸载，
    // 左侧栏保留滚动与展开状态，聊天区/右侧栏随新载荷到达后无缝替换；
    // 中间帧由 isPlaceholderData 驱动内容区禁点防误操作
    placeholderData: keepPreviousData,
  })
  const myNovelsQuery = useQuery({
    queryKey: ['studio', 'my-novels'],
    // 复用 ['community','me'] 共享缓存，避免与外壳/个人中心重复请求 /api/users/me
    queryFn: async () => {
      const me = await queryClient.fetchQuery({
        queryKey: ['community', 'me'],
        queryFn: getMe,
        staleTime: 30_000,
      })
      return Array.isArray(me?.authoredNovels) ? me.authoredNovels : []
    },
    refetchOnWindowFocus: false,
  })
  const navigationSessionsQuery = useQuery({
    queryKey: ['agent', 'sessions', 'workspace-navigation'],
    queryFn: () => fetchAgentSessions(),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })

  const [currentNovel, setCurrentNovel] = useState<Novel | null>(null)
  const [novelForm, setNovelForm] = useState<NovelFormState | null>(null)
  const [projectNotes, setProjectNotes] = useState<ProjectNotesState | null>(null)
  const [coverForm, setCoverForm] = useState<CoverFormState | null>(null)
  const [coverAssets, setCoverAssets] = useState<CoverAsset[]>([])
  const [selectedCoverId, setSelectedCoverId] = useState<string | null>(null)
  const [coverGenerationBusy, setCoverGenerationBusy] = useState(false)
  const [coverGenerationProgress, setCoverGenerationProgress] = useState(0)
  const [chapters, setChapters] = useState<StudioPayload['chapters']>([])
  const [volumes, setVolumes] = useState<StudioPayload['volumes']>([])
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const importCapabilities = useImportCapabilities(activeNovelId, taskUiUserId)
  const [importRequest, setImportRequest] = useState<{ novelId: string; userId: string; attachment?: ImportAgentAttachment; jobId?: string; view?: 'history'; autoFile?: File } | null>(null)
  const [importModel, setImportModel] = useState<{ novelId: string; selection: NovelImportModelSelection | null } | null>(null)
  const handleImportModelSelection = useCallback((ownerNovelId: string, selection: NovelImportModelSelection | null) => {
    setImportModel({ novelId: ownerNovelId, selection })
  }, [])
  const importAvailable = importCapabilities.data?.enabled === true && !studioQuery.isPlaceholderData && currentNovel?.id === activeNovelId
  const importHistoryAvailable = !!importCapabilities.data && !studioQuery.isPlaceholderData && currentNovel?.id === activeNovelId
  const openImportHistory = () => {
    if (importHistoryAvailable && taskUiUserId) setImportRequest({ novelId: activeNovelId, userId: taskUiUserId, view: 'history' })
  }
  // 入口始终开放：先选文件再进导入弹窗自动管线；服务端开关关闭时由导入弹窗给出未开放提示
  const importPicker = useRef<HTMLInputElement>(null)
  const openNovelImport = () => {
    if (!taskUiUserId) return
    if (importPicker.current) {
      importPicker.current.value = ''
      importPicker.current.click()
      return
    }
    setImportRequest({ novelId: activeNovelId, userId: taskUiUserId })
  }
  useEffect(() => {
    if (!importHistoryAvailable || !taskUiUserId) return
    const attachment = importAvailable ? readImportHandoff(searchParams) : null
    const jobId = readImportJobId(searchParams)
    if (attachment || jobId) {
      setImportRequest({ novelId: activeNovelId, userId: taskUiUserId, attachment: attachment ?? undefined, jobId: jobId ?? undefined })
      const next = clearImportHandoff(searchParams)
      next.delete('importJobId')
      setSearchParams(next, { replace: true })
    }
  }, [activeNovelId, importAvailable, importHistoryAvailable, taskUiUserId, searchParams, setSearchParams])
  useEffect(() => {
    setImportRequest((request) => request?.novelId === activeNovelId && request.userId === taskUiUserId ? request : null)
  }, [activeNovelId, taskUiUserId])
  const [activeChangeSetId, setActiveChangeSetId] = useState<string | null>(null)
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [selectedTreeItemId, setSelectedTreeItemId] = useState<string | null>(null)
  const [catalogDocument, setCatalogDocument] = useState<{
    title: string
    content: string
    manualTitle: boolean
    manualContent: boolean
  } | null>(null)
  const [chapterDraft, setChapterDraft] = useState<ChapterDraftState | null>(null)
  const [chapterDirty, setChapterDirty] = useState(false)
  const [chapterSaveState, setChapterSaveState] = useState<SaveState>('idle')
  const [chapterSaveMessage, setChapterSaveMessage] = useState('内容会在停止输入后自动保存。')
  const [chapterLastSavedAt, setChapterLastSavedAt] = useState<string | null>(null)
  const [novelDirty, setNovelDirty] = useState(false)
  const [novelSaveState, setNovelSaveState] = useState<SaveState>('idle')
  const [novelLastSavedAt, setNovelLastSavedAt] = useState<string | null>(null)
  const [novelMessage, setNovelMessage] = useState('作品设置支持自动保存，也可以手动点击保存。')
  const [mobileView, setMobileView] = useState<MobileView>('assistant')
  // 上下文详情弹窗（上下文记录/压缩记录/最终上下文）：由记忆面板占用卡「查看详情」打开
  const [contextDetailOpen, setContextDetailOpen] = useState(false)
  const {
    workspacePerspective, setWorkspacePerspective,
    workspaceSidebarOpen, setWorkspaceSidebarOpen, setWorkspaceSidebarWidth,
    workRightOpen, setWorkRightOpen, workInspectorTab, setWorkInspectorTab,
    workViewer, setWorkViewer, ideTreeOpen, setIdeTreeOpen,
    ideSidebarTab, setIdeSidebarTab, ideAgentOpen, setIdeAgentOpen,
    panelWidths, beginPanelResize,
  } = useWorkspaceLayout(activeNovelId)
  const [studioSettingsOpen, setStudioSettingsOpen] = useState(false)
  const [studioSettingsSection, setStudioSettingsSection] = useState<StudioSettingsSection>('general')
  const featureFlags = studioQuery.data?.featureFlags ?? DEFAULT_AGENT2_FEATURE_FLAGS
  const workspaceActivities = useAgentStore((state) => state.workspaceActivities)
  const workspaceActivitiesVersion = useAgentStore((state) => state.activitiesVersion)
  const agentTodos = useAgentStore((state) => state.todos)
  const agentTodosVersion = useAgentStore((state) => state.todosVersion)
  const agentMessages = useAgentStore((state) => state.messages)
  const liveToolDrafts = useAgentStore((state) => state.liveToolDrafts)
  const autoFollow = useAgentStore((state) => state.autoFollow)
  const setAutoFollow = useAgentStore((state) => state.setAutoFollow)
  const toolNavigationRequest = useAgentStore((state) => state.toolNavigationRequest)
  const clearToolNavigationRequest = useAgentStore((state) => state.clearToolNavigationRequest)
  const memorySpotlight = useAgentStore((state) => state.memorySpotlight)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null)
  // 创作区内滚动条静止时隐藏，滚动中才显示
  useAutoHideScrollbars()
  const [activeToolPanel, setActiveToolPanel] = useState<ToolPanel | null>(null)
  const platformCapabilities = useMemo(() => getPlatformCapabilities(), [])
  const [agentPrompt, setAgentPrompt] = useState('')
  // 惰性初始化：从快照同步恢复当前会话 id，避免跨路由返回时 AgentPanel 先以 null 挂载冲掉进行中的任务直播
  const [agentSessionId, setAgentSessionId] = useState<string | null>(() => {
    const snapshot = readStoredAgentWorkspace(activeNovelId)
    const initialTask = selectInitialTask(snapshot?.tasks ?? [], snapshot?.activeTaskId, searchParams.get('session'))
    return initialTask?.sessionId ?? null
  })
  // 会话解析中：切换作品/首载时任务窗口的 sessionId 需等服务端会话列表合并后才能定案，
  // 这段中间态禁止 AgentPanel 渲染空态欢迎页（否则欢迎页会显示整个网络请求时长）
  const [agentSessionsResolving, setAgentSessionsResolving] = useState(false)
  const [sessionResolutionError, setSessionResolutionError] = useState<string | null>(null)
  const [sessionResolutionAttempt, setSessionResolutionAttempt] = useState(0)
  // 任务窗口同样从快照惰性恢复：挂载即落在该作品上次活跃的任务窗口，
  // 避免初始空窗口先触发快照写入效应清掉存档、或界面闪现「新任务」
  const [agentTaskWindows, setAgentTaskWindows] = useState<AgentTaskWindowState[]>(() => {
    const snapshot = readStoredAgentWorkspace(activeNovelId)
    return initialTaskWindows(snapshot?.tasks ?? [], searchParams.get('session'), createLocalAgentTaskWindow)
  })
  const [activeAgentTaskWindowId, setActiveAgentTaskWindowId] = useState<string | null>(() => {
    const snapshot = readStoredAgentWorkspace(activeNovelId)
    const initialTask = selectInitialTask(snapshot?.tasks ?? [], snapshot?.activeTaskId, searchParams.get('session'))
    return initialTask?.id ?? null
  })
  // 作者回到任务窗口即清除该窗口的未读信号（绿/黄/红点），无论从同作品还是跨作品路径切入
  const dismissSessionSignal = useAgentStore((state) => state.dismissSessionSignal)
  useEffect(() => {
    if (activeAgentTaskWindowId) dismissSessionSignal(activeAgentTaskWindowId)
  }, [activeAgentTaskWindowId, dismissSessionSignal])
  // 当前任务窗口状态归属的作品：切换作品后状态水合落地前，快照写入效应
  // 不得用旧作品窗口写入/删除（会污染目标作品快照），仅状态归属当前作品时才允许写
  const [agentStateNovelId, setAgentStateNovelId] = useState(activeNovelId)
  const taskScopeOwner = taskUiUserId ?? queryClient.getQueryData<UserMePayload>(['community', 'me'])?.user?.id ?? 'current'
  const taskUiScope = activeAgentTaskWindowId && agentStateNovelId === activeNovelId
    ? `${taskScopeOwner}:${activeNovelId}:${activeAgentTaskWindowId}` : undefined
  const taskLocationRef = useRef({ novelId: activeNovelId, taskId: activeAgentTaskWindowId })
  taskLocationRef.current = { novelId: activeNovelId, taskId: activeAgentTaskWindowId }
  const workPanelScope = useWorkPanelState(taskUiScope,
    { rightOpen: workRightOpen, viewer: workViewer, inspectorTab: workInspectorTab, selectedTreeItemId, selectedChapterId },
    { setRightOpen: setWorkRightOpen, setViewer: setWorkViewer, setInspectorTab: setWorkInspectorTab, setSelectedTreeItemId, setSelectedChapterId })
  const [agentRunState, setAgentRunState] = useState<AgentRunState>(createIdleAgentRunState)
  const [agentArtifacts, setAgentArtifacts] = useState<AgentArtifact[]>([])
  const [activeAgentArtifactId, setActiveAgentArtifactId] = useState<string | null>(null)
  // 计划文件夹云端副本：覆盖非活跃任务窗口/历史会话的计划，刷新后不丢失
  const [serverPlanFiles, setServerPlanFiles] = useState<WorkspacePlanFile[]>([])
  const [plansLoadedNovelId, setPlansLoadedNovelId] = useState<string | null>(null)
  const { flushPlanServerSync, schedulePlanServerSync } = usePlanSync()
  const agentRunAbortControllerRef = useRef<AbortController | null>(null)
  const coverGenerationWasActiveRef = useRef(false)
  const [editorSelection, setEditorSelection] = useState<EditorSelectionState>({
    start: 0,
    end: 0,
    text: '',
  })
  const [coverKeywords, setCoverKeywords] = useState<string[]>([])
  const [coverMessage, setCoverMessage] = useState('先整理提示词，再生成候选封面。')
  const [pendingCoverUploadFile, setPendingCoverUploadFile] = useState<File | null>(null)
  const [editorChapterSettingsOpen, setEditorChapterSettingsOpen] = useState(false)
  // 计划设置抽屉：值为计划文件 id（本地产物 id 或 server- 前缀 id）
  const [planSettingsPlanId, setPlanSettingsPlanId] = useState<string | null>(null)
  // 章节审查改为数组：Agent 连续写多章时各章审查态并存，互不覆盖（fix：新章写入导致旧审查被自动采纳）
  const [pendingChapterReviews, setPendingChapterReviews] = useState<ChapterPendingReview[]>([])
  const [pendingChapterReviewBusy, setPendingChapterReviewBusy] = useState(false)
    // 刚在哪一章完成全部定夺：仅该章展示「下一个文件」浮标，避免浏览其它未修改章节时误出现（fix）
    const [reviewHandoffChapterId, setReviewHandoffChapterId] = useState<string | null>(null)
  // 切章后收回流转浮标：只在定夺发生的那一章短暂展示
  useEffect(() => {
    setReviewHandoffChapterId(null)
  }, [selectedChapterId])
  // 计划审查条（plan/14 方案F）：plan_save 更新既有计划后非阻塞事后审，新建计划不触发
  const [pendingPlanReview, setPendingPlanReview] = useState<PlanPendingReview | null>(null)
  const [pendingPlanReviewBusy, setPendingPlanReviewBusy] = useState(false)
  // 审查态持久化：刷新页面后恢复未定夺的审查条与 diff 视图（fix2b）
  usePendingReviewStorage(activeNovelId, pendingChapterReviews, pendingPlanReview, setPendingChapterReviews, setPendingPlanReview)
  const [workspaceDialog, setWorkspaceDialog] = useState<{
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
    onConfirm: () => void | Promise<void>
  } | null>(null)
  const [workspaceDialogBusy, setWorkspaceDialogBusy] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [createNovelDialogOpen, setCreateNovelDialogOpen] = useState(false)
  const createChapterLockRef = useRef(false)
  const agentExecutionChapterTargetRef = useRef<string | null>(null)


  useEffect(() => {
    if (!featureFlags.dualWorkspace && workspacePerspective !== 'ide') {
      setWorkspacePerspective('ide')
    }
  }, [featureFlags.dualWorkspace, workspacePerspective, setWorkspacePerspective])

  useEffect(() => subscribePlatformLifecycle({
    onBack: () => {
      if (workspaceDialog) setWorkspaceDialog(null)
      else if (activeChangeSetId) setActiveChangeSetId(null)
      else if (mobileMoreOpen) setMobileMoreOpen(false)
      else if (activeToolPanel) setActiveToolPanel(null)
      else if (mobileView !== 'assistant') setMobileView('assistant')
      else navigate('/')
    },
    onResume: () => {
      // SSE 以 seq 去重续传；这里只失效查询缓存，不重新启动 run，避免 APP 切后台造成重复写入。
      void queryClient.invalidateQueries({ queryKey: ['studio', activeNovelId] })
    },
  }), [activeChangeSetId, activeNovelId, activeToolPanel, mobileMoreOpen, mobileView, navigate, queryClient, workspaceDialog])

  useEffect(() => {
    if (!coverGenerationBusy) {
      return
    }

    coverGenerationWasActiveRef.current = true
    setCoverGenerationProgress((current) => (current > 0 && current < 99 ? current : 3))

    const interval = window.setInterval(() => {
      setCoverGenerationProgress((current) => {
        if (current < 18) {
          return Math.min(18, current + 4)
        }
        if (current < 36) {
          return Math.min(36, current + 3)
        }
        if (current < 58) {
          return Math.min(58, current + 2)
        }
        if (current < 76) {
          return Math.min(76, current + 1.4)
        }
        if (current < 90) {
          return Math.min(90, current + 0.9)
        }
        if (current < 94) {
          return Math.min(94, current + 0.24)
        }
        if (current < 97) {
          return Math.min(97, current + 0.12)
        }
        if (current < 99) {
          return Math.min(99, current + 0.05)
        }

        return 99
      })
    }, 1167)

    return () => window.clearInterval(interval)
  }, [coverGenerationBusy])

  useEffect(() => {
    if (coverGenerationBusy || !coverGenerationWasActiveRef.current) {
      return
    }

    setCoverGenerationProgress(100)
    coverGenerationWasActiveRef.current = false

    const timeout = window.setTimeout(() => {
      setCoverGenerationProgress(0)
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [coverGenerationBusy])
  const createNovelMutation = useMutation({
    mutationFn: (requestedTitle: string) =>
      createNovelWorkspace({
        title: requestedTitle.trim() || BOOTSTRAP_NOVEL_TITLE,
        summary: BOOTSTRAP_NOVEL_SUMMARY,
        tags: [],
        visibility: 'private',
        status: 'draft',
      }),
    onMutate: () => {
      resetWorkspaceDraftState()
    },
    onSuccess: (novel) => {
      setCreateNovelDialogOpen(false)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STUDIO_LAST_NOVEL_STORAGE_KEY, novel.id)
      }
      queryClient.setQueryData<Novel[]>(['studio', 'my-novels'], (current) => {
        const nextNovels = Array.isArray(current) ? current.filter((item) => item.id !== novel.id) : []
        return [novel, ...nextNovels]
      })
      queryClient.setQueryData<UserMePayload>(['community', 'me'], (current) => {
        if (!current) {
          return current
        }

        const currentAuthoredNovels = Array.isArray(current.authoredNovels) ? current.authoredNovels : []
        return {
          ...current,
          authoredNovels: [novel, ...currentAuthoredNovels.filter((item) => item.id !== novel.id)],
        }
      })
      void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      void queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
      navigate(`/studio/novel/${novel.id}`)
    },
    onError: (error: Error) => {
      // 失败必须把「正在打开作品...」收掉，否则 loading 文案会永远挂着
      setChapterSaveState('error')
      setChapterSaveMessage(error.message || '新建作品失败，请稍后重试。')
      toast.error(error.message || '新建作品失败，请稍后重试。')
    },
  })

  /** 当前已应用（用户可见）的任务窗口 id：后台补载工件返回时据此判断用户是否已切走 */
  const appliedAgentTaskWindowIdRef = useRef<string | null>(null)

  function applyAgentTaskWindowState(taskWindow: AgentTaskWindowState | null) {
    setSessionResolutionError(null)
    appliedAgentTaskWindowIdRef.current = taskWindow?.id ?? null
    if (!taskWindow) {
      setActiveAgentTaskWindowId(null)
      setAgentSessionId(null)
      setAgentPrompt('')
      setAgentArtifacts([])
      setActiveAgentArtifactId(null)
      setAgentRunState(createIdleAgentRunState())
      return
    }

    const latestArtifact = taskWindow.artifacts[0] ?? null

    setActiveAgentTaskWindowId(taskWindow.id)
    setAgentSessionId(taskWindow.sessionId)
    setAgentPrompt(taskWindow.prompt)
    setAgentArtifacts(taskWindow.artifacts)
    setActiveAgentArtifactId(
      taskWindow.activeArtifactId && taskWindow.artifacts.some((artifact) => artifact.id === taskWindow.activeArtifactId)
        ? taskWindow.activeArtifactId
        : latestArtifact?.id ?? null,
    )
    setAgentRunState(
      latestArtifact
        ? {
            active: false,
            task: latestArtifact.task,
            title: latestArtifact.title || 'Agent 对话',
            statusText: '已恢复当前任务窗口。',
            activeAgent: latestArtifact.activeAgent ?? null,
            routeDecision: latestArtifact.routeDecision ?? null,
            executionMode: latestArtifact.executionMode ?? null,
          }
        : createIdleAgentRunState(),
    )
  }

  async function hydrateAgentTaskWindow(taskWindow: AgentTaskWindowState) {
    if (!taskWindow.sessionId || taskWindow.loaded) {
      return taskWindow
    }

    const historyItems = await getWritingAgentSessionHistory(taskWindow.sessionId)
    const restoredArtifacts = buildArtifactsFromHistory(historyItems)

    return {
      ...taskWindow,
      artifacts: restoredArtifacts,
      activeArtifactId: restoredArtifacts[0]?.id ?? null,
      loaded: true,
      temporary: false,
      // 读取历史不是新活动；保留真实更新时间，避免仅点击任务就把它顶到列表首位。
      updatedAt: taskWindow.updatedAt,
    }
  }

  async function loadAgentTaskWindow(taskWindowId: string) {
    const targetTaskWindow = agentTaskWindows.find((taskWindow) => taskWindow.id === taskWindowId)
    if (!targetTaskWindow) {
      return
    }

    // 先切后载：立即把会话切过去，切换在同一帧内完成（对话内容由 Agent 面板按会话缓存复原）；
    // 工件历史在后台补齐，避免点击后整屏卡在 getWritingAgentSessionHistory 的网络往返上
    applyAgentTaskWindowState(targetTaskWindow)

    if (!targetTaskWindow.sessionId || targetTaskWindow.loaded) {
      return
    }

    const loadedTaskWindow = await hydrateAgentTaskWindow(targetTaskWindow)

    setAgentTaskWindows((current) =>
      current.map((taskWindow) => (taskWindow.id === taskWindowId ? loadedTaskWindow : taskWindow)),
    )

    // 补载期间用户可能已切到别的任务窗口，此时不得用旧窗口状态覆盖
    if (appliedAgentTaskWindowIdRef.current !== taskWindowId) {
      return
    }

    applyAgentTaskWindowState(loadedTaskWindow)
  }

  function pruneTemporaryTaskWindows(nextActiveTaskId: string) {
    setAgentTaskWindows((current) =>
      current.filter((taskWindow) => shouldRetainAgentTaskWindow(
        taskWindow, nextActiveTaskId,
        hasComposerDraft(`${taskScopeOwner}:${activeNovelId}:${taskWindow.id}`),
      )),
    )
  }

  // 切换作品时只重置树选中与目录文档；审查态交由上方水合 effect 按作品键恢复，
  // 此处若清空会在「返回创作区/刷新」时把未定夺的 diff 误判为已采纳（fix2）
  useEffect(() => {
    setSelectedTreeItemId(null)
    setCatalogDocument(null)
  }, [activeNovelId])

  useEffect(() => {
    if (!activeAgentTaskWindowId) {
      return
    }

    setAgentTaskWindows((current) => current.map((taskWindow) => {
      if (taskWindow.id !== activeAgentTaskWindowId) return taskWindow
      const contentChanged = taskWindow.prompt !== agentPrompt || taskWindow.artifacts !== agentArtifacts
      return {
        ...taskWindow,
        sessionId: agentSessionId,
        prompt: agentPrompt,
        artifacts: agentArtifacts,
        activeArtifactId: activeAgentArtifactId,
        loaded: taskWindow.loaded || agentArtifacts.length > 0 || Boolean(agentSessionId),
        temporary: taskWindow.temporary && !agentSessionId,
        firstPromptSubmitted:
          taskWindow.firstPromptSubmitted || Boolean(agentArtifacts.some((artifact) => artifact.promptText?.trim())),
        // 只在提示词或产物真正变化时更新排序时间；选择/水合任务不能改变其位置。
        updatedAt: contentChanged ? new Date().toISOString() : taskWindow.updatedAt,
      }
    }))
  }, [activeAgentArtifactId, activeAgentTaskWindowId, agentArtifacts, agentPrompt, agentSessionId])

  useEffect(() => {
    const fallbackTaskWindow = selectTaskFallback(agentTaskWindows, activeAgentTaskWindowId,
      searchParams.get('session'), agentSessionsResolving || Boolean(sessionResolutionError), agentStateNovelId === activeNovelId)
    if (fallbackTaskWindow) {
      applyAgentTaskWindowState(fallbackTaskWindow)
    }
  }, [activeAgentTaskWindowId, agentTaskWindows, searchParams, agentSessionsResolving, sessionResolutionError, agentStateNovelId, activeNovelId])

  useEffect(() => {
    const requestedPanel = searchParams.get('panel')

    if (!currentNovel || !requestedPanel) {
      return
    }

    if (requestedPanel === 'meta') {
      setActiveToolPanel('meta')
      setMobileView('meta')
    } else if (requestedPanel === 'cover') {
      setActiveToolPanel('cover')
      setMobileView('cover')
    }

    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete('panel')
    setSearchParams(nextSearchParams, { replace: true })
  }, [currentNovel, searchParams, setSearchParams])

  // 记录最近一次由本地 setQueryData 写入缓存的 payload 对象引用：
  // 下方 studioQuery.data effect 用它区分「本地增量写入」与「真实网络拉取」，
  // 避免保存/发布等操作触发 effect 时用陈旧缓存覆盖掉 Agent 刚创建的章节（丢章 bug）
  const localStudioPayloadRef = useRef<StudioPayload | null>(null)

  useEffect(() => {
    localStudioPayloadRef.current = null
    // Codex 式无骨架切换：渲染基座（currentNovel/novelForm/projectNotes/coverForm）不清空，
    // 配合 studioQuery 的 keepPreviousData 占位帧继续渲染上一个作品视图（isPlaceholderData
    // 半透明禁点），新载荷到达后由下方同步 effect 全量替换——否则这里清成 null 会立刻
    // 命中渲染入口的骨架短路，整个工作区卸载重建，左侧栏滚动与展开状态全部丢失。
    // 仅清编辑态与选中态，防止旧作品的草稿/脏标记/封面选中泄漏进新作品上下文。
    setSelectedCoverId(null)
    setChapters([])
    setVolumes([])
    // Selection is restored by the task-scoped panel hook, not by novel resets.
    setCatalogDocument(null)
    setChapterDraft(null)
    setChapterDirty(false)
    setChapterSaveState('idle')
    setChapterSaveMessage('内容会在停止输入后自动保存。')
    setChapterLastSavedAt(null)
    setNovelDirty(false)
    setNovelSaveState('idle')
    setNovelLastSavedAt(null)
    setNovelMessage('作品设置支持自动保存，也可以手动点击保存。')
    setEditorChapterSettingsOpen(false)
  }, [activeNovelId])

  useEffect(() => {
    if (!studioQuery.data || studioQuery.isPlaceholderData || studioQuery.data.novel.id !== activeNovelId) {
      return
    }

    // 本地 setQueryData 增量写入（保存/发布/Agent 刷新等）不重置工作区状态：
    // 这些写入基于缓存做局部更新，本地 state 已经是最新，若在这里全量覆盖
    // 会把 selectedChapterId 重置、并可能用旧缓存冲掉刚同步的章节
    if (studioQuery.data === localStudioPayloadRef.current) {
      return
    }

    const payload = studioQuery.data
    const notes = buildProjectNotes(payload.novel)

    setCurrentNovel(payload.novel)
    setNovelForm(buildNovelFormState(payload.novel))
    setProjectNotes(notes)
    setCoverForm(buildCoverForm(payload.novel, notes))
    setCoverAssets(payload.coverAssets)
    setSelectedCoverId(payload.novel.coverAssetId ?? payload.coverAssets[0]?.id ?? null)
    setChapters(payload.chapters)
    setVolumes(payload.volumes)
    setSelectedChapterId(current => current && payload.chapters.some(chapter => chapter.id === current)
      ? current : payload.draftChapter?.id ?? payload.chapters[0]?.id ?? null)
  }, [studioQuery.data, studioQuery.isPlaceholderData, activeNovelId])

  useEffect(() => {
    agentRunAbortControllerRef.current?.abort()
    resetAgentWorkspace()
    setAgentSessionsResolving(true)
    setSessionResolutionError(null)
    setAgentStateNovelId(activeNovelId)

    const requestedSessionId = searchParams.get('session')
    // 侧栏在其它作品点「新建对话/新建任务」会带 ?session=new 跳过来：置顶一个干净的新对话窗口
    const requestNewTask = requestedSessionId === 'new'
    const snapshot = readStoredAgentWorkspace(activeNovelId)
    const storedTasks = initialTaskWindows(snapshot?.tasks ?? [], requestedSessionId, createLocalAgentTaskWindow)
    const freshTaskWindow = requestNewTask ? createLocalAgentTaskWindow() : null
    const snapshotTasks = freshTaskWindow ? [freshTaskWindow, ...storedTasks] : storedTasks
    setAgentTaskWindows(snapshotTasks)
    setCatalogDocument(snapshot?.catalogDocument ?? null)

    const initialTaskWindow =
      freshTaskWindow ??
      selectInitialTask(snapshotTasks, snapshot?.activeTaskId, requestedSessionId)
    applyAgentTaskWindowState(initialTaskWindow)

    let cancelled = false
    let resolvingTaskId = initialTaskWindow?.id ?? null

    void (async () => {
      try {
        const sessions = await listWritingAgentSessions(activeNovelId)
        if (cancelled) {
          return
        }

        // 服务端会话列表是唯一真相：本地快照里 sessionId 已不存在的任务窗口（会话被删除后残留）
        // 必须剔除，否则会拿着僵尸 sessionId 反复 404（拉消息/发消息都报「会话不存在或无权访问」），刷新也无法自愈
        const validSessionIds = new Set(sessions.map((session) => session.id))
        const aliveSnapshotTasks = snapshotTasks.filter(
          (taskWindow) => !taskWindow.sessionId || validSessionIds.has(taskWindow.sessionId),
        )

        if (sessions.length === 0) {
          if (requestedSessionId && !requestNewTask && !selectInitialTask(aliveSnapshotTasks, null, requestedSessionId)) throw new Error('目标任务暂不可用，请重试。不会自动创建新任务。')
          if (aliveSnapshotTasks.length === snapshotTasks.length) {
            return
          }
          const fallbackTasks = aliveSnapshotTasks.length > 0 ? aliveSnapshotTasks : [createLocalAgentTaskWindow()]
          setAgentTaskWindows(fallbackTasks)
          applyAgentTaskWindowState(fallbackTasks[0] ?? null)
          return
        }

        const mergedTasks = dedupeAgentTaskWindows(sessions.reduce<AgentTaskWindowState[]>((current, session) => {
          const existingTask = current.find(
            (taskWindow) => taskWindow.sessionId === session.id || taskWindow.id === session.id,
          )

          if (session.id !== requestedSessionId && !shouldDisplayListedAgentSession(session, Boolean(existingTask))) {
            return current
          }

          if (existingTask) {
            return current.map((taskWindow) =>
              taskWindow.sessionId === session.id || taskWindow.id === session.id
                ? {
                    ...taskWindow,
                    id: session.id,
                    sessionId: session.id,
                    title: taskWindow.customNamed ? taskWindow.title : session.title,
                    temporary: false,
                    updatedAt: session.updatedAt,
                    createdAt: session.createdAt,
                  }
                : taskWindow,
            )
          }

          return [...current, buildAgentTaskWindowFromSession(session)]
        }, dedupeAgentTaskWindows(aliveSnapshotTasks)))

        const nextTaskWindow =
          (freshTaskWindow ? mergedTasks.find((taskWindow) => taskWindow.id === freshTaskWindow.id) : null) ??
          (requestedSessionId ? mergedTasks.find((taskWindow) => taskWindow.sessionId === requestedSessionId || taskWindow.id === requestedSessionId) : null) ??
          (requestedSessionId && !requestNewTask ? null : selectInitialTask(mergedTasks, snapshot?.activeTaskId ?? initialTaskWindow?.id, null))

        if (!nextTaskWindow && requestedSessionId && !requestNewTask) throw new Error('目标任务暂不可用，请重试。不会自动切换到其它任务。')

        setAgentTaskWindows(mergedTasks)
        if (!nextTaskWindow || appliedAgentTaskWindowIdRef.current !== (initialTaskWindow?.id ?? null)) {
          return
        }

        // 先激活任务窗口：sessionId 立即生效，Agent 面板并行拉取会话消息；
        // 历史工件（计划/大纲等）在后台补载，不再串行阻塞对话上下文首屏
        applyAgentTaskWindowState(nextTaskWindow)
        resolvingTaskId = nextTaskWindow.id
        // Keep the deep link until history succeeds so retry resolves the same target.
        // Consume only the matching parameter, never a newer navigation or panel choice.
        if (requestNewTask) {
          setSearchParams(current => consumeSessionDeepLink(current, requestedSessionId), { replace: true })
        }
        if (nextTaskWindow.loaded || !nextTaskWindow.sessionId) {
          if (requestedSessionId && !requestNewTask) setSearchParams(current => consumeSessionDeepLink(current, requestedSessionId), { replace: true })
          return
        }

        const historyItems = await getWritingAgentSessionHistory(nextTaskWindow.sessionId)
        if (cancelled) {
          return
        }

        const restoredArtifacts = mergeRestoredArtifactsWithSnapshot(
          buildArtifactsFromHistory(historyItems),
          nextTaskWindow.artifacts,
        )
        const loadedTaskWindow = {
          ...nextTaskWindow,
          artifacts: restoredArtifacts,
          activeArtifactId: restoredArtifacts[0]?.id ?? null,
          loaded: true,
          temporary: false,
        }

        setAgentTaskWindows((current) =>
          current.map((taskWindow) => (taskWindow.id === loadedTaskWindow.id ? loadedTaskWindow : taskWindow)),
        )
        if (appliedAgentTaskWindowIdRef.current === nextTaskWindow.id) {
          applyAgentTaskWindowState(loadedTaskWindow)
          if (requestedSessionId && !requestNewTask) setSearchParams(current => consumeSessionDeepLink(current, requestedSessionId), { replace: true })
        }
      } catch {
        if (!cancelled && appliedAgentTaskWindowIdRef.current === resolvingTaskId) setSessionResolutionError('任务读取失败，请重试。已保存的对话保留，不会自动创建新任务。')
      } finally {
        // 会话解析结束（命中会话或确认为空）后解除占位，空态欢迎页才能正常出现
        if (!cancelled) {
          setAgentSessionsResolving(false)
        }
      }
    })()

    return () => {
      cancelled = true
      setAgentSessionsResolving(false)
    }
    // 任务深链只在作品切换/首载时消费一次；把 searchParams 加入依赖会在删除
    // `session` 参数后再次重置工作区，反而覆盖刚恢复的目标任务。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNovelId, sessionResolutionAttempt])

  useEffect(() => {
    return () => {
      // 卸载时必须中止“当时最新”的请求，而不是 effect 建立时的旧 controller。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      agentRunAbortControllerRef.current?.abort()
      flushPlanServerSync()
    }
  }, [flushPlanServerSync])

  // 计划文件夹云端持久化：作品切换时拉取全量计划（plan_save 已落库，这里跨会话聚合）
  useEffect(() => {
    let cancelled = false
    flushPlanServerSync()
    setServerPlanFiles([])
    setPlansLoadedNovelId(null)

    void listNovelPlanFiles(activeNovelId)
      .then((items) => {
        if (!cancelled) {
          setServerPlanFiles(items.map(buildServerPlanFile))
          setPlansLoadedNovelId(activeNovelId)
        }
      })
      .catch(() => {
        /* 拉取失败时保留本地派生的计划，不打断创作流程 */
      })

    return () => {
      cancelled = true
    }
     
  }, [activeNovelId, flushPlanServerSync])

  useEffect(() => {
    if (typeof window === 'undefined' || !currentNovel?.id) {
      return
    }

    window.localStorage.setItem(STUDIO_LAST_NOVEL_STORAGE_KEY, currentNovel.id)
  }, [currentNovel?.id])

  useEffect(() => {
    setNovelDirty(isNovelFormDirty(currentNovel, novelForm))
  }, [currentNovel, novelForm])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    // 任务窗口状态尚未水合到当前作品（切换后残留旧作品状态）：跳过写入，避免污染/误删当前作品快照
    if (agentStateNovelId !== activeNovelId || agentSessionsResolving || sessionResolutionError) {
      return
    }

    const storageKey = getAgentWorkspaceStorageKey(activeNovelId)
    const meaningfulTasks = agentTaskWindows.filter(
      (taskWindow) => shouldRetainAgentTaskWindow(
        taskWindow, activeAgentTaskWindowId,
        hasComposerDraft(`${taskScopeOwner}:${activeNovelId}:${taskWindow.id}`),
      ),
    )

    const hasAgentState = meaningfulTasks.length > 0
    if (!hasAgentState) {
      window.localStorage.removeItem(storageKey)
      return
    }

    const snapshot: StoredAgentWorkspaceSnapshot = {
      tasks: meaningfulTasks.map((taskWindow) => ({
        id: taskWindow.id,
        sessionId: taskWindow.sessionId,
        title: taskWindow.title,
        prompt: taskWindow.prompt,
        artifacts: taskWindow.artifacts,
        activeArtifactId: taskWindow.activeArtifactId,
        loaded: taskWindow.loaded,
        temporary: taskWindow.temporary,
        customNamed: taskWindow.customNamed,
        firstPromptSubmitted: taskWindow.firstPromptSubmitted,
        createdAt: taskWindow.createdAt,
        updatedAt: taskWindow.updatedAt,
      })),
      activeTaskId: activeAgentTaskWindowId,
      selectedTreeItemId,
      catalogDocument,
    }
    window.localStorage.setItem(storageKey, JSON.stringify(snapshot))
  }, [activeAgentTaskWindowId, activeNovelId, agentStateNovelId, agentTaskWindows, catalogDocument, selectedTreeItemId, taskScopeOwner, agentSessionsResolving, sessionResolutionError])

  async function handleWorkspaceDialogConfirm() {
    if (!workspaceDialog) {
      return
    }

    setWorkspaceDialogBusy(true)
    try {
      await workspaceDialog.onConfirm()
      setWorkspaceDialog(null)
    } finally {
      setWorkspaceDialogBusy(false)
    }
  }

  const chapterQuery = useQuery({
    queryKey: ['studio-chapter', activeNovelId, selectedChapterId],
    queryFn: () => getChapterContent(activeNovelId, selectedChapterId as string),
    enabled: Boolean(taskUiScope && workPanelScope === taskUiScope && currentNovel?.id === activeNovelId && selectedChapterId && !selectedChapterId.startsWith('local-')),
    refetchOnWindowFocus: false,
    retry: 1,
  })

  useEffect(() => {
    if (!chapterQuery.data || !selectedChapterId || chapterQuery.data.id !== selectedChapterId) {
      return
    }

    setChapterDraft(buildChapterDraft(chapterQuery.data))
    setChapterDirty(false)
    setChapterSaveState('saved')
    setChapterLastSavedAt(chapterQuery.data.updatedAt)
    setChapterSaveMessage(`已同步到 ${formatDateTime(chapterQuery.data.updatedAt)}`)
  }, [chapterQuery.data, selectedChapterId])

  useEffect(() => {
    if (!chapterQuery.isError) {
      return
    }

    setChapterSaveState('error')
    setChapterSaveMessage(
      chapterQuery.error instanceof Error ? chapterQuery.error.message : '章节暂时无法打开，请重试。',
    )
  }, [chapterQuery.error, chapterQuery.isError])

  const syncStudioPayload = useCallback(
    (updater: (current: StudioPayload | undefined) => StudioPayload | undefined) => {
      queryClient.setQueryData<StudioPayload>(['studio', activeNovelId], updater)
      // 标记这次缓存变更来自本地写入，studioQuery.data effect 据此跳过全量覆盖
      localStudioPayloadRef.current =
        queryClient.getQueryData<StudioPayload>(['studio', activeNovelId]) ?? null
    },
    [activeNovelId, queryClient],
  )

  // Agent Loop 写工具落库后同步工作区：直接刷新本地章节树/作品信息，
  // 同时把 fresh payload 写回 studioQuery 缓存（经 syncStudioPayload 标记，
  // 不会触发 effect 重置 selectedChapterId），避免缓存陈旧导致后续
  // 保存/发布等增量更新基于旧数据、再被 effect 覆盖回 state 时丢章
  const agentRefreshTimerRef = useRef<number | null>(null)
  const agentChangedChapterIdsRef = useRef<Set<string>>(new Set())
  const agentWorkspaceDirtyRef = useRef(false)
  const chapterQueryRefetchRef = useRef(chapterQuery.refetch)
  chapterQueryRefetchRef.current = chapterQuery.refetch
  const pendingChapterReviewsRef = useRef(pendingChapterReviews)
  pendingChapterReviewsRef.current = pendingChapterReviews
  const chaptersStateRef = useRef(chapters)
  chaptersStateRef.current = chapters
  const currentNovelStateRef = useRef(currentNovel)
  currentNovelStateRef.current = currentNovel
  const novelFormStateRef = useRef(novelForm)
  novelFormStateRef.current = novelForm
  const chapterDraftStateRef = useRef(chapterDraft)
  chapterDraftStateRef.current = chapterDraft
  const chapterDirtyRef = useRef(chapterDirty)
  chapterDirtyRef.current = chapterDirty
  // 切章守卫与编辑器 blur flush 可能几乎同时触发保存，in-flight 期间直接跳过，避免并发写同一章节。
  const selectedChapterIdStateRef = useRef(selectedChapterId)
  selectedChapterIdStateRef.current = selectedChapterId

  // 自动追踪：Agent 写入章节时编辑器跟随跳转（用户正在手动编辑未保存时不打断）
  const agentFollowChapterRef = useRef<(chapterId: string) => void>(() => {})
  agentFollowChapterRef.current = (chapterId: string) => {
    if (!useAgentStore.getState().autoFollow) {
      return
    }
    // Work 追踪不仅切章节：右侧作品树和正文查看器被折叠时也要恢复完整追踪布局。
    // 即使目标就是当前章，也必须先把被收起的面板重新打开。
    if (workspacePerspective === 'work') {
      setWorkInspectorTab('work')
      setWorkRightOpen(true)
      setWorkViewer('chapter')
    } else {
      setIdeTreeOpen(true)
      setIdeSidebarTab('work')
    }
    if (chapterId === selectedChapterId || chapterDirty) {
      return
    }
    setSelectedTreeItemId(`chapter:${chapterId}`)
    setSelectedChapterId(chapterId)
    setEditorChapterSettingsOpen(false)
    setChapterDraft(null)
    setChapterSaveState('idle')
    setChapterSaveMessage('Agent 正在写这一章，已自动跟随…')
  }

  // Agent Loop 写正文后进入 IDE 式审查：用 chapterDiff 负载构造待审章节，按 chapterId upsert 进数组，
  // 编辑器随即以绿(新增)/红(删除) diff 呈现，由用户“保留/撤销”逐章定夺
  const captureAgentChapterReview = useCallback(
    (event: Extract<AgentStreamEvent, { type: 'tool.result' }>) => {
      const display = event.display
      if (!display || display.kind !== 'chapterDiff' || display.before === display.after) {
        return
      }

      const chapterListItem =
        chaptersStateRef.current.find((item) => item.id === display.chapterId) ?? null
      const draft = chapterDraftStateRef.current
      const draftMatches = draft?.id === display.chapterId ? draft : null
      const summary = draftMatches?.summary ?? chapterListItem?.summary ?? ''
      const status = draftMatches?.status ?? chapterListItem?.status ?? 'draft'
      const visibility = draftMatches?.visibility ?? chapterListItem?.visibility ?? 'private'
      const orderIndex =
        draftMatches?.orderIndex ?? chapterListItem?.orderIndex ?? chaptersStateRef.current.length + 1
      const currentReview = pendingChapterReviewsRef.current.find(
        (item) => item.chapterId === display.chapterId,
      )

      const afterState: ChapterDraftState = {
        id: display.chapterId,
        title: display.chapterTitle,
        summary,
        content: display.after,
        status,
        visibility,
        orderIndex,
        revision:
          display.revision ??
          currentReview?.after.revision ??
          draftMatches?.revision ??
          chapterListItem?.revision ??
          1,
        localOnly: false,
      }

      // 同一章节连续写入（如 chapter_write 后再 append）：保留最早的 before/回滚快照，仅推进 after；
      // 其他章节的审查态不受影响（fix：新章写入不再覆盖旧章未定夺的审查）
      if (currentReview) {
        setPendingChapterReviews((current) =>
          current.map((item) =>
            item.chapterId === display.chapterId
              ? {
                  ...item,
                  after: afterState,
                  runId: event.runId,
                  description: buildChapterReviewDescription(
                    item.before === null ? 'create' : 'replace',
                    display.chapterTitle,
                  ),
                }
              : item,
          ),
        )
        return
      }

      const isCreate = event.toolName === 'chapter_create'
      const beforeTitle = chapterListItem?.title ?? display.chapterTitle
      const rollbackSnapshot: AgentLocalRollbackSnapshot = isCreate
        ? {
            kind: 'remove_created_chapter',
            chapter: {
              id: display.chapterId,
              title: display.chapterTitle,
              summary,
              content: display.after,
              status,
              visibility,
              wordCount: display.after.length,
              updatedAt: null,
            },
            previousSelectedChapterId:
              selectedChapterIdStateRef.current === display.chapterId
                ? null
                : selectedChapterIdStateRef.current,
          }
        : {
            kind: 'restore_chapter',
            chapter: {
              id: display.chapterId,
              title: beforeTitle,
              summary,
              content: display.before,
              status,
              visibility,
              wordCount: display.before.length,
              updatedAt: null,
            },
            selectedChapterId: selectedChapterIdStateRef.current,
          }

      setPendingChapterReviews((current) => [
        ...current.filter((item) => item.chapterId !== display.chapterId),
        buildPendingChapterReview({
          before: isCreate
            ? null
            : { ...afterState, title: beforeTitle, content: display.before },
          after: afterState,
          rollbackSnapshot,
          description: buildChapterReviewDescription(
            isCreate ? 'create' : event.toolName === 'chapter_append' ? 'append' : 'replace',
            display.chapterTitle,
          ),
          runId: event.runId,
        }),
      ])
    },
    [],
  )

  const refreshWorkspaceAfterAgentWrite = useCallback(async () => {
    agentWorkspaceDirtyRef.current = false
    try {
      const payload = await getStudioPayload(activeNovelId)
      // Agent 改过书名/简介/标签后必须同步重置作品表单，否则 novelDirty 会被判为脏，
      // 1200ms 自动保存会用旧表单把 Agent 刚落库的内容覆盖回去；
      // 仅当用户自己有未保存的手动修改时才保留表单不动
      const userEditingNovelForm = isNovelFormDirty(currentNovelStateRef.current, novelFormStateRef.current)
      const previousCoverAssetId = currentNovelStateRef.current?.coverAssetId ?? null

      setChapters(payload.chapters)
      setVolumes(payload.volumes)
      // 当前打开的章节被回退删除：回落到首章或目录。
      // 失效的 selectedChapterId 会让后续发送在后端报章节 404，
      // 此前前端把它误判成会话删除而清空整段对话（P0 数据丢失事故根因）
      if (selectedChapterId && !payload.chapters.some((chapter) => chapter.id === selectedChapterId)) {
        const fallbackChapter = payload.chapters[0] ?? null
        setSelectedChapterId(fallbackChapter?.id ?? null)
        setSelectedTreeItemId(fallbackChapter ? `chapter:${fallbackChapter.id}` : 'catalog')
        setChapterDraft(null)
        setChapterDirty(false)
        setChapterSaveState('idle')
        setChapterSaveMessage(fallbackChapter ? '正在打开章节...' : '当前章节已被回退删除。')
      }
      setCurrentNovel(payload.novel)
      setCoverAssets(payload.coverAssets)
      // fresh payload 写回缓存，保持双源一致（避免丢章 bug）
      syncStudioPayload(() => payload)
      if (!userEditingNovelForm) {
        setNovelForm(buildNovelFormState(payload.novel))
        setNovelDirty(false)
      }
      if ((payload.novel.coverAssetId ?? null) !== previousCoverAssetId) {
        setSelectedCoverId(payload.novel.coverAssetId ?? payload.coverAssets[0]?.id ?? null)
        // Agent 换过封面：同步本机书架快照，书架不再停留在旧封面路径
        if (payload.novel.coverUrl) {
          updateShelfCover(payload.novel.id, payload.novel.coverUrl)
        }
      }

      // 站内其它页面（作品详情/个人中心/创作中心列表）同步看到 Agent 的修改
      void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      void queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
      void queryClient.invalidateQueries({ queryKey: ['novel-detail', activeNovelId] })
      void queryClient.invalidateQueries({ queryKey: ['studio', activeNovelId, 'memory-graph'] })

      const changedChapterIds = agentChangedChapterIdsRef.current
      agentChangedChapterIdsRef.current = new Set()
      if (selectedChapterId && changedChapterIds.has(selectedChapterId) && !chapterDirty) {
        void chapterQueryRefetchRef.current()
      }
    } catch {
      // 静默失败：run 结束或下一次写入事件仍会触发刷新
      agentWorkspaceDirtyRef.current = true
    }
  }, [activeNovelId, chapterDirty, queryClient, selectedChapterId, syncStudioPayload])

  const handleAgentStreamEvent = useCallback(
    (event: AgentStreamEvent) => {
      if (event.type === 'tool.delta' && event.draft?.kind === 'chapter') {
        const targetId = event.draft.targetId
          ?? (event.draft.toolName === 'chapter_create' ? null : selectedChapterIdStateRef.current)
        if (targetId) agentFollowChapterRef.current(targetId)
      }
      if (event.type === 'tool.result' && event.ok && event.toolName.startsWith('memory_')) {
        void queryClient.invalidateQueries({ queryKey: ['studio', activeNovelId, 'memory-graph'] })
      }
      if (event.type === 'run.finished') {
        void queryClient.invalidateQueries({ queryKey: ['studio', activeNovelId, 'memory-graph'] })
      }

      // 跨任务编排新增的运行中窗口（task_spawn 派生 / task_send 投递）：
      // 立即登记进侧栏并亮起运行中标记，但不抢当前窗口的焦点（主控窗口还在跑）
      if (event.type === 'task.spawned') {
        const spawnedHere = event.sessions.filter((item) => item.novelId === activeNovelId)
        if (spawnedHere.length > 0) {
          setAgentTaskWindows((current) =>
            dedupeAgentTaskWindows([
              ...current,
              ...spawnedHere.map((item) =>
                createLocalAgentTaskWindow({
                  id: item.sessionId,
                  sessionId: item.sessionId,
                  title: item.title,
                  temporary: false,
                  customNamed: true,
                  createdAt: event.ts,
                  updatedAt: event.ts,
                }),
              ),
            ]),
          )
        }
        // 复用远端运行状态同步通道：不用等 10s 轮询，派生窗口的运行中小点当帧就亮
        useAgentStore.getState().syncRemoteRunStatuses(
          Object.fromEntries(
            event.sessions.map((item) => [
              item.sessionId,
              { runId: item.runId, status: 'running' as const, finishedAt: null },
            ]),
          ),
        )
        void queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] })
      }

      // plan_save：把规划文档直接写进左侧「计划」文件夹并选中，无需用户手动存入
      if (event.type === 'tool.result' && event.ok && event.display?.kind === 'planFile') {
        const display = event.display
        const planArtifact: AgentArtifact = {
          id: `plan-${display.artifactId}`,
          task: 'plan-chapter',
          type: 'chapter_plan',
          title: display.title,
          content: display.content,
          rawContent: display.content,
          createdAt: event.ts,
          status: 'ready',
          runId: event.runId,
          runStatusMode: 'none',
          backendArtifactId: display.artifactId,
          savedAsPlan: true,
        }

        setAgentArtifacts((current) => [
          planArtifact,
          ...current.filter((artifact) => artifact.backendArtifactId !== display.artifactId),
        ])
        setActiveAgentArtifactId(planArtifact.id)
        setSelectedTreeItemId(`plan:${planArtifact.id}`)
        // 同步写入云端副本，切换任务窗口/刷新后仍可见
        setServerPlanFiles((current) => [
          {
            id: `server-${display.artifactId}`,
            title: display.title,
            content: display.content.trim(),
            createdAt: event.ts,
            artifactId: `server-${display.artifactId}`,
            backendArtifactId: display.artifactId,
          },
          ...current.filter((plan) => plan.backendArtifactId !== display.artifactId),
        ])
        // 新建计划也挂审查条：空基线→全绿新增，撤销即从计划夹移除
        setPendingPlanReview({
          id: `plan-review-${display.artifactId}-${Date.now()}`,
          backendArtifactId: display.artifactId,
          title: display.title,
          beforeTitle: display.title,
          before: '',
          after: display.content,
          description: `已新建计划《${display.title}》，确认是否保留`,
          isCreate: true,
          runId: event.runId,
          createdAt: event.ts,
        })
        return
      }

      // plan_save 更新既有计划（planDiff）：先落库后审——同步新内容到计划夹，再挂出审查条供保留/撤销
      if (event.type === 'tool.result' && event.ok && event.display?.kind === 'planDiff') {
        const display = event.display
        const planArtifact: AgentArtifact = {
          id: `plan-${display.artifactId}`,
          task: 'plan-chapter',
          type: 'chapter_plan',
          title: display.title,
          content: display.after,
          rawContent: display.after,
          createdAt: event.ts,
          status: 'ready',
          runId: event.runId,
          runStatusMode: 'none',
          backendArtifactId: display.artifactId,
          savedAsPlan: true,
        }

        setAgentArtifacts((current) => [
          planArtifact,
          ...current.filter((artifact) => artifact.backendArtifactId !== display.artifactId),
        ])
        setActiveAgentArtifactId(planArtifact.id)
        setSelectedTreeItemId(`plan:${planArtifact.id}`)
        setServerPlanFiles((current) => [
          {
            id: `server-${display.artifactId}`,
            title: display.title,
            content: display.after.trim(),
            createdAt: event.ts,
            artifactId: `server-${display.artifactId}`,
            backendArtifactId: display.artifactId,
          },
          ...current.filter((plan) => plan.backendArtifactId !== display.artifactId),
        ])
        // 同一份计划连续修订：保留最早的 before，仅推进 after
        setPendingPlanReview((current) =>
          current && current.backendArtifactId === display.artifactId
            ? {
                ...current,
                title: display.title,
                after: display.after,
                runId: event.runId,
                description: `已更新计划《${display.title}》，确认是否保留本次修订`,
              }
            : {
                id: `plan-review-${display.artifactId}-${Date.now()}`,
                backendArtifactId: display.artifactId,
                title: display.title,
                beforeTitle: display.beforeTitle,
                before: display.before,
                after: display.after,
                description: `已更新计划《${display.title}》，确认是否保留本次修订`,
                runId: event.runId,
                createdAt: event.ts,
              },
        )
        return
      }

      // plan_rename：就地同步计划标题，不新建副本
      if (event.type === 'tool.result' && event.ok && event.display?.kind === 'planRename') {
        const display = event.display
        setAgentArtifacts((current) =>
          current.map((artifact) =>
            artifact.backendArtifactId === display.artifactId
              ? { ...artifact, title: display.title }
              : artifact,
          ),
        )
        setServerPlanFiles((current) =>
          current.map((plan) =>
            plan.backendArtifactId === display.artifactId ? { ...plan, title: display.title } : plan,
          ),
        )
        return
      }

      // plan_delete：从计划文件夹移除（后端已同步 savedAsPlan=false）
      if (event.type === 'tool.result' && event.ok && event.display?.kind === 'planDelete') {
        const display = event.display
        setAgentArtifacts((current) =>
          current.map((artifact) =>
            artifact.backendArtifactId === display.artifactId
              ? { ...artifact, savedAsPlan: false }
              : artifact,
          ),
        )
        setServerPlanFiles((current) =>
          current.filter((plan) => plan.backendArtifactId !== display.artifactId),
        )
        setSelectedTreeItemId((current) =>
          current && current.startsWith('plan:') ? null : current,
        )
        return
      }

      if (event.type === 'tool.result' && event.ok && event.display?.kind === 'changeSet') {
        setActiveChangeSetId(event.display.changeSetId)
      }

      if (event.type === 'tool.result' && event.ok && WORKSPACE_WRITE_TOOLS.has(event.toolName)) {
        agentWorkspaceDirtyRef.current = true
        const display = event.display as { chapterId?: unknown } | undefined
        if (display && typeof display.chapterId === 'string') {
          agentChangedChapterIdsRef.current.add(display.chapterId)
          // 自动追踪模式：跳转到 Agent 正在写的章节
          agentFollowChapterRef.current(display.chapterId)
        }

        captureAgentChapterReview(event)

        // 去抖合并连续写入（如 chapter_create 紧跟 chapter_write）
        if (agentRefreshTimerRef.current !== null) {
          window.clearTimeout(agentRefreshTimerRef.current)
        }
        agentRefreshTimerRef.current = window.setTimeout(() => {
          agentRefreshTimerRef.current = null
          void refreshWorkspaceAfterAgentWrite()
        }, 600)
        return
      }

      if (event.type === 'run.finished' && agentWorkspaceDirtyRef.current) {
        if (agentRefreshTimerRef.current !== null) {
          window.clearTimeout(agentRefreshTimerRef.current)
          agentRefreshTimerRef.current = null
        }
        void refreshWorkspaceAfterAgentWrite()
      }
    },
    [activeNovelId, captureAgentChapterReview, queryClient, refreshWorkspaceAfterAgentWrite],
  )

  useEffect(
    () => () => {
      if (agentRefreshTimerRef.current !== null) {
        window.clearTimeout(agentRefreshTimerRef.current)
      }
    },
    [],
  )

  const selectedCover = useMemo(
    () => coverAssets.find((asset) => asset.id === selectedCoverId) ?? null,
    [coverAssets, selectedCoverId],
  )
  const novelOptions = useMemo(() => {
    const novelsWithSessions = new Set((navigationSessionsQuery.data?.items ?? []).map((session) => session.novelId))
    // “未命名、0 章、0 字”不等于可以丢弃：只要已产生 Agent 会话，它就是用户的真实作品。
    const source = (myNovelsQuery.data ?? []).filter((novel) => shouldShowWorkspaceNovel(novel, novelsWithSessions.has(novel.id)))
    const byId = new Map(source.map((novel) => [novel.id, novel]))
    if (currentNovel && !byId.has(currentNovel.id)) byId.set(currentNovel.id, currentNovel)
    return [...byId.values()].sort((left, right) => {
      const latest = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      return latest || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    })
  }, [currentNovel, myNovelsQuery.data, navigationSessionsQuery.data?.items])

  const activeChapterListItem = useMemo(
    () => chapters.find((item) => item.id === selectedChapterId) ?? null,
    [chapters, selectedChapterId],
  )
  const activeVolumeTitle = useMemo(
    () => volumes.find((volume) => volume.id === activeChapterListItem?.volumeId)?.title ?? null,
    [activeChapterListItem?.volumeId, volumes],
  )
  const savedPlanFiles = useMemo(() => {
    const localPlans = buildWorkspacePlanFiles(agentArtifacts)
    const serverByBackendId = new Map(
      serverPlanFiles
        .filter((plan): plan is WorkspacePlanFile & { backendArtifactId: string } => Boolean(plan.backendArtifactId))
        .map((plan) => [plan.backendArtifactId, plan]),
    )
    const orderedLocalPlans = localPlans.map((plan) => ({
      ...plan,
      // The same persisted plan must keep its identity when session history arrives.
      id: stablePlanId(plan),
      orderIndex: plan.backendArtifactId ? serverByBackendId.get(plan.backendArtifactId)?.orderIndex ?? null : null,
    }))
    const localBackendIds = new Set(
      orderedLocalPlans.map((plan) => plan.backendArtifactId).filter((id): id is string => Boolean(id)),
    )

    // 本地（活跃任务窗口）优先，云端补齐其他窗口/历史会话的计划
    return [
      ...orderedLocalPlans,
      ...serverPlanFiles.filter(
        (plan) => !plan.backendArtifactId || !localBackendIds.has(plan.backendArtifactId),
      ),
    ].sort((left, right) => {
      const leftOrder = left.orderIndex ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.orderIndex ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    })
  }, [agentArtifacts, serverPlanFiles])
  // 计划设置抽屉指向的计划：计划被删除/切换作品后自动收起
  const planSettingsPlan = planSettingsPlanId
    ? savedPlanFiles.find((plan) => plan.id === planSettingsPlanId) ?? null
    : null
  const catalogPreview = useMemo(
    () =>
      buildCatalogPreview(
        currentNovel?.displayTitle?.trim() || currentNovel?.title?.trim() || novelForm?.displayTitle.trim() || novelForm?.title.trim() || '当前作品',
        chapters,
        volumes,
      ),
    [chapters, currentNovel?.displayTitle, currentNovel?.title, novelForm?.displayTitle, novelForm?.title, volumes],
  )
  useEffect(() => {
    setCatalogDocument((current) => {
      if (!current) {
        return {
          title: catalogPreview.title,
          content: catalogPreview.content,
          manualTitle: false,
          manualContent: false,
        }
      }

      return {
        title: current.manualTitle ? current.title : catalogPreview.title,
        content: current.manualContent
          ? mergeCatalogContentWithChapters(current.content, catalogPreview.content)
          : catalogPreview.content,
        manualTitle: current.manualTitle,
        manualContent: current.manualContent,
      }
    })
  }, [catalogPreview])

  const activeWorkspaceDocument = useMemo<WorkspaceDocumentView | null>(() => {
    if (selectedTreeItemId === 'catalog') {
      return catalogDocument
        ? {
            kind: 'catalog',
            id: 'catalog',
            title: catalogDocument.title,
            content: catalogDocument.content,
            description: `${catalogPreview.description} 支持直接在正文区手动修改。`,
            editableTitle: true,
            editableContent: true,
          }
        : {
            kind: 'catalog',
            id: 'catalog',
            title: catalogPreview.title,
            content: catalogPreview.content,
            description: `${catalogPreview.description} 支持直接在正文区手动修改。`,
            editableTitle: true,
            editableContent: true,
          }
    }

    if (selectedTreeItemId?.startsWith('plan:')) {
      const targetPlan = savedPlanFiles.find((plan) => plan.id === selectedTreeItemId.slice('plan:'.length))
      if (!targetPlan) {
        return null
      }

      return {
        kind: 'plan',
        id: targetPlan.id,
        title: targetPlan.title,
        content: targetPlan.content,
        description: `已存入计划文件夹 · ${new Intl.DateTimeFormat('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(targetPlan.createdAt))} · 支持直接改名或补充计划内容。`,
        editableTitle: true,
        editableContent: true,
      }
    }

    return null
  }, [catalogDocument, catalogPreview, savedPlanFiles, selectedTreeItemId])

  const composerReferenceOptions = useMemo<Array<Omit<ComposerReference, 'offset'>>>(() => [
    {
      id: 'catalog',
      kind: 'catalog',
      name: catalogDocument?.title ?? catalogPreview.title,
      text: catalogDocument?.content ?? catalogPreview.content,
      startLine: 1,
      endLine: Math.max(1, (catalogDocument?.content ?? catalogPreview.content).split('\n').length),
    },
    ...savedPlanFiles.map((plan) => ({
      id: `plan:${plan.id}`,
      kind: 'plan' as const,
      name: plan.title,
      text: plan.content,
      startLine: 1,
      endLine: Math.max(1, plan.content.split('\n').length),
    })),
    ...chapters.map((chapter) => ({
      id: `chapter:${chapter.id}`,
      kind: 'chapter' as const,
      name: chapter.title.trim() ? `第 ${chapter.orderInVolume} 章 · ${chapter.title.trim()}` : `第 ${chapter.orderInVolume} 章`,
      text: '',
      startLine: 1,
      endLine: 1,
    })),
  ], [catalogDocument?.content, catalogDocument?.title, catalogPreview.content, catalogPreview.title, chapters, savedPlanFiles])

  const activeLiveToolDraft = useMemo(() => Object.values(liveToolDrafts).at(-1) ?? null, [liveToolDrafts])
  const liveChapterTargetId = activeLiveToolDraft?.kind === 'chapter'
    ? activeLiveToolDraft.targetId ?? (activeLiveToolDraft.toolName === 'chapter_create' ? null : selectedChapterId)
    : null
  const livePlanTarget = activeLiveToolDraft?.kind === 'plan'
    ? savedPlanFiles.find((plan) => plan.id === activeLiveToolDraft.targetId || plan.backendArtifactId === activeLiveToolDraft.targetId) ?? null
    : null
  const chapterStreamingPreview = liveChapterTargetId && liveChapterTargetId === selectedChapterId ? activeLiveToolDraft?.content : undefined
  const documentStreamingPreview = livePlanTarget && activeWorkspaceDocument?.kind === 'plan' && livePlanTarget.id === activeWorkspaceDocument.id
    ? activeLiveToolDraft?.content
    : undefined
  const selectChapterFromToolRef = useRef(handleSelectChapter)
  const { handleSelectPlanFromTree, handleRequestDeletePlan, handleRequestCreatePlan, handleRenamePlan, handleWorkspaceDocumentChange } = createPlanDocumentActions({
    activeNovelId, savedPlanFiles, agentArtifacts, selectedTreeItemId, catalogPreview, setSelectedTreeItemId, setWorkViewer, setMobileView, setActiveAgentArtifactId, setAgentArtifacts, setServerPlanFiles, setChapterSaveState, setChapterSaveMessage, setAgentRunState, setWorkspaceDialog, setCatalogDocument, updateAgentArtifact, schedulePlanServerSync,
  })
  const selectPlanFromToolRef = useRef(handleSelectPlanFromTree)
  const selectAgentTaskWindowFromToolRef = useRef(handleSelectAgentTaskWindow)
  selectChapterFromToolRef.current = handleSelectChapter
  selectPlanFromToolRef.current = handleSelectPlanFromTree
  selectAgentTaskWindowFromToolRef.current = handleSelectAgentTaskWindow

  useEffect(() => {
    if (!toolNavigationRequest) return
    const args = toolNavigationRequest.args && typeof toolNavigationRequest.args === 'object'
      ? toolNavigationRequest.args as Record<string, unknown>
      : {}
    const display = toolNavigationRequest.display
    const chapterId = display?.kind === 'chapterDiff' || display?.kind === 'chapterRef'
      ? display.chapterId
      : typeof args.chapterId === 'string' ? args.chapterId : null
    if (chapterId) {
      if (!chapters.some((chapter) => chapter.id === chapterId)) {
        toast.error('目标章节尚未载入或已删除，请刷新作品后重试。')
        clearToolNavigationRequest()
        return
      }
      window.dispatchEvent(new Event('chevoink:work-open-document'))
      selectChapterFromToolRef.current(chapterId)
      if (workspacePerspective === 'work') {
        setWorkInspectorTab('work')
        setWorkRightOpen(true)
        setWorkViewer('chapter')
      } else {
        setIdeTreeOpen(true)
        setIdeSidebarTab('work')
      }
    } else if (display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename' || toolNavigationRequest.toolName.startsWith('plan_')) {
      const artifactId = display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
        ? display.artifactId
        : typeof args.planId === 'string' ? args.planId : null
      const target = savedPlanFiles.find((plan) => plan.id === artifactId || plan.backendArtifactId === artifactId)
      if (target) {
        window.dispatchEvent(new Event('chevoink:work-open-document'))
        selectPlanFromToolRef.current(target.id)
        if (workspacePerspective === 'work') {
          setWorkInspectorTab('work')
          setWorkRightOpen(true)
          setWorkViewer('document')
        } else {
          setIdeTreeOpen(true)
          setIdeSidebarTab('work')
        }
      } else {
        toast.error('目标计划尚未载入或已删除，请刷新作品后重试。')
      }
    } else if (display?.kind === 'taskOrchestration') {
      // 编排卡片里点某个并行窗口：直接切到那个任务窗口（主控还在跑时由切窗逻辑自己拦下来）
      const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : null
      if (targetSessionId) {
        void selectAgentTaskWindowFromToolRef.current(targetSessionId)
      }
    }
    clearToolNavigationRequest()
  }, [chapters, toast, clearToolNavigationRequest, savedPlanFiles, toolNavigationRequest, workspacePerspective, setIdeSidebarTab, setIdeTreeOpen, setWorkInspectorTab, setWorkRightOpen, setWorkViewer])

  // 记忆沉淀卡点击：把记忆面板切到可见位置，由当前可见的记忆中心实例开覆层闪卡
  useEffect(() => {
    if (!memorySpotlight) return
    if (Date.now() - memorySpotlight.nonce > 8000) return
    if (window.innerWidth < 1024) {
      setMobileView('context')
      return
    }
    if (workspacePerspective === 'ide') {
      setIdeSidebarTab('context')
      setIdeTreeOpen(true)
    } else {
      setWorkInspectorTab('context')
      setWorkRightOpen(true)
    }
  }, [memorySpotlight, workspacePerspective, setIdeSidebarTab, setIdeTreeOpen, setWorkInspectorTab, setWorkRightOpen])

  // 当前计划文档命中审查态时，正文区呈现绿(新增)/红(删除) diff（与章节审查一致，fix1）
  const activePlanPendingReview = useMemo(() => {
    if (!pendingPlanReview || activeWorkspaceDocument?.kind !== 'plan') {
      return null
    }
    const targetPlan = savedPlanFiles.find((plan) => plan.id === activeWorkspaceDocument.id)
    return targetPlan?.backendArtifactId === pendingPlanReview.backendArtifactId
      ? pendingPlanReview
      : null
  }, [activeWorkspaceDocument, pendingPlanReview, savedPlanFiles])

  const latestWordCount = useMemo(() => chapterDraft?.content.trim().length ?? 0, [chapterDraft])
  const activeAgentTaskWindow = useMemo(
    () =>
      agentTaskWindows.find((taskWindow) => taskWindow.id === activeAgentTaskWindowId) ??
      null,
    [activeAgentTaskWindowId, agentTaskWindows],
  )
  const agentTaskSidebarItems = useMemo(
    () => agentTaskWindows.map((taskWindow) => ({
      id: taskWindow.id,
      title: taskWindow.title,
      updatedAt: taskWindow.updatedAt,
      temporary: taskWindow.temporary,
      prompt: taskWindow.prompt,
      artifactsCount: taskWindow.artifacts.length,
    })).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [agentTaskWindows],
  )
  const agentConversationRailItems = useMemo(() => {
    const items: Array<{ id: string; userMessageId: string; userText: string; assistantText: string }> = []
    for (let index = 0; index < agentMessages.length; index += 1) {
      const message = agentMessages[index]
      if (message.role !== 'user') continue
      let assistantText = ''
      for (let replyIndex = index + 1; replyIndex < agentMessages.length; replyIndex += 1) {
        const reply = agentMessages[replyIndex]
        if (reply.role === 'user') break
        if (reply.role === 'assistant') assistantText += `${assistantText ? '\n' : ''}${getMessageText(reply.parts)}`
      }
      items.push({
        id: message.id,
        userMessageId: message.id,
        userText: getMessageText(message.parts),
        assistantText: assistantText.trim(),
      })
    }
    return items
  }, [agentMessages])

  useEffect(() => {
    if (!taskUiScope || workPanelScope !== taskUiScope || currentNovel?.id !== activeNovelId) return
    if (workViewer === 'document') return
    if (!selectedTreeItemId && selectedChapterId) {
      setSelectedTreeItemId(`chapter:${selectedChapterId}`)
    }
  }, [selectedChapterId, selectedTreeItemId, taskUiScope, workPanelScope, currentNovel?.id, activeNovelId, workViewer])

  useEffect(() => {
    // Empty lists during cross-novel/task hydration are not deletion evidence.
    if (!taskUiScope || workPanelScope !== taskUiScope || currentNovel?.id !== activeNovelId || agentSessionsResolving) return
    if (!selectedTreeItemId) {
      return
    }

    if (selectedTreeItemId === 'catalog') {
      return
    }

    if (selectedTreeItemId.startsWith('chapter:')) {
      const chapterId = selectedTreeItemId.slice('chapter:'.length)
      // Agent 刚创建的章节要等 600ms 去抖刷新后才进入本地列表，此间不回弹选中项（fix2a 自动追踪）
      if (
        !chapters.some((chapter) => chapter.id === chapterId) &&
        !agentChangedChapterIdsRef.current.has(chapterId)
      ) {
        setSelectedTreeItemId(selectedChapterId ? `chapter:${selectedChapterId}` : 'catalog')
      }
      return
    }

    if (selectedTreeItemId.startsWith('plan:')) {
      const next = reconcilePlanSelection(selectedTreeItemId, savedPlanFiles,
        plansLoadedNovelId === activeNovelId && Boolean(activeAgentTaskWindow?.loaded || !activeAgentTaskWindow?.sessionId))
      if (next !== selectedTreeItemId) setSelectedTreeItemId(next)
    }
  }, [chapters, savedPlanFiles, selectedChapterId, selectedTreeItemId, taskUiScope, workPanelScope, currentNovel?.id, activeNovelId, agentSessionsResolving, plansLoadedNovelId, activeAgentTaskWindow?.loaded, activeAgentTaskWindow?.sessionId])

  function handleSelectWorkspaceNovel(novelId: string) {
    if (novelId === activeNovelId) {
      return
    }

    if (pendingChapterReviews.length > 0) {
      promptConfirmPendingChapterReview('切换作品')
      return
    }

    resetWorkspaceDraftState()
    navigate(`/studio/novel/${novelId}`)
  }

  function handleCreateWorkspaceNovel() {
    // Pending reviews belong to the old novel and remain persisted there.
    if (createNovelMutation.isPending) {
      return
    }

    setCreateNovelDialogOpen(true)
  }

  function resetWorkspaceDraftState() {
    void queryClient.cancelQueries({ queryKey: ['studio-chapter'] })
    agentExecutionChapterTargetRef.current = null
    setSelectedChapterId(null)
    setSelectedTreeItemId(null)
    setChapterDraft(null)
    setChapterDirty(false)
    setChapterLastSavedAt(null)
    setChapterSaveState('idle')
    setChapterSaveMessage('正在打开作品...')
    setEditorChapterSettingsOpen(false)
    setMobileView('editor')
  }

  const chapterTitle = chapterDraft
    ? chapterDraft.localOnly
      ? '新章节草稿'
      : chapterDraft.title || `第 ${chapterDraft.orderIndex} 章`
    : '选择章节开始创作'

  function syncUpdatedNovelState(updatedNovel: Novel, message?: string) {
    setCurrentNovel(updatedNovel)
    setNovelForm(buildNovelFormState(updatedNovel))
    setNovelDirty(false)
    setNovelSaveState('saved')
    setNovelLastSavedAt(updatedNovel.updatedAt)
    setCoverForm((current) =>
      current
        ? {
            ...current,
            novelTitle: updatedNovel.title,
            summary: updatedNovel.summary,
            prompt: updatedNovel.coverPrompt ?? current.prompt,
          }
        : current,
    )

    if (message) {
      setNovelMessage(message)
    }

    syncStudioPayload((current) =>
      current ? { ...current, novel: { ...current.novel, ...updatedNovel } } : current,
    )
    void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
    void queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
    // 书名/简介/标签等元信息在阅读侧多处展示，保存后同步失效，否则首页/发现页/详情页仍显示旧值
    void queryClient.invalidateQueries({ queryKey: ['home'] })
    void queryClient.invalidateQueries({ queryKey: ['discover-novels'] })
    void queryClient.invalidateQueries({ queryKey: ['novel-detail', updatedNovel.id] })
    void queryClient.invalidateQueries({ queryKey: ['reader', updatedNovel.id] })
  }

  function syncSavedChapterState(
    savedChapter: Chapter,
    options: {
      message: string
      localDraftId?: string | null
      chapterCountDelta?: number
      wordCountDelta?: number
    },
  ) {
    const chapterCountDelta = options.chapterCountDelta ?? 0
    const wordCountDelta = options.wordCountDelta ?? 0

    agentExecutionChapterTargetRef.current = savedChapter.id
    setChapters((current) => replaceChapterItem(current, options.localDraftId ?? null, toChapterListItem(savedChapter)))
    setSelectedChapterId(savedChapter.id)
    setSelectedTreeItemId(`chapter:${savedChapter.id}`)
    setChapterDraft(buildChapterDraft(savedChapter))
    setChapterDirty(false)
    setChapterSaveState('saved')
    setChapterLastSavedAt(savedChapter.updatedAt)
    setChapterSaveMessage(options.message)
    queryClient.setQueryData<Chapter>(['studio-chapter', activeNovelId, savedChapter.id], savedChapter)
    setCurrentNovel((current) =>
      current
        ? {
            ...current,
            chapterCount: Math.max(0, current.chapterCount + chapterCountDelta),
            wordCount: Math.max(0, current.wordCount + wordCountDelta),
            updatedAt: savedChapter.updatedAt,
          }
        : current,
    )
    syncStudioPayload((current) =>
      current
        ? {
            ...current,
            novel: {
              ...current.novel,
              chapterCount: Math.max(0, current.novel.chapterCount + chapterCountDelta),
              wordCount: Math.max(0, current.novel.wordCount + wordCountDelta),
              updatedAt: savedChapter.updatedAt,
            },
            draftChapter:
              savedChapter.status === 'draft'
                ? savedChapter
                : current.draftChapter?.id === savedChapter.id
                  ? null
                  : current.draftChapter,
            chapters: replaceChapterItem(current.chapters, options.localDraftId ?? null, toChapterListItem(savedChapter)),
          }
        : current,
    )
    void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
    void queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
    // 已发布章节的内容更新需同步失效阅读侧缓存，避免读者看到旧正文
    if (savedChapter.status === 'published') {
      void queryClient.invalidateQueries({ queryKey: ['reader', activeNovelId] })
      void queryClient.invalidateQueries({ queryKey: ['novel-detail', activeNovelId] })
    }
  }

  const saveNovelMutation = useMutation({
    mutationFn: async ({
      statusOverride,
    }: {
      reason: 'manual' | 'auto' | 'publish'
      statusOverride?: EditableNovelStatus
    }) => {
      if (!currentNovel || !novelForm) {
        throw new Error('作品信息尚未加载完成')
      }

      const payload = buildNovelUpdatePayload({
        ...novelForm,
        status: statusOverride ?? novelForm.status,
      })

      return updateNovelMeta(currentNovel.id, payload)
    },
    onMutate: ({ reason }) => {
      setNovelSaveState('saving')
      setNovelMessage(reason === 'auto' ? '正在自动保存作品设置...' : '正在保存作品设置...')
    },
    onSuccess: (updatedNovel, variables) => {
      syncUpdatedNovelState(
        updatedNovel,
        variables.reason === 'publish'
          ? `作品已发布于 ${formatDateTime(updatedNovel.updatedAt)}`
          : variables.reason === 'auto'
            ? `作品已自动保存于 ${formatDateTime(updatedNovel.updatedAt)}`
            : `作品设置已保存于 ${formatDateTime(updatedNovel.updatedAt)}`,
      )
    },
    onError: (error: Error) => {
      setNovelSaveState('error')
      setNovelMessage(error.message)
    },
  })

  // 完结/恢复连载：仅切换作品状态，不触碰表单其它字段；completed ↔ published 双向可逆
  const novelCompletionMutation = useMutation({
    mutationFn: async ({ status }: { status: 'completed' | 'published' }) => {
      if (!currentNovel) {
        throw new Error('作品信息尚未加载完成')
      }

      return updateNovelMeta(currentNovel.id, { status })
    },
    onSuccess: (updatedNovel) => {
      syncUpdatedNovelState(
        updatedNovel,
        updatedNovel.status === 'completed' ? '作品已标记完结。' : '作品已恢复连载。',
      )
      toast.success(updatedNovel.status === 'completed' ? '作品已完结' : '已恢复连载')
    },
    onError: (error: Error) => {
      setNovelSaveState('error')
      setNovelMessage(error.message)
      toast.error(error.message)
    },
  })

  const publishNovelMutation = useMutation({
    mutationFn: async ({ chapterIds, visibility }: { chapterIds: string[]; visibility: Visibility }) => {
      return publishNovelWorkspace(activeNovelId, { chapterIds, visibility })
    },
    onSuccess: ({ novel, publishedChapterIds }, variables) => {
      const publishedSet = new Set(publishedChapterIds)
      const publishedAtFallback = novel.publishedAt ?? new Date().toISOString()

      setChapters((current) =>
        current.map((item) =>
          publishedSet.has(item.id)
            ? {
                ...item,
                status: 'published' as const,
                visibility: variables.visibility,
                publishedAt: item.publishedAt ?? publishedAtFallback,
                revision: item.revision + 1,
                publishedRevision: item.revision + 1,
              }
            : item,
        ),
      )
      setChapterDraft((current) =>
        current && publishedSet.has(current.id)
          ? {
              ...current,
              status: 'published',
              visibility: variables.visibility,
              revision: current.revision + 1,
            }
          : current,
      )
      syncStudioPayload((current) =>
        current
          ? {
              ...current,
              chapters: current.chapters.map((item) =>
                publishedSet.has(item.id)
                  ? {
                      ...item,
                      status: 'published' as const,
                      visibility: variables.visibility,
                      publishedAt: item.publishedAt ?? publishedAtFallback,
                      revision: item.revision + 1,
                      publishedRevision: item.revision + 1,
                    }
                  : item,
              ),
              draftChapter:
                current.draftChapter && publishedSet.has(current.draftChapter.id)
                  ? null
                  : current.draftChapter,
            }
          : current,
      )
      for (const chapterId of publishedChapterIds) {
        queryClient.setQueryData<Chapter>(['studio-chapter', activeNovelId, chapterId], (current) =>
          current
            ? {
                ...current,
                status: 'published',
                visibility: variables.visibility,
                publishedAt: current.publishedAt ?? publishedAtFallback,
                revision: current.revision + 1,
                publishedRevision: current.revision + 1,
              }
            : current,
        )
      }

      syncUpdatedNovelState(
        novel,
        publishedChapterIds.length > 0
          ? `作品已发布，${publishedChapterIds.length} 个章节已同步发布。`
          : '作品已发布。',
      )
      toast.success(
        publishedChapterIds.length > 0
          ? `发布成功，${publishedChapterIds.length} 个章节已同步发布`
          : '发布成功',
      )
      setPublishDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['novel-detail', activeNovelId] })
      // 发布后失效阅读器缓存，确保目录与正文能拉到新发布的章节
      void queryClient.invalidateQueries({ queryKey: ['reader', activeNovelId] })
      void queryClient.invalidateQueries({ queryKey: ['home'] })
    },
    onError: (error: Error) => {
      setNovelSaveState('error')
      setNovelMessage(error.message)
      // 发布弹窗还开着时，底层状态条被遮挡，用 toast 把后端校验信息顶到用户眼前
      toast.error(error.message)
    },
  })

  const deleteNovelMutation = useMutation({
    mutationFn: async () => {
      await deleteNovelWorkspace(activeNovelId)
    },
    onSuccess: async () => {
      const deletedNovelId = activeNovelId
      setWorkspaceDialog(null)
      setNovelMessage('作品已删除。')
      if (typeof window !== 'undefined') {
        const lastNovelId = window.localStorage.getItem(STUDIO_LAST_NOVEL_STORAGE_KEY)
        if (lastNovelId === deletedNovelId) {
          window.localStorage.removeItem(STUDIO_LAST_NOVEL_STORAGE_KEY)
        }
      }

      // 先把已删作品从共享缓存里清掉再导航：/studio 会按 ['community','me'] 挑入口作品，
      // 只做 invalidate 的话首帧拿到的还是旧数据，会把用户直接送回刚删掉的那部作品
      queryClient.setQueryData<UserMePayload>(['community', 'me'], (current) => {
        if (!current) {
          return current
        }

        return {
          ...current,
          authoredNovels: (current.authoredNovels ?? []).filter((item) => item.id !== deletedNovelId),
          drafts: (current.drafts ?? []).filter((item) => item.novelId !== deletedNovelId),
        }
      })
      queryClient.setQueryData<Novel[]>(['studio', 'my-novels'], (current) =>
        Array.isArray(current) ? current.filter((item) => item.id !== deletedNovelId) : current,
      )
      // 这部作品自己的各级缓存已经没有意义，直接丢弃，避开重新渲染旧快照或回头请求 404
      queryClient.removeQueries({ queryKey: ['studio', deletedNovelId] })
      queryClient.removeQueries({ queryKey: ['studio-chapter', deletedNovelId] })
      queryClient.removeQueries({ queryKey: ['novel-detail', deletedNovelId] })
      queryClient.removeQueries({ queryKey: ['reader', deletedNovelId] })

      navigate('/studio', { replace: true })
      await queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
      await queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
    },
    onError: (error: Error) => {
      setNovelSaveState('error')
      setNovelMessage(error.message)
    },
  })

  useEffect(() => {
    if (!novelDirty || !novelForm || saveNovelMutation.isPending) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      saveNovelMutation.mutate({ reason: 'auto' })
    }, 1200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [novelDirty, novelForm, saveNovelMutation])

  function handleSaveNovel() {
    if (!novelForm || saveNovelMutation.isPending) {
      return
    }

    saveNovelMutation.mutate({ reason: 'manual' })
  }

  function handleRequestNovelStatusAction(nextStatus: EditableNovelStatus) {
    if (!novelForm || saveNovelMutation.isPending || novelForm.status === nextStatus) {
      return
    }

    const actionMap: Record<
      EditableNovelStatus,
      { title: string; description: string; confirmLabel: string; tone?: 'default' | 'danger' }
    > = {
      draft: {
        title: '确认将作品状态设置为草稿',
        description: '执行后，这部作品会切回草稿状态，并自动保存当前作品设置。',
        confirmLabel: '确认设置为草稿',
      },
      published: {
        title: '确认立即上架作品',
        description: '执行后，这部作品会以已发布状态对外展示，并自动保存当前作品设置。',
        confirmLabel: '确认上架',
      },
      completed: {
        title: '是否完结？',
        description: '执行后，这部作品会标记为已完结并进入完结榜，同时自动保存当前作品设置。',
        confirmLabel: '确认完结',
      },
      archived: {
        title: '确认立即下架作品',
        description: '执行后，这部作品会切到已下架状态，并自动保存当前作品设置。',
        confirmLabel: '确认下架',
        tone: 'danger',
      },
    }

    const config = actionMap[nextStatus]
    setWorkspaceDialog({
      title: config.title,
      description: config.description,
      confirmLabel: config.confirmLabel,
      cancelLabel: '取消',
      tone: config.tone,
      onConfirm: () => {
        setNovelForm((current) => (current ? { ...current, status: nextStatus } : current))
      },
    })
  }

  function handleRequestNovelVisibilityAction(nextVisibility: NovelFormState['visibility']) {
    if (!novelForm || saveNovelMutation.isPending || novelForm.visibility === nextVisibility) {
      return
    }

    const actionMap: Record<
      NovelFormState['visibility'],
      { title: string; description: string; confirmLabel: string }
    > = {
      private: {
        title: '确认将作品可见范围设置为个人',
        description: '执行后，这部作品只对你自己可见，并自动保存当前作品设置。',
        confirmLabel: '确认设置为个人',
      },
      followers: {
        title: '确认将作品可见范围设置为关注可见',
        description: '执行后，这部作品只对关注你的用户可见，并自动保存当前作品设置。',
        confirmLabel: '确认设置为关注可见',
      },
      public: {
        title: '确认将作品可见范围设置为公开',
        description: '执行后，这部作品会对外公开可见，并自动保存当前作品设置。',
        confirmLabel: '确认设置为公开',
      },
    }

    const config = actionMap[nextVisibility]
    setWorkspaceDialog({
      title: config.title,
      description: config.description,
      confirmLabel: config.confirmLabel,
      cancelLabel: '取消',
      onConfirm: () => {
        setNovelForm((current) => (current ? { ...current, visibility: nextVisibility } : current))
      },
    })
  }

  function handlePublishNovel() {
    if (!novelForm || publishNovelMutation.isPending) {
      return
    }

    if (!ensureNovelPublishable('发布')) {
      return
    }

    // 打开发布弹窗：支持勾选需要一起发布的章节并选择可见范围（默认公开）
    setPublishDialogOpen(true)
  }

  /** 发布/完结共用的上架前置校验：0 章节先引导写作、无标签先引导设置；返回是否通过 */
  function ensureNovelPublishable(action: '发布' | '完结') {
    if (!novelForm) {
      return false
    }

    // 0 章节的作品不允许上架，先引导去写第一章
    if (chapters.length === 0) {
      setWorkspaceDialog({
        title: `还不能${action}这部作品`,
        description: `${action}前需要至少写好一个章节，并在发布时选择公开，读者才能看到这部作品。`,
        confirmLabel: '我知道了',
        onConfirm: () => undefined,
      })
      return false
    }

    // 没有标签的作品先引导去作品设置选标签
    const tags = novelForm.tagsText
      .split(/[、/\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (tags.length === 0) {
      setWorkspaceDialog({
        title: '请先设置作品标签',
        description: `${action}前需要为作品选择标签，读者才能在分类频道和搜索中找到这部作品。`,
        confirmLabel: '展开作品设置',
        onConfirm: () => {
          setActiveToolPanel('meta')
          setMobileView('meta')
        },
      })
      return false
    }

    return true
  }

  /** 完结 ↔ 继续连载：已完结恢复连载；连载中标记完结；草稿直接发布并完结（均弹确认框） */
  function handleToggleNovelCompletion() {
    if (!novelForm || novelCompletionMutation.isPending || publishNovelMutation.isPending) {
      return
    }

    const displayTitle = novelForm.title.trim() || currentNovel?.title || '当前作品'

    if (novelForm.status === 'completed') {
      setWorkspaceDialog({
        title: '继续连载这部作品？',
        description: `《${displayTitle}》将恢复为连载中，作品页的完结标识会移除，你可以继续写作并发布新章节。`,
        confirmLabel: '继续连载',
        cancelLabel: '取消',
        tone: 'default',
        onConfirm: async () => {
          try {
            await novelCompletionMutation.mutateAsync({ status: 'published' })
          } catch {
            // 失败原因已由 mutation onError 提示
          }
        },
      })
      return
    }

    if (novelForm.status === 'draft') {
      // 草稿完结 = 直接发布并完结：沿用发布前置校验，确认后全量发布再标记完结
      if (!ensureNovelPublishable('完结')) {
        return
      }
      setWorkspaceDialog({
        title: '发布并完结这部作品？',
        description: `《${displayTitle}》的全部章节将随完结一并发布公开，作品同时标记为完结；完结后仍可继续连载。`,
        confirmLabel: '发布并完结',
        cancelLabel: '取消',
        tone: 'default',
        onConfirm: async () => {
          try {
            await publishNovelMutation.mutateAsync({ chapterIds: chapters.map((item) => item.id), visibility: 'public' })
            await novelCompletionMutation.mutateAsync({ status: 'completed' })
          } catch {
            // 失败原因已由 mutation onError 提示
          }
        },
      })
      return
    }

    setWorkspaceDialog({
      title: '完结这部作品？',
      description: `《${displayTitle}》将标记为完结，作品页会展示完结标识；已发布章节不受影响，随时可以继续连载。`,
      confirmLabel: '标记完结',
      cancelLabel: '取消',
      tone: 'default',
      onConfirm: async () => {
        try {
          await novelCompletionMutation.mutateAsync({ status: 'completed' })
        } catch {
          // 失败原因已由 mutation onError 提示
        }
      },
    })
  }

  function handleRequestDeleteNovel() {
    if (deleteNovelMutation.isPending) {
      return
    }

    if (!novelForm) {
      return
    }

    if (novelForm.status === 'published') {
      // 不把入口置灰：允许点击并用 toast 说清该去哪里下架，比一个不可点的按钮更易理解
      toast.error('已发布作品不能直接删除，请先去「作品设置」将作品下架，之后再执行删除。')
      return
    }

    setWorkspaceDialog({
      title: '确认删除作品',
      description: '仅草稿或已下架作品允许删除。删除后，这部作品的章节、Agent 记录与封面素材都会一起移除，且无法恢复。确定要删除吗？',
      confirmLabel: '确定删除',
      cancelLabel: '取消',
      tone: 'danger',
      onConfirm: async () => {
        await deleteNovelMutation.mutateAsync()
      },
    })
  }

  function promptConfirmPendingChapterReview(actionLabel: string) {
    setWorkspaceDialog({
      title: '请先确认当前正文改动',
      description: `当前章节还有待确认的正文变更，请先选择“接受”或“拒绝”，再继续${actionLabel}。`,
      confirmLabel: '我知道了',
      cancelLabel: '关闭',
      onConfirm: () => undefined,
    })
  }

  const persistChapter = useChapterPersistence({
    activeNovelId, chapterDraft, chapterDirty, chapterDraftStateRef, pendingChapterReviewsRef, selectedChapterIdStateRef, promptConfirmPendingChapterReview, setChapterSaveState, setChapterSaveMessage, setChapters, setSelectedTreeItemId, setSelectedChapterId, setChapterDraft, setChapterDirty, setChapterLastSavedAt, setCurrentNovel, syncStudioPayload,
  })

  const { coverPromptMutation, coverImageMutation, coverUploadMutation, coverSelectMutation } = useCoverActions({
    activeNovelId, currentNovel, coverForm, pendingCoverUploadFile, setCoverForm, setCoverKeywords, setCoverMessage, setActiveToolPanel, setMobileView, setCoverAssets, setSelectedCoverId, setWorkspaceDialog, setCoverGenerationBusy, setCurrentNovel, setPendingCoverUploadFile, syncStudioPayload,
  })

  function handleOpenCoverCropDialog(file: File) {
    setPendingCoverUploadFile(file)
  }

  function handleDownloadCoverAsset(asset: CoverAsset) {
    const baseTitle = (currentNovel?.title ?? '作品').replace(/[\\/:*?"<>|]+/g, '').trim() || '作品'
    const suffix = asset.createdAt ? new Date(asset.createdAt).toISOString().slice(0, 10) : 'cover'
    void downloadCoverAssetImage(asset.imageUrl, `${baseTitle}-封面-${suffix}.jpg`)
  }

  function guardUnsavedChanges(callback: () => void) {
    const draft = chapterDraftStateRef.current
    // 待审查章节被禁止保存（须先通过审查），切走会丢失未保存输入，这里保留一次确认。
    if (
      draft &&
      chapterDirtyRef.current &&
      pendingChapterReviewsRef.current.some((item) => item.chapterId === draft.id)
    ) {
      setWorkspaceDialog({
        title: '切换章节前确认',
        description: '当前章节正在等待审查确认，期间无法自动保存，切换后刚才的修改可能不会保留。确定继续吗？',
        confirmLabel: '继续切换',
        cancelLabel: '先留在这里',
        onConfirm: () => {
          callback()
        },
      })
      return
    }

    // 普通章节依托自动保存：先把未落盘修改排队落盘（与 blur flush 共用 in-flight 锁），
    // 再直接切换，不再弹窗打断。
    if (chapterDirtyRef.current) {
      void persistChapter('auto')
    }
    callback()
  }

  function handleSelectChapter(nextChapterId: string, options?: { openSettings?: boolean }) {
    const openSettings = options?.openSettings ?? false
    setSelectedTreeItemId(`chapter:${nextChapterId}`)

    if (nextChapterId === selectedChapterId) {
      setEditorChapterSettingsOpen(openSettings)
      setMobileView('editor')

      // 同章点击不再用缓存覆盖草稿，避免丢掉未保存输入：有改动先落盘，干净时才同步缓存。
      if (chapterDirtyRef.current) {
        void persistChapter('auto')
        return
      }

      const cachedChapter = queryClient.getQueryData<Chapter>(['studio-chapter', activeNovelId, nextChapterId])
      if (cachedChapter) {
        setChapterDraft(buildChapterDraft(cachedChapter))
        setChapterDirty(false)
        setChapterSaveState('saved')
        setChapterLastSavedAt(cachedChapter.updatedAt)
        setChapterSaveMessage(`已同步到 ${formatDateTime(cachedChapter.updatedAt)}`)
      }
      return
    }

    guardUnsavedChanges(() => {
      setSelectedChapterId(nextChapterId)
      setEditorChapterSettingsOpen(openSettings)
      setChapterDraft(null)
      setChapterSaveState('idle')
      setChapterSaveMessage('正在打开章节...')
      setMobileView('editor')
    })
  }

  async function handleCreateLocalChapter() {
    if (createChapterLockRef.current) {
      return
    }

    createChapterLockRef.current = true
    setChapterSaveState('saving')
    setChapterSaveMessage('正在创建新章节...')

    try {
      const targetVolume = volumes.find((volume) => volume.id === activeChapterListItem?.volumeId) ?? volumes.at(-1)
      if (!targetVolume) throw new Error('请先新建一卷，再创建章节。')
      const nextOrderInVolume = chapters.filter((chapter) => chapter.volumeId === targetVolume.id).length + 1
      const savedChapter = await createChapterDraft(activeNovelId, {
        title: `第 ${nextOrderInVolume} 章`,
        summary: '新建章节',
        content: '',
        status: 'draft',
        visibility: 'private',
        volumeId: targetVolume.id,
        orderInVolume: nextOrderInVolume,
      })

      queryClient.setQueryData<Chapter>(['studio-chapter', activeNovelId, savedChapter.id], savedChapter)
      setChapters((current) => upsertChapterItem(current, toChapterListItem(savedChapter)))
      setVolumes((current) => current.map((volume) => volume.id === targetVolume.id
        ? { ...volume, chapterCount: volume.chapterCount + 1 }
        : volume))
      setSelectedChapterId(savedChapter.id)
      setChapterDraft(buildChapterDraft(savedChapter))
      setChapterDirty(false)
      setChapterSaveState('saved')
      setChapterSaveMessage(`已自动保存于 ${formatDateTime(savedChapter.updatedAt)}`)
      setChapterLastSavedAt(savedChapter.updatedAt)
      setMobileView('editor')
      setEditorChapterSettingsOpen(false)

      setCurrentNovel((current) =>
        current
          ? {
              ...current,
              chapterCount: current.chapterCount + 1,
              updatedAt: savedChapter.updatedAt,
            }
          : current,
      )

      syncStudioPayload((current) => {
        if (!current) {
          return current
        }

        return {
          ...current,
          novel: {
            ...current.novel,
            chapterCount: current.novel.chapterCount + 1,
            updatedAt: savedChapter.updatedAt,
          },
          draftChapter: savedChapter.status === 'draft' ? savedChapter : current.draftChapter,
          chapters: upsertChapterItem(current.chapters, toChapterListItem(savedChapter)),
          volumes: current.volumes.map((volume) => volume.id === targetVolume.id
            ? { ...volume, chapterCount: volume.chapterCount + 1 }
            : volume),
        }
      })
    } catch (error) {
      setChapterSaveState('error')
      setChapterSaveMessage(error instanceof Error ? error.message : '新章节创建失败，请稍后重试。')
    } finally {
      window.setTimeout(() => {
        createChapterLockRef.current = false
      }, 300)
    }
  }

  function handleRequestCreateChapter() {
    setWorkspaceDialog({
      title: '确认新建章节',
      description: '将会创建一个新的章节草稿。确定现在新建章节吗？',
      confirmLabel: '确认新建',
      cancelLabel: '取消',
      tone: 'default',
      onConfirm: async () => {
        await handleCreateLocalChapter()
      },
    })
  }

  function handleChapterDraftChange(next: ChapterDraftState) {
    setChapterDraft(next)
    setChapterDirty(true)
  }

  function handleEditorStatusChange(nextStatus: Chapter['status']) {
    if (!chapterDraft) {
      return
    }

    handleChapterDraftChange({ ...chapterDraft, status: nextStatus })
  }

  function handleRequestChapterStatusAction(nextStatus: Chapter['status']) {
    if (!chapterDraft || chapterDraft.status === nextStatus) {
      return
    }

    const actionMap: Record<
      Chapter['status'],
      { title: string; description: string; confirmLabel: string; tone?: 'default' | 'danger' }
    > = {
      draft: {
        title: '确认将状态设置为草稿',
        description: '执行后，这一章会切回草稿状态。',
        confirmLabel: '确认设置为草稿',
      },
      published: {
        title: '确认立即上架',
        description: '执行后，这一章会立刻切到上架状态。',
        confirmLabel: '确认上架',
      },
      scheduled: {
        title: '确认将状态设置为定时',
        description: '执行后，这一章会切到定时发布状态。',
        confirmLabel: '确认设置为定时',
      },
      archived: {
        title: '确认立即下架',
        description: '执行后，这一章会立刻从上架状态切到下架状态。',
        confirmLabel: '确认下架',
        tone: 'danger',
      },
    }

    const config = actionMap[nextStatus]
    setWorkspaceDialog({
      title: config.title,
      description: config.description,
      confirmLabel: config.confirmLabel,
      cancelLabel: '取消',
      tone: config.tone,
      onConfirm: () => {
        handleEditorStatusChange(nextStatus)
      },
    })
  }

  function handleRequestChapterVisibilityAction(nextVisibility: Chapter['visibility']) {
    if (!chapterDraft || chapterDraft.visibility === nextVisibility) {
      return
    }

    const actionMap: Record<
      Chapter['visibility'],
      { title: string; description: string; confirmLabel: string }
    > = {
      private: {
        title: '确认将可见范围设置为个人',
        description: '执行后，这一章只对你自己可见。',
        confirmLabel: '确认设置为个人',
      },
      followers: {
        title: '确认将可见范围设置为关注可见',
        description: '执行后，这一章只对关注你的用户可见。',
        confirmLabel: '确认设置为关注可见',
      },
      public: {
        title: '确认将可见范围设置为公开',
        description: '执行后，这一章会对外公开可见。',
        confirmLabel: '确认设置为公开',
      },
    }

    const config = actionMap[nextVisibility]
    setWorkspaceDialog({
      title: config.title,
      description: config.description,
      confirmLabel: config.confirmLabel,
      cancelLabel: '取消',
      onConfirm: () => {
        handleChapterDraftChange({ ...chapterDraft, visibility: nextVisibility })
      },
    })
  }

  async function handleDeleteChapter() {
    if (!chapterDraft) {
      return
    }

    // 审查拦截仅限待审查的那些章，其他章节可自由删除
    if (pendingChapterReviews.some((item) => item.chapterId === chapterDraft.id)) {
      promptConfirmPendingChapterReview('删除章节')
      return
    }

    const deletingChapter = chapterDraft
    const currentIndex = chapters.findIndex((chapter) => chapter.id === deletingChapter.id)
    const remainingChapters = removeChapterAndCompact(chapters, deletingChapter.id)
    const fallbackChapter =
      remainingChapters[Math.min(currentIndex, remainingChapters.length - 1)] ??
      remainingChapters[remainingChapters.length - 1] ??
      null

    if (!deletingChapter.localOnly) {
      await deleteChapterDraft(activeNovelId, deletingChapter.id, deletingChapter.revision)
    }

    setChapters((current) => removeChapterAndCompact(current, deletingChapter.id))
    setSelectedChapterId(fallbackChapter?.id ?? null)
    setEditorChapterSettingsOpen(false)
    setChapterDraft(null)
    setChapterDirty(false)
    setChapterLastSavedAt(null)
    setChapterSaveState('idle')
    setChapterSaveMessage(fallbackChapter ? '正在打开章节...' : '章节已删除。')

    if (!deletingChapter.localOnly) {
      queryClient.removeQueries({
        queryKey: ['studio-chapter', activeNovelId, deletingChapter.id],
      })
      void queryClient.invalidateQueries({ queryKey: ['studio-chapter', activeNovelId] })
      setCurrentNovel((current) =>
        current
          ? {
              ...current,
              chapterCount: Math.max(0, current.chapterCount - 1),
              wordCount: Math.max(0, current.wordCount - deletingChapter.content.length),
            }
          : current,
      )
      syncStudioPayload((current) =>
        current
          ? {
              ...current,
              novel: {
                ...current.novel,
                chapterCount: Math.max(0, current.novel.chapterCount - 1),
                wordCount: Math.max(0, current.novel.wordCount - deletingChapter.content.length),
              },
              draftChapter:
                current.draftChapter?.id === deletingChapter.id ? null : current.draftChapter,
              chapters: removeChapterAndCompact(current.chapters, deletingChapter.id),
            }
          : current,
      )
    }
  }

  function syncLocalRollbackSnapshot(snapshot?: AgentLocalRollbackSnapshot | null) {
    if (!snapshot) {
      return
    }

    if (snapshot.kind === 'restore_chapter') {
      const restoredDraft: ChapterDraftState = {
        id: snapshot.chapter.id,
        title: snapshot.chapter.title,
        summary: snapshot.chapter.summary,
        content: snapshot.chapter.content,
        status: snapshot.chapter.status,
        visibility: snapshot.chapter.visibility,
        orderIndex:
          chapters.find((chapter) => chapter.id === snapshot.chapter.id)?.orderIndex ??
          chapterDraft?.orderIndex ??
          1,
        revision:
          chapters.find((chapter) => chapter.id === snapshot.chapter.id)?.revision ??
          chapterDraft?.revision ??
          1,
        localOnly: false,
      }

      setSelectedChapterId(snapshot.selectedChapterId ?? snapshot.chapter.id)
      setChapterDraft(restoredDraft)
      setChapterDirty(false)
      setChapterSaveState('saved')
      setChapterLastSavedAt(snapshot.chapter.updatedAt)
      setChapterSaveMessage('已回退到本轮对话开始前的正文状态。')
      setChapters((current) =>
        current.map((chapter) =>
          chapter.id === snapshot.chapter.id
            ? {
                ...chapter,
                title: snapshot.chapter.title,
                summary: snapshot.chapter.summary || null,
                wordCount: snapshot.chapter.wordCount,
                status: snapshot.chapter.status,
                visibility: snapshot.chapter.visibility,
              }
            : chapter,
        ),
      )
      queryClient.setQueryData<Chapter>(['studio-chapter', activeNovelId, snapshot.chapter.id], (current) =>
        current
          ? {
              ...current,
              title: snapshot.chapter.title,
              summary: snapshot.chapter.summary || null,
              content: snapshot.chapter.content,
              wordCount: snapshot.chapter.wordCount,
              status: snapshot.chapter.status,
              visibility: snapshot.chapter.visibility,
              updatedAt: snapshot.chapter.updatedAt ?? current.updatedAt,
            }
          : current,
      )
      return
    }

    const previousChapter = snapshot.previousChapter
    const restoredPreviousDraft = previousChapter
      ? {
          id: previousChapter.id,
          title: previousChapter.title,
          summary: previousChapter.summary,
          content: previousChapter.content,
          status: previousChapter.status,
          visibility: previousChapter.visibility,
          orderIndex:
            chapters.find((chapter) => chapter.id === previousChapter.id)?.orderIndex ??
            chapterDraft?.orderIndex ??
            1,
          revision:
            chapters.find((chapter) => chapter.id === previousChapter.id)?.revision ??
            chapterDraft?.revision ??
            1,
          localOnly: false,
        }
      : null

    setChapters((current) => removeChapterAndCompact(current, snapshot.chapter.id))
    queryClient.removeQueries({
      queryKey: ['studio-chapter', activeNovelId, snapshot.chapter.id],
      exact: true,
    })
    void queryClient.invalidateQueries({ queryKey: ['studio-chapter', activeNovelId] })
    setCurrentNovel((current) =>
      current
        ? {
            ...current,
            chapterCount: Math.max(0, current.chapterCount - 1),
            wordCount: Math.max(0, current.wordCount - snapshot.chapter.wordCount),
          }
        : current,
    )
    syncStudioPayload((current) =>
      current
        ? {
            ...current,
            novel: {
              ...current.novel,
              chapterCount: Math.max(0, current.novel.chapterCount - 1),
              wordCount: Math.max(0, current.novel.wordCount - snapshot.chapter.wordCount),
            },
            draftChapter:
              current.draftChapter?.id === snapshot.chapter.id
                ? previousChapter
                  ? {
                      ...current.draftChapter,
                      id: previousChapter.id,
                      title: previousChapter.title,
                      summary: previousChapter.summary || null,
                      content: previousChapter.content,
                      wordCount: previousChapter.wordCount,
                      status: previousChapter.status,
                      visibility: previousChapter.visibility,
                    }
                  : null
                : current.draftChapter,
            chapters: removeChapterAndCompact(current.chapters, snapshot.chapter.id),
          }
        : current,
    )

    if (selectedChapterId === snapshot.chapter.id || chapterDraft?.id === snapshot.chapter.id) {
      setSelectedChapterId(snapshot.previousSelectedChapterId)
      setChapterDraft(restoredPreviousDraft)
      setChapterDirty(false)
      setChapterSaveState('saved')
      setChapterLastSavedAt(previousChapter?.updatedAt ?? null)
      setChapterSaveMessage(previousChapter ? '已回退到本轮对话开始前的章节状态。' : '已回退并移除本轮新建章节。')
    }
  }

  function handleKeepPendingChapterReview(review: ChapterPendingReview) {
    if (pendingChapterReviewBusy) {
      return
    }

    setPendingChapterReviewBusy(true)
    try {
      useAgentStore.getState().markWorkspaceActivitiesAccepted({ chapterId: review.chapterId })
      setPendingChapterReviews((current) => current.filter((item) => item.id !== review.id))
      // 本章定夺完毕：若还有其它章待审，在当前章底部给出「下一个文件」流转入口
      setReviewHandoffChapterId(review.chapterId)
      setChapterSaveState('saved')
      setChapterSaveMessage('已保留本次正文变更。')

      if (review.artifactId) {
        updateAgentArtifact(review.artifactId, (current) => ({
          ...current,
          pendingChapterReview: null,
        }))
      }
    } finally {
      setPendingChapterReviewBusy(false)
    }
  }

  async function handleRevertPendingChapterReview(review: ChapterPendingReview) {
    if (pendingChapterReviewBusy) {
      return
    }

    setPendingChapterReviewBusy(true)
    try {
      if (review.rollbackSnapshot.kind === 'restore_chapter') {
        const restoredChapter = await updateChapterDraft(activeNovelId, review.rollbackSnapshot.chapter.id, {
          title: review.rollbackSnapshot.chapter.title,
          summary: review.rollbackSnapshot.chapter.summary.trim() || undefined,
          content: review.rollbackSnapshot.chapter.content,
          status: review.rollbackSnapshot.chapter.status,
          visibility: review.rollbackSnapshot.chapter.visibility,
          expectedRevision: review.after.revision,
        })

        syncSavedChapterState(restoredChapter, {
          message: '已撤销本次正文变更。',
          wordCountDelta: restoredChapter.wordCount - review.after.content.length,
        })
      } else {
        await deleteChapterDraft(activeNovelId, review.after.id, review.after.revision)
        syncLocalRollbackSnapshot(review.rollbackSnapshot)
      }

      setPendingChapterReviews((current) => current.filter((item) => item.id !== review.id))
      if (review.rollbackSnapshot.kind === 'restore_chapter') {
        // 整章撤销后同样给出流转入口（删除新建章的分支会切章，由切章 effect 清空）
        setReviewHandoffChapterId(review.chapterId)
      }
      if (review.artifactId) {
        updateAgentArtifact(review.artifactId, (current) => ({
          ...current,
          pendingChapterReview: null,
          replacedChapterContent: false,
          appendedToChapter: false,
        }))
      }
    } catch (error) {
      setChapterSaveState('error')
      setChapterSaveMessage(error instanceof Error ? error.message : '撤销本次正文变更失败，请稍后重试。')
    } finally {
      setPendingChapterReviewBusy(false)
    }
  }

  // Agent 面板✕图标的拒绝入口：先弹自定义确认框，确认后才真正撤销
  function handleRequestRejectPendingChapterReview(review: ChapterPendingReview) {
    if (pendingChapterReviewBusy) {
      return
    }

    const chapterTitle = review.after.title.trim() || '当前章节'
    setWorkspaceDialog({
      title: '撤销本次正文变更？',
      description:
        review.rollbackSnapshot.kind === 'remove_created_chapter'
          ? `将删除本轮新建的《${chapterTitle}》并回到写入前的状态，删除后不可恢复。`
          : `《${chapterTitle}》将恢复到本次写入前的内容，AI 新写的这部分正文会被移除。`,
      confirmLabel: '撤销变更',
      cancelLabel: '再想想',
      tone: 'danger',
      onConfirm: () => handleRevertPendingChapterReview(review),
    })
  }

  // 块级采纳（片段右下角✓）：把该变更块写进审查基线；全部块定夺完毕即视为整章保留
  function handleAcceptReviewHunk(review: ChapterPendingReview, hunkIndex: number) {
    if (pendingChapterReviewBusy) {
      return
    }

    const beforeContent = review.before?.content ?? ''
    const resolved = resolveReviewHunk(beforeContent, review.after.content, hunkIndex, 'accept')
    if (buildReviewDiff(resolved.before, review.after.content).hunkCount === 0) {
      handleKeepPendingChapterReview(review)
      return
    }

    setPendingChapterReviews((current) =>
      current.map((item) =>
        item.id === review.id
          ? { ...item, before: { ...(item.before ?? item.after), content: resolved.before } }
          : item,
      ),
    )
  }

  // 块级撤回：把该变更块从章节结果中还原并落库；全部块定夺完毕即结束审查
  async function handleRejectReviewHunk(review: ChapterPendingReview, hunkIndex: number) {
    if (pendingChapterReviewBusy) {
      return
    }

    const beforeContent = review.before?.content ?? ''
    const { hunkCount } = buildReviewDiff(beforeContent, review.after.content)
    // 本轮新建的章节只剩这一个变更块时，撤回等价于整章撤销（删除新建章节）
    if (review.rollbackSnapshot.kind === 'remove_created_chapter' && hunkCount <= 1) {
      await handleRevertPendingChapterReview(review)
      return
    }

    const resolved = resolveReviewHunk(beforeContent, review.after.content, hunkIndex, 'reject')
    setPendingChapterReviewBusy(true)
    try {
      const savedChapter = await updateChapterDraft(activeNovelId, review.after.id, {
        title: review.after.title,
        summary: review.after.summary.trim() || undefined,
        content: resolved.after,
        status: review.after.status,
        visibility: review.after.visibility,
        expectedRevision: review.after.revision,
      })

      syncSavedChapterState(savedChapter, {
        message: '已撤回该处变更。',
        wordCountDelta: savedChapter.wordCount - review.after.content.length,
      })

      if (buildReviewDiff(beforeContent, resolved.after).hunkCount === 0) {
        setPendingChapterReviews((current) => current.filter((item) => item.id !== review.id))
        // 逐块撤回至全部定夺完毕：同样给出「下一个文件」流转入口
        setReviewHandoffChapterId(review.chapterId)
        if (review.artifactId) {
          updateAgentArtifact(review.artifactId, (current) => ({
            ...current,
            pendingChapterReview: null,
          }))
        }
      } else {
        setPendingChapterReviews((current) =>
          current.map((item) =>
            item.id === review.id
              ? {
                  ...item,
                  after: {
                    ...item.after,
                    content: resolved.after,
                    revision: savedChapter.revision,
                  },
                }
              : item,
          ),
        )
      }
    } catch (error) {
      setChapterSaveState('error')
      setChapterSaveMessage(error instanceof Error ? error.message : '撤回该处变更失败，请稍后重试。')
    } finally {
      setPendingChapterReviewBusy(false)
    }
  }

  // 块级✕撤回入口：自定义弹窗确认后才真正回滚该处片段
  function handleRequestRejectReviewHunk(review: ChapterPendingReview, hunkIndex: number) {
    if (pendingChapterReviewBusy) {
      return
    }

    setWorkspaceDialog({
      title: '撤回这一处变更？',
      description: '这一处绿色/红色片段将恢复为 AI 写入前的内容，撤回后不可恢复。',
      confirmLabel: '撤回',
      cancelLabel: '再想想',
      tone: 'danger',
      onConfirm: () => handleRejectReviewHunk(review, hunkIndex),
    })
  }

  // 计划审查条（plan/14 方案F）：✓保留仅清审查态；✕撤销把云端计划回写到本次修订前
  const { handleKeepPendingPlanReview, handleRevertPendingPlanReview, handleRequestRejectPendingPlanReview, handleAcceptPlanReviewHunk, handleRequestRejectPlanReviewHunk } = createPlanReviewActions({
    pendingPlanReview, pendingPlanReviewBusy, setPendingPlanReview, setPendingPlanReviewBusy, setServerPlanFiles, setAgentArtifacts, setSelectedTreeItemId, setChapterSaveState, setChapterSaveMessage, setWorkspaceDialog,
  })

  // 工作区变更头部的一键接受：逐章保留全部待审正文，再保留待审计划
  function handleApproveAllPendingReviews() {
    if (pendingChapterReviewBusy || pendingPlanReviewBusy) {
      return
    }

    for (const review of pendingChapterReviewsRef.current) {
      useAgentStore.getState().markWorkspaceActivitiesAccepted({ chapterId: review.chapterId })
      if (review.artifactId) {
        updateAgentArtifact(review.artifactId, (current) => ({
          ...current,
          pendingChapterReview: null,
        }))
      }
    }
    setPendingChapterReviews([])
    handleKeepPendingPlanReview()
    setChapterSaveState('saved')
    setChapterSaveMessage('已保留本次全部变更。')
  }

  // 一键拒绝全部：合并成一个确认框，确认后依次回滚全部待审正文与计划
  function handleRequestRejectAllPendingReviews() {
    if (pendingChapterReviewBusy || pendingPlanReviewBusy) {
      return
    }
    if (pendingChapterReviews.length === 0 && !pendingPlanReview) {
      return
    }

    setWorkspaceDialog({
      title: '撤销全部变更？',
      description: '本轮全部正文变更与计划修订都会恢复到 AI 写入前的状态，撤销后不可恢复。',
      confirmLabel: '全部撤销',
      cancelLabel: '再想想',
      tone: 'danger',
      onConfirm: async () => {
        for (const review of [...pendingChapterReviewsRef.current]) {
          await handleRevertPendingChapterReview(review)
        }
        await handleRevertPendingPlanReview()
      },
    })
  }

  function handleRetrySave() {
    void persistChapter('manual')
  }

  // 失焦即刷保存：配合 800ms 防抖，保证有改动就落盘。
  // LocalFirstTextarea 在失焦时先同步上报最后一批输入（同一事件批处理内排队），
  // 等 React 提交完成后再读最新 dirty 触发保存。
  function handleEditorBlurFlush() {
    window.setTimeout(() => {
      if (chapterDirtyRef.current) {
        void persistChapter('auto')
      }
    }, 0)
  }

  // 审查态按章节挂载：只在对应章节激活时展示绿增红减审查视图，切走不丢状态
  const activeChapterPendingReview =
    pendingChapterReviews.find((item) => item.chapterId === selectedChapterId) ?? null

  // IDE 式审查条「文件 x/y」：按待审数组顺序给出当前章节位置（1 基）
  const reviewFileCount = pendingChapterReviews.length
  const activeReviewFileIndex = activeChapterPendingReview
    ? pendingChapterReviews.findIndex((item) => item.id === activeChapterPendingReview.id) + 1
    : 0

  // 审查条「‹ 文件 ›」与「下一个文件」浮标：在多个待审章节之间循环跳转
  function handleNavigateReviewFile(offset: 1 | -1) {
    const list = pendingChapterReviewsRef.current
    if (list.length === 0) {
      return
    }
    const currentIndex = list.findIndex((item) => item.chapterId === selectedChapterId)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + list.length) % list.length
    const target = list[nextIndex]
    if (target && target.chapterId !== selectedChapterId) {
      handleSelectChapter(target.chapterId)
    }
  }

  function resetAgentWorkspace() {
    setAgentSessionId(null)
    setAgentArtifacts([])
    setActiveAgentArtifactId(null)
    setAgentRunState(createIdleAgentRunState())
    setAgentPrompt('')
  }

  function updateAgentArtifact(
    artifactId: string,
    updater: (artifact: AgentArtifact) => AgentArtifact,
  ) {
    setAgentArtifacts((current) =>
      current.map((artifact) => (artifact.id === artifactId ? updater(artifact) : artifact)),
    )
  }

  function handleCreateAgentTaskWindow() {
    if (agentRunState.active) {
      setAgentRunState((current) => ({
        ...current,
        statusText: 'AI 生成中，暂时无法切换任务窗口。',
      }))
      return
    }

    if (searchParams.has('session')) {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('session')
      setSearchParams(nextParams, { replace: true })
    }
    const nextTaskWindow = createLocalAgentTaskWindow()
    pruneTemporaryTaskWindows(nextTaskWindow.id)
    setAgentTaskWindows((current) => [nextTaskWindow, ...current])
    applyAgentTaskWindowState(nextTaskWindow)
  }

  /** 侧栏作品行的「新建对话」：当前作品直接开窗口，其它作品带 ?session=new 跳过去后由深链逻辑开窗口 */
  function handleCreateTaskInNovel(novelId: string) {
    if (novelId === activeNovelId) {
      handleCreateAgentTaskWindow()
      return
    }

    navigate(`/studio/novel/${novelId}?session=new`)
  }

  /** 侧栏删除任务：移除任务窗口；删掉的是当前窗口时回落到最近一个有记录的任务，全删完了才补空白窗口 */
  function handleAgentTaskDeleted(deletedTaskId: string) {
    const wasActive = activeAgentTaskWindowId === deletedTaskId || agentSessionId === deletedTaskId
    setAgentTaskWindows((current) =>
      current.filter(
        (taskWindow) => taskWindow.sessionId !== deletedTaskId && taskWindow.id !== deletedTaskId,
      ),
    )

    if (!wasActive) {
      return
    }

    // 回落目标从删除前的列表里算（setState 异步），已排除被删的那个
    const fallbackTaskWindow = pickFallbackAgentTaskWindow(agentTaskWindows, deletedTaskId)
    if (fallbackTaskWindow) {
      // 走 loadAgentTaskWindow 而非直接 apply：后者不会补载历史工件，作者会看到空壳任务
      void loadAgentTaskWindow(fallbackTaskWindow.id)
      return
    }

    const nextTaskWindow = createLocalAgentTaskWindow()
    setAgentTaskWindows([nextTaskWindow])
    applyAgentTaskWindowState(nextTaskWindow)
  }

  /** 任务切出分支：把新会话登记成任务窗口并切过去（跳作品时走深链） */
  function handleAgentTaskForked(session: AgentSession) {
    void queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] })

    if (session.novelId !== activeNovelId) {
      navigate(`/studio/novel/${session.novelId}?session=${encodeURIComponent(session.id)}`)
      return
    }

    // 分支已带全量历史，标为未加载让后续补载工件（对话内容由 Agent 面板自己拉）
    const forkedTaskWindow = buildAgentTaskWindowFromSession(session)
    pruneTemporaryTaskWindows(forkedTaskWindow.id)
    setAgentTaskWindows((current) => [
      forkedTaskWindow,
      ...current.filter((taskWindow) => taskWindow.id !== forkedTaskWindow.id),
    ])
    applyAgentTaskWindowState(forkedTaskWindow)
  }

  /** 侧栏已调完删除接口，这里只做缓存清理；删的是当前作品才需要换页 */
  async function handleNovelDeletedFromSidebar(deletedNovelId: string) {
    if (typeof window !== 'undefined' && window.localStorage.getItem(STUDIO_LAST_NOVEL_STORAGE_KEY) === deletedNovelId) {
      window.localStorage.removeItem(STUDIO_LAST_NOVEL_STORAGE_KEY)
    }

    queryClient.setQueryData<UserMePayload>(['community', 'me'], (current) =>
      current
        ? {
            ...current,
            authoredNovels: (current.authoredNovels ?? []).filter((item) => item.id !== deletedNovelId),
            drafts: (current.drafts ?? []).filter((item) => item.novelId !== deletedNovelId),
          }
        : current,
    )
    queryClient.setQueryData<Novel[]>(['studio', 'my-novels'], (current) =>
      Array.isArray(current) ? current.filter((item) => item.id !== deletedNovelId) : current,
    )
    queryClient.removeQueries({ queryKey: ['studio', deletedNovelId] })
    queryClient.removeQueries({ queryKey: ['studio-chapter', deletedNovelId] })
    queryClient.removeQueries({ queryKey: ['novel-detail', deletedNovelId] })
    queryClient.removeQueries({ queryKey: ['reader', deletedNovelId] })

    if (deletedNovelId === activeNovelId) {
      navigate('/studio', { replace: true })
    }

    await queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
  }

  async function handleSelectAgentTaskWindow(taskWindowId: string) {
    if (agentRunState.active) {
      setAgentRunState((current) => ({
        ...current,
        statusText: 'AI 生成中，暂时无法切换任务窗口。',
      }))
      return
    }

    setSessionResolutionError(null)
    // A newer explicit selection supersedes a still-resolving cross-novel deep link.
    if (searchParams.has('session')) {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('session')
      setSearchParams(nextParams, { replace: true })
    }
    if (taskWindowId === activeAgentTaskWindowId) {
      return
    }

    pruneTemporaryTaskWindows(taskWindowId)
    await loadAgentTaskWindow(taskWindowId)
  }

  async function handleRenameAgentTaskWindow(taskWindowId: string, nextTitle: string) {
    const normalizedTitle = nextTitle.trim().slice(0, 160)
    if (!normalizedTitle) {
      return
    }

    const targetTaskWindow = agentTaskWindows.find((taskWindow) => taskWindow.id === taskWindowId)
    if (!targetTaskWindow) {
      return
    }

    setAgentTaskWindows((current) =>
      current.map((taskWindow) =>
        taskWindow.id === taskWindowId
          ? {
              ...taskWindow,
              title: normalizedTitle,
              customNamed: true,
              updatedAt: new Date().toISOString(),
            }
          : taskWindow,
      ),
    )

    if (targetTaskWindow.sessionId) {
      try {
        const updatedSession = await updateWritingAgentSession(targetTaskWindow.sessionId, {
          title: normalizedTitle,
        })
        setAgentTaskWindows((current) =>
          current.map((taskWindow) =>
            taskWindow.id === taskWindowId
              ? {
                  ...taskWindow,
                  title: updatedSession.title,
                  customNamed: true,
                  updatedAt: updatedSession.updatedAt,
                }
              : taskWindow,
          ),
        )
      } catch (error) {
        setAgentRunState((current) => ({
          ...current,
          statusText: error instanceof Error ? error.message : '任务名称更新失败，请稍后再试。',
        }))
      }
    }
  }

  function handleSelectCatalogFromTree() {
    setSelectedTreeItemId('catalog')
    setWorkViewer('document')
    setMobileView('editor')
  }


  function handleRequestCreateVolume() {
    setWorkspaceDialog({
      title: '确认新建卷',
      description: '新卷会追加到作品末尾；后续新建章节将按作品 → 卷 → 章节的层级存放。确定现在新建吗？',
      confirmLabel: '确认新建',
      cancelLabel: '取消',
      tone: 'default',
      onConfirm: handleCreateLocalVolume,
    })
  }



  function handleRequestDeleteChapterFromEditor() {
    if (!chapterDraft) {
      return
    }

    if (chapterDraft.status === 'published') {
      setWorkspaceDialog({
        title: '当前章节暂不可删除',
        description: '请先将章节下架后才可删除。',
        confirmLabel: '知道了',
        cancelLabel: '关闭',
        onConfirm: () => undefined,
      })
      return
    }

    setWorkspaceDialog({
      title: '确认删除章节',
      description: '章节删除后内容将会丢失，您真的确定要删除吗？',
      confirmLabel: '确定删除',
      cancelLabel: '取消',
      tone: 'danger',
      onConfirm: async () => {
        await handleDeleteChapter()
      },
    })
  }

  /** 作品树右键删除任意章节：当前打开的章沿用编辑器删除流程（含待审查拦截），其余直接确认后删除 */
  function handleRequestDeleteChapterById(chapterId: string) {
    const target = chapters.find((chapter) => chapter.id === chapterId)
    if (!target) {
      return
    }

    if (chapterDraft?.id === chapterId) {
      handleRequestDeleteChapterFromEditor()
      return
    }

    if (target.status === 'published') {
      setWorkspaceDialog({
        title: '当前章节暂不可删除',
        description: '请先将章节下架后才可删除。',
        confirmLabel: '知道了',
        cancelLabel: '关闭',
        onConfirm: () => undefined,
      })
      return
    }

    if (pendingChapterReviews.some((item) => item.chapterId === chapterId)) {
      promptConfirmPendingChapterReview('删除章节')
      return
    }

    const targetTitle = target.title.trim() || `第 ${target.orderInVolume} 章`
    setWorkspaceDialog({
      title: '确认删除章节',
      description: `「${targetTitle}」删除后内容将会丢失，您真的确定要删除吗？`,
      confirmLabel: '确定删除',
      cancelLabel: '取消',
      tone: 'danger',
      onConfirm: async () => {
        await handleDeleteChapterById(chapterId)
      },
    })
  }


  const { handleCreateLocalVolume, handleMoveChapterInTree, handleMovePlanInTree, handleDeleteChapterById, handleRenameChapterById } = createCatalogActions({
    activeNovelId, volumes, chapters, chapterDirty, chapterDraft, selectedChapterId, savedPlanFiles,
    setVolumes, setChapters, setSelectedChapterId, setServerPlanFiles, setChapterSaveState,
    setChapterSaveMessage, syncStudioPayload, refreshWorkspaceAfterAgentWrite, handleChapterDraftChange, toast,
  })

  if (studioQuery.isError) {
    return (
      <Surface as="section" padding="lg" className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            创作中心暂时无法打开
          </h2>
          <p className="text-sm leading-7 text-[var(--text-secondary)]">
            {studioQuery.error instanceof Error ? studioQuery.error.message : '请稍后重试。'}
          </p>
        </div>
        <Button onClick={() => studioQuery.refetch()} variant="secondary">
          <RefreshCcw className="h-4 w-4" />
          重新连接
        </Button>
      </Surface>
    )
  }

  if (studioQuery.isLoading || !novelForm || !projectNotes || !coverForm || !currentNovel) {
    // 作品基座/表单数据未就绪：整页骨架；keepPreviousData 下正常切换不会命中（数据保持上一作品），
    // 会话历史由 AgentPanel 用图标流光自行加载，避免骨架与加载态叠加闪烁
    return <StudioSkeleton />
  }

  const novelTitleState = resolveNovelTitleState(
    // 跨作品切换瞬间：新作品载荷未到达前 currentNovel 仍是上一部作品，
    // 从作品列表缓存里取路由指向的作品标题先行展示，侧栏高亮与命令栏标题立即跟上不再跳变
    currentNovel.id === activeNovelId ? currentNovel : novelOptions.find((item) => item.id === activeNovelId) ?? currentNovel,
  )
  const novelTitle = novelTitleState.title
  const novelTitleMissing = novelTitleState.missing
  const wordCountLabel = formatWordCount(currentNovel.wordCount)
  const chapterCountLabel = `第 ${chapters.length} 章`
  const latestWordCountLabel = formatWordCount(latestWordCount)
  const coverLabel = currentNovel.coverAssetId ? '封面已设置' : '等待挑选封面'
  const novelSaveDisplayMessage =
    novelSaveState === 'saved' && novelLastSavedAt
      ? `已自动保存于 ${formatDateTime(novelLastSavedAt)}`
      : novelMessage
  const saveDisplayMessage =
    chapterSaveState === 'saved' && chapterLastSavedAt
      ? `已自动保存于 ${formatDateTime(chapterLastSavedAt)}`
      : chapterSaveMessage
  const previewTargetChapterId = selectedChapterId && !selectedChapterId.startsWith('local-')
    ? selectedChapterId
    : chapters[0]?.id
  const detailPreviewHref = `/novel/${currentNovel.id}?from=studio&returnTo=${encodeURIComponent(
    `/studio/novel/${currentNovel.id}`,
  )}`
  const previewHref = previewTargetChapterId
    ? `/novel/${currentNovel.id}/read/${previewTargetChapterId}?from=studio&returnTo=${encodeURIComponent(
        `/studio/novel/${currentNovel.id}`,
      )}`
    : undefined

  function handleSelectWorkChapter(chapterId: string) {
    handleSelectChapter(chapterId)
    setWorkViewer('chapter')
  }

  function handleAddViewerSelectionToAgent() {
    const text = editorSelection.text.trim()
    if (!text) return
    const volumeTitle = volumes.find((volume) => volume.id === activeChapterListItem?.volumeId)?.title
    const sourceTitle = activeWorkspaceDocument?.title ?? (chapterDraft ? `${volumeTitle ? `${volumeTitle} / ` : ''}${chapterDraft.title || `第 ${chapterDraft.orderIndex} 章`}` : '')
    if (!sourceTitle) return
    const sourceContent = activeWorkspaceDocument?.content ?? chapterDraft?.content ?? ''
    const startLine = sourceContent.slice(0, editorSelection.start).split('\n').length
    const endLine = startLine + Math.max(0, text.split('\n').length - 1)
    const referenceKind = activeWorkspaceDocument?.kind ?? 'chapter'
    const name = sourceTitle.trim().replace(/\.md$/i, '') || (referenceKind === 'catalog' ? '目录' : referenceKind === 'plan' ? '创作计划' : '章节正文')
    useAgentStore.getState().addComposerReference({
      id: `${activeNovelId}:${selectedTreeItemId ?? selectedChapterId ?? 'document'}:${editorSelection.start}:${editorSelection.end}`,
      kind: referenceKind,
      name,
      startLine,
      endLine,
      text,
      offset: useAgentStore.getState().composerDraft.length,
    })
    toast.success('已把选中内容添加到输入框。')
  }

  // Agent Loop 新链路：首次发送前懒创建会话，并同步任务窗口状态
  async function ensureAgentLoopSession(): Promise<string> {
    if (agentSessionId) {
      return agentSessionId
    }

    const currentTaskWindow = activeAgentTaskWindow
    const createdSession = await createWritingAgentSession(
      activeNovelId,
      currentTaskWindow?.customNamed ? currentTaskWindow.title : undefined,
    )
    // 未命名空白作品一旦产生会话就属于用户真实内容；立即刷新全局导航会话，
    // 避免紧接着切换/新建作品时仍按“无会话引导作品”将它过滤掉。
    void queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] })
    if (taskUiScope) {
      const nextScope = `${taskUiUserId ?? queryClient.getQueryData<UserMePayload>(['community', 'me'])?.user?.id ?? 'current'}:${activeNovelId}:${createdSession.id}`
      promoteComposerDraft(taskUiScope, nextScope)
      writeWorkPanelUi(nextScope, { rightOpen: workRightOpen, viewer: workViewer, inspectorTab: workInspectorTab, selectedTreeItemId, selectedChapterId })
      try {
        const split = localStorage.getItem(`chevoink:work-split-v2:${taskUiScope}`)
        if (split) localStorage.setItem(`chevoink:work-split-v2:${nextScope}`, split)
      } catch { /* Optional layout persistence. */ }
    }
    if (taskLocationRef.current.novelId === activeNovelId && taskLocationRef.current.taskId === currentTaskWindow?.id) {
      setAgentSessionId(createdSession.id)
      setActiveAgentTaskWindowId(createdSession.id)
    }
    setAgentTaskWindows((current) =>
      taskLocationRef.current.novelId !== activeNovelId ? current : current.map((taskWindow) =>
        taskWindow.id === currentTaskWindow?.id
          ? {
              ...taskWindow,
              id: createdSession.id,
              sessionId: createdSession.id,
              title: taskWindow.customNamed ? taskWindow.title : createdSession.title,
              temporary: false,
              loaded: true,
              updatedAt: createdSession.updatedAt,
              createdAt: createdSession.createdAt,
            }
          : taskWindow,
      ),
    )
    return createdSession.id
  }

  function renderWritingAgent(
    close?: () => void,
    showCloseAction = true,
    activityPresentation: 'inline' | 'responsive' = 'inline',
    mobileIntegratedHeader = false,
    showCreditWarning = false,
  ) {
    if (sessionResolutionError) return <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-sm text-[var(--text-secondary)]"><p>{sessionResolutionError}</p><button type="button" className="rounded-lg border border-[var(--border-subtle)] px-4 py-2" onClick={() => setSessionResolutionAttempt(value => value + 1)}>重新读取任务</button></div>
    return (
      <AgentPanel
          composerInsetClassName={activeToolPanel && activeToolPanel !== 'assistant' ? 'md:mr-[26rem] xl:mr-[28rem]' : undefined}
          onImportModelSelection={handleImportModelSelection}
          voiceScopeKey={taskUiScope}
          voiceDisabled={studioSettingsOpen || studioQuery.isPlaceholderData}
          sessionId={agentSessionId}
          sessionResolving={agentSessionsResolving}
          novelId={activeNovelId}
          novelName={currentNovel?.displayTitle?.trim() || currentNovel?.title?.trim() || '未命名作品'}
          initializingNovel={currentNovel ? isBootstrapNovel(currentNovel) : false}
          // 空态推荐只跟作品绑定；重复点击“新对话”不应让四张示例卡片反复换文案。
          emptyStateSeed={activeNovelId}
          chapterId={
            selectedChapterId && !selectedChapterId.startsWith('local-') ? selectedChapterId : null
          }
          selection={editorSelection.text.trim() ? editorSelection : null}
          ensureSession={ensureAgentLoopSession}
          onStreamEvent={handleAgentStreamEvent}
          pendingReviewCount={pendingChapterReviews.length + (pendingPlanReview ? 1 : 0)}
          reviewBusy={pendingChapterReviewBusy || pendingPlanReviewBusy}
          onApproveAllReviews={handleApproveAllPendingReviews}
          onRejectAllReviews={handleRequestRejectAllPendingReviews}
          onSelectSession={(nextSessionId) => {
            setAgentSessionId(nextSessionId)
            setActiveAgentTaskWindowId(nextSessionId)
          }}
          onSessionDeleted={(deletedSessionId) => {
            // 删除会话成功后统一走侧栏同一条善后路径：移除任务窗口（避免僵尸 sessionId 写回快照后反复 404），
            // 删的是当前窗口则回落到最近一个有记录的任务，而不是直接开一个空白对话
            handleAgentTaskDeleted(deletedSessionId)
          }}
          onTaskForked={handleAgentTaskForked}
          onNewSession={handleCreateAgentTaskWindow}
          onWorkspaceRollback={() => void refreshWorkspaceAfterAgentWrite()}
          onClose={showCloseAction ? close : undefined}
          activityPresentation={activityPresentation}
          mobileIntegratedHeader={mobileIntegratedHeader}
          taskTitle={activeAgentTaskWindow?.title ?? null}
          taskSubtitle={`${novelTitle} · ${workspacePerspective === 'work' ? 'Work 创作' : 'IDE 写作'}`}
          // 任务「更多」菜单：紧随 Agent 面板顶栏的任务标题展示，仅作用于当前任务
          onPinTask={() => {
            if (!activeAgentTaskWindow?.sessionId) return
            void updateAgentSessionSettings(activeAgentTaskWindow.sessionId, { pinned: true }).then(() => queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] }))
          }}
          onRenameTask={(title) => {
            if (activeAgentTaskWindow) void handleRenameAgentTaskWindow(activeAgentTaskWindow.id, title)
          }}
          onOpenBranches={() => { setStudioSettingsSection('operations'); setStudioSettingsOpen(true) }}
          showCreditWarning={showCreditWarning}
          showEmptySuggestions={workspacePerspective === 'work'}
          hideHeader={false}
          referenceOptions={composerReferenceOptions}
          onOpenStudioSettings={(section) => { setStudioSettingsSection(section); setStudioSettingsOpen(true) }}
          onOpenSkills={() => {
            // 「+」菜单里的“管理技能”：按当前视角把技能面板所在的侧栏直接展开
            if (mobileIntegratedHeader) {
              setMobileView('skills')
              return
            }
            if (workspacePerspective === 'work') {
              setWorkInspectorTab('skills')
              setWorkRightOpen(true)
              return
            }
            setIdeSidebarTab('skills')
            setIdeTreeOpen(true)
          }}
        />
      )
  }

  function renderCoverToolPanel(close?: () => void) {
    if (!coverForm || !currentNovel) {
      return null
    }

    return (
      <Surface as="section" padding="md" className="flex h-full min-h-0 flex-col overflow-hidden md:w-[24rem] xl:w-[26rem]">
        <CoverPanel
          coverForm={coverForm}
          coverAssets={coverAssets}
          selectedCover={selectedCover}
          currentCoverId={currentNovel.coverAssetId}
          coverKeywords={coverKeywords}
          coverMessage={coverMessage}
          generatingPrompt={coverPromptMutation.isPending}
          generatingImage={coverGenerationBusy}
          generationProgress={coverGenerationProgress}
          selectingCover={coverSelectMutation.isPending}
          formatDateTime={formatDateTime}
          onChange={setCoverForm}
          onUploadFile={handleOpenCoverCropDialog}
          onGeneratePrompt={() => coverPromptMutation.mutate()}
          onGenerateImages={() => coverImageMutation.mutate()}
          onSelectAsset={setSelectedCoverId}
          onApplyCover={() => selectedCover && coverSelectMutation.mutate(selectedCover)}
          onApplyAsset={(asset) => coverSelectMutation.mutate(asset)}
          onDownloadAsset={handleDownloadCoverAsset}
          onClose={close ?? (() => setActiveToolPanel(null))}
        />
      </Surface>
    )
  }

  function renderToolPanel() {
    if (!activeToolPanel) {
      return null
    }

    if (activeToolPanel === 'cover') {
      return renderCoverToolPanel(() => setActiveToolPanel(null))
    }

    return (
      <Surface as="section" padding="md" className="flex h-full min-h-0 flex-col overflow-hidden">
        {activeToolPanel === 'meta' && novelForm ? (
          <MetaPanel
            novelForm={novelForm}
            wordCountLabel={wordCountLabel}
            chapterCountLabel={chapterCountLabel}
            coverLabel={coverLabel}
            message={novelSaveDisplayMessage}
            saving={saveNovelMutation.isPending}
            onChange={setNovelForm}
            onRequestVisibilityAction={handleRequestNovelVisibilityAction}
            onRequestStatusAction={handleRequestNovelStatusAction}
            detailPreviewHref={detailPreviewHref}
            onOpenCover={() => setActiveToolPanel('cover')}
            onSave={handleSaveNovel}
            onClose={() => setActiveToolPanel(null)}
          />
        ) : null}
        {activeToolPanel === 'assistant' ? renderWritingAgent(() => setActiveToolPanel(null)) : null}
      </Surface>
    )
  }

  // Mobile and IDE use the same editing/review contract; only presentation differs.
  function renderEditor(presentation: Pick<ComponentProps<typeof EditorCanvas>, 'variant' | 'embedded'>) {
    return (
    <EditorCanvas
      {...presentation}
      chapterDraft={chapterDraft}
      workspaceDocument={activeWorkspaceDocument}
      chapterLoading={chapterQuery.isLoading}
      chapterErrorMessage={chapterQuery.isError ? chapterSaveMessage : null}
      chapterSaveState={chapterSaveState}
      chapterSaveMessage={saveDisplayMessage}
      latestWordCountLabel={latestWordCountLabel}
      selectedCommentCount={activeChapterListItem?.commentCount ?? 0}
      onSelectionChange={setEditorSelection}
      selection={editorSelection}
      onAddSelection={handleAddViewerSelectionToAgent}
      onSave={() => void persistChapter('manual')}
      onRetryLoad={() => chapterQuery.refetch()}
      onCreateChapter={handleRequestCreateChapter}
      onCreateVolume={handleRequestCreateVolume}
      onOpenChapterSettings={() => setEditorChapterSettingsOpen(true)}
      onOpenPlanSettings={() => {
        if (selectedTreeItemId?.startsWith('plan:')) {
          setPlanSettingsPlanId(selectedTreeItemId.slice('plan:'.length))
        }
      }}
      onPublishNovel={handlePublishNovel}
      novelPublished={novelForm?.status === 'published'}
      onStatusChange={handleEditorStatusChange}
      onChange={handleChapterDraftChange}
      onWorkspaceDocumentChange={handleWorkspaceDocumentChange}
      onRetrySave={handleRetrySave}
      onEditorBlur={handleEditorBlurFlush}
      pendingChapterReview={activeChapterPendingReview}
      pendingChapterReviewBusy={pendingChapterReviewBusy}
      onKeepPendingReview={() => {
        if (activeChapterPendingReview) {
          handleKeepPendingChapterReview(activeChapterPendingReview)
        }
      }}
      onRevertPendingReview={() => {
        if (activeChapterPendingReview) {
          handleRequestRejectPendingChapterReview(activeChapterPendingReview)
        }
      }}
      onAcceptReviewHunk={(hunkIndex) => {
        if (activeChapterPendingReview) {
          handleAcceptReviewHunk(activeChapterPendingReview, hunkIndex)
        }
      }}
      onRejectReviewHunk={(hunkIndex) => {
        if (activeChapterPendingReview) {
          handleRequestRejectReviewHunk(activeChapterPendingReview, hunkIndex)
        }
      }}
      reviewFileIndex={activeReviewFileIndex}
      reviewFileCount={reviewFileCount}
      onNavigateReviewFile={handleNavigateReviewFile}
      pendingReviewRemaining={!activeChapterPendingReview && selectedChapterId === reviewHandoffChapterId ? reviewFileCount : 0}
      onGoToNextReviewFile={() => handleNavigateReviewFile(1)}
      pendingPlanReview={activePlanPendingReview}
      streamingContent={activeWorkspaceDocument ? documentStreamingPreview : chapterStreamingPreview}
      writeLocked={activeWorkspaceDocument ? documentStreamingPreview !== undefined : chapterStreamingPreview !== undefined}
      pendingPlanReviewBusy={pendingPlanReviewBusy}
      onKeepPendingPlanReview={handleKeepPendingPlanReview}
      onRevertPendingPlanReview={handleRequestRejectPendingPlanReview}
      onAcceptPlanReviewHunk={handleAcceptPlanReviewHunk}
      onRejectPlanReviewHunk={handleRequestRejectPlanReviewHunk}
    />
    )
  }

  return (
    <>
      <div
        className="studio-workspace flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]"
        data-platform={platformCapabilities.native ? 'app' : 'web'}
        data-visual-viewport={platformCapabilities.visualViewport ? 'supported' : 'fallback'}
      >
        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
          <div className="flex shrink-0 items-center gap-2 px-0.5 pb-2 pt-1">
            {mobileView === 'cover' || mobileView === 'meta' || mobileView === 'memory' || mobileView === 'context' || mobileView === 'skills' ? (
              <>
                <button
                  type="button"
                  onClick={() => setMobileView('assistant')}
                  className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full pl-1.5 pr-3 text-sm font-medium text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-muted)]"
                >
                  <ChevronLeft className="h-5 w-5" />
                  返回
                </button>
                <p className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-[var(--text-primary)]">
                  {mobileView === 'cover' ? '封面工坊' : mobileView === 'memory' ? '小说关系网' : mobileView === 'context' ? '记忆' : mobileView === 'skills' ? '作品技能' : '作品设置'}
                </p>
              </>
            ) : (
              <>
                {/* 作品选择器占满剩余宽度，作品名尽量完整显示；右侧保存状态保持短标签 */}
                <div className={cn('min-w-0 flex-1 transition-[max-width] duration-200', mobileView === 'assistant' && 'max-w-[44%]')}>
                  <WorkspaceNovelSwitcher
                    currentNovelId={currentNovel.id}
                    currentNovelTitle={novelTitle}
                    novels={novelOptions}
                    busy={createNovelMutation.isPending}
                    loading={myNovelsQuery.isLoading}
                    onSelectNovel={handleSelectWorkspaceNovel}
                    onCreateNovel={handleCreateWorkspaceNovel}
                    fullWidth
                  />
                </div>
              </>
            )}
          </div>

          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">

            {mobileView === 'editor' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {renderEditor({ variant: 'mobile' })}
              </div>
            ) : null}

            {mobileView === 'chapters' ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
                <ChapterSidebar
                  embedded
                  chapters={chapters}
                  volumes={volumes}
                  savedPlans={savedPlanFiles}
                  selectedChapterId={selectedChapterId}
                  selectedTreeItemId={selectedTreeItemId}
                  catalogPreview={catalogPreview}
                  novelWordCountLabel={wordCountLabel}
                  chapterCountLabel={chapterCountLabel}
                  novelTitle={novelTitle}
                  activeCoverLabel={coverLabel}
                  onSelectChapter={handleSelectChapter}
                  onSelectPlan={handleSelectPlanFromTree}
                  onOpenChapterSettings={(chapterId) => handleSelectChapter(chapterId, { openSettings: true })}
                  onOpenPlanSettings={setPlanSettingsPlanId}
                  onSelectCatalog={handleSelectCatalogFromTree}
                  onCreateChapter={handleRequestCreateChapter}
                  onCreateVolume={handleRequestCreateVolume}
                  onCreatePlan={handleRequestCreatePlan}
                  onMoveChapter={handleMoveChapterInTree}
                  onMovePlan={handleMovePlanInTree}
                />
              </div>
            ) : null}

            {mobileView === 'assistant' ? (
              <div className="relative z-20 flex min-h-0 flex-1 flex-col overflow-visible">
                {renderWritingAgent(undefined, false, 'inline', true, true)}
              </div>
            ) : null}

            {mobileView === 'memory' && featureFlags.memory2 ? (
              <div className="min-h-0 flex-1 overflow-hidden border-t border-[var(--border-subtle)]">
                <MemoryGraph novelId={currentNovel.id} active={agentRunState.active} />
              </div>
            ) : null}

            {mobileView === 'context' ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)]">
                <AgentMemoryCenter sessionId={agentSessionId} novelId={currentNovel.id} active={agentRunState.active} scrollable={false} onOpenDetail={() => setContextDetailOpen(true)} />
              </div>
            ) : null}

            {mobileView === 'skills' ? (
              <div className="min-h-0 flex-1 overflow-hidden border-t border-[var(--border-subtle)]">
                <SkillsPanel novelId={currentNovel.id} chapters={chapters} />
              </div>
            ) : null}

            {mobileView === 'cover' ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {renderCoverToolPanel(() => setMobileView('assistant'))}
              </div>
            ) : null}

            {mobileView === 'meta' ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-4">
                <MetaPanel
                  novelForm={novelForm}
                  wordCountLabel={wordCountLabel}
                  chapterCountLabel={chapterCountLabel}
                  coverLabel={coverLabel}
                  message={novelSaveDisplayMessage}
                  saving={saveNovelMutation.isPending}
                  onChange={setNovelForm}
                  onRequestVisibilityAction={handleRequestNovelVisibilityAction}
                  onRequestStatusAction={handleRequestNovelStatusAction}
                  detailPreviewHref={detailPreviewHref}
                  onOpenCover={() => setMobileView('cover')}
                  onSave={handleSaveNovel}
                  onClose={() => setMobileView('assistant')}
                />
              </div>
            ) : null}
          </div>

          {/* 软键盘打开时由 index.css 的 html.keyboard-open .studio-bottom-nav 规则隐藏，
              让 Agent 输入框自然落到收缩视口底部（键盘上方），底栏不再被顶起占位 */}
          <nav className="studio-bottom-nav flex shrink-0 items-stretch justify-around gap-1 border-t border-[var(--border-subtle)] bg-[var(--surface-default)] px-2 pb-[max(var(--safe-bottom),4px)] pt-1">
              {/* 退出创作区固定回首页：创作区常常是从章节/详情等多级页面进来的，回退一步会落回中间页 */}
              <button
                type="button"
                onClick={() => navigate('/')}
                className="flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[14px] px-2 text-[11px] leading-4 text-[var(--text-tertiary)] transition-colors active:text-[var(--text-primary)]"
              >
                <LogOut className="h-5 w-5 rotate-180" />
                退出
              </button>
              {(
                [
                  { key: 'assistant', label: '工作台', icon: MessageSquareText },
                  { key: 'editor', label: '写作', icon: PenLine },
                  { key: 'chapters', label: '卷章', icon: BookOpenText },
                ] as Array<{ key: MobileView; label: string; icon: typeof PenLine }>
              ).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setMobileView(key)
                    if (key === 'assistant') setWorkspacePerspective('work')
                    if (key === 'editor' || key === 'chapters') setWorkspacePerspective('ide')
                  }}
                  className={cn(
                    'flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[14px] px-2 text-[11px] leading-4 transition-colors',
                    mobileView === key
                      ? 'font-medium text-[var(--text-primary)]'
                      : 'text-[var(--text-tertiary)] active:text-[var(--text-primary)]',
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setMobileMoreOpen(true)}
                className={cn(
                  'flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[14px] px-2 text-[11px] leading-4 transition-colors',
                  mobileMoreOpen || mobileView === 'cover' || mobileView === 'meta' || mobileView === 'memory' || mobileView === 'context' || mobileView === 'skills'
                    ? 'font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-tertiary)] active:text-[var(--text-primary)]',
                )}
              >
                <MoreHorizontal className="h-5 w-5" />
                更多
              </button>
          </nav>

          <BottomSheet
            open={mobileMoreOpen}
            onClose={() => setMobileMoreOpen(false)}
            title={novelTitleMissing ? '未命名作品' : novelTitle}
          >
            <StudioMobileAccountCard />
            <div className="space-y-0.5 px-3 pt-1">
              {(
                [
                  { key: 'meta', sectionLabel: '本作品', label: novelTitleMissing ? '去命名作品' : '作品设置', icon: Settings2, action: () => setMobileView('meta') },
                  { key: 'cover', label: '封面工坊', icon: ImagePlus, action: () => setMobileView('cover') },
                  ...(featureFlags.memory2
                    ? [{ key: 'memory', label: '关系网', icon: Network, action: () => setMobileView('memory') }]
                    : []),
                  { key: 'context', label: '记忆', icon: Brain, action: () => setMobileView('context') },
                  { key: 'skills', label: '作品技能', icon: Wrench, action: () => setMobileView('skills') },
                  { key: 'publish', label: novelForm?.status === 'published' ? '更新发布' : '发布作品', icon: Upload, action: () => handlePublishNovel() },
                  ...(novelForm?.status && novelForm.status !== 'archived' ? [{ key: 'completion', label: novelForm.status === 'completed' ? '继续连载' : '完结作品', icon: Flag, action: () => handleToggleNovelCompletion() }] : []),
                  { key: 'detail', label: '作品页', icon: BookOpenText, action: () => navigate(detailPreviewHref) },
                  { key: 'import', label: '一键导入', icon: Upload, action: openNovelImport },
                  { key: 'export', label: '一键导出', icon: FolderDown, action: () => setExportDialogOpen(true) },
                  ...(previewHref
                    ? [{ key: 'preview', label: '预览阅读', icon: BookOpen, action: () => navigate(previewHref) }]
                    : []),
                  { key: 'create-chapter', label: '新建章节', icon: FileText, action: () => handleRequestCreateChapter() },
                  // 创作区级（非本作品）入口单独成组：手机没有侧栏账户菜单与 IDE 顶栏「…」菜单，只能落在这里
                  { key: 'studio-settings', sectionLabel: '创作区', label: '创作区设置', icon: SlidersHorizontal, action: () => { setStudioSettingsSection('general'); setStudioSettingsOpen(true) } },
                  { key: 'feedback-suggestion', label: '提交建议', icon: Lightbulb, action: () => setFeedbackKind('suggestion') },
                  { key: 'feedback-bug', label: '问题反馈', icon: Bug, action: () => setFeedbackKind('bug') },
                  // 删除条件与电脑端一致：仅草稿或已下架可删，已发布时仍可点击但只给 toast 提示
                  {
                    key: 'delete-novel',
                    label: '删除作品',
                    icon: Trash2,
                    action: () => handleRequestDeleteNovel(),
                    danger: true,
                    disabled: deleteNovelMutation.isPending,
                  },
                ] as Array<{
                  key: string
                  /** 分组标题：该项之前插入一行小标题，作品级与创作区级操作不再平铺在一起 */
                  sectionLabel?: string
                  label: string
                  icon: typeof PenLine
                  action: () => void
                  danger?: boolean
                  disabled?: boolean
                }>
              ).map(({ key, sectionLabel, label, icon: Icon, action, danger, disabled }) => (
                <Fragment key={key}>
                  {sectionLabel ? <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-[var(--text-tertiary)]">{sectionLabel}</p> : null}
                  {danger ? <div className="my-1 border-t border-[var(--border-subtle)]" /> : null}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setMobileMoreOpen(false)
                      action()
                    }}
                    className={cn(
                      'flex min-h-[48px] w-full items-center gap-3 rounded-[16px] px-3 text-left text-[15px] transition-colors disabled:opacity-45',
                      danger
                        ? 'text-[rgb(153,27,27)] active:bg-[rgba(127,29,29,0.08)]'
                        : 'text-[var(--text-primary)] active:bg-[var(--surface-muted)]',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-5 w-5 shrink-0',
                        danger ? 'text-[rgb(153,27,27)]' : 'text-[var(--text-secondary)]',
                      )}
                    />
                    {label}
                  </button>
                </Fragment>
              ))}
            </div>
          </BottomSheet>
        </div>

        <div className="hidden min-h-0 flex-1 lg:flex">
          {workspacePerspective === 'work' ? <StudioWorkspaceSidebar
            open={workspaceSidebarOpen}
            onOpenChange={setWorkspaceSidebarOpen}
            onWidthChange={setWorkspaceSidebarWidth}
            perspective={workspacePerspective}
            perspectiveSwitchEnabled={featureFlags.dualWorkspace}
            onPerspectiveChange={setWorkspacePerspective}
            currentNovelId={activeNovelId}
            currentNovelTitle={novelTitle}
            novels={novelOptions}
            novelsLoading={myNovelsQuery.isLoading}
            switchingNovel={createNovelMutation.isPending}
            currentTasks={agentTaskSidebarItems}
            currentTasksNovelId={agentStateNovelId}
            activeTaskId={searchParams.get('session') && searchParams.get('session') !== 'new'
              ? searchParams.get('session') : agentStateNovelId === activeNovelId ? activeAgentTaskWindowId : null}
            taskSwitchLocked={agentRunState.active}
            onSelectNovel={handleSelectWorkspaceNovel}
            onCreateNovel={handleCreateWorkspaceNovel}
            onCreateTask={handleCreateAgentTaskWindow}
            onSelectTask={(taskId, taskNovelId) => {
              if (taskNovelId === activeNovelId) void handleSelectAgentTaskWindow(taskId)
              else navigate(`/studio/novel/${taskNovelId}?session=${encodeURIComponent(taskId)}`)
            }}
            onRenameTask={(taskId, title) => void handleRenameAgentTaskWindow(taskId, title)}
            onCreateTaskInNovel={handleCreateTaskInNovel}
            onTaskDeleted={handleAgentTaskDeleted}
            onTaskForked={handleAgentTaskForked}
            onNovelDeleted={(deletedNovelId) => void handleNovelDeletedFromSidebar(deletedNovelId)}
            currentNovelStatus={novelForm?.status}
            onOpenNovelMeta={() => setActiveToolPanel('meta')}
            onExportNovel={() => setExportDialogOpen(true)}
            onImportNovel={openNovelImport}
            onPublishNovel={handlePublishNovel}
            onToggleNovelCompletion={handleToggleNovelCompletion}
            autoFollow={autoFollow}
            onAutoFollowChange={setAutoFollow}
            onOpenStudioSettings={(section = 'general') => { setStudioSettingsSection(section); setStudioSettingsOpen(true) }}
          /> : null}
          <div className={cn('flex min-w-0 flex-1 flex-col transition-opacity', workspacePerspective === 'ide' && studioQuery.isPlaceholderData && 'pointer-events-none opacity-60')}>
          {/* 半透明防误编辑仅限 IDE 表单视图；Work 对话区数据不依赖 studioQuery，透明只会造成无意义闪烁 */}
          <StudioCommandBar
            workspaceControls={workspacePerspective === 'ide'}
            workspaceSidebarOpen={workspacePerspective === 'ide' ? ideTreeOpen : workspaceSidebarOpen}
            onWorkspaceSidebarToggle={() => workspacePerspective === 'ide' ? setIdeTreeOpen((value) => !value) : setWorkspaceSidebarOpen((value) => !value)}
            perspective={workspacePerspective}
            perspectiveSwitchEnabled={featureFlags.dualWorkspace}
            onPerspectiveChange={setWorkspacePerspective}
            currentNovelId={currentNovel.id}
            novelTitle={novelTitle}
            novelOptions={novelOptions}
            novelsLoading={myNovelsQuery.isLoading}
            switchingNovel={createNovelMutation.isPending}
            onSelectNovel={handleSelectWorkspaceNovel}
            onCreateNovel={handleCreateWorkspaceNovel}
            onPublish={handlePublishNovel}
            onOpenCover={() => setActiveToolPanel('cover')}
            onOpenMeta={() => setActiveToolPanel('meta')}
            onExport={() => setExportDialogOpen(true)}
            onImport={openNovelImport}
            onDeleteNovel={handleRequestDeleteNovel}
            onCreateVolume={handleRequestCreateVolume}
            onCreateChapter={handleRequestCreateChapter}
            onCreatePlan={handleRequestCreatePlan}
            previewHref={previewHref}
            detailPreviewHref={detailPreviewHref}
            published={novelForm?.status === 'published'}
            novelStatus={novelForm?.status}
            onToggleNovelCompletion={handleToggleNovelCompletion}
            onOpenStudioSettings={(section = 'general') => { setStudioSettingsSection(section); setStudioSettingsOpen(true) }}
          />

          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="studio-perspective-enter h-full min-h-0">
            {featureFlags.dualWorkspace && workspacePerspective === 'work' ? (
              <WorkPerspective
                conversationRail={<AgentConversationRail conversations={agentConversationRailItems} onSelectConversation={(messageId) => window.dispatchEvent(new CustomEvent('chevoink:agent-conversation-navigate', { detail: { messageId } }))} />}
                conversation={<div className="mx-auto h-full min-h-0 w-full max-w-4xl px-4 py-2">{renderWritingAgent(undefined, false, workViewer ? 'inline' : 'responsive')}</div>}
                activityDock={(workspaceActivities.length > 0 || agentTodos.length > 0 || pendingChapterReviews.length > 0 || Boolean(pendingPlanReview)) ? <div className="flex h-full min-h-0 flex-col"><div className="rounded-[20px] bg-[var(--surface-muted)] p-3"><p className="px-2 pb-1 pt-1 text-sm font-semibold text-[var(--text-secondary)]">任务状态</p><AgentActivityBar
                  activities={workspaceActivities}
                  activitiesVersion={workspaceActivitiesVersion}
                  todos={agentTodos}
                  todosVersion={agentTodosVersion}
                  runActive={agentRunState.active}
                  pendingReviewCount={pendingChapterReviews.length + (pendingPlanReview ? 1 : 0)}
                  reviewBusy={pendingChapterReviewBusy || pendingPlanReviewBusy}
                  onApproveAllReviews={handleApproveAllPendingReviews}
                  onRejectAllReviews={handleRequestRejectAllPendingReviews}
                  appearance="dock"
                /></div></div> : undefined}
                inspector={<WorkInspector
                  tab={workInspectorTab}
                  onTabChange={setWorkInspectorTab}
                  workTree={<ChapterSidebar
                    embedded chapters={chapters} volumes={volumes} savedPlans={savedPlanFiles}
                    selectedChapterId={selectedChapterId} selectedTreeItemId={selectedTreeItemId}
                    catalogPreview={catalogPreview} novelWordCountLabel={wordCountLabel}
                    chapterCountLabel={chapterCountLabel} novelTitle={novelTitle} activeCoverLabel={coverLabel}
                    onSelectChapter={handleSelectWorkChapter} onSelectPlan={handleSelectPlanFromTree}
                    onOpenChapterSettings={(chapterId) => handleSelectChapter(chapterId, { openSettings: true })}
                    onOpenPlanSettings={setPlanSettingsPlanId} onSelectCatalog={handleSelectCatalogFromTree}
                    onCreateVolume={handleRequestCreateVolume} onCreateChapter={handleRequestCreateChapter} onCreatePlan={handleRequestCreatePlan}
                    onRequestDeleteChapter={handleRequestDeleteChapterById} onRequestDeletePlan={handleRequestDeletePlan}
                    onRenameChapterTitle={(chapterId, title) => void handleRenameChapterById(chapterId, title)}
                    onRenamePlanTitle={handleRenamePlan}
                    onMoveChapter={handleMoveChapterInTree} onMovePlan={handleMovePlanInTree}
                  />}
                  novelTitle={novelTitle} volumeTitle={activeVolumeTitle} chapterTitle={chapterTitle} chapterCount={chapters.length}
                  wordCount={latestWordCountLabel}
                  pendingReviewCount={pendingChapterReviews.length + (pendingPlanReview ? 1 : 0)}
                  activeArtifactTitle={agentArtifacts.find((artifact) => artifact.id === activeAgentArtifactId)?.title ?? null}
                  selectedTextLength={editorSelection.text.length}
                  activities={workspaceActivities}
                  volumes={volumes}
                  chapters={chapters}
                  plans={savedPlanFiles}
                  projectNotes={projectNotes}
                  activeTaskTitle={agentTaskSidebarItems.find((task) => task.id === activeAgentTaskWindowId)?.title ?? null}
                  taskCount={agentTaskSidebarItems.length}
                  memoryGraph={featureFlags.memory2 ? <MemoryGraph novelId={currentNovel.id} active={agentRunState.active} /> : null}
                  skillsPanel={<SkillsPanel novelId={currentNovel.id} chapters={chapters} />}
                  contextPanel={<AgentMemoryCenter sessionId={agentSessionId} novelId={currentNovel.id} active={agentRunState.active} onOpenDetail={() => setContextDetailOpen(true)} />}
                />}
                viewer={workViewer ? <StudioChapterViewer
                  positionScope={taskUiScope}
                  draft={workViewer === 'chapter' ? chapterDraft : null}
                  workspaceDocument={workViewer === 'document' ? activeWorkspaceDocument : null}
                  loading={workViewer === 'chapter' ? chapterQuery.isLoading : plansLoadedNovelId !== activeNovelId || agentSessionsResolving} selection={editorSelection}
                  onChange={handleChapterDraftChange} onSelectionChange={setEditorSelection}
                  onWorkspaceDocumentChange={handleWorkspaceDocumentChange}
                  onAddSelection={handleAddViewerSelectionToAgent}
                  onCreateVolume={handleRequestCreateVolume} onCreateChapter={handleRequestCreateChapter}
                  onClose={() => setWorkViewer(null)}
                  onBlur={handleEditorBlurFlush}
                  streamingContent={workViewer === 'chapter' ? chapterStreamingPreview : documentStreamingPreview}
                  writeLocked={workViewer === 'chapter' ? chapterStreamingPreview !== undefined : documentStreamingPreview !== undefined}
                /> : undefined}
                rightOpen={workRightOpen}
                outerSidebarOpen={workspaceSidebarOpen}
                scopeKey={workPanelScope}
                viewerIdentity={workViewer ? `${workViewer}:${selectedTreeItemId ?? ''}` : null}
                inspectorWidth={panelWidths.workInspector}
                viewerWidth={panelWidths.workViewer}
                onToggleRight={() => {
                  if (!workRightOpen && workInspectorTab === 'work') {
                    if (selectedTreeItemId?.startsWith('chapter:')) setWorkViewer('chapter')
                    else if (selectedTreeItemId === 'catalog' || selectedTreeItemId?.startsWith('plan:')) setWorkViewer('document')
                  }
                  setWorkRightOpen((value) => !value)
                }}
                inspectorTab={workInspectorTab}
                onSelectInspectorTab={(tab) => {
                  setWorkInspectorTab(tab)
                  if (tab === 'work') {
                    if (selectedTreeItemId?.startsWith('chapter:')) setWorkViewer('chapter')
                    else if (selectedTreeItemId === 'catalog' || selectedTreeItemId?.startsWith('plan:')) setWorkViewer('document')
                  }
                }}
              />
            ) : (
            <IdePerspective
              treeWidth={panelWidths.tree}
              treeOpen={ideTreeOpen}
              agentWidth={panelWidths.agent}
              agentOpen={ideAgentOpen}
            >
              <div className="relative min-h-0 border-r border-[var(--border-subtle)]">
                <IdeNavigationRail
                  tab={ideSidebarTab}
                  open={ideTreeOpen}
                  onToggle={() => setIdeTreeOpen((value) => !value)}
                  onSelect={(tab) => {
                    setIdeSidebarTab(tab)
                    setIdeTreeOpen(true)
                  }}
                  panel={ideSidebarTab === 'work' ? <ChapterSidebar
                    embedded
                    chapters={chapters}
                    volumes={volumes}
                    savedPlans={savedPlanFiles}
                    selectedChapterId={selectedChapterId}
                    selectedTreeItemId={selectedTreeItemId}
                    catalogPreview={catalogPreview}
                    novelWordCountLabel={wordCountLabel}
                    chapterCountLabel={chapterCountLabel}
                    novelTitle={novelTitle}
                    activeCoverLabel={coverLabel}
                    onSelectChapter={handleSelectChapter}
                    onSelectPlan={handleSelectPlanFromTree}
                    onOpenChapterSettings={(chapterId) => handleSelectChapter(chapterId, { openSettings: true })}
                    onOpenPlanSettings={setPlanSettingsPlanId}
                    onSelectCatalog={handleSelectCatalogFromTree}
                    onCreateChapter={handleRequestCreateChapter}
                    onCreateVolume={handleRequestCreateVolume}
                    onCreatePlan={handleRequestCreatePlan}
                    onRequestDeleteChapter={handleRequestDeleteChapterById} onRequestDeletePlan={handleRequestDeletePlan}
                    onRenameChapterTitle={(chapterId, title) => void handleRenameChapterById(chapterId, title)}
                    onRenamePlanTitle={handleRenamePlan}
                    onMoveChapter={handleMoveChapterInTree}
                    onMovePlan={handleMovePlanInTree}
                  /> : ideSidebarTab === 'memory' && featureFlags.memory2 ? <MemoryGraph
                    novelId={currentNovel.id}
                    active={agentRunState.active}
                  /> : <WorkInspector
                    tab={ideSidebarTab}
                    onTabChange={setIdeSidebarTab}
                    showNavigation={false}
                    workTree={null}
                    novelTitle={novelTitle}
                    volumeTitle={activeVolumeTitle}
                    chapterTitle={chapterTitle}
                    chapterCount={chapters.length}
                    wordCount={latestWordCountLabel}
                    pendingReviewCount={pendingChapterReviews.length + (pendingPlanReview ? 1 : 0)}
                    activeArtifactTitle={agentArtifacts.find((artifact) => artifact.id === activeAgentArtifactId)?.title ?? null}
                    selectedTextLength={editorSelection.text.length}
                    activities={workspaceActivities}
                    volumes={volumes}
                    chapters={chapters}
                    plans={savedPlanFiles}
                    projectNotes={projectNotes}
                    activeTaskTitle={agentTaskSidebarItems.find((task) => task.id === activeAgentTaskWindowId)?.title ?? null}
                    taskCount={agentTaskSidebarItems.length}
                    skillsPanel={<SkillsPanel novelId={currentNovel.id} chapters={chapters} />}
                    contextPanel={<AgentMemoryCenter sessionId={agentSessionId} novelId={currentNovel.id} active={agentRunState.active} onOpenDetail={() => setContextDetailOpen(true)} />}
                  />}
                />
                {ideTreeOpen ? <PanelResizeHandle
                  panel="tree"
                  side="right"
                  label="拖拽调整 IDE 左侧面板宽度"
                  onBegin={beginPanelResize}
                /> : null}
              </div>

              <div className="min-h-0 border-r border-[var(--border-subtle)] bg-[var(--surface-default)]">
                {renderEditor({ embedded: true })}
              </div>

              <div className="relative flex h-full min-h-0 overflow-hidden bg-[var(--app-bg)]">
                {ideAgentOpen ? <PanelResizeHandle
                  panel="agent"
                  side="left"
                  label="拖拽调整 Agent 对话区宽度"
                  onBegin={beginPanelResize}
                /> : null}
                <div
                  aria-hidden={!ideAgentOpen}
                  className={cn(
                    'absolute inset-0 h-full min-h-0 w-full min-w-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out',
                    ideAgentOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-2 opacity-0',
                  )}
                >
                  {renderWritingAgent(() => setIdeAgentOpen(false))}
                </div>
                <button
                  type="button"
                  onClick={() => setIdeAgentOpen(true)}
                  className={cn(
                    'absolute left-1/2 top-2 flex h-8 w-8 -translate-x-1/2 items-center justify-center text-[var(--text-secondary)] transition-opacity duration-200 hover:bg-[var(--surface-muted)]',
                    ideAgentOpen ? 'pointer-events-none opacity-0' : 'opacity-100',
                  )}
                  aria-label="展开 Agent 区"
                >
                  <PanelRightOpen className="h-4 w-4" />
                </button>
              </div>
            </IdePerspective>
            )}
            </div>
          </div>
          <StudioSettingsDialog
            open={studioSettingsOpen}
            section={studioSettingsSection}
            onSectionChange={setStudioSettingsSection}
            onClose={() => setStudioSettingsOpen(false)}
            onOpenImportHistory={importHistoryAvailable ? () => { setStudioSettingsOpen(false); openImportHistory() } : undefined}
            perspective={workspacePerspective}
            onPerspectiveChange={setWorkspacePerspective}
            autoFollow={autoFollow}
            onAutoFollowChange={setAutoFollow}
            novelId={activeNovelId}
            novels={novelOptions}
            sessionId={agentSessionId}
            chapterId={selectedChapterId}
            runIds={agentArtifacts.map((artifact) => artifact.runId).filter((runId): runId is string => Boolean(runId))}
            onSelectSession={(sessionId) => {
              setAgentSessionId(sessionId)
              setActiveAgentTaskWindowId(sessionId)
              setStudioSettingsOpen(false)
            }}
            onTaskForked={handleAgentTaskForked}
          />

          {activeToolPanel && activeToolPanel !== 'assistant' ? (
            <div className="fixed inset-0 z-40 hidden bg-[rgba(15,23,42,0.18)] md:block" onClick={() => setActiveToolPanel(null)}>
              <div className="absolute inset-y-4 right-4 w-[24rem] max-w-[calc(100vw-2rem)] xl:w-[26rem]" onClick={(event) => event.stopPropagation()}>
                {renderToolPanel()}
              </div>
            </div>
          ) : null}
          </div>
        </div>
      </div>

      {editorChapterSettingsOpen && chapterDraft ? (
        <ChapterSettingsPanel
          chapterDraft={chapterDraft}
          onChange={handleChapterDraftChange}
          onRequestStatusAction={handleRequestChapterStatusAction}
          onRequestVisibilityAction={handleRequestChapterVisibilityAction}
          onRequestDelete={handleRequestDeleteChapterFromEditor}
          onClose={() => setEditorChapterSettingsOpen(false)}
        />
      ) : null}
      {planSettingsPlan ? (
        <PlanSettingsPanel
          plan={planSettingsPlan}
          onRename={(title) => handleRenamePlan(planSettingsPlan.id, title)}
          onRequestDelete={() => {
            setPlanSettingsPlanId(null)
            handleRequestDeletePlan(planSettingsPlan.id)
          }}
          onClose={() => setPlanSettingsPlanId(null)}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(workspaceDialog)}
        title={workspaceDialog?.title ?? ''}
        description={workspaceDialog?.description ?? ''}
        confirmLabel={workspaceDialog?.confirmLabel}
        cancelLabel={workspaceDialog?.cancelLabel}
        tone={workspaceDialog?.tone}
        busy={workspaceDialogBusy}
        onCancel={() => {
          if (workspaceDialogBusy) {
            return
          }
          setWorkspaceDialog(null)
        }}
        onConfirm={() => void handleWorkspaceDialogConfirm()}
      />
      <CreateNovelDialog
        open={createNovelDialogOpen}
        busy={createNovelMutation.isPending}
        onCancel={() => { if (!createNovelMutation.isPending) setCreateNovelDialogOpen(false) }}
        onCreate={(title) => {
          if (!createNovelMutation.isPending) {
            resetWorkspaceDraftState()
            createNovelMutation.mutate(title)
          }
        }}
      />
      <PublishNovelDialog
        open={publishDialogOpen}
        novelTitle={novelForm?.title ?? currentNovel?.title ?? ''}
        chapters={chapters}
        busy={publishNovelMutation.isPending}
        onCancel={() => {
          if (!publishNovelMutation.isPending) {
            setPublishDialogOpen(false)
          }
        }}
        onConfirm={(chapterIds, visibility) => publishNovelMutation.mutate({ chapterIds, visibility })}
      />
      <ExportDialog
        open={exportDialogOpen}
        novelId={currentNovel.id}
        novelTitle={novelForm?.title ?? currentNovel?.title ?? ''}
        chapters={chapters}
        onClose={() => setExportDialogOpen(false)}
      />
      {/* 一键导入：先选文件，选中后带着文件打开导入弹窗自动跑完整管线 */}
      <input ref={importPicker} type="file" aria-label="选择一键导入文件" accept=".zip,.txt,.md,.pdf,.doc,.docx" className="sr-only" onChange={event => {
        const picked = event.target.files?.[0]
        event.target.value = ''
        if (picked && taskUiUserId) setImportRequest({ novelId: activeNovelId, userId: taskUiUserId, autoFile: picked })
      }} />
      {importRequest?.novelId === activeNovelId && importRequest.userId === taskUiUserId ? <ImportDialog
        open
        novelId={activeNovelId}
        novelTitle={novelForm?.title ?? currentNovel.title}
        currentMetadata={{ title: currentNovel.title, summary: currentNovel.summary, tags: currentNovel.tags }}
        modelSelection={importModel?.novelId === activeNovelId && importModel.selection ? importModel.selection : { kind: 'basic' }}
        agentAttachment={importRequest.attachment}
        autoFile={importRequest.autoFile ?? null}
        initialJobId={importRequest.jobId}
        initialView={importRequest.view}
        beforeImport={async () => {
          if (importCapabilities.data?.aiEnabled && (importModel?.novelId !== activeNovelId || !importModel.selection)) throw new Error('请先在当前作品打开 Agent 输入框并确认模型选择。')
          if (chapterSaveState === 'saving' || novelSaveState === 'saving') throw new Error('当前修改正在保存，请稍后重试。')
          if (chapterDirty) {
            await persistChapter('manual')
            // Persistence may return without saving for pending review/validation/in-flight writes.
            // Ask for a second explicit attempt after React receives the authoritative saved state.
            throw new Error('已尝试保存当前章节，请确认保存成功后重新打开导入。未保存的内容不会被覆盖。')
          }
          if (novelDirty) {
            await saveNovelMutation.mutateAsync({ reason: 'manual' })
            throw new Error('作品设置已保存，请重新打开导入以核对最新内容。')
          }
          return true
        }}
        onClose={() => setImportRequest(null)}
        onImported={async (receipt) => {
          await refreshWorkspaceAfterAgentWrite()
          if (currentNovelStateRef.current?.id !== receipt.novelId) return
          if (receipt.firstChapterId) {
            setSelectedChapterId(receipt.firstChapterId)
            setSelectedTreeItemId(`chapter:${receipt.firstChapterId}`)
            setChapterDraft(null)
            setWorkViewer('chapter')
          }
        }}
        onRestored={refreshWorkspaceAfterAgentWrite}
        onViewChapter={handleSelectChapter}
      /> : null}
      <NovelCoverCropDialog
        open={Boolean(pendingCoverUploadFile)}
        file={pendingCoverUploadFile}
        busy={coverUploadMutation.isPending}
        onClose={() => {
          if (!coverUploadMutation.isPending) {
            setPendingCoverUploadFile(null)
          }
        }}
        onConfirm={(crop) => coverUploadMutation.mutate(crop)}
      />
      {featureFlags.changeSet ? <ChangeSetDrawer
        changeSetId={activeChangeSetId}
        novelId={currentNovel.id}
        chapters={chapters}
        onClose={() => setActiveChangeSetId(null)}
        onChanged={refreshWorkspaceAfterAgentWrite}
      /> : null}
      {/* 手机端「更多」面板的反馈入口（桌面端由侧栏账户菜单与 IDE 顶栏「…」菜单各自持有） */}
      <FeedbackDialog open={feedbackKind !== null} kind={feedbackKind ?? 'bug'} source="studio-mobile" onClose={() => setFeedbackKind(null)} />
      {contextDetailOpen && agentSessionId ? <ContextDetailDialog sessionId={agentSessionId} onClose={() => setContextDetailOpen(false)} /> : null}
    </>
  )
}

