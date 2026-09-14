import { Bug, ImagePlus, Lightbulb, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import {
  FEEDBACK_QQ_GROUP_NUMBER,
  FEEDBACK_QQ_GROUP_URL,
  MAX_FEEDBACK_IMAGE_COUNT,
  type FeedbackKind,
} from '../../../../shared/contracts'
import { submitFeedback } from '../api'
import { FEEDBACK_CAPTURE_IGNORE_ATTR, captureViewportScreenshot, prepareFeedbackImage } from '../feedback-media'

type FeedbackDialogProps = {
  open: boolean
  kind: FeedbackKind
  /** 提交来源标记（如 studio-work / studio-ide / studio-mobile），便于后台定位场景 */
  source?: string
  onClose: () => void
}

type FeedbackImage = {
  id: string
  dataUrl: string
  /** 自动截取的当前界面（与用户手动添加的图区分展示） */
  auto: boolean
}

const KIND_COPY: Record<FeedbackKind, { title: string; label: string; placeholder: string; submitting: string }> = {
  bug: {
    title: '问题反馈',
    label: '问题描述',
    placeholder: '请描述遇到的问题、出现的位置以及复现步骤，越具体越有助于我们定位。',
    submitting: '正在提交反馈…',
  },
  suggestion: {
    title: '提交建议',
    label: '建议内容',
    placeholder: '请描述你希望新增或改进的功能，以及它能帮你解决什么问题。',
    submitting: '正在提交建议…',
  },
}

function createImageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default function FeedbackDialog({ open, kind, source, onClose }: FeedbackDialogProps) {
  const toast = useToast()
  const copy = KIND_COPY[kind]
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [images, setImages] = useState<FeedbackImage[]>([])
  const [capturing, setCapturing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)

  // 图片列表的单一写入口：逐张异步压缩时需要同步读到最新张数，不能依赖已提交的 state
  const imagesRef = useRef<FeedbackImage[]>([])
  const updateImages = useCallback((updater: (current: FeedbackImage[]) => FeedbackImage[]) => {
    imagesRef.current = updater(imagesRef.current)
    setImages(imagesRef.current)
  }, [])

  // 打开即重置表单，并自动截取当前界面（弹窗自身被截图过滤器排除，不会拍到自己）
  useEffect(() => {
    if (!open) {
      return
    }

    let cancelled = false
    setContent('')
    setContact('')
    updateImages(() => [])
    setDragging(false)
    setCapturing(true)

    captureViewportScreenshot()
      .then((dataUrl) => {
        if (cancelled || !dataUrl) {
          return
        }
        updateImages((current) =>
          current.length >= MAX_FEEDBACK_IMAGE_COUNT ? current : [{ id: createImageId(), dataUrl, auto: true }, ...current],
        )
      })
      .finally(() => {
        if (!cancelled) {
          setCapturing(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, kind, updateImages])

  useEffect(() => {
    if (!open) {
      return
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const appendFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) {
        return
      }

      const slots = MAX_FEEDBACK_IMAGE_COUNT - imagesRef.current.length
      if (slots <= 0) {
        toast.error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片。`)
        return
      }
      if (files.length > slots) {
        toast.error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片，多余的已忽略。`)
      }

      for (const file of files.slice(0, slots)) {
        try {
          const dataUrl = await prepareFeedbackImage(file)
          updateImages((current) =>
            current.length >= MAX_FEEDBACK_IMAGE_COUNT ? current : [...current, { id: createImageId(), dataUrl, auto: false }],
          )
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '这张图片无法添加，请换一张再试。')
        }
      }
    },
    [toast, updateImages],
  )

  function handleRemoveImage(id: string) {
    updateImages((current) => current.filter((image) => image.id !== id))
  }

  async function handleSubmit() {
    const trimmed = content.trim()
    if (!trimmed) {
      toast.error(`请先填写${copy.label}。`)
      return
    }
    if (submitting) {
      return
    }

    setSubmitting(true)
    try {
      await submitFeedback({
        kind,
        content: trimmed,
        contact: contact.trim() || undefined,
        imageDataUrls: images.map((image) => image.dataUrl),
        source,
        pageUrl: window.location.href,
        clientInfo: {
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        },
      })
      toast.success(kind === 'bug' ? '反馈已提交，感谢你的帮助！' : '建议已提交，感谢你的分享！')
      onClose()
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '提交失败，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return null
  }

  const reachedLimit = images.length >= MAX_FEEDBACK_IMAGE_COUNT

  return createPortal(
    <div
      {...{ [FEEDBACK_CAPTURE_IGNORE_ATTR]: '' }}
      className={`${source?.startsWith('studio') ? 'studio-workspace ' : ''}feedback-dialog fixed inset-0 z-[140] flex items-center justify-center bg-[rgba(15,23,42,0.32)] px-4 py-6 backdrop-blur-[2px]`}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose()
        }
      }}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_24px_64px_rgba(15,23,42,0.22)]"
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
          if (files.length) {
            event.preventDefault()
            void appendFiles(files)
          }
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] bg-[var(--surface-muted)] text-[var(--text-primary)]">
              {kind === 'bug' ? <Bug className="h-4 w-4" /> : <Lightbulb className="h-4 w-4" />}
            </span>
            <div>
              <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">{copy.title}</h3>
              <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">已自动截取当前界面，可继续补充图片</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="关闭"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {copy.label}
              <span className="ml-1 text-[rgb(220,38,38)]">*</span>
            </span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              maxLength={4000}
              placeholder={copy.placeholder}
              className="w-full resize-none rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-solid)] px-3 py-2.5 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]"
            />
          </label>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-secondary)]">图片</span>
              <span className="text-xs text-[var(--text-tertiary)]">
                {images.length}/{MAX_FEEDBACK_IMAGE_COUNT} · 单张 ≤ 20MB
              </span>
            </div>

            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
                void appendFiles(files)
              }}
              className={`rounded-[12px] border border-dashed p-3 transition-colors ${
                dragging ? 'border-[var(--border-strong)] bg-[var(--surface-muted)]' : 'border-[var(--border-subtle)]'
              }`}
            >
              <div className="flex flex-wrap gap-2">
                {images.map((image) => (
                  <div
                    key={image.id}
                    className="relative h-20 w-20 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-muted)]"
                  >
                    <img src={image.dataUrl} alt="反馈附图" className="h-full w-full object-cover" />
                    {image.auto ? (
                      <span className="absolute bottom-0 left-0 right-0 bg-black/55 py-0.5 text-center text-[10px] text-white">
                        当前界面
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(image.id)}
                      aria-label="移除图片"
                      className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}

                {capturing ? (
                  <div className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    <span className="text-[10px]">截取中</span>
                  </div>
                ) : null}

                {reachedLimit ? null : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[10px] border border-[var(--border-subtle)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                  >
                    <ImagePlus className="h-4 w-4" />
                    <span className="text-[10px]">添加图片</span>
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">支持点击添加，也可以直接把图片拖到这里或粘贴</p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void appendFiles(files)
              }}
            />
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">联系方式</span>
            <input
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              maxLength={160}
              placeholder="可填写邮箱、手机号、微信、QQ 等常用联系方式"
              className="h-10 w-full rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-solid)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]"
            />
          </label>

          <p className="text-xs leading-6 text-[var(--text-tertiary)]">
            加入 QQ 交流群：
            <a
              href={FEEDBACK_QQ_GROUP_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--text-primary)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--text-secondary)]"
            >
              点击链接加入群聊：{FEEDBACK_QQ_GROUP_NUMBER}
            </a>
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3.5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting || !content.trim()}>
            {submitting ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {copy.submitting}
              </>
            ) : (
              '提交'
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
