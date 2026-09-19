import { useEffect, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FilePlus2, FileText, FolderPlus, FolderTree, GripVertical, NotebookPen, NotebookText, PencilLine, ScrollText, Settings2, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import type { WorkspacePlanFile } from '../types'
import { COMPOSER_REFERENCE_MIME, serializeComposerReferenceTransfer } from '../agent/composer-content'

function formatChapterTreeLabel(chapter: StudioPayload['chapters'][number]) {
  const normalizedTitle = chapter.title.trim()

  if (!normalizedTitle) {
    return `第 ${chapter.orderInVolume} 章`
  }

  const prefixedPattern = new RegExp(`^第\\s*${chapter.orderInVolume}\\s*章(?:\\s*[：:.·\\-]\\s*.*)?$`)
  if (prefixedPattern.test(normalizedTitle)) {
    return normalizedTitle
  }

  return `第 ${chapter.orderInVolume} 章 · ${normalizedTitle}`
}

/** 右键菜单目标；重命名弹窗内置在树内，删除/设置交给 workspace 层 */
type TreeContextMenuTarget = { kind: 'chapter' | 'plan'; id: string; title: string; x: number; y: number }
type TreeRenameTarget = { kind: 'chapter' | 'plan'; id: string }

const treeMenuItem = 'flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]'

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

type ChapterSidebarProps = {
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
  onSelectPlan: (planId: string) => void
  onSelectCatalog: () => void
  onCreateChapter: () => void
  onCreateVolume?: () => void
  onCreatePlan: () => void
  onMoveChapter?: (chapterId: string, targetVolumeId: string, position: number) => void | Promise<void>
  onMovePlan?: (planId: string, position: number) => void | Promise<void>
  /** 打开章节设置抽屉（会先切到该章） */
  onOpenChapterSettings: (chapterId: string) => void
  /** 打开卷设置抽屉；卷行的章数在悬停、聚焦或触摸时可达 */
  onOpenVolumeSettings?: (volumeId: string) => void
  /** 打开计划设置抽屉（改名 / 删除） */
  onOpenPlanSettings: (planId: string) => void
  /** 右键删除章节：确认弹窗与删除逻辑在 workspace 层 */
  onRequestDeleteChapter?: (chapterId: string) => void
  /** 右键删除计划：确认弹窗与删除逻辑在 workspace 层 */
  onRequestDeletePlan?: (planId: string) => void
  /** 右键重命名提交：当前章改草稿，其它章走 API */
  onRenameChapterTitle?: (chapterId: string, title: string) => void
  /** 右键重命名提交 */
  onRenamePlanTitle?: (planId: string, title: string) => void
  embedded?: boolean
}

export default function ChapterSidebar({
  chapters,
  volumes,
  savedPlans,
  selectedChapterId,
  selectedTreeItemId,
  novelTitle,
  onCreateChapter,
  onCreateVolume,
  onCreatePlan,
  onMoveChapter,
  onMovePlan,
  onOpenChapterSettings,
  onOpenVolumeSettings,
  onOpenPlanSettings,
  onRequestDeleteChapter,
  onRequestDeletePlan,
  onRenameChapterTitle,
  onRenamePlanTitle,
  onSelectCatalog,
  onSelectPlan,
  onSelectChapter,
  embedded = false,
}: ChapterSidebarProps) {
  const [novelExpanded, setNovelExpanded] = useState(true)
  const [planFolderExpanded, setPlanFolderExpanded] = useState(true)
  const [chapterFolderExpanded, setChapterFolderExpanded] = useState(true)
  const [draggedItem, setDraggedItem] = useState<{ kind: 'chapter' | 'plan'; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<TreeContextMenuTarget | null>(null)
  const [renameTarget, setRenameTarget] = useState<TreeRenameTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])

  function openTreeContextMenu(event: MouseEvent, kind: 'chapter' | 'plan', id: string, title: string) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ kind, id, title, x: event.clientX, y: event.clientY })
  }

  function commitTreeRename() {
    const trimmed = renameValue.trim()
    if (renameTarget && trimmed) {
      if (renameTarget.kind === 'chapter') onRenameChapterTitle?.(renameTarget.id, trimmed)
      else onRenamePlanTitle?.(renameTarget.id, trimmed)
    }
    setRenameTarget(null)
    setRenameValue('')
  }
  const volumeGroups = volumes.map((volume) => ({
    volume,
    chapters: chapters.filter((chapter) => chapter.volumeId === volume.id),
  }))
  return (
    <div
      className={cn(
        'group/tree flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface-default)]',
        embedded
          ? 'px-2 py-3'
          : 'rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-2 pb-4 shadow-[var(--shadow-soft)]',
      )}
    >
      {/* 参考 IDE 资源管理器的顶栏结构：标题区移除，新建按钮浮在根节点行右侧；树整体贴近左侧边框 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1 pb-2">
        <div className="space-y-0.5">
          <div className="group/novel-row flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 transition hover:bg-[var(--surface-muted)]">
            <button
              type="button"
              onClick={() => setNovelExpanded((current) => !current)}
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
            {/* 参考 IDE 资源管理器：悬停树区域时浮出图标按钮组，悬停按钮有提示字；手机端无 hover 常驻 */}
            <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:transition-opacity md:group-hover/tree:opacity-100">
              {onCreateVolume ? <TreeHeaderButton label="新建卷" onClick={onCreateVolume}><FolderPlus className="h-3.5 w-3.5" /></TreeHeaderButton> : null}
              <TreeHeaderButton label="新建章节" onClick={onCreateChapter}><FilePlus2 className="h-3.5 w-3.5" /></TreeHeaderButton>
              <TreeHeaderButton label="新建计划" onClick={onCreatePlan}><NotebookPen className="h-3.5 w-3.5" /></TreeHeaderButton>
            </div>
          </div>

          {novelExpanded ? (
            <div className="ml-3.5 border-l border-[var(--border-subtle)] pl-1.5 md:border-transparent md:transition-colors md:group-hover/tree:border-[var(--border-subtle)]">
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

              <button
                type="button"
                onClick={() => setPlanFolderExpanded((current) => !current)}
                className="flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]"
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

              {planFolderExpanded ? (
                <div className="ml-3 border-l border-[var(--border-subtle)] pl-1.5 md:border-transparent md:transition-colors md:group-hover/tree:border-[var(--border-subtle)]">
                  {savedPlans.length > 0 ? (
                    savedPlans.map((plan, index) => (
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
                        onContextMenu={(event) => openTreeContextMenu(event, 'plan', plan.id, plan.title.trim() || `计划 ${savedPlans.length - index}`)}
                        className={cn(
                          'group flex items-center gap-1 rounded-[10px] border-t border-transparent transition',
                          selectedTreeItemId === `plan:${plan.id}` ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
                          dropTarget === `plan:${plan.id}` && 'border-t-[var(--text-primary)]',
                        )}
                      >
                        <GripVertical className="ml-1 h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100" />
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
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenPlanSettings(plan.id)}
                          className={cn(
                            'mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]',
                            // 手机端无 hover，小屏常驻显示；桌面端仅选中或悬停时显示
                            selectedTreeItemId === `plan:${plan.id}`
                              ? 'opacity-100'
                              : 'opacity-100 md:opacity-0 md:group-hover:opacity-100',
                          )}
                          aria-label="计划设置"
                          title="计划设置"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="px-2 py-2 text-xs leading-6 text-[var(--text-tertiary)]">
                      当前作品还没存入计划，点上方「新建计划」自己写，或用规划模式让 Agent 制定。
                    </div>
                  )}
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => setChapterFolderExpanded((current) => !current)}
                className="flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]"
              >
                {chapterFolderExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                )}
                <span className="truncate">全部章节</span>
                <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">共{volumes.length}卷{chapters.length}章</span>
              </button>

              {chapterFolderExpanded ? (
                <div className="ml-3.5 border-l border-[var(--border-subtle)] pl-1.5 md:border-transparent md:transition-colors md:group-hover/tree:border-[var(--border-subtle)]">
                  {volumeGroups.map(({ volume, chapters: volumeChapters }) => (
                    <div key={volume.id} className="py-0.5">
                      <div
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
                          'group/volume flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors',
                          dropTarget === `volume:${volume.id}` && 'border-[var(--border-strong)] bg-[var(--surface-muted)]',
                        )}
                      >
                        <NotebookText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                        <span className="truncate">第 {volume.orderIndex} 卷 · {volume.title}</span>
                        {onOpenVolumeSettings ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenVolumeSettings(volume.id)
                            }}
                            className="ml-auto inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[10px] text-[var(--text-tertiary)] transition hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                            aria-label={`卷设置：${volume.title}`}
                            title="卷设置"
                          >
                            <span className="md:group-hover/volume:hidden md:group-focus-within/volume:hidden">共{volumeChapters.length}章</span>
                            <span className="hidden items-center gap-1 md:group-hover/volume:inline-flex md:group-focus-within/volume:inline-flex">
                              <Settings2 className="h-3 w-3" />设置
                            </span>
                          </button>
                        ) : (
                          <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">共{volumeChapters.length}章</span>
                        )}
                      </div>
                      <div className="ml-2.5 border-l border-[var(--border-subtle)] pl-1 md:border-transparent md:transition-colors md:group-hover/tree:border-[var(--border-subtle)]">
                  {volumeChapters.map((chapter) => {
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
                            name: formatChapterTreeLabel(chapter),
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
                        onContextMenu={(event) => openTreeContextMenu(event, 'chapter', chapter.id, chapter.title.trim() || `第 ${chapter.orderInVolume} 章`)}
                        className={cn(
                          'group flex items-center gap-1 rounded-[10px] border-t border-transparent transition',
                          chapterActive ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
                          dropTarget === `chapter:${chapter.id}` && 'border-t-[var(--text-primary)]',
                        )}
                      >
                        <GripVertical className="ml-1 h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100" />
                        <button
                          type="button"
                          onClick={() => onSelectChapter(chapter.id)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] transition',
                            chapterActive
                              ? 'text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                          <span className="truncate">
                            {formatChapterTreeLabel(chapter)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenChapterSettings(chapter.id)}
                          className={cn(
                            'mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]',
                            chapterActive
                              ? 'opacity-100'
                              : 'opacity-100 md:opacity-0 md:group-hover:opacity-100',
                          )}
                          aria-label="章节设置"
                          title="章节设置"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                        {volumeChapters.length === 0 ? (
                          <p className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">空卷</p>
                        ) : null}
                      </div>
                    </div>
                  ))}
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
        <div
          className="fixed z-[190] w-40 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1 shadow-[0_18px_50px_rgba(15,23,42,.18)]"
          style={{ left: Math.min(contextMenu.x, window.innerWidth - 176), top: Math.min(contextMenu.y, window.innerHeight - 200) }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" className={treeMenuItem} onClick={() => { const target = contextMenu; setContextMenu(null); if (target.kind === 'chapter') onSelectChapter(target.id); else onSelectPlan(target.id) }}>
            <FileText className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />打开
          </button>
          <button type="button" className={treeMenuItem} onClick={() => { const target = contextMenu; setContextMenu(null); setRenameTarget({ kind: target.kind, id: target.id }); setRenameValue(target.title) }}>
            <PencilLine className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />重命名
          </button>
          <button type="button" className={treeMenuItem} onClick={() => { const target = contextMenu; setContextMenu(null); if (target.kind === 'chapter') onOpenChapterSettings(target.id); else onOpenPlanSettings(target.id) }}>
            <Settings2 className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />设置
          </button>
          <button type="button" className={cn(treeMenuItem, 'text-rose-600')} onClick={() => { const target = contextMenu; setContextMenu(null); if (target.kind === 'chapter') onRequestDeleteChapter?.(target.id); else onRequestDeletePlan?.(target.id) }}>
            <Trash2 className="h-3.5 w-3.5" />删除
          </button>
        </div>
      ) : null}

      {renameTarget ? (
        <div className="fixed inset-0 z-[195] flex items-center justify-center bg-black/25 p-4" onMouseDown={() => { setRenameTarget(null); setRenameValue('') }}>
          <form onSubmit={(event) => { event.preventDefault(); commitTreeRename() }} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-2xl">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">重命名{renameTarget.kind === 'chapter' ? '章节' : '计划'}</h2>
            <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={160} className="mt-4 h-10 w-full rounded-[9px] border border-[var(--border-subtle)] bg-transparent px-3 text-sm outline-none focus:border-[var(--border-strong)]" />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => { setRenameTarget(null); setRenameValue('') }} className="h-9 rounded-[9px] px-3 text-xs hover:bg-[var(--surface-muted)]">取消</button>
              <button type="submit" disabled={!renameValue.trim()} className="h-9 rounded-[9px] bg-[var(--surface-contrast)] px-4 text-xs font-medium text-[var(--text-contrast)] disabled:opacity-45">保存</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}
