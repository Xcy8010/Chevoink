import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), message: vi.fn(), execute: vi.fn(), active: vi.fn(() => false), prepare: vi.fn(),
  transaction: vi.fn(), tx: { $queryRaw: vi.fn(), agentRun: { findFirst: vi.fn() } },
}))
vi.mock('../../api/lib/agent/events.js', () => ({ prepareRunEventResume: mocks.prepare }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: { $transaction: mocks.transaction, agentRun: { findFirst: mocks.find, count: mocks.count }, agentMessage: { findFirst: mocks.message }, agentQueuedRequest: { findFirst: vi.fn(async () => null) } },
}))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(), getModelTierRuntime: vi.fn() }))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: mocks.execute }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ getActiveRun: () => undefined, hasActiveRunInSession: mocks.active, countActiveRunsByUser: () => 0 }))
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
const run = { id: 'run19', sessionId: 's', userId: 'u', novelId: 'n', chapterId: 'c19', status: 'paused', engine: 'loop', mode: 'build', inputSummary: 'truncated', modelTier: 'speed', reasoningEffort: 'high', customModelId: null }
beforeEach(() => {
  vi.resetAllMocks()
  // Keep the transactional ownership/epoch query separate from the exact-target
  // and latest-run reads, so their ordered fixtures retain their original meaning.
  mocks.transaction.mockImplementation(callback => callback(mocks.tx))
  mocks.tx.$queryRaw.mockResolvedValue([{ id: 'n' }])
  mocks.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 0 } })
  mocks.active.mockReturnValue(false)
  mocks.count.mockResolvedValue(0)
  mocks.prepare.mockResolvedValue(72)
  mocks.find.mockResolvedValueOnce(run).mockResolvedValue({ id: 'run19' })
  mocks.message.mockResolvedValue({ parts: [{ type: 'text', text: '写第19章。' + '完整原始要求'.repeat(100) }] })
})
describe('continue API exact target', () => {
  it.each([null, { parts: [] }, { parts: [{ type: 'text', text: '   ' }] }])('does not reconstruct a missing original request from inputSummary: %j', async message => {
    mocks.message.mockResolvedValue(message)
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_INPUT_REQUIRED' })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it.each([null, {}, { version: 99 }])('does not downgrade malformed stored authorization to a legacy writing run: %j', async authorization => {
    mocks.find.mockReset().mockResolvedValueOnce({ ...run, taskSpec: { id: 'root', authorization } }).mockResolvedValue({ id: run.id })
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'TASK_AUTHORIZATION_INVALID', status: 409 })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it('resumes the requested run with full original input, not the 300-char summary', async () => {
    expect(await continueLoopRun('u', 'run19')).toMatchObject({ runId: 'run19' })
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join('?')).toBe('SELECT id FROM novels WHERE id = ? FOR UPDATE')
    expect(mocks.tx.$queryRaw.mock.calls[0][1]).toBe('n')
    expect(mocks.tx.agentRun.findFirst).toHaveBeenCalledWith({
      where: { id: 'run19', userId: 'u', novelId: 'n' },
      select: { manuscriptRevision: true, novel: { select: { authorId: true, manuscriptRevision: true } } },
    })
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ runId: 'run19', chapterId: 'c19', resume: true, eventStartSeq: 72 })
    expect(mocks.execute.mock.calls[0][0].prompt.length).toBeGreaterThan(300)
  })
  it('does not dispatch or overwrite a journal while its pending events cannot be saved', async () => {
    mocks.prepare.mockRejectedValue(new Error('db unavailable'))
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_EVENTS_PENDING', status: 503 })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('rechecks concurrent work after asynchronous journal recovery', async () => {
    mocks.prepare.mockImplementation(async () => { mocks.active.mockReturnValue(true); return 72 })
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('does not ignore queued persistent work when this process has no active controller', async () => {
    mocks.count.mockResolvedValue(Number.MAX_SAFE_INTEGER)
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_LIMIT' })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.count).toHaveBeenCalledWith({ where: { userId: 'u', status: { in: ['queued', 'running', 'awaiting_approval'] } } })
  })
  it('rejects stale resume after a newer task exists and never starts it', async () => {
    mocks.find.mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({ id: 'run20' })
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'STALE_RESUME_TARGET', status: 409 })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('cannot use the resume API to start a completed run or overlap live work', async () => {
    mocks.find.mockReset().mockResolvedValue({ ...run, status: 'completed' })
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
    mocks.find.mockResolvedValue(run)
    mocks.active.mockReturnValue(true)
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
