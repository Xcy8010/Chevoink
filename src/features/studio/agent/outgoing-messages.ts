import { create } from 'zustand'
import type { AgentAttachmentMeta, AgentRunTiming, AgentUIMessage, AgentStreamEvent } from '../../../../shared/contracts/index'
import { advanceRunTiming, settleRunTiming } from '../../../../shared/agent-timing'

type OutgoingAnchor = { messageId: string | null; runId: string | null; previousOutgoingId?: string; previousClientRequestId?: string }
export type OutgoingMessage = { clientRequestId: string; anchor: OutgoingAnchor; id: string; scope: string; novelId: string; sessionId: string | null; runId?: string; status: 'sending' | 'failed' | 'sent'; error?: string; message: AgentUIMessage }
export type AuthorMessage = AgentUIMessage & { delivery?: Pick<OutgoingMessage, 'status' | 'error'>; requestTiming?: AgentRunTiming; presentationId?: string }
type RequestClock = Pick<OutgoingMessage, 'id' | 'clientRequestId' | 'scope' | 'novelId' | 'sessionId' | 'runId'> & { retiredRunIds: string[]; timing: AgentRunTiming }
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
    if (event.durableTiming === null && (event.type === 'run.started' || event.type === 'execution.progress')) return state
    if (!event.durableTiming && event.type !== 'run.started' && event.type !== 'run.paused' && event.type !== 'run.finished'
      && event.type !== 'run.question_wait' && (event.type !== 'error' || event.recoverable)) return state
    const requestClocks = state.requestClocks.map(clock => {
      if (event.durableTiming) {
        const incoming = event.durableTiming
        const source = clock.timing.sourceRunId ?? clock.runId
        if (!source || clock.retiredRunIds.includes(event.runId) || source !== event.runId && (!incoming.scopeId || incoming.scopeId !== clock.timing.scopeId)) return clock
        return { ...clock, timing: incoming, retiredRunIds: source === event.runId ? clock.retiredRunIds : [...clock.retiredRunIds, source] }
      }
      if ((clock.timing.sourceRunId ?? clock.runId) !== event.runId) return clock
      const current = clock.timing
      if (event.seq <= current.lastSeq || event.type === 'run.started' && current.activeSince) return clock
      // A new durable attempt replays the original start. Its own start comes
      // from history unless the stream carries the explicit continuation.
      if (event.type === 'run.started' && clock.runId !== event.runId && current.scopeId?.startsWith('root:') && !event.authorContinue) return clock
      const starting = event.type === 'run.started' && !current.lastSeq && current.elapsedMs === null
      const timing = advanceRunTiming(starting ? { ...current, elapsedMs: 0 } : current, event)
      return timing === current ? clock : { ...clock, timing }
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
      requestClocks: [...state.requestClocks, { id, clientRequestId, scope, novelId, sessionId, retiredRunIds: [], timing: { elapsedMs: null, activeSince: null, status: 'running', lastSeq: 0 } }] }))
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

/** The display clock measures execution from its start witness, using the same
 * server timestamps for the stream and for history restored after reconnect. */
function observeRequestClock(clock: RequestClock, messages: AgentUIMessage[]): RequestClock {
  const user = messages.find(message => message.role === 'user' && (message.clientRequestId === clock.clientRequestId || message.id === clock.id))
  const runId = user?.runId ?? clock.runId
  if (!runId) return clock
  const related = messages.filter(message => message.runId === runId || Boolean(clock.timing.scopeId && message.runTiming?.scopeId === clock.timing.scopeId))
  const latest = [...related].reverse().find(message => message.runTiming)
  const server = latest?.runTiming
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
    const sameFrame = server.lastSeq === clock.timing.lastSeq
    const fresh = changedSource || server.lastSeq > clock.timing.lastSeq
      || sameFrame && !(server.status === 'running' && ['waiting', 'paused', 'finished'].includes(clock.timing.status))
    const keepLiveStart = sameFrame && !changedSource && timing.status === 'running' && server.status === 'running'
      && timing.elapsedMs !== null && timing.activeSince !== null
    if (fresh && !keepLiveStart && (changedSource || server.status !== 'unknown')) {
      const scope = { scopeId: timing.scopeId, sourceRunId: timing.sourceRunId }
      timing = server.elapsedMs === null && !changedSource && (server.status === 'finished' || server.status === 'paused')
        ? { ...settleRunTiming(timing, latest?.completedAt ?? server.completedAt, server.status === 'paused'), ...scope, lastSeq: server.lastSeq }
        : { ...server, ...scope }
    }
  }
  else {
    const completed = related.find(message => message.runId === (timing.sourceRunId ?? runId) && message.completedAt)
    if (completed) timing = settleRunTiming(timing, completed.completedAt)
  }
  if (clock.runId === runId && retiredRunIds === clock.retiredRunIds && JSON.stringify(clock.timing) === JSON.stringify(timing)) return clock
  return { ...clock, runId, retiredRunIds, timing }
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
    if (!clock) return message.role === 'user' && message.runTiming ? { ...message, requestTiming: message.runTiming } : message
    const timing = clock.timing.lastSeq === 0 && clock.timing.elapsedMs === null ? message.runTiming ?? clock.timing : clock.timing
    return message.role === 'user' ? { ...message, requestTiming: timing, presentationId: clock.id }
      : { ...message, runTiming: { ...timing, scopeId: timing.scopeId ?? message.runTiming?.scopeId, sourceRunId: timing.sourceRunId ?? message.runTiming?.sourceRunId } }
  })
}
