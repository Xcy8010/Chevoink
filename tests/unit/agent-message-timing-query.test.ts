import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ agentRun: { findMany: vi.fn() }, agentExecutionOutbox: { findMany: vi.fn() } }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: db }))
vi.mock('../../api/lib/agent/runtime-child.js', () => ({ MAIN_RUN_FILTER: { incomingChildGrant: { is: null } } }))
import { loadMessageTimings } from '../../api/lib/agent/message-timing.js'
import { runElapsedMs } from '../../shared/agent-timing.js'

const date = (seconds: number) => new Date(Date.UTC(2026, 9, 18) + seconds * 1000)
const transition = (type: string, seq: number, seconds: number) => ({ type, seq, payload: { ts: date(seconds).toISOString() } })
beforeEach(() => vi.resetAllMocks())
it('scopes timing reads to the authenticated session and only the requested run window', async () => {
  db.agentRun.findMany.mockResolvedValue([{ id: 'r', status: 'completed', startedAt: date(0), finishedAt: date(10), runtimeProtocolVersion: 0, taskRootId: null,
    events: [transition('run.started', 1, 0), transition('run.finished', 2, 10)] }])
  const result = await loadMessageTimings('owner', 'session', ['r', 'r'])
  expect(db.agentRun.findMany).toHaveBeenCalledOnce()
  expect(db.agentRun.findMany.mock.calls[0][0].where).toEqual({ userId: 'owner', sessionId: 'session', incomingChildGrant: { is: null }, id: { in: ['r'] } })
  expect(result.get('r')).toMatchObject({ scopeId: 'r', sourceRunId: 'r', elapsedMs: 10000, status: 'finished' })
  expect(result.get('r')?.completedAt).toBe(date(10).toISOString())
  expect(db.agentExecutionOutbox.findMany).not.toHaveBeenCalled()
})
it('includes resumed runs with no message row, using durable pause sources rather than old start replay', async () => {
  const first = { id: 'old', status: 'paused', startedAt: date(0), finishedAt: null, runtimeProtocolVersion: 1, taskRootId: 'root', events: [transition('run.started', 1, 0)] }
  const resumed = { ...first, id: 'new', status: 'running', startedAt: date(100) }
  db.agentRun.findMany.mockResolvedValueOnce([first]).mockResolvedValueOnce([first, resumed])
  db.agentExecutionOutbox.findMany.mockResolvedValue([{ payload: { runIds: ['old'] }, createdAt: date(10) }])
  const result = await loadMessageTimings('owner', 'session', ['old'])
  expect(db.agentRun.findMany.mock.calls[1][0].where).toMatchObject({ userId: 'owner', sessionId: 'session', taskRootId: { in: ['root'] }, runtimeProtocolVersion: 1 })
  expect(result.get('old')).toEqual(result.get('new'))
  expect(result.get('old')).toMatchObject({ scopeId: 'root:root', sourceRunId: 'new', lastSeq: 1 })
  expect(runElapsedMs(result.get('old')!, date(105).getTime())).toBe(15000)
})
it('does not invent durations for malformed legacy events, missing pauses, or unstarted admissions', async () => {
  db.agentRun.findMany.mockResolvedValue([
    { id: 'queued', status: 'queued', startedAt: null, finishedAt: null, events: [] },
    { id: 'broken', status: 'failed', startedAt: date(0), finishedAt: date(10), events: [{ type: 'run.started', seq: 1, payload: null }] },
  ])
  const result = await loadMessageTimings('owner', 'session', ['queued', 'broken'])
  expect(result.has('queued')).toBe(false)
  expect(result.get('broken')?.elapsedMs).toBeNull()
})
it('does not query when the authorized history window is empty', async () => {
  expect(await loadMessageTimings('owner', 'session', [])).toEqual(new Map())
  expect(db.agentRun.findMany).not.toHaveBeenCalled()
})
