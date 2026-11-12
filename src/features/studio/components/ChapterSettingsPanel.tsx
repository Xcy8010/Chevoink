import { useId, type ReactNode } from 'react'
import { Archive, Clock3, FileText, Globe2, Lock, Trash2, Upload, Users } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { cn } from '@/lib/utils'
import type { ChapterStatus } from '../../../../shared/contracts/index.js'
import type { ChapterDraftState } from '../types'
import StudioDocumentSettingsDrawer from './StudioDocumentSettingsDrawer'

type ChapterVisibility = ChapterDraftState['visibility']

const STATUS_OPTIONS: { value: ChapterStatus; label: string; icon: ReactNode }[] = [
  { value: 'draft', label: '草稿', icon: <FileText className="h-3.5 w-3.5" /> },
  { value: 'published', label: '上架', icon: <Upload className="h-3.5 w-3.5" /> },
  { value: 'scheduled', label: '定时', icon: <Clock3 className="h-3.5 w-3.5" /> },
  { value: 'archived', label: '下架', icon: <Archive className="h-3.5 w-3.5" /> },
]

const VISIBILITY_OPTIONS: {
  value: ChapterVisibility
  label: string
  description: string
  icon: ReactNode
}[] = [
  {
    value: 'public',
    label: '公开',
    description: '所有读者都能在作品页阅读本章。',
    icon: <Globe2 className="h-3.5 w-3.5" />,
  },
  {
    value: 'followers',
    label: '关注可见',
    description: '仅关注你的读者可以阅读本章。',
    icon: <Users className="h-3.5 w-3.5" />,
  },
  {
    value: 'private',
    label: '仅自己',
    description: '只有你自己能在创作区查看本章。',
    icon: <Lock className="h-3.5 w-3.5" />,
  },
]

type ChapterSettingsPanelProps = {
  chapterDraft: ChapterDraftState
  onChange: (next: ChapterDraftState) => void
  /** 切换发布状态：由调用方弹确认框并执行 */
  onRequestStatusAction: (next: ChapterStatus) => void
  /** 切换可见范围：由调用方弹确认框并执行 */
  onRequestVisibilityAction: (next: ChapterVisibility) => void
  onRequestDelete: () => void
  onClose: () => void
  overlayClassName?: string
}

export default function ChapterSettingsPanel({
  chapterDraft,
  onChange,
  onRequestStatusAction,
  onRequestVisibilityAction,
  onRequestDelete,
  onClose,
  overlayClassName,
}: ChapterSettingsPanelProps) {
  const titleId = useId()
  const summaryId = useId()

  return (
    <StudioDocumentSettingsDrawer
      title="章节设置"
      onClose={onClose}
      overlayClassName={overlayClassName}
      footer={<Button onClick={onClose} variant="primary" className="rounded-lg">完成</Button>}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={titleId} className="text-sm font-medium">章节标题</label>
          <TextInput
            id={titleId}
            wrapperAs="span"
            value={chapterDraft.title}
            onChange={(event) => onChange({ ...chapterDraft, title: event.target.value })}
            placeholder="例如：第三十七章 失控回环"
            className="rounded-lg px-3"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={summaryId} className="text-sm font-medium">章节摘要</label>
          <textarea
            id={summaryId}
            value={chapterDraft.summary}
            onChange={(event) => onChange({ ...chapterDraft, summary: event.target.value })}
            rows={4}
            className="block min-h-24 w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
            placeholder="补充这一章的目标、节奏或推进重点。"
          />
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          当前序号：第 {chapterDraft.orderIndex} 章（在左侧目录中拖拽调整顺序）
        </p>
      </div>

      <section className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-medium">发布状态</h3>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-[var(--surface-muted)] p-1" role="group" aria-label="发布状态">
          {STATUS_OPTIONS.map((option) => {
            const active = chapterDraft.status === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => { if (!active) onRequestStatusAction(option.value) }}
                aria-pressed={active}
                className={cn(
                  'inline-flex min-h-9 items-center justify-center gap-1 rounded-md px-1 text-xs font-medium whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] motion-safe:transition-colors',
                  active
                    ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                <span aria-hidden="true">{option.icon}</span>
                {option.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">
          点选目标状态，确认后立即生效；「定时」章节会在设定时间自动上架。
        </p>
      </section>

      <section className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-medium">可见范围</h3>
        <div role="group" aria-label="可见范围">
          {VISIBILITY_OPTIONS.map((option) => {
            const active = chapterDraft.visibility === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => { if (!active) onRequestVisibilityAction(option.value) }}
                aria-pressed={active}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] motion-safe:transition-colors',
                  active ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
                )}
              >
                <span aria-hidden="true" className="mt-1 shrink-0 text-[var(--text-secondary)]">{option.icon}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="block text-xs leading-5 text-[var(--text-secondary)]">{option.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-medium">危险操作</h3>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">
          删除章节后正文与摘要无法恢复，请谨慎操作。
        </p>
        <Button onClick={onRequestDelete} variant="ghost" size="sm" className="rounded-lg text-[var(--color-error)] hover:text-[var(--color-error)]">
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          删除章节
        </Button>
      </section>
    </StudioDocumentSettingsDrawer>
  )
}
