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
  childrenByCall: Map<string, ActivityCall[]>
  readLabel?: string
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
    return `已完成《${display.title}》的更新。`
  }
  if (display?.kind === 'chapterDiff' && (display.appliedDirectly || part.accepted) && display.before !== display.after) {
    return part.toolName === 'chapter_write' || part.toolName === 'chapter_append'
      ? `已写入《${display.chapterTitle}》的正文。` : `已完成《${display.chapterTitle}》的修改。`
  }
}

export function activityWorkingLabel(part: ActivityCall | undefined) {
  if (!part) return '正在思考'
  if (part.status === 'failed' || part.status === 'denied') return '核对刚才未完成的步骤'
  if (part.toolName === 'plan_save') return '核对计划保存结果'
  const { phase, label } = getAgentToolPresentation(part.toolName)
  if (phase === 'read') return '梳理刚查到的资料'
  if (phase === 'write' || phase === 'revise') return '核对刚处理的章节'
  if (phase === 'review') return label.endsWith('复查') ? `整理${label}结果` : '整理复查结果'
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

export function activityTarget(part: ActivityCall): string | undefined {
  const chapterId = activityChapterId(part)
  if (chapterId) return `chapter:${chapterId}`
  const display = part.display
  if (display && 'artifactId' in display) return `artifact:${display.artifactId}`
  if (part.toolName === 'subagent_run' || part.toolName === 'subagent_delegate' || part.toolName === 'ask_user') return part.callId
  const args = part.args as { planId?: unknown; volumeId?: unknown } | null
  if (typeof args?.planId === 'string') return `artifact:${args.planId}`
  if (typeof args?.volumeId === 'string') return `volume:${args.volumeId}`
}

const activityFamilies = new Map([
  ['cover_prompt_set', 'cover'], ['cover_generate', 'cover'],
  ['chapter_write', 'chapter-body'], ['chapter_append', 'chapter-body'],
])
const creationReadLabels = new Set(['核对前文', '查看创作设定', '查看创作资料', '查看作品结构'])

function canGroup(current: ActivityGroup, next: ActivityCall, afterText: boolean): boolean {
  const first = current.calls[0]
  const family = activityFamilies.get(first.toolName)
  if (afterText) return family === 'cover' && first.toolName === 'cover_prompt_set' && next.toolName === 'cover_generate'
  if (family === 'chapter-body') {
    const chapterId = activityChapterId(next)
    return activityFamilies.get(next.toolName) === family && chapterId !== undefined && chapterId === activityChapterId(first)
  }
  if (creationReadLabels.has(getAgentToolPresentation(first.toolName).label)
    && creationReadLabels.has(getAgentToolPresentation(next.toolName).label)) return true
  return first.toolName === next.toolName || family !== undefined && family === activityFamilies.get(next.toolName)
}

/** Only presentation is grouped. Individual tool receipts retain their identity
 * and order, even when a preview is upgraded or a result is replayed. */
export function projectActivityGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts'>[]) {
  const byMessage = new Map<string, Map<string, ActivityGroup>>()
  const runningByRun = new Map<string, ActivityGroup>()
  const openingByRun = new Map<string, string | null>()
  const savedReplyByRun = new Map<string, string>()
  const lastCallByRun = new Map<string, ActivityCall>()
  const lastGroupByRun = new Map<string, ActivityGroup>()
  const groups: ActivityGroup[] = []
  const seen = new Map<string, { group?: ActivityGroup; calls: ActivityCall[]; index: number }>()
  const branches = new Map<string, ActivityCall[]>()
  const transcript = messages.map(message => ({
    message,
    scope: JSON.stringify([message.runId, message.goalId ?? null]),
    parts: message.role === 'assistant'
      ? projectAgentAuthorParts(message.parts.filter(part => part.type !== 'reasoning'), false, { includePreparing: true })
      : [],
  }))
  const callIdentity = (scope: string, part: ActivityCall) => JSON.stringify([scope, part.subagentCallId ?? null, part.callId])
  // Parameter deltas can describe several proposed calls in the same provider
  // turn. Only call/result events establish which operations have started.
  const reportedCalls = new Map<string, { scope: string; status: ActivityCall['status'] }>()
  for (const { scope, parts } of transcript) {
    for (const part of parts) {
      if (part.type !== 'tool-call' || part.preparing) continue
      const id = callIdentity(scope, part)
      if (part.status !== 'running' || !reportedCalls.has(id)) reportedCalls.set(id, { scope, status: part.status })
    }
  }
  const executingScopes = new Set([...reportedCalls.values()].filter(call => call.status === 'running').map(call => call.scope))
  const displayedPreparations = new Set<string>()
  let current: ActivityGroup | undefined
  let previousScope: string | undefined
  let publicTextSinceAction = false
  const announcedMilestones = new Set<string>()

  for (const { message, scope, parts } of transcript) {
    if (message.role !== 'assistant' || scope !== previousScope) {
      current = undefined
      publicTextSinceAction = false
      announcedMilestones.clear()
    }
    previousScope = scope
    if (message.role !== 'assistant') continue

    const messageGroups = new Map<string, ActivityGroup>()
    byMessage.set(message.id, messageGroups)
    for (const part of parts) {
      if (part.type !== 'tool-call') {
        if (part.type === 'text') {
          publicTextSinceAction = true
          if (!openingByRun.has(message.runId)) openingByRun.set(message.runId, null)
        }
        continue
      }
      const identity = callIdentity(scope, part)
      if (part.preparing) {
        if (part.subagentCallId || reportedCalls.has(identity) || executingScopes.has(scope) || displayedPreparations.has(scope)) continue
        displayedPreparations.add(scope)
      }
      const prior = seen.get(identity)
      if (prior) {
        const original = prior.calls[prior.index]
        if (original.status === 'running' || part.status !== 'running') prior.calls[prior.index] = part
        if (prior.group) messageGroups.set(part.callId, prior.group)
        continue
      }
      if (part.subagentCallId) {
        const parentKey = JSON.stringify([scope, null, part.subagentCallId])
        const calls = branches.get(parentKey) ?? []
        branches.set(parentKey, calls)
        seen.set(identity, { calls, index: calls.length })
        calls.push(part)
        continue
      }

      const { phase } = getAgentToolPresentation(part.toolName)
      const milestone = milestones[part.toolName === 'chapter_append' ? 'chapter_write' : part.toolName]
      const opening = !openingByRun.has(message.runId)
      if (opening) openingByRun.set(message.runId, phase === 'read' ? readOpening : milestone ?? activityOpening)
      if (!current || !canGroup(current, part, publicTextSinceAction)) {
        current = { id: JSON.stringify([message.id, part.callId]), runId: message.runId, messageId: message.id, firstCallId: part.callId, calls: [], childrenByCall: new Map() }
        if (!opening && !publicTextSinceAction && milestone && !announcedMilestones.has(milestone)) current.transition = milestone
        if (milestone) announcedMilestones.add(milestone)
        groups.push(current)
      }
      publicTextSinceAction = false
      const group = current
      const first = group.calls[0]
      if (first && phase === 'read' && getAgentToolPresentation(first.toolName).label !== getAgentToolPresentation(part.toolName).label) {
        group.readLabel = '查看创作资料'
      }
      if (part.toolName === 'subagent_run' || part.toolName === 'subagent_delegate') {
        const calls = branches.get(identity) ?? []
        group.childrenByCall.set(part.callId, calls)
        branches.set(identity, calls)
      }
      seen.set(identity, { group, calls: group.calls, index: group.calls.length })
      group.calls.push(part)
      messageGroups.set(part.callId, group)
    }
  }
  for (const group of groups) {
    lastGroupByRun.set(group.runId, group)
    if (group.calls.some(part => part.status === 'running')) runningByRun.set(group.runId, group)
    for (const part of group.calls) {
      lastCallByRun.set(group.runId, part)
      const reply = savedReply(part)
      if (reply) savedReplyByRun.set(group.runId, reply)
    }
  }
  return { byMessage, runningByRun, openingByRun, savedReplyByRun, lastCallByRun, lastGroupByRun }
}
