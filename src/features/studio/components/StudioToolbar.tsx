import { useEffect, useRef, useState } from 'react'
import { BookOpenText, FileText, FolderDown, ImagePlus, MessageSquareText, MoreHorizontal, PenLine, Save, Settings2, Sparkles, Trash2, Upload, WandSparkles } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import Tag from '@/components/ui/Tag'
import type { Novel } from '../../../../shared/contracts/index.js'

import { SaveStatusPill } from './StudioControls'
import WorkspaceNovelSwitcher from './WorkspaceNovelSwitcher'

type StudioToolbarProps = {
  currentNovelId: string
  novelTitle: string
  novelTitleMissing?: boolean
  novelOptions: Novel[]
  chapterTitle: string
  chapterStatusLabel: string
  wordCountLabel: string
  saveState: 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  saveMessage: string
  onRetrySave?: () => void
  onOpenMeta: () => void
  onOpenAssistant: () => void
  onOpenCover: () => void
  onEnterImmersive: () => void
  onSaveNovel: () => void
  onPublishNovel: () => void
  onDeleteNovel: () => void
  onExport: () => void
  onImport?: () => void
  onSelectNovel: (novelId: string) => void
  onCreateNovel: () => void
  onEditNovelTitle?: () => void
  detailPreviewHref?: string
  previewHref?: string
  immersiveDisabled?: boolean
  switchingNovel?: boolean
  novelsLoading?: boolean
  novelSaving?: boolean
  novelDirty?: boolean
  novelPublished?: boolean
  perspective: 'work' | 'ide'
  onPerspectiveChange: (perspective: 'work' | 'ide') => void
  perspectiveSwitchEnabled?: boolean
}

export default function StudioToolbar({
  currentNovelId,
  novelTitle,
  novelTitleMissing = false,
  novelOptions,
  chapterTitle,
  wordCountLabel,
  saveState,
  saveMessage,
  onRetrySave,
  onOpenMeta,
  onOpenAssistant,
  onOpenCover,
  onEnterImmersive,
  onSaveNovel,
  onPublishNovel,
  onDeleteNovel,
  onExport,
  onImport,
  onSelectNovel,
  onCreateNovel,
  onEditNovelTitle,
  detailPreviewHref,
  previewHref,
  immersiveDisabled = false,
  switchingNovel = false,
  novelsLoading = false,
  novelSaving = false,
  novelDirty = false,
  novelPublished = false,
  perspective,
  onPerspectiveChange,
  perspectiveSwitchEnabled = true,
}: StudioToolbarProps) {
  // 低频操作（封面/设置/作品页/删除）收进“更多”菜单，保持工具栏精简
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!moreOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [moreOpen])

  const moreItemClass =
    'flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-sm text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-45'

  return (
    <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 py-3 md:px-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <WorkspaceNovelSwitcher
              currentNovelId={currentNovelId}
              currentNovelTitle={novelTitle}
              novels={novelOptions}
              busy={switchingNovel}
              loading={novelsLoading}
              onSelectNovel={onSelectNovel}
              onCreateNovel={onCreateNovel}
            />
            <Tag tone="accent">{perspective === 'work' ? '工作台' : 'IDE'}</Tag>
            <Tag>{wordCountLabel}</Tag>
          </div>
          <div className="min-w-0">
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
            <h1 className="truncate text-xl font-semibold tracking-tight text-[var(--text-primary)] md:text-2xl">
              {chapterTitle}
            </h1>
          </div>
        </div>

        <div className="flex w-full flex-col gap-3 lg:w-auto lg:min-w-[28rem] lg:items-end">
          <div className="flex flex-wrap items-center gap-2">
            {perspectiveSwitchEnabled ? <div className="inline-flex h-9 items-center rounded-full bg-[var(--surface-muted)] p-0.5" aria-label="切换创作视图">
              {([
                { key: 'work' as const, label: '工作台', icon: MessageSquareText },
                { key: 'ide' as const, label: 'IDE', icon: PenLine },
              ]).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onPerspectiveChange(key)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${perspective === key ? 'bg-[var(--surface-default)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  aria-pressed={perspective === key}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div> : null}
            {novelSaving || novelDirty ? (
              <Button variant="secondary" size="sm" onClick={onSaveNovel} disabled={novelSaving}>
                <Save className="h-4 w-4" />
                {novelSaving ? '保存中' : '保存作品'}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={onPublishNovel}
              disabled={novelSaving}
            >
              <Upload className="h-4 w-4" />
              {novelPublished ? '更新发布' : '发布'}
            </Button>
            <Button variant="secondary" size="sm" onClick={onOpenAssistant} className="xl:hidden">
              <Sparkles className="h-4 w-4" />
              Agent
            </Button>
            <Button size="sm" onClick={onEnterImmersive} disabled={immersiveDisabled}>
              <WandSparkles className="h-4 w-4" />
              沉浸
            </Button>
            {previewHref ? (
              <Link
                to={previewHref}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-pill)] bg-[var(--surface-contrast)] px-3 text-sm font-medium text-[var(--text-contrast)] transition hover:bg-[var(--surface-contrast-hover)]"
              >
                <BookOpenText className="h-4 w-4" />
                预览阅读
              </Link>
            ) : null}
            <div ref={moreRef} className="relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMoreOpen((open) => !open)}
                aria-label="更多操作"
                aria-expanded={moreOpen}
                className="border border-[var(--border-subtle)] px-2.5"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {moreOpen ? (
                <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-44 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[var(--shadow-soft)]">
                  <button
                    type="button"
                    className={moreItemClass}
                    onClick={() => {
                      setMoreOpen(false)
                      onOpenCover()
                    }}
                  >
                    <ImagePlus className="h-4 w-4 text-[var(--text-secondary)]" />
                    封面设计
                  </button>
                  <button
                    type="button"
                    className={moreItemClass}
                    onClick={() => {
                      setMoreOpen(false)
                      onOpenMeta()
                    }}
                  >
                    <Settings2 className="h-4 w-4 text-[var(--text-secondary)]" />
                    作品设置
                  </button>
                  {detailPreviewHref ? (
                    <Link to={detailPreviewHref} className={moreItemClass} onClick={() => setMoreOpen(false)}>
                      <FileText className="h-4 w-4 text-[var(--text-secondary)]" />
                      查看作品页
                    </Link>
                  ) : null}
                  {onImport ? <button type="button" className={`${moreItemClass} min-h-11`} onClick={() => { moreRef.current?.querySelector<HTMLElement>('button')?.focus(); setMoreOpen(false); onImport() }}><Upload className="h-4 w-4 text-[var(--text-secondary)]" />一键导入</button> : null}
                  <button
                    type="button"
                    className={moreItemClass}
                    onClick={() => {
                      setMoreOpen(false)
                      onExport()
                    }}
                  >
                    <FolderDown className="h-4 w-4 text-[var(--text-secondary)]" />
                    一键导出
                  </button>
                  <div className="my-1 border-t border-[var(--border-subtle)]" />
                  <button
                    type="button"
                    disabled={novelSaving}
                    className={`${moreItemClass} text-[rgb(153,27,27)] hover:bg-[rgba(127,29,29,0.08)] hover:text-[rgb(127,29,29)]`}
                    onClick={() => {
                      setMoreOpen(false)
                      onDeleteNovel()
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    删除作品
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <SaveStatusPill state={saveState} message={saveMessage} onRetry={onRetrySave} />
        </div>
      </div>
    </div>
  )
}
