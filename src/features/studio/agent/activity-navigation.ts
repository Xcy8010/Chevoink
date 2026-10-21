import type { AgentMessagePart } from '../../../../shared/contracts/index.js'
import type { WorkspaceActivity } from './agentStore'
import { getToolTargetTitle } from './tool-argument-view'
import { qualityAppliedBodyChange } from '../../../../shared/agent-applied-body-change.js'

type ToolPart = Extract<AgentMessagePart, { type: 'tool-call' }>

/** Resolve only persisted tool targets; never guess a document ID from its title. */
export function resolveActivityNavigation(activity: WorkspaceActivity, part?: ToolPart) {
  if (activity.status !== 'done' || (part && (part.status !== 'success' || part.toolName !== activity.toolName))) return null
  const args = part?.args && typeof part.args === 'object' && !Array.isArray(part.args)
    ? part.args as Record<string, unknown> : {}
  const display = activity.display ?? part?.display
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const toolName = activity.toolName
  if (['memory_save', 'memory_event_save', 'memory_relation_save'].includes(toolName)) {
    const relationTitle = toolName === 'memory_relation_save' && text(args.fromName) && text(args.toName) && text(args.relationType)
      ? `${text(args.fromName)}→${text(args.toName)}:${text(args.relationType)}` : ''
    // Legacy history may retain only the summary. The memory panel still requires
    // one exact match in this novel and refuses ambiguous/deleted targets.
    const legacyTitle = /^(?:沉淀记忆|记忆冲突|记忆候选|事件候选|关系候选)「([^「」]+)」/.exec(activity.summary ?? '')?.[1]
    const title = relationTitle || text(args.title) || legacyTitle
    if (!title) return null
    const memoryType = toolName === 'memory_event_save' ? 'timelineEvent'
      : toolName === 'memory_relation_save' ? 'relationshipState' : text(args.memoryType)
    return { kind: 'memory' as const, title, memoryType }
  }
  // A deletion record is not an extant document to open.
  if (toolName.endsWith('_delete') || display?.kind === 'planDelete') return null
  const applied = qualityAppliedBodyChange(display)
  const title = applied?.chapterTitle || getToolTargetTitle(display, args)
  if (!title) return null
  const chapterId = display?.kind === 'chapterDiff' || display?.kind === 'chapterRef'
    ? display.chapterId : applied?.chapterId ?? (toolName.startsWith('chapter_') ? activity.chapterId || text(args.chapterId) : null)
  const planId = display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename'
    ? display.artifactId : toolName.startsWith('plan_') ? text(args.planId) : null
  if (!chapterId && !planId) return null
  return { kind: 'document' as const, title, toolName, display, args: chapterId ? { chapterId } : { planId } }
}
