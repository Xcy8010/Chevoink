import { create } from 'zustand'
import type { AgentAttachmentMeta, AgentUIMessage } from '../../../../shared/contracts/index'

type OutgoingAnchor = { messageId: string | null; runId: string | null; previousOutgoingId?: string; previousClientRequestId?: string }
export type OutgoingMessage = { clientRequestId: string; anchor: OutgoingAnchor; id: string; scope: string; novelId: string; sessionId: string | null; runId?: string; status: 'sending' | 'failed' | 'sent'; error?: string; message: AgentUIMessage }
export type AuthorMessage = AgentUIMessage & { delivery?: Pick<OutgoingMessage, 'status' | 'error'> }
type OutgoingState = {
  items: OutgoingMessage[]
  add: (scope: string, novelId: string, sessionId: string | null, prompt: string, attachments: AgentAttachmentMeta[], anchor?: Pick<OutgoingAnchor, 'messageId' | 'runId'>, clientRequestId?: string) => string
  update: (id: string, patch: Partial<Pick<OutgoingMessage, 'sessionId' | 'runId' | 'status' | 'error'>>) => void
  remove: (id: string) => void
  reconcile: (messages: AgentUIMessage[], scope: string, novelId: string, sessionId: string | null) => void
}

/** Local delivery facts survive view switches; they never imply server admission. */
export const useOutgoingMessages = create<OutgoingState>((set, get) => ({
  items: [],
  add: (scope, novelId, sessionId, prompt, attachments, anchor = { messageId: null, runId: null }, clientRequestId = crypto.randomUUID()) => {
    const id = `local-outgoing-${crypto.randomUUID()}`
    const message: AgentUIMessage = { id, clientRequestId, runId: id, role: 'user', createdAt: new Date().toISOString(), parts: [
      { type: 'text', text: prompt }, ...attachments.map(attachment => ({ type: 'attachment' as const, kind: attachment.kind, name: attachment.name, url: attachment.url, size: attachment.size })),
    ] }
    const previous = [...get().items].reverse().find(item => item.novelId === novelId && (item.scope === scope || Boolean(sessionId && item.sessionId === sessionId)))
    set(state => ({ items: [...state.items, { id, clientRequestId, scope, novelId, sessionId, message, status: 'sending', anchor: { ...anchor, previousOutgoingId: previous?.id, previousClientRequestId: previous?.clientRequestId } }] }))
    return id
  },
  update: (id, patch) => set(state => ({ items: state.items.map(item => item.id === id ? { ...item, ...patch } : item) })),
  remove: id => set(state => ({ items: state.items.filter(item => item.id !== id) })),
  reconcile: (messages, scope, novelId, sessionId) => set(state => {
    const items = state.items.filter(item => !inScope(item, scope, novelId, sessionId) || !messages.some(message => matchesOutgoingMessage(message, item)))
    return items.length === state.items.length ? state : { items }
  }),
}))

function inScope(item: OutgoingMessage, scope: string, novelId: string, sessionId: string | null) {
  return item.novelId === novelId && (item.scope === scope || Boolean(sessionId && item.sessionId === sessionId))
}
function matchesOutgoingMessage(message: AgentUIMessage, item: OutgoingMessage) {
  return message.role === 'user' && (message.clientRequestId === item.clientRequestId || message.id === item.id || Boolean(item.runId && message.runId === item.runId))
}

export function projectOutgoingMessages(messages: AgentUIMessage[], items: OutgoingMessage[], scope: string, novelId: string, sessionId: string | null): AuthorMessage[] {
  const visible = items.filter(item => inScope(item, scope, novelId, sessionId))
  const projected: AuthorMessage[] = [...messages]
  for (const item of visible) {
    if (messages.some(message => matchesOutgoingMessage(message, item))) continue
    const firstOwnRun = item.runId ? projected.findIndex(message => message.runId === item.runId) : -1
    let index = firstOwnRun
    if (index < 0) {
      const anchorIndex = projected.findIndex(message => message.id === item.anchor.messageId)
      const runIndex = anchorIndex < 0 && item.anchor.runId ? projected.map(message => message.runId).lastIndexOf(item.anchor.runId) : -1
      const previousIndex = projected.findIndex(message => message.id === item.anchor.previousOutgoingId
        || Boolean(item.anchor.previousClientRequestId && message.role === 'user' && message.clientRequestId === item.anchor.previousClientRequestId))
      index = Math.max(anchorIndex, runIndex, previousIndex) + 1
    }
    projected.splice(index, 0, { ...item.message, runId: item.runId ?? item.message.runId, delivery: { status: item.status, error: item.error } })
  }
  return projected
}
