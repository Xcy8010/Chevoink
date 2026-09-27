import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const attempt = {
    id: 'attempt-1', operationId: 'operation-1', attemptKey: '1', runId: 'run-1', ownerEpoch: 3n,
    provider: 'provider', model: 'model', requestHash: '{"body":{}}', requestSnapshot: { body: {} },
    status: 'prepared', dispatchedAt: null, result: null, resultHash: null,
    operation: { id: 'operation-1', taskRootId: 'root-1', status: 'prepared' },
  }
  const tx = {
    agentProviderAttempt: {
      findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(),
    },
    agentOperation: { findFirst: vi.fn(), update: vi.fn() },
    agentExecutionOutbox: { create: vi.fn() },
    $queryRaw: vi.fn(),
  }
  return {
    attempt,
    tx,
    runtimeTransaction: vi.fn(async (work: (tx: typeof tx) => unknown) => work(tx)),
    withRunLease: vi.fn(),
    databaseNow: vi.fn(async () => new Date('2026-09-27T00:00:00.000Z')),
  }
})

vi.mock('../../api/lib/agent/runtime-common.js', () => ({
  databaseNow: mocks.databaseNow,
  runtimeTransaction: mocks.runtimeTransaction,
  runtimeError: (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) },
  runtimeId: (value: unknown): asserts value is string => {
    if (typeof value !== 'string' || !value) throw new Error('invalid runtime id')
  },
  runtimeJson: (value: unknown) => ({ value, hash: JSON.stringify(value) }),
}))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: mocks.withRunLease }))
vi.mock('../../api/lib/agent/runtime-budget.js', () => ({ assertProviderBudget: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ assertPendingProviderState: vi.fn() }))

const { markProviderDispatched, markProviderNotDispatched } = await import('../../api/lib/agent/runtime-operations.js')

describe('durable provider dispatch boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tx.agentProviderAttempt.findFirst.mockResolvedValue(mocks.attempt)
    mocks.tx.agentProviderAttempt.findUnique.mockResolvedValue(mocks.attempt)
    mocks.tx.agentProviderAttempt.findUniqueOrThrow.mockResolvedValue(mocks.attempt)
    mocks.tx.agentOperation.findFirst.mockResolvedValue(mocks.attempt.operation)
    mocks.tx.agentProviderAttempt.update.mockResolvedValue({ ...mocks.attempt, status: 'cancelled' })
    mocks.tx.agentOperation.update.mockResolvedValue({ id: 'operation-1', status: 'cancelled' })
    mocks.tx.agentExecutionOutbox.create.mockResolvedValue({ id: 'event-1' })
  })

  it('closes a prepared attempt as unsent and publishes one durable observation', async () => {
    await markProviderNotDispatched({ userId: 'user-1', attemptId: 'attempt-1', requestHash: '{"body":{}}', code: 'GOAL_BUDGET_EXHAUSTED' })

    expect(mocks.tx.agentProviderAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'attempt-1' }, data: expect.objectContaining({ status: 'cancelled', resultHash: expect.any(String) }),
    }))
    expect(mocks.tx.agentOperation.update).toHaveBeenCalledWith({ where: { id: 'operation-1' }, data: { status: 'cancelled' } })
    expect(mocks.tx.agentExecutionOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventKey: 'provider.not_dispatched:attempt-1', type: 'provider.not_dispatched' }),
    }))
  })

  it('does not rewrite an attempt after a dispatch timestamp exists', async () => {
    mocks.tx.agentProviderAttempt.findUniqueOrThrow.mockResolvedValue({ ...mocks.attempt, status: 'dispatched', dispatchedAt: new Date() })

    await markProviderNotDispatched({ userId: 'user-1', attemptId: 'attempt-1', requestHash: '{"body":{}}', code: 'RUNTIME_LEASE_LOST' })

    expect(mocks.tx.agentProviderAttempt.update).not.toHaveBeenCalled()
    expect(mocks.tx.agentOperation.update).not.toHaveBeenCalled()
    expect(mocks.tx.agentExecutionOutbox.create).not.toHaveBeenCalled()
  })

  it('does not close an inconsistent prepared attempt when its operation is already dispatched', async () => {
    mocks.tx.agentProviderAttempt.findUniqueOrThrow.mockResolvedValue({ ...mocks.attempt, operation: { ...mocks.attempt.operation, status: 'dispatched' } })

    const result = await markProviderNotDispatched({ userId: 'user-1', attemptId: 'attempt-1', requestHash: '{"body":{}}', code: 'RUNTIME_LEASE_LOST' })

    expect(result.operation.status).toBe('dispatched')
    expect(mocks.tx.agentProviderAttempt.update).not.toHaveBeenCalled()
    expect(mocks.tx.agentOperation.update).not.toHaveBeenCalled()
    expect(mocks.tx.agentExecutionOutbox.create).not.toHaveBeenCalled()
  })

  it('never enters goal reservation when the dispatch lease is already fenced', async () => {
    mocks.withRunLease.mockRejectedValueOnce(Object.assign(new Error('old epoch'), { code: 'RUNTIME_LEASE_LOST' }))

    await expect(markProviderDispatched({ userId: 'user-1', runId: 'run-1', taskRootId: 'root-1', ownerId: 'owner-1', claimId: 'claim-1', epoch: 2n }, 'attempt-1'))
      .rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })

    expect(mocks.tx.agentProviderAttempt.findUnique).not.toHaveBeenCalled()
    expect(mocks.tx.agentOperation.update).not.toHaveBeenCalled()
  })
})
