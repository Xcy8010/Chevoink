import { useMemo, useState, type ReactNode } from 'react'
import { BookCopy, Brain, ChevronDown, ChevronRight, FileText, FolderTree, GitCompareArrows, Network, Wrench } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import { useAgentStore, type WorkspaceActivity } from '../agent/agentStore'
import { resolveActivityNavigation } from '../agent/activity-navigation'
import { workspaceActivityDelta, workspaceGroupDelta } from '../agent/workspace-body-changes'
import type { ProjectNotesState, WorkspacePlanFile } from '../types'

export type WorkInspectorTab = 'work' | 'context' | 'changes' | 'memory' | 'skills'

type Props = {
  tab: WorkInspectorTab
  onTabChange: (tab: WorkInspectorTab) => void
  workTree: ReactNode
  novelTitle: string
  volumeTitle?: string | null
  chapterTitle: string
  chapterCount: number
  wordCount: string
  pendingReviewCount: number
  activeArtifactTitle?: string | null
  selectedTextLength?: number
  activities?: WorkspaceActivity[]
  memoryGraph?: ReactNode
  skillsPanel?: ReactNode
  contextPanel: ReactNode
  compactNavigation?: boolean
  showNavigation?: boolean
  volumes?: StudioPayload['volumes']
  chapters?: StudioPayload['chapters']
  plans?: WorkspacePlanFile[]
  projectNotes?: ProjectNotesState | null
  activeTaskTitle?: string | null
  taskCount?: number
}

function Delta({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null

  return (
    <span className="flex shrink-0 gap-1.5 text-[10px] tabular-nums">
      {added > 0 ? <span className="text-emerald-600">+{added}</span> : null}
      {removed > 0 ? <span className="text-rose-500">-{removed}</span> : null}
    </span>
  )
}

function ChangesTree({ activities, pendingReviewCount }: { activities: WorkspaceActivity[]; pendingReviewCount: number }) {
  const [expandedCalls, setExpandedCalls] = useState<Set<string>>(() => new Set())
  const messages = useAgentStore((state) => state.messages)
  const requestToolNavigation = useAgentStore((state) => state.requestToolNavigation)
  const requestMemorySpotlight = useAgentStore((state) => state.requestMemorySpotlight)
  const toolParts = useMemo(() => new Map(messages.flatMap((message) => message.parts
    .filter((part) => part.type === 'tool-call').map((part) => [part.callId, part] as const))), [messages])
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: WorkspaceActivity[] }>()
    for (const activity of activities) {
      const key = activity.chapterId ?? `tool:${activity.label}`
      const current = map.get(key) ?? { label: activity.label, items: [] }
      current.items.push(activity)
      map.set(key, current)
    }
    return Array.from(map.entries())
  }, [activities])

  if (activities.length === 0) return <div className="px-4 py-5"><p className="text-sm text-[var(--text-primary)]">没有工作区变更</p><p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">Agent 的写入、结构和计划操作会按目标形成变更树。</p></div>

  return <div className="h-full overflow-y-auto px-3 py-4">
    <div className="mb-3 flex items-center gap-2 px-2 text-sm text-[var(--text-primary)]"><GitCompareArrows className="h-4 w-4" /><span>{activities.length} 项变更</span>{pendingReviewCount > 0 ? <span className="text-[10px] text-amber-500">{pendingReviewCount} 项待审</span> : null}</div>
    <div className="space-y-1">
      {groups.map(([key, group]) => {
        const totals = workspaceGroupDelta(group.items)
        return <details key={key} open className="group overflow-hidden rounded-[9px] border border-[var(--border-subtle)] bg-[var(--surface-default)]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"><ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /><FolderTree className="h-3.5 w-3.5 text-[var(--text-secondary)]" /><span className="min-w-0 flex-1 truncate">{group.label}</span><Delta {...totals} /></summary>
          <div className="border-t border-[var(--border-subtle)]">
            {group.items.map((activity) => {
              const delta = workspaceActivityDelta(activity)
              const open = expandedCalls.has(activity.callId)
              const target = resolveActivityNavigation(activity, toolParts.get(activity.callId))
              const summary = activity.summary || activity.label
              const titleOffset = target ? summary.indexOf(target.title) : -1
              const targetLink = target ? <button type="button"
                aria-label={`查看${target.kind === 'memory' ? '记忆' : '文档'}：${target.title}`}
                className="inline-flex min-h-8 items-center rounded-sm text-left text-[var(--text-primary)] underline decoration-current underline-offset-4 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                onClick={() => {
                  if (target.kind === 'memory') requestMemorySpotlight(target.memoryType, target.title)
                  else requestToolNavigation(target.toolName, target.args, target.display)
                }}>{target.title}</button> : null
              const linkedSummary = target && titleOffset >= 0
                ? <>{summary.slice(0, titleOffset)}{targetLink}{summary.slice(titleOffset + target.title.length)}</>
                : <>{summary}{targetLink ? <><br />{targetLink}</> : null}</>
              return <div key={activity.callId} className="border-b border-[var(--border-subtle)] last:border-b-0">
                <button type="button" onClick={() => setExpandedCalls((current) => { const next = new Set(current); if (next.has(activity.callId)) next.delete(activity.callId); else next.add(activity.callId); return next })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] hover:bg-[var(--surface-muted)]"><FileText className="h-3.5 w-3.5 text-[var(--text-tertiary)]" /><span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{activity.toolName}</span><Delta {...delta} /><span className={cn('text-[10px]', activity.status === 'failed' ? 'text-rose-500' : activity.accepted ? 'text-emerald-600' : 'text-[var(--text-tertiary)]')}>{activity.status === 'running' ? '执行中' : activity.status === 'failed' ? '失败' : activity.accepted ? '已接受' : '已完成'}</span>{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
                {open ? <div className="bg-[var(--surface-muted)]/45 px-4 py-2 text-[10px] leading-5 text-[var(--text-secondary)]"><p className="break-words">{linkedSummary}</p>{typeof activity.before === 'string' && typeof activity.after === 'string' ? <div className="mt-2 grid gap-2"><div className="rounded-[6px] border border-rose-500/20 bg-rose-500/5 p-2"><p className="mb-1 font-medium text-rose-500">修改前</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap font-sans">{activity.before || '（空）'}</pre></div><div className="rounded-[6px] border border-emerald-500/20 bg-emerald-500/5 p-2"><p className="mb-1 font-medium text-emerald-600">修改后</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap font-sans">{activity.after || '（空）'}</pre></div></div> : null}<p className="mt-2 font-mono text-[var(--text-tertiary)]">call {activity.callId}</p></div> : null}
              </div>
            })}
          </div>
        </details>
      })}
    </div>
  </div>
}

export default function WorkInspector({ tab, onTabChange, workTree, pendingReviewCount, activities = [], memoryGraph, skillsPanel, contextPanel, compactNavigation = false, showNavigation = true }: Props) {
  const tabs = [{ key: 'work' as const, label: '作品', icon: BookCopy }, { key: 'context' as const, label: '记忆', icon: Brain }, { key: 'changes' as const, label: '变更', icon: GitCompareArrows }, { key: 'memory' as const, label: '关系网', icon: Network }, { key: 'skills' as const, label: '技能', icon: Wrench }]
  return <div className="flex h-full min-h-0 flex-col">
    {showNavigation ? <div className="work-inspector-nav flex h-11 shrink-0 items-end border-b border-[var(--border-subtle)] pl-10 pr-1">{tabs.map(({ key, label, icon: Icon }) => <button key={key} type="button" title={label} aria-label={label} onClick={() => onTabChange(key)} className={cn('flex h-10 min-w-0 flex-1 items-center justify-center gap-1 border-b-2 px-1 text-[10px] transition', tab === key ? 'border-[var(--text-primary)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-primary)]')}><Icon className="h-3.5 w-3.5 shrink-0" /><span className={cn(compactNavigation && 'sr-only')}>{label}</span></button>)}</div> : null}
    <div className="min-h-0 flex-1 overflow-hidden">
      {tab === 'work' ? workTree : null}
      {tab === 'context' ? contextPanel : null}
      {tab === 'changes' ? <ChangesTree activities={activities} pendingReviewCount={pendingReviewCount} /> : null}
      {tab === 'memory' ? <div className="h-full min-h-0 overflow-hidden">{memoryGraph}</div> : null}
      {tab === 'skills' ? <div className="h-full min-h-0 overflow-hidden">{skillsPanel}</div> : null}
    </div>
  </div>
}
