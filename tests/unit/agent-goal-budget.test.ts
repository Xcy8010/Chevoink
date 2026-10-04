import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withGoalExecutionContext, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'

const mocks = vi.hoisted(() => {
  const tx = {
    agentGoalUsage: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentGoalBudget: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    agentGoal: {
      findUniqueOrThrow: vi.fn(),
    },
    agentProviderAttempt: {
      findUnique: vi.fn(),
    },
    agentExecutionOutbox: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
  }
  return {
    tx,
    prisma: {
      agentChildExecutionGrant: { findFirst: vi.fn().mockResolvedValue(null) },
      agentGoalUsage: { findUnique: vi.fn() },
      aiUsageLog: { findUnique: vi.fn() },
      agentProviderAttempt: { findUnique: vi.fn() },
      agentExecutionOutbox: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    },
    assertGoalFence: vi.fn(),
    lockNovelActiveScope: vi.fn(),
    changeGoal: vi.fn(),
    databaseNow: vi.fn(),
    runtimeTransaction: vi.fn(),
  }
})

vi.mock('../../api/lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../../api/lib/data/novel-write-lock.js', () => ({
  lockNovelActiveScope: mocks.lockNovelActiveScope,
}))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ assertGoalFence: mocks.assertGoalFence }))
vi.mock('../../api/lib/agent/goal-store.js', () => ({
  changeGoal: mocks.changeGoal,
  goalError: (code: string, message: string) => {
    throw Object.assign(new Error(message), { code })
  },
}))
vi.mock('../../api/lib/agent/runtime-common.js', () => ({
  databaseNow: mocks.databaseNow,
  runtimeTransaction: mocks.runtimeTransaction,
  runtimeJson: (value: unknown) => ({ value, hash: JSON.stringify(value) }),
}))

const { assertGoalProviderAdmission, observeGoalUsage, reserveGoalUsage, syncGoalDurableUsage, syncGoalLegacyUsage } =
  await import('../../api/lib/agent/goal-budget.js')

const context: GoalExecutionContext = {
  goalId: 'goal-1',
  revision: 3,
  epoch: 1n,
  userId: 'user-1',
  novelId: 'novel-1',
  sessionId: 'session-1',
  runId: 'run-1',
}

const goal = {
  id: context.goalId,
  userId: context.userId,
  novelId: context.novelId,
  sessionId: context.sessionId,
  stateVersion: 4,
  status: 'active',
}

const budget = {
  goalId: context.goalId,
  tokensUsed: 10n,
  tokensReserved: 20n,
  tokenLimit: 100n,
  activeTimeMs: 0n,
  activeTimeLimitMs: 60_000n,
}

function usage(status: 'reserved' | 'known' | 'rejected' | 'unknown' = 'reserved') {
  return {
    sourceKey: 'source-1',
    goalId: context.goalId,
    runId: context.runId,
    inputTokens: 10n,
    outputTokens: 20n,
    creditsMicros: 3_000n,
    reservedTokens: 30n,
    status,
  }
}

function configureReserve({ previous = null, unknownCount = 0, currentBudget = budget, currentGoal = goal } = {}) {
  mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
  mocks.assertGoalFence.mockResolvedValue(undefined)
  mocks.tx.agentGoalUsage.findUnique.mockResolvedValue(previous)
  mocks.tx.agentGoalUsage.count.mockResolvedValue(unknownCount)
  mocks.tx.agentGoalBudget.findUniqueOrThrow.mockResolvedValue(currentBudget)
  mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(currentGoal)
  mocks.databaseNow.mockResolvedValue(new Date('2026-09-27T00:00:00.000Z'))
  mocks.tx.agentGoalUsage.create.mockResolvedValue(undefined)
  mocks.tx.agentGoalBudget.update.mockResolvedValue(undefined)
}

function configureDurableSync(attempt: Record<string, unknown>) {
  const known = { ...usage(), sourceKey: `durable:${String(attempt.id)}`, goal: { novelId: context.novelId } }
  mocks.prisma.agentProviderAttempt.findUnique.mockResolvedValue(attempt)
  mocks.prisma.agentExecutionOutbox.findUnique.mockResolvedValue(null)
  mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue(known)
  mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
  mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue(usage())
  mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(goal)
}

describe('goal budget accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureReserve()
  })

  it('does nothing without an execution context and reserves once after fencing', async () => {
    await expect(reserveGoalUsage('source-1', 12)).resolves.toBeUndefined()
    expect(mocks.runtimeTransaction).not.toHaveBeenCalled()

    await withGoalExecutionContext(context, () => reserveGoalUsage('source-1', 12))
    expect(mocks.assertGoalFence).toHaveBeenCalledWith(mocks.tx, context)
    expect(mocks.tx.agentGoalUsage.create).toHaveBeenCalledWith({
      data: { sourceKey: 'source-1', goalId: context.goalId, runId: context.runId, reservedTokens: 12n },
    })
    expect(mocks.tx.agentGoalBudget.update).toHaveBeenCalledWith({
      where: { goalId: context.goalId },
      data: { tokensReserved: { increment: 12n } },
    })
  })

  it.each([
    [-1, 'negative'],
    [1.5, 'fractional'],
    [Number.MAX_SAFE_INTEGER + 1, 'unsafe'],
  ])('rejects %s token estimates before opening a transaction', async (estimate) => {
    await expect(withGoalExecutionContext(context, () => reserveGoalUsage('source-1', estimate)))
      .rejects.toMatchObject({ code: 'GOAL_USAGE_INVALID' })
    expect(mocks.runtimeTransaction).not.toHaveBeenCalled()
  })

  it('does not spend a source key twice and stops at the cumulative token budget', async () => {
    configureReserve({ previous: usage() })
    await expect(withGoalExecutionContext(context, () => reserveGoalUsage('source-1', 12)))
      .rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
    expect(mocks.tx.agentGoalUsage.create).not.toHaveBeenCalled()

    configureReserve({
      currentBudget: { ...budget, tokensUsed: 60n, tokensReserved: 30n, tokenLimit: 100n },
    })
    await expect(withGoalExecutionContext(context, () => reserveGoalUsage('source-2', 11)))
      .rejects.toMatchObject({ code: 'GOAL_BUDGET_EXHAUSTED' })
    expect(mocks.tx.agentGoalUsage.create).not.toHaveBeenCalled()
  })

  it('rejects reservations for another run and for unresolved usage', async () => {
    configureReserve({ previous: { ...usage(), runId: 'other-run' } })
    await expect(withGoalExecutionContext(context, () => reserveGoalUsage('source-1', 1)))
      .rejects.toMatchObject({ code: 'GOAL_SCOPE_MISMATCH' })

    configureReserve({ unknownCount: 1 })
    await expect(withGoalExecutionContext(context, () => reserveGoalUsage('source-2', 1)))
      .rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
  })

  it('updates usage and budget monotonically, releasing a reservation only at settlement', async () => {
    const known = { ...usage(), goal: { novelId: context.novelId } }
    const current = usage()
    mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue(known)
    mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
    mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue(current)
    mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(goal)

    await observeGoalUsage('source-1', {
      inputTokens: 15,
      outputTokens: 18,
      creditsMilli: 4,
      status: 'known',
    })

    expect(mocks.lockNovelActiveScope).toHaveBeenCalledWith(mocks.tx, context.novelId)
    expect(mocks.tx.agentGoalUsage.update).toHaveBeenCalledWith({
      where: { sourceKey: 'source-1' },
      data: {
        inputTokens: 15n,
        outputTokens: 20n,
        creditsMicros: 4_000n,
        status: 'known',
        reservedTokens: 0n,
      },
    })
    expect(mocks.tx.agentGoalBudget.update).toHaveBeenCalledWith({
      where: { goalId: context.goalId },
      data: {
        tokensUsed: { increment: 5n },
        tokensReserved: { decrement: 30n },
        creditsUsedMicros: { increment: 1_000n },
      },
    })
    expect(mocks.changeGoal).toHaveBeenCalledWith(mocks.tx, goal, {}, 'usage.updated')
  })

  it('does not apply a duplicate or lower watermark after a terminal receipt', async () => {
    const known = { ...usage('known'), reservedTokens: 0n, goal: { novelId: context.novelId } }
    mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue(known)
    mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
    mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue({ ...usage('known'), reservedTokens: 0n })
    mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(goal)

    await observeGoalUsage('source-1', {
      inputTokens: 9,
      outputTokens: 19,
      creditsMilli: 2,
      status: 'reserved',
    })

    expect(mocks.tx.agentGoalUsage.update).not.toHaveBeenCalled()
    expect(mocks.tx.agentGoalBudget.update).not.toHaveBeenCalled()
    expect(mocks.changeGoal).not.toHaveBeenCalled()
  })

  it('accepts a late accounting receipt for a cancelled goal without reopening effect admission', async () => {
    const cancelledGoal = { ...goal, status: 'cancelled' }
    const known = { ...usage(), goal: { novelId: context.novelId } }
    mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue(known)
    mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
    mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue(usage())
    mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(cancelledGoal)

    await expect(observeGoalUsage('source-1', {
      inputTokens: 11,
      outputTokens: 21,
      creditsMilli: 4,
      status: 'known',
    })).resolves.toBeUndefined()

    expect(mocks.assertGoalFence).not.toHaveBeenCalled()
    expect(mocks.changeGoal).toHaveBeenCalledWith(mocks.tx, cancelledGoal, {}, 'usage.updated')
  })

  it('treats a legacy receipt with no credit charge as zero credits', async () => {
    const known = { ...usage(), goal: { novelId: context.novelId } }
    mocks.prisma.aiUsageLog.findUnique.mockResolvedValue({
      requestTokens: 5,
      responseTokens: 7,
      creditChargeMilli: 0,
      billingStatus: 'pending_settlement',
      usageSource: 'reported',
    })
    mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue(known)
    mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
    mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue(usage())
    mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(goal)

    await expect(syncGoalLegacyUsage('legacy-1')).resolves.toBeUndefined()
    expect(mocks.tx.agentGoalUsage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inputTokens: 10n, outputTokens: 20n, creditsMicros: 3_000n }),
    }))
  })

  it('does not duplicate fixed image billing in goal usage credits', async () => {
    const known = { ...usage(), creditsMicros: 0n, goal: { novelId: context.novelId } }
    mocks.prisma.aiUsageLog.findUnique.mockResolvedValue({
      providerType: 'image', action: 'generateCoverImage', usageSource: 'fixed_unit', billingStatus: 'observed',
      requestTokens: 0, responseTokens: 0, creditChargeMilli: 500,
    })
    mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue(known)
    mocks.runtimeTransaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
    mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue({ ...usage(), creditsMicros: 0n })
    mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(goal)

    await expect(syncGoalLegacyUsage('image-1')).resolves.toBeUndefined()

    expect(mocks.tx.agentGoalUsage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'known', creditsMicros: 0n }),
    }))
    expect(mocks.tx.agentGoalBudget.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ creditsUsedMicros: { increment: 0n } }),
    }))
  })

  it('reconciles a paid, settled output estimate without losing counts or charging again', async () => {
    mocks.prisma.aiUsageLog.findUnique.mockResolvedValue({
      providerType: 'text', modelTier: 'speed', requestTokens: null, responseTokens: null,
      billingStatus: 'settled', usageSource: 'unknown', creditChargeMilli: 4,
      billingEvidence: { policy: 'observed-output-estimate-2026-09-09', inputEstimate: 50, outputEstimate: 12, responseObserved: true },
    })
    mocks.prisma.agentGoalUsage.findUnique.mockResolvedValue({ ...usage(), goal: { novelId: context.novelId } })
    mocks.runtimeTransaction.mockImplementation(async work => work(mocks.tx))
    mocks.tx.agentGoalUsage.findUniqueOrThrow.mockResolvedValue(usage())
    mocks.tx.agentGoal.findUniqueOrThrow.mockResolvedValue(goal)
    await syncGoalLegacyUsage('paid-interrupted')
    expect(mocks.tx.agentGoalUsage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'known', inputTokens: 50n, outputTokens: 20n, reservedTokens: 0n, creditsMicros: 4000n }),
    }))
  })

  it('releases a reservation only for a hashed, explicitly not-dispatched cancellation', async () => {
    const result = { outcome: 'cancelled', result: { code: 'RUNTIME_PRE_DISPATCH_FAILED', dispatched: false } }
    configureDurableSync({
      id: 'attempt-1', operationId: 'operation-1', status: 'cancelled', dispatchedAt: null,
      result, resultHash: JSON.stringify(result), usageReceipt: null,
    })

    await expect(syncGoalDurableUsage('attempt-1')).resolves.toBeUndefined()

    expect(mocks.tx.agentGoalUsage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'rejected', reservedTokens: 0n }),
    }))
    expect(mocks.tx.agentGoalBudget.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tokensReserved: { decrement: 30n } }),
    }))
  })

  it('keeps an ambiguous cancellation unresolved instead of releasing its reservation', async () => {
    const result = { outcome: 'cancelled', result: { code: 'RUNTIME_PRE_DISPATCH_FAILED' } }
    configureDurableSync({
      id: 'attempt-2', operationId: 'operation-2', status: 'cancelled', dispatchedAt: null,
      result, resultHash: JSON.stringify(result), usageReceipt: null,
    })

    await expect(syncGoalDurableUsage('attempt-2')).resolves.toBeUndefined()

    expect(mocks.tx.agentGoalUsage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'unknown', reservedTokens: 30n }),
    }))
    expect(mocks.tx.agentGoalBudget.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tokensReserved: { decrement: 0n } }),
    }))
  })

  it('rejects a durable receipt whose result hash does not match its result', async () => {
    const result = { outcome: 'cancelled', result: { code: 'RUNTIME_PRE_DISPATCH_FAILED', dispatched: false } }
    configureDurableSync({
      id: 'attempt-3', operationId: 'operation-3', status: 'cancelled', dispatchedAt: null,
      result, resultHash: 'stale-hash', usageReceipt: null,
    })

    await expect(syncGoalDurableUsage('attempt-3')).rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
    expect(mocks.runtimeTransaction).not.toHaveBeenCalled()
  })

  it('uses the fenced transaction for provider admission', async () => {
    mocks.prisma.$transaction.mockImplementation(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx))
    mocks.assertGoalFence.mockResolvedValue(undefined)

    await expect(assertGoalProviderAdmission(context)).resolves.toBeUndefined()
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mocks.assertGoalFence).toHaveBeenCalledWith(mocks.tx, context)
  })
})
