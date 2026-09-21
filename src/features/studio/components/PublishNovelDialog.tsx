import { useEffect, useMemo, useState } from 'react'
import { CheckSquare, Globe2, Lock, Square, Upload, Users, X } from 'lucide-react'
import { createPortal } from 'react-dom'

import Button from '@/components/ui/Button'
import type { ChapterListItem, Visibility } from '../../../../shared/contracts'
import { getPublishableChapters, hasUnpublishedChapterChanges } from '../lib/publish-chapters'

type PublishNovelDialogProps = {
  open: boolean
  novelTitle: string
  chapters: ChapterListItem[]
  busy?: boolean
  onCancel: () => void
  onConfirm: (chapterIds: string[], visibility: Visibility) => void
}

const VISIBILITY_OPTIONS: Array<{ value: Visibility; label: string; description: string; icon: typeof Globe2 }> = [
  { value: 'public', label: '公开', description: '所有读者都能在作品页阅读这些章节。', icon: Globe2 },
  { value: 'followers', label: '关注可见', description: '仅关注你的读者可以阅读这些章节。', icon: Users },
  { value: 'private', label: '仅自己', description: '章节保持仅自己可见，读者无法阅读。', icon: Lock },
]

const CHAPTER_STATUS_LABEL: Record<ChapterListItem['status'], string> = {
  draft: '草稿',
  published: '已发布',
  scheduled: '定时',
  archived: '已归档',
}

const CHAPTER_VISIBILITY_LABEL: Record<Visibility, string> = {
  public: '公开',
  followers: '关注可见',
  private: '仅自己',
}

export default function PublishNovelDialog({
  open,
  novelTitle,
  chapters,
  busy = false,
  onCancel,
  onConfirm,
}: PublishNovelDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [visibility, setVisibility] = useState<Visibility>('public')

  // 已发布但创作稿有更新的章节必须重新进入列表，显式发布后才同步到阅读区。
  const publishableChapters = useMemo(
    () => getPublishableChapters(chapters),
    [chapters],
  )

  // 打开弹窗时默认全选待发布章节，且可见范围默认公开
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(publishableChapters.map((chapter) => chapter.id)))
      setVisibility('public')
    }
  }, [open, publishableChapters])

  const allSelected = useMemo(
    () => publishableChapters.length > 0 && publishableChapters.every((chapter) => selectedIds.has(chapter.id)),
    [publishableChapters, selectedIds],
  )

  // 发布后作品必须至少有一个公开章节：要么已有公开已发布章节，要么本次以公开可见范围发布新章节
  const hasPublicPublishedChapter = useMemo(
    () => chapters.some(
      (chapter) =>
        chapter.status === 'published' &&
        chapter.visibility === 'public' &&
        !selectedIds.has(chapter.id),
    ),
    [chapters, selectedIds],
  )
  const willHavePublicChapter = hasPublicPublishedChapter || (visibility === 'public' && selectedIds.size > 0)

  if (!open) {
    return null
  }

  function toggleChapter(chapterId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(chapterId)) {
        next.delete(chapterId)
      } else {
        next.add(chapterId)
      }
      return next
    })
  }

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(publishableChapters.map((chapter) => chapter.id)))
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4 py-8 backdrop-blur-[2px]">
      <div className="scrollbar-none max-h-[calc(100dvh-4rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-[0_24px_64px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--text-primary)]">
              <Upload className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-[var(--text-primary)]">发布作品</h3>
              <p className="text-sm leading-6 text-[var(--text-secondary)]">
                《{novelTitle || '未命名作品'}》将以已发布状态对外展示，勾选需要一起发布的章节。
              </p>
            </div>
          </div>
          <Button onClick={onCancel} variant="ghost" size="sm" className="h-9 w-9 px-0" aria-label="关闭发布弹窗">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-[var(--text-secondary)]">章节可见范围</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {VISIBILITY_OPTIONS.map((option) => {
              const Icon = option.icon
              const active = visibility === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setVisibility(option.value)}
                  className={
                    active
                      ? 'flex flex-col gap-1 rounded-[16px] border border-[var(--text-primary)] bg-[var(--surface-muted)] p-3 text-left'
                      : 'flex flex-col gap-1 rounded-[16px] border border-[var(--border-subtle)] p-3 text-left transition hover:border-[var(--text-secondary)]'
                  }
                >
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
                    <Icon className="h-4 w-4" />
                    {option.label}
                  </span>
                  <span className="text-xs leading-5 text-[var(--text-secondary)]">{option.description}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs font-medium text-[var(--text-secondary)]">
            发布章节（已选 {selectedIds.size} / {publishableChapters.length}）
          </p>
          <Button onClick={toggleAll} variant="ghost" size="sm" disabled={publishableChapters.length === 0}>
            {allSelected ? '取消全选' : '全选'}
          </Button>
        </div>

        <div className="scrollbar-none mt-2 max-h-60 space-y-1.5 overflow-y-auto overscroll-contain rounded-[16px] border border-[var(--border-subtle)] p-2">
          {publishableChapters.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-[var(--text-secondary)]">
              {chapters.length > 0
                ? '所有章节都已公开发布，可直接发布以同步最新的书名、简介与标签等作品设置。'
                : '还没有章节，先写一章再来发布吧。'}
            </p>
          ) : (
            publishableChapters.map((chapter) => {
              const checked = selectedIds.has(chapter.id)
              return (
                <button
                  key={chapter.id}
                  type="button"
                  onClick={() => toggleChapter(chapter.id)}
                  className={
                    checked
                      ? 'flex w-full items-center gap-2.5 rounded-[12px] bg-[var(--surface-muted)] px-3 py-2 text-left'
                      : 'flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left transition hover:bg-[var(--surface-muted)]'
                  }
                >
                  {checked ? (
                    <CheckSquare className="h-4 w-4 shrink-0 text-[var(--text-primary)]" />
                  ) : (
                    <Square className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                    第 {chapter.orderIndex} 章 · {chapter.title || '未命名章节'}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                    {hasUnpublishedChapterChanges(chapter) ? '待更新' : CHAPTER_STATUS_LABEL[chapter.status]} · {CHAPTER_VISIBILITY_LABEL[chapter.visibility]}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-3">
          {!willHavePublicChapter ? (
            <p className="min-w-0 flex-1 text-xs leading-5 text-[var(--text-secondary)]">
              至少需要一个公开章节，读者才能看到这部作品。请勾选章节并把可见范围设为公开。
            </p>
          ) : null}
          <Button onClick={onCancel} variant="ghost" disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => onConfirm(Array.from(selectedIds), visibility)}
            variant="primary"
            disabled={busy || !willHavePublicChapter}
            className="bg-zinc-900 text-white hover:bg-zinc-800"
          >
            {busy
              ? '正在发布...'
              : !willHavePublicChapter
                ? selectedIds.size === 0
                  ? '暂无章节更新，无法发布'
                  : '需要至少一个公开章节'
                : selectedIds.size === 0
                  ? '发布作品设置更新'
                  : `发布作品与 ${selectedIds.size} 个章节`}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
