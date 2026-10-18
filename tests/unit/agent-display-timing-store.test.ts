import { beforeEach, expect, it } from 'vitest'
import { useAgentStore, readSessionMessagesCache } from '../../src/features/studio/agent/agentStore.js'
import { runElapsedMs } from '../../shared/agent-timing.js'
import type { AgentRunTiming, AgentStreamEvent, AgentUIMessage } from '../../shared/contracts/agent-events.js'

const ts = (seconds: number) => new Date(Date.UTC(2026, 9, 18) + seconds * 1000).toISOString()
const user: AgentUIMessage = { id: 'u', runId: 'r', role: 'user', parts: [], createdAt: ts(0) }
const start = (seq: number, seconds: number): AgentStreamEvent => ({ type: 'run.started', runId: 'r', seq, ts: ts(seconds), mode: 'act', title: '隔离测试', agent: { type: 'novelist', title: '测试', model: 'speed' } })
const finish = (status: 'succeeded' | 'failed' | 'cancelled', seq = 4, seconds = 10): AgentStreamEvent => ({ type: 'run.finished', runId: 'r', seq, ts: ts(seconds), status, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, artifacts: [], outputSummary: '' })
beforeEach(() => {
  useAgentStore.getState().resetRun()
  useAgentStore.setState({ runId: 'r', activeSessionId: 's', loadedSessionId: 's', phase: 'starting', messages: [{ ...user }], lastSeq: 0, workspaceActivities: [] })
})
const current = () => useAgentStore.getState().messages[0].runTiming!
it.each(['succeeded', 'failed', 'cancelled'] as const)('freezes %s runs using their terminal event', status => {
  useAgentStore.getState().applyEvent(start(1, 0))
  useAgentStore.getState().applyEvent({ type: 'message.start', runId: 'r', seq: 2, ts: ts(1), messageId: 'a', role: 'assistant' })
  expect(useAgentStore.getState().messages[1].runTiming).toEqual(current())
  useAgentStore.getState().applyEvent(finish(status))
  expect(runElapsedMs(current(), Date.parse(ts(999)))).toBe(10000)
  expect(current().status).toBe('finished')
})
it('pauses, resumes in the same run, and preserves time through cache and history restoration', () => {
  const state = useAgentStore.getState()
  state.applyEvent(start(1, 0))
  state.applyEvent({ type: 'run.paused', runId: 'r', seq: 2, ts: ts(10), reason: 'user_stop' })
  expect(runElapsedMs(current(), Date.parse(ts(99)))).toBe(10000)
  state.resumeRun('r', 's')
  state.applyEvent(start(3, 100))
  expect(runElapsedMs(current(), Date.parse(ts(105)))).toBe(15000)
  state.resetRun()
  const cached = readSessionMessagesCache('s')!
  expect(cached[0].runTiming?.activeSince).toBe(ts(100))
  state.restoreMessages(cached, 's')
  state.resumeRun('r', 's')
  state.applyEvent(start(3, 100)) // already included in the snapshot
  expect(runElapsedMs(current(), Date.parse(ts(107)))).toBe(17000)
})
it('rejects late events and timing responses after a session switch', () => {
  useAgentStore.getState().applyEvent(start(1, 0))
  const original = current()
  useAgentStore.getState().reconcileRunTimings([{ ...user, runTiming: { ...original, elapsedMs: 99999 } }], 'other', 'r')
  useAgentStore.getState().applyEvent({ ...start(2, 5), runId: 'other' })
  expect(current()).toEqual(original)
  useAgentStore.getState().reconcileRunTimings([{ ...user, runTiming: { ...original, lastSeq: 0, elapsedMs: 99999 } }], 's', 'r')
  expect(current()).toEqual(original)
})
it('reconciles durable resume timing on retained message identities without counting root replay', () => {
  const timing: AgentRunTiming = { scopeId: 'root:root', sourceRunId: 'new', elapsedMs: 10000, activeSince: ts(100), status: 'running', lastSeq: 1 }
  useAgentStore.setState({ runId: 'new', messages: [{ ...user, runTiming: { ...timing, sourceRunId: 'r', activeSince: null, status: 'paused' } }] })
  useAgentStore.getState().reconcileRunTimings([{ ...user, runTiming: timing }], 's', 'new')
  useAgentStore.getState().applyEvent({ ...start(1, 0), runId: 'new' })
  expect(runElapsedMs(current(), Date.parse(ts(105)))).toBe(15000)
  useAgentStore.getState().applyEvent({ ...finish('succeeded', 2, 110), runId: 'new' })
  expect(runElapsedMs(current(), Date.parse(ts(999)))).toBe(20000)
})
it('keeps the real completion time on assistant identities retained from a prior durable run', () => {
  useAgentStore.setState({ runId: 'new', messages: [{ ...user, role: 'assistant', runTiming: {
    scopeId: 'root:root', sourceRunId: 'new', elapsedMs: 10000, activeSince: ts(100), status: 'running', lastSeq: 1,
  } }] })
  useAgentStore.getState().applyEvent({ ...finish('succeeded', 2, 110), runId: 'new' })
  expect(useAgentStore.getState().messages[0].completedAt).toBe(ts(110))
})
it('settles a lost terminal frame from a status read, but never invents a missing stop', () => {
  useAgentStore.getState().applyEvent(start(1, 0))
  useAgentStore.getState().syncRemoteRunStatuses({ s: { runId: 'r', status: 'failed', finishedAt: ts(10) } })
  expect(runElapsedMs(current(), Date.parse(ts(99)))).toBe(10000)
  expect(current().lastSeq).toBe(1)
  useAgentStore.setState({ phase: 'running', messages: [{ ...user, runTiming: { elapsedMs: 0, activeSince: ts(0), status: 'running', lastSeq: 1 } }] })
  useAgentStore.getState().syncRemoteRunStatuses({ s: { runId: 'r', status: 'cancelled' } })
  expect(current()).toMatchObject({ status: 'finished', elapsedMs: null, activeSince: null })
})
it('stops nonrecoverable errors without changing body or billing', () => {
  useAgentStore.getState().applyEvent(start(1, 0))
  useAgentStore.getState().applyEvent({ type: 'error', runId: 'r', seq: 2, ts: ts(5), code: 'ISOLATED', message: '测试错误', recoverable: false })
  expect(current()).toMatchObject({ status: 'finished', elapsedMs: 5000 })
  expect(useAgentStore.getState().messages[0].parts).toEqual([])
  expect(useAgentStore.getState().usage.totalTokens).toBe(0)
})
