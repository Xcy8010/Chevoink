import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'

import { isImageLoaded, markImageLoaded } from '@/lib/image-cache'
import { cn } from '@/lib/utils'

type AppImageProps = {
  src: string
  alt: string
  /** 布局类（宽高/比例/圆角/边框/阴影等），作用在外层容器上 */
  className?: string
  /** 追加到 img 上的类（滤镜、hover 效果等） */
  imgClassName?: string
  /** 图片适配方式，默认 cover */
  fit?: 'cover' | 'contain'
  /** 首屏关键图设为 true 关闭懒加载 */
  priority?: boolean
  /**
   * natural：图片按自身宽高参与布局（不撑满容器），
   * 用于尺寸不确定的场景（如帖子单图），加载期间以 placeholderClassName 占位
   */
  natural?: boolean
  /** natural 模式加载中/失败时的占位尺寸类 */
  placeholderClassName?: string
  draggable?: boolean
  fallback?: ReactNode
}

/**
 * 全站统一图片组件：加载中显示骨架 shimmer，完成后整张淡入，失败显示占位图标。
 * 用户永远只会看到「骨架」或「完整图片」两种状态，不会出现逐行扫描的半张图。
 */
export default function AppImage({
  src,
  alt,
  className,
  imgClassName,
  fit = 'cover',
  priority = false,
  natural = false,
  placeholderClassName,
  draggable,
  fallback,
}: AppImageProps) {
  // 本次会话已加载过的图直接以完成态渲染（SPA 重新挂载不再重复播放骨架与淡入）
  const cachedOnMount = isImageLoaded(src)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(
    cachedOnMount ? 'loaded' : 'loading',
  )
  // 已加载过的图片直接显示，不播放淡入过渡
  const instantRef = useRef(cachedOnMount)
  // 记录上一次的 src：挂载时不能重置状态，否则会覆盖上面算好的完成态
  const previousSrcRef = useRef(src)

  // src 真正变化（如封面更换）时回到骨架态重新加载；新地址已加载过则保持直显
  useEffect(() => {
    if (previousSrcRef.current === src) {
      return
    }
    previousSrcRef.current = src
    const cached = isImageLoaded(src)
    instantRef.current = cached
    setStatus(cached ? 'loaded' : 'loading')
  }, [src])

  const handleLoaded = (instant: boolean) => {
    markImageLoaded(src)
    if (instant) {
      instantRef.current = true
    }
    setStatus('loaded')
  }

  // 命中浏览器缓存时 onLoad 可能不触发，挂载时直接检查完成态避免骨架闪烁
  const handleImgRef = (node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth > 0) {
      handleLoaded(true)
    }
  }

  const imgElement =
    status === 'error' ? null : (
      <img
        ref={handleImgRef}
        src={src}
        // 已加载过的图不再懒加载：已按完成态渲染，懒加载会让空白多停留一帧
        loading={priority || status === 'loaded' ? undefined : 'lazy'}
        alt={alt}
        decoding="async"
        draggable={draggable}
        onLoad={() => handleLoaded(false)}
        onError={() => setStatus('error')}
        className={cn(
          !instantRef.current && 'transition-opacity duration-200',
          natural && status === 'loaded'
            ? 'block'
            : cn('absolute inset-0 h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover'),
          status === 'loaded' ? 'opacity-100' : 'opacity-0',
          imgClassName,
        )}
      />
    )

  if (natural) {
    return (
      <span className={cn('relative block overflow-hidden', className)}>
        {status !== 'loaded' ? (
          <span
            aria-hidden
            className={cn(
              'block',
              status === 'error'
                ? 'flex items-center justify-center bg-[var(--surface-muted)]'
                : 'skeleton-shimmer',
              placeholderClassName ?? 'aspect-[4/3] w-[240px] max-w-full',
            )}
          >
            {status === 'error' ? fallback ?? <ImageOff className="h-5 w-5 text-[var(--text-tertiary)]" /> : null}
          </span>
        ) : null}
        {imgElement}
      </span>
    )
  }

  return (
    <span className={cn('relative block overflow-hidden', className)}>
      {status !== 'loaded' ? (
        <span
          aria-hidden
          className={cn(
            'absolute inset-0',
            status === 'error'
              ? 'flex items-center justify-center bg-[var(--surface-muted)]'
              : 'skeleton-shimmer',
          )}
        >
          {status === 'error' ? fallback ?? <ImageOff className="h-5 w-5 text-[var(--text-tertiary)]" /> : null}
        </span>
      ) : null}
      {imgElement}
    </span>
  )
}
