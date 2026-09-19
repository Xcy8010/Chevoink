import { useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { cn } from '@/lib/utils'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import { InputLabel } from './StudioControls'

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
  /** 遮罩层级：编辑器内 z-40，沉浸区 portal 内 z-[110] */
  overlayClassName?: string
}

/** 卷设置抽屉：编辑卷信息与顺序，删除确认由父容器沿用工作区确认弹窗。 */
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
    <div
      className={cn('fixed inset-0 bg-[rgba(15,23,42,0.18)]', overlayClassName ?? 'z-40')}
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="卷设置"
        className="absolute inset-y-4 right-4 w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_24px_64px_rgba(15,23,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-full min-h-0 flex-col p-5">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
            <div>
              <h3 className="text-base font-semibold text-[var(--text-primary)]">卷设置</h3>
              <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                调整当前卷的名称和简介。
              </p>
            </div>
            <Button
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="关闭卷设置"
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <section className="space-y-3 rounded-[18px] border border-[var(--border-subtle)] p-4">
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">基本信息</h4>
              <label className="block space-y-2">
                <InputLabel label="卷名" />
                <TextInput
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：第一卷 初入江湖"
                  maxLength={128}
                  disabled={busy}
                />
              </label>
              <label className="block space-y-2">
                <InputLabel label="卷简介" hint="用于帮助你和 Agent 快速了解这一卷的范围。" />
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  rows={4}
                  maxLength={20_000}
                  disabled={busy}
                  className="min-h-[7rem] w-full resize-y overflow-y-auto rounded-[20px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="补充这一卷的主线、阶段目标或阅读提示。"
                />
              </label>
              <p className="text-xs text-[var(--text-secondary)]">
                当前序号：第 {volume.orderIndex} 卷 · 共 {chapterCount} 章
              </p>
            </section>

            <section className="space-y-3 rounded-[18px] border border-[rgba(190,18,60,0.25)] p-4">
              <h4 className="text-sm font-semibold text-[rgb(153,27,27)]">危险操作</h4>
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
                  className="text-[rgb(153,27,27)] hover:bg-[rgba(127,29,29,0.08)] hover:text-[rgb(127,29,29)]"
                >
                  <Trash2 className="h-4 w-4" />
                  删除卷
                </Button>
              )}
            </section>
            {error || errorMessage ? <p role="alert" className="rounded-lg bg-rose-500/10 p-3 text-sm text-rose-600">{error || errorMessage}</p> : null}
          </div>

          <div className="mt-4 flex items-center justify-end border-t border-[var(--border-subtle)] pt-4">
            <Button onClick={() => void saveAndClose()} variant="secondary" disabled={busy || !hasTitle}>
              完成
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
