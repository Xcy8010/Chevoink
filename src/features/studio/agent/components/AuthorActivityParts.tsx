import { memo, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { BookOpenText, Bot, Brain, ChevronDown, CircleHelp, ClipboardCheck, Download, FilePenLine, FileText, Globe2, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useStreamingTextState } from '../../components/use-streaming-text'
import { useAgentStore } from '../agentStore'
import { getMemorySpotlight } from '../tool-argument-view'
import { activityChapterId, activityTarget, projectActivityGroups, type ActivityCall, type ActivityGroup, type MessageActivityGroups } from '../lib/activity-groups'
import { projectAgentAuthorParts, projectAgentAuthorText } from '../../../../../shared/agent-author-view.js'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation.js'
import { agentRunningToolLabel } from '../../../../../shared/agent-progress.js'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'
import type { AgentMessagePart, AgentToolDisplayPayload } from '../../../../../shared/contracts/index.js'
import { AgentMarkdownText } from './AgentMarkdownText'
import { ToolDisplayRenderer } from './AgentMessageParts'
import { AgentProcessRegion } from './AgentProcessRegion'
import { ProcessDuration } from './ProcessDuration'

const actionNames: Record<string, string> = {
  chapter_read: '查看章节', chapter_list_summaries: '查看章节摘要', project_search: '搜索前文',
  memory_search: '查找作品设定', web_search: '搜索网页', web_read: '查看网页', web_fetch: '查看网页',
  chapter_write: '写入正文', chapter_append: '续写正文', chapter_edit_range: '修改正文',
}

function toolIcon(part: ActivityCall) {
  const { phase } = getAgentToolPresentation(part.toolName)
  if (['web_search', 'web_read', 'web_fetch'].includes(part.toolName)) return Globe2
  if (['project_search', 'memory_search', 'platform_novel_search'].includes(part.toolName)) return Search
  if (part.toolName === 'novel_export') return Download
  if (part.toolName === 'ask_user') return CircleHelp
  if (['subagent_run', 'subagent_delegate'].includes(part.toolName)) return Bot
  if (phase === 'review') return ClipboardCheck
  if (phase === 'write' || phase === 'revise') return FilePenLine
  if (phase === 'read') return BookOpenText
  return FileText
}

function chapterTitle(part: ActivityCall, titles?: ReadonlyMap<string, string>) {
  const display = part.display
  if (display?.kind === 'chapterDiff') return display.chapterTitle
  if (display?.kind === 'chapterRef') return display.title
  const id = activityChapterId(part)
  return id ? titles?.get(id) : undefined
}

function reviewProblem(part: ActivityCall): 'stale' | 'incomplete' | undefined {
  if (part.reviewOutcome === 'stale') return 'stale'
  if (part.reviewOutcome === 'provider_unresolved' || part.reviewOutcome === 'provider_failed' || part.reviewOutcome === 'evidence_repair_required') return 'incomplete'
  if (part.display?.kind === 'qualityReport') {
    if (part.display.status === 'stale') return 'stale'
    if (part.display.status === 'analyzing' || part.display.status === 'failed') return 'incomplete'
  }
}

function activitySummary(part: ActivityCall, runActive: boolean, titles?: ReadonlyMap<string, string>, detail = false, grouped = false): string {
  const presentation = getAgentToolPresentation(part.toolName)
  const action = actionNames[part.toolName] ?? presentation.label
  const title = grouped ? undefined : chapterTitle(part, titles)
  const display = part.display
  const named = title ? `《${title}》` : ''
  const isWrite = part.toolName === 'chapter_write' || part.toolName === 'chapter_append'
  const review = presentation.phase === 'review'
  if (part.importWaiting && part.status === 'running' && runActive) return '等待你确认导入'
  if (part.toolName === 'ask_user' && part.status === 'running' && runActive) return '等待你回答'
  if (part.status === 'running') {
    if (!runActive) return `${action}未完成`
    return agentRunningToolLabel(part.toolName, title, detail ? action : undefined)
  }
  if (part.status !== 'success') {
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
  if (isWrite) return '写入正文'
  if (review) {
    const problem = reviewProblem(part)
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

function hasCurrentFailure(part: ActivityCall) {
  return part.status === 'failed' || part.status === 'denied'
    || reviewProblem(part) === 'incomplete'
    || part.display?.kind === 'webSearch' && part.display.provider === 'unavailable'
}

const readDetails: Record<string, RegExp> = {
  project_search: /^全书检索[“"](.+)[”"] · (\d+) 处$/u,
  chapter_read: /^读取《(.+)》 (\d+)-(\d+) 字$/u,
  chapter_list_summaries: /^读取 \d+ 章摘要$/u,
  novel_get_context: /^读取《.+》上下文 · \d+ 章$/u,
  plan_read: /^读取计划《.+》$/u,
  memory_search: /^检索["“].+["”] · 命中 \d+ 条$/u,
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
  display: Extract<AgentToolDisplayPayload, { kind: 'projectSearch' }>; onOpen: (chapterId: string) => void
}) {
  if (!display.matches.length) return null
  const byChapter = new Map<string, typeof display.matches>()
  for (const hit of display.matches) {
    const matches = byChapter.get(hit.chapterId)
    if (matches) matches.push(hit)
    else byChapter.set(hit.chapterId, [hit])
  }
  return <ul className="space-y-0.5 text-xs leading-5 text-[var(--text-secondary)]">
    {[...byChapter.values()].map(([hit, ...others]) => <li key={hit.chapterId} className="min-w-0 break-words">
      {hit.volumeTitle ? <span>{hit.volumeTitle} · </span> : null}
      <button type="button" onClick={() => onOpen(hit.chapterId)} className="text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:underline">《{hit.chapterTitle}》</button>
      <span> · {hit.field === 'content' ? `正文第 ${hit.offset + 1} 字` : hit.field === 'summary' ? '章节摘要' : '章节标题'}{others.length ? '等' : ''}</span>
    </li>)}
  </ul>
}

const ActivityDetail = memo(function ActivityDetail({ part, runActive, titles }: { part: ActivityCall; runActive: boolean; titles?: ReadonlyMap<string, string> }) {
  const navigate = useAgentStore(state => state.requestToolNavigation)
  const spotlight = useAgentStore(state => state.requestMemorySpotlight)
  const Icon = toolIcon(part)
  const display = part.display
  const chapterId = activityChapterId(part)
  const planId = part.toolName === 'plan_read' && !display ? (part.args as { planId?: unknown } | null)?.planId : undefined
  const navigable = Boolean(chapterId) || typeof planId === 'string' || display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
  const openTarget = navigable ? () => navigate(part.toolName, chapterId ? { chapterId } : part.args, display) : undefined
  const detail = savedReadDetail(part)
  const memory = part.status === 'success' ? getMemorySpotlight(part.toolName, part.args) : null
  const hasResultTarget = display?.kind === 'chapterDiff' || display?.kind === 'chapterRef' || display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
  return <li className="min-w-0 py-1 font-normal" data-activity-tool={part.toolName}>
    <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-[var(--text-secondary)]">
      <Icon aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 break-words">{detail ?? activitySummary(part, runActive, titles, true)}</span>
      {openTarget && !hasResultTarget ? <button type="button" onClick={openTarget} className="shrink-0 underline-offset-2 hover:underline focus-visible:underline">{typeof planId === 'string' ? '打开计划' : '打开章节'}</button> : null}
      {memory ? <button type="button" onClick={() => spotlight(memory.type, memory.title)} className="shrink-0 underline-offset-2 hover:underline focus-visible:underline">查看设定</button> : null}
    </div>
    {display ? <div className="min-w-0 pl-[22px]">
      {display.kind === 'projectSearch' ? <ProjectSearchLocations display={display} onOpen={chapterId => navigate(part.toolName, { chapterId })} />
        : display.kind === 'readSources' ? <ul className="space-y-0.5 text-xs leading-5 text-[var(--text-secondary)]">
          {display.items.map(({ title, target }, index) => <li key={target?.id ?? index} className="min-w-0 break-words">
            {target ? <button type="button" className="text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:underline"
              onClick={() => navigate(part.toolName, target.kind === 'chapter' ? { chapterId: target.id } : { planId: target.id })}>《{title}》</button>
              : <p className="text-[var(--text-primary)]">{title}</p>}
          </li>)}
        </ul>
          : display.kind === 'subagentReport'
            ? <p className="line-clamp-2 break-words text-xs leading-5 text-[var(--text-secondary)]">{projectAgentAuthorText(display.report)}</p>
            : <ToolDisplayRenderer display={display} onNavigateTarget={openTarget} authorActivity />}
    </div> : null}
  </li>
})

const ActivityRow = memo(function ActivityRow({ group, runActive, active, workingLabel, titles }: {
  group?: ActivityGroup; runActive: boolean; active: boolean; workingLabel?: string; titles?: ReadonlyMap<string, string>
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const calls = group?.calls ?? []
  const grouped = calls.length > 1
  const latest = new Map(calls.map(part => [activityTarget(part), part]))
  // A successful retry for the same target supersedes the headline. The
  // failed receipt stays in the expanded list.
  const unresolved = [...latest.values()].find(hasCurrentFailure)
  const running = runActive ? [...calls].reverse().find(part => part.status === 'running') : undefined
  const part = running ?? unresolved ?? calls.at(-1)
  const Icon = part && !workingLabel ? toolIcon(part) : Brain
  const importWaiting = calls.find(call => isOpenImport(call, runActive))
  const label = workingLabel ?? (part && (grouped && !running && unresolved
    ? `${getAgentToolPresentation(part.toolName).label}有未完成项`
    : activitySummary(part, runActive, titles, false, grouped)))
  const executing = Boolean(active && running && !importWaiting && running.toolName !== 'ask_user')

  return <div className="min-w-0" data-author-activity={group ? '' : undefined} data-author-working={workingLabel ? '' : undefined} data-author-step>
    <button type="button" aria-expanded={group ? open : undefined} aria-controls={group ? detailsId : undefined}
      disabled={!group} onClick={() => setOpen(value => !value)}
      className="agent-activity-step flex min-h-7 w-fit max-w-full items-center gap-2 px-1 text-left text-base font-medium leading-7 text-[var(--text-secondary)] focus-visible:underline focus-visible:outline-none">
      <Icon aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words text-balance">
        <span aria-live={active || running || workingLabel ? 'polite' : undefined} data-activity-running={executing || undefined}
          className={cn('agent-activity-label', (executing || workingLabel) && 'agent-processing-shimmer')}>{label}</span>
        {group ? <ChevronDown aria-hidden className={cn('agent-activity-chevron ml-1 inline-block h-3.5 w-3.5 align-text-bottom motion-safe:transition-[opacity,transform]', open ? 'rotate-0' : '-rotate-90')} /> : null}
      </span>
    </button>
    {importWaiting?.importWaiting ? <a className="ml-6 text-xs underline" href={importWaiting.importWaiting.url}>核对原文并确认导入</a> : null}
    {group ? <AgentProcessRegion open={open} id={detailsId}>
      <ul className="ml-2 border-l border-[var(--border-subtle)] pl-3">
        {calls.flatMap(call => [call, ...(group.childrenByCall.get(call.callId) ?? [])]).map(call =>
          <ActivityDetail key={JSON.stringify([call.subagentCallId ?? null, call.callId])} part={call} runActive={runActive} titles={titles} />)}
      </ul>
    </AgentProcessRegion> : null}
  </div>
})

export function AuthorActivitySummary({ timing, active, open, onToggle }: { timing: AgentRunTiming; active: boolean; open: boolean; onToggle?: () => void }) {
  const label = active || timing.elapsedMs !== null
    ? <ProcessDuration timing={timing} active={active} />
    : <span className="text-sm text-[var(--text-secondary)]">查看处理过程</span>
  return <div className="mb-2 border-b border-[var(--border-subtle)] pb-1.5" data-author-timer>
    {onToggle ? <button type="button" aria-expanded={open} onClick={onToggle}
      className="inline-flex min-h-7 items-center gap-1 text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:underline focus-visible:outline-none">
      {label}
      <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 shrink-0 motion-safe:transition-transform', !open && '-rotate-90')} />
    </button> : <div className="flex min-h-7 items-center">{label}</div>}
  </div>
}

export function AuthorProgressText({ text, className }: { text: string; className?: string }) {
  return <p className={cn('break-words text-pretty text-base font-medium leading-7 text-[var(--text-primary)]', className)} data-author-progress>{text}</p>
}

export const AuthorActivityParts = memo(function AuthorActivityParts({
  parts, messageId, groups, activeGroupId, runActive, processOpen, collapseText = false, workingLabel, workingGroupId, revealText, onTextRevealed, activityChapterTitles,
}: {
  parts: AgentMessagePart[]
  messageId: string
  groups?: MessageActivityGroups
  activeGroupId?: string
  runActive: boolean
  processOpen?: boolean
  collapseText?: boolean
  workingLabel?: string
  workingGroupId?: string
  revealText?: string
  onTextRevealed?: (messageId: string, text: string) => void
  activityChapterTitles?: ReadonlyMap<string, string>
}) {
  const authorParts = useMemo(() => projectAgentAuthorParts(parts.filter(part => part.type !== 'reasoning'), false, { includePreparing: runActive }), [parts, runActive])
  const localGroups = useMemo(() => groups ?? projectActivityGroups([{ id: messageId, runId: '', role: 'assistant', parts }]).byMessage.get(messageId), [groups, messageId, parts])
  const receivedText = useMemo(() => authorParts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''), [authorParts])
  const revealed = useStreamingTextState(receivedText, revealText !== undefined, messageId, true)
  useEffect(() => {
    if (revealText !== undefined && !revealed.pending) onTextRevealed?.(messageId, receivedText)
  }, [revealText, revealed.pending, messageId, receivedText, onTextRevealed])
  const lastToolIndex = authorParts.reduce((last, part, index) => part.type === 'tool-call' ? index : last, -1)
  let textOffset = 0
  let textOrdinal = 0
  const rendered = new Set<string>()

  const stepKey = `${messageId}:step`
  const liveGroupId = workingGroupId ?? (workingLabel ? [...(localGroups?.values() ?? [])].at(-1)?.id : undefined)
  const entries = authorParts.map<ReactNode>((part, index) => {
      if (part.type === 'text') {
        const identity = `${messageId}:text:${textOrdinal++}`
        const text = part.text.slice(0, Math.max(0, revealed.text.length - textOffset))
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
        {group.transition ? <AuthorProgressText text={group.transition} className="mb-4" /> : null}
        <ActivityRow key="activity" group={group} runActive={runActive} active={activeGroupId === group.id} titles={activityChapterTitles}
          workingLabel={liveGroupId === group.id ? workingLabel : undefined} />
      </AgentProcessRegion>
  })
  if (workingLabel && !liveGroupId) {
    // Public prose stays first. Until a tool arrives, this is the pending
    // activity row, which the first tool takes over in the same position.
    entries.push(<AgentProcessRegion key={stepKey} open={processOpen ?? true}>
      <ActivityRow key="activity" runActive={runActive} active={false} workingLabel={workingLabel} />
    </AgentProcessRegion>)
  }
  return <div className="flex flex-col gap-4 font-medium">{entries}</div>
})
