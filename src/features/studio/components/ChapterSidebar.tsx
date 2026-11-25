import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FilePlus2, FileText, FolderPlus, FolderTree, GripVertical, NotebookPen, NotebookText, PencilLine, ScrollText, Settings2, Trash2, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatNumberedChapterTitle } from '../lib/document-title'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import type { WorkspacePlanFile } from '../types'
import { COMPOSER_REFERENCE_MIME, serializeComposerReferenceTransfer } from '../agent/composer-content'
import TreeContextMenu, { TreeMenuButton, type TreeMenuAnchor, type TreeMenuItem } from './TreeContextMenu'
import './chapter-tree.css'

type CreatePlanKind = 'outline' | 'detail'
type PlanFolderKind = CreatePlanKind | 'legacy'
type TreeContextMenuTarget = { title: string } & (
  | { kind: 'novel' | 'plan-folder' | 'chapter-folder'; id?: never }
  | { kind: 'plan-kind'; id: CreatePlanKind }
  | { kind: 'chapter' | 'plan' | 'volume'; id: string }
)
type TreeRenameTarget = { label: string; save: (title: string) => void; trigger: HTMLElement }

const planKindLabels = { outline: '大纲', detail: '细纲', legacy: '历史未分类' }
const rowActionsClass = 'studio-tree-row-action flex shrink-0 items-center'

function TreeHeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  )
}

function readCollapsedVolumes(scope?: string): Set<string> {
  if (!scope) return new Set()
  try { const value: unknown = JSON.parse(localStorage.getItem(`chevoink:volume-collapse:${scope}`) ?? '[]'); return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []) }
  catch { return new Set() }
}

type ChapterSidebarProps = {
  taskScope?: string
  chapters: StudioPayload['chapters']
  volumes: StudioPayload['volumes']
  savedPlans: WorkspacePlanFile[]
  selectedChapterId: string | null
  selectedTreeItemId: string | null
  catalogPreview: {
    title: string
    content: string
    description: string
  }
  novelWordCountLabel: string
  chapterCountLabel: string
  novelTitle: string
  activeCoverLabel: string
  onSelectChapter: (chapterId: string) => void
  onPrepareChapter?: (chapterId: string) => void
  onSelectPlan: (planId: string) => void
  onSelectCatalog: () => void
  onCreateChapter: () => void
  onCreateChapterInVolume?: (volumeId: string) => void
  onCreateVolume?: () => void
  onCreatePlan: () => void
  onCreatePlanKind?: (kind: CreatePlanKind, parentPlanId?: string) => void
  onOpenNovelSettings?: () => void
  onMoveChapter?: (chapterId: string, targetVolumeId: string, position: number) => void | Promise<void>
  onMovePlan?: (planId: string, position: number) => void | Promise<void>
  /** 打开章节设置抽屉（会先切到该章） */
  onOpenChapterSettings: (chapterId: string) => void
  /** 打开卷设置抽屉 */
  onOpenVolumeSettings?: (volumeId: string) => void
  /** 打开计划设置抽屉（改名 / 删除） */
  onOpenPlanSettings: (planId: string) => void
  /** 右键删除章节：确认弹窗与删除逻辑在 workspace 层 */
  onRequestDeleteChapter?: (chapterId: string) => void
  /** 右键删除计划：确认弹窗与删除逻辑在 workspace 层 */
  onRequestDeletePlan?: (planId: string) => void
  onRequestDeleteVolume?: (volumeId: string) => void
  /** 右键重命名提交：当前章改草稿，其它章走 API */
  onRenameChapterTitle?: (chapterId: string, title: string) => void
  /** 右键重命名提交 */
  onRenamePlanTitle?: (planId: string, title: string) => void
  onRenameNovelTitle?: (title: string) => void
  onRenameVolumeTitle?: (volumeId: string, title: string) => void
  embedded?: boolean
  showExtendedMenus?: boolean
}

export default function ChapterSidebar({
  showExtendedMenus = true,
  taskScope,
  chapters,
  volumes,
  savedPlans,
  selectedChapterId,
  selectedTreeItemId,
  novelTitle,
  onCreateChapter,
  onCreateChapterInVolume,
  onCreateVolume,
  onCreatePlan,
  onCreatePlanKind,
  onOpenNovelSettings,
  onMoveChapter,
  onMovePlan,
  onOpenChapterSettings,
  onOpenVolumeSettings,
  onOpenPlanSettings,
  onRequestDeleteChapter,
  onRequestDeletePlan,
  onRequestDeleteVolume,
  onRenameChapterTitle,
  onRenamePlanTitle,
  onRenameNovelTitle,
  onRenameVolumeTitle,
  onSelectCatalog,
  onSelectPlan,
  onSelectChapter,
  onPrepareChapter,
  embedded = false,
}: ChapterSidebarProps) {
  const chapterHoverTimer = useRef<number>()
  function cancelChapterHover() { window.clearTimeout(chapterHoverTimer.current) }
  useEffect(() => cancelChapterHover, [onPrepareChapter])
  const [volumeState, setVolumeState] = useState(() => ({ scope: taskScope, collapsed: readCollapsedVolumes(taskScope) }))
  const collapsedVolumes = volumeState.scope === taskScope ? volumeState.collapsed : readCollapsedVolumes(taskScope)
  useLayoutEffect(() => { setVolumeState({ scope: taskScope, collapsed: readCollapsedVolumes(taskScope) }) }, [taskScope])
  function updateCollapsedVolumes(next: Set<string>) {
    setVolumeState({ scope: taskScope, collapsed: next })
    if (taskScope) try { localStorage.setItem(`chevoink:volume-collapse:${taskScope}`, JSON.stringify([...next])) } catch { /* Memory state remains available. */ }
  }
  function toggleVolume(volumeId: string) {
    const next = new Set(collapsedVolumes)
    if (next.has(volumeId)) next.delete(volumeId); else next.add(volumeId)
    updateCollapsedVolumes(next)
  }
  const [novelExpanded, setNovelExpanded] = useState(true)
  const [planFolderExpanded, setPlanFolderExpanded] = useState(false)
  const [expandedPlanKinds, setExpandedPlanKinds] = useState<Record<PlanFolderKind, boolean>>({ outline: true, detail: true, legacy: true })
  const [chapterFolderExpanded, setChapterFolderExpanded] = useState(true)
  const [draggedItem, setDraggedItem] = useState<{ kind: 'chapter' | 'plan'; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ target: TreeContextMenuTarget; anchor: TreeMenuAnchor } | null>(null)
  const [renameTarget, setRenameTarget] = useState<TreeRenameTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useLayoutEffect(() => {
    setContextMenu(null)
    setRenameTarget(null)
    setRenameValue('')
  }, [taskScope])

  function openTreeContextMenu(event: MouseEvent<HTMLElement>, target: TreeContextMenuTarget) {
    if (!showExtendedMenus && target.kind !== 'chapter' && target.kind !== 'plan') return
    event.preventDefault()
    event.stopPropagation()
    const row = event.currentTarget
    const trigger = row.querySelector<HTMLElement>('[data-tree-menu-trigger]') ?? row
    const rect = trigger.getBoundingClientRect()
    const keyboard = event.clientX === 0 && event.clientY === 0
    setContextMenu({ target, anchor: { x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY, trigger } })
  }

  function treeMenuButton(target: TreeContextMenuTarget) {
    const expanded = contextMenu?.target.kind === target.kind && contextMenu.target.id === target.id
    return <TreeMenuButton title={target.title} expanded={expanded} onClick={(event) => {
      if (expanded) {
        setContextMenu(null)
        return
      }
      const trigger = event.currentTarget
      const rect = trigger.getBoundingClientRect()
      setContextMenu({ target, anchor: { x: rect.left, y: rect.bottom, trigger } })
    }} />
  }

  function closeTreeRename() {
    renameTarget?.trigger.focus({ preventScroll: true })
    setRenameTarget(null)
    setRenameValue('')
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      closeTreeRename()
    }
    if (event.key !== 'Tab') return
    const controls = event.currentTarget.querySelectorAll<HTMLElement>(':is(button, input):not(:disabled)')
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.target === (event.shiftKey ? first : last)) {
      event.preventDefault()
      const next = event.shiftKey ? last : first
      next.focus()
    }
  }

  function commitTreeRename() {
    const trimmed = renameValue.trim()
    if (!renameTarget || !trimmed) return
    renameTarget.save(trimmed)
    closeTreeRename()
  }

  function setTreeExpanded(expanded: boolean) {
    setNovelExpanded(expanded)
    setPlanFolderExpanded(expanded)
    setExpandedPlanKinds({ outline: expanded, detail: expanded, legacy: expanded })
    setChapterFolderExpanded(expanded)
    updateCollapsedVolumes(new Set(expanded ? [] : volumes.map((volume) => volume.id)))
  }

  function getTreeMenuItems({ target, anchor }: NonNullable<typeof contextMenu>): TreeMenuItem[] {
    const items: TreeMenuItem[] = []
    function add(label: string, icon: LucideIcon, onSelect: () => void, danger = false) {
      items.push({ label, icon, onSelect, danger })
    }
    function addNewPlan() {
      if (!onCreatePlanKind) {
        add('新建计划', NotebookPen, onCreatePlan)
        return
      }
      const create = onCreatePlanKind
      items.push({
        label: '新建计划',
        icon: NotebookPen,
        children: [
          { label: '大纲', icon: FileText, onSelect: () => create('outline') },
          { label: '细纲', icon: FileText, onSelect: () => create('detail') },
        ],
      })
    }
    function addToggle(expanded: boolean, toggle: () => void) {
      add(expanded ? '折叠' : '展开', expanded ? ChevronRight : ChevronDown, toggle)
    }
    function addRename(label: string, save?: (title: string) => void, openSettings?: () => void) {
      if (save) {
        add('重命名', PencilLine, () => {
          setRenameTarget({ label, save, trigger: anchor.trigger })
          setRenameValue(target.title)
        })
      } else if (openSettings) add('重命名', PencilLine, openSettings)
    }

    switch (target.kind) {
      case 'novel':
        addNewPlan()
        if (onCreateVolume) add('新建卷', FolderPlus, onCreateVolume)
        add('新建章节', FilePlus2, onCreateChapter)
        addRename('作品', onRenameNovelTitle, onOpenNovelSettings)
        if (onOpenNovelSettings) add('作品设置', Settings2, onOpenNovelSettings)
        add('全部展开', ChevronDown, () => setTreeExpanded(true))
        add('全部折叠', ChevronRight, () => setTreeExpanded(false))
        break
      case 'plan-folder':
        addNewPlan()
        addToggle(planFolderExpanded, () => setPlanFolderExpanded((current) => !current))
        break
      case 'plan-kind': {
        const kind = target.id
        if (onCreatePlanKind) add(`新建${planKindLabels[kind]}`, FilePlus2, () => onCreatePlanKind(kind))
        addToggle(expandedPlanKinds[kind], () => setExpandedPlanKinds((current) => ({ ...current, [kind]: !current[kind] })))
        break
      }
      case 'chapter-folder':
        if (onCreateVolume) add('新建卷', FolderPlus, onCreateVolume)
        add('新建章节', FilePlus2, onCreateChapter)
        addToggle(chapterFolderExpanded, () => setChapterFolderExpanded((current) => !current))
        break
      case 'volume': {
        const id = target.id
        const openSettings = onOpenVolumeSettings ? () => onOpenVolumeSettings(id) : undefined
        if (onCreateChapterInVolume) add('在此卷新建章节', FilePlus2, () => onCreateChapterInVolume(id))
        addRename('卷', onRenameVolumeTitle ? (title) => onRenameVolumeTitle(id, title) : undefined, openSettings)
        if (openSettings) add('卷设置', Settings2, openSettings)
        addToggle(!collapsedVolumes.has(id), () => toggleVolume(id))
        if (onRequestDeleteVolume) add('删除', Trash2, () => onRequestDeleteVolume(id), true)
        break
      }
      case 'chapter': {
        const id = target.id
        const openSettings = () => onOpenChapterSettings(id)
        add('打开', FileText, () => onSelectChapter(id))
        addRename('章节', onRenameChapterTitle ? (title) => onRenameChapterTitle(id, title) : undefined, openSettings)
        add('设置', Settings2, openSettings)
        if (onRequestDeleteChapter) add('删除', Trash2, () => onRequestDeleteChapter(id), true)
        break
      }
      case 'plan': {
        const id = target.id
        const plan = savedPlans.find((item) => item.id === id)
        const openSettings = () => onOpenPlanSettings(id)
        add('打开', FileText, () => onSelectPlan(id))
        addRename('计划', onRenamePlanTitle ? (title) => onRenamePlanTitle(id, title) : undefined, openSettings)
        add('设置', Settings2, openSettings)
        if (plan?.planKind === 'outline' && plan.backendArtifactId && onCreatePlanKind) {
          const parentPlanId = plan.backendArtifactId
          add('新建关联细纲', FilePlus2, () => onCreatePlanKind('detail', parentPlanId))
        }
        if (showExtendedMenus && plan?.planKind === 'detail' && plan.parentPlanId) {
          const parent = savedPlans.find((item) => item.planKind === 'outline' && item.backendArtifactId === plan.parentPlanId)
          if (parent) add('查看父大纲', FileText, () => onSelectPlan(parent.id))
        }
        if (onRequestDeletePlan) add('删除', Trash2, () => onRequestDeletePlan(id), true)
        break
      }
    }
    return items
  }

  const novelTarget = { kind: 'novel', title: novelTitle } as const
  const planFolderTarget = { kind: 'plan-folder', title: '计划' } as const
  const chapterFolderTarget = { kind: 'chapter-folder', title: '全部章节' } as const
  const volumeGroups = volumes.map((volume) => ({
    volume,
    chapters: chapters.filter((chapter) => chapter.volumeId === volume.id),
  }))
  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface-default)]',
        embedded
          ? 'px-2 py-3'
          : 'rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-2 pb-4 shadow-[var(--shadow-soft)]',
      )}
    >
      {/* 参考 IDE 资源管理器的顶栏结构：标题区移除，新建按钮浮在根节点行右侧；树整体贴近左侧边框 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1 pb-2">
        <div className="space-y-0.5">
          <div onContextMenu={(event) => openTreeContextMenu(event, novelTarget)} className="studio-tree-row flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 transition hover:bg-[var(--surface-muted)]">
            <button
              type="button"
              onClick={() => setNovelExpanded((current) => !current)}
              aria-expanded={novelExpanded}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] text-[var(--text-primary)]"
            >
              {novelExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
              )}
              <FolderTree className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
              <span className="truncate">{novelTitle}</span>
            </button>
            <div className="studio-tree-row-action flex shrink-0 items-center gap-0.5">
              {onCreateVolume ? <TreeHeaderButton label="新建卷" onClick={onCreateVolume}><FolderPlus className="h-3.5 w-3.5" /></TreeHeaderButton> : null}
              <TreeHeaderButton label="新建章节" onClick={onCreateChapter}><FilePlus2 className="h-3.5 w-3.5" /></TreeHeaderButton>
              <TreeHeaderButton label="新建计划" onClick={onCreatePlan}><NotebookPen className="h-3.5 w-3.5" /></TreeHeaderButton>
              {showExtendedMenus && treeMenuButton(novelTarget)}
            </div>
          </div>

          {novelExpanded ? (
            <div className="studio-tree-guide ml-3.5 pl-1.5">
              <button
                type="button"
                onClick={onSelectCatalog}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] transition',
                  selectedTreeItemId === 'catalog'
                    ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                <ScrollText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                <span className="truncate">目录</span>
              </button>

              <div onContextMenu={(event) => openTreeContextMenu(event, planFolderTarget)} className="studio-tree-row flex items-center rounded-[10px] transition hover:bg-[var(--surface-muted)]">
                <button
                  type="button"
                  onClick={() => setPlanFolderExpanded((current) => !current)}
                  aria-expanded={planFolderExpanded}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)]"
                >
                  {planFolderExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  )}
                  <NotebookText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  <span className="truncate">计划</span>
                  <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">共{savedPlans.length}个</span>
                </button>
                {showExtendedMenus && <div className={cn(rowActionsClass, 'mr-1')}>{treeMenuButton(planFolderTarget)}</div>}
              </div>

              {planFolderExpanded ? (
                <div className="studio-tree-guide ml-3 pl-1.5">
                  {(['outline', 'detail', 'legacy'] as const).map(kind => {
                    const plans = savedPlans.filter(plan => (plan.planKind ?? 'legacy') === kind)
                    if (kind === 'legacy' && plans.length === 0) return null
                    const kindTarget = kind === 'legacy' ? null : { kind: 'plan-kind' as const, id: kind, title: planKindLabels[kind] }
                    return <div key={kind}>
                      <div onContextMenu={kindTarget ? (event) => openTreeContextMenu(event, kindTarget) : undefined} className="studio-tree-row flex items-center rounded-[10px] hover:bg-[var(--surface-muted)]">
                        <button type="button" aria-expanded={expandedPlanKinds[kind]} onClick={() => setExpandedPlanKinds(current => ({ ...current, [kind]: !current[kind] }))} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] text-[var(--text-secondary)]">
                          {expandedPlanKinds[kind] ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate">{planKindLabels[kind]}</span><span className="ml-auto shrink-0 text-[10px]">共{plans.length}个</span>
                        </button>
                        {showExtendedMenus && kindTarget ? <div className={cn(rowActionsClass, 'mr-1')}>{treeMenuButton(kindTarget)}</div> : null}
                      </div>
                    {expandedPlanKinds[kind] ? plans.map((plan) => {
                      const index = savedPlans.findIndex(item => item.id === plan.id)
                      const planTarget = { kind: 'plan', id: plan.id, title: plan.title.trim() || `计划 ${savedPlans.length - index}` } as const
                      return (
                      <div
                        key={plan.id}
                        draggable={Boolean(onMovePlan)}
                        onDragStart={(event) => {
                          setDraggedItem({ kind: 'plan', id: plan.id })
                          event.dataTransfer.effectAllowed = 'copyMove'
                          event.dataTransfer.setData('text/plain', `plan:${plan.id}`)
                          event.dataTransfer.setData(COMPOSER_REFERENCE_MIME, serializeComposerReferenceTransfer({
                            id: `plan:${plan.id}`,
                            kind: 'plan',
                            name: plan.title.trim() || `计划 ${savedPlans.length - index}`,
                            text: plan.content,
                            startLine: 1,
                            endLine: Math.max(1, plan.content.split('\n').length),
                          }))
                        }}
                        onDragEnd={() => { setDraggedItem(null); setDropTarget(null) }}
                        onDragOver={(event) => {
                          if (draggedItem?.kind !== 'plan') return
                          event.preventDefault()
                          setDropTarget(`plan:${plan.id}`)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          if (draggedItem?.kind === 'plan' && draggedItem.id !== plan.id) {
                            void onMovePlan?.(draggedItem.id, index + 1)
                          }
                          setDraggedItem(null)
                          setDropTarget(null)
                        }}
                        onContextMenu={(event) => openTreeContextMenu(event, planTarget)}
                        className={cn(
                          'studio-tree-row group/row flex items-center gap-1 rounded-[10px] border-t border-transparent transition',
                          selectedTreeItemId === `plan:${plan.id}` ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
                          dropTarget === `plan:${plan.id}` && 'border-t-[var(--text-primary)]',
                        )}
                      >
                        <GripVertical className="ml-1 h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100" />
                        <button
                          type="button"
                          onClick={() => onSelectPlan(plan.id)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] transition',
                            selectedTreeItemId === `plan:${plan.id}`
                              ? 'text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                          <span className="truncate">
                            {plan.title.trim() || `计划 ${savedPlans.length - index}`}
                          </span>
                          {plan.planKind === 'detail' ? <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">{plan.reviewState === 'stale' ? '待复核' : plan.reviewState === 'missing_parent' ? '父大纲已移除' : plan.reviewState === 'current' ? '已关联' : '未关联'}</span> : null}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenPlanSettings(plan.id)}
                          className={cn(
                            'mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]',
                            // 手机端无 hover，小屏常驻显示；桌面端仅选中或悬停时显示
                            selectedTreeItemId === `plan:${plan.id}`
                              ? 'opacity-100'
                              : 'studio-tree-row-action',
                          )}
                          aria-label="计划设置"
                          title="计划设置"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                        {showExtendedMenus && <div className={cn(rowActionsClass, 'mr-1')}>{treeMenuButton(planTarget)}</div>}
                      </div>
                    )}) : null}
                    </div>
                  })}
                </div>
              ) : null}

              <div onContextMenu={(event) => openTreeContextMenu(event, chapterFolderTarget)} className="studio-tree-row flex items-center rounded-[10px] transition hover:bg-[var(--surface-muted)]">
                <button
                  type="button"
                  onClick={() => setChapterFolderExpanded((current) => !current)}
                  aria-expanded={chapterFolderExpanded}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)]"
                >
                  {chapterFolderExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  )}
                  <span className="truncate">全部章节</span>
                  <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">共{volumes.length}卷{chapters.length}章</span>
                </button>
                {showExtendedMenus && <div className={cn(rowActionsClass, 'mr-1')}>{treeMenuButton(chapterFolderTarget)}</div>}
              </div>

              {chapterFolderExpanded ? (
                <div className="studio-tree-guide ml-3.5 pl-1.5">
                  {volumeGroups.map(({ volume, chapters: volumeChapters }) => {
                    const volumeTarget = { kind: 'volume', id: volume.id, title: volume.title } as const
                    return (
                    <div key={volume.id} className="py-0.5">
                      <div
                        onContextMenu={(event) => openTreeContextMenu(event, volumeTarget)}
                        onDragOver={(event) => {
                          if (draggedItem?.kind !== 'chapter') return
                          event.preventDefault()
                          setDropTarget(`volume:${volume.id}`)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          if (draggedItem?.kind === 'chapter') {
                            void onMoveChapter?.(draggedItem.id, volume.id, volumeChapters.length + 1)
                          }
                          setDraggedItem(null)
                          setDropTarget(null)
                        }}
                        className={cn(
                          'studio-tree-row flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors',
                          dropTarget === `volume:${volume.id}` && 'border-[var(--border-strong)] bg-[var(--surface-muted)]',
                        )}
                      >
                        <button type="button" onClick={() => toggleVolume(volume.id)} aria-expanded={!collapsedVolumes.has(volume.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                          {collapsedVolumes.has(volume.id) ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                          <NotebookText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                          <span className="truncate">第 {volume.orderIndex} 卷 · {volume.title}</span>
                        </button>
                        {onOpenVolumeSettings ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenVolumeSettings(volume.id)
                            }}
                            className="ml-auto inline-grid h-11 min-w-11 shrink-0 place-items-center rounded-full px-1.5 text-[10px] text-[var(--text-tertiary)] transition hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [@media(min-width:768px)_and_(hover:hover)_and_(pointer:fine)]:h-7 [@media(min-width:768px)_and_(hover:hover)_and_(pointer:fine)]:min-w-7"
                            aria-label={`卷设置：${volume.title}`}
                            title="卷设置"
                          >
                            <span aria-hidden="true" className="studio-tree-volume-count [grid-area:1/1]">
                              共{volumeChapters.length}章
                            </span>
                            <span aria-hidden="true" className="studio-tree-volume-action inline-flex items-center gap-1 [grid-area:1/1]">
                              <Settings2 data-volume-settings-icon className="h-3.5 w-3.5" />
                              <span className="hidden [@media(min-width:768px)_and_(hover:hover)_and_(pointer:fine)]:inline">设置</span>
                            </span>
                          </button>
                        ) : (
                          <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">共{volumeChapters.length}章</span>
                        )}
                        {showExtendedMenus && <div className={rowActionsClass}>{treeMenuButton(volumeTarget)}</div>}
                      </div>
                      {!collapsedVolumes.has(volume.id) ? <div className="studio-tree-guide ml-2.5 pl-1">
                  {volumeChapters.map((chapter) => {
                    const chapterTarget = { kind: 'chapter', id: chapter.id, title: chapter.title.trim() || `第 ${chapter.orderInVolume} 章` } as const
                    const chapterActive =
                      selectedTreeItemId === `chapter:${chapter.id}` ||
                      (!selectedTreeItemId && selectedChapterId === chapter.id)

                    return (
                      <div
                        key={chapter.id}
                        draggable={Boolean(onMoveChapter)}
                        onDragStart={(event) => {
                          setDraggedItem({ kind: 'chapter', id: chapter.id })
                          event.dataTransfer.effectAllowed = 'copyMove'
                          event.dataTransfer.setData('text/plain', `chapter:${chapter.id}`)
                          event.dataTransfer.setData(COMPOSER_REFERENCE_MIME, serializeComposerReferenceTransfer({
                            id: `chapter:${chapter.id}`,
                            kind: 'chapter',
                            name: formatNumberedChapterTitle(chapter.title, chapter.orderInVolume),
                            // 作品树列表为轻量 ChapterListItem，不携带正文；输入框接收后按 id 懒取全文。
                            text: '',
                            startLine: 1,
                            endLine: 1,
                          }))
                        }}
                        onDragEnd={() => { setDraggedItem(null); setDropTarget(null) }}
                        onDragOver={(event: DragEvent<HTMLDivElement>) => {
                          if (draggedItem?.kind !== 'chapter') return
                          event.preventDefault()
                          event.stopPropagation()
                          setDropTarget(`chapter:${chapter.id}`)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (draggedItem?.kind === 'chapter' && draggedItem.id !== chapter.id) {
                            void onMoveChapter?.(draggedItem.id, volume.id, chapter.orderInVolume)
                          }
                          setDraggedItem(null)
                          setDropTarget(null)
                        }}
                        onContextMenu={(event) => openTreeContextMenu(event, chapterTarget)}
                        className={cn(
                          'studio-tree-row group/row flex items-center gap-1 rounded-[10px] border-t border-transparent transition',
                          chapterActive ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
                          dropTarget === `chapter:${chapter.id}` && 'border-t-[var(--text-primary)]',
                        )}
                      >
                        <GripVertical className="ml-1 h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100" />
                        <button
                          type="button"
                          onClick={() => onSelectChapter(chapter.id)}
                          onPointerDown={event => { if (event.button === 0) onPrepareChapter?.(chapter.id) }}
                          onPointerEnter={event => {
                            cancelChapterHover()
                            if (event.pointerType === 'mouse' && onPrepareChapter) {
                              chapterHoverTimer.current = window.setTimeout(() => onPrepareChapter(chapter.id), 65)
                            }
                          }}
                          onPointerLeave={cancelChapterHover}
                          onFocus={() => onPrepareChapter?.(chapter.id)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] transition',
                            chapterActive
                              ? 'text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                          <span className="truncate">
                            {formatNumberedChapterTitle(chapter.title, chapter.orderInVolume)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenChapterSettings(chapter.id)}
                          className={cn(
                            'mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]',
                            chapterActive
                              ? 'opacity-100'
                              : 'studio-tree-row-action',
                          )}
                          aria-label="章节设置"
                          title="章节设置"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                        {showExtendedMenus && <div className={cn(rowActionsClass, 'mr-1')}>{treeMenuButton(chapterTarget)}</div>}
                      </div>
                    )
                  })}
                        {volumeChapters.length === 0 ? (
                          <p className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">空卷</p>
                        ) : null}
                      </div> : null}
                    </div>
                  )})}
                  {volumeGroups.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-[var(--text-tertiary)]">暂未建立卷结构</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {contextMenu ? (
        <TreeContextMenu title={contextMenu.target.title} anchor={contextMenu.anchor} items={getTreeMenuItems(contextMenu)} onClose={() => setContextMenu(null)} />
      ) : null}

      {renameTarget ? (
        <div className="fixed inset-0 z-[195] flex items-center justify-center bg-black/25 p-4" onMouseDown={closeTreeRename}>
          <form role="dialog" aria-modal="true" aria-label={`重命名${renameTarget.label}`} onSubmit={(event) => { event.preventDefault(); commitTreeRename() }} onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleRenameKeyDown} className="w-full max-w-md rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-2xl">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">重命名{renameTarget.label}</h2>
            <input autoFocus aria-label="名称" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={160} className="mt-4 h-10 w-full rounded-[9px] border border-[var(--border-subtle)] bg-transparent px-3 text-sm outline-none focus:border-[var(--border-strong)]" />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeTreeRename} className="h-9 rounded-[9px] px-3 text-xs hover:bg-[var(--surface-muted)]">取消</button>
              <button type="submit" disabled={!renameValue.trim()} className="h-9 rounded-[9px] bg-[var(--surface-contrast)] px-4 text-xs font-medium text-[var(--text-contrast)] disabled:opacity-45">保存</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}
