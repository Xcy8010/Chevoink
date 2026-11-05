import { create } from 'zustand'
import type { AgentAttachmentMeta, AgentRunTiming, AgentUIMessage, AgentStreamEvent } from '../../../../shared/contracts/index'
import { settleRunTiming, timestamp, unknownRunTiming } from '../../../../shared/agent-timing'

type OutgoingAnchor = { messageId: string | null; runId: string | null; previousOutgoingId?: string; previousClientRequestId?: string }
export type OutgoingMessage = { clientRequestId: string; anchor: OutgoingAnchor; id: string; scope: string; novelId: string; sessionId: string | null; runId?: string; status: 'sending' | 'failed' | 'sent'; error?: string; message: AgentUIMessage }
export type AuthorMessage = AgentUIMessage & { delivery?: Pick<OutgoingMessage, 'status' | 'error'>; requestTiming?: AgentRunTiming }
type RequestClock = Pick<OutgoingMessage, 'id' | 'clientRequestId' | 'scope' | 'novelId' | 'sessionId' | 'runId'> & { responded: boolean; eventOffsetMs: number | null; retiredRunIds: string[]; timing: AgentRunTiming }
type OutgoingState = {
  items: OutgoingMessage[]
  requestClocks: RequestClock[]
  observeEvent: (event: AgentStreamEvent) => void
  add: (scope: string, novelId: string, sessionId: string | null, prompt: string, attachments: AgentAttachmentMeta[], anchor?: Pick<OutgoingAnchor, 'messageId' | 'runId'>, clientRequestId?: string) => string
  update: (id: string, patch: Partial<Pick<OutgoingMessage, 'sessionId' | 'runId' | 'status' | 'error'>>) => void
  remove: (id: string) => void
  reconcile: (messages: AgentUIMessage[], scope: string, novelId: string, sessionId: string | null) => void
}

/** Local delivery facts survive view switches; they never imply server admission. */
export const useOutgoingMessages = create<OutgoingState>((set, get) => ({
  items: [],
  requestClocks: [],
  observeEvent: event => set(state => {
    const response = (event.type === 'text.delta' || event.type === 'reasoning.delta') && Boolean(event.delta.trim())
      || event.type === 'reasoning.delta' && event.activity === true
      || event.type === 'text.final' && Boolean(event.text.trim())
      || event.type === 'tool.call' || event.type === 'tool.delta' && event.argsChars > 0
    const stopped = event.type === 'run.paused' || event.type === 'run.finished' || event.type === 'error' && !event.recoverable
    if (!response && !stopped && event.type !== 'run.started') return state
    const now = new Date().toISOString()
    const requestClocks = state.requestClocks.map(clock => {
      if ((clock.timing.sourceRunId ?? clock.runId) !== event.runId) return clock
      let timing = clock.timing
      if (response && !clock.responded && timing.status === 'running') timing = { ...timing, elapsedMs: 0, activeSince: now, status: 'running', lastSeq: event.seq }
      else if (event.type === 'run.started' && timing.status !== 'running') timing = { ...timing, activeSince: clock.responded ? now : null, status: 'running', lastSeq: event.seq }
      else if (stopped) timing = { ...settleRunTiming(timing, now, event.type === 'run.paused'), lastSeq: event.seq }
      if (timing === clock.timing) return clock
      return { ...clock, responded: clock.responded || response, timing,
        eventOffsetMs: timestamp(event.ts) === null ? clock.eventOffsetMs : Date.now() - timestamp(event.ts)! }
    })
    return requestClocks.every((clock, index) => clock === state.requestClocks[index]) ? state : { requestClocks }
  }),
  add: (scope, novelId, sessionId, prompt, attachments, anchor = { messageId: null, runId: null }, clientRequestId = crypto.randomUUID()) => {
    const id = `local-outgoing-${crypto.randomUUID()}`
    const message: AgentUIMessage = { id, clientRequestId, runId: id, role: 'user', createdAt: new Date().toISOString(), parts: [
      { type: 'text', text: prompt }, ...attachments.map(attachment => ({ type: 'attachment' as const, kind: attachment.kind, name: attachment.name, url: attachment.url, size: attachment.size })),
    ] }
    const previous = [...get().items].reverse().find(item => item.novelId === novelId && (item.scope === scope || Boolean(sessionId && item.sessionId === sessionId)))
    set(state => ({ items: [...state.items, { id, clientRequestId, scope, novelId, sessionId, message, status: 'sending', anchor: { ...anchor, previousOutgoingId: previous?.id, previousClientRequestId: previous?.clientRequestId } }],
      requestClocks: [...state.requestClocks, { id, clientRequestId, scope, novelId, sessionId, responded: false, eventOffsetMs: null, retiredRunIds: [], timing: { elapsedMs: null, activeSince: null, status: 'running', lastSeq: 0 } }] }))
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

/** Response time is a local display fact, never admission, usage or billing time.
 * History supplies identity/terminal evidence without replacing a live clock. */
function observeRequestClock(clock: RequestClock, messages: AgentUIMessage[]): RequestClock {
  const user = messages.find(message => message.role === 'user' && (message.clientRequestId === clock.clientRequestId || message.id === clock.id))
  const runId = user?.runId ?? clock.runId
  if (!runId) return clock
  const related = messages.filter(message => message.runId === runId || Boolean(clock.timing.scopeId && message.runTiming?.scopeId === clock.timing.scopeId))
  const latest = [...related].reverse().find(message => message.runTiming)
  const server = latest?.runTiming
  const hasOutput = related.some(message => message.role === 'assistant' && message.parts.some(part =>
    part.type === 'reasoning' ? Boolean(part.text.trim() || part.activity)
      : part.type === 'text' ? Boolean(part.text.trim()) : part.type === 'tool-call'))
  let responded = clock.responded
  let retiredRunIds = clock.retiredRunIds
  let timing = clock.timing
  if (server) {
    const source = server.sourceRunId ?? latest!.runId
    const currentSource = clock.timing.sourceRunId ?? runId
    const changedSource = source !== currentSource
    // Only a server-confirmed shared scope can link a new execution. Once it
    // has advanced, an old execution's delayed snapshot cannot take it back.
    if (changedSource && (retiredRunIds.includes(source) || !server.scopeId
      || !(server.scopeId === clock.timing.scopeId || !clock.timing.scopeId && latest!.runId === runId))) return clock
    if (changedSource) retiredRunIds = [...retiredRunIds, currentSource]
    timing = { ...timing, scopeId: server.scopeId ?? timing.scopeId, sourceRunId: source }
    const fresh = changedSource || server.lastSeq > clock.timing.lastSeq
      || server.lastSeq === clock.timing.lastSeq && !(server.status === 'running' && ['paused', 'finished'].includes(clock.timing.status))
    if (fresh && !responded && hasOutput && server.status === 'running') {
      // This is the first observed response to a local send, not evidence of
      // its earlier token time. Never backfill the server's admission interval.
      timing = { ...timing, elapsedMs: 0, activeSince: new Date().toISOString(), status: 'running', lastSeq: server.lastSeq }
      responded = true
    }
    else {
      if (fresh) {
        if (server.status === 'finished' || server.status === 'paused') {
          const stoppedAt = timestamp(latest?.completedAt ?? server.completedAt)
          const stop = stoppedAt === null ? Date.now() : Math.min(Date.now(), Math.max(timestamp(timing.activeSince) ?? 0, stoppedAt + (clock.eventOffsetMs ?? 0)))
          timing = { ...settleRunTiming(timing, new Date(stop).toISOString(), server.status === 'paused'), lastSeq: server.lastSeq }
        } else if (responded && timing.status !== 'running' && server.status === 'running') {
          const startedAt = timestamp(server.activeSince)
          timing = { ...timing, status: 'running', activeSince: startedAt === null ? null : new Date(Math.min(Date.now(), startedAt + (clock.eventOffsetMs ?? 0))).toISOString(), lastSeq: server.lastSeq }
        }
      }
    }
  }
  else if (related.some(message => message.runId === (timing.sourceRunId ?? runId) && message.completedAt)) timing = { ...unknownRunTiming(), status: 'finished' }
  if (clock.runId === runId && clock.responded === responded && retiredRunIds === clock.retiredRunIds && JSON.stringify(clock.timing) === JSON.stringify(timing)) return clock
  return { ...clock, runId, responded, retiredRunIds, timing }
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
