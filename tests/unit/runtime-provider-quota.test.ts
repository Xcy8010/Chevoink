import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ attempt: vi.fn(), dispatch: vi.fn(), result: vi.fn(), usage: vi.fn(), goal: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-common.js', () => ({
  runtimeJson: (value: unknown) => ({ value, hash: JSON.stringify(value) }),
  runtimeError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }) },
  durableChatResultSchema: {},
}))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ prepareProviderAttempt: mocks.attempt, markProviderDispatched: mocks.dispatch,
  markProviderNotDispatched: vi.fn(), recordProviderResult: mocks.result, recordProviderUsage: mocks.usage }))
vi.mock('../../api/lib/agent/runtime-settlement.js', () => ({ preparePricedProviderOperation: vi.fn(async () => ({ id: 'operation' })),
  settleProviderOperation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-model-cursor.js', () => ({ prepareModelCursorOperation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-auxiliary-model.js', () => ({ prepareAuxiliaryModelOperation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-reducer.js', () => ({ reduceExecutionReceipt: vi.fn() }))
vi.mock('../../api/lib/agent/goal-budget.js', () => ({ observeGoalUsage: mocks.goal }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ readGoalExecution: vi.fn(async () => undefined) }))

import { beginDurableChat } from '../../api/lib/agent/runtime-provider.js'

const input = { execution: { operationKey: 'operation', attemptKey: '1', lease: { userId: 'owner', runId: 'run', taskRootId: 'task', epoch: 1, leaseToken: 'fixture' } },
  userId: 'owner', agentRunId: 'run', action: 'fixture', provider: 'fixture', model: 'fixture', request: { body: {} },
  price: { modelTier: 'speed' }, admit: async () => {} } as Parameters<typeof beginDurableChat>[0]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.attempt.mockResolvedValue({ id: 'attempt', requestHash: 'request', status: 'prepared' })
  mocks.dispatch.mockResolvedValue({ dispatchGranted: true })
})

describe('durable supplier quota accounting', () => {
  it('retains reported counts and failed quota identity without inventing settlement', async () => {
    const provider = await beginDurableChat(input)
    const usage = { source: 'reported' as const, promptTokens: 12, completionTokens: 3, cacheHitTokens: null, cacheMissTokens: null }
    await provider.rejected(429, { quotaExceeded: true, usage })
    expect(mocks.usage).toHaveBeenCalledWith({ userId: 'owner', attemptId: 'attempt', requestHash: 'request', revision: 1, usage })
    expect(mocks.result).toHaveBeenCalledWith({ userId: 'owner', attemptId: 'attempt', requestHash: 'request', outcome: 'failed',
      result: { httpStatus: 429, code: 'AI_PROVIDER_QUOTA_EXCEEDED' } })
    expect(mocks.goal).toHaveBeenCalledWith('durable:attempt', { inputTokens: 12, outputTokens: 3, creditsMilli: 0, status: 'unknown' })
    expect(mocks.dispatch).toHaveBeenCalledOnce()
  })
  it('keeps a quota response with missing usage unknown rather than releasing it as a zero-charge rejection', async () => {
    const provider = await beginDurableChat(input)
    await provider.rejected(429, { quotaExceeded: true, usage: { source: 'unknown', promptTokens: null, completionTokens: null,
      cacheHitTokens: null, cacheMissTokens: null } })
    expect(mocks.goal).toHaveBeenCalledWith('durable:attempt', { inputTokens: null, outputTokens: null, creditsMilli: 0, status: 'unknown' })
  })
  it('preserves normal transient429 accounting', async () => {
    const provider = await beginDurableChat(input)
    await provider.rejected(429)
    expect(mocks.goal).toHaveBeenCalledWith('durable:attempt', { inputTokens: null, outputTokens: null, creditsMilli: 0, status: 'rejected' })
    expect(mocks.usage).not.toHaveBeenCalled()
  })
  it('refuses a changed owner before preparing or dispatching', async () => {
    await expect(beginDurableChat({ ...input, userId: 'other-owner' })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(mocks.attempt).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it('refuses to redispatch a failed quota attempt after restart', async () => {
    mocks.attempt.mockResolvedValue({ id: 'attempt', requestHash: 'request', status: 'failed' })
    await expect(beginDurableChat(input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.result).not.toHaveBeenCalled()
  })
  it('binds repeated rejection delivery to the same attempt and never grants another dispatch', async () => {
    const provider = await beginDurableChat(input)
    const rejection = { quotaExceeded: true, usage: { source: 'unknown' as const, promptTokens: null, completionTokens: null,
      cacheHitTokens: null, cacheMissTokens: null } }
    await provider.rejected(429, rejection)
    await provider.rejected(429, rejection)
    expect(mocks.attempt).toHaveBeenCalledOnce()
    expect(mocks.dispatch).toHaveBeenCalledOnce()
    expect(mocks.result.mock.calls[0]).toEqual(mocks.result.mock.calls[1])
    expect(mocks.goal.mock.calls[0]).toEqual(mocks.goal.mock.calls[1])
  })
})
