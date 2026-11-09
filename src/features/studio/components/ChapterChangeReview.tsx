import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, X } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { ChapterPendingReview } from '../types'
import { REVIEW_DIFF_LINE_LIMIT, buildReviewDiff, countReviewDiffLines, type ReviewDiffSegment } from './diff'

type ChapterChangeReviewProps = {
  review: ChapterPendingReview
  busy?: boolean
  /** 浮动审查条「采纳」：保留整章全部变更 */
  onKeep: () => void
  /** 浮动审查条「拒绝」：撤销整章全部变更（上游负责自定义弹窗确认） */
  onRevert: () => void
  /** 块级 ✓：仅采纳这一处变更块 */
  onAcceptHunk?: (hunkIndex: number) => void
  /** 块级 ✕：仅撤回这一处变更块（上游负责自定义弹窗确认） */
  onRejectHunk?: (hunkIndex: number) => void
  /** 待审文件序号（1 基）与总数，用于审查条「文件 x/y」多章导航 */
  fileIndex?: number
  fileCount?: number
  onNavigateFile?: (offset: 1 | -1) => void
  className?: string
  mobile?: boolean
  onMobileScroll?: (top: number) => void
}

/** 把 diff 片段按 hunk 分组成渲染块：未变更片段独立成块，同一 hunk 的红/绿片段合成一块并挂块级定夺按钮 */
type RenderBlock = {
  hunkIndex: number | null
  segments: ReviewDiffSegment[]
}

function groupSegments(segments: ReviewDiffSegment[]): RenderBlock[] {
  const blocks: RenderBlock[] = []
  for (const segment of segments) {
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock && lastBlock.hunkIndex === segment.hunkIndex) {
      lastBlock.segments.push(segment)
      continue
    }
    blocks.push({ hunkIndex: segment.hunkIndex, segments: [segment] })
  }
  return blocks
}

export default function ChapterChangeReview({
  review,
  busy = false,
  onKeep,
  onRevert,
  onAcceptHunk,
  onRejectHunk,
  fileIndex = 1,
  fileCount = 1,
  onNavigateFile,
  className,
  mobile = false,
  onMobileScroll,
}: ChapterChangeReviewProps) {
  const { segments, hunkCount } = useMemo(
    () => buildReviewDiff(review.before?.content ?? '', review.after.content),
    [review.after.content, review.before?.content],
  )
  const blocks = useMemo(() => groupSegments(segments), [segments])

  // 超大 diff 截断渲染：默认只渲染前 REVIEW_DIFF_LINE_LIMIT 行，点「展开完整对比」后全量渲染
  const totalLines = useMemo(() => countReviewDiffLines(segments), [segments])
  const [expanded, setExpanded] = useState(false)
  const truncated = !expanded && totalLines > REVIEW_DIFF_LINE_LIMIT
  const visibleBlocks = useMemo(() => {
    if (!truncated) {
      return blocks
    }
    const result: RenderBlock[] = []
    let lineBudget = REVIEW_DIFF_LINE_LIMIT
    for (const block of blocks) {
      if (lineBudget <= 0) break
      result.push(block)
      lineBudget -= countReviewDiffLines(block.segments)
    }
    return result
  }, [blocks, truncated])

  const [activeHunk, setActiveHunk] = useState(0)
  const hunkRefs = useRef<Array<HTMLDivElement | null>>([])
  const mobileViewport = useRef<HTMLDivElement>(null)
  const deferredMobileFocus = useRef<number | null>(null)
  const [mobileHunkVisible, setMobileHunkVisible] = useState(false)
  const currentHunk = Math.min(activeHunk, hunkCount - 1)

  const revealMobileHunk = useCallback((index: number) => {
    const viewport = mobileViewport.current
    const target = hunkRefs.current[index]
    if (!viewport || !target) return
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12
  }, [])

  const syncMobileHunk = useCallback(() => {
    const viewport = mobileViewport.current
    if (!viewport) return
    onMobileScroll?.(viewport.scrollTop)
    const { top, bottom } = viewport.getBoundingClientRect()
    const isVisible = (node: HTMLDivElement | null) => {
      if (!node) return false
      const bounds = node.getBoundingClientRect()
      const visibleHeight = Math.min(bounds.bottom, bottom) - Math.max(bounds.top, top)
      return visibleHeight > 0 && visibleHeight >= Math.min(12, (bounds.bottom - bounds.top) / 2)
    }
    const index = isVisible(hunkRefs.current[currentHunk]) ? currentHunk : hunkRefs.current.findIndex(isVisible)
    if (index >= 0 && index !== currentHunk) setActiveHunk(index)
    setMobileHunkVisible(index >= 0)
  }, [currentHunk, onMobileScroll])

  useLayoutEffect(() => {
    if (!mobile) return
    const deferred = deferredMobileFocus.current
    if (deferred !== null && hunkRefs.current[deferred]) {
      deferredMobileFocus.current = null
      revealMobileHunk(deferred)
    }
    syncMobileHunk()
  }, [mobile, revealMobileHunk, syncMobileHunk, visibleBlocks])

  useEffect(() => {
    const viewport = mobileViewport.current
    if (!viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncMobileHunk)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [syncMobileHunk])

  function focusMobileHunk(index: number) {
    setActiveHunk(index)
    if (truncated && !hunkRefs.current[index]) {
      deferredMobileFocus.current = index
      setExpanded(true)
      return
    }
    revealMobileHunk(index)
  }

  // 块数因逐块定夺而减少时，把当前焦点块收回到有效范围
  useEffect(() => {
    setActiveHunk((current) => Math.min(current, Math.max(hunkCount - 1, 0)))
  }, [hunkCount])

  function focusHunk(nextIndex: number) {
    if (hunkCount === 0) {
      return
    }
    const clamped = ((nextIndex % hunkCount) + hunkCount) % hunkCount
    setActiveHunk(clamped)
    hunkRefs.current[clamped]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // IDE 式快捷键：Ctrl+Enter 采纳整章、Ctrl+Backspace 拒绝整章（桌面端）；
  // 焦点在输入框（如 Agent 对话框）时忽略，避免打字时误触
  useEffect(() => {
    if (mobile) return
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || busy) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        onKeep()
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        onRevert()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, mobile, onKeep, onRevert])

  if (mobile) {
    const newChapter = review.rollbackSnapshot.kind === 'remove_created_chapter'
    const arrowClassName = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] active:bg-[var(--surface-muted)] disabled:opacity-35'
    const hunkActionClassName = 'min-h-11 whitespace-nowrap rounded-md px-2 text-sm font-medium disabled:opacity-40'
    return (
      <>
        <div ref={mobileViewport} onScroll={syncMobileHunk} data-mobile-manuscript className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-3 [-webkit-overflow-scrolling:touch]">
          {newChapter ? <p className="mb-3 text-xs text-[var(--text-secondary)]">新章节 · 待确认</p> : null}
          <div className="studio-editor-content text-[var(--text-primary)]">
            {visibleBlocks.map((block, blockIndex) => {
              const { hunkIndex } = block
              const active = hunkIndex !== null && hunkIndex === currentHunk
              return (
                <div
                  key={blockIndex}
                  ref={hunkIndex === null ? undefined : (node) => { hunkRefs.current[hunkIndex] = node }}
                  aria-current={active ? 'true' : undefined}
                  className={cn(hunkIndex !== null && (!newChapter || hunkCount > 1) &&
                    (active ? 'shadow-[-2px_0_0_var(--color-success)] -ml-2 pl-2' : 'shadow-[-1px_0_0_var(--border-strong)] -ml-2 pl-2'))}
                >
                  {block.segments.map((segment, index) => {
                    const text = segment.text.endsWith('\n') ? `${segment.text}\u00a0` : segment.text || '\u00a0'
                    const paragraphClassName = 'block whitespace-pre-wrap break-words'
                    if (segment.kind !== 'removed') return <div key={index} className={paragraphClassName}>{text}</div>
                    return segment.text.trim()
                      ? <del key={index} className={cn(paragraphClassName, 'text-[var(--color-error)] line-through')}>{text}</del>
                      : <span key={index} className="block text-xs leading-6 text-[var(--color-error)]">删除空行</span>
                  })}
                </div>
              )
            })}
            {truncated ? (
              <button type="button" onClick={() => setExpanded(true)} className="mt-3 min-h-11 text-sm text-[var(--text-secondary)] underline underline-offset-4">
                展开完整对比
              </button>
            ) : null}
          </div>
        </div>
        {hunkCount > 0 ? (
          <div role="group" aria-label="当前变更操作" aria-busy={busy} className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-t border-[var(--border-subtle)] bg-[var(--surface-default)] px-2 py-1">
            <div className="flex items-center">
              <button type="button" onClick={() => focusMobileHunk(currentHunk - 1)} disabled={busy || currentHunk <= 0} aria-label="上一处变更" className={arrowClassName}>
                <ArrowUp aria-hidden="true" className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => focusMobileHunk(currentHunk)} disabled={busy} aria-label={`定位第 ${currentHunk + 1} 处变更，共 ${hunkCount} 处`} className="min-h-11 min-w-11 whitespace-nowrap rounded-md px-1 text-xs tabular-nums text-[var(--text-secondary)] active:bg-[var(--surface-muted)] disabled:opacity-40">
                {currentHunk + 1} / {hunkCount}
              </button>
              <button type="button" onClick={() => focusMobileHunk(currentHunk + 1)} disabled={busy || currentHunk >= hunkCount - 1} aria-label="下一处变更" className={arrowClassName}>
                <ArrowDown aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onRejectHunk?.(currentHunk)} disabled={busy || !mobileHunkVisible || !onRejectHunk} className={cn(hunkActionClassName, 'text-[var(--text-secondary)] active:bg-[var(--surface-muted)]')}>撤回此处</button>
              <button type="button" onClick={() => onAcceptHunk?.(currentHunk)} disabled={busy || !mobileHunkVisible || !onAcceptHunk} className={cn(hunkActionClassName, 'bg-[var(--surface-contrast)] text-[var(--text-contrast)] active:bg-[var(--surface-contrast-hover)]')}>保留此处</button>
            </div>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div className={cn('relative flex h-full min-h-0 flex-col', className)}>
      <div className="flex min-h-0 flex-1 flex-col rounded-[24px] border border-[var(--border-strong)] bg-[var(--surface-default)]">
        {/* 标题在滚动区外：与正常编辑态一致，滚动 diff 正文时不会从标题上方穿透 */}
        <div className="border-b border-[var(--border-subtle)] px-5 pb-4 pt-5">
          <p className="text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)]">
            {review.after.title.trim() || `第 ${review.after.orderIndex} 章`}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-tertiary)]">
            {review.description} · 绿色背景为新增、红色背景为删除，可逐块或整章定夺。
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-24 pt-4">
          <div className="text-sm leading-8 text-[var(--text-primary)]">
          {visibleBlocks.map((block, blockIndex) => {
            if (block.hunkIndex === null) {
              return (
                <div key={`plain-${blockIndex}`} className="whitespace-pre-wrap break-words">
                  {block.segments.map((segment) => segment.text).join('\n') || '\u00A0'}
                </div>
              )
            }

            const hunkIndex = block.hunkIndex
            return (
              <div
                key={`hunk-${blockIndex}`}
                ref={(element) => {
                  hunkRefs.current[hunkIndex] = element
                }}
                className={cn(
                  'relative my-1 rounded-[10px]',
                  activeHunk === hunkIndex && 'ring-1 ring-[rgba(15,23,42,0.30)]',
                )}
              >
                {block.segments.map((segment, segmentIndex) =>
                  segment.kind === 'removed' && segment.text === '' ? null : (
                    <div
                      key={`seg-${segmentIndex}`}
                      className={cn(
                        'whitespace-pre-wrap break-words rounded-[6px] px-1',
                        segment.kind === 'added' && 'bg-[rgba(34,197,94,0.16)]',
                        segment.kind === 'removed' && 'bg-[rgba(239,68,68,0.16)]',
                      )}
                    >
                      {segment.text || '\u00A0'}
                    </div>
                  ),
                )}
                {/* 块级定夺：片段右下角 ✕ 撤回（弹窗确认）/ ✓ 采纳 */}
                <div className="absolute -bottom-3 right-2 z-10 flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-1.5 py-1 shadow-md">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveHunk(hunkIndex)
                      onRejectHunk?.(hunkIndex)
                    }}
                    disabled={busy}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-rose-500 transition hover:bg-rose-50 disabled:opacity-50"
                    aria-label="撤回这一处变更"
                    title="撤回这一处变更"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveHunk(hunkIndex)
                      onAcceptHunk?.(hunkIndex)
                    }}
                    disabled={busy}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-emerald-600 transition hover:bg-emerald-50 disabled:opacity-50"
                    aria-label="采纳这一处变更"
                    title="采纳这一处变更"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
          {truncated ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-3 w-full rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-2.5 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)]"
            >
              对比内容较长，已截断展示前 {REVIEW_DIFF_LINE_LIMIT} 行 · 点击展开完整对比（共 {totalLines} 行）
            </button>
          ) : null}
          </div>
        </div>
      </div>

      {/* IDE 式浮动审查条：块导航 / 整章拒绝·采纳 / 多文件切换（自适应换行，兼容手机与平板） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-[14px] border border-[rgba(24,24,27,0.5)] bg-[rgba(24,24,27,0.94)] px-2 py-1.5 text-xs text-zinc-100 shadow-xl backdrop-blur">
          <button
            type="button"
            onClick={() => focusHunk(activeHunk - 1)}
            disabled={hunkCount === 0}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] transition hover:bg-zinc-700/70 disabled:opacity-40"
            aria-label="上一处变更"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[2.6rem] text-center tabular-nums text-zinc-300">
            {hunkCount === 0 ? '0 / 0' : `${activeHunk + 1} / ${hunkCount}`}
          </span>
          <button
            type="button"
            onClick={() => focusHunk(activeHunk + 1)}
            disabled={hunkCount === 0}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] transition hover:bg-zinc-700/70 disabled:opacity-40"
            aria-label="下一处变更"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>

          <span className="mx-1 h-4 w-px bg-zinc-700" />

          <button
            type="button"
            onClick={onRevert}
            disabled={busy}
            className="flex h-7 items-center gap-1 rounded-[8px] px-2 transition hover:bg-zinc-700/70 disabled:opacity-50"
          >
            拒绝
            <span className="hidden text-[10px] text-zinc-500 md:inline">Ctrl+Backspace</span>
          </button>
          <button
            type="button"
            onClick={onKeep}
            disabled={busy}
            className="flex h-7 items-center gap-1 rounded-[8px] bg-zinc-100 px-2 font-medium text-zinc-900 transition hover:bg-white disabled:opacity-50"
          >
            采纳
            <span className="hidden text-[10px] text-zinc-500 md:inline">Ctrl+Enter</span>
          </button>

          {fileCount > 1 && onNavigateFile ? (
            <>
              <span className="mx-1 h-4 w-px bg-zinc-700" />
              <button
                type="button"
                onClick={() => onNavigateFile(-1)}
                disabled={busy}
                className="flex h-7 w-7 items-center justify-center rounded-[8px] transition hover:bg-zinc-700/70 disabled:opacity-50"
                aria-label="上一个待审文件"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="whitespace-nowrap text-zinc-300">
                文件 {fileIndex} / {fileCount}
              </span>
              <button
                type="button"
                onClick={() => onNavigateFile(1)}
                disabled={busy}
                className="flex h-7 w-7 items-center justify-center rounded-[8px] transition hover:bg-zinc-700/70 disabled:opacity-50"
                aria-label="下一个待审文件"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 当前章节已定夺完毕、但还有其它章节待审时的浮动跳转入口（图三样式） */
export function NextReviewFilePill({
  count,
  onClick,
}: {
  count: number
  onClick: () => void
}) {
  if (count <= 0) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto flex items-center gap-1 rounded-[14px] border border-[rgba(24,24,27,0.5)] bg-[rgba(24,24,27,0.94)] px-3 py-1.5 text-xs text-zinc-100 shadow-xl backdrop-blur transition hover:bg-zinc-800"
      >
        下一个文件
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
