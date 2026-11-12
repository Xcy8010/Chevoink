import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { PlanPendingReview } from '../types'
import { REVIEW_DIFF_LINE_LIMIT, buildReviewDiff, countReviewDiffLines, type ReviewDiffSegment } from './diff'

type PlanChangeReviewProps = {
  review: PlanPendingReview
  busy?: boolean
  /** 浮动审查条「采纳」：保留整份计划修订 */
  onKeep: () => void
  /** 浮动审查条「拒绝」：撤销整份计划修订（上游负责自定义弹窗确认） */
  onRevert: () => void
  /** 块级 ✓：仅采纳这一处变更块 */
  onAcceptHunk?: (hunkIndex: number) => void
  /** 块级 ✕：仅撤回这一处变更块（上游负责自定义弹窗确认） */
  onRejectHunk?: (hunkIndex: number) => void
  inline?: boolean
  className?: string
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

/** 计划文档的 IDE 式审查视图：与章节正文审查一致的行内绿/红 hunk 高亮、块级定夺与浮动审查条 */
export default function PlanChangeReview({
  review,
  busy = false,
  onKeep,
  onRevert,
  onAcceptHunk,
  onRejectHunk,
  inline = false,
  className,
}: PlanChangeReviewProps) {
  const { segments, hunkCount } = useMemo(
    () => buildReviewDiff(review.before, review.after),
    [review.after, review.before],
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
    hunkRefs.current[clamped]?.scrollIntoView({ behavior: inline ? 'auto' : 'smooth', block: 'center' })
  }

  // IDE 式快捷键：Ctrl+Enter 采纳整份、Ctrl+Backspace 拒绝整份（桌面端）；
  // 焦点在输入框（如 Agent 对话框）时忽略，避免打字时误触
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || busy || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('textarea, input') || target.isContentEditable || target.closest('[aria-modal="true"]'))) {
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
  }, [busy, onKeep, onRevert])

  const actionHover = inline ? 'hover:bg-[var(--surface-hover)]' : 'hover:bg-zinc-700/70'

  return (
    <div data-studio-region={inline ? 'ide-plan-review' : undefined} className={cn('relative flex h-full min-h-0 flex-col', className)}>
      <div className={cn('flex min-h-0 flex-1 flex-col', !inline && 'rounded-[24px] border border-[var(--border-strong)] bg-[var(--surface-default)]')}>
        {inline ? (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-subtle)] px-4 py-2 text-xs xl:px-6" title={review.description}>
            <span className="font-medium text-[var(--text-primary)]">待审变更</span>
            <span className="text-[var(--text-tertiary)]">绿色为新增，红色为删除</span>
          </div>
        ) : (
          <div className="border-b border-[var(--border-subtle)] px-5 pb-4 pt-5">
            <p className="text-lg font-semibold tracking-[0.01em] text-[var(--text-primary)]">
              {review.title.trim() || '未命名计划'}
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--text-tertiary)]">
              {review.description} · 绿色背景为新增、红色背景为删除，可逐块或整份定夺。
            </p>
          </div>
        )}

        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', inline ? 'px-4 py-4 motion-safe:scroll-smooth xl:px-6' : 'px-5 pb-24 pt-4')}>
          <div className={cn('text-[var(--text-primary)]', inline ? 'studio-editor-content' : 'text-sm leading-8')}>
          {blocks.length > 0 ? (
            visibleBlocks.map((block, blockIndex) => {
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
                  'relative my-1',
                  inline ? 'rounded-sm' : 'rounded-[10px]',
                  activeHunk === hunkIndex && (inline ? 'outline outline-1 outline-[var(--border-strong)]' : 'ring-1 ring-[rgba(15,23,42,0.30)]'),
                  )}
                >
                  {block.segments.map((segment, segmentIndex) =>
                    segment.kind === 'removed' && segment.text === '' ? null : (
                      <div
                        key={`seg-${segmentIndex}`}
                        className={cn(
                        'whitespace-pre-wrap break-words',
                        inline ? 'border-s-2 ps-2 pe-16' : 'rounded-[6px] px-1',
                        segment.kind === 'added' && (inline ? 'border-emerald-500/60 bg-emerald-500/10' : 'bg-[rgba(34,197,94,0.16)]'),
                        segment.kind === 'removed' && (inline ? 'border-rose-500/60 bg-rose-500/10' : 'bg-[rgba(239,68,68,0.16)]'),
                        )}
                      >
                        {segment.text || '\u00A0'}
                      </div>
                    ),
                  )}
                  {/* 块级定夺：片段右下角 ✕ 撤回（弹窗确认）/ ✓ 采纳 */}
                  <div className={cn('absolute z-10 flex items-center gap-1', inline ? 'end-1 top-0.5' : '-bottom-3 right-2 rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-1.5 py-1 shadow-md')}>
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
            })
          ) : (
            <div className="rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3 text-sm leading-7 text-[var(--text-secondary)]">
                本次没有内容差异，主要调整可能是计划标题。
            </div>
          )}
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

      {/* IDE 式浮动审查条：块导航 / 整份拒绝·采纳（自适应换行，兼容手机与平板） */}
      <div className={cn('flex shrink-0 justify-center px-3', inline ? 'border-t border-[var(--border-subtle)]' : 'pointer-events-none absolute inset-x-0 bottom-3 z-20')}>
        <div role="group" aria-label="计划审查操作" className={cn('pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 px-2 py-1.5 text-xs', inline ? 'text-[var(--text-primary)]' : 'rounded-[14px] border border-[rgba(24,24,27,0.5)] bg-[rgba(24,24,27,0.94)] text-zinc-100 shadow-xl backdrop-blur')}>
          <button
            type="button"
            onClick={() => focusHunk(activeHunk - 1)}
            disabled={hunkCount === 0}
            className={cn('flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40', actionHover)}
            aria-label="上一处变更"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <span className={cn('min-w-[2.6rem] text-center tabular-nums', inline ? 'text-[var(--text-secondary)]' : 'text-zinc-300')}>
            {hunkCount === 0 ? '0 / 0' : `${activeHunk + 1} / ${hunkCount}`}
          </span>
          <button
            type="button"
            onClick={() => focusHunk(activeHunk + 1)}
            disabled={hunkCount === 0}
            className={cn('flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40', actionHover)}
            aria-label="下一处变更"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>

          <span className={cn('mx-1 h-4 w-px', inline ? 'bg-[var(--border-subtle)]' : 'bg-zinc-700')} />

          <button
            type="button"
            onClick={onRevert}
            disabled={busy}
            className={cn('flex h-7 items-center gap-1 rounded-md px-2 transition-colors disabled:opacity-50', actionHover)}
          >
            拒绝
            <span className={cn('hidden text-[10px]', inline ? 'text-[var(--text-tertiary)] xl:inline' : 'text-zinc-500 md:inline')}>Ctrl+Backspace</span>
          </button>
          <button
            type="button"
            onClick={onKeep}
            disabled={busy}
            className={cn('flex h-7 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:opacity-50', inline ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)] hover:bg-[var(--surface-contrast-hover)]' : 'bg-zinc-100 text-zinc-900 hover:bg-white')}
          >
            采纳
            <span className={cn('hidden text-[10px]', inline ? 'opacity-75 xl:inline' : 'text-zinc-500 md:inline')}>Ctrl+Enter</span>
          </button>
        </div>
      </div>
    </div>
  )
}
