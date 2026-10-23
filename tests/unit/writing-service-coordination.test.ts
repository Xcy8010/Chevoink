import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { executeCoordinatedWritingServices } from '../../api/lib/agent/writing-service-coordination.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ tx: { agentOperation: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  agentEffectReceipt: { findUnique: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() }, storyCompilation: { findFirst: vi.fn() }, chapter: { findFirstOrThrow: vi.fn() } },
  admitted: vi.fn(), prepare: vi.fn(), readService: vi.fn(), effect: vi.fn(), failure: vi.fn(), original: vi.fn(), body: vi.fn(),
  continuityWork: vi.fn(), continuity: vi.fn(), qualityWork: vi.fn(), quality: vi.fn(), commit: vi.fn(), compilerHash: vi.fn(), scenes: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(), withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', () => ({ readAdmittedToolOperation: mocks.admitted }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', () => ({ readAdmittedWritingServiceStep: mocks.readService, prepareWritingServiceStep: mocks.prepare,
  writingServiceOperationKey: (parentId: string, step: string) => `writing:${parentId}:${step}` }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ commitOperationEffect: mocks.effect, recordToolFailure: mocks.failure }))
vi.mock('../../api/lib/agent/runtime-compiler-observation.js', async original => ({ ...await original<object>(), compilerStateHash: mocks.compilerHash }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: mocks.original }))
vi.mock('../../api/lib/agent/manuscript-scope.js', () => ({ assertAgentManuscriptCurrent: vi.fn() }))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ isAgent2FeatureEnabled: () => false }))
vi.mock('../../api/lib/agent/tools/durable-chapter.js', () => ({ applyDurableChapterBody: mocks.body }))
vi.mock('../../api/lib/agent/story-compiler.js', () => ({ compilationRunScope: async () => ({ run: { taskRootId: 'root' } }),
  prepareStoryCompilation: vi.fn(), saveSceneTasksWithMilestone: mocks.scenes, recordStoryCompilerWrite: vi.fn() }))
vi.mock('../../api/lib/agent/tools/durable-continuity.js', () => ({ prepareContinuityWork: mocks.continuityWork, executePreparedContinuityWork: mocks.continuity }))
vi.mock('../../api/lib/agent/tools/durable-quality.js', () => ({ prepareQualityWork: mocks.qualityWork, executePreparedQualityWork: mocks.quality }))
vi.mock('../../api/lib/agent/tools/durable-compiler.js', () => ({ executePreparedCompilerWork: mocks.commit }))
vi.mock('../../api/lib/agent/tools/story-compiler-tools.js', () => ({ chapterBridgeCommitTool: { name: 'chapter_bridge_commit' } }))

type Operation = { id: string; taskRootId: string; parentOperationId: string | null; status: string; inputHash: string; inputSnapshot: unknown; action: string }
type Receipt = { operationId: string; result: unknown; resultHash: string }
const lease = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
let ctx: ToolContext, input: Record<string, unknown>, spec: ReturnType<typeof buildTaskSpec>
let operations: Map<string, Operation>, receipts: Map<string, Receipt>, keys: Map<string, string>, order: string[]
const stateHash = (step: number) => String(step).repeat(64)
function save(id: string, result: unknown, status = 'succeeded') {
  const captured = runtimeJson(result), receipt = { operationId: id, result: captured.value, resultHash: captured.hash }
  receipts.set(id, receipt); operations.get(id)!.status = status; order.push(id)
  return receipt
}
function reviewReceipt(id: string, hash: string) {
  return save(id, { compilerState: { id: 'compilation', hash }, toolResult: { output: `${id} original report`, summary: id } })
}
function knownFailure(id: string, code: string) {
  return save(id, { outcome: 'failed', effectApplied: false, code, toolResult: { output: `${id} known refusal`, summary: code } }, 'failed')
}
function refreshParent(draftComplete = true) {
  const writing = coordinatedWritingInputSchema.parse({ draftComplete, ...(draftComplete ? { actualOutcomes: { exitState: {} },
    chapterSummary: '本章的真实摘要', hookDecision: '', delayedHookReason: '', openingStructure: '动作开场', endingStructure: '保留行动' } : {}) })
  input = { novelId: 'novel', callId: 'writer', expectedRevision: 4, args: { chapterId: 'chapter', content: '新正文', writing },
    normalization: { sourceRevision: 2, sourceSnapshotHash: 'a'.repeat(64) },
    writingManifest: coordinatedWritingManifest({ spec, prompt: '完整写作本章' }, 'chapter_write', 'chapter', writing) }
  const snapshot = runtimeJson({ kind: 'tool', action: 'chapter_write', parentOperationId: null, input })
  const parent = { id: 'parent', taskRootId: 'root', parentOperationId: null, action: 'chapter_write', status: 'prepared', inputSnapshot: snapshot.value, inputHash: snapshot.hash }
  operations.set(parent.id, parent); mocks.admitted.mockImplementation(async () => ({ operation: parent, input }))
}
beforeEach(() => {
  vi.resetAllMocks(); operations = new Map(); receipts = new Map(); keys = new Map(); order = []
  ctx = { userId: 'user', novelId: 'novel', chapterId: 'chapter', runId: 'run', sessionId: 'session', callId: 'writer', mode: 'build', qualityMode: 'balanced',
    creativeFreedom: 'balanced', emit: vi.fn(), signal: new AbortController().signal, protectedChapterIds: new Set() }
  spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '完整写作本章' })
  spec.scope.writingCoordinationProtocol = 1; spec.writingPacing = 'explicit_writing'; spec.qualityMode = 'balanced'
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  refreshParent()
  mocks.tx.agentTaskRoot.findUniqueOrThrow.mockImplementation(async () => ({ novelId: 'novel', sessionId: 'session', specSnapshot: spec }))
  mocks.original.mockResolvedValue({ spec, prompt: '完整写作本章' })
  mocks.tx.agentOperation.findUnique.mockImplementation(async ({ where, include }) => {
    const id = where.id ?? keys.get(where.taskRootId_operationKey.operationKey), operation = operations.get(id)
    return operation ? { ...operation, ...(include?.effectReceipt ? { effectReceipt: receipts.get(id) ?? null } : {}) } : null
  })
  mocks.tx.agentOperation.findUniqueOrThrow.mockImplementation(mocks.tx.agentOperation.findUnique)
  mocks.tx.agentEffectReceipt.findUnique.mockImplementation(async ({ where }) => receipts.get(where.operationId) ?? null)
  mocks.prepare.mockImplementation(async (_lease, saved) => {
    const id = saved.serviceAdmission.step, key = `writing:parent:${id}`, captured = runtimeJson(saved), prior = operations.get(id)
    if (prior && runtimeJson((prior.inputSnapshot as { input: unknown }).input).hash !== captured.hash) throw Error('Changed immutable work')
    const action = id === 'body' ? 'chapter_write' : id === 'continuity' ? 'continuity_validate' : id === 'quality' ? 'quality_analyze' : 'chapter_bridge_commit'
    const snapshot = runtimeJson({ kind: 'internal', action, parentOperationId: 'parent', input: saved })
    const operation = prior ?? { id, taskRootId: 'root', parentOperationId: 'parent', status: 'prepared', action,
      inputSnapshot: snapshot.value, inputHash: snapshot.hash }
    operations.set(id, operation); keys.set(key, id); return operation
  })
  mocks.readService.mockImplementation(async (_lease, { operationId }) => {
    const operation = operations.get(operationId)!
    return { operation, input: (operation.inputSnapshot as { input: unknown }).input, original: input }
  })
  mocks.effect.mockImplementation(async (_lease, id, _hash, work) => {
    if (receipts.has(id)) return receipts.get(id)
    if (id === 'parent') expect(receipts.has('body')).toBe(true)
    return save(id, await work(mocks.tx))
  })
  mocks.failure.mockImplementation(async (_lease, { operationId, code }) => knownFailure(operationId, code))
  const scene = { purpose: '推进', entryState: {}, goal: '目标', obstacle: '障碍', choice: '选择', cost: '代价', turn: '转折', exitState: {}, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }
  mocks.tx.storyCompilation.findFirst.mockResolvedValue({ id: 'compilation', sceneTasks: [scene] })
  mocks.compilerHash.mockResolvedValue(stateHash(1))
  mocks.body.mockImplementation(async () => ({ toolResult: { output: '正文已保存', summary: '正文保存', display: { kind: 'chapterDiff',
    chapterId: 'chapter', chapterTitle: '章', before: '旧正文', after: '新正文', appliedDirectly: true, revision: 5 } }, memoryJobId: null,
    progress: { kind: 'content_revision', targetId: 'chapter', beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64) } }))
  mocks.continuityWork.mockResolvedValue({ kind: 'check', fixture: 'continuity' })
  mocks.qualityWork.mockResolvedValue({ kind: 'check', fixture: 'quality' })
  mocks.continuity.mockImplementation(async (_ctx, _lease, id) => reviewReceipt(id, stateHash(2)))
  mocks.quality.mockImplementation(async (_ctx, _lease, id) => reviewReceipt(id, stateHash(3)))
  mocks.commit.mockImplementation(async (_ctx, _lease, id) => reviewReceipt(id, stateHash(4)))
})

const execute = () => executeCoordinatedWritingServices(ctx, lease, 'parent', 'chapter_write')
describe('one-parent writing service coordination', () => {
  it('saves a draft without claiming review or commit', async () => {
    refreshParent(false)
    const receipt = await execute()
    expect(receipt.result).toMatchObject({ writingCompletion: { status: 'draft_saved' } })
    expect(order).toEqual(['body', 'parent']); expect(mocks.continuity).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled()
  })
  it('binds each next step to its genuine predecessor receipt and closes the parent last', async () => {
    expect((await execute()).result).toMatchObject({ writingCompletion: { status: 'completed', steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'quality' }, { step: 'commit' }] } })
    expect(order).toEqual(['body', 'continuity', 'quality', 'commit', 'parent'])
    expect(mocks.qualityWork).toHaveBeenCalledWith(ctx, lease, expect.objectContaining({ serviceReadOnly: true, baseline: { id: 'compilation', hash: stateHash(2) } }))
    expect(mocks.prepare.mock.calls.map(([, saved]) => saved.baseline?.hash ?? null)).toEqual([null, stateHash(1), stateHash(2), stateHash(3)])
    expect(mocks.body).toHaveBeenCalledWith(ctx, mocks.tx, expect.objectContaining({ expectedRevision: 4 }))
    expect(mocks.failure).not.toHaveBeenCalled()
  })
  it('recovers an interruption after the body from its receipt without another body CAS', async () => {
    mocks.continuityWork.mockRejectedValueOnce(Error('interrupted after body'))
    await expect(execute()).rejects.toThrow('interrupted after body')
    expect(operations.get('parent')!.status).toBe('prepared'); expect(receipts.has('body')).toBe(true)
    expect((await execute()).result).toMatchObject({ writingCompletion: { status: 'completed' } })
    expect(mocks.body).toHaveBeenCalledOnce(); expect(mocks.continuity).toHaveBeenCalledOnce()
  })
  it('leaves an unknown provider outcome pending without replaying its saved body', async () => {
    mocks.continuity.mockRejectedValueOnce(Error('provider result unknown')).mockRejectedValueOnce(new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', 'Original dispatched request'))
    await expect(execute()).rejects.toThrow('provider result unknown')
    await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(mocks.body).toHaveBeenCalledOnce(); expect(mocks.quality).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled()
    expect(receipts.has('parent')).toBe(false); expect(mocks.failure).not.toHaveBeenCalled()
  })
  it.each(['continuity', 'quality', 'commit'] as const)('retains a saved body when %s returns a known failed receipt', async stage => {
    mocks[stage].mockImplementation(async (_ctx, _lease, id) => knownFailure(id, 'ORIGINAL_REFUSAL'))
    const receipt = await execute()
    expect(receipt.result).toMatchObject({ writingCompletion: { status: 'blocked' }, toolResult: { outcome: 'failed', failureCode: 'ORIGINAL_REFUSAL',
      display: { chapterId: 'chapter', revision: 5, after: '新正文' }, output: expect.stringContaining(`${stage} known refusal`) } })
    expect(receipt.result).not.toHaveProperty('effectApplied', false)
    expect(operations.get('parent')!.status).toBe('succeeded') // Real saved effect with an explicitly blocked completion.
    expect(mocks.failure).not.toHaveBeenCalled()
    if (stage === 'continuity') expect(mocks.quality).not.toHaveBeenCalled()
    if (stage !== 'commit') expect(mocks.commit).not.toHaveBeenCalled()
  })
  it('does not commit after an incomplete report saved as a business effect', async () => {
    mocks.continuity.mockImplementation(async (_ctx, _lease, id) => save(id, { compilerState: { id: 'compilation', hash: stateHash(2) },
      toolResult: { output: 'Original incomplete report', outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' } }))
    expect((await execute()).result).toMatchObject({ writingCompletion: { status: 'blocked' } })
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.failure).not.toHaveBeenCalled()
  })
  it('records a confirmed body refusal without inventing saved prose or starting a review', async () => {
    mocks.body.mockRejectedValueOnce(new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', 'User edited the chapter'))
    expect((await execute()).result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'CHAPTER_REVISION_CONFLICT' })
    expect(mocks.continuity).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled()
    expect(receipts.get('parent')!.result).not.toHaveProperty('writingCompletion')
  })
  it('recovers a lost body-commit reply by reading the durable receipt', async () => {
    const original = mocks.effect.getMockImplementation()!
    mocks.effect.mockImplementationOnce(async (...args) => { await original(...args); throw Error('body commit reply lost') })
    await expect(execute()).rejects.toThrow('body commit reply lost')
    expect((await execute()).result).toMatchObject({ writingCompletion: { status: 'completed' } })
    expect(mocks.body).toHaveBeenCalledOnce(); expect(mocks.failure).not.toHaveBeenCalled()
  })
})
