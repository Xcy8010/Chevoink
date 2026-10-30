import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'
import { getMessageText } from './panel-helpers'
import { projectAgentAuthorParts } from '../../../../../shared/agent-author-view.js'
import { combineRunTimings, unknownRunTiming } from '../../../../../shared/agent-timing.js'
import type { AgentRunTiming } from '../../../../../shared/contracts/agent-events.js'

export type MessageBlock = { firstId: string; lastId: string; ops: number; goalId?: string; runIds?: string[] }

export function projectBlockTimings(messages: readonly AgentUIMessage[], blocks: Map<string, MessageBlock>, activeRunId: string | null) {
  const byRun = new Map<string, AgentRunTiming>()
  for (const message of messages) if (message.runTiming) byRun.set(message.runId, message.runTiming)
  const result = new Map<string, AgentRunTiming>()
  for (const block of new Set(blocks.values())) {
    const scopes = new Map<string, AgentRunTiming>()
    for (const runId of block.runIds ?? []) {
      const stored = byRun.get(runId) ?? unknownRunTiming()
      const timing = stored.status === 'running' && (stored.sourceRunId ?? runId) !== activeRunId
        ? { ...stored, elapsedMs: null, activeSince: null, status: 'unknown' as const } : stored
      scopes.set(timing.scopeId ?? runId, timing)
    }
    result.set(block.firstId, combineRunTimings([...scopes.values()]))
  }
  return result
}

/** Internal goal dispatch records are context, never an additional author message. */
export function shouldRenderAuthorMessage(message: AgentUIMessage): boolean {
  return message.role === 'user' && !message.goalContinuation
}

/** Pure presentation projection: never mutates messages or changes run state. */
export function projectMessages(messages: readonly AgentUIMessage[]) {
  const blockInfoById = new Map<string, MessageBlock>()
  let ids: string[] = []
  let assistantIds: string[] = []
  let goalId: string | null = null
  let ops = 0
  let runIds = new Set<string>()
  let recentConversationText = ''
  let lastAssistantId: string | undefined
  const flush = () => {
    if (assistantIds.length > 0) {
      const block = { firstId: assistantIds[0], lastId: assistantIds[assistantIds.length - 1], ops, runIds: [...runIds], ...(goalId ? { goalId } : {}) }
      for (const id of ids) blockInfoById.set(id, block)
    }
    ids = []
    assistantIds = []
    goalId = null
    ops = 0
    runIds = new Set()
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      // A run boundary is not a goal boundary. Explicit ordinary/new-goal
      // ownership still separates adjacent assistant messages.
      if (ids.length > 0 && (message.goalId ?? null) !== goalId) flush()
      goalId = message.goalId ?? null
      ids.push(message.id)
      runIds.add(message.runId)
      assistantIds.push(message.id)
      lastAssistantId = message.id
      for (const part of projectAgentAuthorParts(message.parts, false, { includePreparing: true })) if (part.type === 'tool-call') ops++
    } else if (message.goalContinuation && message.goalId) {
      if (ids.length > 0 && message.goalId !== goalId) flush()
      goalId = message.goalId
      ids.push(message.id)
      runIds.add(message.runId)
    } else {
      flush()
    }
  }
  flush()
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].goalContinuation) continue
    const text = getMessageText(messages[index].parts, messages[index].role).replace(/\s+/g, ' ').trim()
    if (text) {
      recentConversationText = text.slice(0, 1000)
      break
    }
  }
  return { blockInfoById, recentConversationText, lastAssistantId }
}
