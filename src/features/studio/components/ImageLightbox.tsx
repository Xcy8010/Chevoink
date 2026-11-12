import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, LoaderCircle, X } from 'lucide-react'

import Button from '@/components/ui/Button'

import { downloadCoverAssetImage } from '../cover-image'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

type ImageLightboxProps = {
  src: string
  alt?: string
  /** 下载时使用的文件名（不传则不显示下载按钮） */
  downloadName?: string
  onClose: () => void
  trapFocus?: boolean
}

/** 图片查看器：全屏放大预览封面图，支持下载，Esc / 点击遮罩关闭 */
export default function ImageLightbox({ src, alt, downloadName, onClose, trapFocus = false }: ImageLightboxProps) {
  const [downloading, setDownloading] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  useDialogFocusTrap({ panel, open: trapFocus, onClose })

  useEffect(() => {
    if (trapFocus) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, trapFocus])

  const handleDownload = async () => {
    if (!downloadName || downloading) return
    setDownloading(true)
    try {
      await downloadCoverAssetImage(src, downloadName)
    } finally {
      setDownloading(false)
    }
  }

  return createPortal(
    <div
      ref={panel}
      tabIndex={trapFocus ? -1 : undefined}
      className="fixed inset-0 z-[140] flex items-center justify-center bg-[rgba(15,23,42,0.72)] px-4 py-8 backdrop-blur-[4px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {downloadName ? (
          <Button
            onClick={handleDownload}
            variant="secondary"
            size="sm"
            disabled={downloading}
            className="border border-[var(--border-subtle)]"
          >
            {downloading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            下载
          </Button>
        ) : null}
        <Button
          onClick={onClose}
          variant="secondary"
          size="sm"
          className="h-9 w-9 border border-[var(--border-subtle)] px-0"
          aria-label="关闭图片预览"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <img
        src={src}
        alt={alt ?? '图片预览'}
        className="max-h-[86vh] max-w-full rounded-[18px] object-contain shadow-[0_24px_64px_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  )
}
