import { useState } from 'react'
import { FilePenLine, FolderPlus, LoaderCircle, MessageSquarePlus, MoreHorizontal, RefreshCcw, Settings2, Upload } from 'lucide-react'

import Button from '@/components/ui/Button'
import Surface from '@/components/ui/Surface'
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
  embedded?: boolean
  /** mobile=手机端零卡片单滚动形态；默认保持桌面卡片形态 */
  variant?: 'default' | 'mobile'
  /** Agent 正在流式生成的只读正文；未落库前覆盖显示但不触发用户草稿。 */
  streamingContent?: string
  writeLocked?: boolean
}

export default function EditorCanvas({
  chapterDraft: sourceChapterDraft,
  workspaceDocument: sourceWorkspaceDocument = null,
  chapterLoading,
  chapterErrorMessage,
  chapterSaveState: _chapterSaveState,
  chapterSaveMessage: _chapterSaveMessage,
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
  embedded = false,
  variant = 'default',
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
  const sectionClassName = embedded
    ? 'flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface-default)]'
    : 'flex h-full min-h-0 flex-col overflow-hidden pb-2'

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
      <Surface as="section" padding="md" className={embedded ? `${sectionClassName} border-0 px-5 py-5 shadow-none xl:px-6` : sectionClassName}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-4">
          <div className="space-y-1">
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
          <div className="flex items-center gap-2">
          {selection?.text.trim() ? (
            <Button onClick={onAddSelection} variant="ghost" size="sm">
              <MessageSquarePlus className="h-4 w-4" />
              添加到输入框
            </Button>
          ) : null}
          {workspaceDocument.kind === 'plan' ? (
            <Button onClick={() => onOpenPlanSettings?.()} variant="primary" size="sm">
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
        </div>

        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pr-1 pb-2">
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
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-1 py-1">
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
                className="min-h-[30rem] w-full flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-8 text-[var(--text-primary)] outline-none"
                placeholder="在这里维护目录内容。"
              />
            ) : (
              <div className="whitespace-pre-wrap break-words text-sm leading-8 text-[var(--text-primary)]">
                {workspaceDocument.content}
              </div>
            )}
          </div>
          )}
        </div>
      </Surface>
    )
  }

  if (chapterLoading && !chapterDraft) {
    return (
      <Surface as="section" padding="md" className={embedded ? 'flex h-full min-h-[32rem] items-center justify-center border-0 shadow-none' : 'flex h-full min-h-[32rem] items-center justify-center'}>
        <div className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
          <LoaderCircle className="h-5 w-5 animate-spin" />
          <span>正在加载章节内容...</span>
        </div>
      </Surface>
    )
  }

  if (chapterErrorMessage && !chapterDraft) {
    return (
      <Surface as="section" padding="md" className={embedded ? 'space-y-4 border-0 shadow-none' : 'space-y-4'}>
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
      </Surface>
    )
  }

  if (!chapterDraft) {
    return (
      <Surface as="section" padding="md" className={embedded ? 'flex h-full min-h-[32rem] items-center justify-center border-0 shadow-none' : 'flex h-full min-h-[32rem] items-center justify-center'}>
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
      </Surface>
    )
  }

  if (isMobile) {
    return (
      <section className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 px-1 pb-2">
          <span className="min-w-0 truncate text-xs text-[var(--text-tertiary)]">{latestWordCountLabel}</span>
          <div className="relative flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label="更多操作"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] active:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {mobileMenuOpen ? (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMobileMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full z-40 mt-2 w-44 overflow-hidden rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] py-1 shadow-[0_16px_40px_rgba(15,23,42,0.16)]">
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false)
                      onOpenChapterSettings()
                    }}
                    className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
                  >
                    <Settings2 className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                    章节设置
                  </button>
                  {onPublishNovel ? (
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false)
                        onPublishNovel()
                      }}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left text-sm text-[var(--text-primary)] transition-colors active:bg-[var(--surface-muted)]"
                    >
                      <Upload className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                      {novelPublished ? '更新发布' : '发布作品'}
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
        <div ref={streamingContainer.ref} onScroll={streamingContainer.onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-8 [-webkit-overflow-scrolling:touch]">
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
              className="min-h-[60vh]"
            />
          ) : (
            <>
              <p className="border-b border-[var(--border-subtle)] pb-3 text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                {chapterDraft.title.trim() || `第 ${chapterDraft.orderIndex} 章`}
              </p>
              <LocalFirstTextarea
                autoGrow
                data-kb-reveal="off"
                value={chapterDraft.content}
                resetKey={chapterDraft.id}
                onCommit={(content) => onChange({ ...chapterDraft, content })}
                onSelectionChange={onSelectionChange}
                onBlur={() => onEditorBlur?.()}
                wrapperClassName="mt-3"
                className="studio-editor-content w-full bg-transparent composer-body-text text-[var(--text-primary)] outline-none"
                placeholder="继续写这一章的正文。"
              />
            </>
          )}
        </div>
        {onGoToNextReviewFile && !pendingChapterReview ? (
          <NextReviewFilePill count={pendingReviewRemaining} onClick={onGoToNextReviewFile} />
        ) : null}
      </section>
    )
  }

  return (
    <Surface as="section" padding="md" className={embedded ? `${sectionClassName} border-0 px-5 py-5 shadow-none xl:px-6` : sectionClassName}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">第 {chapterDraft.orderIndex} 章</p>
          <h1 className="mt-1 truncate text-base font-semibold tracking-[0.01em] text-[var(--text-primary)]">
            {chapterDraft.title.trim() || `第 ${chapterDraft.orderIndex} 章`}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            variant="primary"
            size="sm"
            className="bg-zinc-900 text-white hover:bg-zinc-800"
          >
            <Settings2 className="h-4 w-4" />
            章节设置
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-2 pt-4">
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
          <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-1">
            <LocalFirstTextarea
              ref={streamingTextarea.ref}
              onScroll={streamingTextarea.onScroll}
              data-kb-reveal="off"
              value={chapterDraft.content}
              resetKey={chapterDraft.id}
              onCommit={(content) => onChange({ ...chapterDraft, content })}
              onSelectionChange={onSelectionChange}
              onBlur={() => onEditorBlur?.()}
              rows={20}
              className="studio-editor-content min-h-[30rem] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1 text-[var(--text-primary)] outline-none"
              placeholder="继续写这一章的正文。"
            />
          </div>
          {onGoToNextReviewFile ? (
            <NextReviewFilePill count={pendingReviewRemaining} onClick={onGoToNextReviewFile} />
          ) : null}
          </>
        )}
      </div>
    </Surface>
  )
}
