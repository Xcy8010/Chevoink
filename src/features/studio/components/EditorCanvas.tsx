import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, FilePenLine, FolderPlus, LoaderCircle, MessageSquarePlus, MoreHorizontal, RefreshCcw, Settings2, Upload } from 'lucide-react'

import Button from '@/components/ui/Button'
import type { ChapterStatus } from '../../../../shared/contracts/index.js'

import { type ChapterDraftState, type ChapterPendingReview, type PlanPendingReview, type SaveState, type WorkspaceDocumentView } from '../types'
import ChapterChangeReview, { NextReviewFilePill } from './ChapterChangeReview'
import PlanChangeReview from './PlanChangeReview'
import PlanMarkdownEditor from './PlanMarkdownEditor'
import LocalFirstTextarea from './LocalFirstTextarea'
import { useStreamingAutoFollow } from './useStreamingAutoFollow'

type EditorCanvasProps = {
  chapterDraft: ChapterDraftState | null
  workspaceDocument?: WorkspaceDocumentView | null
  chapterLoading: boolean
  chapterErrorMessage: string | null
  chapterSaveState: SaveState
  chapterSaveMessage: string
  latestWordCountLabel: string
  selectedCommentCount: number
  onSelectionChange?: (next: { start: number; end: number; text: string }) => void
  selection?: { start: number; end: number; text: string }
  onAddSelection?: () => void
  onSave: () => void
  onRetryLoad: () => void
  onCreateChapter: () => void
  onCreateVolume?: () => void
  onOpenChapterSettings: () => void
  /** 打开当前计划的设置抽屉（改名 / 删除） */
  onOpenPlanSettings?: () => void
  /** 发布作品入口（仅手机端工具行展示；桌面端由 StudioToolbar 承担） */
  onPublishNovel?: () => void
  novelPublished?: boolean
  onStatusChange: (nextStatus: ChapterStatus) => void
  onChange: (next: ChapterDraftState) => void
  onWorkspaceDocumentChange?: (next: { title: string; content: string }) => void
  onRetrySave?: () => void
  onEditorBlur?: () => void
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
  /** Mobile and desktop use distinct toolbars over the same document. */
  variant?: 'default' | 'mobile'
  onSelectMobileChapter?: () => void
  mobileScope?: string | null
  /** Agent 正在流式生成的只读正文；未落库前覆盖显示但不触发用户草稿。 */
  streamingContent?: string
  writeLocked?: boolean
}

const editorClassName = 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden'
const desktopToolbarClassName = 'flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--border-subtle)] px-4 py-1.5 xl:px-6'

export default function EditorCanvas({
  chapterDraft: sourceChapterDraft,
  workspaceDocument: sourceWorkspaceDocument = null,
  chapterLoading,
  chapterErrorMessage,
  chapterSaveState,
  chapterSaveMessage,
  latestWordCountLabel,
  onSelectionChange,
  selection,
  onAddSelection,
  onSave: _onSave,
  onRetryLoad,
  onCreateChapter,
  onCreateVolume,
  onOpenChapterSettings,
  onOpenPlanSettings,
  onPublishNovel,
  novelPublished = false,
  onStatusChange: _onStatusChange,
  onChange: sourceOnChange,
  onWorkspaceDocumentChange: sourceOnWorkspaceDocumentChange,
  onRetrySave: _onRetrySave,
  onEditorBlur,
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
  variant = 'default',
  onSelectMobileChapter,
  mobileScope,
  streamingContent,
  writeLocked = false,
}: EditorCanvasProps) {
  const chapterDraft = sourceChapterDraft && streamingContent !== undefined
    ? { ...sourceChapterDraft, content: streamingContent }
    : sourceChapterDraft
  const workspaceDocument = sourceWorkspaceDocument && streamingContent !== undefined
    ? { ...sourceWorkspaceDocument, content: streamingContent, editableContent: false, editableTitle: false }
    : sourceWorkspaceDocument
  const onChange = writeLocked ? () => {} : sourceOnChange
  const onWorkspaceDocumentChange = writeLocked ? undefined : sourceOnWorkspaceDocumentChange
  const isMobile = variant === 'mobile'
  const streaming = streamingContent !== undefined
  const streamingContainer = useStreamingAutoFollow<HTMLElement>(streaming, streamingContent)
  const streamingTextarea = useStreamingAutoFollow<HTMLTextAreaElement>(streaming, streamingContent)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mobileChapterScope = JSON.stringify([mobileScope, chapterDraft?.id])
  const mobileReviewScroll = useRef<{ scope: string; top: number } | null>(null)
  const reviewingChapter = Boolean(pendingChapterReview)
  const mobileChapterEditor = isMobile && !workspaceDocument && Boolean(chapterDraft)
  const rememberMobileReviewScroll = useCallback((top: number) => {
    mobileReviewScroll.current = { scope: mobileChapterScope, top }
  }, [mobileChapterScope])

  const editorViewport = streamingContainer.nodeRef
  useLayoutEffect(() => {
    if (!mobileChapterEditor || reviewingChapter) return
    const viewport = editorViewport.current
    const previous = mobileReviewScroll.current
    if (viewport) viewport.scrollTop = previous?.scope === mobileChapterScope ? previous.top : 0
    mobileReviewScroll.current = null
  }, [editorViewport, mobileChapterEditor, mobileChapterScope, reviewingChapter])

  if (workspaceDocument) {
    if (isMobile) {
      return (
        <section ref={streamingContainer.ref} onScroll={streamingContainer.onScroll} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-1 pb-8 [-webkit-overflow-scrolling:touch]">
          <div className="flex items-start justify-between gap-2 pb-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                {workspaceDocument.editableTitle ? null : workspaceDocument.title}
              </p>
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
              ) : null}
              <p className="text-sm leading-6 text-[var(--text-secondary)]">{workspaceDocument.description}</p>
            </div>
            {workspaceDocument.kind === 'plan' ? (
              <Button onClick={() => onOpenPlanSettings?.()} variant="primary" size="sm" className="shrink-0">
                <Settings2 className="h-4 w-4" />
                计划设置
              </Button>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
              {onCreateVolume ? <Button onClick={onCreateVolume} variant="ghost" size="sm">
                <FolderPlus className="h-4 w-4" />
                新建卷
              </Button> : null}
              <Button onClick={onCreateChapter} variant="ghost" size="sm">
                <FilePenLine className="h-4 w-4" />
                新建章节
              </Button>
              </div>
            )}
          </div>
          {workspaceDocument.kind === 'plan' && chapterSaveState === 'error' ? <p role="alert" className="mb-3 text-sm text-[rgb(153,27,27)]">{chapterSaveMessage}</p> : null}
          {workspaceDocument.kind === 'plan' && pendingPlanReview ? (
            <PlanChangeReview
              review={pendingPlanReview}
              busy={pendingPlanReviewBusy}
              onKeep={onKeepPendingPlanReview ?? (() => undefined)}
              onRevert={onRevertPendingPlanReview ?? (() => undefined)}
              onAcceptHunk={onAcceptPlanReviewHunk}
              onRejectHunk={onRejectPlanReviewHunk}
              className="min-h-[50vh]"
            />
          ) : workspaceDocument.kind === 'plan' ? (
            <PlanMarkdownEditor
              documentId={workspaceDocument.id}
              markdown={workspaceDocument.content}
              editable={workspaceDocument.editableContent}
              mobile
              onChange={(content) => onWorkspaceDocumentChange?.({ title: workspaceDocument.title, content })}
              onBlur={onEditorBlur}
              onSelectionChange={onSelectionChange}
              streaming={streaming}
            />
          ) : workspaceDocument.editableContent ? (
            <LocalFirstTextarea
              autoGrow
              data-kb-reveal="off"
              value={workspaceDocument.content}
              resetKey={workspaceDocument.id}
              onCommit={(content) => onWorkspaceDocumentChange?.({ title: workspaceDocument.title, content })}
              className="w-full bg-transparent composer-body-text text-[var(--text-primary)] outline-none"
              placeholder="在这里维护目录内容。"
            />
          ) : (
            <div className="whitespace-pre-wrap break-words composer-body-text text-[var(--text-primary)]">
              {workspaceDocument.content}
            </div>
          )}
        </section>
      )
    }
    return (
      <section className={editorClassName}>
        <header className={desktopToolbarClassName}>
          <div className="min-w-0 flex-1">
            {workspaceDocument.editableTitle ? (
              <input
                aria-label={workspaceDocument.kind === 'plan' ? '计划名称' : '目录名称'}
                value={workspaceDocument.title}
                onChange={(event) =>
                  onWorkspaceDocumentChange?.({
                    title: event.target.value,
                    content: workspaceDocument.content,
                  })
                }
                className="w-full rounded-sm border-0 bg-transparent text-sm font-semibold text-[var(--text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
                placeholder={workspaceDocument.kind === 'plan' ? '给这份创作计划命名' : '目录'}
              />
            ) : <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]" title={workspaceDocument.title}>{workspaceDocument.title}</h1>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
          {selection?.text.trim() ? (
            <Button onClick={onAddSelection} variant="ghost" size="sm">
              <MessageSquarePlus className="h-4 w-4" />
              添加到输入框
            </Button>
          ) : null}
          {workspaceDocument.kind === 'plan' ? (
            <Button onClick={() => onOpenPlanSettings?.()} variant="ghost" size="sm">
              <Settings2 className="h-4 w-4" />
              计划设置
            </Button>
          ) : (
            <div className="flex items-center gap-1">
            {onCreateVolume ? <Button onClick={onCreateVolume} variant="ghost" size="sm">
              <FolderPlus className="h-4 w-4" />
              新建卷
            </Button> : null}
            <Button onClick={onCreateChapter} variant="ghost" size="sm">
              <FilePenLine className="h-4 w-4" />
              新建章节
            </Button>
            </div>
          )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {workspaceDocument.kind === 'plan' && chapterSaveState === 'error' ? <p role="alert" className="px-4 py-2 text-sm text-[rgb(153,27,27)] xl:px-6">{chapterSaveMessage}</p> : null}
          {workspaceDocument.kind === 'plan' && pendingPlanReview ? (
            <PlanChangeReview
              inline
              review={pendingPlanReview}
              busy={pendingPlanReviewBusy}
              onKeep={onKeepPendingPlanReview ?? (() => undefined)}
              onRevert={onRevertPendingPlanReview ?? (() => undefined)}
              onAcceptHunk={onAcceptPlanReviewHunk}
              onRejectHunk={onRejectPlanReviewHunk}
              className="min-h-0 flex-1"
            />
          ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 py-4 xl:px-6">
            {workspaceDocument.kind === 'plan' ? (
              <PlanMarkdownEditor
                documentId={workspaceDocument.id}
                markdown={workspaceDocument.content}
                editable={workspaceDocument.editableContent}
                onChange={(content) => onWorkspaceDocumentChange?.({ title: workspaceDocument.title, content })}
                onBlur={onEditorBlur}
                onSelectionChange={onSelectionChange}
                streaming={streaming}
              />
            ) : workspaceDocument.editableContent ? (
              <LocalFirstTextarea
                ref={streamingTextarea.ref}
                onScroll={streamingTextarea.onScroll}
                data-kb-reveal="off"
                value={workspaceDocument.content}
                resetKey={workspaceDocument.id}
                onCommit={(content) => onWorkspaceDocumentChange?.({ title: workspaceDocument.title, content })}
                rows={20}
                className="studio-editor-content min-h-0 flex-1 resize-none overflow-y-auto bg-transparent text-[var(--text-primary)] outline-none"
                placeholder="在这里维护目录内容。"
              />
            ) : (
              <div className="studio-editor-content whitespace-pre-wrap break-words text-[var(--text-primary)]">
                {workspaceDocument.content}
              </div>
            )}
          </div>
          )}
        </div>
      </section>
    )
  }

  if (chapterLoading && !chapterDraft) {
    return (
      <section className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
          <LoaderCircle className="h-5 w-5 animate-spin" />
          <span>正在加载章节内容...</span>
        </div>
      </section>
    )
  }

  if (chapterErrorMessage && !chapterDraft) {
    return (
      <section className="space-y-4 p-6">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">这一章暂时无法打开</h2>
          <p className="text-sm leading-7 text-[var(--text-secondary)]">{chapterErrorMessage}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRetryLoad} variant="secondary">
            <RefreshCcw className="h-4 w-4" />
            重新加载
          </Button>
          <Button onClick={onCreateChapter} variant="ghost">
            <FilePenLine className="h-4 w-4" />
            新建章节
          </Button>
        </div>
      </section>
    )
  }

  if (!chapterDraft) {
    return (
      <section className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">从章节目录中选择一章</h2>
          <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">也可以直接新建章节，马上开始写作。</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button onClick={onCreateChapter} variant="secondary">
              <FilePenLine className="h-4 w-4" />
              新建章节
            </Button>
          </div>
        </div>
      </section>
    )
  }

  if (isMobile) {
    const chapterTitle = (pendingChapterReview?.after.title ?? chapterDraft.title).trim() || `第 ${chapterDraft.orderIndex} 章`
    const menuItemClassName = 'flex min-h-11 w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)] disabled:opacity-40'
    const runMenuAction = (action: () => void) => {
      setMobileMenuOpen(false)
      action()
    }

    return (
      <section className="flex min-h-0 flex-1 flex-col bg-[var(--surface-default)]">
        <div data-studio-region="mobile-writing-navigation" className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] pl-4 pr-2">
          {onSelectMobileChapter ? (
            <button
              type="button"
              onClick={() => runMenuAction(onSelectMobileChapter)}
              aria-label={`选择章节，当前：${chapterTitle}`}
              className="-ml-1 inline-flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-sm font-medium text-[var(--text-primary)] active:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)]"
            >
              <span className="truncate">{chapterTitle}</span>
              <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">{chapterTitle}</span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-[var(--text-secondary)]">{latestWordCountLabel}</span>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label="更多操作"
              aria-expanded={mobileMenuOpen}
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] active:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {mobileMenuOpen ? (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMobileMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full z-40 mt-1 max-h-[50dvh] w-52 overflow-y-auto overscroll-contain rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] py-1 shadow-[var(--shadow-modal)]">
                  {pendingChapterReview ? (
                    <div className="border-b border-[var(--border-subtle)] pb-1">
                      {onKeepPendingReview ? (
                        <button type="button" disabled={pendingChapterReviewBusy} onClick={() => runMenuAction(onKeepPendingReview)} className={menuItemClassName}>保留整章</button>
                      ) : null}
                      {onRevertPendingReview ? (
                        <button type="button" disabled={pendingChapterReviewBusy} onClick={() => runMenuAction(onRevertPendingReview)} className={menuItemClassName}>
                          {pendingChapterReview.rollbackSnapshot.kind === 'remove_created_chapter' ? '撤回新建章节' : '撤回本次整章修改'}
                        </button>
                      ) : null}
                      {reviewFileCount > 1 && onNavigateReviewFile ? (
                        <>
                          <p className="px-4 pt-2 text-xs tabular-nums text-[var(--text-secondary)]">待审章节 {reviewFileIndex} / {reviewFileCount}</p>
                          <button type="button" disabled={pendingChapterReviewBusy} onClick={() => runMenuAction(() => onNavigateReviewFile(-1))} className={menuItemClassName}>上一待审章节</button>
                          <button type="button" disabled={pendingChapterReviewBusy} onClick={() => runMenuAction(() => onNavigateReviewFile(1))} className={menuItemClassName}>下一待审章节</button>
                        </>
                      ) : null}
                    </div>
                  ) : pendingReviewRemaining > 0 && onGoToNextReviewFile ? (
                    <button type="button" onClick={() => runMenuAction(onGoToNextReviewFile)} className={menuItemClassName}>下一待审章节</button>
                  ) : null}
                  <button type="button" onClick={() => runMenuAction(onOpenChapterSettings)} className={menuItemClassName}>
                    <Settings2 aria-hidden="true" className="h-4 w-4" />
                    章节设置
                  </button>
                  {onPublishNovel ? (
                    <button type="button" onClick={() => runMenuAction(onPublishNovel)} className={menuItemClassName}>
                      <Upload aria-hidden="true" className="h-4 w-4" />
                      {novelPublished ? '更新发布' : '发布作品'}
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
        {pendingChapterReview ? (
          <ChapterChangeReview
            key={JSON.stringify([mobileChapterScope, pendingChapterReview.id])}
            mobile
            onMobileScroll={rememberMobileReviewScroll}
            review={pendingChapterReview}
            busy={pendingChapterReviewBusy}
            onKeep={onKeepPendingReview ?? (() => undefined)}
            onRevert={onRevertPendingReview ?? (() => undefined)}
            onAcceptHunk={onAcceptReviewHunk}
            onRejectHunk={onRejectReviewHunk}
          />
        ) : (
          <div ref={streamingContainer.ref} onScroll={streamingContainer.onScroll} data-mobile-manuscript className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-3 [-webkit-overflow-scrolling:touch]">
            <LocalFirstTextarea
              autoGrow
              data-kb-reveal="off"
              aria-label="章节正文"
              value={chapterDraft.content}
              readOnly={writeLocked}
              resetKey={chapterDraft.id}
              onCommit={(content) => onChange({ ...chapterDraft, content })}
              onSelectionChange={onSelectionChange}
              onBlur={() => onEditorBlur?.()}
              className="studio-editor-content w-full bg-transparent text-[var(--text-primary)] outline-none"
              placeholder="继续写这一章的正文。"
            />
          </div>
        )}
      </section>
    )
  }

  return (
    <section className={editorClassName}>
      <header className={desktopToolbarClassName}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="shrink-0 text-xs tabular-nums text-[var(--text-tertiary)]">第 {chapterDraft.orderIndex} 章</span>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border-strong)]" />
          <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]" title={pendingChapterReview?.after.title || chapterDraft.title}>
            {pendingChapterReview?.after.title.trim() || chapterDraft.title.trim() || '未命名章节'}
          </h1>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {selection?.text.trim() ? (
            <Button onClick={onAddSelection} variant="ghost" size="sm">
              <MessageSquarePlus className="h-4 w-4" />
              添加到输入框
            </Button>
          ) : null}
          {onPublishNovel ? (
            <Button
              onClick={onPublishNovel}
              variant="secondary"
              size="sm"
              className="lg:hidden"
            >
              <Upload className="h-4 w-4" />
              {novelPublished ? '更新发布' : '发布'}
            </Button>
          ) : null}
          <Button
            onClick={onOpenChapterSettings}
            variant="ghost"
            size="sm"
          >
            <Settings2 className="h-4 w-4" />
            章节设置
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {pendingChapterReview ? (
          <ChapterChangeReview
            inline
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
          <>
          <div data-studio-region="ide-manuscript" className="flex min-h-0 flex-1 flex-col px-4 xl:px-6">
            <LocalFirstTextarea
              ref={streamingTextarea.ref}
              onScroll={streamingTextarea.onScroll}
              data-kb-reveal="off"
              aria-label="章节正文"
              value={chapterDraft.content}
              resetKey={chapterDraft.id}
              onCommit={(content) => onChange({ ...chapterDraft, content })}
              onSelectionChange={onSelectionChange}
              onBlur={() => onEditorBlur?.()}
              rows={20}
              className="studio-editor-content min-h-0 flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent py-5 text-[var(--text-primary)] outline-none"
              placeholder="继续写这一章的正文。"
            />
          </div>
          {onGoToNextReviewFile ? (
            <NextReviewFilePill count={pendingReviewRemaining} onClick={onGoToNextReviewFile} />
          ) : null}
          </>
        )}
      </div>
    </section>
  )
}
