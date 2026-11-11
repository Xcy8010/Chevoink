import { useId, useRef } from 'react'
import { ArrowUpRight, ChevronDown, Image, X } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { joinTags, parseTagsText } from '@/lib/novel-tags'
import { cn } from '@/lib/utils'

import type { NovelFormState } from '../types'
import { SelectControl } from './StudioControls'
import TagPicker from './TagPicker'

type MetaPanelProps = {
  novelForm: NovelFormState
  coverUrl?: string | null
  mobile?: boolean
  message: string
  saving: boolean
  onChange: (next: NovelFormState) => void
  onRequestVisibilityAction: (nextVisibility: NovelFormState['visibility']) => void
  onRequestStatusAction: (nextStatus: NovelFormState['status']) => void
  detailPreviewHref?: string
  onCoverFile?: (file: File) => void
  onOpenCover?: () => void
  onSave: () => void
  onClose: () => void
}

const labelClass = 'block text-sm font-medium text-[var(--text-primary)]'
const sectionClass = 'space-y-4 border-t border-[var(--border-subtle)] pt-4'
const linkClass = 'inline-flex min-h-9 items-center gap-1.5 rounded-md text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]'

export default function MetaPanel({
  novelForm,
  coverUrl,
  mobile = false,
  message,
  saving,
  onChange,
  onRequestVisibilityAction,
  onRequestStatusAction,
  detailPreviewHref,
  onCoverFile,
  onOpenCover,
  onSave,
  onClose,
}: MetaPanelProps) {
  const titleId = useId()
  const summaryId = useId()
  const displayTitleId = useId()
  const visibilityId = useId()
  const statusId = useId()
  const coverInputRef = useRef<HTMLInputElement>(null)

  return (
    <section aria-label="作品设置" className="flex h-full min-h-0 min-w-0 flex-col text-[var(--text-primary)]">
      {!mobile ? (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
          <h2 className="text-lg font-semibold">作品设置</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="关闭作品设置"
            title="关闭作品设置"
            className="h-9 w-9 rounded-lg p-0"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>
      ) : null}

      <div className={cn('min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain py-4', mobile && 'px-4')}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={titleId} className={labelClass}>书名</label>
            <TextInput
              id={titleId}
              wrapperAs="span"
              value={novelForm.title}
              onChange={(event) => onChange({ ...novelForm, title: event.target.value })}
              placeholder="输入作品名称"
              className="rounded-lg px-3"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={summaryId} className={labelClass}>作品简介</label>
            <textarea
              id={summaryId}
              value={novelForm.summary}
              onChange={(event) => onChange({ ...novelForm, summary: event.target.value })}
              rows={4}
              className="block min-h-24 w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2.5 text-sm leading-6 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
              placeholder="用几句话说清故事冲突、人物和世界观。"
            />
          </div>
        </div>

        <div className={sectionClass}>
          <TagPicker
            value={parseTagsText(novelForm.tagsText)}
            onChange={(tags) => onChange({ ...novelForm, tagsText: joinTags(tags) })}
          />
        </div>

        <div className={sectionClass}>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={visibilityId} className={labelClass}>可见范围</label>
              <SelectControl
                id={visibilityId}
                value={novelForm.visibility}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.value as NovelFormState['visibility']
                  if (next !== novelForm.visibility) onRequestVisibilityAction(next)
                }}
                className="h-10 rounded-lg pl-3 pr-10"
              >
                <option value="private">仅自己可见</option>
                <option value="followers">关注者可见</option>
                <option value="public">公开可见</option>
              </SelectControl>
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor={statusId} className={labelClass}>发布状态</label>
              <SelectControl
                id={statusId}
                value={novelForm.status}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.value as NovelFormState['status']
                  if (next !== novelForm.status) onRequestStatusAction(next)
                }}
                className="h-10 rounded-lg pl-3 pr-10"
              >
                <option value="draft">草稿</option>
                <option value="published">上架中</option>
                <option value="completed">已完结</option>
                <option value="archived">已下架</option>
              </SelectControl>
            </div>
          </div>

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md py-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
              展示标题<span className="mr-auto text-xs text-[var(--text-tertiary)]">选填</span>
              <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform motion-reduce:transition-none group-open:rotate-180" />
            </summary>
            <label htmlFor={displayTitleId} className="sr-only">展示标题</label>
            <TextInput
              id={displayTitleId}
              wrapperAs="span"
              value={novelForm.displayTitle}
              onChange={(event) => onChange({ ...novelForm, displayTitle: event.target.value })}
              placeholder="留空时使用书名"
              className="mt-2 rounded-lg px-3"
            />
          </details>
        </div>

        <section aria-label="作品封面" className="flex items-center gap-3 border-t border-[var(--border-subtle)] pt-4">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt="当前作品封面"
              className="aspect-[3/4] w-14 shrink-0 rounded-md bg-[var(--surface-muted)] object-cover"
            />
          ) : (
            <span aria-hidden="true" className="flex aspect-[3/4] w-14 shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
              <Image className="h-5 w-5" />
            </span>
          )}

          <div className="min-w-0 flex-1">
            <h3 className={labelClass}>作品封面</h3>
            {!coverUrl ? <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">未设置</p> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              {onCoverFile ? (
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="选择作品封面图片"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) onCoverFile(file)
                  }}
                />
              ) : null}
              {onCoverFile || onOpenCover ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-lg"
                  onClick={onCoverFile ? () => coverInputRef.current?.click() : onOpenCover}
                >
                  {coverUrl ? '更换封面' : '上传封面'}
                </Button>
              ) : null}
              {onCoverFile && onOpenCover ? (
                <Button variant="ghost" size="sm" className="rounded-lg" onClick={onOpenCover}>
                  封面工坊
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <footer className={cn('shrink-0 border-t border-[var(--border-subtle)] pt-3', mobile && 'px-4 pb-3')}>
        {message ? <p role="status" className="mb-2 break-words text-xs leading-5 text-[var(--text-secondary)]">{message}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {detailPreviewHref ? (
            <Link to={detailPreviewHref} className={linkClass}>
              查看作品页<ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          ) : null}
          <Button variant="primary" onClick={onSave} disabled={saving} className="ml-auto rounded-lg">
            {saving ? '保存中…' : '保存作品设置'}
          </Button>
        </div>
      </footer>
    </section>
  )
}
