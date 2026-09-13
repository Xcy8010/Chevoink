import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, BookOpenText, Bug, Crosshair, ExternalLink, FilePlus2, Flag, FolderDown, FolderPlus, Home, ImagePlus, Lightbulb, NotebookPen, PanelLeftClose, PanelLeftOpen, PenLine, RotateCcw, Settings2, Trash2, Upload } from 'lucide-react'
import { Link } from 'react-router-dom'

import FeedbackDialog from '@/features/feedback/components/FeedbackDialog'
import { cn } from '@/lib/utils'
import type { FeedbackKind, Novel } from '../../../../shared/contracts/index.js'
import StudioMoreMenu, { type StudioSettingsSection } from './StudioMoreMenu'
import WorkspaceNovelSwitcher from './WorkspaceNovelSwitcher'
import { useAgentStore } from '../agent/agentStore'

type Props = {
  workspaceSidebarOpen?: boolean
  onWorkspaceSidebarToggle?: () => void
  workspaceControls?: boolean
  perspective: 'work' | 'ide'
  perspectiveSwitchEnabled: boolean
  onPerspectiveChange: (value: 'work' | 'ide') => void
  currentNovelId: string
  novelTitle: string
  novelOptions: Novel[]
  novelsLoading?: boolean
  switchingNovel?: boolean
  onSelectNovel: (novelId: string) => void
  onCreateNovel: () => void
  onPublish: () => void
  onOpenCover: () => void
  onOpenMeta: () => void
  onExport: () => void
  /** 入口始终展示；服务端开关关闭时由导入弹窗给出未开放提示，不在菜单层隐藏 */
  onImport: () => void
  onDeleteNovel: () => void
  /** 顶部「作品」菜单的结构操作 */
  onCreateVolume?: () => void
  onCreateChapter?: () => void
  onCreatePlan?: () => void
  previewHref?: string
  detailPreviewHref?: string
  published?: boolean
  /** 作品状态：驱动「完结作品/继续连载」按钮文案与图标 */
  novelStatus?: Novel['status']
  /** 完结 ↔ 继续连载切换（确认弹窗由宿主处理） */
  onToggleNovelCompletion?: () => void
  /** IDE 视图没有 Work 侧栏的账户菜单，创作区设置由顶栏「…」菜单打开 */
  onOpenStudioSettings?: (section?: StudioSettingsSection) => void
}

type StudioMenuKey = 'novel' | 'view' | 'design' | 'publish' | 'export' | 'help'

/** 参考 Codex 顶栏：菜单名最多两个字，点击展开操作卡片。任务「更多」按钮归 Agent 面板顶栏，不在此列 */
const STUDIO_MENUS: { key: StudioMenuKey; label: string }[] = [
  { key: 'novel', label: '作品' },
  { key: 'view', label: '查看' },
  { key: 'design', label: '设计' },
  { key: 'publish', label: '发布' },
  { key: 'export', label: '导出' },
  { key: 'help', label: '帮助' },
]

const dropdownClass = 'absolute left-0 top-[calc(100%+7px)] z-50 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1 shadow-[0_18px_50px_rgba(15,23,42,.18)] motion-safe:origin-top-left motion-safe:animate-[agent-menu-in_150ms_cubic-bezier(.2,.8,.2,1)]'

export default function StudioCommandBar(props: Props) {
  const autoFollow = useAgentStore((state) => state.autoFollow)
  const setAutoFollow = useAgentStore((state) => state.setAutoFollow)
  const [openMenu, setOpenMenu] = useState<StudioMenuKey | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!openMenu) return
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [openMenu])
  const item = 'flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]'
  const toggleMenu = (key: StudioMenuKey) => setOpenMenu((current) => (current === key ? null : key))
  const closeMenu = () => setOpenMenu(null)
  const triggerClass = (active: boolean) => cn('inline-flex h-8 items-center justify-center rounded-[8px] px-2 text-xs transition-colors', active ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]')
  const renderDropdown = (key: StudioMenuKey, widthClass: string, children: ReactNode) => (
    openMenu === key ? <div className={cn(dropdownClass, widthClass)}>{children}</div> : null
  )
  const publishLabel = props.published ? '更新发布' : '发布'
  const novelCompleted = props.novelStatus === 'completed'
  const completionLabel = novelCompleted ? '继续连载' : '完结作品'
  const completionButton = props.onToggleNovelCompletion && props.novelStatus ? (
    <button type="button" className={item} onClick={() => { closeMenu(); props.onToggleNovelCompletion?.() }}>
      {novelCompleted ? <RotateCcw className="h-3.5 w-3.5" /> : <Flag className="h-3.5 w-3.5" />}
      {completionLabel}
    </button>
  ) : null

  function renderStudioMenuBody(key: StudioMenuKey) {
    switch (key) {
      case 'novel':
        return <>
          {props.onCreateVolume ? <button type="button" className={item} onClick={() => { closeMenu(); props.onCreateVolume?.() }}><FolderPlus className="h-3.5 w-3.5" />新建卷</button> : null}
          <button type="button" className={item} onClick={() => { closeMenu(); props.onCreateChapter?.() }}><FilePlus2 className="h-3.5 w-3.5" />新建章</button>
          <button type="button" className={item} onClick={() => { closeMenu(); props.onCreatePlan?.() }}><NotebookPen className="h-3.5 w-3.5" />新建计划</button>
          <div className="mx-2 my-1 border-t border-[var(--border-subtle)]" />
          <button type="button" className={item} onClick={() => { closeMenu(); props.onOpenMeta() }}><Settings2 className="h-3.5 w-3.5" />作品设置</button>
          <button type="button" className={item} onClick={() => { closeMenu(); props.onPublish() }}><Upload className="h-3.5 w-3.5" />{publishLabel}</button>
          {completionButton}
          <button type="button" className={cn(item, 'min-h-11')} onClick={() => { menuRef.current?.querySelector<HTMLElement>('button[aria-expanded="true"]')?.focus(); closeMenu(); props.onImport() }}><Upload className="h-3.5 w-3.5" />一键导入</button>
          <button type="button" className={item} onClick={() => { closeMenu(); props.onExport() }}><FolderDown className="h-3.5 w-3.5" />一键导出</button>
          <div className="mx-2 my-1 border-t border-[var(--border-subtle)]" />
          <button type="button" className={cn(item, 'text-rose-600')} onClick={() => { closeMenu(); props.onDeleteNovel() }}><Trash2 className="h-3.5 w-3.5" />删除作品</button>
        </>
      case 'view':
        return <>
          {props.detailPreviewHref ? <Link to={props.detailPreviewHref} className={item} onClick={closeMenu}><ExternalLink className="h-3.5 w-3.5" />查看作品页</Link> : null}
          {props.previewHref ? <Link to={props.previewHref} className={item} onClick={closeMenu}><BookOpenText className="h-3.5 w-3.5" />预览阅读</Link> : null}
        </>
      case 'design':
        return <button type="button" className={item} onClick={() => { closeMenu(); props.onOpenCover() }}><ImagePlus className="h-3.5 w-3.5" />封面工坊</button>
      case 'publish':
        return <>
          <button type="button" className={item} onClick={() => { closeMenu(); props.onPublish() }}><Upload className="h-3.5 w-3.5" />{publishLabel}</button>
          {completionButton}
        </>
      case 'export':
        return <button type="button" className={item} onClick={() => { closeMenu(); props.onExport() }}><FolderDown className="h-3.5 w-3.5" />一键导出</button>
      case 'help':
        return <>
          <button type="button" className={item} onClick={() => { closeMenu(); setFeedbackKind('suggestion') }}><Lightbulb className="h-3.5 w-3.5" />提交建议</button>
          <button type="button" className={item} onClick={() => { closeMenu(); setFeedbackKind('bug') }}><Bug className="h-3.5 w-3.5" />问题反馈</button>
          {/* 帮助文档属账户中心页面：新窗口打开，创作区界面原样保留 */}
          <button type="button" className={item} onClick={() => { closeMenu(); window.open('/account/docs', '_blank', 'noopener,noreferrer') }}><BookOpen className="h-3.5 w-3.5" />帮助文档</button>
        </>
      default:
        return null
    }
  }

  return (
    <header data-studio-command-bar={props.perspective} className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-3">
      {props.onWorkspaceSidebarToggle ? <button
        type="button"
        onClick={props.onWorkspaceSidebarToggle}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
        aria-label={props.workspaceSidebarOpen ? '折叠左侧栏' : '展开左侧栏'}
        title={props.workspaceSidebarOpen ? '折叠左侧栏' : '展开左侧栏'}
      >{props.workspaceSidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}</button> : null}
      {props.onWorkspaceSidebarToggle ? <div className="h-5 w-px shrink-0 bg-[var(--border-subtle)]" /> : null}
      {props.workspaceControls !== false && props.perspectiveSwitchEnabled ? <div className="relative inline-flex h-8 items-center overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-0.5" aria-label="切换创作模式">
        <span aria-hidden className={cn('absolute bottom-0.5 top-0.5 w-[calc(50%-2px)] bg-[var(--surface-default)] shadow-sm transition-transform duration-200 ease-out', props.perspective === 'ide' && 'translate-x-full')} />
        {([{ key: 'work' as const, label: 'Work', icon: BookOpenText }, { key: 'ide' as const, label: 'IDE', icon: PenLine }]).map(({ key, label, icon: Icon }) => <button key={key} type="button" onClick={() => props.onPerspectiveChange(key)} aria-pressed={props.perspective === key} className={cn('relative inline-flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors duration-200', props.perspective === key ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]')}><Icon className="h-3.5 w-3.5" />{label}</button>)}
      </div> : null}
      {props.workspaceControls !== false && props.perspectiveSwitchEnabled ? <div className="h-5 w-px bg-[var(--border-subtle)]" /> : null}
      {/* 任务标题与其「更多」按钮已移至 Agent 面板顶栏：它只作用于当前任务，与顶栏全局菜单无关 */}
      <div ref={menuRef} className="flex shrink-0 items-center gap-0.5">
        <div className="hidden items-center gap-0.5 md:flex">
          {STUDIO_MENUS.map(({ key, label }) => (
            <div key={key} className="relative">
              <button type="button" onClick={() => toggleMenu(key)} className={triggerClass(openMenu === key)} aria-expanded={openMenu === key}>{label}</button>
              {renderDropdown(key, 'w-44', renderStudioMenuBody(key))}
            </div>
          ))}
        </div>
      </div>
      {props.workspaceControls !== false ? <div className="w-fit min-w-0 max-w-[220px] shrink-0">
        <WorkspaceNovelSwitcher compactTrigger currentNovelId={props.currentNovelId} currentNovelTitle={props.novelTitle} novels={props.novelOptions} busy={props.switchingNovel} loading={props.novelsLoading} onSelectNovel={props.onSelectNovel} onCreateNovel={props.onCreateNovel} />
      </div> : null}
      {props.workspaceControls !== false ? <div className="h-5 w-px shrink-0 bg-[var(--border-subtle)]" /> : null}
      {props.workspaceControls !== false ? <button
        type="button"
        onClick={() => setAutoFollow(!autoFollow)}
        title={autoFollow ? '自动追踪已开启：Agent 写到哪章，编辑器跟到哪章' : '自动追踪已关闭：留在当前章节不跳转'}
        aria-pressed={autoFollow}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 border px-2.5 text-xs font-medium transition-all duration-200',
          autoFollow
            ? 'border-[var(--surface-contrast)] bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
        )}
      >
        <Crosshair className="h-3.5 w-3.5" />
        追踪
      </button> : null}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* 发布/预览已收进顶栏「发布」「查看」菜单；最右侧返回首页保持不变 */}
        {props.perspective === 'ide' ? <StudioMoreMenu onOpenStudioSettings={props.onOpenStudioSettings} /> : null}
        <Link to="/" className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] px-2.5 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"><Home className="h-3.5 w-3.5" /><span className="hidden 2xl:inline">返回首页</span></Link>
      </div>
      <FeedbackDialog open={feedbackKind !== null} kind={feedbackKind ?? 'suggestion'} source={`studio-${props.perspective}`} onClose={() => setFeedbackKind(null)} />
    </header>
  )
}
