import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'
import { readAdmittedWritingServiceStep } from '../../api/lib/agent/runtime-writing-service.js'

const mocks = vi.hoisted(() => ({ admitted: vi.fn(), original: vi.fn(), target: vi.fn(), baseline: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), readAdmittedToolOperation: mocks.admitted }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: mocks.original }))
vi.mock('../../api/lib/agent/writing-scope.js', async original => ({ ...await original<object>(), assertWritingTarget: mocks.target }))
vi.mock('../../api/lib/agent/runtime-observed-baseline.js', () => ({ readObservedBaseline: mocks.baseline }))

const lease = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'owner', claimId: 'claim', epoch: 1n }
type Row = { id: string; taskRootId: string; kind: string; action: string; status: string; parentOperationId: string | null;
  operationKey: string; inputSnapshot: unknown; inputHash: string; effectReceipt?: { result: unknown; resultHash: string } }
const actions = { body: 'chapter_write', continuity: 'continuity_validate', quality: 'quality_analyze', commit: 'chapter_bridge_commit' }
type Frame = { taskRootId: string; revision: number; previousHash: string | null; snapshotHash: string; snapshot: Record<string, unknown> }
let rows: Map<string, Row>, events: Map<string, object>, frames: Map<number, Frame>
let tx: { agentOperation: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  agentTaskRoot: { findUniqueOrThrow: ReturnType<typeof vi.fn> }; agentRun: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  agentExecutionFrame: { findUnique: ReturnType<typeof vi.fn> }; agentExecutionOutbox: { findUnique: ReturnType<typeof vi.fn> } }
const compiler = (step: number) => ({ id: 'compilation', hash: String(step).repeat(64) })
const identity = (step: keyof typeof actions) => ({ operationId: step, action: actions[step], novelId: 'novel', callId: 'writer' })
const readCommitted = (step: keyof typeof actions) => readAdmittedWritingServiceStep(lease, identity(step), tx as unknown as RuntimeTx)
const read = (step: keyof typeof actions) => {
  // This traversal admits the current pending step; only its predecessors are committed.
  rows.get(step)!.status = 'prepared'
  return readCommitted(step)
}
function saveFrame(revision: number, snapshot: Record<string, unknown>, previousHash: string | null) {
  const captured = runtimeJson(snapshot)
  const frame = { taskRootId: lease.taskRootId, revision, previousHash, snapshotHash: captured.hash, snapshot }
  frames.set(revision, frame)
  events.set(`state:root:${revision}`, { taskRootId: lease.taskRootId, type: 'execution.state.saved',
    payload: { revision, snapshotHash: frame.snapshotHash, previousHash } })
  return frame
}

beforeEach(() => {
  vi.resetAllMocks(); rows = new Map(); events = new Map(); frames = new Map()
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '完整写作本章' })
  spec.scope.writingCoordinationProtocol = 1; spec.writingPacing = 'explicit_writing'; spec.qualityMode = 'balanced'
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  const writing = coordinatedWritingInputSchema.parse({ draftComplete: true, actualOutcomes: { exitState: {} },
    chapterSummary: '本章摘要', hookDecision: '', delayedHookReason: '', openingStructure: '开场', endingStructure: '结束' })
  const args = { chapterId: 'chapter', content: '新正文', writing }
  const rawArguments = JSON.stringify(args)
  const initial = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    messages: [{ role: 'user', content: '完整写作本章' }], successfulToolSignatures: [] }
  const first = saveFrame(0, initial, null)
  const previous = saveFrame(1, initial, first.snapshotHash)
  const source = saveFrame(2, { ...initial, messages: [...initial.messages,
    { role: 'assistant', content: null, toolCalls: [{ id: 'writer', name: 'chapter_write', arguments: rawArguments }] }] }, previous.snapshotHash)
  const normalization = { version: 1, rawArguments, normalizedArgsHash: runtimeJson(args).hash,
    sourceRevision: 2, sourceSnapshotHash: source.snapshotHash }
  const input = { novelId: 'novel', callId: 'writer', args, expectedRevision: 4, normalization,
    writingManifest: coordinatedWritingManifest({ spec, prompt: '完整写作本章' }, 'chapter_write', 'chapter', writing) }
  const parentSnapshot = runtimeJson({ kind: 'tool', action: 'chapter_write', parentOperationId: null, input })
  const parent: Row = { id: 'parent', taskRootId: 'root', kind: 'tool', action: 'chapter_write', status: 'prepared',
    parentOperationId: null, operationKey: 'exec:0', inputSnapshot: parentSnapshot.value, inputHash: parentSnapshot.hash }
  rows.set(parent.id, parent)
  const steps = ['body', 'continuity', 'quality', 'commit'] as const
  steps.forEach((step, index) => {
    const prior = index ? rows.get(steps[index - 1])! : null
    const savedArgs = step === 'body' ? args : step === 'continuity' ? { compilationId: 'compilation', terminalState: writing.actualOutcomes }
      : step === 'quality' ? { compilationId: 'compilation' } : { compilationId: 'compilation', chapterSummary: writing.chapterSummary,
        hookDecision: writing.hookDecision, delayedHookReason: writing.delayedHookReason, openingStructure: writing.openingStructure, endingStructure: writing.endingStructure }
    const saved = { novelId: 'novel', callId: 'writer', args: savedArgs, baseline: index ? compiler(index) : null,
      work: step === 'continuity' || step === 'quality' ? { kind: 'rejected' } : {}, serviceAdmission: { version: 1,
        parentOperationId: 'parent', parentInputHash: parent.inputHash, sourceRevision: 2, sourceSnapshotHash: normalization.sourceSnapshotHash,
        step, chapterId: 'chapter', source: prior ? { operationId: prior.id, resultHash: prior.effectReceipt!.resultHash } : null } }
    const snapshot = runtimeJson({ kind: 'internal', action: actions[step], parentOperationId: 'parent', input: saved })
    const result = { compilerState: compiler(index + 1), toolResult: { output: step, ...(step === 'body' ? { display: {
      kind: 'chapterDiff', chapterId: 'chapter', revision: 5, before: '旧正文', after: '新正文' } } : {}) } }
    const receipt = runtimeJson(result)
    rows.set(step, { id: step, taskRootId: 'root', kind: 'internal', action: actions[step], status: 'succeeded', parentOperationId: 'parent',
      operationKey: `writing:parent:${step}`, inputSnapshot: snapshot.value, inputHash: snapshot.hash, effectReceipt: { result: receipt.value, resultHash: receipt.hash } })
    events.set(`effect:${step}`, { operationId: step, taskRootId: 'root', type: 'effect.committed', payload: { operationId: step, resultHash: receipt.hash } })
  })
  tx = { agentOperation: { findFirst: vi.fn(async ({ where }) => {
    const row = rows.get(where.id)
    return row && Object.entries(where).every(([key, value]) => row[key as keyof Row] === value) ? row : null
  }), findUnique: vi.fn(async ({ where }) => rows.get(where.id) ?? [...rows.values()].find(row => row.taskRootId === where.taskRootId_operationKey?.taskRootId
    && row.operationKey === where.taskRootId_operationKey?.operationKey) ?? null) },
  agentTaskRoot: { findUniqueOrThrow: vi.fn(async ({ where }) => where.id === lease.taskRootId
    ? { userId: lease.userId, novelId: 'novel', specSnapshot: spec } : null) },
  agentRun: { findFirstOrThrow: vi.fn(async ({ where }) => {
    const source = { id: lease.runId, userId: lease.userId, novelId: 'novel', chapterId: 'chapter', taskRootId: lease.taskRootId,
      sessionId: 'session', manuscriptRevision: 1, writingBindings: null }
    if (!Object.entries(where).every(([key, value]) => source[key as keyof typeof source] === value)) throw new Error('Missing owned source run')
    return source
  }) },
  agentExecutionFrame: { findUnique: vi.fn(async ({ where }) => where.taskRootId_revision.taskRootId === lease.taskRootId
    ? frames.get(where.taskRootId_revision.revision) ?? null : null) },
  agentExecutionOutbox: { findUnique: vi.fn(async ({ where }) => events.get(where.eventKey) ?? null) } }
  mocks.admitted.mockImplementation(async () => ({ operation: rows.get('parent'), input }))
  mocks.original.mockResolvedValue({ prompt: '完整写作本章', spec, taskId: spec.id, sourceRunId: lease.runId, parentRunId: null })
  mocks.target.mockResolvedValue(undefined); mocks.baseline.mockResolvedValue({ kind: 'chapter', revision: 4 })
})

describe('writing provenance bounded to one verification traversal', () => {
  it.each(['missing-owner', 'foreign-owner', 'different-task'] as const)('rejects an unauthenticated parent %s before traversing its receipts', async failure => {
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (failure === 'different-task') mocks.original.mockResolvedValue({ prompt: '完整写作本章', spec: { ...root.specSnapshot, id: 'different-task' } })
    else tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ ...root, userId: failure === 'missing-owner' ? undefined : 'foreign-owner' })
    await expect(read('quality')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.baseline).not.toHaveBeenCalled()
  })
  it.each(['quality', 'commit'] as const)('verifies every distinct %s predecessor once with one genuine parent admission', async step => {
    expect((await read(step)).step.step).toBe(step)
    expect(mocks.admitted).toHaveBeenCalledExactlyOnceWith(lease, { operationId: 'parent', action: 'chapter_write', novelId: 'novel', callId: 'writer' }, tx)
    expect(tx.agentTaskRoot.findUniqueOrThrow).toHaveBeenCalledTimes(1)
    const internalIds = tx.agentOperation.findFirst.mock.calls.map(([query]) => query.where).filter(where => where.kind === 'internal' && where.status === undefined).map(where => where.id)
    expect(internalIds.filter(id => id === 'body')).toHaveLength(1)
    expect(new Set(internalIds).size).toBe(step === 'quality' ? 3 : 4)
    expect(mocks.target).toHaveBeenCalledExactlyOnceWith(tx, { userId: lease.userId, novelId: 'novel', runId: lease.runId },
      { chapterId: 'chapter', effect: 'replace' })
    expect(mocks.original).toHaveBeenCalledTimes(internalIds.length)
    expect(tx.agentRun.findFirstOrThrow).toHaveBeenCalledTimes(internalIds.length - 1)
    for (const [query] of tx.agentRun.findFirstOrThrow.mock.calls) expect(query.where).toEqual({ id: lease.runId, userId: lease.userId, novelId: 'novel' })
  })

  it('does not reuse admission after the parent has closed, even in the same caller transaction', async () => {
    await read('commit')
    rows.get('parent')!.status = 'succeeded'
    await expect(read('commit')).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
  })

  it('rechecks lease/source authority on a new public read', async () => {
    await read('quality')
    mocks.admitted.mockRejectedValueOnce(Object.assign(Error('fenced'), { code: 'RUNTIME_LEASE_LOST' }))
    await expect(read('quality')).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    expect(mocks.admitted).toHaveBeenCalledTimes(2)
  })

  it.each(['input', 'result', 'event'] as const)('retains every %s integrity boundary after an earlier successful read', async failure => {
    await read('quality')
    if (failure === 'input') rows.get('body')!.inputHash = '0'.repeat(64)
    else if (failure === 'result') rows.get('body')!.effectReceipt!.resultHash = '0'.repeat(64)
    else events.delete('effect:body')
    await expect(read('quality')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })

  it.each(['parent', 'novel', 'call', 'chapter', 'sourceRevision', 'sourceHash', 'parentHash', 'cycle'] as const)(
    'rejects a validly hashed predecessor with a substituted %s binding', async failure => {
      const row = rows.get('continuity')!
      const envelope = JSON.parse(JSON.stringify(row.inputSnapshot))
      const saved = envelope.input, admission = saved.serviceAdmission
      if (failure === 'parent') admission.parentOperationId = 'foreign-parent'
      else if (failure === 'novel') saved.novelId = 'foreign-novel'
      else if (failure === 'call') saved.callId = 'foreign-call'
      else if (failure === 'chapter') admission.chapterId = 'foreign-chapter'
      else if (failure === 'sourceRevision') admission.sourceRevision++
      else if (failure === 'sourceHash') admission.sourceSnapshotHash = '0'.repeat(64)
      else if (failure === 'parentHash') admission.parentInputHash = '0'.repeat(64)
      else admission.source = { operationId: 'quality', resultHash: rows.get('quality')!.effectReceipt!.resultHash }
      const captured = runtimeJson(envelope)
      row.inputSnapshot = captured.value; row.inputHash = captured.hash
      await expect(read('quality')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    })
})

describe('committed writing provenance remains historical evidence', () => {
  it('authenticates committed receipts after the parent closes without admitting a new write', async () => {
    rows.get('parent')!.status = 'succeeded'
    expect((await readCommitted('commit')).step.step).toBe('commit')
    expect(mocks.admitted).not.toHaveBeenCalled()
    expect(mocks.target).not.toHaveBeenCalled()
    expect(tx.agentExecutionFrame.findUnique).toHaveBeenCalledWith({ where: { taskRootId_revision: { taskRootId: 'root', revision: 2 } } })
    expect(tx.agentExecutionFrame.findUnique).toHaveBeenCalledWith({ where: { taskRootId_revision: { taskRootId: 'root', revision: 1 } }, select: { snapshotHash: true } })
    expect(tx.agentExecutionFrame.findUnique).toHaveBeenCalledTimes(2)
    expect(tx.agentExecutionOutbox.findUnique).toHaveBeenCalledWith({ where: { eventKey: 'state:root:2' } })
    expect(tx.agentRun.findFirstOrThrow).toHaveBeenCalledTimes(4)
    await expect(read('commit')).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
    expect(mocks.admitted).not.toHaveBeenCalled()
  })

  it.each(['missing-frame', 'snapshot', 'state-event', 'chain', 'call', 'scope', 'owner'] as const)(
    'rejects committed history with substituted %s evidence', async failure => {
      rows.get('parent')!.status = 'succeeded'
      if (failure === 'missing-frame') frames.delete(2)
      else if (failure === 'snapshot') frames.get(2)!.snapshotHash = '0'.repeat(64)
      else if (failure === 'state-event') events.delete('state:root:2')
      else if (failure === 'chain') frames.get(1)!.snapshotHash = '0'.repeat(64)
      else if (failure === 'call') {
        const frame = frames.get(2)!
        const changed = saveFrame(2, { ...frame.snapshot, messages: [{ role: 'assistant', content: null,
          toolCalls: [{ id: 'foreign-call', name: 'chapter_write', arguments: '{}' }] }] }, frame.previousHash)
        // Keep every hash binding consistent so the actual source call must reject it.
        const parent = rows.get('parent')!, envelope = JSON.parse(JSON.stringify(parent.inputSnapshot))
        envelope.input.normalization.sourceSnapshotHash = changed.snapshotHash
        const captured = runtimeJson(envelope)
        parent.inputSnapshot = captured.value; parent.inputHash = captured.hash
        for (const row of rows.values()) if (row.kind === 'internal') {
          const internal = JSON.parse(JSON.stringify(row.inputSnapshot))
          internal.input.serviceAdmission.sourceSnapshotHash = changed.snapshotHash
          internal.input.serviceAdmission.parentInputHash = parent.inputHash
          const captured = runtimeJson(internal)
          row.inputSnapshot = captured.value; row.inputHash = captured.hash
        }
      } else if (failure === 'scope') {
        const original = await mocks.original()
        mocks.original.mockResolvedValue({ ...original, spec: { ...original.spec, scope: { ...original.spec.scope,
          writing: { ...original.spec.scope.writing, targets: [{ chapterId: 'foreign-chapter', orderIndex: 2 }] } } } })
      } else {
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
        tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ ...root, userId: 'foreign-owner' })
      }
      await expect(readCommitted('commit')).rejects.toMatchObject({ code: failure === 'missing-frame' ? 'RUNTIME_STATE_REQUIRED' : 'RUNTIME_RECEIPT_INVALID' })
      expect(mocks.admitted).not.toHaveBeenCalled()
      expect(mocks.target).not.toHaveBeenCalled()
    })
})
