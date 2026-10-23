import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { executePreparedContinuityWork, prepareContinuityWork } from '../../api/lib/agent/tools/durable-continuity.js'
import { executePreparedQualityWork, prepareQualityWork } from '../../api/lib/agent/tools/durable-quality.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({
  tx: { agentOperation: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() }, agentEffectReceipt: { findUnique: vi.fn() } },
  state: vi.fn(), source: vi.fn(), reduce: vi.fn(), effect: vi.fn(), failure: vi.fn(), provider: vi.fn(),
}))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(), withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(), readExecutionStateInTransaction: mocks.state, readExecutionFrame: mocks.source }))
vi.mock('../../api/lib/agent/runtime-operations.js', async original => ({ ...await original<object>(), commitOperationEffect: mocks.effect, recordToolFailure: mocks.failure }))
vi.mock('../../api/lib/agent/runtime-reducer.js', async original => ({ ...await original<object>(), reduceExecutionReceipt: mocks.reduce }))
vi.mock('../../api/lib/agent/runtime-auxiliary-call.js', async original => ({ ...await original<object>(), callDurableAuxiliary: mocks.provider }))

const lease = { userId: 'author', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const context = { userId: lease.userId, runId: lease.runId, novelId: 'novel', callId: 'original-call', signal: new AbortController().signal } as ToolContext
const frozen = { kind: 'rejected' as const, code: 'CONTINUITY_INPUT_STALE', message: 'Original known refusal' }

function saved(action: string, status = 'failed') {
  const snapshot = runtimeJson({ kind: 'tool', action, parentOperationId: null,
    input: { novelId: context.novelId, callId: context.callId, args: {}, work: frozen, normalization: { version: 1,
      rawArguments: '{}', normalizedArgsHash: runtimeJson({}).hash, sourceRevision: 0, sourceSnapshotHash: 'a'.repeat(64) } } })
  const operation = { id: 'operation', taskRootId: lease.taskRootId, operationKey: 'exec:0', action, kind: 'tool', status, inputSnapshot: snapshot.value, inputHash: snapshot.hash }
  const result = runtimeJson({ outcome: 'failed', effectApplied: false, code: frozen.code,
    toolResult: { output: frozen.message, summary: 'Original refusal remains failed' } })
  const receipt = { operationId: operation.id, result: result.value, resultHash: result.hash }
  mocks.tx.agentOperation.findFirst.mockResolvedValue(operation)
  mocks.tx.agentOperation.findUnique.mockResolvedValue(operation)
  mocks.tx.agentOperation.findUniqueOrThrow.mockResolvedValue({ ...operation, effectReceipt: receipt })
  mocks.tx.agentEffectReceipt.findUnique.mockResolvedValue(receipt)
  mocks.source.mockResolvedValue({ revision: 0, snapshotHash: 'a'.repeat(64), state: { phase: 'idle', nextOperationSequence: 0,
    messages: [{ role: 'assistant', toolCalls: [{ id: context.callId, name: action, arguments: '{}' }] }] } })
  return { operation, receipt }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.state.mockResolvedValue({ frame: { state: { phase: 'idle', pendingOperationId: null } } })
})

describe.each([
  { kind: 'continuity', action: 'continuity_validate', execute: executePreparedContinuityWork, prepare: prepareContinuityWork },
  { kind: 'quality', action: 'quality_analyze', execute: executePreparedQualityWork, prepare: prepareQualityWork },
])('$kind saved review work', ({ action, execute, prepare }) => {
  it('returns the original known failed receipt without advancing a model cursor or asking the provider again', async () => {
    const { receipt } = saved(action)
    expect(await execute(context, lease, 'operation')).toEqual(receipt)
    expect(mocks.reduce).not.toHaveBeenCalled()
    expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.failure).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('rejects a different execution identity before reading or dispatching', async () => {
    await expect(execute(context, { ...lease, userId: 'other-author' }, 'operation')).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(mocks.tx.agentOperation.findFirst).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it.each(['novelId', 'callId'] as const)('does not apply original work under another %s', async field => {
    saved(action)
    await expect(execute({ ...context, [field]: 'different' }, lease, 'operation')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('rejects a modified frozen snapshot rather than rebuilding work from current content', async () => {
    const { operation } = saved(action)
    mocks.tx.agentOperation.findFirst.mockResolvedValueOnce({ ...operation, inputHash: '0'.repeat(64) })
    await expect(execute(context, lease, 'operation')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('cannot start a prepared review which is not the current original pending operation', async () => {
    saved(action, 'prepared')
    await expect(execute(context, lease, 'operation')).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
    expect(mocks.failure).not.toHaveBeenCalled()
    expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('rejects metadata which pretends to be a tool call absent from the original frame', async () => {
    saved(action)
    mocks.source.mockResolvedValueOnce({ revision: 0, snapshotHash: 'a'.repeat(64), state: { phase: 'idle', nextOperationSequence: 0, messages: [{ role: 'user', content: 'Original author request' }] } })
    await expect(execute(context, lease, 'operation')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('recovers the frozen preparation without changing its old outcome or consulting today’s content', async () => {
    saved(action)
    expect(await prepare(context, lease, { operationKey: 'exec:0', observedRevision: 0, baseline: null, args: {} })).toEqual(frozen)
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.reduce).not.toHaveBeenCalled()
    expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
})
