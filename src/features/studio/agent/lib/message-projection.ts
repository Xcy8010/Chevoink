import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'
import { getMessageText } from './panel-helpers'

export type MessageBlock = { firstId: string; lastId: string; ops: number; goalId?: string }

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
  let recentConversationText = ''
  let lastAssistantId: string | undefined
  const flush = () => {
    if (assistantIds.length > 0) {
      const block = { firstId: assistantIds[0], lastId: assistantIds[assistantIds.length - 1], ops, ...(goalId ? { goalId } : {}) }
      for (const id of ids) blockInfoById.set(id, block)
    }
    ids = []
    assistantIds = []
    goalId = null
    ops = 0
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      // A run boundary is not a goal boundary. Explicit ordinary/new-goal
      // ownership still separates adjacent assistant messages.
      if (ids.length > 0 && (message.goalId ?? null) !== goalId) flush()
      goalId = message.goalId ?? null
      ids.push(message.id)
      assistantIds.push(message.id)
      lastAssistantId = message.id
      for (const part of message.parts) if (part.type !== 'text') ops++
    } else if (message.goalContinuation && message.goalId) {
      if (ids.length > 0 && message.goalId !== goalId) flush()
      goalId = message.goalId
      ids.push(message.id)
    } else {
      flush()
    }
  }
  flush()
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].goalContinuation) continue
    const text = getMessageText(messages[index].parts).replace(/\s+/g, ' ').trim()
    if (text) {
      recentConversationText = text.slice(0, 1000)
      break
    }
  }
  return { blockInfoById, recentConversationText, lastAssistantId }
}
