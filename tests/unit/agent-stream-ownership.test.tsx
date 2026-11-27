// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentStream } from '../../src/features/studio/agent/useAgentStream'
import { restoreActiveRunHistory, useAgentStore } from '../../src/features/studio/agent/agentStore'
import { claimWorkspaceStreamEvent, isReviewStreamReplay, isStaleChapterReview, isWorkspaceStreamOwnerCurrent, type ChapterStreamOwner, type ReviewStreamCursor } from '../../src/features/studio/components/chapter-stream-handoff'
import type { AgentStreamEvent, AgentUIMessage } from '../../shared/contracts/index.js'
import type { ChapterPendingReview, PlanPendingReview } from '../../src/features/studio/types'
import { buildServerPlanFile, mergeWorkspacePlanFiles, readStoredPendingReviewList, writeStoredPendingReview } from '../../src/features/studio/lib/plan-review'
import { observePlanFolderWrites } from '../../src/features/studio/lib/plan-folder-writes'

class Source {
  static opened: Source[] = []
  listeners = new Map<string, (event: MessageEvent) => void>()
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) { Source.opened.push(this) }
  addEventListener(type: string, callback: (event: MessageEvent) => void) { this.listeners.set(type, callback) }
  send(event: AgentStreamEvent) { this.listeners.get(event.type)?.(new MessageEvent(event.type, { data: JSON.stringify(event) })) }
}
const owner: ChapterStreamOwner = { novelId: 'a', scope: 'user:a:task-a', sessionId: 'session-a', epoch: 1 }
const resultEvent = (seq = 3, runId = 'run-a'): Extract<AgentStreamEvent, { type: 'tool.result' }> => ({
  type: 'tool.result', seq, runId, ts: '2026-10-15T00:00:00Z', messageId: 'message-a', callId: 'write-a', toolName: 'chapter_write', ok: true,
  summary: '已保存', display: { kind: 'chapterDiff', chapterId: 'chapter-a', chapterTitle: 'A', before: '原文', after: 'AI正文', revision: 7, appliedDirectly: true },
})
beforeEach(() => {
  Source.opened = []
  vi.stubGlobal('EventSource', Source)
  useAgentStore.setState({ runId: 'run-a', activeSessionId: 'session-a', phase: 'running', lastSeq: 0, messages: [], planFolderWriteReceipts: new Set() })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

function savedPlanHistory(runId: string, orders: number[]): AgentUIMessage[] {
  return [{ id: `${runId}-message`, runId, role: 'assistant', createdAt: '2026-11-27T02:05:00Z', parts: orders.map(order => ({
    type: 'tool-call', toolName: 'plan_save', callId: `${runId}-save-${order}`, title: '写入计划', args: null,
    status: 'success', display: { kind: 'planFile', artifactId: `${runId}-plan-${order}`, title: `第${order}章细纲`, content: '合成细纲。' },
  })) }]
}

it.each(['already active', 'active', 'completed'] as const)('refreshes the plan folder once when %s history supplies both missed receipts', (phase) => {
  const cloudFiles = Array.from({ length: 20 }, (_, index) => buildServerPlanFile({
    id: `plan-${index + 1}`, runId: 'run-a', title: `第${index + 1}章细纲`, content: '合成细纲。',
    createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString(),
    orderIndex: null, planKind: 'detail', planHash: 'a'.repeat(64), parentPlanId: 'parent', parentPlanHash: 'b'.repeat(64),
    target: { kind: 'future', targetOrderIndex: index + 1 }, reviewState: 'current',
  }))
  let sidebar = cloudFiles.slice(0, 18)
  const refresh = vi.fn(() => { sidebar = mergeWorkspacePlanFiles([], cloudFiles) })
  useAgentStore.setState({ workspaceActivities: [] })
  const history = savedPlanHistory('run-a', [19, 20])
  if (phase === 'already active') restoreActiveRunHistory(history, 'run-a', 'session-a', undefined, null, 10)
  const unsubscribe = observePlanFolderWrites('session-a', refresh)
  try {
    if (phase === 'active') restoreActiveRunHistory(history, 'run-a', 'session-a', undefined, null, 10)
    if (phase === 'completed') useAgentStore.getState().restoreMessages(history, 'session-a')
    expect(refresh).toHaveBeenCalledOnce()
    expect(sidebar).toHaveLength(20)
    expect(sidebar.slice(-2).map(file => file.backendArtifactId)).toEqual(['plan-19', 'plan-20'])
    useAgentStore.getState().restoreMessages(history, 'session-a')
    expect(refresh).toHaveBeenCalledOnce()
    useAgentStore.getState().restoreMessages(savedPlanHistory('run-b', [1]), 'session-b')
    expect(refresh).toHaveBeenCalledOnce()
  } finally { unsubscribe() }
})

it('refreshes on a saved plan SSE witness and ignores streaming deltas and replayed history while the session stays open', () => {
  const refresh = vi.fn()
  useAgentStore.setState({ workspaceActivities: [], loadedSessionId: 'session-a' })
  const unsubscribe = observePlanFolderWrites('session-a', refresh)
  const hook = renderHook(() => useAgentStream())
  try {
    act(() => hook.result.current.connect('run-a'))
    const source = Source.opened[0]
    const history = savedPlanHistory('run-a', [19])
    const part = history[0].parts[0]
    if (part.type !== 'tool-call') throw Error('Missing fixture receipt')
    const { id: messageId, createdAt: ts, runId } = history[0]
    const { callId, toolName, display, title } = part
    act(() => {
      source.send({ type: 'tool.call', seq: 1, ts, runId, messageId, callId, toolName, title, args: null })
      for (let seq = 2; seq < 10; seq++) source.send({ type: 'tool.delta', seq, ts, runId, messageId, callId, toolName, argsChars: seq * 50 })
    })
    expect(refresh).not.toHaveBeenCalled()
    act(() => source.send({ type: 'tool.result', seq: 10, ts, runId, messageId, callId, toolName, ok: true, summary: '已保存', display }))
    expect(refresh).toHaveBeenCalledOnce()
    const savedReceipts = useAgentStore.getState().planFolderWriteReceipts
    act(() => {
      for (let seq = 11; seq < 20; seq++) {
        useAgentStore.getState().applyEvent({ type: 'reasoning.delta', seq, ts, runId, messageId, delta: '合成流式推理' })
      }
    })
    expect(useAgentStore.getState().planFolderWriteReceipts).toBe(savedReceipts)
    expect(refresh).toHaveBeenCalledOnce()
    act(() => useAgentStore.getState().restoreMessages(history, 'session-a'))
    expect(refresh).toHaveBeenCalledOnce()
  } finally { unsubscribe() }
})

it('observes two runs that reuse the same provider call ID for the same plan', () => {
  const refresh = vi.fn()
  useAgentStore.setState({ workspaceActivities: [], loadedSessionId: 'session-a' })
  const unsubscribe = observePlanFolderWrites('session-a', refresh)
  const planResult = (runId: string, messageId: string): AgentStreamEvent => ({
    type: 'tool.result', runId, messageId, seq: 1, ts: '', callId: 'provider-call-0', toolName: 'plan_save',
    ok: true, summary: '已保存', display: { kind: 'planDiff', artifactId: 'plan-19', title: '第十九章细纲', beforeTitle: '第十九章细纲', before: '', after: runId },
  })
  try {
    useAgentStore.getState().applyEvent(planResult('run-a', 'message-a'))
    useAgentStore.getState().resumeRun('run-b', 'session-a')
    useAgentStore.getState().applyEvent(planResult('run-b', 'message-b'))
    expect(refresh).toHaveBeenCalledTimes(2)
    const { messages, workspaceActivities } = useAgentStore.getState()
    expect(workspaceActivities).toHaveLength(1)
    useAgentStore.getState().restoreMessages(messages, 'session-a')
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally { unsubscribe() }
})

it('observes a restored child receipt whose call ID overlaps a top-level save, and consumes its SSE replay once', () => {
  const refresh = vi.fn()
  const [message] = savedPlanHistory('run-a', [19])
  const saved = message.parts[0]
  if (saved.type !== 'tool-call') throw Error('Missing fixture receipt')
  const unsubscribe = observePlanFolderWrites('session-a', refresh)
  try {
    useAgentStore.getState().restoreMessages([message], 'session-a')
    expect(refresh).toHaveBeenCalledOnce()
    const restored = [{ ...message, parts: [...message.parts, { ...saved, subagentCallId: 'inline-writer' }] }]
    restoreActiveRunHistory(restored, 'run-a', 'session-a', undefined, null, 1)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().workspaceActivities).toHaveLength(1)
    useAgentStore.getState().applyEvent({ type: 'tool.result', runId: message.runId, messageId: message.id, seq: 2, ts: message.createdAt,
      callId: saved.callId, toolName: saved.toolName, subagentCallId: 'inline-writer', ok: true, summary: '已保存', display: saved.display })
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally { unsubscribe() }
})

it('rejects callbacks and errors from an old source even when a new connection resumes the same run', () => {
  const received = vi.fn(), error = vi.fn()
  const hook = renderHook(() => useAgentStream(received, error))
  act(() => hook.result.current.connect('run-a'))
  const old = Source.opened[0]
  act(() => hook.result.current.connect('run-a'))
  act(() => { old.send(resultEvent()); old.onerror?.() })
  expect(received).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
  expect(useAgentStore.getState().lastSeq).toBe(0)
  act(() => Source.opened[1].send(resultEvent()))
  expect(received).toHaveBeenCalledExactlyOnceWith(resultEvent())
})

it('forwards only store-accepted events and a foreign or duplicate terminal cannot close the active stream', () => {
  const received = vi.fn()
  const hook = renderHook(() => useAgentStream(received))
  act(() => hook.result.current.connect('run-a'))
  const source = Source.opened[0]
  act(() => { source.send(resultEvent()); source.send(resultEvent()); source.send({ type: 'run.paused', runId: 'other', seq: 9, ts: '', reason: 'needs_input' }); source.send({ type: 'run.paused', runId: 'run-a', seq: 2, ts: '', reason: 'needs_input' }) })
  expect(received).toHaveBeenCalledOnce(); expect(source.close).not.toHaveBeenCalled()
  act(() => source.send({ type: 'run.paused', runId: 'run-a', seq: 4, ts: '', reason: 'needs_input' }))
  expect(received).toHaveBeenCalledTimes(2); expect(source.close).toHaveBeenCalledOnce()
})

it.each(['foreign-run','user-role'] as const)('does not forward rejected tool ownership to workspace callbacks: %s',kind=>{
  const parts=[],message={id:'message-a',runId:kind==='foreign-run'?'old-run':'run-a',role:kind==='user-role'?'user' as const:'assistant' as const,parts,createdAt:'2026-10-15T00:00:00Z'}
  useAgentStore.setState({messages:[message],liveToolDrafts:{},workspaceActivities:[]})
  const received=vi.fn(),hook=renderHook(()=>useAgentStream(received))
  act(()=>hook.result.current.connect('run-a'))
  const source=Source.opened[0],base={runId:'run-a',messageId:'message-a',callId:'write-a',ts:message.createdAt,toolName:'chapter_write'}
  act(()=>source.send({...base,seq:1,type:'tool.delta',argsChars:20,draft:{kind:'chapter',toolName:'chapter_write',targetId:'chapter-a',content:'Rejected preview'}}))
  act(()=>source.send({...base,seq:2,type:'tool.call',title:'写入正文',args:{chapterId:'chapter-a'}}))
  act(()=>source.send(resultEvent(3)))
  expect(received).not.toHaveBeenCalled()
  expect(useAgentStore.getState()).toMatchObject({lastSeq:0,messages:[message],liveToolDrafts:{},workspaceActivities:[]})
  expect(source.close).not.toHaveBeenCalled()
})

it('retains the original host epoch when callbacks change before the old connection cleanup', () => {
  const received = vi.fn()
  const hook = renderHook(({ current }: { current: ChapterStreamOwner }) => {
    const latest = useRef(current); latest.current = current
    return useAgentStream(event => {
      const live = useAgentStore.getState()
      if (isWorkspaceStreamOwnerCurrent({ origin: current, current: latest.current, activeSessionId: live.activeSessionId, activeRunId: live.runId, eventRunId: event.runId })) received(event)
    })
  }, { initialProps: { current: owner } })
  act(() => hook.result.current.connect('run-a'))
  hook.rerender({ current: { ...owner, epoch: 3 } })
  act(() => Source.opened[0].send(resultEvent()))
  expect(received).not.toHaveBeenCalled()
})

it('keeps saved revision8 and pending body/plan baselines after A -> B -> A and actual seq0 stream replay', () => {
  const after = { id: 'chapter-a', title: 'A', content: 'AI正文', summary: '', revision: 7, status: 'draft' as const, visibility: 'private' as const, orderIndex: 1, localOnly: false }
  let review: ChapterPendingReview = { id: 'review-a', chapterId: after.id, runId: 'run-a', before: { ...after, content: '原文', revision: 6 }, after, rollbackSnapshot: { kind: 'restore_chapter', chapter: { ...after, content: '原文', wordCount: 2, updatedAt: null } }, description: '待确认', createdAt: '' }
  const plan: PlanPendingReview = { id: 'plan-a', backendArtifactId: 'plan-a', title: '计划', beforeTitle: '旧计划', before: '原计划', after: '最新计划', description: '待确认', runId: 'run-a', createdAt: '', lastAppliedEvent: { runId: 'run-a', seq: 5 } }
  const cursors = new Map<string, ReviewStreamCursor>()
  const applied = vi.fn()
  const hook = renderHook(({ current }: { current: ChapterStreamOwner }) => useAgentStream(event => {
    if (!claimWorkspaceStreamEvent(cursors, current, event)) return
    if (event.type !== 'tool.result') return
    if (event.display?.kind === 'chapterDiff') {
      if (isReviewStreamReplay(review.lastAppliedEvent, event) || isStaleChapterReview(event.display.revision, review.after.revision)) return
      applied(event)
    } else if (event.display?.kind === 'planFile' && !isReviewStreamReplay(plan.lastAppliedEvent, event)) applied(event)
  }), { initialProps: { current: owner } })
  act(() => hook.result.current.connect('run-a'))
  act(() => Source.opened[0].send(resultEvent()))
  // The switch save advances only after/revision; serialize and restore the same
  // pending review, exactly as the durable review storage does between novels.
  review = { ...review, after: { ...review.after, revision: 8, content: '作者保存的新输入' } }
  writeStoredPendingReview('pending:a', [review])
  act(() => { hook.result.current.disconnect(); useAgentStore.getState().resumeRun('run-b', 'session-b') })
  hook.rerender({ current: { novelId: 'b', scope: 'user:b:task-b', sessionId: 'session-b', epoch: 2 } })
  act(() => hook.result.current.connect('run-b'))
  act(() => { hook.result.current.disconnect(); useAgentStore.getState().resumeRun('run-a', 'session-a') })
  hook.rerender({ current: { ...owner, epoch: 3 } })
  review = readStoredPendingReviewList<ChapterPendingReview>('pending:a')[0]
  const saved = structuredClone(review)
  act(() => hook.result.current.connect('run-a', 0))
  const replay = Source.opened[2]
  expect(replay.url).toContain('/run-a/stream')
  act(() => { replay.send(resultEvent()); replay.send({ ...resultEvent(5), display: { kind: 'planFile', artifactId: 'plan-a', title: '计划', content: '旧的重放计划' } }) })
  expect(useAgentStore.getState().lastSeq).toBe(5)
  expect(applied).not.toHaveBeenCalled()
  expect(review).toEqual(saved); expect(review.after.revision).toBe(8)
  expect(plan).toMatchObject({ before: '原计划', after: '最新计划', runId: 'run-a', lastAppliedEvent: { seq: 5 } })
  const newer = { ...resultEvent(6), display: { ...resultEvent().display, kind: 'chapterDiff' as const, chapterId: 'chapter-a', chapterTitle: 'A', before: '作者保存的新输入', after: '后续真实修改', revision: 9, appliedDirectly: true } }
  act(() => replay.send(newer))
  expect(applied).toHaveBeenCalledExactlyOnceWith(newer)
})

it('rejects older revisions after a reload even without an in-memory replay cursor', () => {
  expect(isStaleChapterReview(7, 8, 8, 8)).toBe(true)
  expect(isStaleChapterReview(8, 8)).toBe(true)
  expect(isStaleChapterReview(9, 8)).toBe(false)
  expect(isStaleChapterReview(undefined, 8)).toBe(true)
  expect(isStaleChapterReview(7, undefined, 8)).toBe(true)
})

it('filters old and duplicate deltas before merging the next animation-frame batch', () => {
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const received = vi.fn()
  const hook = renderHook(() => useAgentStream(received))
  act(() => {
    hook.result.current.connect('run-a')
    useAgentStore.setState({ lastSeq: 5, messages: [{ id: 'm', runId: 'run-a', role: 'assistant', parts: [], createdAt: '' }] })
  })
  const source = Source.opened[0]
  const delta = (seq: number, text: string): AgentStreamEvent => ({ type: 'text.delta', runId: 'run-a', messageId: 'm', seq, delta: text, ts: '' })
  // The actual author-text stream publishes complete paragraphs, not partial prose.
  act(() => { source.send(delta(5, '旧')); source.send(delta(6, '新')); source.send(delta(6, '重复')); source.send(delta(7, '内容\n\n')); frame?.(0) })
  expect(received).toHaveBeenCalledExactlyOnceWith(delta(7, '新内容\n\n'))
  expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'text', text: '新内容\n\n' }])
})

it('flushes a scheduled visible frame when hidden, then keeps background deltas flowing without rAF', () => {
  vi.useFakeTimers()
  let hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const frame = vi.fn(() => 41), cancel = vi.fn()
  vi.stubGlobal('requestAnimationFrame', frame)
  vi.stubGlobal('cancelAnimationFrame', cancel)
  const received = vi.fn(), hook = renderHook(() => useAgentStream(received))
  act(() => {
    useAgentStore.setState({ messages: [{ id: 'm', runId: 'run-a', role: 'assistant', parts: [], createdAt: '' }] })
    hook.result.current.connect('run-a')
  })
  const source = Source.opened[0]
  const delta = (seq: number): AgentStreamEvent => ({ type: 'text.delta', runId: 'run-a', messageId: 'm', seq, delta: `第${seq}段。\n\n`, ts: '' })
  act(() => source.send(delta(1)))
  expect(frame).toHaveBeenCalledOnce()
  expect(received).not.toHaveBeenCalled()
  act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) })
  expect(cancel).toHaveBeenCalledWith(41)
  expect(received).toHaveBeenCalledExactlyOnceWith(delta(1))
  act(() => { source.send(delta(2)); vi.advanceTimersByTime(100) })
  expect(received).toHaveBeenCalledTimes(2)
  expect(useAgentStore.getState().lastSeq).toBe(2)
  expect(frame).toHaveBeenCalledOnce()
  act(() => source.send(delta(3)))
  expect(vi.getTimerCount()).toBe(1)
  act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) })
  expect(received).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
  expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'text', text: '第1段。\n\n第2段。\n\n第3段。\n\n' }])
  hook.unmount()
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(received).toHaveBeenCalledTimes(3)
})

it('clears a background batch before cancellation and cannot deliver it into a switched run', () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  const received = vi.fn(), hook = renderHook(() => useAgentStream(received))
  act(() => hook.result.current.connect('run-a'))
  const source = Source.opened[0]
  const delta: AgentStreamEvent = { type: 'reasoning.delta', runId: 'run-a', messageId: 'm', seq: 1, delta: '合成思考。', ts: '' }
  const cancelled: AgentStreamEvent = { type: 'run.finished', runId: 'run-a', seq: 2, ts: '', status: 'cancelled',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, artifacts: [], outputSummary: '' }
  act(() => source.send(delta))
  expect(vi.getTimerCount()).toBe(1)
  act(() => source.send(cancelled))
  expect(received.mock.calls.map(call => call[0])).toEqual([delta, cancelled])
  expect(source.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  act(() => {
    useAgentStore.setState({ runId: 'run-b', phase: 'running', lastSeq: 0, messages: [] })
    hook.result.current.connect('run-b')
    source.send({ ...delta, seq: 3 })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.runOnlyPendingTimers()
  })
  expect(received).toHaveBeenCalledTimes(2)
  expect(useAgentStore.getState()).toMatchObject({ runId: 'run-b', lastSeq: 0, messages: [] })
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
