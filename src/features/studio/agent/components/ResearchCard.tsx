import { memo, useId, useState } from 'react'
import { BookOpenText, ChevronDown, FileText, LoaderCircle, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { projectAgentToolSummary } from '../../../../../shared/agent-author-view.js'
import { AgentProcessRegion } from './AgentProcessRegion'
import { AgentMarkdownText } from './AgentMarkdownText'
import { researchCallTarget, researchCallUnavailable, summarizeResearchGroup, type ResearchCall, type ResearchGroup } from '../lib/research-groups'
import './research-card.css'

function ResearchResult({ call, runActive }: { call: ResearchCall; runActive: boolean }) {
  // Availability belongs to the aggregate. Failed provider payloads are not source content.
  if (researchCallUnavailable(call)) return null
  const display = call.display
  const target = researchCallTarget(call)
  return <section data-agent-call-id={call.callId} data-agent-tool-phase={call.preparing ? 'preparing' : call.status}
    className="border-t border-[var(--border-subtle)] py-2 first:border-0">
    <div className="flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-secondary)]">
      {call.toolName === 'web_search' ? <Search className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={target}>{target || (call.toolName === 'web_search' ? '搜索资料' : '读取参考资料')}</span>
      {call.status === 'running' ? <span className="shrink-0">{runActive ? call.preparing ? '准备中…' : '获取中…' : '结果待确认'}</span> : null}
    </div>
    {call.status === 'success' && display?.kind === 'webSearch' ? display.results.length ? <ul className="mt-1 space-y-1">
      {display.results.map((result, index) => <li key={`${result.url}:${index}`}>
        <a href={result.url} target="_blank" rel="noopener noreferrer"
          className="block rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
          <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 break-words text-xs text-[var(--text-primary)]">{result.title}</span><span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{result.source}</span></span>
          {result.snippet ? <span className="mt-0.5 block break-words text-[11px] leading-5 text-[var(--text-secondary)]">{result.snippet}</span> : null}
        </a>
      </li>)}
    </ul> : <p className="mt-1 pl-5 text-[11px] text-[var(--text-tertiary)]">未找到结果</p> : null}
    {call.status === 'success' && display?.kind === 'markdown' && display.markdown.trim() ? <details className="mt-1 pl-5">
      <summary className="cursor-pointer text-[11px] text-[var(--text-secondary)]">查看资料内容</summary>
      <div className="mt-1 max-h-80 overflow-y-auto break-words text-xs leading-6 text-[var(--text-primary)]"><AgentMarkdownText text={display.markdown} identity={`research:${call.callId}`} /></div>
    </details> : null}
    {call.status === 'success' && !display ? <p className="mt-1 pl-5 text-[11px] leading-5 text-[var(--text-secondary)]">
      {call.summary ? projectAgentToolSummary(call.summary, call.status) || '暂无可展示的参考内容' : '暂无可展示的参考内容'}
    </p> : null}
  </section>
}

export const ResearchCard = memo(function ResearchCard({ group, runActive, animate = false }: { group: ResearchGroup; runActive: boolean; animate?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const view = summarizeResearchGroup(group.calls, runActive)
  return <div data-agent-research-id={group.id} data-agent-research-phase={view.status}
    className={cn('agent-research-card relative overflow-hidden border-b border-[var(--border-subtle)]', view.running && 'agent-tool-running')}>
    <button type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}
      className="group flex w-full items-start gap-2 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
      {view.running ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-secondary)] motion-reduce:animate-none" />
        : <BookOpenText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-[var(--text-primary)]">查看参考资料</span>
        <span className="mt-0.5 block min-h-5 overflow-hidden text-[11px] leading-5 text-[var(--text-secondary)]" aria-live="polite" aria-atomic="true">
          <span key={`${view.current?.callId}:${view.status}:${view.summary}`} className={cn('block truncate', animate && 'agent-research-update')} title={view.summary}>{view.summary}</span>
        </span>
        {!view.running ? <span className="block text-[10px] leading-4 text-[var(--text-tertiary)]">{view.outcome}{view.hasEvidence && view.unavailable ? ` · ${view.unavailable} 项资料未能获取` : ''}</span> : null}
      </span>
      <ChevronDown className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)] transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
    </button>
    <AgentProcessRegion open={expanded} id={bodyId}>
      <div className="max-h-96 overflow-y-auto border-t border-[var(--border-subtle)] pl-[22px] pr-1">
        {group.calls.map(call => <ResearchResult key={call.callId} call={call} runActive={runActive} />)}
        {view.unavailable ? <p className="py-2 text-[11px] leading-5 text-[var(--text-secondary)]">{view.hasEvidence || view.running ? `${view.unavailable} 项资料未能获取` : '本次未取得参考资料'}</p> : null}
      </div>
    </AgentProcessRegion>
    {view.running ? <span aria-hidden className="agent-tool-progress pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[var(--text-secondary)]/55" /> : null}
  </div>
})
