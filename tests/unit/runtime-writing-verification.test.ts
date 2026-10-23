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
let rows: Map<string, Row>, events: Map<string, object>
let tx: { agentOperation: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  agentTaskRoot: { findUniqueOrThrow: ReturnType<typeof vi.fn> }; agentExecutionOutbox: { findUnique: ReturnType<typeof vi.fn> } }
const compiler = (step: number) => ({ id: 'compilation', hash: String(step).repeat(64) })
const identity = (step: keyof typeof actions) => ({ operationId: step, action: actions[step], novelId: 'novel', callId: 'writer' })
const read = (step: keyof typeof actions) => readAdmittedWritingServiceStep(lease, identity(step), tx as unknown as RuntimeTx)

beforeEach(() => {
  vi.resetAllMocks(); rows = new Map(); events = new Map()
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '完整写作本章' })
  spec.scope.writingCoordinationProtocol = 1; spec.writingPacing = 'explicit_writing'; spec.qualityMode = 'balanced'
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  const writing = coordinatedWritingInputSchema.parse({ draftComplete: true, actualOutcomes: { exitState: {} },
    chapterSummary: '本章摘要', hookDecision: '', delayedHookReason: '', openingStructure: '开场', endingStructure: '结束' })
  const args = { chapterId: 'chapter', content: '新正文', writing }
  const normalization = { version: 1, rawArguments: JSON.stringify(args), normalizedArgsHash: runtimeJson(args).hash,
    sourceRevision: 2, sourceSnapshotHash: 'a'.repeat(64) }
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
  agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => ({ novelId: 'novel', specSnapshot: spec })) },
  agentExecutionOutbox: { findUnique: vi.fn(async ({ where }) => events.get(where.eventKey) ?? null) } }
  mocks.admitted.mockImplementation(async () => ({ operation: rows.get('parent'), input }))
  mocks.original.mockResolvedValue({ prompt: '完整写作本章' })
  mocks.target.mockResolvedValue(undefined); mocks.baseline.mockResolvedValue({ kind: 'chapter', revision: 4 })
})

describe('writing provenance bounded to one verification traversal', () => {
  it.each(['quality', 'commit'] as const)('verifies every distinct %s predecessor once with one genuine parent admission', async step => {
    expect((await read(step)).step.step).toBe(step)
    expect(mocks.admitted).toHaveBeenCalledExactlyOnceWith(lease, { operationId: 'parent', action: 'chapter_write', novelId: 'novel', callId: 'writer' }, tx)
    expect(mocks.original).toHaveBeenCalledTimes(1)
    expect(tx.agentTaskRoot.findUniqueOrThrow).toHaveBeenCalledTimes(1)
    const internalIds = tx.agentOperation.findFirst.mock.calls.map(([query]) => query.where).filter(where => where.kind === 'internal').map(where => where.id)
    expect(internalIds.filter(id => id === 'body')).toHaveLength(1)
    expect(new Set(internalIds).size).toBe(step === 'quality' ? 3 : 4)
    expect(mocks.target).toHaveBeenCalledTimes(internalIds.length)
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
