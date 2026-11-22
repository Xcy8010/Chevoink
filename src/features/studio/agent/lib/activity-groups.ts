import { joinAgentAuthorText, projectAgentAuthorParts } from '../../../../../shared/agent-author-view.js'
import { activityAttemptKey, activityReviewVersion } from '../../../../../shared/agent-activity-receipts.js'
import { visibleAgentActivityTitle } from '../../../../../shared/agent-activity-title.js'
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
  receiptKeys: string[]
  stageStart: number
  childrenByCall: Map<string, ActivityCall[]>
  reportsAfterCall: Map<string, ActivityReport[]>
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

export function activityAnswerText(parts: readonly AgentMessagePart[]) {
  const visible = projectAgentAuthorParts(parts)
  const lastTool = visible.reduce((last, part, index) => part.type === 'tool-call' ? index : last, -1)
  return joinAgentAuthorText(visible.slice(lastTool + 1))
}

export type MessageActivityGroups = ReadonlyMap<string, ActivityGroup>

type ActivityReport = {
  id: string
  text: string
  group: ActivityGroup
  terminal: boolean
  waitForTools: boolean
  followingCallId?: string
}

export type ActivityReportVisibility = { hidden: ReadonlySet<number>; deferred: boolean }

export function isActivityDetailReport(report: ActivityReport, runActive: boolean, awaitingApprovalCallId?: string) {
  return report.followingCallId !== undefined && (!runActive || report.followingCallId !== awaitingApprovalCallId)
}

/** Keep pending text in its original slot. Only a report bracketed by actual
 * reads under the same explicit title belongs in details permanently. */
export function activityReportVisibility(reports: ReadonlyMap<number, ActivityReport> | undefined, runActive: boolean,
  awaitingApprovalCallId?: string): ActivityReportVisibility | undefined {
  if (!reports?.size) return undefined
  const hidden = new Set<number>()
  let deferred = false
  for (const [index, report] of reports) {
    const { group } = report
    if (isActivityDetailReport(report, runActive, awaitingApprovalCallId)) {
      hidden.add(index)
      continue
    }
    if (!runActive) continue
    const waitingForAuthor = group.calls.some(call => call.status === 'running' && !call.preparing
      && (call.toolName === 'ask_user' || call.callId === awaitingApprovalCallId || call.importWaiting))
    const pending = report.terminal ? report.waitForTools
      : group.calls.some(call => !call.preparing && call.status === 'running') || !group.closed && !group.completed
    if (!waitingForAuthor && pending) {
      hidden.add(index)
      deferred = true
    }
  }
  return hidden.size ? { hidden, deferred } : undefined
}

export function hasVisibleActivityText(parts: readonly AgentMessagePart[], visibility?: ActivityReportVisibility) {
  let index = 0
  return projectAgentAuthorParts(parts).some(part => part.type === 'text' && !visibility?.hidden.has(index++))
}

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
  const first = current.calls[current.stageStart]
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
  const reportsByMessage = new Map<string, Map<number, ActivityReport>>()
  const runningByRun = new Map<string, ActivityGroup>()
  const activeByRun = new Map<string, ActivityGroup>()
  const authorSpokeByRun = new Set<string>()
  const savedReplyByRun = new Map<string, string>()
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
  let hasActivityTitle = false
  let stageReports: ActivityReport[] = []
  let previousCall: { messageId: string; group: ActivityGroup; key: string; wasRead: boolean; reports: ActivityReport[] } | undefined
  let proposedTitle: string | undefined

  for (const { message, scope, parts } of transcript) {
    const newAuthorMessage = message.role !== 'assistant' && !message.goalContinuation
    if (newAuthorMessage && scope === previousScope && current) current.closed = true
    if (newAuthorMessage || scope !== previousScope) {
      current = undefined
      publicTextSinceAction = false
      hasPublicReport = false
      hasActivityTitle = false
      stageReports = []
      previousCall = undefined
      proposedTitle = undefined
    }
    previousScope = scope
    if (message.role !== 'assistant') continue

    const sourceRunId = message.runTiming?.sourceRunId ?? message.runId
    runByScope.set(scope, sourceRunId)
    if (message.completedAt || message.runTiming?.completedAt) completedScopes.add(scope)
    const messageGroups = new Map<string, ActivityGroup>()
    byMessage.set(message.id, messageGroups)
    let textIndex = 0
    for (const part of parts) {
      if (part.type !== 'tool-call') {
        if (part.type === 'context-compaction') {
          if (current) current.closed = true
          current = undefined
          previousCall = undefined
          proposedTitle = undefined
          stageReports = []
          publicTextSinceAction = false
          hasPublicReport = false
          hasActivityTitle = false
        }
        if (part.type === 'activity-title') {
          proposedTitle = visibleAgentActivityTitle(part.title)
          if (proposedTitle) hasActivityTitle = true
        }
        else if (part.type === 'text') {
          if (current) {
            const reports = reportsByMessage.get(message.id) ?? new Map<number, ActivityReport>()
            const terminal = part.afterTools === true
            const report: ActivityReport = { id: JSON.stringify([message.id, textIndex]), text: part.text,
              group: current, terminal, waitForTools: terminal && executingScopes.has(scope) }
            reports.set(textIndex, report)
            reportsByMessage.set(message.id, reports)
            if (terminal) current.closed = true
            else {
              stageReports.push(report)
              if (previousCall?.group === current) previousCall.reports.push(report)
            }
          }
          textIndex++
          publicTextSinceAction ||= !part.afterTools
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

      const nextStage = getAgentToolPresentation(part.toolName)
      const changesStage = current && (publicTextSinceAction || previousCall?.messageId !== message.id && ['save', 'write', 'revise'].includes(nextStage.phase))
        && !sameAgentToolStage(getAgentToolPresentation(current.calls[current.stageStart].toolName), nextStage)
      const title = proposedTitle ?? (changesStage ? undefined : current?.title)
      const separate = title ? title !== current?.title : current && (changesStage || !canGroup(current, part, publicTextSinceAction))
      if (!part.preparing && current?.title && !current.closed && !separate && nextStage.phase === 'read'
        && previousCall?.group === current && previousCall.wasRead && previousCall.reports.length) {
        for (const report of previousCall.reports) report.followingCallId = part.callId
        current.reportsAfterCall.set(previousCall.key, previousCall.reports)
      }
      // A new stage without a report changes the existing row. Earlier receipts
      // stay in its details. Old untitled, silent transcripts keep their groups.
      if (!current || current.closed || separate && (stageReports.some(report => !report.followingCallId) || !hasPublicReport && !hasActivityTitle)) {
        if (current) current.closed = true
        current = { id: JSON.stringify([message.id, part.callId]), runId: message.runId, messageId: message.id,
          firstCallId: part.callId, calls: [], callKeys: [], receiptKeys: [], stageStart: 0, childrenByCall: new Map(), reportsAfterCall: new Map(), ...(title ? { title } : {}) }
        groups.push({ group: current, scope })
        stageReports = []
      } else if (separate && (changesStage || proposedTitle)) {
        current.title = title
        current.stageStart = current.calls.length
        current.readLabel = undefined
        stageReports = []
      }
      proposedTitle = undefined
      publicTextSinceAction = false
      const group = current
      const first = group.calls[group.stageStart]
      if (!group.title && first) {
        const next = getAgentToolPresentation(part.toolName)
        const firstTool = getAgentToolPresentation(first.toolName)
        if (next.phase !== 'read') group.readLabel = undefined
        else if (firstTool.label !== next.label && group.calls.slice(group.stageStart).every(call => getAgentToolPresentation(call.toolName).phase === 'read')) {
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
      group.receiptKeys.push(JSON.stringify([message.id, null, part.callId]))
      if (!part.preparing) previousCall = { messageId: message.id, group, key: identity, wasRead: nextStage.phase === 'read', reports: [] }
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
    const stageCalls = group.calls.slice(group.stageStart)
    group.unsettled = findUnsettledCall(stageCalls, stale)
    group.unfinished = Boolean(group.unsettled) || group.calls.some(part => !part.preparing && part.status === 'running') || stageCalls.every(part => part.preparing)
    group.completed = completedScopes.has(scope)
    if (group.title && !group.closed && !group.completed) activeByRun.set(sourceRunId, group)
    for (const part of group.calls) {
      const reply = savedReply(part)
      if (reply) savedReplyByRun.set(group.runId, reply)
    }
  }
  for (const [runId, group] of runningByRun) activeByRun.set(runId, group)
  return { byMessage, reportsByMessage, runningByRun, activeByRun, authorSpokeByRun, savedReplyByRun, lastGroupByRun }
}
