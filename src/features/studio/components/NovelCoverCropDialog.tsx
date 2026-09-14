import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Move, Search, X } from 'lucide-react'

import Button from '@/components/ui/Button'

import {
  COVER_PREVIEW_HEIGHT,
  COVER_PREVIEW_WIDTH,
  clampNovelCoverCropState,
  createNovelCoverCropSource,
  getNovelCoverPreviewMetrics,
  type NovelCoverCropState,
} from '../cover-image'

type NovelCoverCropDialogProps = {
  file: File | null
  open: boolean
  busy?: boolean
  onClose: () => void
  onConfirm: (crop: NovelCoverCropState) => void
}

const INITIAL_CROP: NovelCoverCropState = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
}

export default function NovelCoverCropDialog({
  file,
  open,
  busy = false,
  onClose,
  onConfirm,
}: NovelCoverCropDialogProps) {
  const [source, setSource] = useState<{ image: HTMLImageElement; dataUrl: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [crop, setCrop] = useState<NovelCoverCropState>(INITIAL_CROP)

  useEffect(() => {
    if (!open || !file) {
      setSource(null)
      setCrop(INITIAL_CROP)
      setError('')
      return
    }

    let cancelled = false
    setLoading(true)
    setError('')
    setCrop(INITIAL_CROP)

    void createNovelCoverCropSource(file)
      .then((nextSource) => {
        if (!cancelled) {
          setSource(nextSource)
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : '读取封面图片失败。')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [file, open])

  const previewMetrics = useMemo(() => {
    if (!source) {
      return null
    }

    return getNovelCoverPreviewMetrics(source.image, crop)
  }, [crop, source])

  if (!open || !file) {
    return null
  }

  return (
    <div className="studio-workspace fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-4 backdrop-blur-[2px]">
      <div className="absolute inset-0" onClick={() => !busy && onClose()} />
      <div className="relative z-[1] w-full max-w-[920px] rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-6 shadow-[var(--shadow-soft)]">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold text-[var(--text-primary)]">裁切作品封面</h3>
            <p className="text-sm leading-7 text-[var(--text-secondary)]">
              在固定书封比例框内调整图片位置和缩放，最终会统一输出成标准书籍封面尺寸。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-4">
              <div
                className="relative mx-auto overflow-hidden rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-solid)]"
                style={{ width: COVER_PREVIEW_WIDTH, height: COVER_PREVIEW_HEIGHT }}
              >
                {loading ? (
                  <div className="flex h-full items-center justify-center text-[var(--text-tertiary)]">
                    <LoaderCircle className="h-5 w-5 animate-spin" />
                  </div>
                ) : error ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-rose-600 dark:text-rose-300">
                    {error}
                  </div>
                ) : previewMetrics && source ? (
                  <>
                    <img
                      src={source.dataUrl}
                      alt="封面裁切预览"
                      className="pointer-events-none absolute select-none object-cover"
                      style={{
                        left: previewMetrics.drawX,
                        top: previewMetrics.drawY,
                        width: previewMetrics.drawWidth,
                        height: previewMetrics.drawHeight,
                        maxWidth: 'none',
                      }}
                    />
                    <div className="pointer-events-none absolute inset-0 rounded-[24px] ring-1 ring-black/10 dark:ring-white/10" />
                  </>
                ) : null}
              </div>
            </div>
            <div className="rounded-[24px] bg-[var(--surface-muted)] px-4 py-4 text-sm leading-7 text-[var(--text-secondary)]">
              选取框固定为书籍封面比例，输出后会统一成标准竖版书封。
            </div>
          </div>

          <div className="grid gap-5">
            <label className="grid gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                <Search className="h-4 w-4 text-[var(--text-tertiary)]" />
                缩放
              </span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={crop.zoom}
                disabled={!source || loading || busy}
                onChange={(event) => {
                  if (!source) {
                    return
                  }

                  setCrop((current) =>
                    clampNovelCoverCropState(source.image, {
                      ...current,
                      zoom: Number(event.target.value),
                    }),
                  )
                }}
              />
            </label>

            <label className="grid gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                <Move className="h-4 w-4 text-[var(--text-tertiary)]" />
                左右位置
              </span>
              <input
                type="range"
                min={previewMetrics ? -previewMetrics.maxOffsetX : 0}
                max={previewMetrics ? previewMetrics.maxOffsetX : 0}
                step={1}
                value={crop.offsetX}
                disabled={!previewMetrics || busy}
                onChange={(event) => {
                  if (!source) {
                    return
                  }

                  setCrop((current) =>
                    clampNovelCoverCropState(source.image, {
                      ...current,
                      offsetX: Number(event.target.value),
                    }),
                  )
                }}
              />
            </label>

            <label className="grid gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                <Move className="h-4 w-4 text-[var(--text-tertiary)]" />
                上下位置
              </span>
              <input
                type="range"
                min={previewMetrics ? -previewMetrics.maxOffsetY : 0}
                max={previewMetrics ? previewMetrics.maxOffsetY : 0}
                step={1}
                value={crop.offsetY}
                disabled={!previewMetrics || busy}
                onChange={(event) => {
                  if (!source) {
                    return
                  }

                  setCrop((current) =>
                    clampNovelCoverCropState(source.image, {
                      ...current,
                      offsetY: Number(event.target.value),
                    }),
                  )
                }}
              />
            </label>

            <div className="rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-4 text-sm leading-7 text-[var(--text-secondary)]">
              拖不动没关系，直接用这三个滑杆就可以把图片调整到统一封面视图里。
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button
                type="button"
                onClick={() => onConfirm(crop)}
                disabled={busy || loading || Boolean(error) || !source}
              >
                {busy ? '处理中...' : '确认使用这张裁切图'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
