import { StudioPresence } from '@/features/studio/components/StudioPresence'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, ChevronDown, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { NovelOptionSkeleton } from '@/components/ui/Skeleton'
import type { Novel } from '../../../../shared/contracts/index.js'

type WorkspaceNovelSwitcherProps = {
  currentNovelId: string
  currentNovelTitle: string
  novels: Novel[]
  busy?: boolean
  loading?: boolean
  /** 手机端工具条用：按钮占满容器宽度，作品名押左、箭头押右 */
  fullWidth?: boolean
  /** 桌面命令栏仅压缩顶部触发器，不影响下拉列表项的正常行高。 */
  compactTrigger?: boolean
  onSelectNovel: (novelId: string) => void
  onCreateNovel: () => void
}

function getNovelDisplayTitle(novel: Novel) {
  return novel.displayTitle?.trim() || novel.title || '未命名作品'
}

export default function WorkspaceNovelSwitcher({
  currentNovelId,
  currentNovelTitle,
  novels,
  busy = false,
  loading = false,
  fullWidth = false,
  compactTrigger = false,
  onSelectNovel,
  onCreateNovel,
}: WorkspaceNovelSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: 8, top: 56, width: 320, maxHeight: 420 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const offsetLeft = viewport?.offsetLeft ?? 0
      const offsetTop = viewport?.offsetTop ?? 0
      const cardWidth = width < 768 ? width - 16 : Math.min(360, width - 24)
      const top = Math.max(offsetTop + 8, Math.min(rect.bottom + 8, offsetTop + height - 160))
      setPosition({ left: width < 768 ? offsetLeft + 8 : Math.max(offsetLeft + 8, Math.min(rect.left, offsetLeft + width - cardWidth - 8)), top, width: cardWidth, maxHeight: Math.max(120, offsetTop + height - top - 12) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place) }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); rootRef.current?.querySelector('button')?.focus() } }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', handlePointerDown); window.removeEventListener('keydown', escape) }
  }, [open])

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative min-w-0',
        fullWidth && 'w-full',
        compactTrigger && !fullWidth && 'inline-flex w-auto shrink-0',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`选择作品：${currentNovelTitle}`}
        className={cn(
          'inline-flex h-10 min-w-0 max-w-full items-center gap-2 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-sm font-medium text-[var(--text-primary)] transition hover:border-[var(--border-strong)]',
          fullWidth && 'w-full',
          compactTrigger && 'h-8 rounded-none',
        )}
      >
        <BookOpen className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
        <span className={cn('min-w-0 truncate', fullWidth ? 'flex-1 text-left' : 'max-w-[15rem]')}>{currentNovelTitle}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-[var(--text-secondary)] transition', open && 'rotate-180')} />
      </button>

      {typeof document !== 'undefined' && createPortal(
        <StudioPresence kind="menu">{open && <div ref={panelRef} role="region" aria-label="我的作品" style={position} className="studio-workspace fixed z-[180] flex flex-col overflow-hidden rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-2 text-[var(--text-primary)] shadow-[0_20px_48px_rgba(15,23,42,0.16)]">
          <div className="flex items-center justify-between gap-3 px-2 py-2">
            <div className="min-w-0">
              <p className="text-xs tracking-[0.08em] text-[var(--text-secondary)]">我的作品</p>
              <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-secondary)]">切换作品时会一起恢复对应的 Agent 任务。</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onCreateNovel()
            }}
            disabled={busy}
            className="flex w-full items-center gap-3 rounded-[16px] px-3 py-3 text-left transition hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[var(--surface-muted)] text-[var(--text-primary)]">
              <Plus className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-[var(--text-primary)]">新建作品</span>
              <span className="block truncate text-xs text-[var(--text-secondary)]">立即创建并进入创作台</span>
            </span>
          </button>

          <div className="mt-2 min-h-0 space-y-1 overflow-y-auto overscroll-contain">
            {loading && novels.length === 0 ? (
              <NovelOptionSkeleton />
            ) : (
              novels.map((novel) => {
              const isActive = novel.id === currentNovelId
              const title = getNovelDisplayTitle(novel)
              return (
                <button
                  key={novel.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onSelectNovel(novel.id)
                  }}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-[16px] px-3 py-3 text-left transition',
                    isActive ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]' : 'hover:bg-[var(--surface-muted)]',
                  )}
                >
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[var(--surface-muted)] text-sm font-semibold text-[var(--text-primary)]">
                    {title.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block whitespace-normal break-words text-sm font-medium text-[var(--text-primary)]">{title}</span>
                    <span className="block text-xs text-[var(--text-secondary)]">
                      {novel.chapterCount} 章 · {novel.wordCount} 字
                    </span>
                  </span>
                </button>
              )
              })
            )}
          </div>
        </div>}</StudioPresence>, document.fullscreenElement ?? document.body
      )}
    </div>
  )
}
