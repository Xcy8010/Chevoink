import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Archive, ArrowLeft, AudioLines, ChevronDown, CircleUserRound, Cpu, Eye, FileText, Gauge, Search, Settings, Workflow, type LucideProps } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { AgentSession, Novel } from '../../../../shared/contracts/index.js'
import { loadStudioSurface } from './load-studio-surface'
import { StudioPresence } from './StudioPresence'
import StudioPersonalizationIcon from './StudioPersonalizationIcon'
import './studio-settings.css'

export type StudioSettingsSection =
  | 'general'
  | 'profile'
  | 'usage'
  | 'personalization'
  | 'appearance'
  | 'models'
  | 'model-assignments'
  | 'writing'
  | 'operations'
  | 'archives'
  | 'language-packs'

export type StudioSettingsProps = {
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
  icon: ComponentType<LucideProps>
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '个人',
    items: [
      { id: 'general', label: '通用', keywords: '工作区 基础行为 模式 自动追踪 全屏 账号安全 登录设备 设备管理', icon: Settings },
      { id: 'profile', label: '个人资料', keywords: '头像 昵称 简介 作者身份 公开信息 账号', icon: CircleUserRound },
      { id: 'usage', label: '使用情况', keywords: '额度 Credits 余额 用量 奖励 消耗 账单 流水 重置', icon: Gauge },
      { id: 'personalization', label: '个性化', keywords: '自定义指令 回答偏好 风格 语气 全局记忆 权限 自定义规则 Agent', icon: StudioPersonalizationIcon },
      { id: 'appearance', label: '外观', keywords: '主题 浅色 深色 正文 排版 字体 字号 行距 宽度 动画', icon: Eye },
      { id: 'models', label: '模型', keywords: '自定义模型 密钥 API Key DeepSeek GLM 推理', icon: Cpu },
      { id: 'model-assignments', label: '模型分工', keywords: '模型 分工 推理 全局 作品 检查 写作 子Agent', icon: Workflow },
      { id: 'language-packs', label: '语言包', keywords: '语音 本机 下载 删除 语言包', icon: AudioLines },
    ],
  },
  {
    label: '创作与协作',
    items: [
      { id: 'writing', label: '写作偏好', keywords: '写作 自由度 编辑 严谨 平衡 大胆 正文 Agent', icon: FileText },
      { id: 'operations', label: 'Agent 操作', keywords: '任务 分支 子Agent 定时 权限 评测', icon: Workflow },
      { id: 'archives', label: '归档', keywords: '归档 恢复 作品 历史 任务', icon: Archive },
    ],
  },
]

const NAV_ITEMS = NAV_GROUPS.flatMap(group => group.items)

const SettingsPanels = loadStudioSurface(() => import('./StudioSettingsPanels'), '设置内容')

export default function StudioSettingsDialog(props: StudioSettingsProps) {
  const { onClose, open } = props
  const [query, setQuery] = useState('')
  const mobileSettingsNav = useRef<HTMLDetailsElement>(null)
  const sectionHeading = useRef<HTMLHeadingElement>(null)
  const title = NAV_ITEMS.find(item => item.id === props.section)?.label
  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return NAV_GROUPS
    return NAV_GROUPS
      .map((group) => ({ ...group, items: group.items.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(needle)) }))
      .filter((group) => group.items.length > 0)
  }, [query])

  useLayoutEffect(() => {
    if (open) sectionHeading.current?.focus({ preventScroll: true })
  }, [open, props.section])

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

  if (typeof document === 'undefined') return null

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
    <StudioPresence kind="fade">{open && (
    <section aria-label="创作区设置" className="studio-settings-page studio-workspace studio-settings-style fixed inset-0 z-[200] flex h-dvh w-screen overflow-hidden">
      <aside className="studio-settings-sidebar h-full shrink-0 flex-col" aria-label="设置侧栏">
        <div className="studio-settings-sidebar-header">
          <h2 className="studio-settings-sidebar-title">设置</h2>
          <button type="button" onClick={onClose} className="studio-settings-back" aria-label="返回创作区" title="返回创作区"><ArrowLeft size={16} aria-hidden="true" /></button>
        </div>
        {settingsSearch}
        <nav className="scrollbar-none min-h-0 flex-1 overflow-y-auto" aria-label="设置导航">
          {settingsNavigation}
        </nav>
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
            <h1 ref={sectionHeading} tabIndex={-1} className="outline-none">{title}</h1>
            <SettingsPanels {...props} />
          </div>
        </main>
      </div>
    </section>
    )}</StudioPresence>,
    document.body,
  )
}
