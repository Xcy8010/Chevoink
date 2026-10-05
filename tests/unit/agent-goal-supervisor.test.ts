import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'

const mocks = vi.hoisted(() => {
  const tx = {
    agentRun: { findUnique: vi.fn() },
    agentGoalBudget: { findUniqueOrThrow: vi.fn() },
    agentGoalUsage: { count: vi.fn() },
    agentGoalEvidence: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    agentQueuedRequest: { count: vi.fn() },
    agentGoalRevision: { findUniqueOrThrow: vi.fn() },
  }
  return {
    tx,
    prisma: { agentGoal: { findMany: vi.fn() } },
    lockOwnedGoal: vi.fn(),
    changeGoal: vi.fn(),
    closeGoalActivity: vi.fn(),
    databaseNow: vi.fn(),
    runtimeTransaction: vi.fn(),
    runtimeJson: vi.fn((value: unknown) => ({ value, hash: 'runtime-hash' })),
    inspectGoalEvidence: vi.fn(),
    startLoopRun: vi.fn(),
    reconcileGoalUsage: vi.fn(),
    stopAgentRun: vi.fn(),
    actOnAgentGoal: vi.fn(),
    revokeGoalExecutions: vi.fn(),
    readGoalExecutionControl: vi.fn(),
  }
})

vi.mock('../../api/lib/prisma.js', () => ({ prisma: mocks.prisma, DataAccessError: class DataAccessError extends Error {} }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ stopAgentRun: mocks.stopAgentRun }))
vi.mock('../../api/lib/agent/goal-service.js', () => ({
  actOnAgentGoal: mocks.actOnAgentGoal,
  revokeGoalExecutions: mocks.revokeGoalExecutions,
}))
vi.mock('../../api/lib/agent/goal-store.js', () => ({
  lockOwnedGoal: mocks.lockOwnedGoal,
  changeGoal: mocks.changeGoal,
  closeGoalActivity: mocks.closeGoalActivity,
}))
vi.mock('../../api/lib/agent/runtime-common.js', () => ({
  databaseNow: mocks.databaseNow,
  runtimeTransaction: mocks.runtimeTransaction,
  runtimeJson: mocks.runtimeJson,
}))
vi.mock('../../api/lib/agent/run-service.js', () => ({ startLoopRun: mocks.startLoopRun }))
vi.mock('../../api/lib/agent/goal-budget.js', () => ({ reconcileGoalUsage: mocks.reconcileGoalUsage }))
vi.mock('../../api/lib/agent/goal-execution-control.js', () => ({ readGoalExecutionControl: mocks.readGoalExecutionControl }))

let realNextGoalProgress: typeof import('../../api/lib/agent/goal-evidence.js').nextGoalProgress
vi.mock('../../api/lib/agent/goal-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/lib/agent/goal-evidence.js')>()
  realNextGoalProgress = actual.nextGoalProgress
  return { ...actual, inspectGoalEvidence: mocks.inspectGoalEvidence }
})

const { superviseAgentGoal } = await import('../../api/lib/agent/goal-supervisor.js')

const now = new Date('2026-09-28T00:00:00.000Z')

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1', userId: 'user-1', novelId: 'novel-1', sessionId: 'session-1',
    currentRevision: 1, pendingRevision: null, resumeStatus: null, status: 'active', phase: 'reviewing',
    stateVersion: 3, epoch: 1n, currentRunId: 'run-1', executionOptions: { mode: 'build' }, continuationIndex: 1,
    reasonCode: null, nextEligibleAt: null, blockFingerprint: null, blockCount: 0, progressHash: null,
    activeSince: null, finishedAt: null, ...overrides,
  }
}

function configure(candidate = goal()) {
  mocks.readGoalExecutionControl.mockResolvedValue({ version: 3, controlPolicy: 'until_completion', origin: 'system_default', limits: { tokens: null, turns: null, activeTimeMs: null } })
  mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
  mocks.lockOwnedGoal.mockResolvedValue(candidate)
  mocks.databaseNow.mockResolvedValue(now)
  mocks.reconcileGoalUsage.mockResolvedValue(undefined)
  mocks.tx.agentGoalBudget.findUniqueOrThrow.mockResolvedValue({ tokensUsed: 0n, tokenLimit: 100_000n, activeTimeMs: 0n, activeTimeLimitMs: 3_600_000n })
  mocks.tx.agentGoalUsage.count.mockResolvedValue(0)
  mocks.tx.agentQueuedRequest.count.mockResolvedValue(0)
  mocks.tx.agentRun.findUnique.mockResolvedValue({ id: 'run-1', status: 'completed', taskRootId: null })
  mocks.tx.agentGoalEvidence.findUnique.mockResolvedValue(null)
  mocks.tx.agentGoalEvidence.findFirst.mockResolvedValue(null)
  mocks.tx.agentGoalEvidence.create.mockResolvedValue(undefined)
  mocks.tx.agentGoalRevision.findUniqueOrThrow.mockResolvedValue({ revision: 1, objective: '写三章' })
  mocks.inspectGoalEvidence.mockResolvedValue({ progressHash: 'progress-1', blockers: [], needsScopeDecision: false,
    hasDeliverable: true, requirements: { needsAuthorVerification: true } })
  mocks.revokeGoalExecutions.mockResolvedValue([])
  mocks.changeGoal.mockImplementation(async (_tx: unknown, current: Record<string, unknown>, patch: Record<string, unknown>) => ({
    goal: { ...current, ...patch }, snapshot: { ...current, ...patch },
  }))
  mocks.startLoopRun.mockResolvedValue({ runId: 'run-2', sessionId: 'session-1', status: 'running', streamUrl: '/stream' })
}

beforeEach(() => {
  vi.clearAllMocks()
  env.agentGoalEnabled = true
  configure()
})

describe('goal supervisor acceptance boundaries', () => {
  it('automatically continues unfinished work using the selected BYOK model', async () => {
    configure(goal({ executionOptions: { mode: 'build', modelTier: 'custom', customModelId: 'author-model', reasoningEffort: 'high' } }))
    mocks.inspectGoalEvidence.mockResolvedValue({ progressHash: 'chapter-one-done', blockers: [{ code: 'CHAPTER_NOT_COMMITTED', id: 'chapter-two' }],
      needsScopeDecision: false, hasDeliverable: true, requirements: { needsAuthorVerification: false } })
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')
    expect(mocks.startLoopRun).toHaveBeenCalledWith('user-1', expect.objectContaining({
      modelTier: 'custom', customModelId: 'author-model', reasoningEffort: 'high', prompt: '写三章',
    }), expect.objectContaining({ goal: expect.objectContaining({ trigger: 'goal_auto', goalId: 'goal-1' }) }))
    expect(mocks.actOnAgentGoal).not.toHaveBeenCalled()
  })

  it('finishes from current deterministic domain receipts without requiring a model completion report', async () => {
    mocks.inspectGoalEvidence.mockResolvedValue({ objective: '写三章', progressHash: 'three-current-chapters', blockers: [],
      needsScopeDecision: false, hasDeliverable: true, requirements: { needsAuthorVerification: false } })
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
    expect(mocks.tx.agentGoalEvidence.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'verified', receipt: { source: 'domain-evidence', progressHash: 'three-current-chapters' } }),
    }))
    expect(mocks.changeGoal).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'completed' }), 'completed')
  })

  it('parks a qualitative deliverable for one author completion review instead of repeating the round', async () => {
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.startLoopRun).not.toHaveBeenCalled()
    expect(mocks.changeGoal).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      phase: 'awaiting_input', reasonCode: 'GOAL_COMPLETION_REVIEW_REQUIRED',
    }), 'completion.review_required')
  })

  it('does not complete a chapter goal from todo-like progress when the chapter is not committed', async () => {
    mocks.inspectGoalEvidence.mockResolvedValue({
      progressHash: 'todo-only',
      blockers: [{ code: 'CHAPTER_NOT_COMMITTED', id: 'compilation-1' }],
      needsScopeDecision: false,
      hasDeliverable: false,
      requirements: { needsAuthorVerification: false },
    })
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.startLoopRun).toHaveBeenCalledTimes(1)
    expect(mocks.changeGoal.mock.calls.some((call: unknown[]) => (call[2] as { status?: string }).status === 'completed')).toBe(false)
  })

  it('holds a revision transition while its earlier execution usage is unresolved', async () => {
    configure(goal({ pendingRevision: 2, resumeStatus: 'active' }))
    mocks.tx.agentGoalUsage.count.mockResolvedValue(1)

    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.tx.agentGoalRevision.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('does not dispatch while the goal is waiting for an author answer or approval', async () => {
    configure(goal({ phase: 'awaiting_input' }))
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')
    expect(mocks.inspectGoalEvidence).not.toHaveBeenCalled()
    expect(mocks.startLoopRun).not.toHaveBeenCalled()

    configure(goal({ phase: 'awaiting_approval' }))
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('keeps the goal active clock while a child run is still executing', async () => {
    const activeSince = new Date(now.getTime() - 10_000)
    configure(goal({ activeSince }))
    mocks.inspectGoalEvidence.mockResolvedValue({
      progressHash: 'child-running',
      blockers: [{ code: 'CHILD_EXECUTING', id: 'child-run-1' }],
      childrenExecuting: true,
      needsScopeDecision: false,
      hasDeliverable: false,
      requirements: { needsAuthorVerification: false },
    })

    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.closeGoalActivity).not.toHaveBeenCalled()
    expect(mocks.changeGoal).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      phase: 'awaiting_provider', activeSince, reasonCode: 'GOAL_CHILD_EXECUTING',
    }))
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('settles the active clock when the only child is waiting for approval', async () => {
    const activeSince = new Date(now.getTime() - 10_000)
    configure(goal({ activeSince }))
    mocks.inspectGoalEvidence.mockResolvedValue({
      progressHash: 'child-awaiting-approval',
      blockers: [{ code: 'CHILD_EXECUTING', id: 'child-run-1' }],
      childrenExecuting: false,
      needsScopeDecision: false,
      hasDeliverable: false,
      requirements: { needsAuthorVerification: false },
    })

    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.closeGoalActivity).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ id: 'goal-1', activeSince }), now)
    expect(mocks.changeGoal).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      phase: 'awaiting_provider', activeSince: null, reasonCode: 'GOAL_CHILD_EXECUTING',
    }))
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('gives a newly queued author message priority over automatic continuation', async () => {
    mocks.tx.agentQueuedRequest.count.mockResolvedValue(1)
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('does not dispatch or mutate a terminal goal when an old run arrives late', async () => {
    configure(goal({ status: 'cancelled', phase: 'idle' }))
    await superviseAgentGoal('user-1', 'session-1', 'goal-1')
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
    expect(mocks.changeGoal).not.toHaveBeenCalled()
  })

  it('revokes every child execution before marking an exhausted goal budget-limited', async () => {
    configure(goal({ activeSince: new Date(now.getTime() - 10_000) }))
    mocks.readGoalExecutionControl.mockResolvedValue({ version: 3, controlPolicy: 'until_completion', origin: 'user', limits: { tokens: 100n, turns: null, activeTimeMs: null } })
    mocks.tx.agentGoalBudget.findUniqueOrThrow.mockResolvedValue({
      tokensUsed: 100n, tokenLimit: 100n, activeTimeMs: 0n, activeTimeLimitMs: 3_600_000n,
    })
    mocks.revokeGoalExecutions.mockResolvedValue(['run-1', 'run-2'])

    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.revokeGoalExecutions).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ id: 'goal-1' }), now)
    expect(mocks.stopAgentRun).toHaveBeenCalledTimes(2)
    expect(mocks.stopAgentRun.mock.calls.map((args: unknown[]) => args[0])).toEqual(['run-1', 'run-2'])
    expect(mocks.changeGoal).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      status: 'budget_limited', phase: 'idle', reasonCode: 'GOAL_BUDGET_EXHAUSTED',
    }))
  })

  it('cancels after an ended author run and revokes every child without completing the goal', async () => {
    configure(goal({ activeSince: new Date(now.getTime() - 10_000) }))
    mocks.tx.agentGoalBudget.findUniqueOrThrow.mockResolvedValue({ tokensUsed: 100n, tokenLimit: 100n, activeTimeMs: 0n, activeTimeLimitMs: 3_600_000n })
    mocks.tx.agentRun.findUnique.mockResolvedValue({
      id: 'run-1', status: 'completed', taskRootId: null,
      usage: { authorEnded: { fulfilled: false, todoItems: [{ content: '剩余工作', status: 'cancelled' }] } },
    })
    mocks.revokeGoalExecutions.mockResolvedValue(['run-1', 'child-run'])

    await superviseAgentGoal('user-1', 'session-1', 'goal-1')

    expect(mocks.revokeGoalExecutions).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ id: 'goal-1' }), now)
    expect(mocks.stopAgentRun.mock.calls.map((args: unknown[]) => args[0])).toEqual(['run-1', 'child-run'])
    expect(mocks.closeGoalActivity).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ id: 'goal-1' }), now)
    expect(mocks.changeGoal).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      status: 'cancelled', phase: 'idle', activeSince: null, reasonCode: 'AUTHOR_CANCELLED', finishedAt: now,
    }), 'cancelled')
    expect(mocks.changeGoal.mock.calls.some((call: unknown[]) => (call[2] as { status?: string }).status === 'completed')).toBe(false)
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('leaves an unknown provider settlement pending and never starts a paid retry', async () => {
    mocks.reconcileGoalUsage.mockRejectedValue(new Error('provider receipt is still unknown'))
    await expect(superviseAgentGoal('user-1', 'session-1', 'goal-1')).rejects.toThrow('provider receipt is still unknown')
    expect(mocks.lockOwnedGoal).not.toHaveBeenCalled()
    expect(mocks.startLoopRun).not.toHaveBeenCalled()
  })

  it('trips the no-progress fuse only after three identical persisted facts and blockers', () => {
    expect(realNextGoalProgress).toBeTypeOf('function')
    const first = realNextGoalProgress({ progressHash: null, blockFingerprint: null, blockCount: 0 }, 'facts-1', ['CHAPTER_NOT_COMMITTED:compilation-1'])
    const second = realNextGoalProgress(first, 'facts-1', ['CHAPTER_NOT_COMMITTED:compilation-1'])
    const third = realNextGoalProgress(second, 'facts-1', ['CHAPTER_NOT_COMMITTED:compilation-1'])
    const newEvidence = realNextGoalProgress(third, 'facts-2', ['CHAPTER_NOT_COMMITTED:compilation-1'])

    expect(first.blocked).toBe(false)
    expect(second.blocked).toBe(false)
    expect(third).toMatchObject({ blockCount: 3, blocked: true })
    expect(newEvidence).toMatchObject({ blockCount: 1, blocked: false })
  })
})
