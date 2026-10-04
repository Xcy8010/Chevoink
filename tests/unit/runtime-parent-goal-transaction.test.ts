import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withGoalTransaction, withoutGoalEffects, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'
const mocks = vi.hoisted(() => ({ scope: vi.fn(), transaction: vi.fn(), known: vi.fn(), fence: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { agentGoalUsage: { findUnique: mocks.known } } }))
vi.mock('../../api/lib/agent/runtime-parent-contention.js', () => ({ readParentContentionScope: mocks.scope }))
vi.mock('../../api/lib/agent/runtime-common.js', () => ({ runtimeTransaction: mocks.transaction, databaseNow: async () => new Date(0), runtimeJson: (value: unknown) => ({ value, hash: '' }) }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ assertGoalFence: mocks.fence }))
vi.mock('../../api/lib/agent/goal-store.js', () => ({ changeGoal: vi.fn(), goalError(code: string) { throw Object.assign(new Error(code), { code }) } }))
import { reserveGoalUsage, reserveGoalUsageInTransaction, observeGoalUsage } from '../../api/lib/agent/goal-budget.js'
const context: GoalExecutionContext = { goalId: 'goal', revision: 1, epoch: 1n, userId: 'author', novelId: 'novel', sessionId: 'session', runId: 'child' }
const ambient = {} as Prisma.TransactionClient
const nested = <T>(work: () => T) => withGoalTransaction(ambient, () => withoutGoalEffects(work))
beforeEach(() => { vi.clearAllMocks(); mocks.known.mockResolvedValue(null) })
describe('explicit goal accounting transaction boundaries', () => {
  it('preserves no-context reservation and invalid-input behavior before rejecting ambient reservations', async () => {
    await nested(() => reserveGoalUsage('source', 1))
    await expect(nested(() => reserveGoalUsage('source', -1, context))).rejects.toMatchObject({ code: 'GOAL_USAGE_INVALID' })
    await expect(nested(() => reserveGoalUsage('source', 1, context))).rejects.toMatchObject({ code: 'GOAL_USAGE_TRANSACTION_REQUIRED' })
    expect(mocks.scope).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.fence).not.toHaveBeenCalled()
  })
  it('preserves absent observations and validation but rejects a known ambient observation before scheduling', async () => {
    const observation = { inputTokens: 5, outputTokens: 2, creditsMilli: 0, status: 'known' as const }
    await nested(() => observeGoalUsage('absent', observation))
    mocks.known.mockResolvedValue({ runId: 'child', goal: { userId: 'author' } })
    await expect(nested(() => observeGoalUsage('known', { ...observation, inputTokens: -1 }))).rejects.toMatchObject({ code: 'GOAL_USAGE_INVALID' })
    await expect(nested(() => observeGoalUsage('known', observation))).rejects.toMatchObject({ code: 'GOAL_USAGE_TRANSACTION_REQUIRED' })
    expect(mocks.scope).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('uses only the caller-owned transaction for explicit dispatch reservation', async () => {
    const create = vi.fn(), update = vi.fn()
    const tx = { agentGoalUsage: { findUnique: async () => null, count: async () => 0, create },
      agentGoalBudget: { findUniqueOrThrow: async () => ({ tokensUsed: 0n, tokensReserved: 0n, tokenLimit: 100n, activeTimeMs: 0n, activeTimeLimitMs: 10000n }), update },
      agentGoal: { findUniqueOrThrow: async () => ({ activeSince: null }) } } as unknown as Prisma.TransactionClient
    await withGoalTransaction(tx, () => reserveGoalUsageInTransaction(tx, 'dispatch', 10, context))
    expect(mocks.fence).toHaveBeenCalledWith(tx, context)
    expect(create).toHaveBeenCalledWith({ data: { sourceKey: 'dispatch', goalId: 'goal', runId: 'child', reservedTokens: 10n } })
    expect(update).toHaveBeenCalledOnce()
    expect(mocks.scope).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
