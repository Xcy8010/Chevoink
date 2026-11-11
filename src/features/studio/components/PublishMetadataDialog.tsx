import { useEffect, useRef, useState } from 'react'

import Button from '@/components/ui/Button'
import {
  NOVEL_PUBLISH_FIELDS,
  novelPublishMetadataMessage,
  type NovelPublishField,
} from '../../../../shared/contracts/novel-publish.js'
import ConfirmDialog from './ConfirmDialog'

const GUIDANCE = {
  cover: {
    path: '封面工坊 → 本地上传封面或生成封面 → 设为作品封面',
    panel: 'cover',
    linkLabel: '打开封面工坊',
    prompt: '请根据当前作品的书名和故事内容生成一张封面候选图，给我预览，确认后设为作品封面。',
  },
  summary: {
    path: '作品设置 → 作品简介 → 保存作品设置',
    panel: 'meta',
    linkLabel: '打开作品设置',
    prompt: '请根据当前作品的人物和主要冲突写一段不剧透的作品简介，并保存到当前作品的简介。',
  },
  tags: {
    path: '作品设置 → 标签 → 保存作品设置',
    panel: 'meta',
    linkLabel: '打开作品设置',
    prompt: '请从站内标签库选择与当前作品题材和风格最匹配的标签，并保存到当前作品的标签。',
  },
} as const

export default function PublishMetadataDialog({ missing, onClose, onOpenPanel }: {
  missing: NovelPublishField[]
  onClose: () => void
  onOpenPanel: (panel: 'cover' | 'meta') => void
}) {
  const [showHelp, setShowHelp] = useState(false)
  const [copyResult, setCopyResult] = useState<{ field: NovelPublishField; message: string } | null>(null)
  const helpLink = useRef<HTMLButtonElement>(null)
  const helpContent = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showHelp) helpContent.current?.focus({ preventScroll: true })
    else helpLink.current?.focus({ preventScroll: true })
  }, [showHelp])

  async function copyPrompt(field: NovelPublishField) {
    try {
      await navigator.clipboard.writeText(GUIDANCE[field].prompt)
      setCopyResult({ field, message: `已复制${NOVEL_PUBLISH_FIELDS[field]}提示词` })
    } catch {
      setCopyResult({ field, message: '复制失败，可以选中上方文字手动复制。' })
    }
  }

  return (
    <ConfirmDialog
      open
      title={showHelp ? '如何设置作品信息' : '还不能发布这部作品'}
      description={showHelp ? '你可以手动设置，也可以把提示词复制到当前作品的 Agent 输入框。' : novelPublishMetadataMessage(missing)}
      confirmLabel="我知道了"
      cancelLabel={showHelp ? '返回' : null}
      onCancel={showHelp ? () => { setShowHelp(false); setCopyResult(null) } : onClose}
      onConfirm={onClose}
    >
      {showHelp ? (
        <div ref={helpContent} tabIndex={-1} className="mt-4 space-y-3 outline-none">
          {missing.map((field) => {
            const guidance = GUIDANCE[field]
            return (
              <section key={field} className="space-y-2 rounded-2xl border border-[var(--border-subtle)] p-3">
                <h4 className="text-sm font-semibold text-[var(--text-primary)]">{NOVEL_PUBLISH_FIELDS[field]}</h4>
                <p className="text-sm leading-6 text-[var(--text-secondary)]">{guidance.path}</p>
                <p className="select-text rounded-xl bg-[var(--surface-muted)] p-3 text-sm leading-6 text-[var(--text-primary)]">{guidance.prompt}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => onOpenPanel(guidance.panel)}>{guidance.linkLabel}</Button>
                  <Button variant="secondary" size="sm" onClick={() => void copyPrompt(field)}>复制提示词</Button>
                </div>
                {copyResult?.field === field ? <p role="status" className="text-xs text-[var(--text-secondary)]">{copyResult.message}</p> : null}
              </section>
            )
          })}
        </div>
      ) : (
        <button
          ref={helpLink}
          type="button"
          onClick={() => setShowHelp(true)}
          className="mt-3 rounded px-1 py-1 text-sm font-medium text-blue-600 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 dark:text-blue-400"
        >
          如何设置？
        </button>
      )}
    </ConfirmDialog>
  )
}
