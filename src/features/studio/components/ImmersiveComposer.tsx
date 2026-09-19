import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText as FileTextIcon,
  FolderDown,
  ImagePlus,
  MoreHorizontal,
  NotebookPen,
  PanelBottomOpen,
  Save,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react'

import LocalFirstTextarea from './LocalFirstTextarea'
import BottomSheet from '@/components/ui/BottomSheet'
import Button from '@/components/ui/Button'
import { useKeyboardInset } from '@/hooks/useMobileComposer'
import { cn } from '@/lib/utils'
import type { ChapterStatus, Novel, StudioPayload, Visibility } from '../../../../shared/contracts/index.js'
import type {
  ChapterDraftState,
  ChapterPendingReview,
  EditorSelectionState,
  PlanPendingReview,
  SaveState,
  WorkspaceDocumentView,
  WorkspacePlanFile,
} from '../types'
import ChapterSidebar from './ChapterSidebar'
import ChapterChangeReview, { NextReviewFilePill } from './ChapterChangeReview'
import PlanChangeReview from './PlanChangeReview'
import ChapterSettingsPanel from './ChapterSettingsPanel'
import PlanSettingsPanel from './PlanSettingsPanel'
import ConfirmDialog from './ConfirmDialog'
import { SaveStatusPill } from './StudioControls'
import WorkspaceNovelSwitcher from './WorkspaceNovelSwitcher'
import { PanelResizeHandle } from '../panel-resize'
import { useStudioPanelWidths } from '../panel-widths'

/** 手机端全屏面板 sheet 的内容页：编辑区是常驻基座，不再参与切换 */
type MobileSheetPanel = 'agent' | 'chapters' | 'cover' | 'meta'

type ImmersiveComposerProps = {
  currentNovelId: string
  novelTitle: string
  novelTitleMissing?: boolean
  novelOptions: Novel[]
  chapterDraft: ChapterDraftState | null
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
  workspaceDocument?: WorkspaceDocumentView | null
  saveState: SaveState
  saveMessage: string
  wordCountLabel: string
  onClose: () => void
  onSave: () => void
  onRetrySave?: () => void
  onSelectNovel: (novelId: string) => void
  onCreateNovel: () => void
  onEditNovelTitle?: () => void
  detailPreviewHref?: string
  previewHref?: string
  onSelectChapter: (chapterId: string) => void
  onSelectPlan: (planId: string) => void
  onDeletePlan: (planId: string) => void
  /** 作品树里点齿轮：切到该章并打开章节设置抽屉 */
  onOpenChapterSettings?: (chapterId: string) => void
  onOpenVolumeSettings?: (volumeId: string) => void
  /** 计划改名（计划设置面板内） */
  onRenamePlan: (planId: string, title: string) => void
  onSelectCatalog: () => void
  onCreateChapter: () => void
  onCreatePlan: () => void
  onDeleteChapter: () => void | Promise<void>
  onChange: (next: ChapterDraftState) => void
  onWorkspaceDocumentChange?: (next: { title: string; content: string }) => void
  onSelectionChange?: (next: EditorSelectionState) => void
  pendingChapterReview?: ChapterPendingReview | null
  pendingChapterReviewBusy?: boolean
  onKeepPendingReview?: () => void
  onRevertPendingReview?: () => void
  onAcceptReviewHunk?: (hunkIndex: number) => void
  onRejectReviewHunk?: (hunkIndex: number) => void
  /** 待审文件序号（1 基）与总数：审查条「文件 x/y」多章导航 */
  reviewFileIndex?: number
  reviewFileCount?: number
  onNavigateReviewFile?: (offset: 1 | -1) => void
  /** 当前章无待审但其它章还有待审时，展示「下一个文件」浮标 */
  pendingReviewRemaining?: number
  onGoToNextReviewFile?: () => void
  pendingPlanReview?: PlanPendingReview | null
  pendingPlanReviewBusy?: boolean
  onKeepPendingPlanReview?: () => void
  onRevertPendingPlanReview?: () => void
  onAcceptPlanReviewHunk?: (hunkIndex: number) => void
  onRejectPlanReviewHunk?: (hunkIndex: number) => void
  onOpenCover?: () => void
  onOpenMeta?: () => void
  onPublishNovel?: () => void
  onDeleteNovel?: () => void
  onExport?: () => void
  novelPublished?: boolean
  novelSaving?: boolean
  agentPanel: ReactNode
  taskSidebar?: ReactNode
  coverPanel?: ReactNode
  showCoverPanel?: boolean
  metaPanel?: ReactNode
  showMetaPanel?: boolean
  switchingNovel?: boolean
  novelsLoading?: boolean
}

export default function ImmersiveComposer({
  currentNovelId,
  novelTitle,
  novelTitleMissing = false,
  novelOptions,
  chapterDraft,
  chapters,
  volumes,
  savedPlans,
  selectedChapterId,
  selectedTreeItemId,
  catalogPreview,
  workspaceDocument = null,
  saveState,
  saveMessage,
  wordCountLabel,
  onClose,
  onSave,
  onRetrySave,
  onSelectNovel,
  onCreateNovel,
  onEditNovelTitle,
  detailPreviewHref,
  previewHref,
  onSelectChapter,
  onSelectPlan,
  onDeletePlan,
  onOpenChapterSettings,
  onOpenVolumeSettings,
  onRenamePlan,
  onSelectCatalog,
  onCreateChapter,
  onCreatePlan,
  onDeleteChapter,
  onChange,
  onWorkspaceDocumentChange,
  onSelectionChange,
  pendingChapterReview = null,
  pendingChapterReviewBusy = false,
  onKeepPendingReview,
  onRevertPendingReview,
  onAcceptReviewHunk,
  onRejectReviewHunk,
  reviewFileIndex = 1,
  reviewFileCount = 1,
  onNavigateReviewFile,
  pendingReviewRemaining = 0,
  onGoToNextReviewFile,
  pendingPlanReview = null,
  pendingPlanReviewBusy = false,
  onKeepPendingPlanReview,
  onRevertPendingPlanReview,
  onAcceptPlanReviewHunk,
  onRejectPlanReviewHunk,
  onOpenCover,
  onOpenMeta,
  onPublishNovel,
  onDeleteNovel,
  onExport,
  novelPublished = false,
  novelSaving = false,
  agentPanel,
  taskSidebar,
  coverPanel,
  showCoverPanel = false,
  metaPanel,
  showMetaPanel = false,
  switchingNovel = false,
  novelsLoading = false,
}: ImmersiveComposerProps) {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1280px)').matches : false,
  )
  const { panelWidths, beginPanelResize } = useStudioPanelWidths()
  // 手机端：编辑区是常驻纸面，Agent/章节/封面/设置收进全屏底部 sheet
  const [mobilePanel, setMobilePanel] = useState<MobileSheetPanel>('agent')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const keyboardInset = useKeyboardInset()
  const [showChapterSettings, setShowChapterSettings] = useState(false)
  const [planSettingsPlanId, setPlanSettingsPlanId] = useState<string | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
    onConfirm: () => void | Promise<void>
  } | null>(null)
  const currentIndex = chapters.findIndex((chapter) => chapter.id === selectedChapterId)
  const previousChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null
  const nextChapter = currentIndex >= 0 ? chapters[currentIndex + 1] ?? null : null
  // 当前正在看的计划：供「计划设置」入口与面板定位
  const activePlanId =
    workspaceDocument?.kind === 'plan' && selectedTreeItemId?.startsWith('plan:')
      ? selectedTreeItemId.slice('plan:'.length)
      : null
  const planSettingsPlan = planSettingsPlanId
    ? savedPlans.find((plan) => plan.id === planSettingsPlanId) ?? null
    : null

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 1280px)')
    setIsDesktop(mediaQuery.matches)

    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches)
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  // 注意：手机端编辑区常驻渲染，选中计划/目录时走 workspaceDocument，切章加载瞬间草稿短暂为空也有空态引导

  // 外部（发布引导、Agent 指令等）打开作品设置/封面面板时，手机端联动打开底部 sheet
  useEffect(() => {
    if (isDesktop) {
      return
    }
    if (showMetaPanel && metaPanel) {
      setMobilePanel('meta')
      setSheetOpen(true)
    } else if (showCoverPanel && coverPanel) {
      setMobilePanel('cover')
      setSheetOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, showMetaPanel, showCoverPanel])

  async function handleConfirmDialog() {
    if (!confirmDialog) {
      return
    }

    setSettingsBusy(true)
    try {
      await confirmDialog.onConfirm()
      setConfirmDialog(null)
    } finally {
      setSettingsBusy(false)
    }
  }

  function requestStatusAction(nextStatus: ChapterStatus) {
    if (!chapterDraft || chapterDraft.status === nextStatus) {
      return
    }

    const statusActionMap: Record<
      ChapterStatus,
      { title: string; description: string; confirmLabel: string }
    > = {
      draft: {
        title: '确认将状态设置为草稿',
        description: '执行后，这一章会切回草稿状态。',
        confirmLabel: '确认设置为草稿',
      },
      published: {
        title: '确认立即上架',
        description: '执行后，这一章会立刻切到上架状态。',
        confirmLabel: '确认上架',
      },
      scheduled: {
        title: '确认将状态设置为定时',
        description: '执行后，这一章会切到定时发布状态。',
        confirmLabel: '确认设置为定时',
      },
      archived: {
        title: '确认立即下架',
        description: '执行后，这一章会立刻从上架状态切到下架状态。',
        confirmLabel: '确认下架',
      },
    }

    const config = statusActionMap[nextStatus]
    setConfirmDialog({
      title: config.title,
      description: config.description,
      confirmLabel: config.confirmLabel,
      cancelLabel: '取消',
      tone: nextStatus === 'archived' ? 'danger' : 'default',
      onConfirm: () => {
        onChange({ ...chapterDraft, status: nextStatus })
      },
    })
  }

  function requestVisibilityAction(nextVisibility: Visibility) {
    if (!chapterDraft || chapterDraft.visibility === nextVisibility) {
      return
    }

    const visibilityActionMap: Record<
      Visibility,
      { title: string; description: string; confirmLabel: string }
    > = {
      private: {
        title: '确认将可见范围设置为个人',
        description: '执行后，这一章只对你自己可见。',
        confirmLabel: '确认设置为个人',
      },
      followers: {
        title: '确认将可见范围设置为关注可见',
        description: '执行后，这一章只对关注你的用户可见。',
        confirmLabel: '确认设置为关注可见',
      },
      public: {
        title: '确认将可见范围设置为公开',
        description: '执行后，这一章会对外公开可见。',
        confirmLabel: '确认设置为公开',
      },
    }

    const config = visibilityActionMap[nextVisibility]
    setConfirmDialog({
      title: config.title,
      description: config.description,
      confirmLabel: config.confirmLabel,
      cancelLabel: '取消',
      onConfirm: () => {
        onChange({ ...chapterDraft, visibility: nextVisibility })
      },
    })
  }

  function handleDeleteRequest() {
    if (!chapterDraft) {
      return
    }

    if (chapterDraft.status === 'published') {
      setConfirmDialog({
        title: '当前章节暂不可删除',
        description: '请先将章节下架后才可删除。',
        confirmLabel: '知道了',
        cancelLabel: '关闭',
        tone: 'default',
        onConfirm: () => undefined,
      })
      return
    }

    setConfirmDialog({
      title: '确认删除章节',
      description: '章节删除后内容将会丢失，您真的确定要删除吗？',
      confirmLabel: '确定删除',
      cancelLabel: '取消',
      tone: 'danger',
      onConfirm: async () => {
        await onDeleteChapter()
        setShowChapterSettings(false)
      },
    })
  }

  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[90] isolate overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      <div className="mx-auto flex h-full max-w-[140rem] flex-col px-3 pb-3 pt-[calc(var(--safe-top)+10px)] md:px-6 md:py-5">
        {isDesktop ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
            <div className="min-w-0 space-y-3">
            <WorkspaceNovelSwitcher
              currentNovelId={currentNovelId}
              currentNovelTitle={novelTitle}
              novels={novelOptions}
              busy={switchingNovel}
              loading={novelsLoading}
              onSelectNovel={onSelectNovel}
              onCreateNovel={onCreateNovel}
            />
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-[var(--text-secondary)]">{novelTitle}</p>
                {novelTitleMissing && onEditNovelTitle ? (
                  <button
                    type="button"
                    onClick={onEditNovelTitle}
                    className="inline-flex h-9 items-center rounded-full bg-[var(--surface-contrast)] px-4 text-sm font-medium text-[var(--text-contrast)] transition hover:bg-[var(--surface-contrast-hover)]"
                  >
                    去命名作品
                  </button>
                ) : null}
              </div>
              <h2 className="truncate text-lg font-semibold tracking-tight text-[var(--text-primary)] md:text-xl">
                {workspaceDocument?.title || chapterDraft?.title || '继续写作'}
              </h2>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SaveStatusPill state={saveState} message={saveMessage} onRetry={onRetrySave} />
            {detailPreviewHref ? (
              <Link
                to={detailPreviewHref}
                title="查看作品页"
                aria-label="查看作品页"
                className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--border-subtle)] text-[var(--text-primary)] transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
              >
                <FileTextIcon className="h-4 w-4" />
              </Link>
            ) : null}
            {onOpenCover ? (
              <Button
                variant={showCoverPanel ? 'secondary' : 'ghost'}
                onClick={onOpenCover}
                title="封面设计"
                aria-label="封面设计"
                className="h-10 w-10 border border-[var(--border-subtle)] px-0"
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
            ) : null}
            {onOpenMeta ? (
              <Button
                variant={showMetaPanel ? 'secondary' : 'ghost'}
                onClick={onOpenMeta}
                title="作品设置"
                aria-label="作品设置"
                className="h-10 w-10 border border-[var(--border-subtle)] px-0"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            ) : null}
            {onPublishNovel ? (
              <Button variant="secondary" onClick={onPublishNovel} disabled={novelSaving}>
                <Upload className="h-4 w-4" />
                {novelPublished ? '更新发布' : '发布'}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={onSave}
              disabled={!chapterDraft || pendingChapterReviewBusy || Boolean(pendingChapterReview)}
            >
              <Save className="h-4 w-4" />
              立即保存
            </Button>
            {onExport ? (
              <Button variant="secondary" onClick={onExport}>
                <FolderDown className="h-4 w-4" />
                一键导出
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              <ArrowLeft className="h-4 w-4" />
              退出沉浸
            </Button>
          </div>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-xs font-medium text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]"
            >
              <ArrowLeft className="h-4 w-4" />
              退出沉浸
            </button>
            <p className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-[var(--text-primary)]">
              {workspaceDocument?.title || chapterDraft?.title || novelTitle}
            </p>
            <SaveStatusPill compact state={saveState} message={saveMessage} onRetry={onRetrySave} />
          </div>
        )}

        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col pt-4',
            isDesktop &&
              'overflow-hidden rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] xl:grid',
          )}
          style={
            isDesktop
              ? {
                  // 与创作中心共享的三区拖拽宽度（章节树 / 内容 / Agent）
                  gridTemplateColumns:
                    showCoverPanel || showMetaPanel || taskSidebar
                      ? `${panelWidths.tree}px minmax(0,1fr) ${panelWidths.agent}px auto`
                      : `${panelWidths.tree}px minmax(0,1fr) ${panelWidths.agent}px`,
                  // 锁定唯一一行为容器高度，保证各列内部（尤其 Agent 消息流）自行滚动
                  gridTemplateRows: 'minmax(0, 1fr)',
                }
              : undefined
          }
        >
          {isDesktop ? (
            <div className={cn('flex h-full min-h-0 flex-col', isDesktop && 'relative border-r border-[var(--border-subtle)] bg-[var(--surface-default)] p-4')}>
              <ChapterSidebar
                embedded
                chapters={chapters}
                volumes={volumes}
                savedPlans={savedPlans}
                selectedChapterId={selectedChapterId}
                selectedTreeItemId={selectedTreeItemId}
                catalogPreview={catalogPreview}
                novelWordCountLabel={wordCountLabel}
                chapterCountLabel={`共 ${chapters.length} 章`}
                novelTitle={novelTitle}
                activeCoverLabel=""
                onSelectChapter={onSelectChapter}
                onSelectPlan={onSelectPlan}
                onOpenChapterSettings={(chapterId) => {
                  onOpenChapterSettings?.(chapterId)
                  setShowChapterSettings(true)
                }}
                onOpenPlanSettings={setPlanSettingsPlanId}
                onOpenVolumeSettings={onOpenVolumeSettings}
                onSelectCatalog={onSelectCatalog}
                onCreateChapter={onCreateChapter}
                onCreatePlan={onCreatePlan}
              />
              <PanelResizeHandle
                panel="tree"
                side="right"
                label="拖拽调整章节树宽度"
                onBegin={beginPanelResize}
              />
            </div>
          ) : null}

          {isDesktop ? (
            <div className={cn('flex h-full min-h-0 flex-col', isDesktop && 'border-r border-[var(--border-subtle)] px-5 py-5 xl:px-6')}>
              {workspaceDocument ? (
                <>
                  {/* 计划/目录文档的工具行：与章节的「章节设置」保持同一位置 */}
                  <div className="flex flex-wrap items-center justify-end gap-2 pb-4">
                    <Button variant="ghost" size="sm" onClick={onCreatePlan}>
                      <NotebookPen className="h-4 w-4" />
                      新建计划
                    </Button>
                    {activePlanId ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setPlanSettingsPlanId(activePlanId)}
                        className="bg-zinc-900 text-white hover:bg-zinc-800"
                      >
                        <Settings2 className="h-4 w-4" />
                        计划设置
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={onCreateChapter}>
                        <FilePlus2 className="h-4 w-4" />
                        新建章节
                      </Button>
                    )}
                  </div>
                  <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4">
                  {workspaceDocument.kind === 'plan' && pendingPlanReview ? (
                    <PlanChangeReview
                      review={pendingPlanReview}
                      busy={pendingPlanReviewBusy}
                      onKeep={onKeepPendingPlanReview ?? (() => undefined)}
                      onRevert={onRevertPendingPlanReview ?? (() => undefined)}
                      onAcceptHunk={onAcceptPlanReviewHunk}
                      onRejectHunk={onRejectPlanReviewHunk}
                      className="min-h-0 flex-1"
                    />
                  ) : (
                  <div className="flex min-h-0 flex-1 flex-col rounded-[28px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-6 py-6 md:px-8 md:py-8">
                    <div className="border-b border-[var(--border-subtle)] pb-5">
                      {workspaceDocument.editableTitle ? (
                        <input
                          value={workspaceDocument.title}
                          onChange={(event) =>
                            onWorkspaceDocumentChange?.({
                              title: event.target.value,
                              content: workspaceDocument.content,
                            })
                          }
                          className="w-full border-0 bg-transparent text-[1.18rem] font-semibold tracking-[0.01em] text-[var(--text-primary)] outline-none"
                          placeholder={workspaceDocument.kind === 'plan' ? '给这份创作计划命名' : '目录'}
                        />
                      ) : (
                        <p className="text-[1.18rem] font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                          {workspaceDocument.title}
                        </p>
                      )}
                      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                        {workspaceDocument.description}
                      </p>
                    </div>
                    {workspaceDocument.editableContent ? (
                      <LocalFirstTextarea
                        value={workspaceDocument.content}
                        resetKey={workspaceDocument.id}
                        onCommit={(content) => onWorkspaceDocumentChange?.({ title: workspaceDocument.title, content })}
                        rows={24}
                        className="mt-5 min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-8 text-[var(--text-primary)] outline-none"
                        placeholder={workspaceDocument.kind === 'plan' ? '继续完善这份创作计划。' : '在这里维护目录内容。'}
                      />
                    ) : (
                      <div className="mt-5 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm leading-8 text-[var(--text-primary)]">
                        {workspaceDocument.content}
                      </div>
                    )}
                  </div>
                  )}
                  </div>
                </>
              ) : chapterDraft ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
                    <SaveStatusPill state={saveState} message={saveMessage} onRetry={onRetrySave} />
                    <div className="flex flex-wrap items-center gap-2">
                      {!isDesktop && onPublishNovel ? (
                        <Button variant="secondary" size="sm" onClick={onPublishNovel} disabled={novelSaving}>
                          <Upload className="h-4 w-4" />
                          {novelPublished ? '更新发布' : '发布'}
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={onCreateChapter}>
                        <FilePlus2 className="h-4 w-4" />
                        新建章节
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setShowChapterSettings((current) => !current)}
                        className="bg-zinc-900 text-white hover:bg-zinc-800"
                      >
                        <Settings2 className="h-4 w-4" />
                        章节设置
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => previousChapter && onSelectChapter(previousChapter.id)}
                        disabled={!previousChapter}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        上一章
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => nextChapter && onSelectChapter(nextChapter.id)}
                        disabled={!nextChapter}
                      >
                        下一章
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4">
                    {pendingChapterReview ? (
                      <ChapterChangeReview
                        review={pendingChapterReview}
                        busy={pendingChapterReviewBusy}
                        onKeep={onKeepPendingReview ?? (() => undefined)}
                        onRevert={onRevertPendingReview ?? (() => undefined)}
                        onAcceptHunk={onAcceptReviewHunk}
                        onRejectHunk={onRejectReviewHunk}
                        fileIndex={reviewFileIndex}
                        fileCount={reviewFileCount}
                        onNavigateFile={onNavigateReviewFile}
                        className="min-h-0 flex-1"
                      />
                    ) : (
                      <div className="relative flex min-h-0 flex-1 flex-col rounded-[28px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-6 py-6 md:px-8 md:py-8">
                        <div className="border-b border-[var(--border-subtle)] pb-5">
                          <p className="text-[1.18rem] font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                            {chapterDraft.title.trim() || `第 ${chapterDraft.orderIndex} 章`}
                          </p>
                        </div>
                        <LocalFirstTextarea
                          value={chapterDraft.content}
                          resetKey={chapterDraft.id}
                          onCommit={(content) => onChange({ ...chapterDraft, content })}
                          onSelectionChange={onSelectionChange}
                          rows={24}
                          className="studio-editor-content mt-5 min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent text-[var(--text-primary)] outline-none"
                          placeholder="继续写这一章的正文。"
                        />
                        {onGoToNextReviewFile ? (
                          <NextReviewFilePill count={pendingReviewRemaining} onClick={onGoToNextReviewFile} />
                        ) : null}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-[28px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-default)] px-6 py-10">
                  <div className="max-w-md space-y-4 text-center">
                    <div>
                      <h3 className="text-lg font-semibold text-[var(--text-primary)]">沉浸区已经打开</h3>
                      <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                        现在可以先和 Agent 继续对话，也可以新建章节或切到已有章节开始写作。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button onClick={onCreateChapter} variant="secondary">
                        <FilePlus2 className="h-4 w-4" />
                        新建章节
                      </Button>
                      {chapters[0] ? (
                        <Button onClick={() => onSelectChapter(chapters[0].id)} variant="ghost">
                          选择现有章节
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {!isDesktop ? (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-24 [-webkit-overflow-scrolling:touch]">
                {workspaceDocument ? (
                  workspaceDocument.kind === 'plan' && pendingPlanReview ? (
                    <PlanChangeReview
                      review={pendingPlanReview}
                      busy={pendingPlanReviewBusy}
                      onKeep={onKeepPendingPlanReview ?? (() => undefined)}
                      onRevert={onRevertPendingPlanReview ?? (() => undefined)}
                      onAcceptHunk={onAcceptPlanReviewHunk}
                      onRejectHunk={onRejectPlanReviewHunk}
                      className="min-h-[60vh]"
                    />
                  ) : (
                    <>
                      <div className="border-b border-[var(--border-subtle)] pb-3">
                        {workspaceDocument.editableTitle ? (
                          <input
                            value={workspaceDocument.title}
                            onChange={(event) =>
                              onWorkspaceDocumentChange?.({
                                title: event.target.value,
                                content: workspaceDocument.content,
                              })
                            }
                            className="w-full border-0 bg-transparent text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)] outline-none"
                            placeholder={workspaceDocument.kind === 'plan' ? '给这份创作计划命名' : '目录'}
                          />
                        ) : (
                          <p className="text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                            {workspaceDocument.title}
                          </p>
                        )}
                        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{workspaceDocument.description}</p>
                      </div>
                      {workspaceDocument.editableContent ? (
                        <LocalFirstTextarea
                          autoGrow
                          value={workspaceDocument.content}
                          resetKey={workspaceDocument.id}
                          onCommit={(content) => onWorkspaceDocumentChange?.({ title: workspaceDocument.title, content })}
                          wrapperClassName="mt-3"
                          className="studio-editor-content w-full bg-transparent composer-body-text text-[var(--text-primary)] outline-none"
                          placeholder={workspaceDocument.kind === 'plan' ? '继续完善这份创作计划。' : '在这里维护目录内容。'}
                        />
                      ) : (
                        <div className="studio-editor-content mt-3 whitespace-pre-wrap break-words composer-body-text text-[var(--text-primary)]">
                          {workspaceDocument.content}
                        </div>
                      )}
                    </>
                  )
                ) : chapterDraft ? (
                  pendingChapterReview ? (
                    <ChapterChangeReview
                      review={pendingChapterReview}
                      busy={pendingChapterReviewBusy}
                      onKeep={onKeepPendingReview ?? (() => undefined)}
                      onRevert={onRevertPendingReview ?? (() => undefined)}
                      onAcceptHunk={onAcceptReviewHunk}
                      onRejectHunk={onRejectReviewHunk}
                      fileIndex={reviewFileIndex}
                      fileCount={reviewFileCount}
                      onNavigateFile={onNavigateReviewFile}
                      className="min-h-[60vh]"
                    />
                  ) : (
                    <>
                      <p className="border-b border-[var(--border-subtle)] pb-3 text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                        {chapterDraft.title.trim() || `第 ${chapterDraft.orderIndex} 章`}
                      </p>
                      <LocalFirstTextarea
                        autoGrow
                        value={chapterDraft.content}
                        resetKey={chapterDraft.id}
                        onCommit={(content) => onChange({ ...chapterDraft, content })}
                        onSelectionChange={onSelectionChange}
                        wrapperClassName="mt-3"
                        className="studio-editor-content w-full bg-transparent composer-body-text text-[var(--text-primary)] outline-none"
                        placeholder="继续写这一章的正文。"
                      />
                    </>
                  )
                ) : (
                  <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
                    <h3 className="text-lg font-semibold text-[var(--text-primary)]">沉浸区已经打开</h3>
                    <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                      现在可以先和 Agent 继续对话，也可以新建章节或切到已有章节开始写作。
                    </p>
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                      <Button onClick={onCreateChapter} variant="secondary">
                        <FilePlus2 className="h-4 w-4" />
                        新建章节
                      </Button>
                      {chapters[0] ? (
                        <Button onClick={() => onSelectChapter(chapters[0].id)} variant="ghost">
                          选择现有章节
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
              {!workspaceDocument && chapterDraft && !pendingChapterReview && onGoToNextReviewFile ? (
                <NextReviewFilePill count={pendingReviewRemaining} onClick={onGoToNextReviewFile} />
              ) : null}
            </div>
          ) : null}

          {isDesktop ? (
            <div className={cn('flex min-h-0 flex-1 flex-col', isDesktop && 'relative border-r border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 py-4')}>
              {isDesktop ? (
                <PanelResizeHandle
                  panel="agent"
                  side="left"
                  label="拖拽调整 Agent 对话区宽度"
                  onBegin={beginPanelResize}
                />
              ) : null}
              <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', !isDesktop && 'rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-4 shadow-[var(--shadow-soft)]')}>
                {agentPanel}
              </div>
            </div>
          ) : null}

          {isDesktop && showCoverPanel && coverPanel ? (
            <div className="min-h-0 overflow-hidden">{coverPanel}</div>
          ) : isDesktop && showMetaPanel && metaPanel ? (
            <div className="min-h-0 overflow-hidden">{metaPanel}</div>
          ) : isDesktop && taskSidebar ? (
            <div className="min-h-0 overflow-hidden">{taskSidebar}</div>
          ) : null}

        </div>
      </div>

      {!isDesktop ? (
        <div
          className={cn(
            'fixed inset-x-0 z-20 border-t border-[var(--border-subtle)] bg-[var(--app-bg)] px-3 pt-2',
            keyboardInset > 0 ? 'pb-2' : 'pb-[max(var(--safe-bottom),8px)]',
          )}
          style={{ bottom: keyboardInset }}
        >
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-[var(--text-tertiary)]">{wordCountLabel}</span>
            <div className="relative flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                aria-label="更多操作"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-muted)]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {mobileMenuOpen ? (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMobileMenuOpen(false)} aria-hidden />
                  <div className="absolute bottom-full right-0 z-40 mb-2 w-44 overflow-hidden rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] py-1 shadow-[0_16px_40px_rgba(15,23,42,0.16)]">
                    {/* 设置入口二选一：当前是计划文档显示「计划设置」，否则是章节显示「章节设置」 */}
                    {activePlanId ? (
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMenuOpen(false)
                          setPlanSettingsPlanId(activePlanId)
                        }}
                        className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
                      >
                        <Settings2 className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                        计划设置
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!chapterDraft}
                        onClick={() => {
                          setMobileMenuOpen(false)
                          setShowChapterSettings(true)
                        }}
                        className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)] disabled:opacity-40"
                      >
                        <Settings2 className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                        章节设置
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false)
                        onCreateChapter()
                      }}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
                    >
                      <FilePlus2 className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                      新建章节
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false)
                        onCreatePlan()
                      }}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
                    >
                      <NotebookPen className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                      新建计划
                    </button>
                    <button
                      type="button"
                      disabled={!previousChapter}
                      onClick={() => {
                        setMobileMenuOpen(false)
                        if (previousChapter) {
                          onSelectChapter(previousChapter.id)
                        }
                      }}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)] disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                      上一章
                    </button>
                    <button
                      type="button"
                      disabled={!nextChapter}
                      onClick={() => {
                        setMobileMenuOpen(false)
                        if (nextChapter) {
                          onSelectChapter(nextChapter.id)
                        }
                      }}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)] disabled:opacity-40"
                    >
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                      下一章
                    </button>
                    {onPublishNovel ? (
                      <button
                        type="button"
                        disabled={novelSaving}
                        onClick={() => {
                          setMobileMenuOpen(false)
                          onPublishNovel()
                        }}
                        className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)] disabled:opacity-40"
                      >
                        <Upload className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                        {novelPublished ? '更新发布' : '发布作品'}
                      </button>
                    ) : null}
                    {onExport ? (
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMenuOpen(false)
                          onExport()
                        }}
                        className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
                      >
                        <FolderDown className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                        一键导出
                      </button>
                    ) : null}
                    {onDeleteNovel ? (
                      <>
                        <div className="my-1 border-t border-[var(--border-subtle)]" />
                        <button
                          type="button"
                          disabled={novelSaving}
                          onClick={() => {
                            setMobileMenuOpen(false)
                            onDeleteNovel()
                          }}
                          className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[rgb(153,27,27)] transition-colors active:bg-[rgba(127,29,29,0.08)] disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4 shrink-0" />
                          删除作品
                        </button>
                      </>
                    ) : null}
                  </div>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className="inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3.5 text-sm font-medium text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
              >
                <PanelBottomOpen className="h-4 w-4" />
                面板
              </button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onSave}
                disabled={!chapterDraft || pendingChapterReviewBusy || Boolean(pendingChapterReview)}
              >
                <Save className="h-4 w-4" />
                保存
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!isDesktop ? (
        <BottomSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          height="full"
          zIndexClassName="z-[100]"
          contentClassName="flex flex-col overflow-hidden"
        >
          <div className="mx-4 mb-3 flex shrink-0 gap-1 rounded-full bg-[var(--surface-muted)] p-1">
            {(
              [
                ['agent', 'Agent'],
                ['chapters', '章节'],
                ...(coverPanel ? [['cover', '封面']] : []),
                ...(metaPanel ? [['meta', '设置']] : []),
              ] as Array<[MobileSheetPanel, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setMobilePanel(key)}
                className={cn(
                  'h-9 min-w-0 flex-1 rounded-full text-sm font-medium transition-colors',
                  mobilePanel === key
                    ? 'bg-[var(--surface-default)] text-[var(--text-primary)] shadow-[var(--shadow-soft)]'
                    : 'text-[var(--text-secondary)]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-1">
            {mobilePanel === 'agent' ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{agentPanel}</div>
            ) : null}
            {mobilePanel === 'chapters' ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {previewHref ? (
                  <Link
                    to={previewHref}
                    onClick={() => setSheetOpen(false)}
                    className="mb-2 inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] text-sm font-medium text-[var(--text-primary)] transition active:bg-[var(--surface-muted)]"
                  >
                    <BookOpen className="h-4 w-4" />
                    预览阅读
                  </Link>
                ) : null}
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ChapterSidebar
                    embedded
                    chapters={chapters}
                    volumes={volumes}
                    savedPlans={savedPlans}
                    selectedChapterId={selectedChapterId}
                    selectedTreeItemId={selectedTreeItemId}
                    catalogPreview={catalogPreview}
                    novelWordCountLabel={wordCountLabel}
                    chapterCountLabel={`共 ${chapters.length} 章`}
                    novelTitle={novelTitle}
                    activeCoverLabel=""
                    onSelectChapter={(chapterId) => {
                      onSelectChapter(chapterId)
                      setSheetOpen(false)
                    }}
                    onSelectPlan={(planId) => {
                      onSelectPlan(planId)
                      setSheetOpen(false)
                    }}
                    onOpenChapterSettings={(chapterId) => {
                      onOpenChapterSettings?.(chapterId)
                      setShowChapterSettings(true)
                      setSheetOpen(false)
                    }}
                    onOpenVolumeSettings={(volumeId) => {
                      onOpenVolumeSettings?.(volumeId)
                      setSheetOpen(false)
                    }}
                    onOpenPlanSettings={(planId) => {
                      setPlanSettingsPlanId(planId)
                      setSheetOpen(false)
                    }}
                    onSelectCatalog={() => {
                      onSelectCatalog()
                      setSheetOpen(false)
                    }}
                    onCreateChapter={() => {
                      onCreateChapter()
                      setSheetOpen(false)
                    }}
                    onCreatePlan={() => {
                      onCreatePlan()
                      setSheetOpen(false)
                    }}
                  />
                </div>
              </div>
            ) : null}
            {mobilePanel === 'cover' && coverPanel ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{coverPanel}</div>
            ) : null}
            {mobilePanel === 'meta' && metaPanel ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{metaPanel}</div>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}

      {chapterDraft && showChapterSettings ? (
        <ChapterSettingsPanel
          chapterDraft={chapterDraft}
          onChange={onChange}
          onRequestStatusAction={requestStatusAction}
          onRequestVisibilityAction={requestVisibilityAction}
          onRequestDelete={handleDeleteRequest}
          onClose={() => setShowChapterSettings(false)}
          overlayClassName="z-[110]"
        />
      ) : null}
      {planSettingsPlan ? (
        <PlanSettingsPanel
          plan={planSettingsPlan}
          onRename={(title) => onRenamePlan(planSettingsPlan.id, title)}
          onRequestDelete={() => {
            setPlanSettingsPlanId(null)
            onDeletePlan(planSettingsPlan.id)
          }}
          onClose={() => setPlanSettingsPlanId(null)}
          overlayClassName="z-[110]"
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title ?? ''}
        description={confirmDialog?.description ?? ''}
        confirmLabel={confirmDialog?.confirmLabel}
        cancelLabel={confirmDialog?.cancelLabel}
        tone={confirmDialog?.tone}
        busy={settingsBusy}
        onCancel={() => {
          if (settingsBusy) {
            return
          }
          setConfirmDialog(null)
        }}
        onConfirm={() => void handleConfirmDialog()}
      />
    </div>,
    document.body,
  )
}
