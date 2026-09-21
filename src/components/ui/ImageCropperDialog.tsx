import { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'

import Button from '@/components/ui/Button'

interface ImageCropperDialogProps {
  open: boolean
  /** 待裁剪图片的 dataURL */
  imageDataUrl: string | null
  /** 裁剪框宽高比（宽/高），个人封面统一 3:1 */
  aspect?: number
  title?: string
  description?: string
  submitting?: boolean
  onCancel: () => void
  /** 确认裁剪：回传裁剪后的 JPEG dataURL */
  onConfirm: (croppedDataUrl: string) => void
}

const OUTPUT_WIDTH = 1536
const MIN_ZOOM = 1
const MAX_ZOOM = 3

/**
 * 图片裁剪弹窗（TikTok 式封面编辑）：固定比例视口 + 拖拽平移 + 缩放滑杆，
 * 导出固定尺寸 JPEG，保证个人封面长宽比一致。
 */
export default function ImageCropperDialog({
  open,
  imageDataUrl,
  aspect = 3,
  title = '调整封面',
  description = '拖动图片调整位置，滑动调整缩放，裁剪区域外的部分不会展示。',
  submitting = false,
  onCancel,
  onConfirm,
}: ImageCropperDialogProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  // 打开新图片时重置缩放与位移
  useEffect(() => {
    if (open) {
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setImageSize(null)
    }
  }, [open, imageDataUrl])

  // 视口宽度随窗口变化实时测量，保证拖拽边界与导出映射准确
  useEffect(() => {
    if (!open) {
      return
    }

    function measure() {
      setViewportWidth(viewportRef.current?.clientWidth ?? 0)
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  const viewportHeight = viewportWidth > 0 ? viewportWidth / aspect : 0

  // 基础缩放：图片恰好铺满视口（cover），zoom 在此基础上放大
  const baseScale =
    imageSize && viewportWidth > 0
      ? Math.max(viewportWidth / imageSize.width, viewportHeight / imageSize.height)
      : 0
  const displayScale = baseScale * zoom
  const displayWidth = imageSize ? imageSize.width * displayScale : 0
  const displayHeight = imageSize ? imageSize.height * displayScale : 0

  const clampOffset = useCallback(
    (next: { x: number; y: number }) => {
      const maxX = Math.max(0, (displayWidth - viewportWidth) / 2)
      const maxY = Math.max(0, (displayHeight - viewportHeight) / 2)
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      }
    },
    [displayWidth, displayHeight, viewportWidth, viewportHeight],
  )

  // 缩放变化后位移可能越界，实时收回边界内
  useEffect(() => {
    setOffset((current) => clampOffset(current))
  }, [zoom, clampOffset])

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    setOffset(
      clampOffset({
        x: drag.baseX + (event.clientX - drag.startX),
        y: drag.baseY + (event.clientY - drag.startY),
      }),
    )
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }

  function handleConfirm() {
    const image = imageRef.current
    if (!image || !imageSize || viewportWidth <= 0 || displayScale <= 0) {
      return
    }

    // 视口左上角映射回原图坐标，按视口:输出的比例绘制
    const sourceX = (displayWidth / 2 - viewportWidth / 2 - offset.x) / displayScale
    const sourceY = (displayHeight / 2 - viewportHeight / 2 - offset.y) / displayScale
    const sourceWidth = viewportWidth / displayScale
    const sourceHeight = viewportHeight / displayScale

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_WIDTH
    canvas.height = Math.round(OUTPUT_WIDTH / aspect)
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
    onConfirm(canvas.toDataURL('image/jpeg', 0.85))
  }

  if (!open || !imageDataUrl) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 items-center justify-center overflow-hidden bg-black/45 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-0 shadow-[var(--shadow-modal)] sm:max-h-[calc(100dvh-3rem)] sm:p-6">
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-0 sm:pt-0">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h3>
            <p className="text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            className="press-feedback -mr-1 -mt-1 rounded-full p-2 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4 [-webkit-overflow-scrolling:touch] sm:px-0 sm:pb-0 sm:pt-4">
          <div
            ref={viewportRef}
            className="relative w-full touch-none select-none overflow-hidden rounded-[var(--radius-lg)] bg-black/80"
          style={{ aspectRatio: `${aspect} / 1`, cursor: dragRef.current ? 'grabbing' : 'grab' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <img
            ref={imageRef}
            src={imageDataUrl}
            alt="封面裁剪预览"
            draggable={false}
            onLoad={(event) =>
              setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
            className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
            style={{
              width: displayWidth > 0 ? `${displayWidth}px` : undefined,
              height: displayHeight > 0 ? `${displayHeight}px` : undefined,
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            }}
          />
          </div>

        <div className="mt-4 flex items-center gap-3">
          <Minus className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label="缩放"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--surface-muted)] accent-[var(--color-brand)]"
          />
          <Plus className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button type="button" variant="primary" onClick={handleConfirm} disabled={submitting || !imageSize}>
            {submitting ? '保存中…' : '保存封面'}
          </Button>
        </div>
        </div>
      </div>
    </div>
  )
}
