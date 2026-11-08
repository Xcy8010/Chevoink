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
  transition?: string
}

export const activityOpening = '我会先梳理这次的要求。'

const readOpening = '我会先核对与这次任务有关的资料。'
const milestones: Record<string, string> = {
  plan_save: '接下来整理创作计划，把关键情节和前后的衔接理清。',
  chapter_write: '接下来处理正文，让这一章接上已有情节。',
  chapter_edit_range: '接下来集中处理需要修改的地方。',
  continuity_validate: '接下来核对这一章和前文的衔接。',
  quality_analyze: '接下来看看这一章的表达是否贴合人物和情境。',
}

/** These are presentation receipts, separate from the assistant's reply and
 * from the run's completion status. Never infer saving from a tool's title. */
function savedReply(part: ActivityCall) {
  if (part.status !== 'success') return undefined
  const display = part.display
  if (part.toolName === 'plan_save' && (display?.kind === 'planFile' || display?.kind === 'planDiff')) {
    return `已将《${display.title}》保存到计划。`
  }
  if (display?.kind === 'chapterDiff' && (display.appliedDirectly || part.accepted) && display.before !== display.after) {
    return part.toolName === 'chapter_write' || part.toolName === 'chapter_append'
      ? `已写入《${display.chapterTitle}》的正文。` : `已保存《${display.chapterTitle}》的修改。`
  }
}

export function activityWorkingLabel(part: ActivityCall | undefined) {
  if (!part) return '梳理这次的创作要求'
  if (part.status === 'failed' || part.status === 'denied') return '核对刚才未完成的步骤'
  if (part.toolName === 'plan_save') return '核对计划保存结果'
  const { phase } = getAgentToolPresentation(part.toolName)
  if (phase === 'read') return '梳理刚查到的资料'
  if (phase === 'write' || phase === 'revise') return '核对刚处理的章节'
  if (phase === 'review') return '整理复查结果'
  return '整理这一步的结果'
}

export function activityAnswerText(parts: readonly AgentMessagePart[]) {
  const visible = projectAgentAuthorParts(parts)
  const lastTool = visible.reduce((last, part, index) => part.type === 'tool-call' ? index : last, -1)
  return visible.slice(lastTool + 1).flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n').trim()
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
  const openingByRun = new Map<string, string | null>()
  const savedReplyByRun = new Map<string, string>()
  const lastCallByRun = new Map<string, ActivityCall>()
  const groups: ActivityGroup[] = []
  const seen = new Map<string, { group?: ActivityGroup; calls: ActivityCall[]; index: number }>()
  const branches = new Map<string, ActivityCall[]>()
  let current: { label: string; target?: string; group: ActivityGroup } | undefined
  let previousScope: string | undefined
  let publicTextSinceAction = false
  const announcedMilestones = new Set<string>()

  for (const message of messages) {
    const scope = JSON.stringify([message.runId, message.goalId ?? null])
    if (message.role !== 'assistant' || scope !== previousScope) {
      current = undefined
      publicTextSinceAction = false
      announcedMilestones.clear()
    }
    previousScope = scope
    if (message.role !== 'assistant') continue

    const messageGroups = new Map<string, ActivityGroup>()
    byMessage.set(message.id, messageGroups)
    const parts = projectAgentAuthorParts(message.parts.filter(part => part.type !== 'reasoning'), false, { includePreparing: true })
    for (const part of parts) {
      if (part.type !== 'tool-call') {
        if (part.type === 'text') {
          current = undefined
          publicTextSinceAction = true
          if (!openingByRun.has(message.runId)) openingByRun.set(message.runId, null)
        }
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

      const { label, phase } = getAgentToolPresentation(part.toolName)
      const milestone = milestones[part.toolName === 'chapter_append' ? 'chapter_write' : part.toolName]
      const opening = !openingByRun.has(message.runId)
      if (opening) openingByRun.set(message.runId, phase === 'read' ? readOpening : milestone ?? activityOpening)
      const target = activityTarget(part)
      // Rereading the affected chapter to recover a failed edit is part of
      // that activity. A different target or an author-visible paragraph ends it.
      const lastAction = part.toolName === 'chapter_read' && target && target === current?.target && current.label !== label
        ? [...current.group.calls].reverse().find(call => call.toolName !== 'chapter_read') : undefined
      const recoveryRead = lastAction?.status === 'failed'
        && (lastAction.toolName === 'chapter_edit_range' || lastAction.toolName === 'continuity_validate')
      if (!current || (!recoveryRead && current.label !== label) || (target && current.target && target !== current.target)) {
        const group: ActivityGroup = { id: JSON.stringify([message.id, part.callId]), runId: message.runId, messageId: message.id, firstCallId: part.callId, calls: [], children: [] }
        if (!opening && !publicTextSinceAction && milestone && !announcedMilestones.has(milestone)) group.transition = milestone
        if (milestone) announcedMilestones.add(milestone)
        publicTextSinceAction = false
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
    for (const part of group.calls) {
      lastCallByRun.set(group.runId, part)
      const reply = savedReply(part)
      if (reply) savedReplyByRun.set(group.runId, reply)
    }
  }
  return { byMessage, runningByRun, openingByRun, savedReplyByRun, lastCallByRun }
}
