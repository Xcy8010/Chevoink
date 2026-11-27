import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpenText, Bot, ChevronDown, CircleHelp, ClipboardCheck, Download, FilePenLine, FileText, Globe2, ListCollapse, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useStreamingTextState } from '../../components/use-streaming-text'
import { useAgentStore } from '../agentStore'
import { getMemorySpotlight } from '../tool-argument-view'
import { activityChapterId, activityReviewProblem, isActivityDetailReport, projectActivityGroups, type ActivityCall, type ActivityGroup, type ActivityReportVisibility, type MessageActivityGroups } from '../lib/activity-groups'
import { projectAgentAuthorParts, projectAgentAuthorText } from '../../../../../shared/agent-author-view.js'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation.js'
import { agentRunningToolLabel } from '../../../../../shared/agent-progress.js'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'
import type { AgentMessagePart, AgentToolDisplayPayload, ChapterListItem } from '../../../../../shared/contracts/index.js'
import { plainChapterTitle } from '../../../../../shared/structure/chapter-title.js'
import { AgentMarkdownText } from './AgentMarkdownText'
import { ToolDisplayRenderer } from './AgentMessageParts'
import { AgentProcessRegion } from './AgentProcessRegion'
import { ActivityScrollArea } from './ActivityScrollArea'
import { ProcessDuration } from './ProcessDuration'
import { ChapterReviewCard, ContinuityReviewDetails } from './ChapterReviewCard'
import { reviewBatchFailureHeadline, reviewBatchHeadline } from '../lib/chapter-review-presentation'

const actionNames: Record<string, string> = {
  chapter_read: '查看章节', chapter_list_summaries: '查看章节摘要', project_search: '搜索前文',
  novel_get_context: '读取作品上下文', chapter_bridge_get: '查看前章承接', plan_read: '查看创作计划',
  research_report_read: '查看调研报告', research_dossier_get: '查看调研档案', first_three_prototype_get: '查看前三章方案',
  craft_search: '查找写作技法', retrieval_trace_read: '查看检索记录', skill_catalog: '查看技能目录',
  skill_load: '加载创作技能', skill_run_explain: '查看技能执行说明', skill_shared_invites: '查看技能邀请',
  volume_list: '查看卷目录', structure_outline: '查看卷章结构',
  memory_search: '查找作品设定', web_search: '搜索网页', web_read: '查看网页', web_fetch: '查看网页',
  chapter_write: '写入正文', chapter_append: '续写正文', chapter_edit_range: '修改正文',
  directive_list: '查看写作要求', memory_review_list: '核对记忆冲突', story_charter_get: '查看故事宪章',
  character_voice_get: '查看人物声口', experience_anchor_get: '查看经历锚点', style_profile_get: '查看文风画像',
  cover_prompt_set: '保存封面提示词', cover_generate: '生成封面候选图', cover_apply: '应用封面',
}

function toolIcon(part: ActivityCall) {
  const { phase } = getAgentToolPresentation(part.toolName)
  if (['web_search', 'web_read', 'web_fetch'].includes(part.toolName)) return Globe2
  if (['project_search', 'memory_search', 'platform_novel_search'].includes(part.toolName)) return Search
  if (part.toolName === 'novel_export') return Download
  if (part.toolName === 'ask_user') return CircleHelp
  if (['subagent_run', 'subagent_delegate'].includes(part.toolName)) return Bot
  if (phase === 'review' || part.display?.kind === 'reviewBatch') return ClipboardCheck
  if (phase === 'write' || phase === 'revise') return FilePenLine
  if (phase === 'read') return BookOpenText
  return FileText
}

export type ActivityChapters = ReadonlyMap<string, Pick<ChapterListItem, 'title' | 'orderIndex'> & Partial<Pick<ChapterListItem, 'revision'>>>

function chapterTitle(part: ActivityCall, chapters?: ActivityChapters) {
  const display = part.display
  if (display?.kind === 'chapterDiff') return display.chapterTitle
  if (display?.kind === 'chapterRef') return display.title
  const id = activityChapterId(part)
  return id ? chapters?.get(id)?.title : undefined
}

function observedReviewDisplay(display: AgentToolDisplayPayload | undefined, revisions?: ReadonlyMap<string, number>, chapters?: ActivityChapters) {
  const forChapter = <T extends { chapterId: string; revision: number; status: string },>(chapter: T): T =>
    chapter.status === 'complete' && Math.max(revisions?.get(chapter.chapterId) ?? 0, chapters?.get(chapter.chapterId)?.revision ?? 0) > chapter.revision
      ? { ...chapter, status: 'stale' }
      : chapter
  if (display?.kind === 'reviewBatch') return { ...display, chapters: display.chapters.map(forChapter) }
  if (display?.kind === 'storyCompiler' && display.chapterReview) return { ...display, chapterReview: forChapter(display.chapterReview) }
  return display
}

function activitySummary(part: ActivityCall, runActive: boolean, chapters?: ActivityChapters, detail = false, grouped = false, stale = false): string {
  const presentation = getAgentToolPresentation(part.toolName)
  const action = actionNames[part.toolName] ?? presentation.label
  const title = grouped ? undefined : chapterTitle(part, chapters)
  const display = part.display
  const named = title ? `《${title}》` : ''
  const isWrite = part.toolName === 'chapter_write' || part.toolName === 'chapter_append'
  const review = presentation.phase === 'review'
  if (part.importWaiting && part.status === 'running' && runActive) return '等待你确认导入'
  if (part.toolName === 'ask_user' && part.status === 'running' && runActive) return '等待你回答'
  if (display?.kind === 'question') {
    if (display.cancelled) return '作者已取消提问'
    if (display.unanswered) return '提问未获回答'
    if (display.answer) return '已收到作者回答'
  }
  if (part.status === 'running') {
    if (!runActive) return `${action}未完成`
    if (part.preparing) return `正在准备 · ${detail ? action : presentation.label}`
    if (part.toolName === 'chapter_read' && title) return `正在查看${named}`
    return agentRunningToolLabel(part.toolName, title, detail ? action : undefined)
  }
  if (part.status !== 'success') {
    if (part.toolName === 'chapter_review_batch') return reviewBatchFailureHeadline(part.args)
    // Old persisted results do not carry failureCode. Only the server's exact
    // author-facing anchor receipt is safe to render from the summary field.
    if (detail && part.toolName === 'chapter_edit_range'
      && /^这批修改未保存，(?:第 \d+ 处(?:未找到对应原文|对应多处原文)|第 \d+ 与第 \d+ 处重叠|需要重新定位原文)$/u.test(part.summary ?? '')) return part.summary!
    return display?.kind === 'chapterDiff' || isWrite || part.toolName === 'chapter_edit_range'
      ? `${named}正文修改未保存` : `${detail ? action : presentation.label}未完成`
  }
  if (display?.kind === 'chapterDiff') {
    if (display.before === display.after) return `${named}正文未改动`
    if (!display.appliedDirectly && !part.accepted) return `已生成${named}的修改建议`
    if (isWrite) return grouped ? '已写入正文' : `已写入${named}正文 · ${display.after.length.toLocaleString('zh-CN')} 字`
    return named ? `已完成${named}的修改` : '已完成修改'
  }
  if (display?.kind === 'memoryCard' && !grouped) return `已保存记忆「${display.title}」`
  if (!detail && part.toolName === 'plan_save' && (display?.kind === 'planFile' || display?.kind === 'planDiff')) return `已保存《${display.title}》`
  if (isWrite) return '写入正文'
  if (review) {
    const problem = stale ? 'stale' : activityReviewProblem(part)
    if (problem === 'stale') return `${presentation.label} · 正文有新改动`
    if (problem === 'incomplete') return `${presentation.label}未完成`
    return part.toolName === 'quality_report_get' ? '已查看复查报告' : `${presentation.label}完成`
  }
  if (detail && display?.kind === 'projectSearch') return `搜索「${display.query}」 · ${display.total ? `${display.total} 处` : '无匹配'}`
  if (display?.kind === 'webSearch') {
    if (display.provider === 'unavailable') return '未取得网页资料'
    if (detail) return `搜索网页 · ${display.results.length} 条结果`
  }
  if (part.toolName === 'chapter_read' && title) return `已查看${named}`
  if (part.toolName === 'plan_rename') return '已完成计划重命名'
  if (part.toolName === 'plan_delete') return '已完成计划删除'
  if (presentation.phase === 'save') return `已完成${presentation.label.replace(/^保存/, '')}`
  return `已${detail ? action : presentation.label}`
}

function isOpenImport(part: ActivityCall, runActive: boolean) {
  return runActive && part.toolName === 'novel_import' && part.status === 'running'
    && /^\/studio\/novel\/[^/?#]+\?/.test(part.importWaiting?.url ?? '')
}

const readDetails: Record<string, RegExp> = {
  project_search: /^全书检索[“"](.+)[”"] · (\d+) 处$/u,
  chapter_read: /^读取《(.+)》 (\d+)-(\d+) 字$/u,
  chapter_list_summaries: /^读取 \d+ 章摘要$/u,
  novel_get_context: /^读取《.+》上下文 · \d+ 章$/u,
  plan_read: /^读取计划《.+》$/u,
  memory_search: /^检索["“].+["”] · 命中 \d+ 条$/u,
  directive_list: /^有效指令 · \d+ 条$/u,
  memory_review_list: /^记忆审核箱 · \d+ 项$/u,
  story_charter_get: /^当前尚未建立创作宪章$/u,
  character_voice_get: /^人物声口 · \d+ 项$/u,
  experience_anchor_get: /^经历锚点 · \d+ 项$/u,
  style_profile_get: /^(?:未找到 Style DNA|读取 Style DNA「[^\n]+」)$/u,
}

function savedReadDetail(part: ActivityCall) {
  if (part.status !== 'success' || part.display || !part.summary) return undefined
  const match = readDetails[part.toolName]?.exec(part.summary)
  if (!match) return undefined
  if (part.toolName === 'project_search') return `搜索「${match[1]}」 · ${match[2] === '0' ? '无匹配' : `${match[2]} 处`}`
  if (part.toolName === 'chapter_read') return `《${match[1]}》 · ${match[2] === match[3] ? '本次未读到正文' : `正文第 ${Number(match[2]) + 1}–${match[3]} 字`}`
  return part.summary
}

function ProjectSearchLocations({ display, onOpen }: {
  display: Extract<AgentToolDisplayPayload, { kind: 'projectSearch' }>; onOpen?: (chapterId: string) => void
}) {
  if (!display.matches.length) return null
  const byChapter = new Map<string, typeof display.matches>()
  for (const hit of display.matches) {
    const matches = byChapter.get(hit.chapterId)
    if (matches) matches.push(hit)
    else byChapter.set(hit.chapterId, [hit])
  }
  return <ActivityScrollArea detail><ul className="space-y-0.5 text-xs leading-5 text-[var(--text-secondary)]">
    {[...byChapter.values()].map(([hit, ...others]) => <li key={hit.chapterId} className="min-w-0 break-words">
      {hit.volumeTitle ? <span>{hit.volumeTitle} · </span> : null}
      {onOpen ? <button type="button" onClick={() => onOpen(hit.chapterId)} className="text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:underline">《{hit.chapterTitle}》</button>
        : <span className="text-[var(--text-primary)]">《{hit.chapterTitle}》</span>}
      <span> · {hit.field === 'content' ? `正文第 ${hit.offset + 1} 字` : hit.field === 'summary' ? '章节摘要' : '章节标题'}{others.length ? '等' : ''}</span>
    </li>)}
  </ul></ActivityScrollArea>
}

type ReadSource = Extract<AgentToolDisplayPayload, { kind: 'readSources' }>['items'][number]

function memorySearchSourceTitle({ title, preview, memoryType }: ReadSource, requestedType: unknown, chapters?: ActivityChapters): string {
  const type = memoryType ?? (typeof requestedType === 'string' ? requestedType : undefined)
  if (type !== undefined && type !== 'chapterSummary') return title
  // Automatically generated chapter summaries use their source ID as the stored title.
  const reference = /^(?:章节|chapter)[:：]\s*(\S+)$/iu.exec(title.trim())?.[1]
  if (!reference) return title
  const chapter = chapters?.get(reference)
  const isChapterId = /^(?:c[a-z0-9]{24}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(reference)
  if (!chapter && !isChapterId) return title
  // Old mixed results lack a card type. The automatic summary also stored the chapter title at the start of its preview.
  if (type === undefined && (!chapter?.title.trim() || !preview?.startsWith(`${chapter.title}：`))) return '历史设定（名称暂不可用）'
  if (!chapter) return '章节摘要（无法定位章节）'
  const name = plainChapterTitle(chapter.title)
  return name ? `第 ${chapter.orderIndex} 章 · ${name}` : `第 ${chapter.orderIndex} 章`
}

const ActivityDetail = memo(function ActivityDetail({ part, runActive, chapters, readOnly, stale, reviewChapterRevisions }: {
  part: ActivityCall; runActive: boolean; chapters?: ActivityChapters; readOnly?: boolean; stale?: boolean
  reviewChapterRevisions?: ReadonlyMap<string, number>
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const navigate = useAgentStore(state => state.requestToolNavigation)
  const spotlight = useAgentStore(state => state.requestMemorySpotlight)
  const Icon = toolIcon(part)
  const display = observedReviewDisplay(part.display, reviewChapterRevisions, chapters)
  const qualityChapter = display?.kind === 'qualityReport' ? chapters?.get(display.chapterId) : undefined
  const qualityStatus = part.status !== 'success' || activityReviewProblem(part) === 'incomplete' ? 'incomplete'
    : stale || activityReviewProblem(part) === 'stale' || display?.kind === 'qualityReport' && (qualityChapter?.revision ?? 0) > display.chapterRevision
      ? 'stale' : 'complete'
  const legacyContinuity = part.toolName === 'continuity_validate' && display?.kind === 'storyCompiler' && !display.chapterReview
  const structuredReview = display?.kind === 'reviewBatch' || display?.kind === 'qualityReport' || display?.kind === 'storyCompiler' && (display.chapterReview || legacyContinuity)
  const requestedMemoryType = (part.args as { memoryType?: unknown } | null)?.memoryType
  const chapterId = activityChapterId(part)
  const planId = part.toolName === 'plan_read' && !display ? (part.args as { planId?: unknown } | null)?.planId : undefined
  const navigable = Boolean(chapterId) || typeof planId === 'string' || display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
  const openTarget = !readOnly && navigable ? () => navigate(part.toolName, chapterId ? { chapterId } : part.args, display) : undefined
  const label = savedReadDetail(part) ?? activitySummary(part, runActive, chapters, true, false, stale)
  const memory = !readOnly && part.status === 'success' ? getMemorySpotlight(part.toolName, part.args, display) : null
  const hasResultTarget = display?.kind === 'chapterDiff' || display?.kind === 'chapterRef' || display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
  const collapsible = display?.kind === 'projectSearch' && new Set(display.matches.map(hit => hit.chapterId)).size > 4
    || display?.kind === 'readSources' && display.items.length > 4
    || display?.kind === 'subagentReport' && (display.report.length > 180 || display.report.split('\n').length > 4)
  const onOpenReviewedChapter = readOnly ? undefined : (chapterId: string, evidence?: string) => navigate(part.toolName, { chapterId, evidence })
  const singleReview = legacyContinuity || display?.kind === 'qualityReport'
  const reviewTitle = singleReview ? chapterTitle(part, chapters) ?? qualityChapter?.title : undefined
  const result = display ? <div className="agent-activity-detail min-w-0">
    {display.kind === 'qualityReport' ? <ChapterReviewCard showChapter={false} onOpenChapter={onOpenReviewedChapter} chapters={[{
      chapterId: display.chapterId,
      title: qualityChapter?.title ?? display.appliedBodyChange?.chapterTitle ?? '',
      orderIndex: qualityChapter?.orderIndex,
      revision: display.chapterRevision,
      status: qualityStatus,
      findings: display.findings.map(finding => ({
        ...finding,
        disposition: finding.disposition === 'repaired' ? 'repaired' : finding.authorFeedback === 'rejected' ? 'retained' : undefined,
      })),
    }]} />
      : legacyContinuity && display.kind === 'storyCompiler'
        ? <ContinuityReviewDetails display={display} status={qualityStatus} />
        : display.kind === 'projectSearch' ? <ProjectSearchLocations display={display} onOpen={readOnly ? undefined : chapterId => navigate(part.toolName, { chapterId })} />
      : display.kind === 'readSources' ? <ActivityScrollArea detail><ul className="space-y-0.5 text-xs leading-5 text-[var(--text-secondary)]">
        {display.items.map((item, index) => {
          const { target } = item
          const title = part.toolName === 'memory_search' ? memorySearchSourceTitle(item, requestedMemoryType, chapters) : item.title
          return <li key={target?.id ?? index} className="min-w-0 break-words">
            {target && !readOnly ? <button type="button" className="text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:underline"
              onClick={() => navigate(part.toolName, target.kind === 'chapter' ? { chapterId: target.id } : { planId: target.id })}>《{title}》</button>
              : <p className="text-[var(--text-primary)]">{title}</p>}
          </li>
        })}
      </ul></ActivityScrollArea>
        : display.kind === 'subagentReport'
          ? <ActivityScrollArea detail><p className="whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">{projectAgentAuthorText(display.report)}</p></ActivityScrollArea>
          : <ToolDisplayRenderer display={display} onNavigateTarget={openTarget}
            onOpenReviewedChapter={onOpenReviewedChapter}
            authorActivity readOnly={readOnly} />}
  </div> : null
  return <li className="min-w-0 font-normal" data-activity-tool={part.toolName}>
    {display?.kind !== 'reviewBatch' && <div className="agent-activity-line min-h-7 items-start py-1 text-xs leading-5 text-[var(--text-secondary)]">
      <Icon aria-hidden className="mt-0.5 h-4 w-4 text-[var(--text-tertiary)]" />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {collapsible ? <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}
          data-activity-detail-toggle className="min-w-0 break-words text-left underline-offset-2 hover:underline focus-visible:underline">
          {label}<ChevronDown aria-hidden className={cn('ml-1 inline-block h-3.5 w-3.5 align-text-bottom motion-safe:transition-transform', !open && '-rotate-90')} />
        </button> : <span className="min-w-0 break-words">{structuredReview ? getAgentToolPresentation(part.toolName).label : label}</span>}
        {openTarget && !hasResultTarget && (!structuredReview || singleReview) ? <button type="button" onClick={openTarget}
          className={cn('underline-offset-2 hover:underline focus-visible:underline', reviewTitle ? 'min-w-0 max-w-full break-words text-left' : 'shrink-0')}>
          {reviewTitle ? `《${plainChapterTitle(reviewTitle)}》` : typeof planId === 'string' ? '打开计划' : '打开章节'}
        </button> : reviewTitle ? <span className="min-w-0 break-words">《{plainChapterTitle(reviewTitle)}》</span> : null}
        {memory ? <button type="button" onClick={() => spotlight(memory.type, memory.title, memory.memoryId)} className="shrink-0 underline-offset-2 hover:underline focus-visible:underline">查看设定</button> : null}
      </div>
    </div>}
    {collapsible ? <AgentProcessRegion open={open} id={detailsId}>{result}</AgentProcessRegion> : result}
  </li>
})

const ActivityRow = memo(function ActivityRow({ group, runActive, active, continuing, chapters, readOnly, awaitingApprovalCallId, animateLive }: {
  group: ActivityGroup; runActive: boolean; active: boolean; chapters?: ActivityChapters; readOnly?: boolean
  continuing: boolean
  awaitingApprovalCallId?: string
  animateLive?: boolean
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const calls = group.calls
  const grouped = calls.length > 1
  const unresolved = group.unsettled
  const running = runActive ? [...calls].reverse().find(part => part.status === 'running') : undefined
  const part = running ?? unresolved ?? calls.at(-1)
  const iconPart = group.title ? calls[0] : part
  const importWaiting = calls.find(call => isOpenImport(call, runActive))
  const waitingForAnswer = runActive && calls.some(call => call.toolName === 'ask_user' && call.status === 'running')
  const waitingForApproval = runActive && awaitingApprovalCallId !== undefined
    && calls.some(call => !call.preparing && call.status === 'running' && call.callId === awaitingApprovalCallId)
  const settledBatch = !running && part?.display?.kind === 'reviewBatch'
  const namedInProgress = Boolean(group.title && runActive && !settledBatch && (running || active && !group.closed && !group.completed))
  const waiting = Boolean(importWaiting || waitingForAnswer || waitingForApproval)
  const Icon = iconPart && toolIcon(iconPart)
  const chapterId = part && activityChapterId(part)
  const sharesChapter = Boolean(chapterId) && part?.display?.kind === 'chapterDiff'
    && calls.every(call => activityChapterId(call) === chapterId)
  const readChapterIds = grouped && calls.every(call => call.toolName === 'chapter_read' && activityChapterId(call))
    ? new Set(calls.map(activityChapterId)) : undefined
  const readLabel = group.readLabel
  const latestDisplay = observedReviewDisplay(part?.display, group.reviewChapterRevisions, chapters)
  const currentBatch = !running && !waiting && latestDisplay?.kind === 'reviewBatch' && latestDisplay.chapters.length ? latestDisplay : undefined
  let label: string | undefined
  if (currentBatch) {
    label = reviewBatchHeadline(currentBatch)
  } else if (!running && !waiting && part?.toolName === 'chapter_review_batch' && part.status !== 'success') {
    label = reviewBatchFailureHeadline(part.args, chapters)
  } else if (runActive && continuing && !running && !namedInProgress && !waiting && part) {
    label = group.readLabel === '查看创作资料' ? '核对创作资料' : getAgentToolPresentation(part.toolName).label
  } else if (group.title) {
    const title = group.title
    if (waitingForAnswer) label = `等待你回答 · ${title}`
    else if (importWaiting || waitingForApproval) label = `等待你确认 · ${title}`
    else if (namedInProgress) label = `正在${title}`
    else if ((group.closed || group.completed) && !group.unfinished) label = `已${title}`
    else label = `${title}未完成`
  } else if (part) {
    if (readLabel && running) label = activitySummary(running, runActive, chapters, true)
    else if (readLabel) label = group.unfinished
      ? `${readLabel}有未完成项` : `已${readLabel}`
    else if (grouped && !running && unresolved) label = `${getAgentToolPresentation(part.toolName).label}有未完成项`
    else if (readChapterIds && readChapterIds.size > 1 && calls.every(call => call.status === 'success' && !call.preparing)) label = `已查看 ${readChapterIds.size} 章正文`
    else label = activitySummary(part, runActive, chapters, false, grouped && !readChapterIds && !sharesChapter, group.staleReviewCalls?.has(part))
  }
  const showingActivity = Boolean(running && !waiting)
  const shimmer = runActive && Boolean(showingActivity || namedInProgress || continuing) && !waiting && !settledBatch
  const step = group.title ? label : part ? `${part.toolName}:${part.preparing ? 'preparing' : part.status}` : ''
  const enter = useRef<boolean | undefined>(undefined)
  if (enter.current === undefined) {
    enter.current = Boolean(animateLive && document.visibilityState !== 'hidden'
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  }
  const previousStep = useRef(step)
  const headline = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const changed = previousStep.current !== step
    previousStep.current = step
    if (!changed || !animateLive || document.visibilityState === 'hidden' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = headline.current?.animate?.(
      [{ opacity: 0.5, transform: 'translateY(2px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 160, easing: 'ease-out' },
    )
    return () => animation?.cancel()
  }, [animateLive, step])

  return <div className="min-w-0" data-author-activity data-author-step>
    <button type="button" aria-expanded={open} aria-controls={detailsId}
      onClick={() => setOpen(value => !value)}
      className="agent-activity-step min-h-7 w-fit max-w-full text-left text-sm font-medium leading-7 text-[var(--text-secondary)] focus-visible:underline focus-visible:outline-none">
      <span ref={headline} className={cn('agent-activity-line items-center', enter.current && 'agent-tool-enter')}>
        {Icon && <Icon aria-hidden className="h-4 w-4" />}
        <span className="min-w-0 break-words text-balance">
          <span aria-live={group.title || active || running ? 'polite' : undefined}
            data-activity-continuing={runActive && continuing && !waiting && !settledBatch || undefined}
            data-activity-preparing={showingActivity && running?.preparing || undefined}
            data-activity-running={showingActivity && !running?.preparing || undefined}
            className={cn('agent-activity-label', shimmer && 'agent-processing-shimmer')}>{label}</span>
          <ChevronDown aria-hidden className={cn('agent-activity-chevron ml-1 inline-block h-3.5 w-3.5 align-text-bottom motion-safe:transition-[opacity,transform]', open ? 'rotate-0' : '-rotate-90')} />
        </span>
      </span>
    </button>
    {!readOnly && importWaiting?.importWaiting ? <a className="ml-6 text-xs underline" href={importWaiting.importWaiting.url}>核对原文并确认导入</a> : null}
    <AgentProcessRegion open={open} id={detailsId}>
      <ActivityScrollArea><ul>
        {calls.flatMap((call, index) => {
          const key = group.callKeys[index]
          const receipts = [call, ...(group.childrenByCall.get(key) ?? [])].map(detail =>
            <ActivityDetail key={JSON.stringify([key, detail.subagentCallId ?? null, detail.callId])} part={detail} runActive={runActive} chapters={chapters} readOnly={readOnly}
              stale={group.staleReviewCalls?.has(detail)} reviewChapterRevisions={group.reviewChapterRevisions} />)
          const reports = group.reportsAfterCall.get(key)?.filter(report => isActivityDetailReport(report, runActive, awaitingApprovalCallId))
          return [...receipts, ...reports?.map(report => <li key={report.id} data-activity-report className="ml-6 text-[var(--text-secondary)]">
            <AgentMarkdownText text={report.text} identity={report.id} />
          </li>) ?? []]
        })}
      </ul></ActivityScrollArea>
    </AgentProcessRegion>
  </div>
})

export function AuthorActivitySummary({ timing, active, open, openingPending = false, onToggle }: {
  timing: AgentRunTiming; active: boolean; open: boolean; openingPending?: boolean; onToggle?: () => void
}) {
  const label = active || timing.elapsedMs !== null
    ? <ProcessDuration timing={timing} active={active} />
    : <span className="text-sm leading-6 text-[var(--text-secondary)]">查看处理过程</span>
  return <><div className="mb-1 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1.5" data-author-timer>
    {onToggle ? <button type="button" aria-expanded={open} onClick={onToggle}
      className="inline-flex min-h-7 shrink-0 items-center gap-1 text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:underline focus-visible:outline-none">
      {label}
      <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 shrink-0 motion-safe:transition-transform', !open && '-rotate-90')} />
    </button> : <div className="flex min-h-7 shrink-0 items-center">{label}</div>}
  </div>
    {active && openingPending && <p role="status" className="agent-opening-thinking agent-processing-shimmer mt-4 w-fit text-sm font-medium leading-7">正在思考</p>}
  </>
}

export function AuthorProgressText({ text, className }: { text: string; className?: string }) {
  return <p className={cn('break-words text-pretty text-sm font-medium leading-7 text-[var(--text-primary)]', className)} data-author-progress>{text}</p>
}

export const AuthorActivityParts = memo(function AuthorActivityParts({
  parts, messageId, groups, activeGroupId, continuingGroupId, runActive, processOpen, collapseText = false, revealText, onTextRevealed, activityChapters, readOnly, awaitingApprovalCallId, reportVisibility, liveToolReceiptIds,
}: {
  parts: AgentMessagePart[]
  messageId: string
  groups?: MessageActivityGroups
  activeGroupId?: string
  continuingGroupId?: string
  runActive: boolean
  processOpen?: boolean
  collapseText?: boolean
  revealText?: string
  onTextRevealed?: (messageId: string, text: string) => void
  activityChapters?: ActivityChapters
  readOnly?: boolean
  awaitingApprovalCallId?: string
  reportVisibility?: ActivityReportVisibility
  liveToolReceiptIds?: ReadonlySet<string>
}) {
  const authorParts = useMemo(() => {
    const projected = projectAgentAuthorParts(parts.filter(part => part.type !== 'reasoning'), false, { includePreparing: runActive })
    if (!reportVisibility) return projected
    let textIndex = 0
    // Preserve the text position across the hold so released reports do not
    // remount an existing opening or displace the focused activity control.
    return projected.map(part => part.type === 'text' && reportVisibility.hidden.has(textIndex++) ? { ...part, text: '' } : part)
  }, [parts, runActive, reportVisibility])
  const localGroups = useMemo(() => groups ?? projectActivityGroups([{ id: messageId, runId: '', role: 'assistant', parts }]).byMessage.get(messageId), [groups, messageId, parts])
  const receivedText = useMemo(() => authorParts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''), [authorParts])
  const revealed = useStreamingTextState(receivedText, revealText !== undefined, messageId, true)
  const deferred = reportVisibility?.deferred ?? false
  useEffect(() => {
    if (revealText !== undefined && !deferred && !revealed.pending) {
      const fullText = parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
      onTextRevealed?.(messageId, fullText)
    }
  }, [revealText, deferred, revealed.pending, messageId, parts, onTextRevealed])
  const lastToolIndex = authorParts.reduce((last, part, index) => part.type === 'tool-call' ? index : last, -1)
  let textOffset = 0
  let textOrdinal = 0
  const rendered = new Set<string>()

  const stepKey = `${messageId}:step`
  const entries = authorParts.map<ReactNode>((part, index) => {
      if (part.type === 'context-compaction') return <div key={`${messageId}:compaction`} role="status" title="模型请求的上下文包含当轮工具输入、输出和模型指令，并预留回答空间。" className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
        <ListCollapse aria-hidden="true" className="size-4" />
        {part.state === 'running' ? '正在自动压缩上下文' : '上下文已自动压缩'}
      </div>
      if (part.type === 'text') {
        const identity = `${messageId}:text:${textOrdinal++}`
        if (!part.text) return null
        // A progress row can settle in the same paint that public text arrives.
        // Show the beginning immediately and keep revealing the rest in place.
        const opening = textOffset === 0 ? /^\s*.{1,3}/su.exec(part.text)?.[0].length ?? 0 : 0
        const text = part.text.slice(0, Math.max(opening, revealed.text.length - textOffset))
        textOffset += part.text.length
        const inProcess = collapseText || index < lastToolIndex
        return <AgentProcessRegion key={identity} open={!inProcess || processOpen !== false}>
          <AgentMarkdownText text={text} identity={identity} />
        </AgentProcessRegion>
      }
      if (part.type !== 'tool-call' || part.subagentCallId) return null
      const group = localGroups?.get(part.callId)
      if (!group || group.messageId !== messageId || group.firstCallId !== part.callId || rendered.has(group.id)) return null
      const key = rendered.size ? group.id : stepKey
      rendered.add(group.id)
      return <AgentProcessRegion key={key} open={processOpen ?? true}>
        <ActivityRow key="activity" group={group} runActive={runActive} active={activeGroupId === group.id} continuing={continuingGroupId === group.id} chapters={activityChapters} readOnly={readOnly}
          awaitingApprovalCallId={awaitingApprovalCallId}
          animateLive={!readOnly && group.receiptKeys.some(key => liveToolReceiptIds?.has(key))} />
      </AgentProcessRegion>
  })
  return entries.some(Boolean) ? <div className="flex flex-col gap-3 font-medium">{entries}</div> : null
})
