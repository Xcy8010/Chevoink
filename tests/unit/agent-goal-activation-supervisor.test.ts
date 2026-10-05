import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoal } from '@prisma/client'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { activationReceiptSchema } from '../../api/lib/agent/goal-activation.js'
import type { GoalTx } from '../../api/lib/agent/goal-store.js'

const mocks = vi.hoisted(() => ({ activation: vi.fn(), source: vi.fn(), inspect: vi.fn(), change: vi.fn(), active: vi.fn() }))
vi.mock('../../api/lib/agent/goal-activation.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/goal-activation.js')>(),
  readGoalActivationReceipt: mocks.activation, readActivationSource: mocks.source }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ getActiveRun: mocks.active }))
vi.mock('../../api/lib/agent/goal-evidence.js', () => ({ inspectGoalEvidence: mocks.inspect }))
vi.mock('../../api/lib/agent/goal-execution-control.js', () => ({ readGoalExecutionControl: async () => ({ version: 3, controlPolicy: 'until_completion',
  origin: 'unknown_legacy', limits: { tokens: null, turns: null, activeTimeMs: null } }) }))
vi.mock('../../api/lib/agent/goal-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/goal-store.js')>(), changeGoal: mocks.change }))
import { reconcileGoalActivation } from '../../api/lib/agent/goal-activation-supervisor.js'

function fixture(status = 'completed', goalStatus = 'active') {
  const run = { id: 'source', status, taskRootId: null, taskSpec: { id: 'root' }, startRequest: { prompt: '任务' }, currentTurn: 0, startedAt: null, events: [], usage: {} }
  const original = { id: 'human', parts: [{ type: 'text', text: '任务' }] }
  const source = { run, original, sourceRootId: 'root', options: { mode: 'build' }, objective: '写下一章', journal: null,
    consentHash: 'consent', admitted: { grant: { requestHash: 'request' } } }
  const receipt = activationReceiptSchema.parse({ version: 1, sourceRunId: run.id, activationRunId: run.id, sourceRootId: 'root', sourceMessageId: 'human',
    requestHash: 'request', startHash: runtimeJson(run.startRequest).hash, specHash: runtimeJson(run.taskSpec).hash,
    messageHash: runtimeJson(original.parts).hash, optionsHash: runtimeJson(source.options).hash, authorityHash: runtimeJson([]).hash,
    consentHash: 'consent', consentRequestId: null, callId: 'call', toolAuthority: [], baselineBound: false })
  const goal = { id: 'goal', userId: 'owner', sessionId: 'session', novelId: 'novel', currentRevision: 1, pendingRevision: null,
    status: goalStatus, currentRunId: run.id, executionOptions: source.options, continuationIndex: 0, epoch: 2n, phase: 'reconciling' } as unknown as AgentGoal
  const budget = { tokensUsed: 0n, tokenLimit: 1000n, activeTimeMs: 0n, activeTimeLimitMs: 1000n }
  const db = {
    $queryRaw: vi.fn(), agentGoalRevision: { findUniqueOrThrow: vi.fn().mockResolvedValue({ objective: source.objective, authorityHash: runtimeJson(receipt).hash }) },
    agentRun: { findMany: vi.fn().mockResolvedValueOnce([run]).mockResolvedValue([]) }, agentRunLease: { count: vi.fn().mockResolvedValue(0) },
    agentOperation: { count: vi.fn().mockResolvedValue(0) }, aiUsageLog: { findMany: vi.fn().mockResolvedValue([]) },
    agentProviderAttempt: { findMany: vi.fn().mockResolvedValue([]) }, agentGoalUsage: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(0), create: vi.fn() },
    agentGoalBudget: { findUniqueOrThrow: vi.fn().mockResolvedValue(budget), update: vi.fn() },
    agentGoalExecution: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    agentGoalEvidence: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
  }
  mocks.activation.mockResolvedValue({ evidence: { id: 'receipt' }, receipt }); mocks.source.mockResolvedValue(source)
  mocks.change.mockImplementation(async (_tx, previous, data) => ({ goal: { ...previous, ...data }, snapshot: {} }))
  mocks.inspect.mockResolvedValue({ needsScopeDecision: false, blockers: [], hasDeliverable: false, requirements: { needsAuthorVerification: false } })
  return { goal, run, db, tx: db as unknown as GoalTx, budget }
}
beforeEach(() => { vi.resetAllMocks(); mocks.active.mockReturnValue(null) })
describe('deferred activation reconciliation barriers', () => {
  it('keeps a live source ordinary and never binds it before settlement', async () => {
    const f = fixture('running')
    expect(await reconcileGoalActivation(f.tx, f.goal, new Date())).toBe(true)
    expect(f.db.agentGoalExecution.create).not.toHaveBeenCalled(); expect(mocks.change).not.toHaveBeenCalled()
  })
  it('imports unknown receipts monotonically and does not interpret missing usage as zero', async () => {
    const f = fixture()
    f.db.aiUsageLog.findMany.mockResolvedValue([{ id: 'usage', agentRunId: 'source' }])
    expect(await reconcileGoalActivation(f.tx, f.goal, new Date())).toBe(true)
    expect(f.db.agentGoalUsage.create).toHaveBeenCalledWith({ data: { sourceKey: 'legacy:usage', goalId: 'goal', runId: 'source', status: 'unknown' } })
    expect(f.db.agentGoalExecution.create).not.toHaveBeenCalled()
  })
  it('parks a completed ordinary run with no deliverable proof without creating another paid task', async () => {
    const f = fixture()
    await reconcileGoalActivation(f.tx, f.goal, new Date())
    expect(f.db.agentGoalExecution.create).toHaveBeenCalledWith({ data: {
      goalId: 'goal', goalRevision: 1, epoch: 2n, runId: 'source', taskRootId: null, continuationIndex: 1,
      trigger: 'author', sourceEventId: 'activation:goal:source',
    } })
    expect(f.db.agentGoalEvidence.update).toHaveBeenCalledWith({ where: { id: 'receipt' }, data: {
      receipt: expect.objectContaining({ sourceRunId: 'source', activationRunId: 'source', sourceRootId: 'root', sourceMessageId: 'human',
        requestHash: 'request', consentHash: 'consent', baselineBound: true }),
    } })
    expect(mocks.change).toHaveBeenLastCalledWith(f.tx, expect.anything(), expect.objectContaining({ phase: 'awaiting_input', reasonCode: 'GOAL_ACTIVATION_AUTHOR_INPUT_REQUIRED' }), 'activation.waiting')
  })
  it('keeps settled model-spawned children as subagents within the original activation receipt', async () => {
    const f = fixture()
    f.db.agentRun.findMany.mockReset().mockResolvedValueOnce([f.run]).mockResolvedValueOnce([{ id: 'child', status: 'completed', taskRootId: null }])
    await reconcileGoalActivation(f.tx, f.goal, new Date())
    expect(f.db.agentGoalExecution.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({
      runId: 'source', trigger: 'author', sourceEventId: 'activation:goal:source', continuationIndex: 1,
    }) })
    expect(f.db.agentGoalExecution.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({
      runId: 'child', trigger: 'subagent', sourceEventId: 'activation:goal:child', continuationIndex: 2,
    }) })
    expect(f.db.agentGoalExecution.create).toHaveBeenCalledTimes(2)
  })
  it('accepts actual domain completion without a second round', async () => {
    const f = fixture()
    mocks.inspect.mockResolvedValue({ needsScopeDecision: false, blockers: [], hasDeliverable: true, objective: '写下一章', progressHash: 'domain', requirements: { needsAuthorVerification: false } })
    await reconcileGoalActivation(f.tx, f.goal, new Date())
    expect(mocks.change).toHaveBeenLastCalledWith(f.tx, expect.anything(), expect.objectContaining({ status: 'completed' }), 'completed')
  })
  it.each(['paused', 'cancelled'])('settles a %s goal without reviving or changing its human control', async status => {
    const f = fixture('paused', status)
    expect(await reconcileGoalActivation(f.tx, f.goal, new Date())).toBe(true)
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.change.mock.calls.every(call => !('status' in call[2]))).toBe(true)
  })
  it('requires the current durable human resume epoch and ignores unverifiable historical caps', async () => {
    const f = fixture('paused')
    f.db.agentGoalEvidence.findUnique.mockResolvedValue({ status: 'verified', receipt: { epoch: '2', sourceRunId: 'source' } })
    expect(await reconcileGoalActivation(f.tx, f.goal, new Date())).toMatchObject({ kind: 'activation_continue', runId: 'source' })
    const limited = fixture('paused'); limited.budget.tokensUsed = 1000n
    limited.db.agentGoalEvidence.findUnique.mockResolvedValue({ status: 'verified', receipt: { epoch: '2', sourceRunId: 'source' } })
    expect(await reconcileGoalActivation(limited.tx, limited.goal, new Date())).toMatchObject({ kind: 'activation_continue', runId: 'source' })
  })
})
