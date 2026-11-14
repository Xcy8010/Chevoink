import { CREATIVE_FREEDOM_DESCRIPTIONS, CREATIVE_FREEDOM_LABELS } from '../../../../shared/contracts/agent-window-configuration.js'
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
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Gauge,
  Gift,
  LoaderCircle,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { createPortal } from 'react-dom'

import { ApiClientError, requestJson } from '@/app/api-client'
import { useAgentWindowConfiguration } from '../agent/useAgentWindowConfiguration'
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
import type { ThemeMode } from '@/types/app'
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
import VoicePackSettings from './VoicePackSettings'
import ModelAssignmentsSettings from './ModelAssignmentsSettings'
import PersonalizationSettings from './PersonalizationSettings'
import './studio-settings.css'

export type StudioSettingsSection =
  | 'general'
  | 'profile'
  | 'personalization'
  | 'appearance'
  | 'models'
  | 'model-assignments'
  | 'writing'
  | 'operations'
  | 'archives'
  | 'language-packs'

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
  taskTitle?: string | null
  draftScopeKey?: string
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
  keywords: string
  icon: LucideIcon
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '个人',
    items: [
      { id: 'general', label: '通用', keywords: '工作区 基础行为 模式 自动追踪 全屏', icon: Settings2 },
      { id: 'profile', label: '个人资料', keywords: '头像 昵称 简介 作者身份 公开信息 账号', icon: UserRound },
      { id: 'personalization', label: '个性化', keywords: '自定义指令 回答偏好 风格 语气 全局记忆 权限 自定义规则 Agent', icon: SlidersHorizontal },
      { id: 'appearance', label: '外观', keywords: '主题 浅色 深色 正文 排版 字体 字号 行距 宽度 动画', icon: Eye },
      { id: 'models', label: '模型', keywords: '自定义模型 密钥 API Key DeepSeek GLM 推理', icon: BrainCircuit },
      { id: 'model-assignments', label: '模型分工', keywords: '模型 分工 推理 全局 作品 检查 写作 子Agent', icon: BrainCircuit },
      { id: 'language-packs', label: '语言包', keywords: '语音 本机 下载 删除 语言包', icon: Activity },
    ],
  },
  {
    label: '创作与协作',
    items: [
      { id: 'writing', label: '写作偏好', keywords: '写作 自由度 编辑 严谨 平衡 大胆 正文 Agent', icon: FileText },
      { id: 'operations', label: 'Agent 操作', keywords: '任务 分支 子Agent 定时 权限 评测', icon: Bot },
      { id: 'archives', label: '归档', keywords: '归档 恢复 作品 历史 任务', icon: Archive },
    ],
  },
]

const NAV_ITEMS = NAV_GROUPS.flatMap(group => group.items)

const FREEDOM_OPTIONS = [
  { value: 'stable', label: CREATIVE_FREEDOM_LABELS.stable },
  { value: 'balanced', label: CREATIVE_FREEDOM_LABELS.balanced },
  { value: 'bold', label: CREATIVE_FREEDOM_LABELS.bold },
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
      className="studio-settings-toggle"
    >
      <span aria-hidden="true" />
    </button>
  )
}

function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="studio-settings-group">
      <h2>{title}</h2>
      {description ? <p className="-mt-1 mb-3 text-xs text-[var(--text-secondary)]">{description}</p> : null}
      <div className="studio-settings-card">{children}</div>
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
    <div className="studio-settings-row spacious">
      <div className="studio-settings-row-copy">
        <span className="studio-settings-row-title">{title}</span>
        <p>{description}</p>
      </div>
      {value ? <span className="shrink-0 text-xs text-[var(--text-secondary)]">{value}</span> : null}
      {children}
    </div>
  )
}

function GeneralPanel(props: Props) {
  const fullscreenEnabled = useShellStore((state) => state.fullscreenEnabled)
  const setFullscreenEnabled = useShellStore((state) => state.setFullscreenEnabled)
  const currentNovel = props.novels.find((novel) => novel.id === props.novelId)

  return (
    <div className="studio-settings-groups">
      <SettingsGroup title="工作区">
        <SettingsRow title="工作模式" description="Work 适合与 Agent 协作；IDE 适合集中编辑结构与正文。">
          <select aria-label="工作模式" value={props.perspective} onChange={event => props.onPerspectiveChange(event.target.value as Props['perspective'])}>
            <option value="work">Work</option>
            <option value="ide">IDE</option>
          </select>
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

      <SettingsGroup title="当前作品">
          <SettingsRow
            title={currentNovel?.displayTitle?.trim() || currentNovel?.title || '未命名作品'}
            description={`${currentNovel?.chapterCount ?? 0} 章 · ${props.chapterId ? '已打开章节' : '尚未打开章节'}`}
            value={props.perspective === 'work' ? 'Work 工作区' : 'IDE 写作台'}
          />
          {props.onOpenImportHistory ? (
            <button type="button" onClick={props.onOpenImportHistory} className="studio-settings-row studio-settings-row-link spacious">
              <RotateCcw className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">导入记录与恢复</span>
                <span className="mt-1 block text-xs text-[var(--text-tertiary)]">查看当前作品的导入任务、完整性报告与可恢复回执</span>
              </span>
              <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
            </button>
          ) : null}
      </SettingsGroup>

      <SettingsGroup title="账户与数据">
        <button type="button" onClick={() => window.open('/settings', '_blank', 'noopener,noreferrer')} className="studio-settings-row studio-settings-row-link spacious">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">账户安全与隐私</span>
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">密码、手机号、隐私范围和客户端设置</span>
          </span>
          <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
        </button>
        <div className="flex flex-wrap gap-x-5 gap-y-2 py-3 text-sm text-[var(--text-secondary)]">
          <a href="/legal?kind=terms" target="_blank" rel="noopener noreferrer" className="rounded-sm underline-offset-4 hover:underline">用户协议</a>
          <a href="/legal?kind=privacy" target="_blank" rel="noopener noreferrer" className="rounded-sm underline-offset-4 hover:underline">隐私政策</a>
        </div>
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

      <div className="studio-settings-card my-4 py-5 text-center">
        <Avatar name={sessionUser.nickname} src={sessionUser.avatarUrl} size="lg" className="mx-auto h-20 w-20" />
        <h2 className="mt-4 text-xl font-semibold tracking-[-.02em]">{sessionUser.nickname}</h2>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{sessionUser.email || sessionUser.phone || 'Chevoink 创作者'}</p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)] px-3 py-1 text-[11px] text-[var(--text-secondary)]">
          {account?.planLabel ?? '—'}
          <span aria-hidden className="h-3 w-px bg-[var(--border-strong)]" />
          剩余 {account ? formatCreditAmount(account.totalRemaining) : '—'} Credits
        </p>
      </div>

      {editing ? (
        <section className="studio-settings-card mb-8 py-5">
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
          <div className="studio-settings-card studio-settings-table">
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

          <section className="studio-settings-card mt-8 py-5">
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
    <div className="studio-settings-groups">
      <SettingsGroup title="主题">
        <div className="studio-settings-row">
          <label htmlFor="studio-settings-theme">颜色模式</label>
          <select id="studio-settings-theme" value={theme} onChange={event => setTheme(event.target.value as ThemeMode)}>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
      </SettingsGroup>

      <SettingsGroup title="正文排版">
        <div className="studio-settings-row">
          <label htmlFor="studio-settings-font">正文字体</label>
          <select id="studio-settings-font" value={appearance.bodyFont} onChange={event => setAppearance({ bodyFont: event.target.value as StudioBodyFont })}>
            <option value="sans">系统</option>
            <option value="serif">宋体</option>
          </select>
        </div>
        <div className="studio-settings-row">
          <label htmlFor="studio-settings-font-size">正文字号</label>
          <select id="studio-settings-font-size" value={appearance.fontSize} onChange={event => setAppearance({ fontSize: Number(event.target.value) as StudioFontSize })}>
            {[15, 16, 18].map(size => <option key={size} value={size}>{size}px</option>)}
          </select>
        </div>
        <div className="studio-settings-row">
          <label htmlFor="studio-settings-line-height">行间距</label>
          <select id="studio-settings-line-height" value={appearance.lineHeight} onChange={event => setAppearance({ lineHeight: Number(event.target.value) as StudioLineHeight })}>
            {[1.65, 1.8, 2].map(height => <option key={height} value={height}>{height}</option>)}
          </select>
        </div>
        <div className="studio-settings-row">
          <label htmlFor="studio-settings-editor-width">编辑器宽度</label>
          <select id="studio-settings-editor-width" value={appearance.contentWidth} onChange={event => setAppearance({ contentWidth: Number(event.target.value) as StudioContentWidth })}>
            <option value={720}>专注</option>
            <option value={880}>均衡</option>
            <option value={1040}>宽屏</option>
          </select>
        </div>
      </SettingsGroup>

      <SettingsGroup title="辅助功能">
        <SettingsRow title="减少动态效果" description="关闭创作区过场、扫光与布局动画，降低视觉干扰。">
          <Toggle checked={appearance.reducedMotion} label="减少动态效果" onChange={(reducedMotion) => setAppearance({ reducedMotion })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="排版预览">
        <div className="py-5">
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
  const preferences = useAgentWindowConfiguration(props.novelId, props.sessionId, props.draftScopeKey)
  const creativeFreedom = preferences.configuration.creativeFreedom

  function updateFreedom(value: CreativeFreedom) {
    void preferences.update({ creativeFreedom: value }).catch(() => {})
  }

  return (
    <div className="studio-settings-groups">
      <SettingsGroup title={`当前窗口的创作模式（${preferences.title || props.taskTitle || '新任务'}）`}>
        {preferences.error ? <p role="alert" className="py-2 text-xs text-rose-500">{preferences.error}</p> : null}
        <div className="studio-settings-row spacious">
          <div className="studio-settings-row-copy">
            <label htmlFor="studio-settings-creation-mode">创作模式</label>
            <p>{CREATIVE_FREEDOM_DESCRIPTIONS[creativeFreedom]}</p>
          </div>
          <select id="studio-settings-creation-mode" value={creativeFreedom} disabled={preferences.loading} onChange={event => updateFreedom(event.target.value as CreativeFreedom)}>
            {FREEDOM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </SettingsGroup>

      <SettingsGroup title="正文协作">
        <SettingsRow title="正文自动追踪" description="Agent 写作、修订或打开章节时自动跟随到对应正文。">
          <Toggle checked={props.autoFollow} label="正文自动追踪" onChange={props.onAutoFollowChange} />
        </SettingsRow>
        <SettingsRow title="当前工作模式" description="切换后立即回到对应创作界面。">
          <select aria-label="当前工作模式" value={props.perspective} onChange={event => props.onPerspectiveChange(event.target.value as Props['perspective'])}>
            <option value="work">Work</option>
            <option value="ide">IDE</option>
          </select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="质量与评测" description="连续性检查、人类感质量门和真实运行对比均由 Agent 操作中心执行。">
        <button type="button" onClick={() => props.onSectionChange('operations')} className="studio-settings-row studio-settings-row-link spacious">
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
    void queryClient.invalidateQueries({ queryKey: ['community', 'me'], refetchType: 'none' })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] }),
      queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] }),
    ])
  }

  const empty = (label: string) => <p className="py-10 text-center text-xs text-[var(--text-tertiary)]">{label}</p>

  return (
    <div className="studio-settings-groups">
      <SettingsGroup title="已归档作品" description="恢复后会重新出现在创作区项目列表。">
        <div className="divide-y divide-[var(--border-subtle)]">
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
        <div className="divide-y divide-[var(--border-subtle)]">
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
  const currentNovel = props.novels.find((novel) => novel.id === props.novelId)
  const { onClose, open } = props
  const [query, setQuery] = useState('')
  const mobileSettingsNav = useRef<HTMLDetailsElement>(null)
  const title = NAV_ITEMS.find(item => item.id === props.section)?.label
  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return NAV_GROUPS
    return NAV_GROUPS
      .map((group) => ({ ...group, items: group.items.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(needle)) }))
      .filter((group) => group.items.length > 0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, open])

  if (!open) return null

  const navButton = (item: NavItem) => {
    const Icon = item.icon
    return (
      <button key={item.id} type="button" className="studio-settings-nav-item" aria-current={props.section === item.id ? 'page' : undefined}
        onClick={() => {
          if (mobileSettingsNav.current) mobileSettingsNav.current.open = false
          props.onSectionChange(item.id)
        }}>
        <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
        {item.label}
      </button>
    )
  }
  const settingsSearch = (
    <label className="studio-settings-search">
      <Search size={14} aria-hidden="true" />
      <input aria-label="搜索设置" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索设置…" />
    </label>
  )
  const settingsNavigation = <>
    {filteredGroups.map(group => <div key={group.label} className="studio-settings-nav-group">
      <p>{group.label}</p>
      {group.items.map(navButton)}
    </div>)}
    {filteredGroups.length === 0 ? <p className="studio-settings-empty">没有匹配的设置</p> : null}
  </>

  return createPortal(
    <section aria-label="创作区设置" className="studio-settings-page studio-workspace studio-settings-style fixed inset-0 z-[200] flex h-dvh w-screen overflow-hidden">
      <aside className="studio-settings-sidebar h-full shrink-0 flex-col" aria-label="设置侧栏">
        <div className="studio-settings-brand">chevoink<span>创作区</span></div>
        <h2 className="studio-settings-sidebar-title">设置</h2>
        {settingsSearch}
        <nav className="scrollbar-none min-h-0 flex-1 overflow-y-auto" aria-label="设置导航">
          {settingsNavigation}
        </nav>
        <div className="studio-settings-sidebar-footer">
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5"><ArrowLeft size={13} aria-hidden="true" />返回创作区</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="studio-settings-mobile-bar">
          <button type="button" onClick={onClose} aria-label="返回创作区"><ArrowLeft size={16} aria-hidden="true" /></button>
          <details ref={mobileSettingsNav}>
            <summary>创作区 / 设置 <ChevronDown size={12} aria-hidden="true" /></summary>
            <nav className="studio-settings-mobile-nav" aria-label="设置导航">
              {settingsSearch}
              {settingsNavigation}
            </nav>
          </details>
        </header>

        <main key={props.section} className="scrollbar-none min-h-0 flex-1 overflow-y-auto">
          <div className="studio-settings-main">
            <h1>{title}</h1>
            {props.section === 'general' ? <GeneralPanel {...props} /> : null}
            {props.section === 'profile' ? <ProfilePanel /> : null}
            {props.section === 'personalization' ? <PersonalizationSettings /> : null}
            {props.section === 'appearance' ? <AppearancePanel /> : null}
            {props.section === 'models' ? <div className="studio-settings-card py-5"><CustomModelSettingsContent active /></div> : null}
            {props.section === 'model-assignments' ? <ModelAssignmentsSettings novelId={props.novelId} novelTitle={currentNovel?.displayTitle?.trim() || currentNovel?.title?.trim() || '未命名作品'} /> : null}
            {props.section === 'language-packs' ? <div className="studio-settings-card py-5"><VoicePackSettings /></div> : null}
            {props.section === 'writing' ? <WritingPanel {...props} /> : null}
            {props.section === 'operations' ? <AgentOperationsCenter embedded open onClose={onClose} novelId={props.novelId} sessionId={props.sessionId} chapterId={props.chapterId} runIds={props.runIds ?? []} onSelectSession={props.onSelectSession} onTaskForked={props.onTaskForked} onTaskArchived={props.onTaskArchived} /> : null}
            {props.section === 'archives' ? <ArchivesPanel novels={props.novels} /> : null}
          </div>
        </main>
      </div>
    </section>,
    document.body,
  )
}
