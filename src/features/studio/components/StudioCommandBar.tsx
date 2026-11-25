import { StudioPresence } from '@/features/studio/components/StudioPresence'
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, BookOpenText, Bug, ChevronRight, ExternalLink, FilePlus2, FileText, Flag, FolderDown, FolderPlus, ImagePlus, Lightbulb, NotebookPen, PanelLeftClose, PanelLeftOpen, RotateCcw, Settings2, Trash2, Upload } from 'lucide-react'
import { Link } from 'react-router-dom'

import FeedbackDialog from '@/features/feedback/components/FeedbackDialog'
import { cn } from '@/lib/utils'
import { DesktopCaptionHost } from '@/lib/desktop-caption'
import type { FeedbackKind, Novel } from '../../../../shared/contracts/index.js'
import { DesktopHistory } from '@/components/layout/DesktopNavigation'
import { StudioPerspectiveMenu } from './StudioSidebarHeader'
import WorkspaceNovelSwitcher from './WorkspaceNovelSwitcher'
import { studioInert } from './use-studio-presence'
import StudioDocumentPicker, { type DocumentKind, type DocumentPickerData } from './StudioDocumentPicker'

type Props = {
  workspaceSidebarOpen?: boolean
  onWorkspaceSidebarToggle?: () => void
  workspaceControls?: boolean
  switchingWork?: boolean
  surfaceOpen?: boolean
  onDismissTransient?: () => void
  historyBlocked?: boolean
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
  documents: DocumentPickerData
  onOpenChapterSettings: (id: string) => void
  onOpenPlanSettings: (id: string) => void
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

const dropdownClass = 'studio-floating-menu absolute left-0 top-[calc(100%+7px)] z-50 rounded-[12px] border border-[var(--border-subtle)] p-1 shadow-[0_18px_50px_rgba(15,23,42,.18)] [--studio-motion-origin:top_left]'

export default function StudioCommandBar(props: Props) {
  const captionHost = useContext(DesktopCaptionHost)
  const [openMenu, setOpenMenu] = useState<StudioMenuKey | null>(null)
  const [picker, setPicker] = useState<DocumentKind | null>(null)
  const pickerId = useId()
  const pickerTrigger = useRef<HTMLButtonElement | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!openMenu) return
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) { setOpenMenu(null); setPicker(null) } }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [openMenu])
  const item = 'flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]'
  const toggleMenu = (key: StudioMenuKey) => {
    setPicker(null)
    setOpenMenu(current => current === key ? null : key)
  }
  const closeMenu = () => {
    menuRef.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus({ preventScroll: true })
    setPicker(null)
    setOpenMenu(null)
  }
  const triggerClass = (active: boolean) => cn('inline-flex h-8 items-center justify-center rounded-[8px] px-2 text-sm font-medium transition-colors', active ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]')
  const renderDropdown = (key: StudioMenuKey, widthClass: string, children: ReactNode) => (
    <StudioPresence kind="menu">{openMenu === key ? <div className={cn(dropdownClass, widthClass)}>
      {key === 'novel' ? <>
        <div className="studio-novel-actions overflow-y-auto overscroll-contain">{children}</div>
        <StudioPresence kind="menu">{picker && <StudioDocumentPicker key={picker} id={pickerId} kind={picker} data={props.documents} trigger={pickerTrigger.current}
          onSelect={id => {
            closeMenu()
            if (picker === 'chapter') props.onOpenChapterSettings(id)
            else props.onOpenPlanSettings(id)
          }} />}</StudioPresence>
      </> : children}
    </div> : null}</StudioPresence>
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
          {(['chapter', 'plan'] as const).map(kind => {
            const Icon = kind === 'chapter' ? FileText : NotebookPen
            return <button key={kind} type="button" aria-controls={picker === kind ? pickerId : undefined} aria-expanded={picker === kind}
              className={cn(item, picker === kind && 'bg-[var(--surface-muted)]')}
              onClick={event => { pickerTrigger.current = event.currentTarget; setPicker(picker === kind ? null : kind) }}
              onKeyDown={event => {
                if (event.key !== 'ArrowRight') return
                event.preventDefault()
                pickerTrigger.current = event.currentTarget
                setPicker(kind)
              }}>
              <Icon aria-hidden="true" className="h-3.5 w-3.5" />{kind === 'chapter' ? '章节设置' : '计划设置'}
              <ChevronRight aria-hidden="true" className="ml-auto h-3.5 w-3.5 text-[var(--text-tertiary)]" />
            </button>
          })}
          <button type="button" className={item} onClick={() => { closeMenu(); props.onPublish() }}><Upload className="h-3.5 w-3.5" />{publishLabel}</button>
          {completionButton}
          <button type="button" className={cn(item, 'min-h-11')} onClick={() => { closeMenu(); props.onImport() }}><Upload className="h-3.5 w-3.5" />一键导入</button>
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

  const commands = (
    <div ref={element => { if (element) element.inert = Boolean(props.switchingWork) }} data-studio-command-bar={props.perspective} className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-3">
      {props.onWorkspaceSidebarToggle ? <button
        type="button"
        disabled={props.surfaceOpen}
        onClick={props.onWorkspaceSidebarToggle}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
        aria-label={props.workspaceSidebarOpen ? '折叠左侧栏' : '展开左侧栏'}
        title={props.workspaceSidebarOpen ? '折叠左侧栏' : '展开左侧栏'}
      >{props.workspaceSidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}</button> : null}
      <DesktopHistory onDismiss={props.onDismissTransient} blocked={props.historyBlocked} />
      <div className="h-4 w-px shrink-0 bg-[var(--border-subtle)]" />
      {/* 任务标题与其「更多」按钮已移至 Agent 面板顶栏：它只作用于当前任务，与顶栏全局菜单无关 */}
      <div ref={menuRef} {...studioInert(Boolean(props.surfaceOpen))} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (picker && (event.key === 'Escape' || (event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement)))) {
          event.preventDefault()
          setPicker(null)
          pickerTrigger.current?.focus({ preventScroll: true })
          return
        }
        if (event.key === 'Escape' && openMenu) {
          event.preventDefault()
          closeMenu()
        }
      }} className="flex shrink-0 items-center gap-0.5">
        <div className="hidden items-center gap-0.5 md:flex">
          {STUDIO_MENUS.map(({ key, label }) => (
            <div key={key} className="relative">
              <button type="button" onClick={() => toggleMenu(key)} className={triggerClass(openMenu === key)} aria-expanded={openMenu === key}>{label}</button>
              {renderDropdown(key, 'w-44', renderStudioMenuBody(key))}
            </div>
          ))}
        </div>
      </div>
      {!props.surfaceOpen && props.workspaceControls !== false && props.perspectiveSwitchEnabled && <>
        <StudioPerspectiveMenu perspective={props.perspective} enabled onChange={props.onPerspectiveChange} />
        <div className="h-4 w-px shrink-0 bg-[var(--border-subtle)]" />
      </>}
      {!props.surfaceOpen && props.workspaceControls !== false ? <div className="w-fit min-w-0 max-w-[220px] shrink-0">
        <WorkspaceNovelSwitcher compactTrigger currentNovelId={props.currentNovelId} currentNovelTitle={props.novelTitle} novels={props.novelOptions} busy={props.switchingNovel} loading={props.novelsLoading} onSelectNovel={props.onSelectNovel} onCreateNovel={props.onCreateNovel} />
      </div> : null}
    </div>
  )
  return <>{captionHost ? createPortal(commands, captionHost) : <header data-surface-open={props.surfaceOpen || undefined} className="studio-web-caption" aria-label="创作区菜单栏"><div className="desktop-commands">{commands}</div></header>}
    <FeedbackDialog open={feedbackKind !== null} kind={feedbackKind ?? 'suggestion'} source={`studio-${props.perspective}`} onClose={() => setFeedbackKind(null)} />
  </>
}
