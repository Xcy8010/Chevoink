import { create } from 'zustand'
import type { AgentAttachmentMeta, AgentRunTiming, AgentUIMessage } from '../../../../shared/contracts/index'
import { settleRunTiming, timestamp, unknownRunTiming } from '../../../../shared/agent-timing'

type OutgoingAnchor = { messageId: string | null; runId: string | null; previousOutgoingId?: string; previousClientRequestId?: string }
export type OutgoingMessage = { clientRequestId: string; anchor: OutgoingAnchor; id: string; scope: string; novelId: string; sessionId: string | null; runId?: string; status: 'sending' | 'failed' | 'sent'; error?: string; message: AgentUIMessage }
export type AuthorMessage = AgentUIMessage & { delivery?: Pick<OutgoingMessage, 'status' | 'error'>; requestTiming?: AgentRunTiming }
type RequestClock = Pick<OutgoingMessage, 'id' | 'clientRequestId' | 'scope' | 'novelId' | 'sessionId' | 'runId'> & { sentAt: string; overheadMs: number | null; timing: AgentRunTiming }
type OutgoingState = {
  items: OutgoingMessage[]
  requestClocks: RequestClock[]
  observeOriginalStart: (runId: string, startedAt: string) => void
  add: (scope: string, novelId: string, sessionId: string | null, prompt: string, attachments: AgentAttachmentMeta[], anchor?: Pick<OutgoingAnchor, 'messageId' | 'runId'>, clientRequestId?: string) => string
  update: (id: string, patch: Partial<Pick<OutgoingMessage, 'sessionId' | 'runId' | 'status' | 'error'>>) => void
  remove: (id: string) => void
  reconcile: (messages: AgentUIMessage[], scope: string, novelId: string, sessionId: string | null) => void
}

/** Local delivery facts survive view switches; they never imply server admission. */
export const useOutgoingMessages = create<OutgoingState>((set, get) => ({
  items: [],
  requestClocks: [],
  observeOriginalStart: (runId, startedAt) => set(state => {
    const started = timestamp(startedAt)
    if (started === null) return state
    const requestClocks = state.requestClocks.map(clock => clock.runId === runId && clock.overheadMs === null
      ? { ...clock, overheadMs: Math.max(0, started - timestamp(clock.sentAt)!) } : clock)
    return requestClocks.every((clock, index) => clock === state.requestClocks[index]) ? state : { requestClocks }
  }),
  add: (scope, novelId, sessionId, prompt, attachments, anchor = { messageId: null, runId: null }, clientRequestId = crypto.randomUUID()) => {
    const id = `local-outgoing-${crypto.randomUUID()}`
    const message: AgentUIMessage = { id, clientRequestId, runId: id, role: 'user', createdAt: new Date().toISOString(), parts: [
      { type: 'text', text: prompt }, ...attachments.map(attachment => ({ type: 'attachment' as const, kind: attachment.kind, name: attachment.name, url: attachment.url, size: attachment.size })),
    ] }
    const previous = [...get().items].reverse().find(item => item.novelId === novelId && (item.scope === scope || Boolean(sessionId && item.sessionId === sessionId)))
    set(state => ({ items: [...state.items, { id, clientRequestId, scope, novelId, sessionId, message, status: 'sending', anchor: { ...anchor, previousOutgoingId: previous?.id, previousClientRequestId: previous?.clientRequestId } }],
      requestClocks: [...state.requestClocks, { id, clientRequestId, scope, novelId, sessionId, sentAt: message.createdAt, overheadMs: null, timing: { elapsedMs: 0, activeSince: message.createdAt, status: 'running', lastSeq: 0 } }] }))
    return id
  },
  update: (id, patch) => set(state => ({ items: state.items.map(item => item.id === id ? { ...item, ...patch } : item),
    requestClocks: state.requestClocks.map(clock => clock.id === id ? { ...clock,
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}), ...(patch.runId ? { runId: patch.runId } : {}),
      ...(patch.status === 'failed' ? { timing: settleRunTiming(clock.timing, new Date().toISOString()) } : {}),
    } : clock) })),
  remove: id => set(state => ({ items: state.items.filter(item => item.id !== id), requestClocks: state.requestClocks.filter(clock => clock.id !== id) })),
  reconcile: (messages, scope, novelId, sessionId) => set(state => {
    const items = state.items.filter(item => !inScope(item, scope, novelId, sessionId) || !messages.some(message => matchesOutgoingMessage(message, item)))
    const requestClocks = state.requestClocks.map(clock => inScope(clock, scope, novelId, sessionId) ? observeRequestClock(clock, messages) : clock)
    return items.length === state.items.length && requestClocks.every((clock, index) => clock === state.requestClocks[index]) ? state : { items, requestClocks }
  }),
}))

function inScope(item: Pick<OutgoingMessage, 'scope' | 'novelId' | 'sessionId'>, scope: string, novelId: string, sessionId: string | null) {
  return item.novelId === novelId && (item.scope === scope || Boolean(sessionId && item.sessionId === sessionId))
}

/** Local send latency belongs to display only. Server activity still owns pause,
 * resume and completion, and a session with no local send retains unknown time. */
function observeRequestClock(clock: RequestClock, messages: AgentUIMessage[]): RequestClock {
  const user = messages.find(message => message.role === 'user' && (message.clientRequestId === clock.clientRequestId || message.id === clock.id))
  const runId = user?.runId ?? clock.runId
  if (!runId) return clock
  const related = messages.filter(message => message.runId === runId || Boolean(clock.timing.scopeId && message.runTiming?.scopeId === clock.timing.scopeId))
  const server = [...related].reverse().find(message => message.runTiming)?.runTiming
  const overheadMs = clock.overheadMs
  let timing = clock.timing
  if (server) timing = { ...server, elapsedMs: server.elapsedMs !== null && overheadMs !== null ? server.elapsedMs + overheadMs : server.elapsedMs }
  else if (related.some(message => message.completedAt)) timing = { ...unknownRunTiming(), status: 'finished' }
  if (clock.runId === runId && clock.overheadMs === overheadMs && JSON.stringify(clock.timing) === JSON.stringify(timing)) return clock
  return { ...clock, runId, overheadMs, timing }
}
function matchesOutgoingMessage(message: AgentUIMessage, item: OutgoingMessage) {
  return message.role === 'user' && (message.clientRequestId === item.clientRequestId || message.id === item.id || Boolean(item.runId && message.runId === item.runId))
}

export function projectOutgoingMessages(messages: AgentUIMessage[], items: OutgoingMessage[], scope: string, novelId: string, sessionId: string | null, clocks: RequestClock[] = []): AuthorMessage[] {
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
  const localClocks = clocks.filter(clock => inScope(clock, scope, novelId, sessionId))
  return projected.map(message => {
    const clock = localClocks.find(item => message.role === 'user'
      ? message.id === item.id || message.clientRequestId === item.clientRequestId || message.runId === item.runId
      : message.runId === item.runId || Boolean(item.timing.scopeId && message.runTiming?.scopeId === item.timing.scopeId))
    if (!clock) return message
    return message.role === 'user' ? { ...message, requestTiming: clock.timing }
      : { ...message, runTiming: { ...clock.timing, scopeId: clock.timing.scopeId ?? message.runTiming?.scopeId, sourceRunId: clock.timing.sourceRunId ?? message.runTiming?.sourceRunId } }
  })
}
