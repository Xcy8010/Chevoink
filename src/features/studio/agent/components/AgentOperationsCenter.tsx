import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import {
  Archive,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  CirclePause,
  CirclePlay,
  GitBranch,
  GitFork,
  LoaderCircle,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SquareActivity,
  X,
} from 'lucide-react'
import { createPortal } from 'react-dom'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type {
  AgentEvalComparisonView,
  AgentScheduleView,
  AgentSession,
  AgentSessionToolPolicy,
  AgentSandboxMode,
} from '../../../../../shared/contracts'
import {
  createAgentScheduleRequest,
  createEvalComparisonRequest,
  fetchAgentSchedules,
  fetchAgentSessions,
  fetchEvalComparisons,
  forkAgentSession,
  updateAgentScheduleRequest,
  updateAgentSessionSettings,
} from '../agentApi'
import { buildAgentTaskBranchRows } from '../lib/task-branches'
import SubAgentManager from './SubAgentManager'

type Tab = 'tasks' | 'branches' | 'agents' | 'schedules' | 'permissions' | 'evals'

type Props = {
  open: boolean
  onClose: () => void
  novelId: string
  sessionId: string | null
  chapterId?: string | null
  runIds: string[]
  currentSession?: AgentSession | null
  onSelectSession?: (sessionId: string) => void
  onTaskForked?: (session: AgentSession) => void
  embedded?: boolean
}

type TabDefinition = {
  id: Tab
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}

const tabs: TabDefinition[] = [
  { id: 'tasks', label: '任务', description: '查找与整理对话任务', icon: Search },
  { id: 'branches', label: '任务分支', description: '查看当前作品的探索路线', icon: GitBranch },
  { id: 'agents', label: '子 Agent', description: '管理可复用的专业助手', icon: Bot },
  { id: 'schedules', label: '定时计划', description: '让 Agent 按周期执行检查', icon: CalendarClock },
  { id: 'permissions', label: '权限', description: '控制工具与写入边界', icon: ShieldCheck },
  { id: 'evals', label: '评测', description: '对比真实运行表现', icon: SquareActivity },
]

const defaultPolicy: AgentSessionToolPolicy = {
  network: 'ask',
  contentWrite: 'allow',
  bulkWrite: 'ask',
  publish: 'ask',
  destructive: 'ask',
}

const inputClass = 'h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]'
const textareaClass = 'min-h-28 w-full resize-y rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 text-sm leading-6 outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]'

const permissionRows: Array<{
  key: keyof AgentSessionToolPolicy
  label: string
  description: string
}> = [
  { key: 'network', label: '联网检索', description: '访问公开网页并读取外部资料。' },
  { key: 'contentWrite', label: '正文写入', description: '写入当前章节或工作区文档。' },
  { key: 'bulkWrite', label: '批量改写', description: '一次修改多个章节或大段内容。' },
  { key: 'publish', label: '发布操作', description: '改变作品的公开发布状态。' },
  { key: 'destructive', label: '删除与回滚', description: '删除内容、任务或执行不可逆回滚。' },
]

const cadenceLabels: Record<number, string> = {
  360: '每 6 小时',
  1440: '每天',
  10080: '每周',
}

function EmptyState({ icon: Icon, title, description, action }: {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]">
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-4 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-5 text-[var(--text-secondary)]">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

function SectionHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--text-secondary)]">{description}</p>
      </div>
      {action}
    </div>
  )
}

function ScheduleDialog({
  open,
  busy,
  name,
  prompt,
  cadenceMinutes,
  onNameChange,
  onPromptChange,
  onCadenceChange,
  onClose,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  name: string
  prompt: string
  cadenceMinutes: number
  onNameChange: (value: string) => void
  onPromptChange: (value: string) => void
  onCadenceChange: (value: number) => void
  onClose: () => void
  onSubmit: () => void
}) {
  if (!open) return null
  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[260] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section role="dialog" aria-modal="true" aria-label="新建定时计划" className="w-full max-w-xl overflow-hidden rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_24px_70px_rgba(15,23,42,.2)]">
        <header className="flex items-start gap-4 border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="min-w-0 flex-1"><h3 className="text-base font-semibold">新建定时计划</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">Agent 会在当前任务中按周期执行这项检查。</p></div>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <label className="block"><span className="mb-1.5 block text-xs font-medium">计划名称</span><input autoFocus className={inputClass} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：章节质量巡检" /></label>
          <label className="block"><span className="mb-1.5 block text-xs font-medium">执行周期</span><select className={inputClass} value={cadenceMinutes} onChange={(event) => onCadenceChange(Number(event.target.value))}><option value={360}>每 6 小时</option><option value={1440}>每天</option><option value={10080}>每周</option></select></label>
          <label className="block"><span className="mb-1.5 block text-xs font-medium">Agent 要完成什么</span><textarea className={textareaClass} value={prompt} onChange={(event) => onPromptChange(event.target.value)} placeholder="描述检查范围、输出格式和完成标准" /></label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-4"><Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" onClick={onSubmit} disabled={busy || !name.trim() || !prompt.trim()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}创建计划</Button></footer>
      </section>
    </div>,
    document.body,
  )
}

export default function AgentOperationsCenter({
  open,
  onClose,
  novelId,
  sessionId,
  chapterId,
  runIds,
  currentSession,
  onSelectSession,
  onTaskForked,
  embedded = false,
}: Props) {
  const [tab, setTab] = useState<Tab>('tasks')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tasks, setTasks] = useState<AgentSession[]>([])
  const [novelTasks, setNovelTasks] = useState<AgentSession[]>([])
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [schedules, setSchedules] = useState<AgentScheduleView[]>([])
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [scheduleName, setScheduleName] = useState('章节质量巡检')
  const [schedulePrompt, setSchedulePrompt] = useState('检查最新章节的连续性、逻辑和人类感质量，输出明确结论。')
  const [cadenceMinutes, setCadenceMinutes] = useState(1440)
  const [sandboxMode, setSandboxMode] = useState<AgentSandboxMode>('workspace')
  const [policy, setPolicy] = useState<AgentSessionToolPolicy>(defaultPolicy)
  const [selectedRuns, setSelectedRuns] = useState<string[]>([])
  const [evals, setEvals] = useState<AgentEvalComparisonView[]>([])

  const execute = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  const refreshTasks = async () => {
    const data = await fetchAgentSessions(undefined, { query, includeArchived })
    setTasks(data.items)
  }
  const refreshNovelTasks = async () => {
    const data = await fetchAgentSessions(novelId, { includeArchived: true })
    setNovelTasks(data.items)
  }
  const refreshSchedules = async () => {
    const data = await fetchAgentSchedules(novelId)
    setSchedules(data.items)
  }
  const refreshEvals = async () => {
    const data = await fetchEvalComparisons(novelId)
    setEvals(data.items)
  }

  useEffect(() => {
    if (!open) return
    void execute(async () => {
      await Promise.all([refreshTasks(), refreshNovelTasks(), refreshSchedules(), refreshEvals()])
    })
  // Initial data must be reloaded when the settings page switches to another novel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, novelId])

  useEffect(() => {
    if (!open || tab !== 'tasks') return
    const timer = window.setTimeout(() => {
      void refreshTasks().catch((cause) => setError(cause instanceof Error ? cause.message : '任务加载失败。'))
    }, 220)
    return () => window.clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, includeArchived, open, tab])

  useEffect(() => {
    const active = currentSession ?? novelTasks.find((item) => item.id === sessionId)
    if (!active) return
    setSandboxMode(active.sandboxMode ?? 'workspace')
    setPolicy(active.toolPolicy ?? defaultPolicy)
  }, [currentSession, novelTasks, sessionId])

  const runOptions = useMemo(() => [...new Set(runIds)].slice(-12).reverse(), [runIds])
  const branchRows = useMemo(() => buildAgentTaskBranchRows(novelTasks), [novelTasks])
  const actualBranchCount = useMemo(() => novelTasks.filter((item) => Boolean(item.forkedFromSessionId)).length, [novelTasks])

  if (!open) return null

  const openTask = (item: AgentSession) => {
    if (item.novelId === novelId) {
      onSelectSession?.(item.id)
      onClose()
      return
    }
    window.location.assign(`/studio/novel/${encodeURIComponent(item.novelId)}?session=${encodeURIComponent(item.id)}`)
  }

  const content = (
    <div className={cn(embedded ? 'h-full min-h-0' : 'fixed inset-0 z-[155] flex items-end justify-center bg-black/35 backdrop-blur-[2px] sm:items-center sm:p-6')} onMouseDown={(event) => { if (!embedded && event.target === event.currentTarget) onClose() }}>
      <section role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : 'true'} aria-label="Agent 操作中心" className={cn('flex w-full flex-col overflow-hidden bg-[var(--surface-default)]', embedded ? 'h-full min-h-0' : 'h-[92dvh] max-w-5xl border border-[var(--border-subtle)] shadow-[0_28px_90px_rgba(15,23,42,0.28)] sm:h-[78dvh] sm:rounded-[20px]')}>
        <header className={cn('items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3 sm:px-6', embedded ? 'hidden' : 'flex')}>
          <SlidersHorizontal className="h-4 w-4" />
          <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Agent 操作中心</h2><p className="truncate text-xs text-[var(--text-secondary)]">任务、专业助手、计划与安全边界</p></div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] hover:bg-[var(--surface-muted)]" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] p-2 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:p-3" aria-label="Agent 操作导航">
            {tabs.map((item) => (
              <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn('inline-flex shrink-0 items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left transition-colors', tab === item.id ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]/70 hover:text-[var(--text-primary)]')}>
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0"><span className="block text-xs font-medium">{item.label}</span><span className="mt-0.5 hidden truncate text-[10px] text-[var(--text-tertiary)] sm:block">{item.description}</span></span>
              </button>
            ))}
          </nav>

          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
            <div className="mx-auto w-full max-w-5xl">
              {error ? <div role="alert" className="mb-5 border-l-2 border-rose-500 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/20 dark:text-rose-300">{error}</div> : null}
              {notice ? <div role="status" className="mb-5 border-l-2 border-[#71857c] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">{notice}</div> : null}

              {tab === 'tasks' ? (
                <section>
                  <SectionHeader title="任务" description="查找全部作品中的 Agent 对话，快速打开、置顶或归档。" />
                  <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <label className="relative flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-[var(--text-tertiary)]" /><input className={`${inputClass} pl-9`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务标题或作品名" /></label>
                    <label className="inline-flex h-10 items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} className="h-4 w-4 rounded border-[var(--border-strong)]" />显示已归档</label>
                  </div>
                  <div className="mt-5 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
                    {tasks.map((item) => (
                      <div key={item.id} className="group flex items-center gap-3 py-3.5">
                        <button type="button" onClick={() => openTask(item)} className="min-w-0 flex-1 text-left">
                          <span className="flex items-center gap-2"><span className="truncate text-sm font-medium">{item.title}</span>{item.id === sessionId ? <span className="shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">当前</span> : null}{item.status === 'archived' ? <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">已归档</span> : null}</span>
                          <span className="mt-1 block truncate text-xs text-[var(--text-secondary)]">{item.novelTitle ?? '当前作品'} · {new Date(item.lastRunAt ?? item.updatedAt).toLocaleString()}</span>
                        </button>
                        <button type="button" className={cn('inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]', item.pinnedAt && 'bg-[var(--surface-muted)] text-[var(--text-primary)]')} onClick={() => void execute(async () => { await updateAgentSessionSettings(item.id, { pinned: !item.pinnedAt }); await Promise.all([refreshTasks(), refreshNovelTasks()]) })} title={item.pinnedAt ? '取消置顶' : '置顶'} aria-label={item.pinnedAt ? '取消置顶' : '置顶'}><Pin className="h-3.5 w-3.5" /></button>
                        <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" onClick={() => void execute(async () => { await updateAgentSessionSettings(item.id, { status: item.status === 'archived' ? 'active' : 'archived' }); await Promise.all([refreshTasks(), refreshNovelTasks()]) })} title={item.status === 'archived' ? '恢复任务' : '归档任务'} aria-label={item.status === 'archived' ? '恢复任务' : '归档任务'}><Archive className="h-3.5 w-3.5" /></button>
                        <button type="button" onClick={() => openTask(item)} className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-tertiary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]" aria-label={`打开${item.title}`}><ChevronRight className="h-4 w-4" /></button>
                      </div>
                    ))}
                    {tasks.length === 0 ? <EmptyState icon={Search} title="没有匹配的任务" description="换一个关键词，或打开“显示已归档”继续查找。" /> : null}
                  </div>
                </section>
              ) : null}

              {tab === 'branches' ? (
                <section>
                  <SectionHeader
                    title="任务分支"
                    description="这里展示当前作品真实的 Agent 对话分支。分支会复制当前节点之前的对话与上下文，适合并行尝试不同剧情，不会直接覆盖原任务。"
                    action={<Button variant="primary" size="sm" disabled={!sessionId || busy} onClick={() => void execute(async () => { if (!sessionId) return; const result = await forkAgentSession(sessionId); await Promise.all([refreshTasks(), refreshNovelTasks()]); onTaskForked?.(result.session); if (!onTaskForked) onSelectSession?.(result.session.id); onClose() })}><GitFork className="h-4 w-4" />从当前任务创建分支</Button>}
                  />
                  <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-[var(--border-subtle)] py-3 text-xs text-[var(--text-secondary)]"><span><strong className="mr-1 text-sm text-[var(--text-primary)]">{novelTasks.length}</strong>个任务</span><span><strong className="mr-1 text-sm text-[var(--text-primary)]">{actualBranchCount}</strong>个分支</span><span>分支入口也可在聊天消息菜单中使用</span></div>
                  {!sessionId ? <p className="mt-3 text-xs text-[var(--text-secondary)]">当前是尚未发送消息的新任务；发送第一条消息后即可创建分支。</p> : null}
                  <div className="mt-3 divide-y divide-[var(--border-subtle)] border-b border-[var(--border-subtle)]">
                    {branchRows.map(({ session, depth, childCount }) => (
                      <div key={session.id} className="relative flex items-center gap-3 py-3.5" style={{ paddingLeft: `${Math.min(depth, 5) * 24}px` }}>
                        {depth > 0 ? <span className="absolute top-0 h-1/2 w-4 border-b border-l border-[var(--border-strong)]" style={{ left: `${Math.max(0, Math.min(depth, 5) * 24 - 20)}px` }} /> : null}
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]">{depth > 0 ? <GitBranch className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}</span>
                        <button type="button" onClick={() => openTask(session)} className="min-w-0 flex-1 text-left">
                          <span className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{session.title}</span>{session.id === sessionId ? <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px]">当前</span> : null}<span className="text-[10px] text-[var(--text-tertiary)]">{depth > 0 ? '分支' : '主任务'}{childCount > 0 ? ` · ${childCount} 个子分支` : ''}</span></span>
                          <span className="mt-1 block text-xs text-[var(--text-secondary)]">最近更新 {new Date(session.lastRunAt ?? session.updatedAt).toLocaleString()}{session.status === 'archived' ? ' · 已归档' : ''}</span>
                        </button>
                        <Button size="sm" variant="ghost" onClick={() => openTask(session)}>打开</Button>
                      </div>
                    ))}
                    {branchRows.length === 0 ? <EmptyState icon={GitBranch} title="还没有任务分支" description="先在当前任务中发送一条消息，再从这里或聊天消息菜单创建分支。" /> : null}
                  </div>
                </section>
              ) : null}

              {tab === 'agents' ? <SubAgentManager novelId={novelId} sessionId={sessionId} chapterId={chapterId} /> : null}

              {tab === 'schedules' ? (
                <section>
                  <SectionHeader title="定时计划" description="将重复的巡检和整理任务交给 Agent。计划始终绑定当前作品与当前任务，可随时暂停。" action={<Button variant="primary" size="sm" disabled={!sessionId} onClick={() => setScheduleDialogOpen(true)}><Plus className="h-4 w-4" />新建计划</Button>} />
                  {!sessionId ? <p className="mt-4 text-xs text-[var(--text-secondary)]">发送第一条消息建立任务后，才能创建定时计划。</p> : null}
                  <div className="mt-5 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
                    {schedules.map((item) => (
                      <div key={item.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]"><CalendarClock className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--text-secondary)]">{item.prompt}</p><p className="mt-1 text-[10px] text-[var(--text-tertiary)]">{cadenceLabels[item.cadenceMinutes] ?? `每 ${item.cadenceMinutes} 分钟`} · 下次 {new Date(item.nextRunAt).toLocaleString()}</p></div>
                        <Button size="sm" variant="ghost" onClick={() => void execute(async () => { await updateAgentScheduleRequest(item.id, { status: item.status === 'active' ? 'paused' : 'active' }); await refreshSchedules() })}>{item.status === 'active' ? <><CirclePause className="h-4 w-4" />暂停</> : <><CirclePlay className="h-4 w-4" />启用</>}</Button>
                      </div>
                    ))}
                    {schedules.length === 0 ? <EmptyState icon={CalendarClock} title="还没有定时计划" description="把章节巡检、设定核对等重复工作设为周期任务。" action={sessionId ? <Button size="sm" onClick={() => setScheduleDialogOpen(true)}>新建第一个计划</Button> : undefined} /> : null}
                  </div>
                </section>
              ) : null}

              {tab === 'permissions' ? (
                <section>
                  <SectionHeader title="权限与安全边界" description="这些设置只作用于当前任务，服务端会在真正执行工具前再次校验；发布、删除和批量写入不会绕过确认。" />
                  <div className="mt-5 border-y border-[var(--border-subtle)]">
                    <label className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">工具范围</span><span className="mt-1 block text-xs leading-5 text-[var(--text-secondary)]">决定 Agent 能接触哪些工具；具体动作仍受下方逐项权限限制。</span></span><select className="h-9 min-w-40 rounded-[9px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-xs" value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as AgentSandboxMode)}><option value="read_only">只读</option><option value="workspace">当前作品</option><option value="full_access">完整工具集</option></select></label>
                    {permissionRows.map((row) => (
                      <label key={row.key} className="flex flex-col gap-3 border-t border-[var(--border-subtle)] py-4 sm:flex-row sm:items-center"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{row.label}</span><span className="mt-1 block text-xs text-[var(--text-secondary)]">{row.description}</span></span><select className="h-9 min-w-40 rounded-[9px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-xs" value={policy[row.key]} onChange={(event) => setPolicy({ ...policy, [row.key]: event.target.value as 'allow' | 'ask' | 'deny' })}><option value="allow">直接允许</option><option value="ask">每次询问</option><option value="deny">禁止</option></select></label>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-4"><p className="text-xs text-[var(--text-tertiary)]">{sessionId ? '修改后仅影响当前任务。' : '发送第一条消息建立任务后可保存权限。'}</p><Button variant="primary" disabled={!sessionId || busy} onClick={() => void execute(async () => { if (!sessionId) return; await updateAgentSessionSettings(sessionId, { sandboxMode, toolPolicy: policy }); setNotice('当前任务的权限设置已保存。') })}><Check className="h-4 w-4" />保存权限</Button></div>
                </section>
              ) : null}

              {tab === 'evals' ? (
                <section>
                  <SectionHeader title="运行评测" description="选择 2–4 次当前会话的真实运行，对比模型档位、推理强度、Token 与耗时。评测不会重新执行或产生额外模型费用。" />
                  {runOptions.length > 0 ? <div className="mt-5 border-y border-[var(--border-subtle)]">{runOptions.map((id, index) => <label key={id} className="flex cursor-pointer items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-b-0"><input type="checkbox" checked={selectedRuns.includes(id)} disabled={!selectedRuns.includes(id) && selectedRuns.length >= 4} onChange={(event) => setSelectedRuns(event.target.checked ? [...selectedRuns, id] : selectedRuns.filter((value) => value !== id))} className="h-4 w-4" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">最近运行 {index + 1}</span><span className="mt-0.5 block text-[10px] text-[var(--text-tertiary)]">按当前任务运行时间由近到远排列</span></span>{selectedRuns.includes(id) ? <Check className="h-4 w-4 text-[var(--text-secondary)]" /> : null}</label>)}</div> : <EmptyState icon={SquareActivity} title="暂无可评测运行" description="完成至少两次 Agent 任务后，即可在这里创建运行对比。" />}
                  {runOptions.length > 0 ? <div className="mt-4 flex items-center justify-between gap-4"><p className="text-xs text-[var(--text-secondary)]">已选择 {selectedRuns.length}/4 次运行</p><Button variant="primary" disabled={selectedRuns.length < 2 || busy} onClick={() => void execute(async () => { await createEvalComparisonRequest({ novelId, name: `运行对比 ${new Date().toLocaleDateString()}`, runIds: selectedRuns }); setSelectedRuns([]); await refreshEvals() })}>生成对比</Button></div> : null}
                  {evals.length > 0 ? <div className="mt-7"><h4 className="text-sm font-semibold">历史评测</h4><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{evals.map((item) => <article key={item.id} className="py-4"><p className="text-sm font-medium">{item.name}</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead className="text-[var(--text-secondary)]"><tr><th className="pb-2 font-medium">样本</th><th className="font-medium">模型档位</th><th className="font-medium">推理</th><th className="font-medium">Token</th><th className="font-medium">耗时</th></tr></thead><tbody>{item.metrics.map((metric, index) => <tr key={metric.runId} className="border-t border-[var(--border-subtle)]"><td className="py-2.5">样本 {index + 1}</td><td>{metric.modelTier}</td><td>{metric.reasoningEffort}</td><td>{metric.totalTokens.toLocaleString()}</td><td>{metric.durationMs === null ? '—' : `${Math.round(metric.durationMs / 1000)} 秒`}</td></tr>)}</tbody></table></div></article>)}</div></div> : null}
                </section>
              ) : null}
            </div>
          </main>
        </div>

        {busy ? <div className="pointer-events-none fixed bottom-6 right-6 z-[270] inline-flex items-center gap-2 rounded-full bg-[var(--surface-contrast)] px-4 py-2 text-xs text-[var(--text-contrast)] shadow-lg"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在处理</div> : null}
      </section>

      <ScheduleDialog
        open={scheduleDialogOpen}
        busy={busy}
        name={scheduleName}
        prompt={schedulePrompt}
        cadenceMinutes={cadenceMinutes}
        onNameChange={setScheduleName}
        onPromptChange={setSchedulePrompt}
        onCadenceChange={setCadenceMinutes}
        onClose={() => setScheduleDialogOpen(false)}
        onSubmit={() => void execute(async () => {
          if (!sessionId) return
          await createAgentScheduleRequest({ novelId, sessionId, name: scheduleName.trim(), prompt: schedulePrompt.trim(), cadenceMinutes })
          setScheduleDialogOpen(false)
          await refreshSchedules()
          setNotice('定时计划已创建。')
        })}
      />
    </div>
  )

  return embedded ? content : createPortal(content, document.body)
}
