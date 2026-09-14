import { ChevronDown, Save, Upload } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { joinTags, parseTagsText } from '@/lib/novel-tags'

import type { NovelFormState } from '../types'
import { InputLabel, SelectControl, ToolShell } from './StudioControls'
import TagPicker from './TagPicker'

type MetaPanelProps = {
  novelForm: NovelFormState
  wordCountLabel: string
  chapterCountLabel: string
  coverLabel: string
  message: string
  saving: boolean
  onChange: (next: NovelFormState) => void
  onRequestVisibilityAction: (nextVisibility: NovelFormState['visibility']) => void
  onRequestStatusAction: (nextStatus: NovelFormState['status']) => void
  detailPreviewHref?: string
  onOpenCover?: () => void
  onSave: () => void
  onClose: () => void
}

export default function MetaPanel({
  novelForm,
  wordCountLabel,
  chapterCountLabel,
  coverLabel,
  message,
  saving,
  onChange,
  onRequestVisibilityAction,
  onRequestStatusAction,
  detailPreviewHref,
  onOpenCover,
  onSave,
  onClose,
}: MetaPanelProps) {
  return (
    <ToolShell
      title="作品设置"
      description="集中整理书名、简介、标签与发布方式。"
      actions={
        <Button variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      }
    >
      <div className="scrollbar-none flex h-full min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[18px] bg-[var(--surface-muted)] px-4 py-3 text-xs text-[var(--text-secondary)]">
          <span>{wordCountLabel}</span>
          <span>{chapterCountLabel}</span>
          <span>{coverLabel}</span>
        </div>

        <div className="grid gap-4">
          <label className="space-y-2">
            <InputLabel label="书名" />
            <TextInput
              value={novelForm.title}
              onChange={(event) => onChange({ ...novelForm, title: event.target.value })}
              placeholder="输入作品名称"
            />
          </label>

          <label className="space-y-2">
            <InputLabel label="作品简介" />
            <textarea
              value={novelForm.summary}
              onChange={(event) => onChange({ ...novelForm, summary: event.target.value })}
              rows={5}
              className="w-full rounded-[20px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
              placeholder="用几句话说清故事冲突、人物和世界观。"
            />
          </label>

          <div className="space-y-2">
            <InputLabel label="标签" hint="从统一标签库中选择，读者会按标签在分类和搜索中找到作品。" />
            <TagPicker
              value={parseTagsText(novelForm.tagsText)}
              onChange={(tags) => onChange({ ...novelForm, tagsText: joinTags(tags) })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2">
              <InputLabel label="可见范围" hint="切换后确认即自动保存。" />
              <SelectControl
                value={novelForm.visibility}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.value as NovelFormState['visibility']
                  if (next !== novelForm.visibility) {
                    onRequestVisibilityAction(next)
                  }
                }}
              >
                <option value="private">仅自己可见</option>
                <option value="followers">关注者可见</option>
                <option value="public">公开可见</option>
              </SelectControl>
            </label>

            <label className="space-y-2">
              <InputLabel label="发布状态" hint="切换后确认即自动保存。" />
              <SelectControl
                value={novelForm.status}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.value as NovelFormState['status']
                  if (next !== novelForm.status) {
                    onRequestStatusAction(next)
                  }
                }}
              >
                <option value="draft">草稿</option>
                <option value="published">上架中</option>
                <option value="completed">已完结</option>
                <option value="archived">已下架</option>
              </SelectControl>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
            <span>简介、标签和封面会同步到读者看到的作品页。</span>
            {detailPreviewHref ? (
              <Link
                to={detailPreviewHref}
                className="font-medium text-[var(--text-primary)] underline underline-offset-4 transition hover:opacity-75"
              >
                查看作品页
              </Link>
            ) : null}
            {onOpenCover ? (
              <button
                type="button"
                onClick={onOpenCover}
                className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)] underline underline-offset-4 transition hover:opacity-75"
              >
                <Upload className="h-3.5 w-3.5" />
                去设置封面
              </button>
            ) : null}
          </div>

          <details className="group rounded-[18px] border border-[var(--border-subtle)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
              高级设置
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="px-4 pb-4">
              <label className="space-y-2">
                <InputLabel label="展示标题" hint="用于详情页展示，可留空。" />
                <TextInput
                  value={novelForm.displayTitle}
                  onChange={(event) => onChange({ ...novelForm, displayTitle: event.target.value })}
                  placeholder="更适合展示的标题"
                />
              </label>
            </div>
          </details>
        </div>

        <div className="mt-auto space-y-3 border-t border-[var(--border-subtle)] pt-4">
          <p className="text-sm leading-6 text-[var(--text-secondary)]">{message}</p>
          <Button onClick={onSave} disabled={saving} className="w-full justify-center">
            <Save className="h-4 w-4" />
            保存作品设置
          </Button>
        </div>
      </div>
    </ToolShell>
  )
}
