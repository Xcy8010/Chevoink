import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { currentNativeToolViews } from '../../api/lib/agent/runtime-tool-view.js'
import { executePreparedContinuityWork, prepareContinuityWork } from '../../api/lib/agent/tools/durable-continuity.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as continuity from '../../api/lib/agent/continuity-review.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const mocks = vi.hoisted(() => ({ tx: {} as RuntimeTx, state: vi.fn(), frame: vi.fn(), save: vi.fn(), provider: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(),
  withRunLease: async (_lease: unknown, work: (tx: RuntimeTx) => unknown) => work(mocks.tx),
  withRunLeaseInTransaction: async (tx: RuntimeTx, _lease: unknown, work: (tx: RuntimeTx) => unknown) => work(tx),
}))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(),
  readExecutionStateInTransaction: mocks.state, readExecutionFrame: mocks.frame, saveExecutionStateInTransaction: mocks.save,
}))
vi.mock('../../api/lib/agent/runtime-auxiliary-call.js', async original => ({ ...await original<object>(), callDurableAuxiliary: mocks.provider }))
vi.mock('../../api/lib/agent/runtime-operations.js', async original => {
  const actual = await original<typeof import('../../api/lib/agent/runtime-operations.js')>()
  return { ...actual, commitOperationEffect: (lease, id, hash, work) => actual.commitOperationEffectInTransaction(mocks.tx, lease, id, hash, work) }
})
const lease = { userId: 'author', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const context = { userId: lease.userId, runId: lease.runId, novelId: 'novel', callId: 'call', signal: new AbortController().signal }
async function fixture(args: Record<string, string> = { chapterId: 'missing' }) {
  const spec = buildTaskSpec({ runId: lease.runId, novelId: context.novelId, chapterId: 'chapter', prompt: '检查本章' })
  const tools = await currentNativeToolViews([{ type: 'function', function: { name: 'continuity_validate', description: '', parameters: { type: 'object' } } }], spec.scope)
  const source = { revision: 0, snapshotHash: 'a'.repeat(64), state: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle',
    pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'assistant', content: null,
      toolCalls: [{ id: context.callId, name: 'continuity_validate', arguments: JSON.stringify(args) }] }] } }
  const configuration = { version: 1, mode: 'build', tools, toolAuthority: [{ name: 'continuity_validate', permission: 'allow', alwaysConfirm: false }], protectedChapterIds: [] }
  let current = { configuration, originalSpec: spec, frame: source }
  let operation: Record<string, unknown> | null = null, receipt: Record<string, unknown> | null = null
  const db = {
    agentOperation: {
      findUnique: vi.fn(async () => operation), findFirst: vi.fn(async ({ where }) => operation && Object.entries(where).every(([key, value]) => operation![key] === value) ? operation : null),
      create: vi.fn(async ({ data }) => { operation = { ...data, status: 'prepared' }; return operation }),
      update: vi.fn(async ({ data }) => { Object.assign(operation!, data); return operation }),
    },
    agentEffectReceipt: { findUnique: vi.fn(async () => receipt), create: vi.fn(async ({ data }) => { receipt = { ...data }; return receipt }) },
    agentExecutionOutbox: { create: vi.fn(async ({ data }) => data) },
  }
  mocks.tx = db as unknown as RuntimeTx
  mocks.state.mockImplementation(async () => current)
  mocks.frame.mockResolvedValue(source)
  mocks.save.mockImplementation(async (_tx, _lease, input) => {
    const pending = { revision: 1, snapshotHash: runtimeJson(input.snapshot).hash, state: input.snapshot }
    current = { ...current, frame: pending }
    return pending
  })
  const admit = (work: unknown) => prepareToolCursorOperation(lease, { expectedRevision: source.revision, expectedHash: source.snapshotHash }, {
    key: 'exec:0', action: 'continuity_validate', callId: context.callId, targetId: lease.taskRootId, effectDomain: 'compiler',
    operationInput: runtimeJson({ callId: context.callId, novelId: context.novelId, args, baseline: null, work }).value,
    effectiveArgs: args, normalize: raw => raw,
  })
  return { args, source, db, admit, operation: () => operation!, receipt: () => receipt }
}
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())
describe('continuity preflight rejection through actual tool admission and failure receipts', () => {
  it.each(['CHAPTER_NOT_FOUND', 'COMPILATION_NOT_FOUND'] as const)('records %s once, with authentic frozen input and no provider dispatch', async code => {
    const f = await fixture(code === 'CHAPTER_NOT_FOUND' ? { chapterId: 'missing' } : { compilationId: 'missing' })
    vi.spyOn(continuity, 'buildContinuitySnapshot').mockRejectedValue(new DataAccessError(404, code, 'Original locator was not found'))
    const billing = vi.spyOn(continuity, 'readContinuityRequestBilling')
    const work = await prepareContinuityWork(context as never, lease, { operationKey: 'exec:0', observedRevision: 0, baseline: null, args: f.args })
    expect(work).toEqual({ kind: 'rejected', code, message: 'Original locator was not found' })
    const admitted = await f.admit(work)
    expect(admitted.operation.inputSnapshot).toMatchObject({ input: { work, normalization: { rawArguments: JSON.stringify(f.args), sourceRevision: 0,
      sourceSnapshotHash: f.source.snapshotHash, normalizedArgsHash: runtimeJson(f.args).hash } } })
    expect(runtimeJson(admitted.operation.inputSnapshot).hash).toBe(admitted.operation.inputHash)
    const original = structuredClone(admitted.operation.inputSnapshot)
    const result = await executePreparedContinuityWork(context as never, lease, admitted.operation.id)
    expect(result.result).toMatchObject({ outcome: 'failed', effectApplied: false, code })
    expect(result.resultHash).toBe(runtimeJson(result.result).hash)
    expect(f.operation().status).toBe('failed')
    expect(f.db.agentExecutionOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'tool.observation.recorded',
      eventKey: 'observation:' + admitted.operation.id, payload: { operationId: admitted.operation.id, outcome: 'failed', resultHash: result.resultHash } }) })
    expect(await executePreparedContinuityWork(context as never, lease, admitted.operation.id)).toEqual(result)
    expect(f.db.agentEffectReceipt.create).toHaveBeenCalledOnce()
    expect(f.db.agentOperation.update).toHaveBeenCalledOnce()
    expect(f.db.agentExecutionOutbox.create).toHaveBeenCalledOnce()
    expect(f.operation().inputSnapshot).toEqual(original)
    expect(billing).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('still rejects damaged admission proof before recording a locator failure', async () => {
    const f = await fixture(), admitted = await f.admit({ kind: 'rejected', code: 'CHAPTER_NOT_FOUND', message: 'Missing' })
    f.operation().inputHash = 'f'.repeat(64)
    await expect(executePreparedContinuityWork(context as never, lease, admitted.operation.id)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.receipt()).toBeNull()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('does not turn a cancellation after admission into a locator failure', async () => {
    const f = await fixture(), admitted = await f.admit({ kind: 'rejected', code: 'CHAPTER_NOT_FOUND', message: 'Missing' })
    const signal = new AbortController(); signal.abort(new DOMException('Stopped', 'AbortError'))
    await expect(executePreparedContinuityWork({ ...context, signal: signal.signal } as never, lease, admitted.operation.id)).rejects.toBe(signal.signal.reason)
    expect(f.receipt()).toBeNull()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it.each(['RUNTIME_RECEIPT_INVALID', 'RUNTIME_PARENT_LEASE_LOST', 'AI_PROVIDER_BILLING_UNCONFIRMED'])('does not freeze %s as a known preflight rejection', async code => {
    const f = await fixture(), error = new DataAccessError(409, code, 'Original unresolved error')
    vi.spyOn(continuity, 'buildContinuitySnapshot').mockRejectedValue(error)
    await expect(prepareContinuityWork(context as never, lease, { operationKey: 'exec:0', observedRevision: 0, baseline: null, args: f.args })).rejects.toBe(error)
    expect(f.db.agentOperation.create).not.toHaveBeenCalled()
    expect(f.receipt()).toBeNull()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it.each([{ kind: 'historical', version: 23 }, { kind: 'rejected', code: 'AI_PROVIDER_BILLING_UNCONFIRMED', message: 'Unknown' }])('keeps non-native unresolved $kind work behind its historical billing reader', async work => {
    const f = await fixture(), admitted = await f.admit(work)
    vi.spyOn(continuity, 'buildContinuitySnapshot').mockResolvedValue({ chapter: { id: 'chapter' }, runIds: [lease.runId] } as never)
    const billing = vi.spyOn(continuity, 'readContinuityRequestBilling').mockResolvedValue({ known: false, hasRequest: true, usageIds: [], nativeReceiptIds: [] })
    await expect(executePreparedContinuityWork(context as never, lease, admitted.operation.id)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(billing).toHaveBeenCalledOnce()
    expect(f.operation().status).toBe('prepared')
    expect(f.receipt()).toBeNull()
    expect(mocks.provider).not.toHaveBeenCalled()
  })
})
