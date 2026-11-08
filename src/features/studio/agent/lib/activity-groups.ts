import { projectAgentAuthorParts } from '../../../../../shared/agent-author-view.js'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation.js'
import type { AgentMessagePart, AgentUIMessage } from '../../../../../shared/contracts/index.js'

export type ActivityCall = Extract<AgentMessagePart, { type: 'tool-call' }>

export type ActivityGroup = {
  id: string
  runId: string
  messageId: string
  firstCallId: string
  calls: ActivityCall[]
  children: ActivityCall[]
}

export type MessageActivityGroups = ReadonlyMap<string, ActivityGroup>

export function activityChapterId(part: ActivityCall): string | undefined {
  const display = part.display
  if (display && 'chapterId' in display) return display.chapterId
  const args = part.args as { chapterId?: unknown; chapter_id?: unknown } | null
  const id = args?.chapterId ?? args?.chapter_id
  return typeof id === 'string' ? id : undefined
}

function activityTarget(part: ActivityCall): string | undefined {
  const chapterId = activityChapterId(part)
  if (chapterId) return `chapter:${chapterId}`
  const display = part.display
  if (display && 'artifactId' in display) return `artifact:${display.artifactId}`
  if (part.toolName === 'subagent_run' || part.toolName === 'subagent_delegate' || part.toolName === 'ask_user') return part.callId
  const args = part.args as { planId?: unknown; volumeId?: unknown } | null
  if (typeof args?.planId === 'string') return `artifact:${args.planId}`
  if (typeof args?.volumeId === 'string') return `volume:${args.volumeId}`
}

/** Only presentation is grouped. Individual tool receipts retain their identity
 * and order, even when a preview is upgraded or a result is replayed. */
export function projectActivityGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts'>[]) {
  const byMessage = new Map<string, Map<string, ActivityGroup>>()
  const runningByRun = new Map<string, ActivityGroup>()
  const groups: ActivityGroup[] = []
  const seen = new Map<string, { group?: ActivityGroup; calls: ActivityCall[]; index: number }>()
  const branches = new Map<string, ActivityCall[]>()
  let current: { label: string; target?: string; group: ActivityGroup } | undefined
  let previousScope: string | undefined

  for (const message of messages) {
    const scope = JSON.stringify([message.runId, message.goalId ?? null])
    if (message.role !== 'assistant' || scope !== previousScope) current = undefined
    previousScope = scope
    if (message.role !== 'assistant') continue

    const messageGroups = new Map<string, ActivityGroup>()
    byMessage.set(message.id, messageGroups)
    const parts = projectAgentAuthorParts(message.parts.filter(part => part.type !== 'reasoning'), false, { includePreparing: true })
    for (const part of parts) {
      if (part.type !== 'tool-call') {
        if (part.type === 'text') current = undefined
        continue
      }
      const identity = JSON.stringify([scope, part.subagentCallId ?? null, part.callId])
      const prior = seen.get(identity)
      if (prior) {
        const original = prior.calls[prior.index]
        if (original.status === 'running' || part.status !== 'running') prior.calls[prior.index] = part
        if (prior.group) messageGroups.set(part.callId, prior.group)
        continue
      }
      if (part.subagentCallId) {
        const parentKey = JSON.stringify([scope, part.subagentCallId])
        const calls = branches.get(parentKey) ?? []
        branches.set(parentKey, calls)
        seen.set(identity, { calls, index: calls.length })
        calls.push(part)
        continue
      }

      const label = getAgentToolPresentation(part.toolName).label
      const target = activityTarget(part)
      // Rereading the affected chapter to recover a failed edit is part of
      // that activity. A different target or an author-visible paragraph ends it.
      const lastAction = part.toolName === 'chapter_read' && target && target === current?.target && current.label !== label
        ? [...current.group.calls].reverse().find(call => call.toolName !== 'chapter_read') : undefined
      const recoveryRead = lastAction?.status === 'failed'
        && (lastAction.toolName === 'chapter_edit_range' || lastAction.toolName === 'continuity_validate')
      if (!current || (!recoveryRead && current.label !== label) || (target && current.target && target !== current.target)) {
        const group: ActivityGroup = { id: JSON.stringify([message.id, part.callId]), runId: message.runId, messageId: message.id, firstCallId: part.callId, calls: [], children: [] }
        current = { label, target, group }
        groups.push(group)
        if (part.toolName === 'subagent_run' || part.toolName === 'subagent_delegate') {
          const parentKey = JSON.stringify([scope, part.callId])
          group.children = branches.get(parentKey) ?? []
          branches.set(parentKey, group.children)
        }
      }
      current.target ??= target
      const group = current.group
      seen.set(identity, { group, calls: group.calls, index: group.calls.length })
      group.calls.push(part)
      messageGroups.set(part.callId, group)
    }
  }
  for (const group of groups) {
    if (group.calls.some(part => part.status === 'running')) runningByRun.set(group.runId, group)
  }
  return { byMessage, runningByRun }
}
