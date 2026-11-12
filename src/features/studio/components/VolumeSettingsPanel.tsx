import { useEffect, useId, useState } from 'react'
import { Trash2 } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import StudioDocumentSettingsDrawer from './StudioDocumentSettingsDrawer'

type Volume = StudioPayload['volumes'][number]

export type VolumeSettingsDraft = {
  title: string
  summary: string
}

type VolumeSettingsPanelProps = {
  volume: Volume
  chapterCount: number
  volumeCount: number
  deleteDestinationTitle?: string
  busy?: boolean
  errorMessage?: string
  onSave: (draft: VolumeSettingsDraft) => void | Promise<void>
  onRequestDelete: () => void
  onClose: () => void
  overlayClassName?: string
}

export default function VolumeSettingsPanel({
  volume,
  chapterCount,
  volumeCount,
  deleteDestinationTitle,
  busy = false,
  errorMessage,
  onSave,
  onRequestDelete,
  onClose,
  overlayClassName,
}: VolumeSettingsPanelProps) {
  const [title, setTitle] = useState(volume.title)
  const [summary, setSummary] = useState(volume.summary ?? '')
  const [error, setError] = useState('')
  const titleId = useId()
  const summaryId = useId()
  const summaryHintId = useId()
  const isOnlyVolume = volumeCount <= 1
  const hasTitle = title.trim().length > 0

  useEffect(() => {
    setTitle(volume.title)
    setSummary(volume.summary ?? '')
    setError('')
  }, [volume.id, volume.revision, volume.title, volume.summary])

  const saveAndClose = async () => {
    if (!hasTitle || busy) return
    setError('')
    try {
      await onSave({ title: title.trim(), summary: summary.trim() })
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '卷设置保存失败，请稍后重试。')
    }
  }

  return (
    <StudioDocumentSettingsDrawer
      title="卷设置"
      busy={busy}
      onClose={onClose}
      overlayClassName={overlayClassName}
      footer={
        <Button onClick={() => void saveAndClose()} variant="primary" className="rounded-lg" disabled={busy || !hasTitle}>
          完成
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={titleId} className="text-sm font-medium">卷名</label>
          <TextInput
            id={titleId}
            wrapperAs="span"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：第一卷 初入江湖"
            maxLength={128}
            disabled={busy}
            className="rounded-lg px-3"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={summaryId} className="text-sm font-medium">卷简介</label>
          <p id={summaryHintId} className="text-xs leading-5 text-[var(--text-secondary)]">用于帮助你和 Agent 快速了解这一卷的范围。</p>
          <textarea
            id={summaryId}
            aria-describedby={summaryHintId}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            maxLength={20_000}
            disabled={busy}
            className="block min-h-24 w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
            placeholder="补充这一卷的主线、阶段目标或阅读提示。"
          />
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          当前序号：第 {volume.orderIndex} 卷 · 共 {chapterCount} 章
        </p>
      </div>

      <section className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-sm font-medium">危险操作</h3>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">
          删除卷不会删除其中章节；章节会移入{deleteDestinationTitle ? `「${deleteDestinationTitle}」` : '相邻卷'}，并保持原有阅读顺序。
        </p>
        {isOnlyVolume ? (
          <p className="text-xs text-[var(--text-secondary)]">作品仅剩一卷，不能删除最后一卷。</p>
        ) : (
          <Button
            onClick={onRequestDelete}
            variant="ghost"
            size="sm"
            disabled={busy}
            className="rounded-lg text-[var(--color-error)] hover:text-[var(--color-error)]"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            删除卷
          </Button>
        )}
      </section>
      {error || errorMessage ? <p role="alert" className="text-sm text-[var(--color-error)]">{error || errorMessage}</p> : null}
    </StudioDocumentSettingsDrawer>
  )
}
