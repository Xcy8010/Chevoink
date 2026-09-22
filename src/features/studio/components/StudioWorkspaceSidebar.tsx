import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, BookOpenText, Bot, Bug, Check, ChevronDown, ChevronRight, Clock3, Copy, Crosshair, Flag, FolderDown,
  Gauge, Gift, GitBranch, Home, Lightbulb, LoaderCircle, MoreHorizontal, PencilLine, Pin, PinOff, Plus, RotateCcw,
  Search, Settings2, Trash2, Upload, X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useToast } from '@/components/ui/toast-context'
import { fetchCreditSummary, fetchReferral } from '@/features/account/credits-api'
import { formatCreditAmount, formatCreditResetLabel } from '@/features/account/credit-format'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import Avatar from '@/features/community/components/Avatar'
import FeedbackDialog from '@/features/feedback/components/FeedbackDialog'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import type { AgentSession, FeedbackKind, Novel } from '../../../../shared/contracts/index.js'
import { deleteNovelWorkspace, updateNovelMeta } from '../api'
import { deleteAgentSession, fetchAgentSessions, fetchSessionsRunStatus, forkAgentSession, renameAgentSession, updateAgentSessionSettings } from '../agent/agentApi'
import ChevoinkAgentMark from '../agent/components/ChevoinkAgentMark'
import { useAgentStore } from '../agent/agentStore'
import { formatTaskRelativeTime } from '../lib/relative-time'
import type { AgentTaskSidebarItem } from './AgentTaskSidebar'
import DangerConfirmDialog from './DangerConfirmDialog'

type SettingsSection = 'general' | 'models' | 'operations' | 'archives'
type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 宽度最终确定（拖拽结束/折叠/首帧）时上报，供 Work 布局动态计算聊天区最小宽度 */
  onWidthChange?: (width: number) => void
  perspective: 'work' | 'ide'
  perspectiveSwitchEnabled: boolean
  onPerspectiveChange: (value: 'work' | 'ide') => void
  currentNovelId: string
  currentNovelTitle: string
  novels: Novel[]
  novelsLoading?: boolean
  switchingNovel?: boolean
  currentTasks: AgentTaskSidebarItem[]
  /** Local tasks retain their owner while the destination novel is hydrating. */
  currentTasksNovelId: string
  activeTaskId: string | null
  taskSwitchLocked: boolean
  onSelectNovel: (novelId: string) => void
  onCreateNovel: () => void
  onCreateTask: () => void
  onSelectTask: (taskId: string, novelId: string) => void
  onRenameTask: (taskId: string, title: string) => void
  /** 作品行的「新建对话」：跳作品时宿主先切作品再开新任务窗口 */
  onCreateTaskInNovel: (novelId: string) => void
  /** 任务删除或归档完成（含本地临时窗口）：宿主移除任务窗口，必要时回落或补一个新窗口 */
  onTaskDeleted: (taskId: string) => void
  /** 任务切出分支成功：宿主把新会话登记为任务窗口并切过去 */
  onTaskForked: (session: AgentSession) => void
  /** 作品删除完成：宿主清缓存、必要时换到其它作品 */
  onNovelDeleted: (novelId: string) => void
  /** 以下作品级动作只对当前作品生效（宿主 handler 绑定 activeNovelId），菜单里也只给当前作品渲染 */
  currentNovelStatus?: Novel['status']
  onOpenNovelMeta?: () => void
  onExportNovel?: () => void
  /** 入口始终展示；服务端开关关闭时由导入弹窗给出未开放提示，不在菜单层隐藏 */
  onImportNovel: () => void
  onPublishNovel?: () => void
  onToggleNovelCompletion?: () => void
  autoFollow: boolean
  onAutoFollowChange: (enabled: boolean) => void
  onOpenStudioSettings: (section?: SettingsSection) => void
}
type ContextTarget =
  | { kind: 'novel'; id: string; title: string; pinned: boolean; x: number; y: number }
  | { kind: 'task'; id: string; novelId: string; title: string; pinned: boolean; temporary: boolean; x: number; y: number }
type ContextTargetInput =
  | { kind: 'novel'; id: string; title: string; pinned: boolean }
  | { kind: 'task'; id: string; novelId: string; title: string; pinned: boolean; temporary: boolean }
type RenameTarget = { kind: 'novel' | 'task'; id: string; title: string }
type SidebarTask = {
  id: string; novelId: string; title: string; updatedAt: string; pinnedAt: string | null; temporary: boolean
  /** 分支副本：行尾展示分支 icon */
  isBranch: boolean
  /** 最近活跃时间（lastRunAt 优先）：悬停信息卡片右上角显示多久前 */
  lastActiveAt: string
  createdAt: string | null
}
/** 高危确认弹窗要处理的动作：删作品需逐字输入，删任务与切分支只需点确认 */
type DangerAction =
  | { kind: 'deleteNovel'; id: string; title: string }
  | { kind: 'deleteTask'; id: string; title: string; temporary: boolean }
  | { kind: 'forkTask'; id: string; title: string }
/** 任务悬停信息卡片：侧栏列表横向 overflow 会裁切，改用 fixed 按行坐标渲染 */
type TaskCard = { task: SidebarTask; x: number; y: number }

const MIN_WIDTH = 216
const MAX_WIDTH = 392
const DEFAULT_WIDTH = 280
const COLLAPSE_AT = MIN_WIDTH
/** 折叠态悬停peek的横向宽度上限：悬浮预览不需要展开态那么宽 */
const PEEK_MAX_WIDTH = 288
/** 旧版默认宽度，仅精确匹配时迁移到新默认，保留用户主动拖拽的值 */
const LEGACY_DEFAULT_WIDTH = 304

function novelTitle(novel: Novel) {
  return novel.displayTitle?.trim() || novel.title?.trim() || '未命名作品'
}

function toSidebarTask(session: AgentSession): SidebarTask {
  return {
    id: session.id, novelId: session.novelId, title: session.title, updatedAt: session.updatedAt,
    pinnedAt: session.pinnedAt, temporary: false, isBranch: Boolean(session.forkedFromSessionId),
    lastActiveAt: session.lastRunAt ?? session.updatedAt, createdAt: session.createdAt,
  }
}

function sortWorkspaceItemsByLatest<T extends { updatedAt: string }>(items: T[]): T[] {
  const timestamp = (value: string) => {
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : 0
  }
  return [...items].sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
}

function initialWidth() {
  const value = Number(window.localStorage.getItem('chevoink:studio-sidebar-width'))
  if (!Number.isFinite(value) || value <= MIN_WIDTH + 16) return DEFAULT_WIDTH
  if (value === LEGACY_DEFAULT_WIDTH) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value))
}

export default function StudioWorkspaceSidebar(props: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const sessionUser = useShellStore((state) => state.sessionUser)
  const [width, setWidth] = useState(initialWidth)
  const onWidthChangeRef = useRef(props.onWidthChange)
  onWidthChangeRef.current = props.onWidthChange
  // 宽度稳定后上报（拖拽中不逐帧上报，避免父级大组件高频重渲染）
  useEffect(() => {
    if (!dragRef.current) onWidthChangeRef.current?.(width)
  }, [width])
  const [peek, setPeek] = useState(false)
  const [productMenu, setProductMenu] = useState(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const [usageExpanded, setUsageExpanded] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null)
  const [warningDismissed, setWarningDismissed] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set([props.currentNovelId]))
  const [context, setContext] = useState<ContextTarget | null>(null)
  const contextTriggerRef = useRef<HTMLElement | null>(null)
  const [rename, setRename] = useState<RenameTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [danger, setDanger] = useState<DangerAction | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ContextTargetInput | null>(null)
  const [taskCard, setTaskCard] = useState<TaskCard | null>(null)
  const taskCardTimerRef = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const accountRef = useRef<HTMLDivElement | null>(null)
  const peekCloseTimerRef = useRef<number | null>(null)
  const autoCopyRef = useRef(false)
  const resizeRootRef = useRef<HTMLElement>(null)
  const [foldingSidebar, setFoldingSidebar] = useState(false)
  useEffect(() => {
    setFoldingSidebar(true)
    const timer = setTimeout(() => setFoldingSidebar(false), 220)
    return () => clearTimeout(timer)
  }, [props.open])
  const dragRef = useRef<{ x: number; width: number; raw: number; pointer: number; open: boolean } | null>(null)
  useEffect(() => {
    const cancel = () => {
      const gesture = dragRef.current
      dragRef.current = null
      if (gesture && resizeRootRef.current?.hasPointerCapture(gesture.pointer)) resizeRootRef.current.releasePointerCapture(gesture.pointer)
      if (gesture) delete document.documentElement.dataset.studioResizing
    }
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('blur', cancel); cancel() }
  }, [])
  // 作品列表滚动位置记忆：折叠/展开或切换作品重挂载后恢复，不再回到顶部
  const listScrollTopRef = useRef(0)
  const restoreListScroll = useCallback((element: HTMLDivElement | null) => {
    if (element && listScrollTopRef.current > 0) {
      element.scrollTop = listScrollTopRef.current
    }
  }, [])

  const novels = useMemo(
    () => sortWorkspaceItemsByLatest(props.novels.filter((item) => item.status !== 'archived')),
    [props.novels],
  )
  const sessionsQuery = useQuery({
    queryKey: ['agent', 'sessions', 'workspace-sidebar'],
    queryFn: () => fetchAgentSessions(),
    staleTime: 15_000,
    enabled: props.open || peek || searchOpen,
  })
  const searchQuery = useQuery({
    queryKey: ['agent', 'sessions', 'workspace-search', searchText.trim()],
    queryFn: () => fetchAgentSessions(undefined, { query: searchText.trim() }),
    staleTime: 8_000,
    enabled: searchOpen && searchText.trim().length > 0,
  })
  const creditQuery = useQuery({ queryKey: ['credits', 'summary'], queryFn: fetchCreditSummary, staleTime: 20_000, refetchInterval: 60_000 })
  const referralQuery = useQuery({ queryKey: ['credits', 'referral'], queryFn: fetchReferral, staleTime: 60_000, enabled: inviteOpen })
  const sessions = useMemo(() => sessionsQuery.data?.items ?? [], [sessionsQuery.data?.items])
  const sessionsByNovel = useMemo(() => {
    const result = new Map<string, AgentSession[]>()
    sessions.forEach((session) => result.set(session.novelId, [...(result.get(session.novelId) ?? []), session]))
    result.forEach((items, novelId) => result.set(novelId, sortWorkspaceItemsByLatest(items)))
    return result
  }, [sessions])
  const localTasks = useMemo<SidebarTask[]>(() => props.currentTasks.map((task) => ({
    id: task.id, novelId: props.currentTasksNovelId, title: task.title, updatedAt: task.updatedAt,
    pinnedAt: null, temporary: task.temporary, isBranch: false, lastActiveAt: task.updatedAt, createdAt: null,
  })), [props.currentTasksNovelId, props.currentTasks])
  // 任务状态信号：本地 SSE 实时层（agentStore）+ 服务端 run-status 轮询兑底，
  // 覆盖切走窗口/跨作品/折叠期间的任务完成、待确认、异常中止与运行中提示
  const sessionSignals = useAgentStore((state) => state.sessionSignals)
  const runningSessionIds = useAgentStore((state) => state.runningSessionIds)
  const agentPhase = useAgentStore((state) => state.phase)
  /** 正在直播的会话：phase 只对它成立，不能拿去判断其他任务行 */
  const livePhaseSessionId = useAgentStore((state) => state.activeSessionId)
  const trackedRunningIds = useMemo(() => [...runningSessionIds], [runningSessionIds])
  const sidebarSessionIds = useMemo(
    () => [...new Set([...localTasks.map((task) => task.id), ...sessions.map((session) => session.id), ...trackedRunningIds])].slice(0, 60),
    [localTasks, sessions, trackedRunningIds],
  )
  const runStatusQuery = useQuery({
    queryKey: ['agent', 'sessions', 'run-status', sidebarSessionIds],
    queryFn: () => fetchSessionsRunStatus(sidebarSessionIds),
    refetchInterval: 10_000,
    staleTime: 5_000,
    enabled: sidebarSessionIds.length > 0,
  })
  const remoteRunStatuses = useMemo(() => runStatusQuery.data?.statuses ?? {}, [runStatusQuery.data])
  useEffect(() => {
    const statuses = runStatusQuery.data?.statuses
    if (!statuses) return
    useAgentStore.getState().syncRemoteRunStatuses(statuses)
  }, [runStatusQuery.data])
  const summary = creditQuery.data
  const remainingPercent = summary?.dailyAllowance ? Math.max(0, Math.min(100, Math.round(summary.totalRemaining / summary.dailyAllowance * 100))) : 100
  const warningThreshold: 5 | 10 | 20 | null = remainingPercent <= 5 ? 5 : remainingPercent <= 10 ? 10 : remainingPercent <= 20 ? 20 : null
  // 用真实余额而不是取整百分比判耗尽：0.4% 会四舍五入成 0%，但额度还能用
  const creditsExhausted = summary ? summary.totalRemaining <= 0 : false

  useLayoutEffect(() => setExpandedProjects((current) => new Set(current).add(props.currentNovelId)), [props.currentNovelId])
  useEffect(() => {
    const key = summary?.resetsAt && warningThreshold ? `chevoink:credit-warning:${summary.resetsAt}:${warningThreshold}` : null
    setWarningDismissed(Boolean(key && window.localStorage.getItem(key) === 'dismissed'))
  }, [summary?.resetsAt, warningThreshold])
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (accountOpen && !accountRef.current?.contains(event.target as Node)) setAccountOpen(false)
      setProductMenu(false)
      setMoreMenu(false)
      setContext(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [accountOpen])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true) }
      if (event.key === 'Escape') { setSearchOpen(false); setContext(null) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  useEffect(() => () => {
    if (peekCloseTimerRef.current !== null) window.clearTimeout(peekCloseTimerRef.current)
    if (taskCardTimerRef.current !== null) window.clearTimeout(taskCardTimerRef.current)
  }, [])

  const copyInvite = useCallback(async () => {
    const url = referralQuery.data?.inviteUrl
    if (!url || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(url)
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 1800)
    } catch { /* 显式复制按钮仍可用 */ }
  }, [referralQuery.data?.inviteUrl])
  useEffect(() => {
    if (!inviteOpen || !autoCopyRef.current || !referralQuery.data?.inviteUrl) return
    autoCopyRef.current = false
    void copyInvite()
  }, [copyInvite, inviteOpen, referralQuery.data?.inviteUrl])

  function openInvite() {
    setAccountOpen(false)
    setInviteOpen(true)
    autoCopyRef.current = true
    if (referralQuery.data?.inviteUrl) { autoCopyRef.current = false; void copyInvite() }
  }
  function openContext(event: React.MouseEvent, target: ContextTargetInput) {
    event.preventDefault(); event.stopPropagation()
    contextTriggerRef.current = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    hideTaskCard()
    setContext({ ...target, x: event.clientX, y: event.clientY } as ContextTarget)
  }
  /** 「更多」按钮开的卡片与右键菜单共用一套：按钮位置作为锚点，避免两份菜单定义跑偏 */
  function openContextAt(trigger: HTMLElement, target: ContextTargetInput) {
    contextTriggerRef.current = trigger
    const rect = trigger.getBoundingClientRect()
    hideTaskCard()
    setContext({ ...target, x: rect.right - 8, y: rect.bottom + 6 } as ContextTarget)
  }
  function clearTaskCardTimer() {
    if (taskCardTimerRef.current !== null) window.clearTimeout(taskCardTimerRef.current)
    taskCardTimerRef.current = null
  }
  function hideTaskCard() { clearTaskCardTimer(); setTaskCard(null) }
  /** 悬停 320ms 后再弹信息卡片：快速划过列表时不闪卡片 */
  function scheduleTaskCard(event: React.MouseEvent<HTMLElement>, task: SidebarTask) {
    const rect = event.currentTarget.getBoundingClientRect()
    clearTaskCardTimer()
    taskCardTimerRef.current = window.setTimeout(() => {
      taskCardTimerRef.current = null
      setTaskCard({ task, x: rect.right + 10, y: rect.top })
    }, 320)
  }
  async function copyTaskId(taskId: string) {
    setContext(null)
    if (await copyToClipboard(taskId)) toast.success('任务 ID 已复制，可在对话里让 Agent 读取该任务的上下文。')
    else toast.error('复制失败，请手动选择文本复制。')
  }
  function requestDeleteNovel(target: { id: string; title: string }) {
    setContext(null)
    // 与顶栏删除口径一致：已发布作品先下架再删，不把入口置灰而是说清去哪里操作
    if (novels.find((item) => item.id === target.id)?.status === 'published') {
      toast.error('已发布作品不能直接删除，请先去「作品设置」将作品下架，之后再执行删除。')
      return
    }
    setDanger({ kind: 'deleteNovel', id: target.id, title: target.title })
  }
  async function runDangerAction() {
    if (!danger) return
    setBusy(true)
    try {
      if (danger.kind === 'deleteNovel') {
        await deleteNovelWorkspace(danger.id)
        props.onNovelDeleted(danger.id)
        await refreshNavigation()
        toast.success('作品已删除。')
      } else if (danger.kind === 'deleteTask') {
        // 临时窗口还没落库，直接让宿主移除即可，不要拿本地 id 调删除接口 404
        if (!danger.temporary) await deleteAgentSession(danger.id)
        props.onTaskDeleted(danger.id)
        await refreshNavigation()
      } else {
        const { session } = await forkAgentSession(danger.id)
        await refreshNavigation()
        props.onTaskForked(session)
      }
      setDanger(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败，请稍后再试。')
      setDanger(null)
    } finally { setBusy(false) }
  }
  async function refreshNavigation() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] }),
      queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] }),
    ])
  }
  async function togglePin(target: ContextTargetInput) {
    if ('temporary' in target && target.temporary) return
    setBusy(true)
    try {
      if (target.kind === 'novel') await updateNovelMeta(target.id, { pinned: !target.pinned })
      else await updateAgentSessionSettings(target.id, { pinned: !target.pinned })
      await refreshNavigation()
    } finally { setBusy(false); setContext(null) }
  }
  /**
   * 归档确认：归档统一走确认弹窗并说明找回入口。临时窗口还没落库、
   * 运行中或等待确认的任务现场不能被拉走，这两种情况只提示不弹窗。
   */
  function requestArchive(target: ContextTargetInput) {
    setContext(null)
    if ('temporary' in target && target.temporary) return
    const remoteStatus = remoteRunStatuses[target.id]?.status
    const taskBusy =
      target.kind === 'task' &&
      (runningSessionIds.has(target.id) ||
        remoteStatus === 'running' ||
        remoteStatus === 'queued' ||
        remoteStatus === 'awaiting_approval' ||
        (target.id === props.activeTaskId && props.taskSwitchLocked))
    if (taskBusy) {
      toast.error('任务正在运行或等待确认，结束后才能归档。')
      return
    }
    setArchiveTarget(target)
  }
  async function runArchive() {
    const target = archiveTarget
    if (!target) return
    setBusy(true)
    try {
      if (target.kind === 'novel') {
        await updateNovelMeta(target.id, { status: 'archived' })
        if (target.id === props.currentNovelId) {
          const next = novels.find((item) => item.id !== target.id)
          if (next) props.onSelectNovel(next.id); else props.onCreateNovel()
        }
        toast.success('作品已归档，可在左侧栏「更多 → 归档内容」中找回并恢复。')
      } else {
        await updateAgentSessionSettings(target.id, { status: 'archived' })
        // 归档与删除同为窗口回收：不能新建任务窗口（否则作者会看到「归档了却又冒出一个新任务」），
        // 且必须移除本地窗口，被归档的任务才不会继续留在列表里
        props.onTaskDeleted(target.id)
        toast.success('任务已归档，可在左侧栏「更多 → 归档内容」中找回并恢复。')
      }
      await refreshNavigation()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档失败，请稍后再试。')
    } finally { setBusy(false); setArchiveTarget(null) }
  }
  function beginRename(target: ContextTargetInput) {
    setRename({ kind: target.kind, id: target.id, title: target.title }); setRenameValue(target.title); setContext(null)
  }
  async function commitRename() {
    if (!rename || !renameValue.trim()) return
    setBusy(true)
    try {
      const title = renameValue.trim().slice(0, 160)
      if (rename.kind === 'novel') await updateNovelMeta(rename.id, { title })
      else if (props.currentTasks.some((task) => task.id === rename.id)) props.onRenameTask(rename.id, title)
      else await renameAgentSession(rename.id, title)
      await refreshNavigation(); setRename(null)
    } finally { setBusy(false) }
  }
  function beginResize(event: React.PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    resizeRootRef.current?.setPointerCapture(event.pointerId)
    const initial = props.open ? width : MIN_WIDTH
    dragRef.current = { x: event.clientX, width: initial, raw: initial, pointer: event.pointerId, open: props.open }
    document.documentElement.dataset.studioResizing = 'true'
    setPeek(false)
  }
  function resize(event: React.PointerEvent) {
    if (!dragRef.current || dragRef.current.pointer !== event.pointerId) return
    const raw = dragRef.current.width + event.clientX - dragRef.current.x
    dragRef.current.raw = raw
    const open = raw >= COLLAPSE_AT + (dragRef.current.open ? -24 : 24)
    if (open !== dragRef.current.open) {
      dragRef.current.open = open
      props.onOpenChange(open)
    }
    if (open) setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw)))
  }
  function finishResize() {
    const state = dragRef.current; dragRef.current = null
    if (state) {
      if (resizeRootRef.current?.hasPointerCapture(state.pointer)) resizeRootRef.current.releasePointerCapture(state.pointer)
      delete document.documentElement.dataset.studioResizing
      try { window.localStorage.setItem('chevoink:studio-sidebar-width', String(Math.round(Math.max(MIN_WIDTH + 17, width)))) } catch { /* Optional preference. */ }
      onWidthChangeRef.current?.(width)
    }
  }

  function showPeek() {
    if (dragRef.current) return
    if (peekCloseTimerRef.current !== null) window.clearTimeout(peekCloseTimerRef.current)
    peekCloseTimerRef.current = null
    setPeek(true)
  }
  function schedulePeekClose() {
    if (peekCloseTimerRef.current !== null) window.clearTimeout(peekCloseTimerRef.current)
    peekCloseTimerRef.current = window.setTimeout(() => {
      setPeek(false)
      setProductMenu(false)
      setMoreMenu(false)
      setAccountOpen(false)
      peekCloseTimerRef.current = null
    }, 180)
  }

  const projectTasks = (novelId: string): SidebarTask[] => {
    const remote = (sessionsByNovel.get(novelId) ?? []).map(toSidebarTask)
    if (novelId !== props.currentTasksNovelId) return sortWorkspaceItemsByLatest(remote)
    // 同 id 任务以服务端为准（快照只补服务端尚没有的本地临时任务）：
    // 快照→服务端合并时 updatedAt 不再漂移，切换作品后任务列表不重排跳动
    const remoteIds = new Set(remote.map((task) => task.id))
    return sortWorkspaceItemsByLatest([...remote, ...localTasks.filter((task) => !remoteIds.has(task.id))])
  }
  const pinnedNovels = sortWorkspaceItemsByLatest(novels.filter((item) => item.pinnedAt))
  const pinnedSessions = sortWorkspaceItemsByLatest(sessions.filter((item) => item.pinnedAt))

  function taskRow(task: SidebarTask, compact = false) {
    const active = task.novelId === props.currentNovelId && task.id === props.activeTaskId
    const signal = sessionSignals[task.id]
    const remoteStatus = remoteRunStatuses[task.id]?.status
    // 正在直播的任务窗口以本地 phase 为唯一真相：run-status 轮询最多滞后 10s，
    // 作者答完选择后不能再残留黄点，必须立即回到转圈
    const livePhase = active && livePhaseSessionId === task.id ? agentPhase : null
    const awaiting = livePhase
      ? livePhase === 'awaiting_approval' || livePhase === 'awaiting_input'
      : signal?.kind === 'attention' || remoteStatus === 'awaiting_approval'
    const spinning = livePhase
      ? livePhase === 'starting' || livePhase === 'running'
      : runningSessionIds.has(task.id) || remoteStatus === 'running' || remoteStatus === 'queued'
    // 异常中止持续显示（含当前任务窗口内），直到作者发新提示词或任务恢复运行
    const aborted = signal?.kind === 'failed' || livePhase === 'failed' || livePhase === 'cancelled'
    // 状态指示器优先级：待作者选择（黄）> 运行中（转圈）> 异常中止（红）> 已完成（绿，仅未读且不在该窗口内）> 占位
    const indicator = awaiting
      ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
      : spinning
        ? <LoaderCircle className="h-3 w-3 animate-spin text-[var(--text-tertiary)]" aria-hidden="true" />
        : aborted
          ? <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden="true" />
          : signal?.kind === 'done' && !active
            ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            : <span className="h-1.5 w-1.5 rounded-full" aria-hidden="true" />
    return <div key={`${task.novelId}:${task.id}`} className="group/task relative" onMouseEnter={(event) => scheduleTaskCard(event, task)} onMouseLeave={hideTaskCard}><button type="button" onClick={() => props.onSelectTask(task.id, task.novelId)} onContextMenu={(event) => openContext(event, { kind: 'task', id: task.id, novelId: task.novelId, title: task.title, pinned: Boolean(task.pinnedAt), temporary: task.temporary })} disabled={props.taskSwitchLocked} className={cn('group flex w-full items-center gap-2 rounded-[8px] pl-2.5 pr-2 text-left text-[12px] transition-colors disabled:opacity-50', compact ? 'h-8' : 'h-9', active ? 'bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]')} aria-current={active ? 'page' : undefined}><span className="flex h-3 w-3 shrink-0 items-center justify-center">{indicator}</span><span className="min-w-0 flex-1 truncate">{task.title || '新任务'}</span>{task.isBranch ? <GitBranch className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" aria-label="分支任务" /> : null}{task.pinnedAt ? <Pin className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" /> : null}{/* 悬停时右侧让位给置顶/归档按钮，避免按钮盖住标题末尾 */}{task.temporary ? null : <span className="w-0 shrink-0 transition-[width] duration-150 group-hover/task:w-[46px]" aria-hidden="true" />}</button>{task.temporary ? null : <div className="absolute right-1 top-0 flex h-full items-center gap-0.5 opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100"><button type="button" disabled={busy} onClick={() => void togglePin({ kind: 'task', id: task.id, novelId: task.novelId, title: task.title, pinned: Boolean(task.pinnedAt), temporary: task.temporary })} className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)] disabled:opacity-40" aria-label={task.pinnedAt ? '取消置顶' : '置顶任务'} title={task.pinnedAt ? '取消置顶' : '置顶'}>{task.pinnedAt ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</button><button type="button" disabled={busy} onClick={() => requestArchive({ kind: 'task', id: task.id, novelId: task.novelId, title: task.title, pinned: Boolean(task.pinnedAt), temporary: task.temporary })} className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)] disabled:opacity-40" aria-label="归档任务" title="归档"><Archive className="h-3.5 w-3.5" /></button></div>}</div>
  }

  function body() {
    return <div className="studio-sidebar-surface relative flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-3">
        <div className="relative min-w-0 flex-1">
          <button type="button" onMouseDown={(event) => event.stopPropagation()} onClick={() => setProductMenu((value) => !value)} className="flex h-8 max-w-full items-center gap-2 rounded-[9px] px-2 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"><ChevoinkAgentMark className="h-5 w-5 shrink-0" /><span key={props.perspective} className="truncate motion-safe:animate-[mode-label-in_180ms_cubic-bezier(.22,1,.36,1)]">{props.perspective === 'work' ? 'Work' : 'IDE'}</span><ChevronDown className={cn('h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform', productMenu && 'rotate-180')} /></button>
          {productMenu ? <div onMouseDown={(event) => event.stopPropagation()} className="absolute left-0 top-[calc(100%+5px)] z-50 w-64 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[0_18px_50px_rgba(15,23,42,.18)]">{([{ id: 'work' as const, title: 'Work', description: '协作、任务与创作' }, { id: 'ide' as const, title: 'IDE', description: '结构、正文与预览' }]).map((item) => <button key={item.id} type="button" onClick={() => { props.onPerspectiveChange(item.id); setProductMenu(false) }} disabled={!props.perspectiveSwitchEnabled} className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-[var(--surface-muted)] disabled:opacity-50"><div className="min-w-0 flex-1"><p className="text-xs font-semibold">{item.title}</p><p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">{item.description}</p></div>{props.perspective === item.id ? <Check className="h-4 w-4" /> : null}</button>)}</div> : null}
        </div>
        <button type="button" onClick={() => setSearchOpen(true)} className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" aria-label="搜索作品与任务" title="搜索（Ctrl+K）"><Search className="h-4 w-4" /></button>
      </div>

      <div ref={restoreListScroll} onScroll={(event) => { listScrollTopRef.current = event.currentTarget.scrollTop; hideTaskCard() }} className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 [scrollbar-width:thin]">
        <div className="space-y-0.5 pb-3">
          <button type="button" onClick={props.onCreateTask} disabled={props.taskSwitchLocked} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-xs font-medium hover:bg-[var(--surface-muted)] disabled:opacity-45"><PencilLine className="h-4 w-4" /><span className="flex-1">新对话</span><Plus className="h-3.5 w-3.5 text-[var(--text-tertiary)]" /></button>
          <button type="button" onClick={() => props.onAutoFollowChange(!props.autoFollow)} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"><Crosshair className="h-4 w-4" /><span className="flex-1">正文追踪</span><span className="text-[10px] text-[var(--text-tertiary)]">{props.autoFollow ? '已开启' : '已关闭'}</span></button>
          <button type="button" onClick={() => props.onOpenStudioSettings('operations')} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"><Bot className="h-4 w-4" /><span className="flex-1">Agent 与定时</span></button>
          <div className="relative"><button type="button" onMouseDown={(event) => event.stopPropagation()} onClick={() => setMoreMenu((value) => !value)} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"><MoreHorizontal className="h-4 w-4" />更多</button>{moreMenu ? <div onMouseDown={(event) => event.stopPropagation()} className="absolute left-2 right-2 top-full z-40 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1 shadow-xl"><button type="button" onClick={() => props.onOpenStudioSettings('archives')} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-xs hover:bg-[var(--surface-muted)]"><Archive className="h-3.5 w-3.5" />归档内容</button><button type="button" onClick={() => props.onOpenStudioSettings('general')} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-xs hover:bg-[var(--surface-muted)]"><Settings2 className="h-3.5 w-3.5" />创作区设置</button></div> : null}</div>
        </div>

        {pinnedNovels.length || pinnedSessions.length ? <section className="pb-4"><p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-tertiary)]">置顶</p>{pinnedNovels.map((novel) => <button key={novel.id} type="button" onClick={() => props.onSelectNovel(novel.id)} onContextMenu={(event) => openContext(event, { kind: 'novel', id: novel.id, title: novelTitle(novel), pinned: true })} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"><BookOpenText className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{novelTitle(novel)}</span><Pin className="h-3 w-3" /></button>)}{pinnedSessions.map((session) => taskRow(toSidebarTask(session), true))}</section> : null}

        <section><div className="flex items-center justify-between px-2 pb-1.5"><p className="text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-tertiary)]">作品</p><button type="button" onClick={props.onCreateNovel} disabled={props.switchingNovel} className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--surface-muted)] disabled:opacity-40" aria-label="新建作品"><Plus className="h-3.5 w-3.5" /></button></div>
          {/* 有缓存数据时直接渲染列表，后台刷新不替换内容，避免跨作品切换/二次进入时闪烁 */}
          {props.novelsLoading && novels.length === 0 ? <p className="px-2 py-3 text-xs text-[var(--text-tertiary)]">正在读取作品…</p> : novels.map((novel) => {
            const title = novelTitle(novel); const tasks = projectTasks(novel.id); const expanded = expandedProjects.has(novel.id); const shown = expanded ? tasks : tasks.slice(0, 5)
            return <div key={novel.id} className="mb-1"><div className="group/novel relative"><button type="button" onClick={() => { props.onSelectNovel(novel.id); setExpandedProjects((current) => new Set(current).add(novel.id)) }} onContextMenu={(event) => openContext(event, { kind: 'novel', id: novel.id, title, pinned: Boolean(novel.pinnedAt) })} className={cn('flex h-9 w-full items-center gap-2 rounded-[8px] pl-2.5 pr-2 text-left text-xs', novel.id === props.currentNovelId ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]')}><BookOpenText className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{title}</span>{/* 悬停时用更多/新建任务按钮替掉任务数角标 */}<span className="text-[9px] tabular-nums text-[var(--text-tertiary)] transition-opacity group-hover/novel:opacity-0">{tasks.length || `${novel.chapterCount}章`}</span><span className="w-0 shrink-0 transition-[width] duration-150 group-hover/novel:w-[46px]" aria-hidden="true" /></button><div className="absolute right-1 top-0 flex h-full items-center gap-0.5 opacity-0 transition-opacity group-hover/novel:opacity-100 focus-within:opacity-100"><button type="button" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => openContextAt(event.currentTarget, { kind: 'novel', id: novel.id, title, pinned: Boolean(novel.pinnedAt) })} className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]" aria-label="作品更多操作" title="更多"><MoreHorizontal className="h-3.5 w-3.5" /></button><button type="button" disabled={props.taskSwitchLocked} onClick={() => props.onCreateTaskInNovel(novel.id)} className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)] disabled:opacity-40" aria-label="在该作品新建任务" title="新建任务"><Plus className="h-3.5 w-3.5" /></button></div></div><div className="ml-5">{shown.map((task) => taskRow(task))}{tasks.length > 5 ? <button type="button" onClick={() => setExpandedProjects((current) => { const next = new Set(current); if (next.has(novel.id)) next.delete(novel.id); else next.add(novel.id); return next })} className="flex h-8 items-center gap-1 px-2 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">{expanded ? '收起' : `展开全部 ${tasks.length} 条`}<ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} /></button> : null}</div></div>
          })}
        </section>
      </div>

      <div className="relative shrink-0 border-t border-[var(--border-subtle)]" ref={accountRef}>
        {warningThreshold && !warningDismissed ? <div className="mx-2 my-2 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-2.5 text-[10px]"><div className="flex items-start gap-2"><Gauge className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" /><span className="min-w-0 flex-1 leading-4">{creditsExhausted ? <><span className="font-medium text-[var(--text-primary)]">额度已耗尽</span><br />邀请好友领取 300 Credits！</> : `剩余 ${remainingPercent}% 使用量`}</span><button type="button" onClick={openInvite} className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-emerald-600 px-2 font-medium text-white transition-opacity hover:opacity-90"><Gift className="h-3 w-3" />邀请</button><button type="button" onClick={() => { if (summary?.resetsAt) window.localStorage.setItem(`chevoink:credit-warning:${summary.resetsAt}:${warningThreshold}`, 'dismissed'); setWarningDismissed(true) }} className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="关闭提醒"><X className="h-3 w-3" /></button></div></div> : null}
        <button type="button" onClick={() => setAccountOpen((value) => !value)} className="flex h-11 w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--surface-muted)]" aria-expanded={accountOpen}><Avatar name={sessionUser?.nickname ?? '创作者'} src={sessionUser?.avatarUrl} size="sm" className="h-7 w-7" /><span className="min-w-0 flex-1 truncate text-xs font-medium">{sessionUser?.nickname ?? '创作者'}</span><ChevronDown className={cn('h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform', accountOpen && 'rotate-180')} /></button>
        {accountOpen ? <div className="absolute bottom-[calc(100%-2px)] left-2 right-2 z-[70] overflow-hidden rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[0_20px_55px_rgba(15,23,42,.22)] motion-safe:origin-bottom motion-safe:animate-[agent-menu-in_150ms_cubic-bezier(.2,.8,.2,1)]"><div className="mb-1 flex items-center gap-2 rounded-[10px] bg-emerald-600 px-3 py-2.5 text-[11px] text-white shadow-[0_5px_16px_rgba(5,150,105,.18)]"><Gift className="h-3.5 w-3.5" /><span className="font-medium">公测期间，每日送 450 Credits！</span></div><button type="button" onClick={() => setUsageExpanded((value) => !value)} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs font-medium hover:bg-[var(--surface-muted)]"><Gauge className="h-3.5 w-3.5" /><span className="flex-1">剩余用量</span><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', usageExpanded && 'rotate-180')} /></button>{usageExpanded ? <div className="mx-1 mb-1 rounded-[10px] bg-[var(--surface-muted)] px-3 py-2.5 text-[11px]"><div className="flex items-end justify-between"><div><p className="text-[var(--text-tertiary)]">当前可用</p><p className="mt-0.5 text-base font-semibold tabular-nums">{summary ? formatCreditAmount(summary.totalRemaining) : '—'} <span className="text-[10px] font-normal">Credits</span></p></div><span className="text-[10px] text-[var(--text-tertiary)]">{remainingPercent}%</span></div><div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${remainingPercent}%` }} /></div><div className="mt-2 flex justify-between text-[10px] text-[var(--text-tertiary)]"><span>每日 {formatCreditAmount(summary?.dailyAllowance ?? 450)} Credits</span><span>{formatCreditResetLabel(summary?.resetsAt)}</span></div><button type="button" onClick={() => window.open('/account/usage', '_blank', 'noopener,noreferrer')} className="mt-2 text-[10px] font-medium hover:underline">查看详细记录 →</button></div> : null}<button type="button" onClick={openInvite} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs hover:bg-[var(--surface-muted)]"><Gift className="h-3.5 w-3.5" />邀请好友</button><button type="button" onClick={() => { setAccountOpen(false); props.onOpenStudioSettings('general') }} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs hover:bg-[var(--surface-muted)]"><Settings2 className="h-3.5 w-3.5" />创作区设置</button><button type="button" onClick={() => { setAccountOpen(false); setFeedbackKind('suggestion') }} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs hover:bg-[var(--surface-muted)]"><Lightbulb className="h-3.5 w-3.5" />提交建议</button><button type="button" onClick={() => { setAccountOpen(false); setFeedbackKind('bug') }} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs hover:bg-[var(--surface-muted)]"><Bug className="h-3.5 w-3.5" />问题反馈</button><button type="button" onClick={() => navigate('/')} className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs hover:bg-[var(--surface-muted)]"><Home className="h-3.5 w-3.5" />返回首页</button></div> : null}
      </div>
    </div>
  }

  const peekWidth = Math.min(width, PEEK_MAX_WIDTH)

  // 右键菜单与「更多」卡片共用同一套条目样式，避免两处菜单视觉漂移
  const menuItem = 'flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40'
  const menuDivider = 'mx-1 my-1 border-t border-[var(--border-subtle)]'
  const publishLabel = props.currentNovelStatus === 'published' ? '更新发布' : '发布'
  const novelCompleted = props.currentNovelStatus === 'completed'
  const taskCardNovel = taskCard ? novels.find((item) => item.id === taskCard.task.novelId) : undefined
  const dangerCopy = danger ? danger.kind === 'deleteNovel'
    ? { title: '删除作品', description: `将永久删除《${danger.title}》。作品下的卷、章节正文、计划与全部任务对话都会一并清除，且无法恢复。`, bullets: ['章节正文与历史版本会一起删除', '该作品下的全部任务与对话记录会被清除', '已发布的作品需要先下架才能删除'], confirmLabel: '删除作品', requiredText: '确定删除', tone: 'danger' as const }
    : danger.kind === 'deleteTask'
      ? { title: '删除任务', description: `将删除任务「${danger.title}」及其全部对话记录，已写入作品的正文不受影响。`, bullets: ['任务里的对话、工具调用与产物记录会被清除', '任务已写入章节的正文保留在作品中'], confirmLabel: '删除任务', requiredText: undefined, tone: 'danger' as const }
      : { title: '创建任务分支', description: `将复制一份「${danger.title}」的副本（标题带角标区分），完整带上现有对话上下文，在分支里接着聊不会影响原任务。`, bullets: ['原任务的对话与已写入内容保持不变', '分支里的新对话不会回流到原任务'], confirmLabel: '创建分支', requiredText: undefined, tone: 'default' as const }
    : null

  const archiveCopy = archiveTarget ? archiveTarget.kind === 'novel'
    ? { title: '归档作品', description: `将归档《${archiveTarget.title}》。归档后作品会从创作区列表收起，可随时恢复。`, bullets: ['作品内容、章节与任务对话都会完整保留', '归档后可在左侧栏「更多 → 归档内容」中找到它', '恢复后会重新出现在创作区项目列表'], confirmLabel: '确认归档' }
    : { title: '归档任务', description: `将归档任务「${archiveTarget.title}」。归档后它会从任务列表收起，可随时恢复。`, bullets: ['任务不会被删除，对话记录与已写入作品的正文保留', '归档后可在左侧栏「更多 → 归档内容」中找到它', '恢复后会重新出现在所属作品的任务列表'], confirmLabel: '确认归档' }
    : null

  const foundSessions = searchText.trim() ? (searchQuery.data?.items ?? []) : sessions.slice(0, 10)
  const needle = searchText.trim().toLocaleLowerCase()
  const foundNovels = novels.filter((item) => !needle || novelTitle(item).toLocaleLowerCase().includes(needle))

  return <>
    <aside data-sidebar-folding={foldingSidebar} ref={resizeRootRef} onPointerMove={resize} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} className={cn('studio-resizable-panel relative z-30 h-full min-h-0 shrink-0 overflow-visible border-r bg-[var(--app-bg)] transition-[width,border-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)]', props.open ? 'border-[var(--border-subtle)]' : 'border-transparent')} style={{ width: props.open ? width : 0 }} data-workspace-sidebar={props.open ? 'open' : 'collapsed'}>{props.open ? body() : null}<div role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuenow={props.open ? width : 0} aria-valuemin={0} aria-valuemax={MAX_WIDTH} tabIndex={0} onPointerDown={beginResize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); if (!props.open) { if (event.key === 'ArrowRight') props.onOpenChange(true) } else if (width <= MIN_WIDTH && event.key === 'ArrowLeft') props.onOpenChange(false); else setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width + (event.key === 'ArrowRight' ? 24 : -24)))) } }} className="absolute inset-y-0 -right-1 z-[60] w-2 cursor-col-resize touch-none hover:bg-[var(--border-strong)] focus-visible:bg-[var(--border-strong)]" /></aside>
    {!props.open ? <div className="fixed bottom-0 left-0 top-12 z-50 overflow-visible transition-[width] duration-200 ease-[cubic-bezier(.22,1,.36,1)]" style={{ width: peek ? peekWidth : 12 }} onMouseEnter={showPeek} onMouseLeave={schedulePeekClose}><div aria-hidden="true" onPointerDown={beginResize} className="absolute inset-y-0 left-0 z-[60] w-2 cursor-col-resize touch-none" /><aside className={cn('h-full border-r border-[var(--border-subtle)] bg-[var(--app-bg)] shadow-[12px_0_34px_rgba(15,23,42,.14)] transition-[opacity,transform] duration-180 ease-out', peek ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-3 opacity-0')} style={{ width: peekWidth }}>{body()}</aside></div> : null}

    {searchOpen ? <div className="fixed inset-0 z-[180] flex items-start justify-center bg-black/25 px-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={() => setSearchOpen(false)}><section role="dialog" aria-modal="true" aria-label="搜索作品、任务与聊天记录" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-2xl overflow-hidden rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_28px_90px_rgba(15,23,42,.24)]"><div className="flex h-14 items-center gap-3 border-b border-[var(--border-subtle)] px-4"><Search className="h-4 w-4 text-[var(--text-tertiary)]" /><input autoFocus value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索作品、任务或聊天记录" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /><kbd className="rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">Esc</kbd></div><div className="max-h-[62vh] overflow-y-auto p-2"><p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-tertiary)]">作品</p>{foundNovels.map((item) => <button key={item.id} type="button" onClick={() => { props.onSelectNovel(item.id); setSearchOpen(false) }} className="flex h-10 w-full items-center gap-3 rounded-[9px] px-3 text-left text-xs hover:bg-[var(--surface-muted)]"><BookOpenText className="h-4 w-4 text-[var(--text-tertiary)]" /><span className="flex-1 truncate">{novelTitle(item)}</span><span className="text-[10px] text-[var(--text-tertiary)]">作品</span></button>)}<p className="mt-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-tertiary)]">任务与聊天记录</p>{foundSessions.map((session) => <button key={session.id} type="button" onClick={() => { props.onSelectTask(session.id, session.novelId); setSearchOpen(false) }} className="flex h-10 w-full items-center gap-3 rounded-[9px] px-3 text-left text-xs hover:bg-[var(--surface-muted)]"><Clock3 className="h-4 w-4 text-[var(--text-tertiary)]" /><span className="min-w-0 flex-1 truncate">{session.title}</span><span className="max-w-36 truncate text-[10px] text-[var(--text-tertiary)]">{session.novelTitle ?? '任务'}</span></button>)}{needle && !foundNovels.length && !foundSessions.length ? <p className="px-3 py-10 text-center text-xs text-[var(--text-tertiary)]">没有找到相关作品、任务或聊天记录</p> : null}</div></section></div> : null}

    {context ? <div onMouseDown={(event) => event.stopPropagation()} className="fixed z-[190] max-h-[calc(100dvh-24px)] w-48 overflow-y-auto rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1 shadow-2xl" style={{ left: Math.min(context.x, window.innerWidth - 208), top: Math.max(12, Math.min(context.y, window.innerHeight - (context.kind === 'novel' ? 424 : 304))) }}>
      {context.kind === 'novel' ? <><button type="button" disabled={props.taskSwitchLocked} onClick={() => { const novelId = context.id; setContext(null); props.onCreateTaskInNovel(novelId) }} className={menuItem}><PencilLine className="h-3.5 w-3.5" />新建对话</button><div className={menuDivider} /></> : null}
      <button type="button" disabled={busy || ('temporary' in context && context.temporary)} onClick={() => void togglePin(context)} className={menuItem}>{context.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}{context.pinned ? '取消置顶' : '置顶'}</button>
      <button type="button" disabled={busy} onClick={() => beginRename(context)} className={menuItem}><PencilLine className="h-3.5 w-3.5" />重命名</button>
      {context.kind === 'task' ? <><button type="button" disabled={context.temporary} onClick={() => void copyTaskId(context.id)} className={menuItem} title={context.temporary ? '新对话发出第一条消息后才有任务 ID' : '复制任务 ID'}><Copy className="h-3.5 w-3.5" />复制任务 ID</button><button type="button" disabled={busy || context.temporary} onClick={() => { const target = { kind: 'forkTask' as const, id: context.id, title: context.title }; setContext(null); setDanger(target) }} className={menuItem} title={context.temporary ? '新对话还没有可复制的上下文' : '复制成同名分支任务'}><GitBranch className="h-3.5 w-3.5" />创建分支</button></> : null}
      {context.kind === 'novel' && context.id === props.currentNovelId ? <><div className={menuDivider} />{props.onOpenNovelMeta ? <button type="button" onClick={() => { setContext(null); props.onOpenNovelMeta?.() }} className={menuItem}><Settings2 className="h-3.5 w-3.5" />作品设置</button> : null}{props.onPublishNovel ? <button type="button" onClick={() => { setContext(null); props.onPublishNovel?.() }} className={menuItem}><Upload className="h-3.5 w-3.5" />{publishLabel}</button> : null}{props.onToggleNovelCompletion && props.currentNovelStatus ? <button type="button" onClick={() => { setContext(null); props.onToggleNovelCompletion?.() }} className={menuItem}>{novelCompleted ? <RotateCcw className="h-3.5 w-3.5" /> : <Flag className="h-3.5 w-3.5" />}{novelCompleted ? '继续连载' : '完结作品'}</button> : null}<button type="button" onClick={() => { contextTriggerRef.current?.focus(); setContext(null); props.onImportNovel() }} className={cn(menuItem, 'min-h-11')}><Upload className="h-3.5 w-3.5" />一键导入</button>{props.onExportNovel ? <button type="button" onClick={() => { setContext(null); props.onExportNovel?.() }} className={menuItem}><FolderDown className="h-3.5 w-3.5" />一键导出</button> : null}</> : null}
      <div className={menuDivider} />
      <button type="button" disabled={busy || ('temporary' in context && context.temporary)} onClick={() => requestArchive(context)} className={cn(menuItem, 'text-amber-700')}><Archive className="h-3.5 w-3.5" />归档</button>
      {context.kind === 'novel'
        ? <button type="button" disabled={busy} onClick={() => requestDeleteNovel({ id: context.id, title: context.title })} className={cn(menuItem, 'text-rose-600')}><Trash2 className="h-3.5 w-3.5" />删除作品</button>
        : <button type="button" disabled={busy} onClick={() => { const target = { kind: 'deleteTask' as const, id: context.id, title: context.title, temporary: context.temporary }; setContext(null); setDanger(target) }} className={cn(menuItem, 'text-rose-600')}><Trash2 className="h-3.5 w-3.5" />删除任务</button>}
    </div> : null}

    {/* 任务悬停信息卡片：列表容器有纵向滚动会裁切绝对定位元素，改用 fixed 按行坐标渲染 */}
    {taskCard ? <div className="pointer-events-none fixed z-[150] w-64 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 shadow-[0_18px_50px_rgba(15,23,42,.18)]" style={{ left: Math.min(taskCard.x, window.innerWidth - 272), top: Math.max(12, Math.min(taskCard.y, window.innerHeight - 172)) }}>
      <div className="flex items-start gap-2"><p className="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-5 text-[var(--text-primary)]">{taskCard.task.title || '新任务'}</p><span className="shrink-0 pt-0.5 text-[10px] text-[var(--text-tertiary)]">{taskCard.task.temporary ? '未开始' : formatTaskRelativeTime(taskCard.task.lastActiveAt)}</span></div>
      <div className="mt-2.5 space-y-1 text-[10px]">{[
        { label: '所属作品', value: taskCardNovel ? novelTitle(taskCardNovel) : '—' },
        { label: '任务类型', value: taskCard.task.temporary ? '未保存的新对话' : taskCard.task.isBranch ? '分支副本' : '普通任务' },
        { label: '创建时间', value: taskCard.task.createdAt ? new Date(taskCard.task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—' },
      ].map((row) => <div key={row.label} className="flex items-center gap-2"><span className="w-14 shrink-0 text-[var(--text-tertiary)]">{row.label}</span><span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{row.value}</span></div>)}</div>
      <p className="mt-2.5 border-t border-[var(--border-subtle)] pt-2 text-[10px] leading-4 text-[var(--text-tertiary)]">右键可复制任务 ID、创建分支或删除任务</p>
    </div> : null}

    {dangerCopy ? <DangerConfirmDialog open title={dangerCopy.title} description={dangerCopy.description} bullets={dangerCopy.bullets} requiredText={dangerCopy.requiredText} confirmLabel={dangerCopy.confirmLabel} tone={dangerCopy.tone} busy={busy} onConfirm={() => void runDangerAction()} onCancel={() => setDanger(null)} /> : null}
    {archiveCopy ? <DangerConfirmDialog open title={archiveCopy.title} description={archiveCopy.description} bullets={archiveCopy.bullets} confirmLabel={archiveCopy.confirmLabel} tone="default" busy={busy} onConfirm={() => void runArchive()} onCancel={() => setArchiveTarget(null)} /> : null}
    {rename ? <div className="fixed inset-0 z-[195] flex items-center justify-center bg-black/25 p-4" onMouseDown={() => setRename(null)}><form onSubmit={(event) => { event.preventDefault(); void commitRename() }} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-2xl"><h2 className="text-sm font-semibold">重命名{rename.kind === 'novel' ? '作品' : '任务'}</h2><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={160} className="mt-4 h-10 w-full rounded-[9px] border border-[var(--border-subtle)] bg-transparent px-3 text-sm outline-none focus:border-[var(--border-strong)]" /><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setRename(null)} className="h-9 rounded-[9px] px-3 text-xs hover:bg-[var(--surface-muted)]">取消</button><button type="submit" disabled={busy || !renameValue.trim()} className="h-9 rounded-[9px] bg-[var(--surface-contrast)] px-4 text-xs font-medium text-[var(--text-contrast)] disabled:opacity-45">保存</button></div></form></div> : null}
    <InviteCreditsDialog open={inviteOpen} referral={referralQuery.data ?? null} copied={inviteCopied} onCopy={() => void copyInvite()} onClose={() => { autoCopyRef.current = false; setInviteOpen(false) }} />
    <FeedbackDialog open={feedbackKind !== null} kind={feedbackKind ?? 'bug'} source="studio-work" onClose={() => setFeedbackKind(null)} />
  </>
}
