import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Check, Copy, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import {
  NOVEL_PUBLISH_FIELDS,
  novelPublishMetadataMessage,
  type NovelPublishField,
} from '../../../../shared/contracts/novel-publish.js'

const GUIDANCE = {
  cover: {
    path: '封面工坊 → 本地上传封面或生成封面 → 设为作品封面',
    panel: 'cover',
    linkLabel: '打开封面工坊',
    prompt: '请根据当前作品生成一张封面候选图，给我预览，确认后设为作品封面。',
  },
  summary: {
    path: '作品设置 → 作品简介 → 保存作品设置',
    panel: 'meta',
    linkLabel: '打开作品设置',
    prompt: '请根据当前作品的人物和主要冲突写一段不剧透的简介，并保存为作品简介。',
  },
  tags: {
    path: '作品设置 → 标签 → 保存作品设置',
    panel: 'meta',
    linkLabel: '打开作品设置',
    prompt: '请设置当前作品的标签，从站内标签库选择符合题材和风格的标签并保存。',
  },
} as const

export default function PublishMetadataDialog({ missing, onClose, onOpenPanel }: {
  missing: NovelPublishField[]
  onClose: () => void
  onOpenPanel: (panel: 'cover' | 'meta') => void
}) {
  const [showHelp, setShowHelp] = useState(false)
  const [copyResult, setCopyResult] = useState<{ field: NovelPublishField; success: boolean } | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [showHelp])

  function returnToNotice() {
    setShowHelp(false)
    setCopyResult(null)
  }

  async function copyPrompt(field: NovelPublishField) {
    try {
      await navigator.clipboard.writeText(GUIDANCE[field].prompt)
      setCopyResult({ field, success: true })
    } catch {
      setCopyResult({ field, success: false })
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      data-native-back-dismiss
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        if (showHelp) returnToNotice()
        else onClose()
      }}
      className={`studio-workspace fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-0 text-[var(--text-primary)] shadow-[0_24px_64px_rgba(15,23,42,0.2)] backdrop:bg-black/30 backdrop:backdrop-blur-[2px] open:flex ${showHelp ? 'max-w-[34rem]' : 'max-w-[28rem]'}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3 sm:px-6 sm:py-4">
        <div className="min-w-0">
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-lg font-semibold leading-6 outline-none">
            {showHelp ? '如何设置作品信息' : '还不能发布这部作品'}
          </h2>
          {showHelp ? <p id={descriptionId} className="mt-1.5 text-sm leading-5 text-[var(--text-secondary)]">手动设置，或把提示词复制到 Agent 输入框。</p> : null}
        </div>
        <Button variant="ghost" size="sm" className="-mr-1 h-9 w-9 shrink-0 rounded-lg px-0" onClick={onClose} aria-label={showHelp ? '关闭设置帮助' : '关闭发布提示'}>
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </header>

      {showHelp ? (
        <div data-publish-help-content className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain px-4 sm:px-6">
          {missing.map((field) => {
            const guidance = GUIDANCE[field]
            const label = NOVEL_PUBLISH_FIELDS[field]
            const result = copyResult?.field === field ? copyResult : null
            return (
              <section key={field} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{label}</h3>
                  <Button variant="ghost" size="sm" className="-mr-2 gap-1 rounded-lg px-2 text-xs" onClick={() => onOpenPanel(guidance.panel)}>
                    {guidance.linkLabel}<ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-xs leading-5 text-[var(--text-secondary)]">{guidance.path}</p>
                <div className="mt-2 flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 select-text text-sm leading-6">{guidance.prompt}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mr-2 shrink-0 gap-1 rounded-lg px-2 text-xs"
                    aria-label={`复制${label}提示词`}
                    onClick={() => void copyPrompt(field)}
                  >
                    {result?.success ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
                    {result?.success ? '已复制' : '复制'}
                  </Button>
                </div>
                {result ? (
                  <p role="status" className={result.success ? 'sr-only' : 'mt-1 text-xs text-[var(--text-secondary)]'}>
                    {result.success ? `已复制${label}提示词` : '复制失败，可以选中文字手动复制。'}
                  </p>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6">
          <p id={descriptionId} className="flex min-h-24 items-center py-5 text-sm leading-6 text-[var(--text-secondary)]">
            {novelPublishMetadataMessage(missing)}
          </p>
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-[var(--border-subtle)] px-4 py-3 sm:px-6">
        {showHelp ? (
          <Button variant="secondary" size="sm" onClick={returnToNotice}>返回</Button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="mr-auto min-h-9 rounded-lg text-sm font-medium text-blue-600 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 dark:text-blue-400"
            >
              如何设置？
            </button>
            <Button variant="secondary" size="sm" onClick={onClose}>我知道了</Button>
          </>
        )}
      </footer>
    </dialog>,
    document.body,
  )
}
