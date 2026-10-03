import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), message: vi.fn(), execute: vi.fn(), active: vi.fn(() => false), prepare: vi.fn(),
  runUpdate: vi.fn(), creditAccess: vi.fn(), tierRuntime: vi.fn(), goal: vi.fn(), binding: vi.fn(),
  lockGoal: vi.fn(), activationSource: vi.fn(), reconcile: vi.fn(), resumeDurable: vi.fn(), pause: vi.fn(),
  transaction: vi.fn(), tx: { $queryRaw: vi.fn(), agentRun: { findFirst: vi.fn() }, agentGoalExecution: { findUnique: vi.fn(async () => null) } },
}))
vi.mock('../../api/lib/agent/events.js', () => ({ prepareRunEventResume: mocks.prepare }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: { $transaction: mocks.transaction, agentRun: { findFirst: mocks.find, count: mocks.count, update: mocks.runUpdate }, agentGoal: { findFirst: mocks.goal }, agentGoalExecution: { findUnique: mocks.binding }, agentMessage: { findFirst: mocks.message }, agentQueuedRequest: { findFirst: vi.fn(async () => null) }, agentExecutionOutbox: { findFirst: mocks.pause } },
}))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: mocks.creditAccess, getModelTierRuntime: mocks.tierRuntime }))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: mocks.execute }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ getActiveRun: () => undefined, hasActiveRunInSession: mocks.active, countActiveRunsByUser: () => 0 }))
vi.mock('../../api/lib/agent/goal-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/goal-store.js')>(), lockOwnedGoal: mocks.lockGoal }))
vi.mock('../../api/lib/agent/goal-activation.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/goal-activation.js')>(), readGoalActivationReceipt: mocks.activationSource }))
vi.mock('../../api/lib/agent/goal-activation-supervisor.js', () => ({ reconcileGoalActivation: mocks.reconcile }))
vi.mock('../../api/lib/agent/runtime-resume.js', () => ({ resumeDurableTask: mocks.resumeDurable }))
import { continueActivatedGoalRun, continueLoopRun } from '../../api/lib/agent/run-service.js'
const run = { id: 'run19', sessionId: 's', userId: 'u', novelId: 'n', chapterId: 'c19', status: 'paused', engine: 'loop', mode: 'build', inputSummary: 'truncated', modelTier: 'speed', reasoningEffort: 'high', customModelId: null }
beforeEach(() => {
  vi.resetAllMocks()
  // Keep the transactional ownership/epoch query separate from the exact-target
  // and latest-run reads, so their ordered fixtures retain their original meaning.
  mocks.transaction.mockImplementation(callback => callback(mocks.tx))
  mocks.tx.$queryRaw.mockResolvedValue([{ id: 'n' }])
  mocks.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 0 } })
  mocks.tx.agentGoalExecution.findUnique.mockResolvedValue(null)
  mocks.goal.mockResolvedValue(null)
  mocks.binding.mockResolvedValue(null)
  mocks.active.mockReturnValue(false)
  mocks.count.mockResolvedValue(0)
  mocks.prepare.mockResolvedValue(72)
  mocks.find.mockResolvedValueOnce(run).mockResolvedValue({ id: 'run19' })
  mocks.message.mockResolvedValue({ parts: [{ type: 'text', text: '写第19章。' + '完整原始要求'.repeat(100) }] })
})

function activatedFixture(durable = false) {
  const goal = { id: 'goal', status: 'active', currentRevision: 1, pendingRevision: null, epoch: 2n,
    currentRunId: run.id, reasonCode: 'GOAL_ACTIVATION_RESUME_READY' }
  mocks.binding.mockResolvedValue({ goalId: goal.id })
  mocks.lockGoal.mockResolvedValue(goal)
  mocks.activationSource.mockResolvedValue({ receipt: { baselineBound: true, toolAuthority: [] } })
  mocks.reconcile.mockResolvedValue({ kind: 'activation_continue', goal, runId: run.id })
  if (durable) {
    mocks.find.mockReset().mockResolvedValue({ ...run, runtimeProtocolVersion: 1, taskRootId: 'root' })
    mocks.pause.mockResolvedValue({ id: 'pause' })
    // A recorded paused attempt is returned without dispatching a fake executor.
    // The native transaction and live fence are exercised in the PostgreSQL gate.
    mocks.resumeDurable.mockResolvedValue({ run: { ...run, id: 'resumed', runtimeProtocolVersion: 1, taskRootId: 'root' } })
  }
  return goal
}
describe('continue API exact target', () => {
  it('validates the human activation before legacy manuscript admission and preserves the original ceiling', async () => {
    const goal = activatedFixture()
    expect(await continueActivatedGoalRun('u', run.id, goal.id, goal.epoch)).toMatchObject({ runId: run.id, runGoalId: goal.id })
    expect(mocks.lockGoal).toHaveBeenCalledWith(mocks.tx, 'u', run.sessionId, goal.id)
    expect(mocks.reconcile).toHaveBeenCalledWith(mocks.tx, goal, expect.any(Date))
    expect(mocks.tx.agentRun.findFirst).toHaveBeenCalledWith({ where: { id: run.id, userId: 'u', novelId: 'n' },
      select: { manuscriptRevision: true, novel: { select: { authorId: true, manuscriptRevision: true } } } })
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ activationResume: { goalId: goal.id, epoch: goal.epoch },
      toolAuthorityCeiling: new Map(), prompt: expect.any(String) }))
    expect(mocks.runUpdate).not.toHaveBeenCalled()
  })
  it('delegates verified durable activation to the formal resume transaction without fencing its paused source as a writer', async () => {
    const goal = activatedFixture(true)
    expect(await continueActivatedGoalRun('u', run.id, goal.id, goal.epoch)).toMatchObject({ runId: 'resumed', runGoalId: goal.id })
    expect(mocks.reconcile).toHaveBeenCalledWith(mocks.tx, goal, expect.any(Date))
    expect(mocks.tx.agentRun.findFirst).not.toHaveBeenCalled()
    expect(mocks.resumeDurable).toHaveBeenCalledWith({ userId: 'u', runId: run.id, pauseEventId: 'pause', activation: { goalId: goal.id, epoch: goal.epoch } })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it.each(['stale-epoch', 'cancelled', 'pending-revision', 'unsettled', 'missing-baseline', 'imported-manuscript'])('rejects activation %s before dispatch or spending', async kind => {
    const goal = activatedFixture()
    if (kind === 'stale-epoch') mocks.lockGoal.mockResolvedValue({ ...goal, epoch: 3n })
    if (kind === 'cancelled') mocks.lockGoal.mockResolvedValue({ ...goal, status: 'cancelled' })
    if (kind === 'pending-revision') mocks.lockGoal.mockResolvedValue({ ...goal, pendingRevision: 2 })
    if (kind === 'unsettled') mocks.reconcile.mockResolvedValue(true)
    if (kind === 'missing-baseline') mocks.activationSource.mockResolvedValue({ receipt: { baselineBound: false } })
    if (kind === 'imported-manuscript') mocks.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 1 } })
    const code = kind === 'imported-manuscript' ? 'IMPORT_SCOPE_CHANGED' : ['unsettled', 'missing-baseline'].includes(kind) ? 'GOAL_RECONCILIATION_REQUIRED' : 'GOAL_VERSION_CONFLICT'
    await expect(continueActivatedGoalRun('u', run.id, goal.id, goal.epoch)).rejects.toMatchObject({ code })
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.resumeDurable).not.toHaveBeenCalled()
    expect(mocks.runUpdate).not.toHaveBeenCalled(); expect(mocks.creditAccess).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it.each(['pending-activation', 'goal-bound'])('requires human goal controls for %s without changing model or starting paid work', async kind => {
    if (kind === 'pending-activation') mocks.goal.mockResolvedValue({ id: 'pending-goal' })
    else mocks.binding.mockResolvedValue({ goalId: 'bound-goal' })
    await expect(continueLoopRun('u', 'run19', { modelTier: 'lite', customModelId: null, reasoningEffort: 'high' }))
      .rejects.toMatchObject({ code: 'GOAL_RESUME_REQUIRED', status: 409 })
    expect(mocks.goal).toHaveBeenCalledWith({ where: { userId: 'u', sessionId: 's', currentRunId: 'run19',
      status: { notIn: ['completed', 'cancelled'] }, evidence: { some: { criterionId: 'activation-source' } } } })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.runUpdate).not.toHaveBeenCalled()
    expect(mocks.creditAccess).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
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
  it('does not mutate an old task model when a stale tab requests a model switch', async () => {
    mocks.find.mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({ id: 'new-run' })
    await expect(continueLoopRun('u', 'run19', { modelTier: 'lite', customModelId: null, reasoningEffort: 'high' }))
      .rejects.toMatchObject({ code: 'STALE_RESUME_TARGET' })
    expect(mocks.runUpdate).not.toHaveBeenCalled()
  })
  it('cannot use the resume API to start a completed run or overlap live work', async () => {
    mocks.find.mockReset().mockResolvedValue({ ...run, status: 'completed' })
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
    mocks.find.mockResolvedValue(run)
    mocks.active.mockReturnValue(true)
    await expect(continueLoopRun('u', 'run19')).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('follows the current model selection when resuming an old paid run', async () => {
    expect(await continueLoopRun('u', 'run19', { modelTier: 'lite', customModelId: null, reasoningEffort: 'high' })).toMatchObject({ runId: 'run19' })
    expect(mocks.creditAccess).toHaveBeenCalledWith('u', 'lite')
    expect(mocks.tierRuntime).toHaveBeenCalledWith('lite', 'u', null, 'high')
    expect(mocks.runUpdate).toHaveBeenCalledWith({ where: { id: 'run19' }, data: { modelTier: 'lite', customModelId: null, reasoningEffort: 'high' } })
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ runId: 'run19', modelTier: 'lite', customModelId: null, reasoningEffort: 'high', resume: true })
  })
  it('keeps the saved tier and skips the write-back when no model selection travels with the resume', async () => {
    expect(await continueLoopRun('u', 'run19')).toMatchObject({ runId: 'run19' })
    expect(mocks.creditAccess).toHaveBeenCalledWith('u', 'speed')
    expect(mocks.tierRuntime).toHaveBeenCalledWith('speed', 'u', null, 'high')
    expect(mocks.runUpdate).not.toHaveBeenCalled()
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ modelTier: 'speed', reasoningEffort: 'high' })
  })
})
