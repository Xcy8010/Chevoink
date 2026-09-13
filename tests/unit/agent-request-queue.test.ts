import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), query: vi.fn(),
  owned: vi.fn(), find: vi.fn(), unique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), many: vi.fn(), latest: vi.fn(), start: vi.fn(), active: vi.fn(), activeId: vi.fn(), stop: vi.fn(), fork: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: { $transaction: mocks.transaction, user: { findUnique: async () => ({ bannedAt: null }) }, agentSession: { findFirst: mocks.owned }, agentRun: { findFirst: mocks.latest }, agentQueuedRequest: { findFirst: mocks.find, findUnique: mocks.unique, count: mocks.count, create: mocks.create, updateMany: mocks.update, findMany: mocks.many } },
}))
vi.mock('../../api/lib/agent/run-service.js', () => ({ startLoopRunLocked: mocks.start, forkAgentSessionData: mocks.fork, toAgentSession: (s: unknown) => s }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ hasActiveRunInSession: mocks.active, getActiveRunIdBySession: mocks.activeId, stopAgentRun: mocks.stop }))
import { actOnQueuedRequest, dispatchQueuedRequests, enqueueRequest, listQueuedRequests, queueCanDispatch } from '../../api/lib/agent/request-queue.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { withUserRunLock } from '../../api/lib/agent/run-lock.js'

const input = { sessionId: 's', novelId: 'n', prompt: '写第20章', mode: 'build' as const, modelTier: 'speed' as const }
const item = { id: 'q', sessionId: 's', userId: 'u', payload: input, status: 'pending', revision: 0, priority: 0, error: null }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([{ id: 'n' }])
  mocks.transaction.mockImplementation(work => work({ $queryRaw: mocks.query,
    agentQueuedRequest: { findUnique: mocks.unique, count: mocks.count, create: mocks.create } }))
  mocks.owned.mockResolvedValue({ id: 's', novelId: 'n', userId: 'u' })
  mocks.find.mockResolvedValue(item)
  mocks.many.mockResolvedValue([item])
  mocks.latest.mockResolvedValue({ id: 'r', status: 'completed' })
  mocks.count.mockResolvedValue(0)
  mocks.update.mockResolvedValue({ count: 1 })
  mocks.start.mockResolvedValue({ runId: 'next' })
})
describe('durable request queue', () => {
  it('holds the shared novel lock before admitting a pending request', async () => {
    await enqueueRequest('u', 'q', input)
    expect(mocks.query.mock.calls[1][0].join('?')).toBe('SELECT id FROM novels WHERE id = ? FOR UPDATE')
    expect(mocks.query.mock.calls[1][1]).toBe('n')
    expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(mocks.create.mock.invocationCallOrder[0])
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })
  it.each(['running', 'queued', 'awaiting_approval', 'paused', 'failed', 'cancelled'])('ordinary queue waits on %s', status => {
    expect(queueCanDispatch(status, 0)).toBe(false)
  })
  it('steering still waits for termination, never approval or running', () => {
    expect(queueCanDispatch('paused', 1)).toBe(true)
    expect(queueCanDispatch('running', 1)).toBe(false)
    expect(queueCanDispatch('awaiting_approval', 1)).toBe(false)
  })
  it('admission is idempotent for a repeated submission id', async () => {
    mocks.unique.mockResolvedValue(item)
    await enqueueRequest('u', 'q', input)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects cross-user access and cross-novel requests before writes', async () => {
    mocks.owned.mockResolvedValueOnce(null)
    await expect(enqueueRequest('other', 'q', input)).rejects.toMatchObject({ status: 404 })
    await expect(enqueueRequest('u', 'q', { ...input, novelId: 'other' })).rejects.toMatchObject({ status: 400 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('retains input snapshots and does not launch on enqueue', async () => {
    await enqueueRequest('u', 'q', input)
    expect(mocks.create).toHaveBeenCalledWith({ data: { id: 'q', userId: 'u', sessionId: 's', payload: input } })
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('claims only after the old executor deregisters', async () => {
    mocks.active.mockReturnValue(true)
    await dispatchQueuedRequests()
    expect(mocks.start).not.toHaveBeenCalled()
    mocks.active.mockReturnValue(false)
    await dispatchQueuedRequests()
    expect(mocks.start).toHaveBeenCalledWith('u', input, { queuedRequest: { id: 'q', revision: 0 } })
  })
  it('steer persists first, aborts current run and never starts inline', async () => {
    mocks.activeId.mockReturnValue('current')
    await actOnQueuedRequest('u', 's', 'q', 'steer', 0)
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ priority: 1, status: 'pending' }) }))
    expect(mocks.stop).toHaveBeenCalledWith('current')
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('stale edit/delete/steer cannot change an already dispatched request', async () => {
    mocks.find.mockResolvedValue(null)
    await expect(actOnQueuedRequest('u', 's', 'q', 'delete', 0)).rejects.toMatchObject({ code: 'QUEUE_CHANGED' })
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('startup failure holds the request; concurrency limits only defer it', async () => {
    mocks.start.mockRejectedValueOnce(new DataAccessError(409, 'RUN_LIMIT', 'limit'))
    await dispatchQueuedRequests()
    expect(mocks.update).not.toHaveBeenCalled()
    mocks.start.mockRejectedValueOnce(new Error('offline'))
    await dispatchQueuedRequests()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'held' }) }))
  })
  it('a held head blocks later ordinary items and failures are visible', async () => {
    mocks.find.mockResolvedValue({ ...item, status: 'held' })
    await dispatchQueuedRequests()
    expect(mocks.start).not.toHaveBeenCalled()
    mocks.latest.mockResolvedValue({ id: 'r', status: 'failed' })
    expect((await listQueuedRequests('u', 's')).items[0].error).toContain('当前任务已停止')
  })
  it('serializes same-account async operations and releases after rejection', async () => {
    let release!: () => void
    const events: number[] = []
    const first = withUserRunLock('lock', async () => { events.push(1); await new Promise<void>(resolve => { release = resolve }); events.push(2) })
    const second = withUserRunLock('lock', async () => { events.push(3); throw new Error('test') })
    const failure = expect(second).rejects.toThrow('test')
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual([1])
    release(); await first; await failure
    await withUserRunLock('lock', async () => { events.push(4) })
    expect(events).toEqual([1, 2, 3, 4])
  })
})
