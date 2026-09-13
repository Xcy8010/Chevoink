import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenText,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Download,
  Eye,
  FileText,
  FolderDown,
  GitBranch,
  Library,
  LoaderCircle,
  Search,
  ShieldX,
  SquareStack,
  Wrench,
} from 'lucide-react'

import { buildApiUrl } from '@/app/api-base'
import { cn } from '@/lib/utils'
import ImageLightbox from '../../components/ImageLightbox'
import { formatTaskRelativeTime } from '../../lib/relative-time'
import type {
  AgentMessagePart,
  AgentToolDisplayPayload,
} from '../../../../../shared/contracts/index.js'
import { AgentMarkdownText } from './AgentMarkdownText'
import { useAgentStore } from '../agentStore'
import { describeToolArguments, getToolTargetTitle } from '../tool-argument-view'

/**
 * 消息 Parts 渲染器（plan/13 §5.3 + plan/20 §3.3）：
 * - text / reasoning / tool-call 三类 part 按 type 分发
 * - tool-call 的 display 负载再按 kind 渲染 diff / plan / 封面等结构化卡片
 * - part 级组件全部 memo：store 保证未变更 part 引用稳定，流式期间只有正在输出的最后一个 part 重渲染
 */

type DiffLine = {
  type: 'same' | 'add' | 'del'
  text: string
}

const DIFF_LINE_LIMIT = 300

function ToolTargetLink({
  title,
  onNavigate,
}: {
  title: string
  onNavigate?: () => void
}) {
  if (!onNavigate) return <>{title}</>
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onNavigate()
      }}
      title={`打开《${title}》`}
      className="inline cursor-pointer font-medium text-[var(--text-primary)] underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-none"
    >
      {title}
    </button>
  )
}

/** 轻量行级 diff（LCS）；超长内容直接降级为仅展示新内容 */
function computeLineDiff(before: string, after: string): DiffLine[] | null {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  if (beforeLines.length > DIFF_LINE_LIMIT || afterLines.length > DIFF_LINE_LIMIT) {
    return null
  }

  const m = beforeLines.length
  const n = afterLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        beforeLines[i] === afterLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push({ type: 'same', text: beforeLines[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: beforeLines[i] })
      i += 1
    } else {
      lines.push({ type: 'add', text: afterLines[j] })
      j += 1
    }
  }
  while (i < m) {
    lines.push({ type: 'del', text: beforeLines[i] })
    i += 1
  }
  while (j < n) {
    lines.push({ type: 'add', text: afterLines[j] })
    j += 1
  }

  return lines
}

function DiffCard({
  display,
  onNavigateTarget,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'chapterDiff' }>
  onNavigateTarget?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const diffLines = useMemo(
    () => (expanded ? computeLineDiff(display.before, display.after) : null),
    [expanded, display.before, display.after],
  )

  const addedChars = display.after.length - display.before.length

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <div className="group relative flex w-full items-center justify-between gap-2 py-1.5 text-left">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? '收起章节变更' : '展开章节变更'}
          className="absolute inset-0 z-0"
        />
        {onNavigateTarget ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onNavigateTarget()
            }}
            title={`打开《${display.chapterTitle}》`}
            className="relative z-10 min-w-0 truncate text-xs font-medium text-[var(--text-primary)] underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {display.chapterTitle}
          </button>
        ) : (
          <span className="pointer-events-none relative z-10 min-w-0 truncate text-xs font-medium text-[var(--text-primary)]">
            {display.chapterTitle}
          </span>
        )}
        <span className="pointer-events-none relative z-10 flex shrink-0 items-center gap-2 text-[11px] text-[var(--text-secondary)]">
          <span className={cn(addedChars >= 0 ? 'text-emerald-600' : 'text-rose-500')}>
            {addedChars >= 0 ? `+${addedChars}` : addedChars} 字
          </span>
          {display.appliedDirectly ? <span>已写入</span> : null}
          <span className="relative inline-flex h-4 w-4 items-center justify-center">
            <FileText className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} />
            <ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} />
          </span>
        </span>
      </div>
      {expanded ? (
        <div className="max-h-72 overflow-y-auto border-t border-[var(--border-subtle)] py-2 pl-5">
          {diffLines ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6">
              {diffLines.map((line, index) =>
                line.type === 'same' ? (
                  <span key={index} className="block text-[var(--text-secondary)]">
                    {line.text || ' '}
                  </span>
                ) : line.type === 'add' ? (
                  <span key={index} className="block bg-emerald-50 text-emerald-700">
                    {line.text || ' '}
                  </span>
                ) : (
                  <span key={index} className="block bg-rose-50 text-rose-600 line-through">
                    {line.text || ' '}
                  </span>
                ),
              )}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6 text-[var(--text-primary)]">
              {display.after}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

function PlanCard({ display }: { display: Extract<AgentToolDisplayPayload, { kind: 'plan' }> }) {
  return (
    <div className="border-t border-[var(--border-subtle)] py-2 pl-5">
      <p className="text-[11px] font-medium tracking-[0.08em] text-[var(--text-secondary)]">方案</p>
      {display.summary ? (
        <p className="mt-1 text-xs leading-6 text-[var(--text-primary)]">{display.summary}</p>
      ) : null}
      {display.steps.length > 0 ? (
        <ol className="mt-1.5 space-y-1">
          {display.steps.map((step, index) => (
            <li key={index} className="flex items-start gap-2 text-xs leading-6">
              <span className="mt-0.5 shrink-0 text-[var(--text-secondary)]">{index + 1}.</span>
              <span className="min-w-0">
                <span className="text-[var(--text-primary)]">{step.title}</span>
                {step.detail ? (
                  <span className="text-[var(--text-secondary)]"> — {step.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

const storyCompilerPhaseLabel = {
  charter: '创作宪章', prepare: '准备', beat: '场景', write: '写作', check: '检查', repair: '修补', commit: '提交',
} as const

function StoryCompilerCard({ display }: { display: Extract<AgentToolDisplayPayload, { kind: 'storyCompiler' }> }) {
  const [expanded, setExpanded] = useState(display.errorCount !== undefined && display.errorCount > 0)
  const hasProblems = (display.errorCount ?? 0) > 0 || (display.warningCount ?? 0) > 0
  if (!hasProblems && display.items.length === 0) return null
  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="group flex min-h-7 w-full items-center gap-1.5 py-1.5 text-left">
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
          <Brain className={cn('h-3.5 w-3.5 transition-opacity', display.items.length > 0 && !expanded && 'group-hover:opacity-0')} />
          {display.items.length > 0 ? <ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /> : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">{storyCompilerPhaseLabel[display.phase]} · {display.detail}</span>
        {hasProblems ? (
          <span className={cn('shrink-0 text-[11px]', (display.errorCount ?? 0) > 0 ? 'text-rose-500' : 'text-amber-500')}>
            {(display.errorCount ?? 0) > 0 ? `${display.errorCount} 错误` : `${display.warningCount} 警告`}
          </span>
        ) : null}
      </button>
      {expanded && display.items.length > 0 ? (
        <ul className="space-y-1 pb-1.5 pl-[22px]">
          {display.items.map((item, index) => <li key={`${index}-${item}`} className="break-words text-[11px] leading-5 text-[var(--text-secondary)]">{item}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

function QualityReportCard({ display }: { display: Extract<AgentToolDisplayPayload, { kind: 'qualityReport' }> }) {
  const [expanded, setExpanded] = useState(display.findings.length > 0)
  const repaired = display.findings.filter((finding) => finding.disposition === 'repaired').length
  const warnings = display.findings.filter((finding) => (finding.severity === 'warning' || finding.severity === 'error') && finding.disposition !== 'repaired').length

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="group flex min-h-7 w-full items-center gap-1.5 py-1.5 text-left">
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
          <Wrench className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} />
          <ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">质量报告 · r{display.chapterRevision} · {display.findings.length} 条证据</span>
        <span className={cn('shrink-0 text-[11px]', warnings > 0 ? 'text-amber-500' : 'text-emerald-600')}>
          {warnings > 0 ? `${warnings} 条需关注` : repaired > 0 ? `已自动修复 ${repaired} 处` : '通过'}
        </span>
      </button>
      {expanded ? (
        <div className="pl-[22px]">
          {display.findings.length === 0 ? <p className="text-[11px] text-[var(--text-secondary)]">没有发现可定位的问题。</p> : null}
          {display.findings.map((finding) => {
            return (
              <div key={finding.id} className="border-b border-[var(--border-subtle)] py-2 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={cn('text-[11px] font-medium', finding.severity === 'warning' || finding.severity === 'error' ? 'text-amber-600' : 'text-[var(--text-secondary)]')}>{finding.label}</span>
                  <span className="text-[10px] text-[var(--text-secondary)]">{finding.disposition === 'repaired' ? '已自动修复' : '审美建议'}</span>
                </div>
                <blockquote className="mt-1 border-l-2 border-[var(--border-subtle)] pl-2 text-[11px] leading-5 text-[var(--text-primary)]">{finding.evidence}</blockquote>
                <p className="mt-1 text-[11px] leading-5 text-[var(--text-secondary)]">{finding.explanation}</p>
                <p className="mt-1 text-[11px] leading-5 text-[var(--text-primary)]">最小修法：{finding.suggestion}</p>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function CoverImagesCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'coverImages' }>
}) {
  // 点击缩略图放大查看，并支持下载
  const [previewImage, setPreviewImage] = useState<{ id: string; url: string } | null>(null)

  return (
    <div className="flex flex-wrap gap-2">
      {display.images.map((image) => (
        <button
          key={image.id}
          type="button"
          onClick={() => setPreviewImage(image)}
          className="cursor-zoom-in overflow-hidden rounded-[10px] border border-[var(--border-subtle)] transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          aria-label="放大查看封面候选"
        >
          <img
            src={image.url}
            alt="封面候选"
            className="h-32 w-24 object-cover"
            loading="lazy"
          />
        </button>
      ))}
      {previewImage ? (
        <ImageLightbox
          src={previewImage.url}
          alt="封面候选"
          downloadName={`封面候选-${previewImage.id}.png`}
          onClose={() => setPreviewImage(null)}
        />
      ) : null}
    </div>
  )
}

/** 联网搜索结果卡片：折叠行 = 已检索网络「query」· n 个结果，展开为标题+来源域名列表 */
function WebSearchCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'webSearch' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const unavailable = display.provider === 'unavailable'

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
          {unavailable ? '联网搜索不可用 · ' : '已检索网络 '}
          「{display.query}」
          {!unavailable && display.results.length > 0 ? ` · ${display.results.length} 个结果` : ''}
        </span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><Search className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded && display.results.length > 0 ? (
        <ul className="max-h-72 overflow-y-auto border-t border-[var(--border-subtle)] py-1 pl-5">
          {display.results.map((result, index) => (
            <li key={result.url || index}>
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 transition hover:bg-[var(--surface-muted)]"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
                  {result.title}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                  {result.source}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** 站内作品搜索结果卡片：折叠行 = 已搜索作品「query」· n 个结果，展开为书名+作者+状态徽标列表 */
function PlatformNovelSearchCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'platformNovelSearch' }>
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <Library className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
          已搜索作品 「{display.query}」
          {display.results.length > 0 ? ` · ${display.results.length} 个结果` : ''}
        </span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><Library className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded && display.results.length > 0 ? (
        <ul className="max-h-72 overflow-y-auto border-t border-[var(--border-subtle)] py-1 pl-5">
          {display.results.map((result, index) => (
            <li
              key={result.id || index}
              className="flex items-center gap-2 rounded-[8px] px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
                《{result.title}》 · {result.authorName}
              </span>
              <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                {result.published ? '已上架' : result.isOwn ? '我的·未公开' : '已下架'}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]">
                {result.wordCount} 字
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** 站内作品查看卡片：折叠行 = 已查看作品《title》· 作者 · n 章，展开为状态/标签/简介元信息 */
function PlatformNovelCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'platformNovel' }>
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <BookOpenText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
          已查看作品 《{display.title}》 · {display.authorName} · {display.chapterCount} 章
        </span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><BookOpenText className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded ? (
        <div className="border-t border-[var(--border-subtle)] py-2 pl-5">
          <p className="text-[11px] text-[var(--text-secondary)]">
            {display.published ? '已上架' : display.isOwn ? '我的·未公开' : '已下架'}
            {display.chapterTitle ? ` · 本章：《${display.chapterTitle}》` : ''}
          </p>
          {display.tags.length > 0 ? (
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
              标签：{display.tags.join('、')}
            </p>
          ) : null}
          {display.summary.trim() ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-6 text-[var(--text-primary)]">
              {display.summary}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 视觉旁路查看图片卡片：折叠行「已查看图片 · n 张」，展开为缩略图行（点击放大）+ 视觉模型描述 */
function ViewedImageCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'viewedImage' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const [previewImage, setPreviewImage] = useState<{ id: string; url: string } | null>(null)

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <Eye className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
          已查看图片 · {display.images.length} 张
        </span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><Eye className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded ? (
        <div className="border-t border-[var(--border-subtle)] py-2 pl-5">
          <div className="flex flex-wrap gap-2">
            {display.images.map((image) => (
              <button
                key={image.id}
                type="button"
                onClick={() => setPreviewImage(image)}
                className="cursor-zoom-in overflow-hidden rounded-[10px] border border-[var(--border-subtle)] transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                aria-label="放大查看图片"
              >
                <img
                  src={image.url}
                  alt="查看过的图片"
                  className="h-24 w-24 object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
          {display.description ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-[var(--text-secondary)]">
              {display.description}
            </p>
          ) : null}
        </div>
      ) : null}
      {previewImage ? (
        <ImageLightbox
          src={previewImage.url}
          alt="查看过的图片"
          downloadName={`图片-${previewImage.id}.webp`}
          onClose={() => setPreviewImage(null)}
        />
      ) : null}
    </div>
  )
}

/** markdown 内容卡片：长内容（读文件/读网页）默认折叠、点击展开收起；短内容（如封面提示词）直接展示 */
function MarkdownCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'markdown' }>
}) {
  const collapsible = display.markdown.length > 300
  const [expanded, setExpanded] = useState(false)

  if (!collapsible) {
    return (
      <div className="border-t border-[var(--border-subtle)] py-2 pl-5">
        <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6 text-[var(--text-primary)]">
          {display.markdown}
        </pre>
      </div>
    )
  }

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
          内容 · {display.markdown.length} 字
        </span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><FileText className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded ? (
        <div className="border-t border-[var(--border-subtle)] py-2 pl-5">
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-6 text-[var(--text-primary)]">
            {display.markdown}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

/** 跨任务上下文卡片：折叠行 = 已读取任务「标题」，展开为任务归属与对话片段，作者可核对 Agent 到底读了哪个任务 */
function TaskContextCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'taskContext' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const primary = display.tasks[0]
  const headline = display.mode === 'list'
    ? `已列出历史任务 · ${display.tasks.length} 个`
    : primary
      ? `已读取任务「${primary.title}」${display.excerpts.length > 0 ? ` · ${display.excerpts.length} 条对话` : ''}`
      : '未找到对应任务'

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">{headline}</span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><GitBranch className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded ? (
        <div className="max-h-72 overflow-y-auto border-t border-[var(--border-subtle)] py-1.5 pl-5">
          <ul>
            {display.tasks.map((task) => (
              <li key={task.sessionId} className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
                  {task.title}
                  {task.isBranch ? ' · 分支' : ''}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">{task.novelTitle}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]">
                  {formatTaskRelativeTime(task.lastActiveAt)}
                </span>
              </li>
            ))}
          </ul>
          {display.excerpts.length > 0 ? (
            <ul className="mt-1 border-t border-[var(--border-subtle)] pt-1.5">
              {display.excerpts.map((excerpt, index) => (
                <li key={`${excerpt.createdAt}:${index}`} className="py-1">
                  <p className="text-[10px] text-[var(--text-tertiary)]">
                    {excerpt.role === 'user' ? '作者' : 'Agent'} · {formatTaskRelativeTime(excerpt.createdAt)}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">
                    {excerpt.text}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const ORCHESTRATION_STATUS_LABEL: Record<
  Extract<AgentToolDisplayPayload, { kind: 'taskOrchestration' }>['windows'][number]['status'],
  string
> = {
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  awaiting: '待作者处理',
  timeout: '仍在执行',
}

const ORCHESTRATION_MODE_LABEL: Record<'spawn' | 'wait' | 'send', string> = {
  spawn: '并行任务窗口',
  wait: '等待任务窗口',
  send: '投递提示词',
}

/** 跨任务编排卡片：折叠行 = 并行窗口概况，展开列出每个窗口的状态与交付摘要，点标题直接切到那个任务窗口 */
function TaskOrchestrationCard({
  display,
}: {
  display: Extract<AgentToolDisplayPayload, { kind: 'taskOrchestration' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const requestToolNavigation = useAgentStore((state) => state.requestToolNavigation)
  const headline = display.detail.trim()
    || `${ORCHESTRATION_MODE_LABEL[display.mode]} · ${display.windows.length} 个`

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-1.5 text-left"
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">{headline}</span>
        <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-tertiary)]"><GitBranch className={cn('h-3.5 w-3.5 transition-opacity', !expanded && 'group-hover:opacity-0')} /><ChevronDown className={cn('absolute h-3.5 w-3.5 transition-[opacity,transform]', expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100')} /></span>
      </button>
      {expanded ? (
        <div className="max-h-72 overflow-y-auto border-t border-[var(--border-subtle)] py-1.5 pl-5">
          <ul>
            {display.windows.map((taskWindow) => (
              <li key={taskWindow.sessionId} className="py-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => requestToolNavigation('task_open', { sessionId: taskWindow.sessionId }, display)}
                    className="min-w-0 flex-1 truncate text-left text-xs text-[var(--text-primary)] hover:underline"
                  >
                    {taskWindow.title}
                  </button>
                  <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                    {ORCHESTRATION_STATUS_LABEL[taskWindow.status]}
                    {taskWindow.inherit === 'transcript' ? ' · 分支副本' : ''}
                  </span>
                </div>
                {taskWindow.summary ? (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">
                    {taskWindow.summary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function ToolDisplayRenderer({
  display,
  onNavigateTarget,
}: {
  display: AgentToolDisplayPayload
  onNavigateTarget?: () => void
}) {
  switch (display.kind) {
    case 'chapterDiff':
      return <DiffCard display={display} onNavigateTarget={onNavigateTarget} />
    case 'plan':
      return <PlanCard display={display} />
    case 'storyCompiler':
      return <StoryCompilerCard display={display} />
    case 'qualityReport':
      return <QualityReportCard display={display} />
    case 'coverImages':
      return <CoverImagesCard display={display} />
    case 'webSearch':
      return <WebSearchCard display={display} />
    case 'platformNovelSearch':
      return <PlatformNovelSearchCard display={display} />
    case 'platformNovel':
      return <PlatformNovelCard display={display} />
    case 'viewedImage':
      return <ViewedImageCard display={display} />
    case 'markdown':
      return <MarkdownCard display={display} />
    case 'taskContext':
      return <TaskContextCard display={display} />
    case 'taskOrchestration':
      return <TaskOrchestrationCard display={display} />
    case 'chapterRef':
      return (
        <p className="text-[11px] text-[var(--text-secondary)]">
          章节「<ToolTargetLink title={display.title} onNavigate={onNavigateTarget} />」 · {display.wordCount} 字
        </p>
      )
    case 'planFile':
      return (
        <p className="text-[11px] text-[var(--text-secondary)]">
          计划「<ToolTargetLink title={display.title} onNavigate={onNavigateTarget} />」已写入计划文件夹 · {display.content.length} 字，可在左侧作品树直接编辑
        </p>
      )
    case 'planDiff':
      return (
        <p className="border-t border-[var(--border-subtle)] py-1.5 text-[11px] text-[var(--text-secondary)]">
          计划「<ToolTargetLink title={display.title} onNavigate={onNavigateTarget} />」 · {display.after.length - display.before.length >= 0 ? '+' : ''}{display.after.length - display.before.length} 字
        </p>
      )
    case 'planRename':
      return (
        <p className="text-[11px] text-[var(--text-secondary)]">
          计划「{display.beforeTitle}」已重命名为「<ToolTargetLink title={display.title} onNavigate={onNavigateTarget} />」
        </p>
      )
    case 'planDelete':
      return (
        <p className="text-[11px] text-[var(--text-secondary)]">
          计划「{display.title}」已从计划文件夹移除
        </p>
      )
    case 'uiIntent':
      return (
        <p className="text-[11px] text-[var(--text-secondary)]">
          {display.intent === 'open_meta' ? '已请求打开作品信息面板' : '已请求打开封面面板'}
        </p>
      )
    case 'exportReady':
      return (
        <div className="border-t border-[var(--border-subtle)] py-2.5 pl-5">
          <div className="flex items-center gap-2">
            <FolderDown className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-[var(--text-primary)]">{display.fileName}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-secondary)]">
                含{display.detail} · 链接 15 分钟内有效
              </p>
            </div>
          </div>
          <a
            href={buildApiUrl(display.downloadUrl)}
            download={display.fileName}
            className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--surface-contrast)] px-3 text-xs font-medium text-[var(--text-contrast)] transition hover:bg-[var(--surface-contrast-hover)]"
          >
            <Download className="h-3.5 w-3.5" />
            下载导出包
          </a>
        </div>
      )
    case 'question':
      return (
        <div className="border-t border-[var(--border-subtle)] py-2 pl-5">
          <p className="break-words text-xs leading-6 text-[var(--text-primary)]">{display.question}</p>
          <p className="mt-1 break-words text-[11px] leading-5 text-[var(--text-secondary)]">
            {display.unanswered ? '未回答，Agent 已按默认方案继续' : `你的回答：${display.answer ?? ''}`}
          </p>
        </div>
      )
    case 'todoList': {
      const completed = display.items.filter((item) => item.status === 'completed').length
      return (
        <p className="text-[11px] text-[var(--text-secondary)]">
          待办清单已更新 · {completed}/{display.items.length} 已完成
        </p>
      )
    }
    case 'changeSet':
      return (
        <div className="border-l-2 border-[var(--border-strong)] pl-3 text-[11px] leading-5 text-[var(--text-secondary)]">
          <p className="font-medium text-[var(--text-primary)]">
            全书变更 · {display.selectedCount}/{display.patchCount} 项 · {display.status}
          </p>
          <p>变更集 {display.changeSetId} 已同步到审查抽屉。</p>
        </div>
      )
    default:
      return null
  }
}

const toolStatusIcon = {
  running: <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)]" />,
  success: <Check className="h-3.5 w-3.5 text-emerald-600" />,
  failed: <CircleAlert className="h-3.5 w-3.5 text-rose-500" />,
  denied: <ShieldX className="h-3.5 w-3.5 text-amber-500" />,
} as const

const WRITE_TOOL_NAMES = new Set([
  'chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename',
  'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge',
  'volume_create', 'volume_update', 'volume_move', 'volume_delete',
  'changeset_apply', 'changeset_rollback', 'directive_save', 'directive_supersede',
  'memory_save', 'memory_relation_save', 'memory_event_save',
  'plan_save', 'plan_rename', 'plan_delete',
  'novel_create', 'novel_rename', 'novel_update_meta', 'cover_prompt_set', 'cover_apply',
  'novel_publish', 'novel_archive', 'novel_delete',
])
const NAVIGABLE_TOOL_NAMES = new Set(['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'plan_save', 'plan_rename'])

/** 沉淀单张记忆卡的写工具：点击不展开参数，而是去记忆中心定位闪一下对应卡片 */
function memorySpotlightType(toolName: string, args: unknown): string | null {
  if (toolName === 'memory_event_save') return 'timelineEvent'
  if (toolName === 'memory_relation_save') return 'relationshipState'
  if (toolName !== 'memory_save') return null
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : null
  return typeof record?.memoryType === 'string' ? record.memoryType : null
}

/** 工具真实执行耗时：不足 1 秒的瞬时操作不展示，避免满屏无意义的 0.0s */
function formatToolDuration(durationMs: number | undefined): string | null {
  if (typeof durationMs !== 'number' || durationMs < 1000) {
    return null
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }
  return `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)}s`
}

const ToolCallCard = memo(function ToolCallCard({
  part,
}: {
  part: Extract<AgentMessagePart, { type: 'tool-call' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const requestToolNavigation = useAgentStore((state) => state.requestToolNavigation)
  const requestMemorySpotlight = useAgentStore((state) => state.requestMemorySpotlight)
  const argumentRows = useMemo(() => describeToolArguments(part.args), [part.args])
  const durationLabel = formatToolDuration(part.durationMs)
  const running = part.status === 'running'
  const importWaiting = running && part.toolName === 'novel_import' && part.importWaiting
    && /^\/studio\/novel\/[^/?#]+\?/.test(part.importWaiting.url) ? part.importWaiting : null
  const writeTool = WRITE_TOOL_NAMES.has(part.toolName)
  const workflowDisplay = part.display?.kind === 'storyCompiler' || part.display?.kind === 'qualityReport'
  const workflowDisplayHasBody = part.display?.kind !== 'storyCompiler'
    || (part.display.items.length > 0 || (part.display.errorCount ?? 0) > 0 || (part.display.warningCount ?? 0) > 0)
  // 深读卡：执行结束后默认折叠、点击头部展开回看；按 toolName 精确门控（cover_prompt_set 同样产出 markdown，不能误折）
  const collapsible = part.toolName === 'web_read' && !!part.display
  const expandable = !workflowDisplay && argumentRows.length > 0
  const navigable = NAVIGABLE_TOOL_NAMES.has(part.toolName)
  const targetTitle = navigable ? getToolTargetTitle(part.display, part.args) : null
  // 联网搜索过程态：复用 tool.call args 里的 query，免新增事件类型
  const argsRecord = typeof part.args === 'object' && part.args !== null ? (part.args as Record<string, unknown>) : null
  // 记忆沉淀卡：去掉参数展开，点击整行去记忆中心看对应卡片
  const spotlightType = part.status === 'success' ? memorySpotlightType(part.toolName, part.args) : null
  const spotlightTitle = part.toolName === 'memory_relation_save' && typeof argsRecord?.fromName === 'string'
    && typeof argsRecord.toName === 'string' && typeof argsRecord.relationType === 'string'
    ? `${argsRecord.fromName}→${argsRecord.toName}:${argsRecord.relationType}`
    : spotlightType && typeof argsRecord?.title === 'string' ? argsRecord.title : ''
  const rowExpandable = spotlightType === null && (expandable || collapsible)
  // 质量报告：默认折叠、点击头部展开回看（报告条目多，平铺会把对话流冲得很长）
  const qualityReport = part.display?.kind === 'qualityReport'
  const [workflowExpanded, setWorkflowExpanded] = useState(false)
  const webSearchQuery =
    part.toolName === 'web_search' && typeof argsRecord?.query === 'string' ? argsRecord.query : ''
  const platformSearchQuery =
    part.toolName === 'platform_novel_search' && typeof argsRecord?.query === 'string'
      ? argsRecord.query
      : ''
  const runningLabel =
    importWaiting ? '等待作者确认' : running && webSearchQuery
      ? `正在搜索「${webSearchQuery}」…`
      : running && platformSearchQuery
        ? `正在搜索作品「${platformSearchQuery}」…`
        : running && part.toolName === 'platform_novel_read'
          ? '查看作品中…'
          : running
            ? part.progressChars
              ? `已生成 ${part.progressChars} 字 · 执行中…`
              : '执行中…'
            : ''
  const headerContent = <>
    {writeTool ? <FileText className="h-3.5 w-3.5 shrink-0 text-sky-500" /> : <Wrench className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />}
    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">{part.title || part.toolName}</span>
    {running ? <span className="agent-tool-running-label shrink-0 text-[10px] font-medium text-[var(--text-secondary)]">{runningLabel}</span> : null}
    {durationLabel ? <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]">{durationLabel}</span> : null}
    {writeTool && !running ? <span className={cn(
      'shrink-0 text-[10px] font-medium',
      part.status === 'success' ? 'text-emerald-600' : part.status === 'denied' ? 'text-amber-500' : 'text-rose-500',
    )}>{part.status === 'success' ? (part.accepted ? '已接受' : '已完成') : part.status === 'denied' ? '已拒绝' : '失败'}</span> : null}
    <span className="shrink-0">{toolStatusIcon[part.status]}</span>
    {qualityReport ? (
      <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)] transition-transform', workflowExpanded && 'rotate-180')} />
    ) : spotlightType !== null ? (
      <SquareStack className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]" />
    ) : rowExpandable ? <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)] transition-transform', expanded && 'rotate-180')} /> : null}
  </>

  return (
    <div
      className={cn(
        'relative overflow-hidden border-b border-[var(--border-subtle)] bg-transparent transition-colors',
        running && 'agent-tool-running',
      )}
    >
      {running ? (
        <span aria-hidden className="agent-tool-progress pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[var(--text-secondary)]/55" />
      ) : null}
      {workflowDisplay
        ? qualityReport ? (
          <div className="group relative flex w-full items-center gap-2 py-2 text-left">
            <button
              type="button"
              onClick={() => setWorkflowExpanded((value) => !value)}
              aria-label={workflowExpanded ? '收起质量报告' : '展开质量报告'}
              className="absolute inset-0 z-0"
            />
            {headerContent}
          </div>
        ) : <div className="relative flex w-full items-center gap-2 py-2 text-left">{headerContent}</div>
        : <div className="group relative flex w-full items-center gap-2 py-2 text-left">
            {spotlightType !== null ? (
              <button
                type="button"
                onClick={() => requestMemorySpotlight(spotlightType, spotlightTitle)}
                aria-label="在记忆中心查看这张卡片"
                title="在记忆中心查看这张卡片"
                className="absolute inset-0 z-0"
              />
            ) : rowExpandable ? <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? '收起工具详情' : '展开工具详情'} className="absolute inset-0 z-0" /> : null}
            {headerContent}
          </div>}
      {importWaiting ? <p className="pb-2 pl-[22px] text-xs leading-5">
        <a className="underline" href={importWaiting.url}>核对原文并确认导入</a>
        <span className="ml-2 text-[var(--text-secondary)]">尚未导入；已有章节需要两次覆盖确认。</span>
      </p> : null}
      {part.summary ? (
        <p
          className={cn(
            'pb-2 text-[11px] leading-5',
            'pl-[22px]',
            part.status === 'failed' || part.status === 'denied'
              ? 'text-rose-500'
              : 'text-[var(--text-secondary)]',
          )}
        >
          {part.summary}
        </p>
      ) : null}
      {expanded && argumentRows.length > 0 ? (
        <dl className="max-h-44 space-y-1.5 overflow-y-auto border-t border-[var(--border-subtle)] py-2 pl-[22px] pr-2 text-[10px] leading-5">
          {argumentRows.map((row, index) => <div key={`${row.label}-${index}`} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><dt className="text-[var(--text-tertiary)]">{row.label}</dt><dd className="min-w-0 break-words text-[var(--text-secondary)]">{row.value}</dd></div>)}
        </dl>
      ) : null}
      {part.display && workflowDisplayHasBody && (!collapsible || expanded) && (!qualityReport || workflowExpanded) ? (
        <div className={cn(workflowDisplay ? 'pb-2' : 'pb-3 pt-1 pl-[22px]')}>
          <ToolDisplayRenderer
            display={part.display}
            onNavigateTarget={targetTitle ? () => requestToolNavigation(part.toolName, part.args, part.display) : undefined}
          />
        </div>
      ) : null}
    </div>
  )
})

const SUBAGENT_ROLE_LABELS: Record<string, string> = {
  research: '调研',
  continuity: '一致性',
  quality: '质量',
  lore: '设定',
}

const EMPTY_SUBAGENT_CHILDREN: Array<Extract<AgentMessagePart, { type: 'tool-call' }>> = []

/**
 * 子 Agent 内嵌调用容器卡片（codex/Zcode 模式）：
 * 主 Agent 用 subagent_run 像调工具一样调用子 Agent，子 Agent 的内部工具调用与最终报告
 * 全部嵌套在这张卡片内展示，不再新开任务窗口。
 */
const SubAgentCallCard = memo(function SubAgentCallCard({
  part,
  children,
}: {
  part: Extract<AgentMessagePart, { type: 'tool-call' }>
  children: Array<Extract<AgentMessagePart, { type: 'tool-call' }>>
}) {
  const [expanded, setExpanded] = useState(true)
  const report = part.display?.kind === 'subagentReport' ? part.display : null
  const running = part.status === 'running'
  const durationLabel = formatToolDuration(report?.durationMs ?? part.durationMs)
  const roleLabel = report?.role ? SUBAGENT_ROLE_LABELS[report.role] ?? report.role : null
  const subagentName = report?.subagentName ?? '子 Agent'
  const progress = part.subagentProgress

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)]/40',
        running && 'agent-tool-running',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-2 text-left"
        aria-label={expanded ? '收起子 Agent 详情' : '展开子 Agent 详情'}
      >
        <Bot className={cn('h-3.5 w-3.5 shrink-0', running ? 'animate-pulse text-sky-500' : 'text-[var(--text-secondary)]')} />
        <span className="min-w-0 shrink-0 text-xs font-medium text-[var(--text-primary)]">{subagentName}</span>
        {roleLabel ? <span className="shrink-0 rounded bg-[var(--surface-muted)] px-1 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">{roleLabel}</span> : null}
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-tertiary)]">
          {running ? (progress?.message ?? '准备中…') : report?.triggerCondition ?? ''}
        </span>
        {durationLabel ? <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]">{durationLabel}</span> : null}
        {report && report.steps > 0 ? <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{report.steps} 次调用</span> : null}
        <span className="shrink-0">{toolStatusIcon[part.status]}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)] transition-transform', expanded && 'rotate-180')} />
      </button>
      {running ? <span aria-hidden className="agent-tool-progress pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[var(--text-secondary)]/55" /> : null}
      {expanded ? (
        <div className="border-t border-[var(--border-subtle)]">
          {children.length > 0 ? (
            <div className="pl-2">
              {children.map((child) => <ToolCallCard key={child.callId} part={child} />)}
            </div>
          ) : null}
          {report?.report ? (
            <div className="border-t border-[var(--border-subtle)] px-2 py-2">
              <p className="mb-1 text-[10px] font-medium text-[var(--text-secondary)]">工作报告 · 待主 Agent 审查</p>
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--text-secondary)]">{report.report}</p>
            </div>
          ) : null}
          {part.status !== 'running' && !report?.report && part.summary ? (
            <p className="border-t border-[var(--border-subtle)] px-2 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">{part.summary}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

const ReasoningPart = memo(function ReasoningPart({
  part,
  streaming,
}: {
  part: Extract<AgentMessagePart, { type: 'reasoning' }>
  streaming: boolean
}) {
  // null = 跟随默认（思考中展开、思考结束收起）；true/false = 用户本轮手动指定，思考中也能收起
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const showBody = manualOpen ?? false
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 是否跟随最新思考文本：默认跟随，用户在思考区内往上翻即暂停，重新滑回底部即恢复
  const followRef = useRef(true)

  // 思考结束时清掉手动状态，维持紧凑收起态。
  useEffect(() => {
    if (!streaming) {
      setManualOpen(null)
    }
  }, [streaming])

  useEffect(() => {
    // 只在思考中跟随；思考结束后用户手动展开回看时，从头开始读而不是跳到末尾
    if (!streaming || !showBody) {
      return
    }
    const node = bodyRef.current
    if (!node || !followRef.current) {
      return
    }
    node.scrollTop = node.scrollHeight
  }, [part.text, streaming, showBody])

  const handleBodyScroll = useCallback(() => {
    const node = bodyRef.current
    if (!node) {
      return
    }
    // 程序自动滚底后本就贴底，不会被误判成用户干预；内容没溢出时差值为 0，同样保持跟随
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 12
  }, [])

  const handleToggle = useCallback(() => {
    setManualOpen((current) => {
      const nextOpen = !(current ?? streaming)
      // 收起时重置跟随，再次展开直接看最新思考
      if (!nextOpen) {
        followRef.current = true
      }
      return nextOpen
    })
  }, [streaming])

  const visibleText = part.text.trim()
  const meaningfulLines = visibleText.split('\n').map((line) => line.trim()).filter(Boolean)
  const summary = (streaming ? meaningfulLines.at(-1) : meaningfulLines[0]) ?? (streaming ? '正在分析…' : '已完成分析')

  return (
    <div className="relative overflow-hidden" data-reasoning-running={streaming || undefined}>
      {streaming ? <span aria-hidden className="pointer-events-none absolute inset-y-0 -left-72 z-0 w-72 animate-[reasoning-sweep_2.6s_ease-out_infinite] bg-gradient-to-r from-transparent via-[color:var(--surface-muted)]/70 to-transparent motion-reduce:hidden" /> : null}
      <button
        type="button"
        onClick={handleToggle}
        className="relative z-10 flex h-8 w-full items-center gap-2 overflow-hidden text-left"
      >
        <Brain
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]',
            streaming && 'animate-pulse',
          )}
        />
        <span className="shrink-0 text-[11px] font-medium text-[var(--text-secondary)]">
          {streaming ? '思考中' : '思考'}
        </span>
        <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">{summary}</span>
        {showBody ? (
          <ChevronUp className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        )}
      </button>
      {showBody ? (
        /* 这里刻意不加 overscroll-contain：思考区滚到边界后手势要能继续传给外层对话列表，
           否则手指落在思考区上时整个对话就滑不动了 */
        <div
          ref={bodyRef}
          onScroll={handleBodyScroll}
          className="max-h-44 overflow-y-auto whitespace-pre-wrap border-l border-[var(--border-subtle)] py-1 pl-[22px] text-xs leading-6 text-[var(--text-tertiary)] [-webkit-overflow-scrolling:auto]"
        >
          {part.text}
        </div>
      ) : null}
    </div>
  )
})

export const AgentMessageParts = memo(function AgentMessageParts({
  parts,
  streaming,
  runActive,
  blockId,
  summaryCount,
  summaryExpanded = false,
  onToggleSummary,
  textCollapsible = false,
}: {
  parts: AgentMessagePart[]
  streaming: boolean
  /** 所属 run 是否仍活跃：活跃时平铺输出 */
  runActive: boolean
  /** 所属对话块（连续助手消息）的首条消息 id */
  blockId?: string
  /** 整个对话块的操作总数（仅块内首条助手消息传值）：run 结束后显示唯一一行「已处理 n 个操作」 */
  summaryCount?: number
  /** 摘要是否已展开（回看全部思考/动作） */
  summaryExpanded?: boolean
  onToggleSummary?: (blockId: string) => void
  /** 折叠态下本消息正文是否可收起（块内非最后一条）：run 结束后过程进展正文折进摘要行 */
  textCollapsible?: boolean
}) {
  const showSummary = !runActive && (summaryCount ?? 0) > 0
  const collapsed = !runActive && !summaryExpanded
  // 子 Agent 内部工具卡片归组：嵌套渲染进所属的 subagent_run 容器（codex/Zcode 模式）
  const subagentChildren = useMemo(() => {
    const grouped = new Map<string, Array<Extract<AgentMessagePart, { type: 'tool-call' }>>>()
    for (const part of parts) {
      if (part.type === 'tool-call' && part.subagentCallId) {
        const list = grouped.get(part.subagentCallId)
        if (list) list.push(part)
        else grouped.set(part.subagentCallId, [part])
      }
    }
    return grouped
  }, [parts])

  return (
    <div className="space-y-2">
      {showSummary ? (
        <button
          type="button"
          onClick={() => {
            if (blockId) {
              onToggleSummary?.(blockId)
            }
          }}
          className="flex w-full animate-fade-in items-center gap-1 text-left"
        >
          <span className="text-[11px] text-[var(--text-secondary)]">已处理 {summaryCount} 个操作</span>
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          )}
        </button>
      ) : null}
      {parts.map((part, index) => {
        const isLast = index === parts.length - 1

        if (part.type === 'text') {
          // 折叠态且可收起：过程进展正文折进「已处理 n 个操作」，只留结尾总结的正文可见
          if (collapsed && textCollapsible) return null
          // Activity belongs to run status, never an indefinitely blinking prose suffix.
          return <AgentMarkdownText key={index} text={part.text} streaming={streaming && isLast} identity={`${blockId ?? ''}:${index}`} />
        }

        // 折叠态：隐藏思考/动作，仅保留 text 结论
        if (collapsed) {
          return null
        }

        if (part.type === 'reasoning') {
          return <ReasoningPart key={index} part={part} streaming={streaming && isLast} />
        }

        if (part.type === 'tool-call') {
          // 子 Agent 内部工具卡片已嵌套进容器渲染，平铺处跳过
          if (part.subagentCallId) return null
          if (part.toolName === 'subagent_run' || part.toolName === 'subagent_delegate') {
            return (
              <SubAgentCallCard
                key={`${part.callId}-${index}`}
                part={part}
                children={subagentChildren.get(part.callId) ?? EMPTY_SUBAGENT_CHILDREN}
              />
            )
          }
          return <ToolCallCard key={`${part.callId}-${index}`} part={part} />
        }

        // attachment part 只在用户消息出现，由 AgentPanel 气泡自行渲染，此处防御性跳过
        return null
      })}
    </div>
  )
})
