import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
type SavedAttempt = { id: string; operationId: string; runId: string; status: string; requestHash: string; requestSnapshot: unknown;
  resultHash: string; result: unknown; dispatchedAt: Date | null; operation: { id: string; taskRootId: string; status: string; inputSnapshot: unknown; inputHash: string } }
type SavedEvent = { taskRootId: string; operationId: string; runId: string; type: string; payload: Record<string, unknown> }
const mocks = vi.hoisted(() => ({ attempt: vi.fn(), dispatch: vi.fn(), result: vi.fn(), usage: vi.fn(), admit: vi.fn(), settlement: vi.fn(), goal: vi.fn(),
  saved: {} as SavedAttempt, event: null as SavedEvent | null }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ prepareProviderAttempt: mocks.attempt, markProviderDispatched: mocks.dispatch,
  markProviderNotDispatched: vi.fn(), recordProviderResult: mocks.result, recordProviderUsage: mocks.usage }))
vi.mock('../../api/lib/agent/runtime-settlement.js', () => ({ preparePricedProviderOperation: vi.fn(async () => ({ id: 'op' })), settleProviderOperation: mocks.settlement }))
vi.mock('../../api/lib/agent/runtime-model-cursor.js', () => ({ prepareModelCursorOperation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-auxiliary-model.js', () => ({ prepareAuxiliaryModelOperation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work({
  agentProviderAttempt: { findFirst: async () => mocks.saved }, agentExecutionOutbox: { findUnique: async () => mocks.event },
}) }))
vi.mock('../../api/lib/agent/runtime-reducer.js', () => ({ reduceExecutionReceipt: vi.fn() }))
vi.mock('../../api/lib/agent/goal-budget.js', () => ({ observeGoalUsage: mocks.goal }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ readGoalExecution: vi.fn(async () => undefined) }))

import { beginDurableChat } from '../../api/lib/agent/runtime-provider.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
const input = { execution: { operationKey: 'operation', attemptKey: '1', lease: { userId: 'owner', runId: 'run', taskRootId: 'task',
  ownerId: 'worker', claimId: 'claim', epoch: 1n } }, userId: 'owner', agentRunId: 'run', action: 'fixture', provider: 'fixture', model: 'fixture',
  request: { body: {} }, price: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }, admit: mocks.admit } as Parameters<typeof beginDurableChat>[0]
function savedReceipt(unsent = false, status = 400, quota = false) {
  const request = runtimeJson({ provider: input.provider, model: input.model, request: input.request })
  const result = runtimeJson(unsent ? { outcome: 'cancelled', result: { code: 'CREDITS_EXHAUSTED', dispatched: false } }
    : { outcome: 'failed', result: { httpStatus: status, ...(quota ? { code: 'AI_PROVIDER_QUOTA_EXCEEDED' } : {}) } })
  const operation = runtimeJson({ input: { request: input.request, billing: input.price } })
  mocks.saved = { id: 'attempt', operationId: 'op', runId: 'original-run', status: unsent ? 'cancelled' : 'failed',
    requestHash: request.hash, requestSnapshot: request.value, resultHash: result.hash, result: result.value, dispatchedAt: unsent ? null : new Date(),
    operation: { id: 'op', taskRootId: 'task', status: unsent ? 'cancelled' : 'failed', inputSnapshot: operation.value, inputHash: operation.hash } }
  mocks.event = { taskRootId: 'task', operationId: 'op', runId: 'original-run', type: unsent ? 'provider.not_dispatched' : 'provider.result.recorded',
    payload: unsent ? { attemptId: 'attempt', requestHash: request.hash, code: 'CREDITS_EXHAUSTED', resultHash: result.hash }
      : { attemptId: 'attempt', status: 'failed', resultHash: result.hash } }
  mocks.attempt.mockResolvedValue(mocks.saved)
}
beforeEach(() => { vi.clearAllMocks(); savedReceipt(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => vi.unstubAllGlobals())
describe('owned terminal provider replay preserves original attempt/accounting', () => {
  it.each([{ status: 400, code: 'AI_PROVIDER_ERROR' }, { status: 503, code: 'AI_PROVIDER_ERROR' }, { status: 504, code: 'AI_PROVIDER_TIMEOUT' },
    { status: 429, quota: true, code: 'AI_PROVIDER_QUOTA_EXCEEDED' }, { unsent: true, status: 400, code: 'CREDITS_EXHAUSTED' }])(
    'replays $code without redispatch or changing accounting', async scenario => {
      savedReceipt(scenario.unsent, scenario.status, scenario.quota)
      const original = structuredClone(mocks.saved)
      await expect(beginDurableChat(input)).rejects.toMatchObject({ code: scenario.code })
      expect(mocks.saved).toEqual(original)
      expect(mocks.admit).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
      expect(mocks.result).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled(); expect(mocks.settlement).not.toHaveBeenCalled(); expect(mocks.goal).not.toHaveBeenCalled()
    })
  it.each(['request-hash', 'operation-hash', 'result-hash', 'outbox-missing', 'outbox-hash', 'outbox-root', 'outbox-run', 'outbox-operation', 'dispatched-unsent', 'missing-dispatch', 'operation-status'] as const)(
    '%s cannot authorize terminal replay or another request', async mismatch => {
      if (mismatch === 'dispatched-unsent') savedReceipt(true)
      if (mismatch === 'request-hash') mocks.saved.requestSnapshot = { altered: true }
      if (mismatch === 'operation-hash') mocks.saved.operation.inputHash = createHash('sha256').update('different').digest('hex')
      if (mismatch === 'result-hash') mocks.saved.result = { outcome: 'failed', result: { httpStatus: 401 } }
      if (mismatch === 'outbox-missing') mocks.event = null
      if (mismatch === 'outbox-hash') mocks.event!.payload.resultHash = 'other'
      if (mismatch === 'outbox-root') mocks.event!.taskRootId = 'foreign'
      if (mismatch === 'outbox-run') mocks.event!.runId = 'foreign'
      if (mismatch === 'outbox-operation') mocks.event!.operationId = 'foreign'
      if (mismatch === 'dispatched-unsent') mocks.saved.dispatchedAt = new Date()
      if (mismatch === 'missing-dispatch') mocks.saved.dispatchedAt = null
      if (mismatch === 'operation-status') mocks.saved.operation.status = 'prepared'
      await expect(beginDurableChat(input)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(mocks.dispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(mocks.settlement).not.toHaveBeenCalled()
    })
  it.each(['dispatched', 'dispatching', 'unknown'] as const)('keeps %s without a terminal receipt unknown', async status => {
    mocks.attempt.mockResolvedValue({ ...mocks.saved, status })
    await expect(beginDurableChat(input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects a foreign author before any attempt access', async () => {
    await expect(beginDurableChat({ ...input, userId: 'foreign' })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(mocks.attempt).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
})
