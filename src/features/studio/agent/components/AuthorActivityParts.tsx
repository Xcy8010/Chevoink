import { memo, useEffect, useId, useMemo, useState } from 'react'
import { BookOpenText, Bot, ChevronDown, CircleHelp, ClipboardCheck, Download, FilePenLine, FileText, Globe2, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useStreamingTextState } from '../../components/use-streaming-text'
import { useAgentStore } from '../agentStore'
import { getMemorySpotlight } from '../tool-argument-view'
import { activityChapterId, projectActivityGroups, type ActivityCall, type ActivityGroup, type MessageActivityGroups } from '../lib/activity-groups'
import { projectAgentAuthorParts, projectAgentAuthorText } from '../../../../../shared/agent-author-view.js'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation.js'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'
import type { AgentMessagePart } from '../../../../../shared/contracts/index.js'
import { AgentMarkdownText } from './AgentMarkdownText'
import { ToolDisplayRenderer } from './AgentMessageParts'
import { AgentProcessRegion } from './AgentProcessRegion'
import { ProcessDuration } from './ProcessDuration'

const actionNames: Record<string, string> = {
  chapter_read: '查看章节', chapter_list_summaries: '查看章节摘要', project_search: '搜索前文',
  memory_search: '查找作品设定', web_search: '搜索网页', web_read: '查看网页', web_fetch: '查看网页',
  chapter_write: '写入正文', chapter_append: '续写正文', chapter_edit_range: '修改正文',
  continuity_validate: '核对章节衔接', quality_analyze: '检查表达', quality_report_get: '查看复查报告',
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

function reviewResult(part: ActivityCall) {
  const display = part.display
  if (part.reviewOutcome === 'stale') return '正文有新改动'
  if (part.reviewOutcome === 'provider_unresolved' || part.reviewOutcome === 'provider_failed' || part.reviewOutcome === 'evidence_repair_required') return '复查未完成'
  if (display?.kind === 'storyCompiler' && display.phase === 'check') {
    if (display.errorCount) return `${display.errorCount} 处待核对`
    if (display.warningCount) return `${display.warningCount} 条建议`
  }
  if (display?.kind === 'qualityReport') {
    if (display.status === 'stale') return '正文有新改动'
    if (display.status === 'analyzing' || display.status === 'failed') return '复查未完成'
    const pending = display.findings.filter(finding => finding.disposition !== 'repaired' && finding.authorFeedback !== 'rejected')
    const count = pending.filter(finding => finding.severity !== 'advisory').length
    if (count) return `${count} 处待核对`
    if (pending.length) return `${pending.length} 条建议`
  }
}

function activitySummary(part: ActivityCall, runActive: boolean, titles?: ReadonlyMap<string, string>, detail = false): string {
  const presentation = getAgentToolPresentation(part.toolName)
  const action = actionNames[part.toolName] ?? presentation.label
  const title = chapterTitle(part, titles)
  const display = part.display
  const named = title ? `《${title}》` : ''
  const isWrite = part.toolName === 'chapter_write' || part.toolName === 'chapter_append'
  const review = presentation.phase === 'review'
  if (part.importWaiting && part.status === 'running' && runActive) return '等待你确认导入'
  if (part.toolName === 'ask_user' && part.status === 'running' && runActive) return '等待你回答'
  if (part.status === 'running') {
    if (!runActive) return `${action}未完成`
    if (part.preparing) return `准备${isWrite ? `写入${named}正文` : action}`
    if (isWrite) return `正在写入${named}正文`
    if (review && title) return `正在复查${named}`
    return `正在${detail ? action : presentation.label}`
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
    if (isWrite) return `已写入${named}正文 · ${display.after.length.toLocaleString('zh-CN')} 字`
    return `已保存${named}的修改`
  }
  if (isWrite) return '写入正文'
  if (review) {
    const outcome = reviewResult(part)
    if (outcome === '复查未完成' || outcome === '正文有新改动') return outcome
    const result = part.toolName === 'quality_report_get' ? '已查看复查报告' : `${detail ? action : '复查'}完成`
    return `${result}${outcome ? ` · ${outcome}` : ''}`
  }
  if (display?.kind === 'webSearch') {
    if (display.provider === 'unavailable') return '未取得网页资料'
    if (detail) return `搜索网页 · ${display.results.length} 条结果`
  }
  if (part.toolName === 'chapter_read' && title) return `已查看${named}`
  return `已${detail ? action : presentation.label}`
}

function isOpenImport(part: ActivityCall, runActive: boolean) {
  return runActive && part.toolName === 'novel_import' && part.status === 'running'
    && /^\/studio\/novel\/[^/?#]+\?/.test(part.importWaiting?.url ?? '')
}

function hasCurrentFailure(part: ActivityCall) {
  return part.status === 'failed' || part.status === 'denied'
    || reviewResult(part) === '复查未完成'
    || part.display?.kind === 'qualityReport' && part.display.status === 'failed'
    || part.display?.kind === 'webSearch' && part.display.provider === 'unavailable'
}

const ActivityDetail = memo(function ActivityDetail({ part, runActive, titles }: { part: ActivityCall; runActive: boolean; titles?: ReadonlyMap<string, string> }) {
  const navigate = useAgentStore(state => state.requestToolNavigation)
  const spotlight = useAgentStore(state => state.requestMemorySpotlight)
  const Icon = toolIcon(part)
  const display = part.display
  const chapterId = activityChapterId(part)
  const navigable = Boolean(chapterId) || display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
  const openTarget = navigable ? () => navigate(part.toolName, chapterId ? { chapterId } : part.args, display) : undefined
  const memory = part.status === 'success' ? getMemorySpotlight(part.toolName, part.args) : null
  const hasResultTarget = display?.kind === 'chapterDiff' || display?.kind === 'chapterRef' || display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
  return <li className="min-w-0 py-1" data-activity-tool={part.toolName}>
    <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-[var(--text-secondary)]">
      <Icon aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 break-words">{activitySummary(part, runActive, titles, true)}</span>
      {openTarget && !hasResultTarget ? <button type="button" onClick={openTarget} className="shrink-0 underline-offset-2 hover:underline focus-visible:underline">打开章节</button> : null}
      {memory ? <button type="button" onClick={() => spotlight(memory.type, memory.title)} className="shrink-0 underline-offset-2 hover:underline focus-visible:underline">查看设定</button> : null}
    </div>
    {display ? <div className="min-w-0 pl-[22px]">
      {display.kind === 'subagentReport'
        ? <p className="whitespace-pre-wrap break-words text-xs text-[var(--text-secondary)]">{projectAgentAuthorText(display.report)}</p>
        : <ToolDisplayRenderer display={display} onNavigateTarget={openTarget} authorActivity />}
    </div> : null}
  </li>
})

const ActivityRow = memo(function ActivityRow({ group, runActive, active, titles }: { group: ActivityGroup; runActive: boolean; active: boolean; titles?: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const latest = new Map(group.calls.map(part => [part.toolName, part]))
  // A successful retry for the same action supersedes the headline, but the
  // earlier failed receipt remains in the expanded timeline.
  const unresolved = [...latest.values()].find(hasCurrentFailure)
  const running = runActive ? [...group.calls].reverse().find(part => part.status === 'running') : undefined
  const part = running ?? unresolved ?? group.calls[group.calls.length - 1]
  const Icon = toolIcon(part)
  const importWaiting = group.calls.find(call => isOpenImport(call, runActive))
  const label = activitySummary(part, runActive, titles)
  const executing = Boolean(active && running && !importWaiting && running.toolName !== 'ask_user')

  return <div className="min-w-0" data-author-activity>
    <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}
      className="agent-activity-step inline-flex min-h-8 max-w-full items-center gap-2 px-1 text-left text-xs leading-5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:underline focus-visible:outline-none">
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        <span aria-live={active || running ? 'polite' : undefined} data-activity-running={executing || undefined}
          className={executing ? 'agent-processing-shimmer' : undefined}>{label}</span>
        <ChevronDown aria-hidden className={cn('agent-activity-chevron ml-1 inline-block h-3.5 w-3.5 align-text-bottom motion-safe:transition-[opacity,transform]', open ? 'rotate-0' : '-rotate-90')} />
      </span>
    </button>
    {importWaiting?.importWaiting ? <a className="ml-6 text-xs underline" href={importWaiting.importWaiting.url}>核对原文并确认导入</a> : null}
    <AgentProcessRegion open={open} id={detailsId}>
      <ul className="ml-2 border-l border-[var(--border-subtle)] pl-3">
        {[...group.calls, ...group.children].map(call => <ActivityDetail key={call.callId} part={call} runActive={runActive} titles={titles} />)}
      </ul>
    </AgentProcessRegion>
  </div>
})

export function AuthorActivitySummary({ timing, active, open, onToggle }: { timing: AgentRunTiming; active: boolean; open: boolean; onToggle?: () => void }) {
  const label = active || timing.elapsedMs !== null
    ? <ProcessDuration timing={timing} active={active} />
    : <span className="text-[11px] text-[var(--text-secondary)]">查看处理过程</span>
  return <div className="mb-2 border-b border-[var(--border-subtle)] pb-1.5">
    {onToggle ? <button type="button" aria-expanded={open} onClick={onToggle}
      className="inline-flex min-h-7 items-center gap-1 text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:underline focus-visible:outline-none">
      {label}
      <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 shrink-0 motion-safe:transition-transform', !open && '-rotate-90')} />
    </button> : <div className="flex min-h-7 items-center">{label}</div>}
  </div>
}

export function AuthorProgressText({ text }: { text: string }) {
  return <p className="break-words text-sm leading-7 text-[var(--text-primary)]" data-author-progress>{text}</p>
}

export function AuthorWorkingSummary({ text }: { text: string }) {
  return <p role="status" className="text-xs leading-6 text-[var(--text-secondary)]" data-author-working>
    <span className="agent-processing-shimmer">{text}</span>
  </p>
}

export const AuthorActivityParts = memo(function AuthorActivityParts({
  parts, messageId, groups, activeGroupId, runActive, processOpen, collapseText = false, workingLabel, revealText, onTextRevealed, activityChapterTitles,
}: {
  parts: AgentMessagePart[]
  messageId: string
  groups?: MessageActivityGroups
  activeGroupId?: string
  runActive: boolean
  processOpen?: boolean
  collapseText?: boolean
  workingLabel?: string
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

  return <div className="space-y-2">
    {authorParts.map((part, index) => {
      if (part.type === 'text') {
        const identity = `${messageId}:text:${textOrdinal++}`
        const text = part.text.slice(0, Math.max(0, revealed.text.length - textOffset))
        textOffset += part.text.length
        const paragraph = <AgentMarkdownText key={identity} text={text} identity={identity} />
        return processOpen !== undefined && (collapseText || index < lastToolIndex)
          ? <AgentProcessRegion key={identity} open={processOpen}>{paragraph}</AgentProcessRegion>
          : paragraph
      }
      if (part.type !== 'tool-call' || part.subagentCallId) return null
      const group = localGroups?.get(part.callId)
      if (!group || group.messageId !== messageId || group.firstCallId !== part.callId || rendered.has(group.id)) return null
      rendered.add(group.id)
      const row = <>
        {group.transition ? <AuthorProgressText text={group.transition} /> : null}
        <ActivityRow group={group} runActive={runActive} active={activeGroupId === group.id} titles={activityChapterTitles} />
      </>
      return processOpen === undefined
        ? <div key={group.id}>{row}</div>
        : <AgentProcessRegion key={group.id} open={processOpen}>{row}</AgentProcessRegion>
    })}
    {workingLabel ? <AuthorWorkingSummary text={workingLabel} /> : null}
  </div>
})
