import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Archive,
  ArrowLeft,
  BookOpenText,
  Bot,
  BrainCircuit,
  CalendarDays,
  Check,
  ChevronRight,
  Eye,
  FileText,
  Gauge,
  Gift,
  LoaderCircle,
  Moon,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { createPortal } from 'react-dom'

import { ApiClientError, requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { CustomModelSettingsContent } from '@/features/account/CustomModelSettingsDialog'
import { fetchCreditActivity, fetchReferral } from '@/features/account/credits-api'
import { formatCreditAmount } from '@/features/account/credit-format'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import Avatar from '@/features/community/components/Avatar'
import { isNativeApp } from '@/lib/native-app'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import type { AgentSession, CreditActivityDay, Novel, UpdateMyProfileRequest, User } from '../../../../shared/contracts/index.js'
import type {
  StudioBodyFont,
  StudioContentWidth,
  StudioFontSize,
  StudioLineHeight,
} from '../studio-preferences'
import { updateNovelMeta } from '../api'
import { fetchAgentSessions, updateAgentSessionSettings } from '../agent/agentApi'
import AgentOperationsCenter from '../agent/components/AgentOperationsCenter'

export type StudioSettingsSection =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'models'
  | 'writing'
  | 'operations'
  | 'archives'

type Props = {
  open: boolean
  section: StudioSettingsSection
  onSectionChange: (section: StudioSettingsSection) => void
  onClose: () => void
  perspective: 'work' | 'ide'
  onPerspectiveChange: (perspective: 'work' | 'ide') => void
  autoFollow: boolean
  onAutoFollowChange: (enabled: boolean) => void
  novelId: string
  novels: Novel[]
  sessionId: string | null
  chapterId?: string | null
  runIds?: string[]
  onSelectSession?: (sessionId: string) => void
  onTaskForked?: (session: AgentSession) => void
  /** 操作中心归档任务完成：宿主回收对应任务窗口（运行中的当前窗口保留现场） */
  onTaskArchived?: (sessionId: string) => void
  /** 当前作品的导入记录与恢复入口；宿主负责关闭设置并打开导入弹窗历史视图 */
  onOpenImportHistory?: () => void
}

type NavItem = {
  id: StudioSettingsSection
  label: string
  description: string
  keywords: string
  icon: LucideIcon
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '个人',
    items: [
      { id: 'general', label: '通用', description: '工作区与基础行为', keywords: '工作区 模式 自动追踪 全屏', icon: Settings2 },
      { id: 'profile', label: '个人资料', description: '作者身份与公开信息', keywords: '头像 昵称 简介 作者 账号', icon: UserRound },
      { id: 'appearance', label: '外观', description: '主题与正文排版', keywords: '主题 浅色 深色 字体 字号 行距 宽度 动画', icon: Eye },
      { id: 'models', label: '模型', description: '自定义模型与密钥', keywords: '模型 API Key DeepSeek GLM 推理', icon: BrainCircuit },
    ],
  },
  {
    label: '创作与协作',
    items: [
      { id: 'writing', label: '写作偏好', description: '创作自由度与编辑体验', keywords: '写作 严谨 平衡 大胆 正文 Agent', icon: FileText },
      { id: 'operations', label: 'Agent 操作', description: '任务、分支、权限与评测', keywords: '任务 分支 子Agent 定时 权限 评测', icon: Bot },
      { id: 'archives', label: '归档', description: '恢复作品与历史任务', keywords: '归档 恢复 作品 任务', icon: Archive },
    ],
  },
]

const SECTION_META: Record<StudioSettingsSection, { title: string; description: string }> = {
  general: { title: '通用', description: '管理当前创作区的工作方式与基础行为。' },
  profile: { title: '个人资料', description: '维护作者身份、公开简介与账户入口。' },
  appearance: { title: '外观', description: '调整创作区主题与正文排版，修改会立即生效。' },
  models: { title: '模型', description: '管理当前账户可用于 Agent 的自定义模型。' },
  writing: { title: '写作偏好', description: '设置当前作品的创作自由度与正文跟随方式。' },
  operations: { title: 'Agent 操作', description: '管理任务分支、专业子 Agent、定时计划、权限和评测。' },
  archives: { title: '归档', description: '查看并恢复已归档作品与 Agent 任务。' },
}

const FREEDOM_OPTIONS = [
  { value: 'stable', label: '平衡延续', description: '优先承接已有文风、人物轨迹与段落节奏。' },
  { value: 'balanced', label: '严谨创作', description: '执行连续性与人类感检查，适合稳定生产。' },
  { value: 'bold', label: '大胆探索', description: '允许更明显的结构、节奏和表达变化。' },
] as const

type CreativeFreedom = typeof FREEDOM_OPTIONS[number]['value']

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        checked
          ? 'border-[#71857c] bg-[#71857c] dark:border-[#8fa198] dark:bg-[#8fa198]'
          : 'border-[var(--border-strong)] bg-[var(--surface-muted)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[22px]' : 'translate-x-0',
        )}
      />
    </button>
  )
}

function Choice<T extends string | number>({
  value,
  current,
  label,
  onChange,
}: {
  value: T
  current: T
  label: string
  onChange: (value: T) => void
}) {
  const active = value === current
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-[9px] border px-3 text-xs transition-colors',
        active
          ? 'border-[#aab8b2] bg-[#e5ebe8] text-[#26332e] dark:border-[#596a63] dark:bg-[#2c3934] dark:text-[#e8eeeb]'
          : 'border-[var(--border-subtle)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
      )}
    >
      {active ? <Check className="h-3.5 w-3.5" /> : null}
      {label}
    </button>
  )
}

function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="border-b border-[var(--border-subtle)] pb-7 last:border-b-0">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
        {description ? <p className="mt-1 text-xs leading-5 text-[var(--text-tertiary)]">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

function SettingsRow({
  title,
  description,
  value,
  children,
}: {
  title: string
  description: string
  value?: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-[64px] items-center gap-5 border-t border-[var(--border-subtle)] py-3 first:border-t-0 max-sm:flex-col max-sm:items-stretch max-sm:gap-3 max-sm:py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
        <p className="mt-1 text-xs leading-5 text-[var(--text-tertiary)]">{description}</p>
      </div>
      {value ? <span className="max-w-60 truncate text-xs text-[var(--text-secondary)] max-sm:max-w-full">{value}</span> : null}
      {children}
    </div>
  )
}

function GeneralPanel(props: Props) {
  const fullscreenEnabled = useShellStore((state) => state.fullscreenEnabled)
  const setFullscreenEnabled = useShellStore((state) => state.setFullscreenEnabled)
  const currentNovel = props.novels.find((novel) => novel.id === props.novelId)

  return (
    <div className="space-y-7">
      <SettingsGroup title="工作区" description="这些设置直接影响当前创作区，不会改动作品正文。">
        <SettingsRow title="工作模式" description="Work 适合与 Agent 协作；IDE 适合集中编辑结构与正文。">
          <div className="flex shrink-0 gap-2">
            <Choice value="work" current={props.perspective} label="Work" onChange={props.onPerspectiveChange} />
            <Choice value="ide" current={props.perspective} label="IDE" onChange={props.onPerspectiveChange} />
          </div>
        </SettingsRow>
        <SettingsRow title="正文自动追踪" description="Agent 打开或写入章节时，查看器自动定位到对应内容。">
          <Toggle checked={props.autoFollow} label="正文自动追踪" onChange={props.onAutoFollowChange} />
        </SettingsRow>
        {!isNativeApp() ? (
          <SettingsRow title="沉浸全屏" description="进入创作时允许浏览器切换到沉浸式全屏。">
            <Toggle checked={fullscreenEnabled} label="沉浸全屏" onChange={setFullscreenEnabled} />
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="当前作品" description="用于确认设置当前作用的作品范围。">
        <div className="border-y border-[var(--border-subtle)]">
          <SettingsRow
            title={currentNovel?.displayTitle?.trim() || currentNovel?.title || '未命名作品'}
            description={`${currentNovel?.chapterCount ?? 0} 章 · ${props.chapterId ? '已打开章节' : '尚未打开章节'}`}
            value={props.perspective === 'work' ? 'Work 工作区' : 'IDE 写作台'}
          />
          {props.onOpenImportHistory ? (
            <button type="button" onClick={props.onOpenImportHistory} className="flex w-full items-center gap-3 border-t border-[var(--border-subtle)] py-4 text-left hover:text-[var(--text-primary)]">
              <RotateCcw className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">导入记录与恢复</span>
                <span className="mt-1 block text-xs text-[var(--text-tertiary)]">查看当前作品的导入任务、完整性报告与可恢复回执</span>
              </span>
              <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
            </button>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title="账户与数据" description="敏感账户操作继续由统一账户设置处理。">
        <button type="button" onClick={() => window.open('/settings', '_blank', 'noopener,noreferrer')} className="flex w-full items-center gap-3 border-y border-[var(--border-subtle)] py-4 text-left hover:text-[var(--text-primary)]">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">账户安全与隐私</span>
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">密码、手机号、隐私范围和客户端设置</span>
          </span>
          <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
        </button>
      </SettingsGroup>
    </div>
  )
}

const ACTIVITY_DAY_MS = 24 * 60 * 60 * 1000

function shiftActivityDate(dateKey: string, days: number): string {
  return new Date(new Date(`${dateKey}T00:00:00.000Z`).getTime() + days * ACTIVITY_DAY_MS).toISOString().slice(0, 10)
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function CreditsActivityHeatmap({
  activity,
  startedAt,
  endsAt,
}: {
  activity: CreditActivityDay[]
  startedAt: string
  endsAt: string
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{
    day: CreditActivityDay
    left: number
    top: number
    placement: 'top' | 'bottom'
  } | null>(null)
  const { cells, columnCount, labels, maxSpent } = useMemo(() => {
    const activityByDate = new Map(activity.map((day) => [day.date, day]))
    const days: CreditActivityDay[] = []
    for (let date = startedAt, guard = 0; date <= endsAt && guard < 370; date = shiftActivityDate(date, 1), guard += 1) {
      days.push(activityByDate.get(date) ?? { date, creditsSpent: 0, eventCount: 0 })
    }
    const leading = new Date(`${startedAt}T00:00:00.000Z`).getUTCDay()
    const allCells: Array<CreditActivityDay | null> = [...Array.from({ length: leading }, () => null), ...days]
    const months: Array<{ label: string; column: number }> = []
    let previousMonth = ''
    days.forEach((day, index) => {
      const month = day.date.slice(0, 7)
      if (month === previousMonth) return
      previousMonth = month
      months.push({
        label: new Intl.DateTimeFormat('zh-CN', { month: 'short', timeZone: 'UTC' }).format(new Date(`${day.date}T00:00:00.000Z`)),
        column: Math.floor((leading + index) / 7),
      })
    })
    return {
      cells: allCells,
      columnCount: Math.ceil(allCells.length / 7),
      labels: months,
      maxSpent: Math.max(0, ...activity.map((day) => day.creditsSpent)),
    }
  }, [activity, endsAt, startedAt])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller && window.matchMedia('(max-width: 639px)').matches) {
      scroller.scrollLeft = scroller.scrollWidth
    }
  }, [cells.length])

  useEffect(() => {
    if (!tooltip) return
    const hideTooltip = () => setTooltip(null)
    window.addEventListener('resize', hideTooltip)
    window.addEventListener('scroll', hideTooltip, true)
    return () => {
      window.removeEventListener('resize', hideTooltip)
      window.removeEventListener('scroll', hideTooltip, true)
    }
  }, [tooltip])

  const showTooltip = (day: CreditActivityDay, target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    const halfWidth = Math.min(112, Math.max(0, (window.innerWidth - 24) / 2))
    setTooltip({
      day,
      left: Math.min(window.innerWidth - halfWidth - 12, Math.max(halfWidth + 12, rect.left + rect.width / 2)),
      top: rect.top >= 92 ? rect.top - 8 : rect.bottom + 8,
      placement: rect.top >= 92 ? 'top' : 'bottom',
    })
  }

  const levelClass = (spent: number) => {
    if (spent <= 0 || maxSpent <= 0) return 'bg-[#eceeed] dark:bg-white/[.06]'
    const ratio = spent / maxSpent
    if (ratio <= 0.15) return 'bg-[#d5e3de] dark:bg-[#24463a]'
    if (ratio <= 0.4) return 'bg-[#a9c8bd] dark:bg-[#356451]'
    if (ratio <= 0.7) return 'bg-[#719f8e] dark:bg-[#4c806c]'
    return 'bg-[#386c59] dark:bg-[#72a590]'
  }

  const width = columnCount * 13 - 3
  return (
    <>
      <div ref={scrollerRef} className="overflow-x-auto pb-1" role="group" aria-label={`过去一年共有 ${activity.length} 个 Credits 使用日`}>
        <div className="min-w-[685px]" style={{ width }}>
          <div className="grid w-max grid-flow-col grid-rows-7 gap-[3px]">
            {cells.map((day, index) => day ? (
              <button
                type="button"
                key={day.date}
                tabIndex={day.creditsSpent > 0 ? 0 : -1}
                aria-label={`${day.date}，消耗 ${formatCreditAmount(day.creditsSpent)} Credits，${day.eventCount} 次计费`}
                data-activity-date={day.date}
                onMouseEnter={(event) => showTooltip(day, event.currentTarget)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => showTooltip(day, event.currentTarget)}
                onBlur={() => setTooltip(null)}
                className={cn(
                  'h-2.5 w-2.5 rounded-[2px] outline-none ring-offset-1 ring-offset-white focus-visible:ring-2 focus-visible:ring-[#71857c] dark:ring-offset-[#111318]',
                  levelClass(day.creditsSpent),
                )}
              />
            ) : <span key={`empty-${index}`} aria-hidden className="h-2.5 w-2.5" />)}
          </div>
          <div className="relative mt-2 h-4 text-[10px] text-[var(--text-tertiary)]">
            {labels.map((month) => <span key={`${month.label}-${month.column}`} className="absolute whitespace-nowrap" style={{ left: month.column * 13 }}>{month.label}</span>)}
          </div>
        </div>
      </div>
      {tooltip ? createPortal(
        <div
          role="tooltip"
          data-credits-activity-tooltip
          className={cn(
            'pointer-events-none fixed z-[220] w-max max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-[10px] border border-white/10 bg-[#171a1f] px-3 py-2 text-left text-white shadow-[0_10px_30px_rgba(15,23,42,.22)]',
            tooltip.placement === 'top' && '-translate-y-full',
          )}
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <p className="text-[11px] font-medium">{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${tooltip.day.date}T00:00:00.000Z`))}</p>
          <p className="mt-1 text-[10px] text-white/70">消耗 {formatCreditAmount(tooltip.day.creditsSpent)} Credits · {tooltip.day.eventCount} 次计费</p>
        </div>
        , document.body) : null}
    </>
  )
}

function ProfilePanel() {
  const toast = useToast()
  const sessionUser = useShellStore((state) => state.sessionUser)
  const unreadMessageCount = useShellStore((state) => state.unreadMessageCount)
  const unreadNotificationCount = useShellStore((state) => state.unreadNotificationCount)
  const syncSessionUser = useShellStore((state) => state.syncSessionUser)
  const [nickname, setNickname] = useState(sessionUser?.nickname ?? '')
  const [bio, setBio] = useState(sessionUser?.bio ?? '')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const activityQuery = useQuery({
    queryKey: ['credits', 'activity'],
    queryFn: fetchCreditActivity,
    staleTime: 20_000,
    enabled: Boolean(sessionUser),
  })
  const referralQuery = useQuery({
    queryKey: ['credits', 'referral'],
    queryFn: fetchReferral,
    staleTime: 60_000,
    enabled: inviteOpen,
  })

  useEffect(() => {
    setNickname(sessionUser?.nickname ?? '')
    setBio(sessionUser?.bio ?? '')
  }, [sessionUser?.bio, sessionUser?.nickname])

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!nickname.trim()) {
      toast.error('请输入昵称。')
      return
    }
    setSaving(true)
    try {
      const payload = await requestJson<{ user: User }>('/api/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ nickname: nickname.trim(), bio: bio.trim() } satisfies UpdateMyProfileRequest),
      })
      syncSessionUser({ user: payload.user, unreadMessageCount, unreadNotificationCount })
      setEditing(false)
      toast.success('个人资料已保存')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法保存个人资料。')
    } finally {
      setSaving(false)
    }
  }

  if (!sessionUser) {
    return <p className="border-y border-[var(--border-subtle)] py-10 text-center text-sm text-[var(--text-tertiary)]">登录后可以维护作者资料。</p>
  }

  const activity = activityQuery.data
  const stats = activity?.stats
  const account = activity?.account
  const copyInviteLink = async () => {
    if (!referralQuery.data?.inviteUrl || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(referralQuery.data.inviteUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('复制失败，请在邀请窗口中手动复制。')
    }
  }

  return (
    <div className="pb-8">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <button type="button" onClick={() => setInviteOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-[9px] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"><Gift className="h-3.5 w-3.5" />邀请好友</button>
        <button type="button" onClick={() => window.open('/account/usage', '_blank', 'noopener,noreferrer')} className="inline-flex h-9 items-center gap-2 rounded-[9px] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"><Activity className="h-3.5 w-3.5" />用量明细</button>
        <button type="button" onClick={() => setEditing((value) => !value)} className="inline-flex h-9 items-center gap-2 rounded-[9px] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"><Pencil className="h-3.5 w-3.5" />{editing ? '收起编辑' : '编辑资料'}</button>
      </div>

      <div className="pb-8 pt-5 text-center sm:pt-7">
        <Avatar name={sessionUser.nickname} src={sessionUser.avatarUrl} size="lg" className="mx-auto h-20 w-20" />
        <h2 className="mt-4 text-xl font-semibold tracking-[-.02em]">{sessionUser.nickname}</h2>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{sessionUser.email || sessionUser.phone || 'Chevoink 创作者'}</p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)] px-3 py-1 text-[11px] text-[var(--text-secondary)]">
          {account?.planLabel ?? '公测版'}
          <span aria-hidden className="h-3 w-px bg-[var(--border-strong)]" />
          剩余 {account ? formatCreditAmount(account.totalRemaining) : '—'} Credits
        </p>
      </div>

      {editing ? (
        <section className="mb-8 rounded-[14px] border border-[var(--border-subtle)] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div><h3 className="text-sm font-semibold">公开资料</h3><p className="mt-1 text-xs text-[var(--text-tertiary)]">昵称与简介会用于个人主页及作品作者信息。</p></div>
            <button type="button" onClick={() => window.open('/settings', '_blank', 'noopener,noreferrer')} className="h-8 shrink-0 rounded-[8px] border border-[var(--border-subtle)] px-2.5 text-xs hover:bg-[var(--surface-muted)]">更换头像</button>
          </div>
          <form onSubmit={saveProfile} className="mt-5 space-y-4">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">昵称<input value={nickname} maxLength={30} onChange={(event) => setNickname(event.target.value)} className="mt-2 h-10 w-full rounded-[9px] border border-[var(--border-strong)] bg-transparent px-3 text-sm text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring)]" /></label>
            <label className="block text-xs font-medium text-[var(--text-secondary)]">个人简介<textarea value={bio} maxLength={200} rows={3} onChange={(event) => setBio(event.target.value)} placeholder="介绍你的创作方向与擅长题材" className="mt-2 w-full resize-y rounded-[9px] border border-[var(--border-strong)] bg-transparent px-3 py-2.5 text-sm leading-6 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring)]" /></label>
            <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button><Button type="submit" size="sm" disabled={saving}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}保存资料</Button></div>
          </form>
        </section>
      ) : null}

      {activityQuery.isLoading ? (
        <div className="space-y-8" aria-label="正在加载 Credits 活动">
          <div className="grid grid-cols-5 overflow-hidden rounded-[14px] border border-[var(--border-subtle)]">{Array.from({ length: 5 }, (_, index) => <div key={index} className="border-l border-[var(--border-subtle)] px-3 py-5 first:border-l-0"><span className="skeleton-shimmer mx-auto block h-5 w-16 rounded" /><span className="skeleton-shimmer mx-auto mt-2 block h-3 w-20 rounded" /></div>)}</div>
          <div className="skeleton-shimmer h-44 rounded-[14px]" />
        </div>
      ) : activityQuery.isError || !stats ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-[14px] border border-[var(--border-subtle)] px-6 text-center">
          <p className="text-sm text-[var(--text-secondary)]">暂时无法读取 Credits 活动。</p>
          <Button size="sm" className="mt-4" onClick={() => void activityQuery.refetch()}><RefreshCcw className="h-3.5 w-3.5" />重新加载</Button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-[14px] border border-[var(--border-subtle)]">
            <dl className="grid min-w-[680px] grid-cols-5 divide-x divide-[var(--border-subtle)]">
              {[
                ['累计消耗', formatCreditAmount(stats.cumulativeSpent), 'Credits'],
                ['峰值日消耗', formatCreditAmount(stats.peakDailySpent), 'Credits'],
                ['累计 Token', formatCompactCount(stats.totalTokens), '输入与输出'],
                ['当前连续', `${stats.currentStreakDays} 天`, '今日或昨日仍活跃'],
                ['最长连续', `${stats.longestStreakDays} 天`, 'Credits 使用记录'],
              ].map(([label, value, note]) => (
                <div key={label} className="px-3 py-4 text-center sm:py-5"><dt className="text-base font-semibold tabular-nums sm:text-lg">{value}</dt><dd className="mt-1 text-[11px] font-medium text-[var(--text-secondary)]">{label}</dd><p className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">{note}</p></div>
              ))}
            </dl>
          </div>

          <section className="mt-8 rounded-[14px] border border-[var(--border-subtle)] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-[var(--text-secondary)]" />Credits 活动</h3><p className="mt-1 text-[11px] text-[var(--text-tertiary)]">按 UTC+8 汇总过去一年真实计费记录；颜色越深，消耗越高。</p></div>
              <p className="text-[10px] text-[var(--text-tertiary)]">{stats.ledgerStartedAt ? `统计自 ${stats.ledgerStartedAt}` : '尚无 Credits 消耗'}</p>
            </div>
            <div className="mt-5"><CreditsActivityHeatmap activity={stats.activity} startedAt={stats.activityStartedAt} endsAt={stats.activityEndsAt} /></div>
            <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-[var(--text-tertiary)]"><span>少</span>{['bg-[#eceeed] dark:bg-white/[.06]', 'bg-[#d5e3de] dark:bg-[#24463a]', 'bg-[#a9c8bd] dark:bg-[#356451]', 'bg-[#719f8e] dark:bg-[#4c806c]', 'bg-[#386c59] dark:bg-[#72a590]'].map((color) => <span key={color} className={cn('h-2.5 w-2.5 rounded-[2px]', color)} />)}<span>多</span></div>
          </section>

          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <section><h3 className="text-sm font-semibold">活动洞察</h3><dl className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{[
              ['模型调用', stats.totalModelCalls.toLocaleString('zh-CN')],
              ['Agent 任务', stats.agentRuns.toLocaleString('zh-CN')],
              ['Credits 活跃天', `${stats.activeDays.toLocaleString('zh-CN')} 天`],
              ['累计获得', `+${formatCreditAmount(stats.cumulativeEarned)} Credits`],
              ['缓存命中率', stats.cacheHitRate === null ? '—' : `${stats.cacheHitRate}%`],
              ['作品数量', sessionUser.novelCount.toLocaleString('zh-CN')],
            ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 py-2.5 text-xs"><dt className="text-[var(--text-secondary)]">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl></section>
            <section><h3 className="text-sm font-semibold">常用模型</h3><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{stats.modelUsage.length > 0 ? stats.modelUsage.map((model) => <div key={model.label} className="py-2.5"><div className="flex items-center justify-between gap-4 text-xs"><span className="min-w-0 truncate font-medium">{model.label}</span><span className="shrink-0 text-[var(--text-secondary)]">{model.calls.toLocaleString('zh-CN')} 次</span></div><div className="mt-1.5 flex items-center justify-between gap-4 text-[10px] text-[var(--text-tertiary)]"><span>{formatCompactCount(model.tokens)} Token</span><span>{formatCreditAmount(model.creditsSpent)} Credits</span></div></div>) : <p className="py-8 text-center text-xs text-[var(--text-tertiary)]">尚无模型调用记录</p>}</div></section>
          </div>
        </>
      )}
      <InviteCreditsDialog open={inviteOpen} referral={referralQuery.data ?? null} copied={copied} onCopy={() => void copyInviteLink()} onClose={() => { setInviteOpen(false); setCopied(false) }} />
    </div>
  )
}

function AppearancePanel() {
  const theme = useShellStore((state) => state.theme)
  const setTheme = useShellStore((state) => state.setTheme)
  const appearance = useShellStore((state) => state.studioAppearance)
  const setAppearance = useShellStore((state) => state.setStudioAppearance)

  return (
    <div className="space-y-7">
      <SettingsGroup title="主题" description="浅色模式使用纯白工作区，不继承站点纸张底色。">
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            { value: 'light', label: '浅色', icon: Sun, canvas: 'bg-white', panel: 'bg-[#f0f1f3]' },
            { value: 'dark', label: '深色', icon: Moon, canvas: 'bg-[#15181e]', panel: 'bg-[#232730]' },
          ] as const).map((option) => {
            const active = theme === option.value
            return (
              <button key={option.value} type="button" onClick={() => setTheme(option.value)} className={cn('overflow-hidden rounded-[12px] border text-left transition-colors', active ? 'border-[var(--text-primary)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]')}>
                <span className={cn('grid h-28 grid-cols-[28%_1fr] border-b border-[var(--border-subtle)]', option.canvas)}>
                  <span className={cn('border-r border-black/10', option.panel)} />
                  <span className="space-y-2 p-4"><span className="block h-2 w-16 rounded-full bg-black/15" /><span className="block h-2 w-full rounded-full bg-black/10" /><span className="block h-2 w-2/3 rounded-full bg-black/10" /></span>
                </span>
                <span className="flex items-center gap-2 px-3 py-2.5 text-xs font-medium"><option.icon className="h-3.5 w-3.5" />{option.label}{active ? <Check className="ml-auto h-3.5 w-3.5" /> : null}</span>
              </button>
            )
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title="正文排版" description="只改变创作区编辑显示，不修改正文内容或导出格式。">
        <SettingsRow title="正文字体" description="选择更适合长时间写作的无衬线或宋体风格。">
          <div className="flex gap-2">
            <Choice value="sans" current={appearance.bodyFont} label="系统" onChange={(bodyFont: StudioBodyFont) => setAppearance({ bodyFont })} />
            <Choice value="serif" current={appearance.bodyFont} label="宋体" onChange={(bodyFont: StudioBodyFont) => setAppearance({ bodyFont })} />
          </div>
        </SettingsRow>
        <SettingsRow title="正文字号" description="桌面与移动创作区会使用同一偏好。">
          <div className="flex gap-2">{([15, 16, 18] as StudioFontSize[]).map((fontSize) => <Choice key={fontSize} value={fontSize} current={appearance.fontSize} label={`${fontSize}px`} onChange={(value: StudioFontSize) => setAppearance({ fontSize: value })} />)}</div>
        </SettingsRow>
        <SettingsRow title="行间距" description="宽松档适合长篇校阅，紧凑档可提高同屏信息量。">
          <div className="flex gap-2">{([1.65, 1.8, 2] as StudioLineHeight[]).map((lineHeight) => <Choice key={lineHeight} value={lineHeight} current={appearance.lineHeight} label={String(lineHeight)} onChange={(value: StudioLineHeight) => setAppearance({ lineHeight: value })} />)}</div>
        </SettingsRow>
        <SettingsRow title="编辑器宽度" description="限制正文行宽，减少超宽屏上的视线移动。">
          <div className="flex flex-wrap justify-end gap-2">{([720, 880, 1040] as StudioContentWidth[]).map((contentWidth) => <Choice key={contentWidth} value={contentWidth} current={appearance.contentWidth} label={contentWidth === 720 ? '专注' : contentWidth === 880 ? '均衡' : '宽屏'} onChange={(value: StudioContentWidth) => setAppearance({ contentWidth: value })} />)}</div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="辅助功能">
        <SettingsRow title="减少动态效果" description="关闭创作区过场、扫光与布局动画，降低视觉干扰。">
          <Toggle checked={appearance.reducedMotion} label="减少动态效果" onChange={(reducedMotion) => setAppearance({ reducedMotion })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="排版预览">
        <div className="border-y border-[var(--border-subtle)] py-5">
          <article className="mx-auto" style={{ maxWidth: Math.min(appearance.contentWidth, 720), fontFamily: 'var(--studio-body-font)', fontSize: appearance.fontSize, lineHeight: appearance.lineHeight }}>
            <p className="text-base font-semibold">第1章 初入江湖</p>
            <p className="mt-3 text-[var(--text-secondary)]">清晨的雾气还未散尽，青石板路上已经响起了脚步声。好的排版不会抢走内容的注意力，只会让作者更容易看清句子的节奏。</p>
          </article>
        </div>
      </SettingsGroup>
    </div>
  )
}

function WritingPanel(props: Props) {
  const [creativeFreedom, setCreativeFreedom] = useState<CreativeFreedom>('balanced')

  useEffect(() => {
    const saved = window.localStorage.getItem(`chevoink:creative-freedom:${props.novelId}`)
    setCreativeFreedom(saved === 'stable' || saved === 'bold' ? saved : 'balanced')
  }, [props.novelId])

  function updateFreedom(value: CreativeFreedom) {
    setCreativeFreedom(value)
    window.localStorage.setItem(`chevoink:creative-freedom:${props.novelId}`, value)
    window.dispatchEvent(new CustomEvent('chevoink:creative-freedom-change', { detail: { novelId: props.novelId, value } }))
  }

  return (
    <div className="space-y-7">
      <SettingsGroup title="当前作品的创作自由度" description="该选择会用于之后发起的 Agent 任务，不会重写既有内容。">
        <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {FREEDOM_OPTIONS.map((option) => (
            <button key={option.value} type="button" onClick={() => updateFreedom(option.value)} className="flex w-full items-center gap-4 py-4 text-left">
              <span className={cn('h-4 w-4 shrink-0 rounded-full border', creativeFreedom === option.value ? 'border-[5px] border-[var(--text-primary)]' : 'border-[var(--border-strong)]')} />
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{option.label}</span><span className="mt-1 block text-xs leading-5 text-[var(--text-tertiary)]">{option.description}</span></span>
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="正文协作">
        <SettingsRow title="正文自动追踪" description="Agent 写作、修订或打开章节时自动跟随到对应正文。">
          <Toggle checked={props.autoFollow} label="正文自动追踪" onChange={props.onAutoFollowChange} />
        </SettingsRow>
        <SettingsRow title="当前工作模式" description="切换后立即回到对应创作界面。">
          <div className="flex gap-2">
            <Choice value="work" current={props.perspective} label="Work" onChange={props.onPerspectiveChange} />
            <Choice value="ide" current={props.perspective} label="IDE" onChange={props.onPerspectiveChange} />
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="质量与评测" description="连续性检查、人类感质量门和真实运行对比均由 Agent 操作中心执行。">
        <button type="button" onClick={() => props.onSectionChange('operations')} className="flex w-full items-center gap-3 border-y border-[var(--border-subtle)] py-4 text-left">
          <Gauge className="h-4 w-4 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">打开 Agent 评测与运行管理</span><span className="mt-1 block text-xs text-[var(--text-tertiary)]">查看版本、权限、子 Agent、定时任务和评测结果</span></span>
          <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
        </button>
      </SettingsGroup>
    </div>
  )
}

function ArchivesPanel({ novels }: { novels: Novel[] }) {
  const queryClient = useQueryClient()
  const tasksQuery = useQuery({
    queryKey: ['agent', 'sessions', 'archives'],
    queryFn: () => fetchAgentSessions(undefined, { includeArchived: true }),
    staleTime: 10_000,
  })
  const archivedNovels = novels.filter((novel) => novel.status === 'archived')
  const archivedTasks = (tasksQuery.data?.items ?? []).filter((task) => task.status === 'archived')

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] }),
      queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] }),
    ])
  }

  const empty = (label: string) => <p className="py-10 text-center text-xs text-[var(--text-tertiary)]">{label}</p>

  return (
    <div className="space-y-8">
      <SettingsGroup title="已归档作品" description="恢复后会重新出现在创作区项目列表。">
        <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {archivedNovels.map((novel) => (
            <div key={novel.id} className="flex items-center gap-3 py-3.5">
              <BookOpenText className="h-4 w-4 text-[var(--text-secondary)]" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{novel.displayTitle?.trim() || novel.title || '未命名作品'}</p><p className="mt-1 text-xs text-[var(--text-tertiary)]">{novel.chapterCount} 章</p></div>
              <button type="button" onClick={() => void updateNovelMeta(novel.id, { status: 'draft' }).then(refresh)} className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] px-2.5 text-xs hover:bg-[var(--surface-muted)]"><RotateCcw className="h-3.5 w-3.5" />恢复</button>
            </div>
          ))}
          {archivedNovels.length === 0 ? empty('没有已归档作品') : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title="已归档任务" description="恢复任务不会改变所属作品或历史消息。">
        <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {archivedTasks.map((task) => (
            <div key={task.id} className="flex items-center gap-3 py-3.5">
              <Bot className="h-4 w-4 text-[var(--text-secondary)]" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{task.title}</p><p className="mt-1 truncate text-xs text-[var(--text-tertiary)]">{task.novelTitle ?? '所属作品'}</p></div>
              <button type="button" onClick={() => void updateAgentSessionSettings(task.id, { status: 'active' }).then(refresh)} className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] px-2.5 text-xs hover:bg-[var(--surface-muted)]"><RotateCcw className="h-3.5 w-3.5" />恢复</button>
            </div>
          ))}
          {archivedTasks.length === 0 ? empty('没有已归档任务') : null}
        </div>
      </SettingsGroup>
    </div>
  )
}

export default function StudioSettingsDialog(props: Props) {
  const { onClose, open } = props
  const [query, setQuery] = useState('')
  const meta = SECTION_META[props.section]
  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return NAV_GROUPS
    return NAV_GROUPS
      .map((group) => ({ ...group, items: group.items.filter((item) => `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(needle)) }))
      .filter((group) => group.items.length > 0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, open])

  if (!open) return null

  const navButton = (item: NavItem, mobile = false) => {
    const Icon = item.icon
    const active = props.section === item.id
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => props.onSectionChange(item.id)}
        className={cn(
          mobile
            ? 'inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-3 text-xs'
            : 'flex min-h-11 w-full items-center gap-3 rounded-[9px] px-3 py-2 text-left',
          active
            ? 'bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        <span className="min-w-0"><span className="block truncate text-sm">{item.label}</span>{!mobile ? <span className="mt-0.5 block truncate text-[10px] font-normal text-[var(--text-tertiary)]">{item.description}</span> : null}</span>
      </button>
    )
  }

  return createPortal(
    <section aria-label="创作区设置" className="studio-settings-page studio-workspace fixed inset-0 z-[200] flex h-dvh w-screen overflow-hidden bg-[var(--surface-default)] text-[var(--text-primary)]">
      <aside className="hidden h-full w-[264px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 pb-4 pt-[max(16px,var(--safe-top))] lg:flex">
        <button type="button" onClick={props.onClose} className="mb-4 flex h-10 items-center gap-2 rounded-[9px] px-2 text-sm font-medium hover:bg-[var(--surface-muted)]"><ArrowLeft className="h-4 w-4" />返回创作区</button>
        <label className="relative mb-5 block"><Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--text-tertiary)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置…" className="h-9 w-full rounded-[9px] border border-[var(--border-subtle)] bg-[var(--surface-default)] pl-9 pr-3 text-xs outline-none focus:border-[var(--border-strong)]" /></label>
        <nav className="scrollbar-none min-h-0 flex-1 space-y-5 overflow-y-auto" aria-label="设置导航">
          {filteredGroups.map((group) => <div key={group.label}><p className="mb-1.5 px-3 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">{group.label}</p><div className="space-y-0.5">{group.items.map((item) => navButton(item))}</div></div>)}
          {filteredGroups.length === 0 ? <p className="px-3 py-8 text-center text-xs text-[var(--text-tertiary)]">没有匹配的设置</p> : null}
        </nav>
        <div className="mt-4 flex items-center gap-2 border-t border-[var(--border-subtle)] px-2 pt-4 text-xs text-[var(--text-tertiary)]"><img src="/chevoink-agent.png" alt="" className="h-4 w-4 object-contain" />Chevoink Agent 3.0</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-[var(--surface-default)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 pb-3 pt-[max(12px,var(--safe-top))] lg:hidden">
          <button type="button" onClick={props.onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] hover:bg-[var(--surface-muted)]" aria-label="返回创作区"><ArrowLeft className="h-4 w-4" /></button>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">创作区设置</p><p className="truncate text-[10px] text-[var(--text-tertiary)]">{meta.title}</p></div>
        </header>
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-3 py-2 lg:hidden" aria-label="设置导航">{NAV_GROUPS.flatMap((group) => group.items).map((item) => navButton(item, true))}</nav>

        <header className="hidden h-[88px] shrink-0 items-start border-b border-[var(--border-subtle)] px-10 py-5 lg:flex">
          <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold tracking-tight">{meta.title}</h1><p className="mt-1 text-xs text-[var(--text-tertiary)]">{meta.description}</p></div>
        </header>

        <main className={cn('scrollbar-none min-h-0 flex-1 overflow-y-auto', props.section === 'operations' ? 'p-0' : 'px-5 py-7 sm:px-8 lg:px-10 lg:py-9')}>
          {props.section === 'operations' ? (
            <AgentOperationsCenter embedded open onClose={props.onClose} novelId={props.novelId} sessionId={props.sessionId} chapterId={props.chapterId} runIds={props.runIds ?? []} onSelectSession={props.onSelectSession} onTaskForked={props.onTaskForked} onTaskArchived={props.onTaskArchived} />
          ) : (
            <div className="mx-auto w-full max-w-[920px]">
              {props.section === 'general' ? <GeneralPanel {...props} /> : null}
              {props.section === 'profile' ? <ProfilePanel /> : null}
              {props.section === 'appearance' ? <AppearancePanel /> : null}
              {props.section === 'models' ? <CustomModelSettingsContent active /> : null}
              {props.section === 'writing' ? <WritingPanel {...props} /> : null}
              {props.section === 'archives' ? <ArchivesPanel novels={props.novels} /> : null}
            </div>
          )}
        </main>
      </div>
    </section>,
    document.body,
  )
}
