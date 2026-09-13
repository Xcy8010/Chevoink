import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  CircleAlert,
  Copy,
  FileText,
  GitBranch,
  History,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  PencilLine,
  Pin,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'

import { useWorkConversation } from '../../components/work-conversation-context'
import { WorkConversationRestore } from '../../components/WorkConversationRestore'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import type {
  AgentAttachmentMeta,
  AgentSession,
  AgentStreamEvent,
  CreativeFreedom,
  CreditModelTier,
  EntityId,
  ModelReasoningEffort,
  StoryCompilerMode,
} from '../../../../../shared/contracts/index.js'
import { fetchCreditSummary, fetchCustomModels, fetchReferral } from '@/features/account/credits-api'
import { formatCreditAmount } from '@/features/account/credit-format'
import CreditQuotaDialog from '@/features/account/CreditQuotaDialog'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import DangerConfirmDialog from '../../components/DangerConfirmDialog'
import ImageLightbox from '../../components/ImageLightbox'
import { getNovelSkills } from '../../api'

import {
  AgentApiError,
  enqueueAgentRequest,
  fetchAgentQueue,
  actOnAgentQueue,
  deleteAgentSession,
  deleteAgentSessionMessage,
  fetchAgentSessionMessages,
  fetchAgentSessions,
  forkAgentSession,
  renameAgentSession,
  rollbackAgentSessionMessage,
  startAgentLoopRun,
} from '../agentApi'
import { isRunActive, readSessionMessagesCache, useAgentStore, type ComposerReference } from '../agentStore'
import { formatSessionTime, getMessageText, phaseLabel, shouldKeepLiveSessionMessages, skillPhaseLabel } from '../lib/panel-helpers'
import { useProcessingHint } from '../useProcessingHint'
import { useAgentStream } from '../useAgentStream'
import { projectMessages } from '../lib/message-projection'
import { useMessageScroll } from './use-message-scroll'
import { useComposerInset } from './use-composer-inset'
import { useRunControls } from './use-run-controls'
import { AgentActivityBar } from './AgentActivityBar'
import { MessageTime, UserMessageActions } from './MessageActions'
import { AgentComposer } from './AgentComposer'
import { AgentQueueTray } from './AgentQueueTray'
import { AgentMessageParts } from './AgentMessageParts'
import { AgentPermissionCard } from './AgentPermissionCard'
import { AgentQuestionCard } from './AgentQuestionCard'
import { ProcessingHint } from './ProcessingHint'
import AgentEmptyWelcome from './AgentEmptyWelcome'
import ChevoinkAgentMark from './ChevoinkAgentMark'

/**
 * Agent Loop 主面板（plan/13 §5）：
 * - 消息流由 SSE 事件实时构建，历史通过 /sessions/:id/messages 恢复
 * - 状态栏展示模式/轮次/token；paused/failed 提供"继续"续跑
 */

type AgentPanelProps = {
  voiceScopeKey?: string
  voiceDisabled?: boolean
  /** 未建会话时为 null，首次发送前通过 ensureSession 懒创建 */
  sessionId: EntityId | null
  novelId: EntityId
  /** 空对话欢迎区使用真实作品名；占位作品会展示“创建小说”引导。 */
  novelName: string
  initializingNovel?: boolean
  emptyStateSeed?: string
  chapterId?: EntityId | null
  selection?: { text: string; start?: number; end?: number } | null
  ensureSession: () => Promise<EntityId>
  /** SSE 事件透传：宿主据此同步章节树/编辑器等工作区状态 */
  onStreamEvent?: (event: AgentStreamEvent) => void
  /** 待审查变更总数（正文审查 + 计划审查）：驱动工作区变更头部的接受/拒绝按钮 */
  pendingReviewCount?: number
  reviewBusy?: boolean
  /** 一键接受全部待审变更 / 拒绝并撤回（宿主弹自定义确认框） */
  onApproveAllReviews?: () => void
  onRejectAllReviews?: () => void
  /** 历史任务对话：点击列表项切换会话 */
  onSelectSession?: (sessionId: EntityId) => void
  /** 历史列表删除会话成功后回调：宿主同步移除对应任务窗口，避免僵尸 sessionId 写回本地快照 */
  onSessionDeleted?: (sessionId: EntityId) => void
  /** 新建任务对话：宿主重置 sessionId 为 null（首次发送时懒创建） */
  onNewSession?: () => void
  /** 从某条对话切出分支成功：宿主把新会话登记为任务窗口并切过去 */
  onTaskForked?: (session: AgentSession) => void
  /** 回退成功后宿主刷新工作区（章节树/编辑器/小说信息） */
  onWorkspaceRollback?: () => void
  onClose?: () => void
  className?: string
  /** Work 宽屏存在独立任务停靠区时，内联待办/变更自动隐藏。 */
  activityPresentation?: 'inline' | 'responsive'
  /** 手机工作台把 Agent 标题与任务按钮并入作品选择同一行。 */
  mobileIntegratedHeader?: boolean
  /** 桌面端顶栏展示当前任务标题（替代 Chevoink Agent 标识位），空则回退「新任务」。 */
  taskTitle?: string | null
  /** 任务标题下方副标题：作品名 · 视角，与原顶栏任务展示一致。 */
  taskSubtitle?: string | null
  /** 任务「更多」菜单：置顶/重命名/分支，紧随任务标题展示（原 StudioCommandBar 任务三点按钮迁入）。 */
  onPinTask?: () => void
  onRenameTask?: (title: string) => void
  onOpenBranches?: () => void
  /** Work 桌面端由全局任务顶栏承载标题与操作，避免重复出现第二条 Agent 顶栏。 */
  hideHeader?: boolean
  /** “+”菜单可直接选择的目录/计划/章节；章节正文由输入框按需读取。 */
  referenceOptions?: Array<Omit<ComposerReference, 'offset'>>
  /** 桌面端由工作区左下角统一承载额度提醒；手机端没有该侧栏时在输入框上方展示。 */
  showCreditWarning?: boolean
  showEmptySuggestions?: boolean
  /** 宿主正在异步解析当前任务窗口的会话（切换作品/首载/快照与服务端合并）：
      期间 sessionId 尚未定案，禁止渲染空态欢迎页，避免欢迎页在中间态显示数百毫秒 */
  sessionResolving?: boolean
  onOpenStudioSettings?: (section: 'general' | 'models' | 'operations' | 'archives') => void
  /** 打开技能区：输入框「+」菜单里发现需要新建/导入/启用技能时直达。 */
  onOpenSkills?: () => void
  onImportModelSelection?: (novelId: string, selection: { kind: 'basic' } | { kind: 'custom'; customModelId: string } | null) => void
}

/** 无缓存首次拉取时图标流光的保底展示时长（一个完整扫光周期），避免快请求下只闪一下 */
const MIN_SHIMMER_HOLD_MS = 1500

export function AgentPanel({
  voiceScopeKey,
  voiceDisabled = false,
  sessionId,
  novelId,
  novelName,
  initializingNovel = false,
  emptyStateSeed,
  chapterId,
  selection,
  ensureSession,
  onStreamEvent,
  pendingReviewCount = 0,
  reviewBusy = false,
  onApproveAllReviews,
  onRejectAllReviews,
  onSelectSession,
  onSessionDeleted,
  onNewSession,
  onTaskForked,
  onWorkspaceRollback,
  onClose,
  className,
  activityPresentation = 'inline',
  mobileIntegratedHeader = false,
  taskTitle,
  taskSubtitle,
  onPinTask,
  onRenameTask,
  onOpenBranches,
  hideHeader = false,
  showCreditWarning = false,
  showEmptySuggestions = true,
  sessionResolving = false,
  onOpenStudioSettings,
  onOpenSkills,
  onImportModelSelection,
  referenceOptions = [],
}: AgentPanelProps) {
  const workConversation = useWorkConversation()
  const runId = useAgentStore((state) => state.runId)
  const phase = useAgentStore((state) => state.phase)
  const resumeableRunId = useAgentStore((state) => state.resumeableRunId)
  const messages = useAgentStore((state) => state.messages)
  const { recentConversationText, blockInfoById, lastAssistantId } = useMemo(() => projectMessages(messages), [messages])
  // 正文已定稿的消息 id：定稿后不再画流式光标（等答题/审批/工具执行期间光标不应常闪）
  const finalizedTextIds = useAgentStore((state) => state.finalizedTextIds)
  const pendingApproval = useAgentStore((state) => state.pendingApproval)
  const pendingQuestion = useAgentStore((state) => state.pendingQuestion)
  const usage = useAgentStore((state) => state.usage)
  const currentTurn = useAgentStore((state) => state.currentTurn)
  const errorMessage = useAgentStore((state) => state.errorMessage)
  const errorCode = useAgentStore((state) => state.errorCode)
  const workspaceActivities = useAgentStore((state) => state.workspaceActivities)
  const activitiesVersion = useAgentStore((state) => state.activitiesVersion)
  const todos = useAgentStore((state) => state.todos)
  const todosVersion = useAgentStore((state) => state.todosVersion)
  // 本轮服务端技能路由结果：让作者看得见 Agent 到底用了哪些技能
  const skillRoute = useAgentStore((state) => state.skillRoute)

  const { connect, disconnect } = useAgentStream(onStreamEvent)
  const queueQuery = useQuery({ queryKey: ['agent-queue', sessionId], queryFn: () => fetchAgentQueue(sessionId!), enabled: Boolean(sessionId), refetchInterval: 2000 })
  const queueRetry = useRef<{ signature: string; id: string } | null>(null)
  const viewSession = useRef(sessionId)
  viewSession.current = sessionId
  const viewScope = useRef(voiceScopeKey)
  viewScope.current = voiceScopeKey

  // Server dispatch works even with no browser open. Discover each new run and
  // hydrate its history before connecting, including runs finished between polls.
  useEffect(() => {
    const latestId = queueQuery.data?.latestRunId
    if (!sessionId || !latestId) return
    const live = useAgentStore.getState()
    if (live.loadedSessionId !== sessionId || live.runId === latestId || live.messages.some(message => message.runId === latestId)) return
    let cancelled = false
    void fetchAgentSessionMessages(sessionId, { runLimit: 50 }).then(payload => {
      if (cancelled || viewSession.current !== sessionId) return
      const now = useAgentStore.getState()
      if (now.runId === latestId) return
      if (payload.activeRunId) {
        now.restoreMessages(payload.messages.filter(message => !(message.runId === payload.activeRunId && message.role === 'assistant')), sessionId)
        now.resumeRun(payload.activeRunId, sessionId)
        connect(payload.activeRunId, 0)
      } else {
        now.restoreMessages(payload.messages, sessionId)
        now.noteResumeableRun(payload.resumeRunId ?? null)
      }
    }).catch(() => { /* Next queue poll retries; never erase existing history. */ })
    return () => { cancelled = true }
  }, [sessionId, queueQuery.data, queueQuery.dataUpdatedAt, connect])

  // 更早对话分页：每页最多 50 轮 run，用户手动点击顶部按钮加载更早内容
  const [olderPagination, setOlderPagination] = useState<{ hasMore: boolean; before: string | null } | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // 无缓存首次加载的流光保底窗口（快请求下也走完一个扫光周期）
  const [shimmerHolding, setShimmerHolding] = useState(false)
  // 历史拉取失败的会话：不能标记成“已恢复”（否则不再重试），但需让渲染层退出加载态，避免流光永久转圈
  const [historyErrorSessionId, setHistoryErrorSessionId] = useState<string | null>(null)
  const storeLoadedSessionId = useAgentStore((state) => state.loadedSessionId)
  const hydratingSessionId = useAgentStore((state) => state.hydratingSessionId)
  // 加载态完全由全局 store 状态派生，不再依赖任何局部标记：
  // 只有 store 明确宣告「本会话已水合」（loadedSessionId 命中）或「本就没有会话」时才允许欢迎页，
  // 其余一切中间态（切换中/拉取中/宿主解析中/水合归属不明）都走图标流光，从结构上杜绍欢迎页闪现
  const conversationReady = messages.length > 0
  const conversationSettled =
    sessionId === null || storeLoadedSessionId === sessionId || historyErrorSessionId === sessionId
  const conversationLoading =
    // 保底窗口优先：无缓存首载即便请求 200ms 就回来，也走完一个完整扫光周期再显示，避免流光一闪而过
    shimmerHolding ||
    (!conversationReady &&
      (sessionResolving || (sessionId !== null && hydratingSessionId === sessionId) || !conversationSettled))
  const [actionError, setActionError] = useState<string | null>(null)
  const { stoppingRunId, handleStop, handleContinue, handleResolveApproval, handleResolveQuestion } = useRunControls({
    runId, resumeableRunId, sessionId, phase, pendingApproval, pendingQuestion, connect, setActionError,
  })
  // 任务「更多」菜单与重命名弹窗（原 StudioCommandBar 任务三点按钮迁入）
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [taskRenaming, setTaskRenaming] = useState(false)
  const [taskTitleDraft, setTaskTitleDraft] = useState('')
  const taskMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!taskMenuOpen) return
    const close = (event: MouseEvent) => { if (!taskMenuRef.current?.contains(event.target as Node)) setTaskMenuOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [taskMenuOpen])
  const [creativeFreedom, setCreativeFreedom] = useState<CreativeFreedom>(() => {
    if (typeof window === 'undefined') return 'balanced'
    const saved = window.localStorage.getItem(`chevoink:creative-freedom:${novelId}`)
    return saved === 'stable' || saved === 'bold' ? saved : 'balanced'
  })
  const qualityMode: StoryCompilerMode = 'premium'
  const [modelTier, setModelTier] = useState<CreditModelTier>(() => {
    if (typeof window === 'undefined') return 'speed'
    const saved = window.localStorage.getItem('chevoink:agent-model-tier')
    return saved === 'lite' || saved === 'standard' || saved === 'performance' || saved === 'ultimate' || saved === 'custom' ? saved : 'speed'
  })
  const [customModelId, setCustomModelId] = useState<string | null>(() => typeof window === 'undefined' ? null : window.localStorage.getItem('chevoink:agent-custom-model-id'))
  useEffect(() => {
    onImportModelSelection?.(novelId, modelTier === 'custom'
      ? customModelId ? { kind: 'custom', customModelId } : null
      : { kind: 'basic' })
  }, [novelId, modelTier, customModelId, onImportModelSelection])
  const [reasoningSelections, setReasoningSelections] = useState<Record<string, ModelReasoningEffort>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const parsed = JSON.parse(window.localStorage.getItem('chevoink:agent-reasoning-efforts') ?? '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })
  /** 用户气泡附件图片的大图预览 */
  const [attachmentPreview, setAttachmentPreview] = useState<{ url: string; name: string } | null>(null)
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const autoCopyInviteRef = useRef(false)
  const [creditWarning, setCreditWarning] = useState<5 | 10 | 20 | null>(null)

  // 历史任务对话列表
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  // 消息操作：悬停复制展开删除/回退；移动端长按展开；复制成功短暂打勾
  const [touchActionsId, setTouchActionsId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'deleteMessage'; messageId: string }
    | { kind: 'rollbackMessage'; messageId: string }
    | { kind: 'deleteSession'; sessionId: string; title: string }
    | null
  >(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  // 分支溯源：本会话是副本时后端随消息一起返回，用于底部「从聊天中继续」提示
  const [forkInfo, setForkInfo] = useState<{ sessionId: string; forkedAt: string | null } | null>(null)
  // 待确认的分支创建：messageId 为空表示从整段对话切分支
  const [forkTarget, setForkTarget] = useState<{ messageId: string | null } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  const longPressTimerRef = useRef<number | null>(null)
  const copyResetTimerRef = useRef<number | null>(null)
  // 懒创建会话：首次发送时 sessionId 从 null 变为新建 id，此时正在流式输出，需跳过历史恢复避免冲掉直播消息
  const lazySessionRef = useRef<string | null>(null)

  const { scrollRef, pinnedToBottomRef, lastScrollTopRef, handleMessagesScroll } = useMessageScroll({
    messages, pendingApproval, pendingQuestion, conversationLoading, collapsed: workConversation.collapsed,
  })
  const active = isRunActive(phase)
  const creditSummaryQuery = useQuery({
    queryKey: ['credits', 'summary'],
    queryFn: fetchCreditSummary,
    staleTime: 20_000,
    refetchInterval: active ? 20_000 : 60_000,
  })
  const refetchCredits = creditSummaryQuery.refetch
  const previousActiveRef = useRef(active)
  const referralQuery = useQuery({
    queryKey: ['credits', 'referral'],
    queryFn: fetchReferral,
    staleTime: 60_000,
    enabled: inviteDialogOpen || quotaDialogOpen,
  })
  const customModelsQuery = useQuery({ queryKey: ['credits', 'custom-models'], queryFn: fetchCustomModels, staleTime: 30_000 })
  // 与技能区共享同一份缓存；skill2 未开通时接口直接报错，此处静默让「+」菜单不展示技能分组
  const skillsQuery = useQuery({
    queryKey: ['studio', novelId, 'skills'],
    queryFn: () => getNovelSkills(novelId),
    staleTime: 30_000,
    retry: false,
  })
  // 只列出真正可被路由装载的技能：未启用或未发布的版本手动指定也不会生效
  const pinnableSkills = useMemo(
    () => (skillsQuery.data?.items ?? []).filter((skill) => skill.enabled && skill.status === 'active'),
    [skillsQuery.data],
  )
  // 参数生成、工具间等待等阶段也需要动态反馈；不能因已经输出过正文而永久隐藏。
  const awaiting = useProcessingHint(messages, runId, phase, Boolean(pendingApproval || pendingQuestion))

  // AgentPanel stays mounted while authors switch works. Re-hydrate the per-work
  // freedom setting instead of carrying the previous work's value into the new one.
  useEffect(() => {
    const saved = window.localStorage.getItem(`chevoink:creative-freedom:${novelId}`)
    setCreativeFreedom(saved === 'stable' || saved === 'bold' ? saved : 'balanced')
  }, [novelId])

  // The full-screen Studio settings page can update the active panel without
  // reaching into component state or forcing a remount.
  useEffect(() => {
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<{ novelId?: string; value?: CreativeFreedom }>).detail
      if (detail?.novelId !== novelId) return
      if (detail.value === 'stable' || detail.value === 'balanced' || detail.value === 'bold') {
        setCreativeFreedom(detail.value)
      }
    }
    window.addEventListener('chevoink:creative-freedom-change', handleChange)
    return () => window.removeEventListener('chevoink:creative-freedom-change', handleChange)
  }, [novelId])

  useEffect(() => {
    window.localStorage.setItem(`chevoink:creative-freedom:${novelId}`, creativeFreedom)
    // novelId changes are hydrated by the effect above; persisting on that same
    // render would overwrite the next work with the previous work's preference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativeFreedom])

  useEffect(() => {
    window.localStorage.setItem('chevoink:agent-model-tier', modelTier)
  }, [modelTier])

  useEffect(() => {
    if (customModelId) window.localStorage.setItem('chevoink:agent-custom-model-id', customModelId)
    else window.localStorage.removeItem('chevoink:agent-custom-model-id')
  }, [customModelId])

  useEffect(() => {
    window.localStorage.setItem('chevoink:agent-reasoning-efforts', JSON.stringify(reasoningSelections))
  }, [reasoningSelections])

  const selectedModelCapability = modelTier === 'custom'
    ? customModelsQuery.data?.models.find((model) => model.id === customModelId)
    : creditSummaryQuery.data?.models.find((model) => model.tier === modelTier)
  const selectedModelKey = modelTier === 'custom' ? `custom:${customModelId ?? ''}` : `tier:${modelTier}`
  const savedReasoningEffort = reasoningSelections[selectedModelKey]
  const selectedReasoningEffort = savedReasoningEffort && selectedModelCapability?.reasoningEfforts.includes(savedReasoningEffort)
    ? savedReasoningEffort
    : selectedModelCapability?.defaultReasoningEffort ?? 'high'

  useEffect(() => {
    const options = creditSummaryQuery.data?.models
    if (modelTier !== 'custom' && options && !options.some((item) => item.tier === modelTier && item.available)) setModelTier('speed')
  }, [creditSummaryQuery.data?.models, modelTier])

  useEffect(() => {
    if (modelTier !== 'custom') return
    const selected = customModelsQuery.data?.models.find((model) => model.id === customModelId && model.enabled)
    if (customModelsQuery.data && !selected) setModelTier('speed')
  }, [customModelId, customModelsQuery.data, modelTier])

  useEffect(() => {
    if (errorCode === 'credits_exhausted' || errorCode === 'credits_globally_paused' || errorCode === 'credits_account_suspended') {
      setQuotaDialogOpen(true)
      void refetchCredits()
    }
  }, [errorCode, refetchCredits])

  useEffect(() => {
    // 管理员全局暂停会直接中止服务端活动 run；即便该 run 没来得及回传额度错误，
    // 轮询到全局状态后仍要向用户解释停止原因。
    if (creditSummaryQuery.data?.suspended) setQuotaDialogOpen(true)
  }, [creditSummaryQuery.data?.suspended])

  useEffect(() => {
    if (previousActiveRef.current && !active) void refetchCredits()
    previousActiveRef.current = active
  }, [active, refetchCredits])

  useEffect(() => {
    const summary = creditSummaryQuery.data
    if (!summary || summary.dailyAllowance <= 0 || summary.totalRemaining <= 0) return
    const remainingPercent = (summary.totalRemaining / summary.dailyAllowance) * 100
    const threshold: 5 | 10 | 20 | null = remainingPercent <= 5 ? 5 : remainingPercent <= 10 ? 10 : remainingPercent <= 20 ? 20 : null
    if (!threshold) {
      setCreditWarning(null)
      return
    }
    const key = `chevoink:credit-warning:${summary.resetsAt}:${threshold}`
    if (window.localStorage.getItem(key) !== 'dismissed') setCreditWarning(threshold)
  }, [creditSummaryQuery.data])

  const dismissCreditWarning = useCallback(() => {
    const summary = creditSummaryQuery.data
    if (summary && creditWarning) window.localStorage.setItem(`chevoink:credit-warning:${summary.resetsAt}:${creditWarning}`, 'dismissed')
    setCreditWarning(null)
  }, [creditSummaryQuery.data, creditWarning])

  const copyInviteLink = useCallback(async () => {
    const url = referralQuery.data?.inviteUrl
    if (!url || !navigator.clipboard) return
    await navigator.clipboard.writeText(url)
    setInviteCopied(true)
    window.setTimeout(() => setInviteCopied(false), 1800)
  }, [referralQuery.data?.inviteUrl])

  const openInviteDialog = useCallback(async () => {
    setQuotaDialogOpen(false)
    setInviteDialogOpen(true)
    autoCopyInviteRef.current = true
    const url = referralQuery.data?.inviteUrl
    if (url) {
      autoCopyInviteRef.current = false
      try {
        await navigator.clipboard.writeText(url)
        setInviteCopied(true)
      } catch {
        // 浏览器禁止自动复制时，弹窗仍保留显式复制按钮。
      }
    }
  }, [referralQuery.data?.inviteUrl])

  useEffect(() => {
    if (!inviteDialogOpen || !autoCopyInviteRef.current || !referralQuery.data?.inviteUrl) return
    autoCopyInviteRef.current = false
    void copyInviteLink()
  }, [copyInviteLink, inviteDialogOpen, referralQuery.data?.inviteUrl])


  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({})
  const handleToggleBlockSummary = useCallback((blockId: string) => {
    setExpandedBlocks((current) => ({ ...current, [blockId]: !current[blockId] }))
  }, [])

  useEffect(
    () => () => {
      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current)
      }
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current)
      }
    },
    [],
  )

  // 恢复会话历史（切换会话时优先用缓存，无缓存才拉取；懒创建触发的 sessionId 变化跳过）
  // 用 layout effect：会话复位与缓存复原在浏览器绘制前完成，切换只有一次绘制，不会闪旧对话内容
  useLayoutEffect(() => {
    if (sessionId && lazySessionRef.current === sessionId) {
      lazySessionRef.current = null
      return
    }

    // 面板重挂载（沉浸切换/路由往返）时：若 store 中仍有本会话的活跃 run，续接 SSE 直播而非重置，
    // 避免冲掉进行中的任务状态（后端 run 独立运行，事件支持 sinceSeq 续传）
    const live = useAgentStore.getState()
    if (live.runId && isRunActive(live.phase) && live.activeSessionId === sessionId) {
      connect(live.runId, live.lastSeq)
      return
    }

    // Work / IDE 只是同一任务的两种视图。消息已经属于当前会话时直接复用
    // Zustand 中的完整内容，避免重新拉取、闪现 loading，亦避免旧响应覆盖直播收尾。
    if (live.loadedSessionId === sessionId) {
      return
    }

    // 切换/重载会话语义上就是「跳到对话最新处」：强制复位贴底跟随。
    // 否则旧对话内容清空/替换时容器高度骤减，浏览器把 scrollTop 钳制回 0 并触发 scroll 事件，
    // 会被误判为用户上滑而关闭自动滚底，导致历史载入后永远停在最顶部
    pinnedToBottomRef.current = true
    lastScrollTopRef.current = 0

    let cancelled = false
    disconnect()
    useAgentStore.getState().resetRun()

    if (!sessionId) {
      // 新任务窗口（会话尚未懒创建）：resetRun 已清空，直接展示欢迎页
      return
    }

    const cached = readSessionMessagesCache(sessionId)
    let holdTimer: number | null = null
    setHistoryErrorSessionId(null)
    // 切到别的会话才丢弃分支信息，回到同一会话时保留，避免提示闪一下再出现
    setForkInfo((current) => (current && current.sessionId === sessionId ? current : null))
    if (cached) {
      // 有缓存：绘制前同步复原，切换即显示，全程不进任何加载态（后续请求静默修正）
      useAgentStore.getState().restoreMessages(cached, sessionId)
    } else {
      // 无缓存：进图标流光，并保底一个完整扫光周期
      useAgentStore.getState().beginSessionHydration(sessionId)
      setShimmerHolding(true)
      holdTimer = window.setTimeout(() => setShimmerHolding(false), MIN_SHIMMER_HOLD_MS)
    }

    fetchAgentSessionMessages(sessionId, { runLimit: 50 })
      .then((payload) => {
        if (cancelled) {
          return
        }
        setOlderPagination(payload.pagination ? { hasMore: payload.pagination.hasMore, before: payload.pagination.earliestRunStartedAt } : null)
        setForkInfo(payload.fork ? { sessionId, forkedAt: payload.fork.forkedAt } : null)
        const history = payload.messages
        const activeRunId = payload.activeRunId
        const live = useAgentStore.getState()
        if (shouldKeepLiveSessionMessages(live.runId, live.phase, live.activeSessionId, sessionId)) {
          // 新会话首次发送会与空历史请求并发；直播态始终比更早发出的历史快照新。
          return
        }
        if (activeRunId) {
          // 服务端仍有本会话进行中的 run（如刷新页面后回来）：
          // 历史里剔除该 run 的助手消息，改由事件重放（seq 0）重建直播与提问/审批卡片
          useAgentStore
            .getState()
            .restoreMessages(
              history.filter((message) => !(message.runId === activeRunId && message.role === 'assistant')),
              sessionId,
            )
          useAgentStore.getState().resumeRun(activeRunId, sessionId)
          connect(activeRunId, 0)
        } else {
          useAgentStore.getState().restoreMessages(history, sessionId)
          // 无活跃 run：若服务端派生出可续跑的 failed/paused run，刷新后仍保留「继续执行」按钮
          useAgentStore.getState().noteResumeableRun(payload.resumeRunId ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          // 网络失败不能把该会话标记成“已恢复”，否则 Work/IDE 切换后也不会重试。
          useAgentStore.getState().restoreMessages([], null)
          setHistoryErrorSessionId(sessionId)
          setOlderPagination(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          useAgentStore.getState().endSessionHydration(sessionId)
        }
      })

    return () => {
      cancelled = true
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer)
      }
      setShimmerHolding(false)
      // 兜底：会话切换/面板卸载时结束水合标记，不让加载态悬挂
      useAgentStore.getState().endSessionHydration(sessionId)
    }
  }, [sessionId, connect, disconnect, pinnedToBottomRef, lastScrollTopRef])


  const handleSend = useCallback(
    async (prompt: string, attachments: AgentAttachmentMeta[], freedom: CreativeFreedom, selectedQualityMode: StoryCompilerMode, pinnedSkillIds: string[], pinnedSubagentId?: string) => {
      setActionError(null)
      // 用户主动发言视为回到对话最新处，重新开启自动跟随
      pinnedToBottomRef.current = true
      try {
        let ensuredSessionId = sessionId
        if (!ensuredSessionId) {
          ensuredSessionId = await ensureSession()
          if (viewScope.current === voiceScopeKey || viewSession.current === ensuredSessionId) lazySessionRef.current = ensuredSessionId
        }
        const startRun = async (targetChapterId: string | null) => {
          const input = {
            sessionId: ensuredSessionId,
            novelId,
            chapterId: targetChapterId,
            // Agent 默认最大权限：恒以 build 模式运行（后端路由也有强制兜底）
            mode: 'build' as const,
            prompt,
            selection: selection ?? null,
            attachments: attachments.length > 0 ? attachments : undefined,
            creativeFreedom: freedom,
            qualityMode: selectedQualityMode,
            modelTier,
            customModelId: modelTier === 'custom' ? customModelId ?? undefined : undefined,
            reasoningEffort: selectedReasoningEffort,
            // 作者在「+」菜单里点选的技能：本轮绕过评分门槛必定装载
            pinnedSkillIds: pinnedSkillIds.length > 0 ? pinnedSkillIds : undefined,
            pinnedSubagentId,
          }
          const enqueue = async () => {
            const signature = JSON.stringify(input)
            if (queueRetry.current?.signature !== signature) queueRetry.current = { signature, id: crypto.randomUUID() }
            await enqueueAgentRequest({ id: queueRetry.current.id, input })
            queueRetry.current = null
            await queueQuery.refetch()
            return null
          }
          if (isRunActive(useAgentStore.getState().phase) || (queueQuery.data?.items.length ?? 0) > 0) return enqueue()
          try { return await startAgentLoopRun(input) }
          catch (error) {
            // Another tab/worker may start between the UI check and this request.
            if (error instanceof AgentApiError && error.code === 'RUN_IN_PROGRESS') return enqueue()
            throw error
          }
        }
        let result: Awaited<ReturnType<typeof startAgentLoopRun>> | null
        try {
          result = await startRun(chapterId ?? null)
        } catch (error) {
          // 当前打开的章节被回退删除等导致 chapterId 失效：丢弃失效章节重试一次。
          // 与会话删除严格区分（此前两者共用 404 NOT_FOUND，章节 404 会被误判成
          // 「会话已被删除」而清空整段对话并新建会话——P0 数据丢失事故根因）
          if (
            chapterId &&
            error instanceof AgentApiError &&
            error.status === 404 &&
            error.code === 'CHAPTER_NOT_FOUND'
          ) {
            result = await startRun(null)
          } else {
            throw error
          }
        }
        if (!result || (viewSession.current !== sessionId && viewSession.current !== ensuredSessionId)) return
        if (viewScope.current !== voiceScopeKey && viewSession.current !== ensuredSessionId) return
        useAgentStore.getState().beginRun(result.runId, prompt, ensuredSessionId, attachments)
        connect(result.runId)
      } catch (error) {
        if (viewScope.current !== voiceScopeKey) throw error
        // 会话已在服务端被删除（如用户删了历史任务后本地快照残留僵尸 sessionId）：
        // 重置为新对话而不是让用户死循环卡在「会话不存在或无权访问」里
        if (sessionId && error instanceof AgentApiError && error.status === 404 && error.code === 'NOT_FOUND') {
          onNewSession?.()
          setActionError('上个会话已被删除，已为你新建对话，请重新发送。')
          throw error
        }
        setActionError(error instanceof Error ? error.message : '启动失败，请稍后再试。')
        if (error instanceof AgentApiError && ['CREDITS_EXHAUSTED', 'CREDITS_GLOBALLY_PAUSED', 'CREDITS_ACCOUNT_SUSPENDED'].includes(error.code ?? '')) {
          setQuotaDialogOpen(true)
          void refetchCredits()
        } else if (error instanceof AgentApiError && error.code === 'CREDITS_SETTLEMENT_PENDING') {
          setQuotaDialogOpen(false)
        }
        // 抛回输入框：发送失败时保留草稿，避免用户输入丢失
        throw error
      }
    },
    [sessionId, voiceScopeKey, novelId, chapterId, selection, ensureSession, connect, onNewSession, modelTier, customModelId, selectedReasoningEffort, refetchCredits, queueQuery, pinnedToBottomRef],
  )


  const canContinue = (Boolean(runId) && (phase === 'paused' || phase === 'failed')) || (!runId && Boolean(resumeableRunId))
  const combinedError = actionError ?? errorMessage

  const handleCopyText = useCallback(async (id: string, text: string) => {
    if (await copyToClipboard(text)) {
      setCopiedId(id)
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => setCopiedId(null), 1500)
    } else {
      setActionError('复制失败，请手动选择文本复制。')
    }
  }, [])

  const handleConfirmFork = useCallback(async () => {
    if (!sessionId || !forkTarget) {
      return
    }
    setForkBusy(true)
    try {
      const result = await forkAgentSession(sessionId, forkTarget.messageId ?? undefined)
      setForkTarget(null)
      onTaskForked?.(result.session)
    } catch (error) {
      setForkTarget(null)
      setActionError(error instanceof Error ? error.message : '创建分支失败，请稍后再试。')
    } finally {
      setForkBusy(false)
    }
  }, [forkTarget, onTaskForked, sessionId])

  // 分支底部「从聊天中继续」：只在副本还没有任何新对话时展示。
  // 复制过来的消息 createdAt 均早于 forkedAt，分支内新对话必然比它晚；
  // 本地刚发出的消息用客户端时钟（可能与服务端有偏差），额外按 local- 前缀与运行态兑底
  const branchContinueVisible = useMemo(() => {
    if (!sessionId || forkInfo?.sessionId !== sessionId || messages.length === 0 || active) {
      return false
    }
    const forkedAt = forkInfo.forkedAt ? new Date(forkInfo.forkedAt).getTime() : null
    return !messages.some(
      (message) =>
        message.id.startsWith('local-') ||
        (forkedAt != null && new Date(message.createdAt).getTime() > forkedAt),
    )
  }, [active, forkInfo, messages, sessionId])

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  // 移动/平板端：长按 500ms 展开复制/删除/回退按钮
  const startLongPress = useCallback(
    (messageId: string) => {
      cancelLongPress()
      longPressTimerRef.current = window.setTimeout(() => {
        setTouchActionsId(messageId)
      }, 500)
    },
    [cancelLongPress],
  )

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const { items } = await fetchAgentSessions(novelId)
      setSessions(items)
    } catch {
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [novelId])

  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => {
      const next = !open
      if (next) {
        setEditingSessionId(null)
        void loadSessions()
      }
      return next
    })
  }, [loadSessions])

  const commitRename = useCallback(async () => {
    const targetId = editingSessionId
    const title = editingTitle.trim()
    setEditingSessionId(null)
    if (!targetId || !title) {
      return
    }
    try {
      const { session } = await renameAgentSession(targetId, title)
      setSessions((current) => current.map((item) => (item.id === session.id ? session : item)))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '重命名失败，请稍后再试。')
    }
  }, [editingSessionId, editingTitle])

  const reloadMessages = useCallback(async () => {
    if (!sessionId) {
      return
    }
    try {
      // 删除/回退后的重拉：不带分页参数走全量，避免已加载的更早轮次被页窗口截掉；
      // 同时清掉分页游标，防止顶部按钮残留过期状态
      const { messages: history } = await fetchAgentSessionMessages(sessionId)
      setOlderPagination(null)
      useAgentStore.getState().restoreMessages(history, sessionId)
    } catch {
      /* 拉取失败保留现有消息 */
    }
  }, [sessionId])

  // 加载更早对话：按 run 轮次向前翻页（50 轮/页），把视口重新对准加载前的首条消息避免跳动
  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || !olderPagination?.hasMore || loadingOlder) {
      return
    }
    const before = olderPagination.before
    if (!before) {
      setOlderPagination(null)
      return
    }
    const anchorId = useAgentStore.getState().messages[0]?.id ?? null
    setLoadingOlder(true)
    try {
      const payload = await fetchAgentSessionMessages(sessionId, { runLimit: 50, beforeRunStartedAt: before })
      setOlderPagination(payload.pagination ? { hasMore: payload.pagination.hasMore, before: payload.pagination.earliestRunStartedAt } : null)
      useAgentStore.getState().prependMessages(payload.messages)
      if (anchorId) {
        // content-visibility 虚拟化下前插内容高度初始为估算值：多帧对齐锚点直到布局稳定
        const alignAnchor = () => {
          document.getElementById(`agent-message-${anchorId}`)?.scrollIntoView({ block: 'start' })
        }
        alignAnchor()
        requestAnimationFrame(alignAnchor)
        window.setTimeout(alignAnchor, 80)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '加载更早对话失败，请稍后再试。')
    } finally {
      setLoadingOlder(false)
    }
  }, [sessionId, olderPagination, loadingOlder])

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction) {
      return
    }
    setConfirmBusy(true)
    try {
      if (confirmAction.kind === 'deleteSession') {
        await deleteAgentSession(confirmAction.sessionId)
        setSessions((current) => current.filter((item) => item.id !== confirmAction.sessionId))
        // 删当前会话的善后全交给宿主（onSessionDeleted 会回落到最近一个有记录的任务）；
        // 这里再调 onNewSession 会抢先插一个空白窗口，把作者丢到欢迎页
        onSessionDeleted?.(confirmAction.sessionId)
      } else if (sessionId) {
        // 刚发出的用户消息在本地是临时 id（local-*），服务端落库用的是另一个 uuid：
        // 直接拿临时 id 调删除/回退会 404「消息不存在或已被删除」，先按 runId 对齐到真实 id
        let targetMessageId = confirmAction.messageId
        if (targetMessageId.startsWith('local-')) {
          const localMessage = useAgentStore
            .getState()
            .messages.find((item) => item.id === targetMessageId)
          const { messages: history } = await fetchAgentSessionMessages(sessionId)
          const serverMessage = history.find(
            (item) => item.role === 'user' && localMessage != null && item.runId === localMessage.runId,
          )
          targetMessageId = serverMessage?.id ?? targetMessageId
        }
        if (confirmAction.kind === 'deleteMessage') {
          await deleteAgentSessionMessage(sessionId, targetMessageId)
          await reloadMessages()
        } else {
          await rollbackAgentSessionMessage(sessionId, targetMessageId)
          await reloadMessages()
          onWorkspaceRollback?.()
        }
      }
      setConfirmAction(null)
      setTouchActionsId(null)
    } catch (error) {
      // 服务端已经没有这条消息（如此前已删除成功但界面未同步）：重拉历史对齐界面，不再报错
      if (
        error instanceof AgentApiError &&
        error.status === 404 &&
        confirmAction.kind !== 'deleteSession'
      ) {
        await reloadMessages()
        setTouchActionsId(null)
      } else {
        setActionError(error instanceof Error ? error.message : '操作失败，请稍后再试。')
      }
      setConfirmAction(null)
    } finally {
      setConfirmBusy(false)
    }
  }, [confirmAction, sessionId, onSessionDeleted, onWorkspaceRollback, reloadMessages])

  const confirmDialogCopy = confirmAction
    ? confirmAction.kind === 'deleteSession'
      ? {
          title: '删除任务对话',
          description: `将删除「${confirmAction.title}」及其全部对话记录，已写入作品的内容不受影响。`,
          confirmLabel: '删除',
        }
      : confirmAction.kind === 'deleteMessage'
        ? {
            title: '删除这轮对话',
            description: '将删除这条消息与对应的回复记录，已写入作品的内容不会被恢复。',
            confirmLabel: '删除',
          }
        : {
            title: '回退到此对话之前',
            description: '将撤销这轮及之后所有对话对作品的修改，并删除这些对话记录。此操作不可恢复。',
            confirmLabel: '回退',
          }
    : null

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!workConversation.collapsed && node && !pinnedToBottomRef.current) node.scrollTop = lastScrollTopRef.current
  }, [workConversation.collapsed, scrollRef, pinnedToBottomRef, lastScrollTopRef])
  useEffect(() => {
    if (workConversation.collapsed && (pendingApproval || pendingQuestion || combinedError || quotaDialogOpen)) workConversation.expand()
  }, [workConversation, pendingApproval, pendingQuestion, combinedError, quotaDialogOpen])

  const floatingFooterRef = useComposerInset(scrollRef, pinnedToBottomRef, lastScrollTopRef, workConversation.collapsed)

  return (
    <div className={cn('agent-conversation-panel relative flex h-full min-h-0 flex-col', workConversation.collapsed && 'work-agent-compact', className)}>
      {/* 状态栏 */}
      {!hideHeader ? <div className={cn(
        'relative flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5',
        mobileIntegratedHeader && 'absolute -top-[52px] left-[44%] right-0 z-30 h-[52px] gap-1 border-b-0 bg-[var(--app-bg)] px-1.5 py-1',
      )}>
        {mobileIntegratedHeader ? (
          <>
            <ChevoinkAgentMark className="h-5 w-5 shrink-0" />
            <span className="min-w-0 truncate text-xs font-medium text-[var(--text-primary)]">Chevoink Agent</span>
          </>
        ) : (
          // 桌面端顶栏承接原 StudioCommandBar 的任务标题展示（border-l 样式保持一致）；
          // 「更多」按钮紧随标题块：它只作用于当前任务，与顶栏全局菜单无关
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 max-w-[360px] border-l-2 border-[var(--text-primary)] pl-2.5">
              <p className="truncate text-[13px] font-medium leading-4 text-[var(--text-primary)]">{taskTitle?.trim() || '新任务'}</p>
              {taskSubtitle ? <p className="mt-0.5 truncate text-[10px] leading-3 text-[var(--text-tertiary)]">{taskSubtitle}</p> : null}
            </div>
            {onPinTask || onRenameTask || onOpenBranches ? <div ref={taskMenuRef} className="relative shrink-0">
              <button type="button" onClick={() => setTaskMenuOpen((value) => !value)} className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]" aria-label="任务操作" aria-expanded={taskMenuOpen}><MoreHorizontal className="h-4 w-4" /></button>
              {taskMenuOpen ? <div className="absolute left-0 top-[calc(100%+7px)] z-50 w-52 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1 shadow-[0_18px_50px_rgba(15,23,42,.18)] motion-safe:origin-top-left motion-safe:animate-[agent-menu-in_150ms_cubic-bezier(.2,.8,.2,1)]">
                {onPinTask ? <button type="button" disabled={!sessionId} className="flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-45" onClick={() => { setTaskMenuOpen(false); onPinTask() }}><Pin className="h-3.5 w-3.5" />置顶当前任务</button> : null}
                {onRenameTask ? <button type="button" className="flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]" onClick={() => { setTaskTitleDraft(taskTitle?.trim() || '新任务'); setTaskRenaming(true); setTaskMenuOpen(false) }}><PencilLine className="h-3.5 w-3.5" />编辑任务名称</button> : null}
                {onOpenBranches ? <button type="button" className="flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]" onClick={() => { setTaskMenuOpen(false); onOpenBranches() }}><GitBranch className="h-3.5 w-3.5" />创建分支与版本</button> : null}
              </div> : null}
            </div> : null}
          </div>
        )}
        {phase !== 'idle' ? (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
              mobileIntegratedHeader && 'hidden',
              active
                ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
                : phase === 'failed'
                  ? 'bg-rose-50 text-rose-600'
                  : 'bg-[var(--surface-muted)] text-[var(--text-secondary)]',
            )}
          >
            {phaseLabel[phase] ?? phase}
          </span>
        ) : null}
        <span className={cn('ml-auto shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]', mobileIntegratedHeader && 'hidden')}>
          {currentTurn > 0 ? `第 ${currentTurn} 轮 · ` : ''}
          {usage.totalTokens > 0 ? `${usage.totalTokens.toLocaleString()} tokens` : ''}
        </span>
        <button
          type="button"
          onClick={() => { setHistoryOpen(false); onOpenStudioSettings?.('operations') }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
          aria-label="打开 Agent 操作中心"
          title="Agent 操作中心"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleHistory}
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md p-1 transition-colors',
            mobileIntegratedHeader && 'ml-auto',
            historyOpen
              ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
          aria-label="展开或收起历史任务对话"
          title="历史任务对话"
        >
          <History className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setHistoryOpen(false)
            onNewSession?.()
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          aria-label="新建任务对话"
          title="新建任务对话"
        >
          <SquarePen className="h-4 w-4" />
        </button>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            aria-label="关闭面板"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}

        {/* 历史任务对话下拉：列表项可切换/重命名/删除 */}
        {historyOpen ? (
          <div className="absolute left-2 right-2 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.14)]">
            {sessionsLoading ? (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--text-secondary)]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                正在载入历史任务…
              </div>
            ) : sessions.length === 0 ? (
              <p className="px-2 py-2 text-xs text-[var(--text-secondary)]">还没有历史任务对话</p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    'group/item flex items-center gap-1 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-[var(--surface-muted)]',
                    session.id === sessionId && 'bg-[var(--surface-muted)]',
                  )}
                >
                  {editingSessionId === session.id ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void commitRename()
                        } else if (event.key === 'Escape') {
                          setEditingSessionId(null)
                        }
                      }}
                      maxLength={40}
                      className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-transparent px-1.5 py-0.5 text-xs text-[var(--text-primary)] outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setHistoryOpen(false)
                        onSelectSession?.(session.id)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
                        {session.title}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]">
                        {formatSessionTime(session.updatedAt)}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSessionId(session.id)
                      setEditingTitle(session.title)
                    }}
                    className="shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-all hover:text-[var(--text-primary)] md:opacity-0 md:group-hover/item:opacity-100"
                    aria-label="编辑名称"
                    title="编辑名称"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmAction({ kind: 'deleteSession', sessionId: session.id, title: session.title })
                    }
                    className="shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-all hover:text-rose-500 md:opacity-0 md:group-hover/item:opacity-100"
                    aria-label="删除对话"
                    title="删除对话"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div> : null}

      {/* 消息流 */}
      <div data-agent-body className="agent-conversation-body">
      <div ref={scrollRef} onScroll={handleMessagesScroll} className="agent-conversation-scroll min-h-0 overflow-y-auto">
      <div className="agent-conversation-width">
        {conversationLoading ? (
          /* 任何「归属不明」的中间态都走 Codex 式 Agent 图标流光（居中）：图标形状作 mask、渐变光带扫过。
             必须排在内容分支之前：否则请求一返回就被 conversationReady 短路掉，1.5s 保底窗口形同虚设 */
          <div className="flex min-h-full items-center justify-center py-10" role="status" aria-label="正在载入对话">
            <span
              className="block h-12 w-12 bg-[length:220%_100%] bg-[linear-gradient(100deg,var(--text-tertiary)_38%,var(--text-primary)_50%,var(--text-tertiary)_62%)] motion-safe:animate-[agent-icon-shimmer_1.5s_linear_infinite] [mask-image:url(/chevoink-agent.png)] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
            />
          </div>
        ) : conversationReady ? (
          /* 已有内容直接呈现：切回已加载会话 / 同会话重用 / 直播收尾时不插任何加载态，做到「有缓存直接显示」。
             按会话取 key：跨会话切换重放淡入，同会话流式追加不重挂载 */
          <div key={storeLoadedSessionId ?? 'pending'} className="flex flex-col gap-4 pb-2 motion-safe:animate-fade-in">
            {olderPagination?.hasMore ? (
              <div className="flex justify-center pb-1">
                <button
                  type="button"
                  onClick={() => void loadOlderMessages()}
                  disabled={loadingOlder}
                  className="flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingOlder ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                  {loadingOlder ? '正在载入更早对话…' : '加载更早对话'}
                </button>
              </div>
            ) : null}
            {messages.map((message) => {
              if (message.role === 'user') {
                return (
                <div
                  key={message.id}
                  id={`agent-message-${message.id}`}
                  className="agent-msg-cv group/message flex flex-col items-end gap-1.5"
                  onTouchStart={() => startLongPress(message.id)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                >
                  <div className="flex max-w-[82%] flex-col items-end gap-1.5">
                    {message.parts.some((part) => part.type === 'attachment') && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {message.parts.map((part, partIndex) => {
                          if (part.type !== 'attachment') {
                            return null
                          }
                          if (part.kind === 'image') {
                            return (
                              <button
                                key={`${message.id}-attach-${partIndex}`}
                                type="button"
                                onClick={() => setAttachmentPreview({ url: part.url, name: part.name })}
                                className="cursor-zoom-in overflow-hidden rounded-[10px] border border-[var(--border-subtle)] transition hover:opacity-90"
                                aria-label={`放大查看图片 ${part.name}`}
                              >
                                <img
                                  src={part.url}
                                  alt={part.name}
                                  className="h-16 w-16 object-cover"
                                  loading="lazy"
                                />
                              </button>
                            )
                          }
                          return (
                            <a
                              key={`${message.id}-attach-${partIndex}`}
                              href={part.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex max-w-52 items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-default)] hover:underline"
                              title={`打开文件 ${part.name}`}
                            >
                              <FileText className="h-3 w-3 shrink-0 text-[var(--text-secondary)]" />
                              <span className="truncate">{part.name}</span>
                            </a>
                          )
                        })}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words rounded-[20px] bg-[var(--surface-contrast)] px-4 py-3 text-sm leading-7 text-[var(--text-contrast)]">
                      {message.parts
                        .map((part) => (part.type === 'text' ? part.text : ''))
                        .join('')}
                    </div>
                  </div>
                  <UserMessageActions createdAt={message.createdAt} visible={touchActionsId === message.id} copied={copiedId === message.id} disabled={active}
                    onCopy={() => void handleCopyText(message.id, getMessageText(message.parts))}
                    onRollback={() => setConfirmAction({ kind: 'rollbackMessage', messageId: message.id })}
                    onDelete={() => setConfirmAction({ kind: 'deleteMessage', messageId: message.id })} />
                </div>
                )
              }

              const block = blockInfoById.get(message.id)
              const isBlockFirst = block?.firstId === message.id
              const isBlockLast = block?.lastId === message.id
              const blockExpanded = block ? !!expandedBlocks[block.firstId] : false
              // 仅当前 run 的消息视为活跃：新任务开始时历史块保持折叠，不会被全局 active 连带展开
              const messageRunActive = active && message.runId === runId
              const blockCollapsed = !messageRunActive && !blockExpanded
              const hasTextPart = message.parts.some((part) => part.type === 'text')
              // 折叠态下块内非最后一条的过程正文会折进摘要行（与传给 AgentMessageParts 的口径一致）
              const textCollapsible = !isBlockLast && (block?.ops ?? 0) > 0
              // 折叠态下块内非首条且不再贡献任何内容的消息不渲染空壳（避免 flex gap 在空壳间叠出大段空白）：
              // 无文本的消息、以及正文被折叠收起后只剩空 div 的消息都属此类
              if (blockCollapsed && !isBlockFirst && (!hasTextPart || textCollapsible)) {
                return null
              }

              return (
                <div
                  key={message.id}
                  id={`agent-message-${message.id}`}
                  // 正在流式的消息不加 content-visibility，避免高度估算干扰自动滚底
                  className={cn('group/reply min-w-0', message.id !== lastAssistantId && 'agent-msg-cv')}
                >
                  <AgentMessageParts
                    parts={message.parts}
                    streaming={messageRunActive && message.id === lastAssistantId && !finalizedTextIds.includes(message.id)}
                    runActive={messageRunActive}
                    blockId={block?.firstId}
                    summaryCount={isBlockFirst ? block?.ops : undefined}
                    summaryExpanded={blockExpanded}
                    onToggleSummary={handleToggleBlockSummary}
                    // 折叠态下过程进展正文一并收进「已处理 n 个操作」，只留块内最后一条（结尾总结）的正文
                    textCollapsible={textCollapsible}
                  />
                  {/* 结论操作条：每个对话块结尾均提供复制与创建分支（纯 icon，悬停 title 说明，流式进行中不显示） */}
                  {isBlockLast && !messageRunActive && getMessageText(message.parts) ? (
                    <div className="mt-1 flex items-center justify-start gap-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          void handleCopyText(message.id, getMessageText(message.parts))
                        }
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                        aria-label="复制回复"
                        title={copiedId === message.id ? '已复制' : '复制'}
                      >
                        {copiedId === message.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      {sessionId ? (
                        <button
                          type="button"
                          onClick={() => setForkTarget({ messageId: message.id })}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                          aria-label="从这条对话创建分支"
                          title="创建分支"
                        >
                          <GitBranch className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <MessageTime value={message.completedAt} label="完成时间" className="ml-2 opacity-0 transition-opacity group-hover/reply:opacity-100 group-focus-within/reply:opacity-100 mobile:opacity-100" />
                    </div>
                  ) : null}
                </div>
              )
            })}
            {/* 分支副本尚无新对话：底部分隔线提示可从此继续聊，一发新消息就消失 */}
            {branchContinueVisible ? (
              <div className="flex select-none items-center gap-3 py-1 text-[11px] text-[var(--text-tertiary)]">
                <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                <span className="inline-flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5" />
                  从聊天中继续
                </span>
                <span className="h-px flex-1 bg-[var(--border-subtle)]" />
              </div>
            ) : null}
            <ProcessingHint visible={awaiting} />
            {pendingApproval ? (
              <AgentPermissionCard approval={pendingApproval} onResolve={handleResolveApproval} />
            ) : null}
            {pendingQuestion ? (
              <AgentQuestionCard question={pendingQuestion} onAnswer={handleResolveQuestion} />
            ) : null}
          </div>
        ) : (
          <AgentEmptyWelcome
            novelName={novelName}
            initializingNovel={initializingNovel}
            seed={emptyStateSeed ?? sessionId ?? novelId}
            showSuggestions={showEmptySuggestions}
          />
        )}
      </div>
      </div>

      <div ref={floatingFooterRef} data-agent-floating-footer className="agent-floating-footer">
      <div className="agent-conversation-width">
      {/* 任务停靠区：待办清单 + 工作区变更（默认折叠，被触发时自动展开） */}
      {workspaceActivities.length > 0 || todos.length > 0 || pendingReviewCount > 0 ? (
        <div data-agent-activity className={cn('px-4 pb-2', activityPresentation === 'responsive' && 'agent-activity-responsive')}>
          <AgentActivityBar
            activities={workspaceActivities}
            activitiesVersion={activitiesVersion}
            todos={todos}
            todosVersion={todosVersion}
            runActive={active}
            pendingReviewCount={pendingReviewCount}
            reviewBusy={reviewBusy}
            onApproveAllReviews={onApproveAllReviews}
            onRejectAllReviews={onRejectAllReviews}
          />
        </div>
      ) : null}

      {/* 错误提示 */}
      {combinedError ? (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
          <p className="min-w-0 flex-1 text-xs leading-5 text-rose-600">{combinedError}</p>
          <button
            type="button"
            onClick={() => {
              setActionError(null)
              useAgentStore.getState().clearError()
            }}
            className="shrink-0 text-rose-400 transition-colors hover:text-rose-600"
            aria-label="关闭提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* 输入区 */}
      {skillRoute && skillRoute.selected.length > 0 ? (
        <div className="mx-4 mb-2 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
          <Wrench className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={`${skillPhaseLabel[skillRoute.phase] ?? skillRoute.phase}阶段已装载：${skillRoute.selected.map((skill) => skill.name).join('、')}`}>
            本轮技能：{skillRoute.selected.map((skill) => skill.name).join('、')}
          </span>
        </div>
      ) : null}
      {showCreditWarning && creditWarning ? (
        <div className="mx-4 mb-2 border-l-2 border-amber-500 bg-[var(--surface-muted)] px-3 py-2.5 text-xs text-[var(--text-secondary)]">
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 leading-5">本期 Credits 约剩 {creditWarning}%{creditSummaryQuery.data ? `（${formatCreditAmount(creditSummaryQuery.data.totalRemaining)}）` : ''}，长任务开始前建议先查看用量。</p>
            <button type="button" onClick={dismissCreditWarning} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="关闭额度提醒"><X className="h-3.5 w-3.5" /></button>
          </div>
          <button type="button" onClick={() => window.open('/account/usage', '_blank', 'noopener,noreferrer')} className="mt-1 font-medium text-[var(--text-primary)] hover:underline">了解更多</button>
        </div>
      ) : null}
      <CreditQuotaDialog
        open={quotaDialogOpen}
        resetsAt={creditSummaryQuery.data?.resetsAt}
        globallyPaused={errorCode === 'credits_globally_paused' || Boolean(creditSummaryQuery.data?.globallyPaused && creditSummaryQuery.data?.suspended)}
        onInvite={() => void openInviteDialog()}
        onClose={() => setQuotaDialogOpen(false)}
      />
      {workConversation.collapsed ? <WorkConversationRestore onExpand={workConversation.expand} recentMessage={recentConversationText} /> : null}
      <div data-agent-composer className="px-4 pb-4">
      {sessionId ? <AgentQueueTray key={sessionId} items={queueQuery.data?.items ?? []} onAction={async (item, action, prompt) => {
        const result = await actOnAgentQueue(sessionId, item.id, action, item.revision, prompt)
        await queueQuery.refetch()
        if (result.session && viewSession.current === sessionId) {
          if (onTaskForked) onTaskForked(result.session)
          else onSelectSession?.(result.session.id)
        }
      }} /> : null}
        <AgentComposer
          novelId={novelId}
          voiceScopeKey={voiceScopeKey}
          voiceDisabled={voiceDisabled || sessionResolving}
          running={active}
          onContinue={canContinue ? handleContinue : undefined}
          disabled={conversationLoading}
          onSend={(prompt, attachments, freedom, selectedQualityMode, pinnedSkillIds, pinnedSubagentId) => handleSend(prompt, attachments, freedom, selectedQualityMode, pinnedSkillIds, pinnedSubagentId)}
          creativeFreedom={creativeFreedom}
          onCreativeFreedomChange={setCreativeFreedom}
          qualityMode={qualityMode}
          modelTier={modelTier}
          modelOptions={creditSummaryQuery.data?.models ?? [
            { tier: 'lite', label: '轻量', multiplier: 0, available: false, selectedByDefault: false, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', visionEnabled: false },
            { tier: 'speed', label: '极速', multiplier: 1, available: true, selectedByDefault: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', visionEnabled: false },
            { tier: 'standard', label: '标准', multiplier: 1.1, available: false, selectedByDefault: false, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
            { tier: 'performance', label: '性能', multiplier: 1.8, available: false, selectedByDefault: false, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
            { tier: 'ultimate', label: '极致', multiplier: 4.8, available: false, selectedByDefault: false, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
          ]}
          onModelTierChange={setModelTier}
          customModels={customModelsQuery.data?.models ?? []}
          customModelId={customModelId}
          onCustomModelChange={setCustomModelId}
          reasoningSelections={reasoningSelections}
          onReasoningEffortChange={(modelKey, effort) => setReasoningSelections((value) => ({ ...value, [modelKey]: effort }))}
          referenceOptions={referenceOptions}
          skills={pinnableSkills}
          onOpenSkillManager={onOpenSkills}
          onOpenModelSettings={() => onOpenStudioSettings?.('models')}
          onStop={() => void handleStop()}
          stopping={stoppingRunId === runId && runId !== null}
        />
      </div>
      </div>
      </div>
      </div>
      {attachmentPreview && (
        <ImageLightbox
          src={attachmentPreview.url}
          alt={attachmentPreview.name}
          downloadName={attachmentPreview.name}
          onClose={() => setAttachmentPreview(null)}
        />
      )}

      {/* 消息删除/回退、历史对话删除确认 */}
      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmDialogCopy?.title ?? ''}
        description={confirmDialogCopy?.description ?? ''}
        confirmLabel={confirmDialogCopy?.confirmLabel}
        tone="danger"
        busy={confirmBusy}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => setConfirmAction(null)}
      />
      <DangerConfirmDialog
        open={Boolean(forkTarget)}
        tone="default"
        title="创建任务分支"
        description="将复制一份同名任务（标题带角标区分），把当前到这条对话为止的上下文完整带过去，在新分支里接着聊不会影响原任务。"
        bullets={['原任务对话与已写入作品的内容保持不变', '分支里的新对话不会回流到原任务']}
        confirmLabel="创建分支"
        busy={forkBusy}
        onConfirm={() => void handleConfirmFork()}
        onCancel={() => setForkTarget(null)}
      />
      <InviteCreditsDialog
        open={inviteDialogOpen}
        referral={referralQuery.data ?? null}
        copied={inviteCopied}
        onCopy={() => void copyInviteLink()}
        onClose={() => { autoCopyInviteRef.current = false; setInviteDialogOpen(false) }}
      />
      {/* 任务重命名弹窗（原 StudioCommandBar 任务三点菜单迁入） */}
      {taskRenaming ? <div className="fixed inset-0 z-[170] flex items-center justify-center bg-black/25 p-4" onMouseDown={() => setTaskRenaming(false)}><form onSubmit={(event) => { event.preventDefault(); if (taskTitleDraft.trim()) onRenameTask?.(taskTitleDraft.trim()); setTaskRenaming(false) }} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-2xl"><h2 className="text-sm font-semibold">编辑任务名称</h2><input autoFocus maxLength={160} value={taskTitleDraft} onChange={(event) => setTaskTitleDraft(event.target.value)} className="mt-4 h-10 w-full rounded-[9px] border border-[var(--border-subtle)] bg-transparent px-3 text-sm outline-none focus:border-[var(--border-strong)]" /><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setTaskRenaming(false)} className="h-9 rounded-[9px] px-3 text-xs hover:bg-[var(--surface-muted)]">取消</button><button type="submit" disabled={!taskTitleDraft.trim()} className="h-9 rounded-[9px] bg-[var(--surface-contrast)] px-4 text-xs font-medium text-[var(--text-contrast)] disabled:opacity-45">保存</button></div></form></div> : null}
    </div>
  )
}
