import { projectAgentAuthorParts } from '../../../../../shared/agent-author-view.js'
import { activityAttemptKey, activityReviewVersion } from '../../../../../shared/agent-activity-receipts.js'
import { getAgentToolPresentation, sameAgentToolStage } from '../../../../../shared/agent-tool-presentation.js'
import type { AgentMessagePart, AgentUIMessage } from '../../../../../shared/contracts/index.js'

export type ActivityCall = Extract<AgentMessagePart, { type: 'tool-call' }>

export type ActivityGroup = {
  id: string
  runId: string
  messageId: string
  firstCallId: string
  calls: ActivityCall[]
  callKeys: string[]
  childrenByCall: Map<string, ActivityCall[]>
  readLabel?: string
  title?: string
  closed?: boolean
  completed?: boolean
  unfinished?: boolean
  unsettled?: ActivityCall
  staleReviewCalls?: Set<ActivityCall>
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
  if (part.status === 'failed' || part.status === 'denied') return '正在处理…'
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

export function activityReviewProblem(part: ActivityCall): 'stale' | 'incomplete' | undefined {
  if (part.reviewOutcome === 'stale') return 'stale'
  if (part.reviewOutcome === 'provider_unresolved' || part.reviewOutcome === 'provider_failed' || part.reviewOutcome === 'evidence_repair_required') return 'incomplete'
  if (part.display?.kind === 'qualityReport') {
    if (part.display.status === 'stale') return 'stale'
    if (part.display.status === 'analyzing' || part.display.status === 'failed') return 'incomplete'
  }
}

function hasActivityFailure(part: ActivityCall) {
  return part.status === 'failed' || part.status === 'denied'
    || activityReviewProblem(part) === 'incomplete'
    || part.display?.kind === 'webSearch' && part.display.provider === 'unavailable'
}

function observedChapterVersion(part: ActivityCall) {
  const display = part.display
  if (part.status === 'success' && display && (display.kind === 'chapterRef' || display.kind === 'chapterDiff' && (display.appliedDirectly || part.accepted)) && display.revision !== undefined) {
    return { chapterId: display.chapterId, revision: display.revision }
  }
  if (part.status === 'success' && display?.kind === 'qualityReport' && display.appliedBodyChange) {
    const { chapterId, targetRevision } = display.appliedBodyChange
    return { chapterId, revision: targetRevision }
  }
  return activityReviewVersion(part)
}

function findUnsettledCall(calls: ActivityCall[], stale: ReadonlySet<ActivityCall>) {
  // Concurrent attempts have their own receipts. An already settled sibling
  // cannot substitute for a call that is still executing.
  const running = calls.find(part => !part.preparing && part.status === 'running')
  if (running) return running
  const incomplete = (part: ActivityCall) => hasActivityFailure(part) || stale.has(part)
    || part.display?.kind === 'question' && (part.display.unanswered || part.display.cancelled)
  if (!calls.some(part => !part.preparing && incomplete(part))) return undefined

  const successes = new Map<string, ActivityCall>()
  for (let index = calls.length - 1; index >= 0; index--) {
    const part = calls[index]
    if (part.preparing) continue
    const key = activityAttemptKey(part)
    if (!incomplete(part)) {
      if (key && !successes.has(key)) successes.set(key, part)
      continue
    }
    const retry = key ? successes.get(key) : undefined
    if (!retry || part.reviewOutcome === 'provider_unresolved') return part
    const version = activityReviewVersion(part)
    const retryVersion = activityReviewVersion(retry)
    if (version && (!retryVersion || retryVersion.chapterId !== version.chapterId || retryVersion.revision < version.revision)) return part
  }
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
export function projectActivityGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts' | 'runTiming' | 'completedAt' | 'goalContinuation'>[]) {
  const byMessage = new Map<string, Map<string, ActivityGroup>>()
  const runningByRun = new Map<string, ActivityGroup>()
  const activeByRun = new Map<string, ActivityGroup>()
  const authorSpokeByRun = new Set<string>()
  const savedReplyByRun = new Map<string, string>()
  const lastCallByRun = new Map<string, ActivityCall>()
  const lastGroupByRun = new Map<string, ActivityGroup>()
  const groups: Array<{ group: ActivityGroup; scope: string }> = []
  const seen = new Map<string, { group?: ActivityGroup; calls: ActivityCall[]; index: number }>()
  const branches = new Map<string, ActivityCall[]>()
  const transcript = messages.map(message => ({
    message,
    scope: JSON.stringify([message.runTiming?.scopeId ?? message.runId, message.goalId ?? null]),
    parts: message.role === 'assistant'
      ? projectAgentAuthorParts(message.parts.filter(part => part.type !== 'reasoning'), false, { includePreparing: true })
      : [],
  }))
  const callIdentity = (scope: string, messageId: string, part: ActivityCall) => JSON.stringify([scope, messageId, part.subagentCallId ?? null, part.callId])
  // Parameter deltas can describe several proposed calls in the same provider
  // turn. Only call/result events establish which operations have started.
  const reportedCalls = new Map<string, { scope: string; status: ActivityCall['status'] }>()
  for (const { message, scope, parts } of transcript) {
    for (const part of parts) {
      if (part.type !== 'tool-call' || part.preparing) continue
      const id = callIdentity(scope, message.id, part)
      if (part.status !== 'running' || !reportedCalls.has(id)) reportedCalls.set(id, { scope, status: part.status })
    }
  }
  const executingScopes = new Set([...reportedCalls.values()].filter(call => call.status === 'running').map(call => call.scope))
  const displayedPreparations = new Set<string>()
  const completedScopes = new Set<string>()
  const runByScope = new Map<string, string>()
  let current: ActivityGroup | undefined
  let previousScope: string | undefined
  let publicTextSinceAction = false
  let hasPublicReport = false
  let proposedTitle: string | undefined

  for (const { message, scope, parts } of transcript) {
    const newAuthorMessage = message.role !== 'assistant' && !message.goalContinuation
    if (newAuthorMessage && scope === previousScope && current?.title) current.closed = true
    if (newAuthorMessage || scope !== previousScope) {
      current = undefined
      publicTextSinceAction = false
      hasPublicReport = false
      proposedTitle = undefined
    }
    previousScope = scope
    if (message.role !== 'assistant') continue

    const sourceRunId = message.runTiming?.sourceRunId ?? message.runId
    runByScope.set(scope, sourceRunId)
    if (message.completedAt || message.runTiming?.completedAt) completedScopes.add(scope)
    const messageGroups = new Map<string, ActivityGroup>()
    byMessage.set(message.id, messageGroups)
    for (const part of parts) {
      if (part.type !== 'tool-call') {
        if (part.type === 'activity-title') proposedTitle = part.title
        else if (part.type === 'text') {
          publicTextSinceAction = true
          hasPublicReport = true
          authorSpokeByRun.add(sourceRunId)
        }
        continue
      }
      const identity = callIdentity(scope, message.id, part)
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
        const parentKey = JSON.stringify([scope, message.id, null, part.subagentCallId])
        const calls = branches.get(parentKey) ?? []
        branches.set(parentKey, calls)
        seen.set(identity, { calls, index: calls.length })
        calls.push(part)
        continue
      }

      const changesStage = current && publicTextSinceAction
        && !sameAgentToolStage(getAgentToolPresentation(current.calls[0].toolName), getAgentToolPresentation(part.toolName))
      const title = proposedTitle ?? (changesStage ? undefined : current?.title)
      const separate = title ? title !== current?.title : current && (changesStage || !canGroup(current, part, publicTextSinceAction))
      // A reported run changes rows after public prose. A batch without another
      // report stays in one row even when the tool types differ. Keep the
      // original grouping of old, completely silent untitled transcripts.
      if (!current || separate && (publicTextSinceAction || !hasPublicReport && !current.title)) {
        if (current?.title) current.closed = true
        current = { id: JSON.stringify([message.id, part.callId]), runId: message.runId, messageId: message.id,
          firstCallId: part.callId, calls: [], callKeys: [], childrenByCall: new Map(), ...(title ? { title } : {}) }
        groups.push({ group: current, scope })
      }
      proposedTitle = undefined
      publicTextSinceAction = false
      const group = current
      const first = group.calls[0]
      if (!group.title && first) {
        const next = getAgentToolPresentation(part.toolName)
        const firstTool = getAgentToolPresentation(first.toolName)
        if (next.phase !== 'read') group.readLabel = undefined
        else if (firstTool.label !== next.label && group.calls.every(call => getAgentToolPresentation(call.toolName).phase === 'read')) {
          group.readLabel = '查看创作资料'
        }
      }
      if (part.toolName === 'subagent_run' || part.toolName === 'subagent_delegate') {
        const calls = branches.get(identity) ?? []
        group.childrenByCall.set(identity, calls)
        branches.set(identity, calls)
      }
      seen.set(identity, { group, calls: group.calls, index: group.calls.length })
      group.calls.push(part)
      group.callKeys.push(identity)
      messageGroups.set(part.callId, group)
    }
  }
  const chaptersByScope = new Map<string, Map<string, number>>()
  for (const { group, scope } of groups) {
    const chapters = chaptersByScope.get(scope) ?? new Map<string, number>()
    chaptersByScope.set(scope, chapters)
    for (const part of group.calls) {
      const version = observedChapterVersion(part)
      if (version) chapters.set(version.chapterId, Math.max(version.revision, chapters.get(version.chapterId) ?? version.revision))
    }
  }
  for (const { group, scope } of groups) {
    const sourceRunId = runByScope.get(scope) ?? group.runId
    lastGroupByRun.set(sourceRunId, group)
    if (group.calls.some(part => part.status === 'running')) runningByRun.set(sourceRunId, group)
    const chapters = chaptersByScope.get(scope)
    const stale = new Set(group.calls.filter(part => {
      const review = activityReviewVersion(part)
      return activityReviewProblem(part) === 'stale' || review && (chapters?.get(review.chapterId) ?? review.revision) > review.revision
    }))
    group.staleReviewCalls = stale
    group.unsettled = findUnsettledCall(group.calls, stale)
    group.unfinished = Boolean(group.unsettled) || group.calls.every(part => part.preparing)
    if (group.title) {
      group.completed = completedScopes.has(scope)
      if (!group.closed && !group.completed) activeByRun.set(sourceRunId, group)
    }
    for (const part of group.calls) {
      lastCallByRun.set(sourceRunId, part)
      const reply = savedReply(part)
      if (reply) savedReplyByRun.set(group.runId, reply)
    }
  }
  for (const [runId, group] of runningByRun) activeByRun.set(runId, group)
  return { byMessage, runningByRun, activeByRun, authorSpokeByRun, savedReplyByRun, lastCallByRun, lastGroupByRun }
}
