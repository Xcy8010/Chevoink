import { useId, type ReactNode } from 'react'
import { Archive, Clock3, FileText, Upload } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { cn } from '@/lib/utils'
import type { ChapterStatus } from '../../../../shared/contracts/index.js'
import type { ChapterDraftState } from '../types'
import { formatNumberedChapterTitle } from '../lib/document-title'
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
}[] = [
  {
    value: 'public',
    label: '公开',
    description: '所有读者都能在作品页阅读本章。',
  },
  {
    value: 'followers',
    label: '关注可见',
    description: '仅关注你的读者可以阅读本章。',
  },
  {
    value: 'private',
    label: '仅自己',
    description: '只有你自己能在创作区查看本章。',
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

  const visibilityId = useId()
  const selectedVisibility = VISIBILITY_OPTIONS.find(option => option.value === chapterDraft.visibility)

  return (
    <StudioDocumentSettingsDrawer
      title="章节设置"
      documentName={formatNumberedChapterTitle(chapterDraft.title, chapterDraft.orderIndex)}
      onClose={onClose}
      overlayClassName={overlayClassName}
      deleteAction={{ label: '删除章节', description: '删除章节后正文与摘要无法恢复。', onClick: onRequestDelete }}
      footer={<Button onClick={onClose} variant="primary" className="rounded-lg">完成</Button>}
    >
      <div className="document-settings-field">
        <label htmlFor={titleId} className="document-settings-label">章节标题</label>
        <TextInput
          id={titleId}
          wrapperAs="span"
          value={chapterDraft.title}
          onChange={(event) => onChange({ ...chapterDraft, title: event.target.value })}
          placeholder="例如：第三十七章 失控回环"
          className="rounded-lg px-3"
        />
        <p className="document-settings-note">章节顺序可在左侧目录中拖动调整。</p>
      </div>
      <div className="document-settings-field">
        <label htmlFor={summaryId} className="document-settings-label">章节摘要</label>
        <textarea
          id={summaryId}
          value={chapterDraft.summary}
          onChange={(event) => onChange({ ...chapterDraft, summary: event.target.value })}
          rows={3}
          className="document-settings-textarea"
          placeholder="补充这一章的目标、节奏或推进重点。"
        />
      </div>

      <div className="document-settings-section">
        <div className="document-settings-columns document-settings-columns--primary">
          <div className="document-settings-field">
            <h3 className="document-settings-label">发布状态</h3>
            <div className="grid min-h-10 grid-cols-4 gap-1 rounded-lg bg-[var(--surface-muted)] p-1 lg:min-h-11" role="group" aria-label="发布状态">
              {STATUS_OPTIONS.map((option) => {
                const active = chapterDraft.status === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => { if (!active) onRequestStatusAction(option.value) }}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                      active ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <span aria-hidden="true">{option.icon}</span>{option.label}
                  </button>
                )
              })}
            </div>
            <p className="document-settings-note">更改状态需确认，定时章节将在设定时间上架。</p>
          </div>
          <div className="document-settings-field">
            <label htmlFor={visibilityId} className="document-settings-label">可见范围</label>
            <select
              id={visibilityId}
              value={chapterDraft.visibility}
              aria-describedby={`${visibilityId}-hint`}
              onChange={(event) => onRequestVisibilityAction(event.target.value as ChapterVisibility)}
              className="document-settings-select"
            >
              {VISIBILITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <p id={`${visibilityId}-hint`} className="document-settings-note">{selectedVisibility?.description}</p>
          </div>
        </div>
      </div>
    </StudioDocumentSettingsDrawer>
  )
}
