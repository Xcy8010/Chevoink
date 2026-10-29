import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { executeCoordinatedWritingServices } from '../../api/lib/agent/writing-service-coordination.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ tx: { creditLedgerEntry: { findUnique: vi.fn() }, aiUsageLog: { findMany: vi.fn() }, agentArtifact: { findMany: vi.fn() }, agentOperation: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  agentEffectReceipt: { findUnique: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() }, storyCompilation: { findFirst: vi.fn() }, chapter: { findFirstOrThrow: vi.fn() } },
  admitted: vi.fn(), prepare: vi.fn(), readService: vi.fn(), effect: vi.fn(), failure: vi.fn(), original: vi.fn(), body: vi.fn(),
  continuityWork: vi.fn(), continuity: vi.fn(), qualityWork: vi.fn(), quality: vi.fn(), commit: vi.fn(), compilerHash: vi.fn(), scenes: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(), withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), readAdmittedToolOperation: mocks.admitted }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', () => ({ readAdmittedWritingServiceStep: mocks.readService, prepareWritingServiceStep: mocks.prepare,
  writingServiceOperationKey: (parentId: string, step: string) => `writing:${parentId}:${step}` }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ commitOperationEffect: mocks.effect, recordToolFailure: mocks.failure }))
vi.mock('../../api/lib/agent/runtime-compiler-observation.js', async original => ({ ...await original<object>(), compilerStateHash: mocks.compilerHash }))
vi.mock('../../api/lib/agent/original-request.js', async original => ({ ...await original<object>(), readOriginalTaskRequest: mocks.original,
  originalTaskRunIds: async () => ['run'] }))
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
  mocks.tx.creditLedgerEntry.findUnique.mockResolvedValue(null)
  mocks.tx.aiUsageLog.findMany.mockResolvedValue([])
  mocks.tx.agentArtifact.findMany.mockResolvedValue([])
  mocks.tx.agentOperation.findMany.mockResolvedValue([])
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
const noDispatch = () => {
  for (const mock of [mocks.prepare, mocks.body, mocks.continuityWork, mocks.continuity, mocks.qualityWork, mocks.quality, mocks.commit]) expect(mock).not.toHaveBeenCalled()
}
const bodyResult = () => ({ compilerState: { id: 'compilation', hash: stateHash(1) }, memoryJobId: 'original-memory-job',
  progress: { kind: 'content_revision', targetId: 'chapter', beforeHash: runtimeJson({ content: '旧正文' }).hash, afterHash: runtimeJson({ content: '新正文' }).hash },
  toolResult: { output: '正文已保存', summary: '原已保存正文', display: { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '章',
    before: '旧正文', after: '新正文', appliedDirectly: true, revision: 5 } } })
function historicalStep(step: 'body' | 'continuity' | 'quality' | 'commit', result: unknown, status = 'succeeded') {
  const action = step === 'body' ? 'chapter_write' : step === 'continuity' ? 'continuity_validate' : step === 'quality' ? 'quality_analyze' : 'chapter_bridge_commit'
  const snapshot = runtimeJson({ kind: 'internal', action, parentOperationId: 'parent', input: { historical: true, step } })
  operations.set(step, { id: step, taskRootId: 'root', parentOperationId: 'parent', action, status, inputHash: snapshot.hash, inputSnapshot: snapshot.value })
  keys.set('writing:parent:' + step, step)
  return save(step, result, status)
}
function historicalParent(status: 'draft_saved' | 'completed' | 'blocked', failedStage?: 'continuity' | 'quality' | 'commit') {
  const body = bodyResult()
  const steps = [{ step: 'body', operationId: 'body', resultHash: historicalStep('body', body).resultHash }]
  if (status !== 'draft_saved') for (const stage of ['continuity', 'quality', 'commit'] as const) {
    const result = stage === failedStage ? { outcome: 'failed', effectApplied: false, code: 'ORIGINAL_REFUSAL', toolResult: { output: stage + ' original refusal', summary: 'Original refusal' } }
      : { compilerState: { id: 'compilation', hash: stateHash(2) }, toolResult: { output: stage + ' original report', summary: stage } }
    steps.push({ step: stage, operationId: stage, resultHash: historicalStep(stage, result, stage === failedStage ? 'failed' : 'succeeded').resultHash })
    if (stage === failedStage) break
  }
  return save('parent', { ...body, writingCompletion: { version: 1, status, steps }, toolResult: { ...body.toolResult,
    ...(failedStage ? { outcome: 'failed', failureCode: 'ORIGINAL_REFUSAL', output: failedStage + ' original refusal; original saved body retained' } : {}) } })
}

describe('historical one-parent writing service coordination', () => {
  it('replays a saved draft without claiming a new review or commit', async () => {
    refreshParent(false)
    const saved = historicalParent('draft_saved'), before = structuredClone(saved), originalOrder = [...order]
    expect(await execute()).toEqual(saved)
    expect(saved).toEqual(before); expect(order).toEqual(originalOrder)
    expect(mocks.effect).toHaveBeenCalledWith(lease, 'parent', operations.get('parent')!.inputHash, expect.any(Function))
    await expect(mocks.effect.mock.calls[0][3](mocks.tx)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.failure).not.toHaveBeenCalled(); noDispatch()
  })
  it('retains each genuine predecessor receipt and the closed parent without executing the former chain', async () => {
    const saved = historicalParent('completed'), originalRows = structuredClone([...operations]), originalReceipts = structuredClone([...receipts])
    expect(await execute()).toEqual(saved)
    expect([...operations]).toEqual(originalRows); expect([...receipts]).toEqual(originalReceipts)
    expect(mocks.failure).not.toHaveBeenCalled(); noDispatch()
  })
  it('closes known unfinished historical work after its body without another body CAS', async () => {
    const body = historicalStep('body', bodyResult()), originalBody = structuredClone(body)
    const first = await execute()
    expect(first.result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(await execute()).toEqual(first)
    expect(receipts.get('body')).toEqual(originalBody)
    expect(operations.get('body')!.status).toBe('succeeded')
    expect(mocks.failure).toHaveBeenCalledOnce(); noDispatch()
  })
  it('leaves an unknown provider outcome pending without replaying its saved body', async () => {
    const body = historicalStep('body', bodyResult()), originalBody = structuredClone(body)
    const request = runtimeJson({ provider: 'fixture', model: 'fixture', request: { body: { messages: [] } } })
    const snapshot = runtimeJson({ kind: 'provider', action: 'continuity_critic', parentOperationId: 'continuity', input: {
      request: request.value, billing: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 } } })
    const physical = { id: 'original-provider', kind: 'provider', status: 'unknown', inputSnapshot: snapshot.value, inputHash: snapshot.hash,
      attempts: [{ id: 'original-attempt', status: 'unknown', requestSnapshot: request.value, requestHash: request.hash,
        result: null, resultHash: null, usageReceipt: null }], events: [] }
    const original = structuredClone(physical)
    mocks.tx.agentOperation.findMany.mockResolvedValue([physical])
    await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(receipts.get('body')).toEqual(originalBody); expect(physical).toEqual(original)
    expect(receipts.has('parent')).toBe(false); expect(mocks.failure).not.toHaveBeenCalled(); noDispatch()
  })
  it.each(['continuity', 'quality', 'commit'] as const)('retains a saved body and original %s failed receipt without restarting that stage', async stage => {
    const saved = historicalParent('blocked', stage), original = structuredClone(saved), originalRows = structuredClone([...operations])
    expect(await execute()).toEqual(original)
    expect(saved.result).toMatchObject({ writingCompletion: { status: 'blocked' }, memoryJobId: 'original-memory-job',
      progress: { kind: 'content_revision' }, toolResult: { outcome: 'failed', failureCode: 'ORIGINAL_REFUSAL', display: { chapterId: 'chapter', revision: 5, after: '新正文' } } })
    expect(saved.result).not.toHaveProperty('effectApplied', false)
    expect([...operations]).toEqual(originalRows); expect(mocks.failure).not.toHaveBeenCalled(); noDispatch()
  })
  it('does not commit after an incomplete historical report saved as a business effect', async () => {
    const body = historicalStep('body', bodyResult()), originalBody = structuredClone(body)
    const report = historicalStep('continuity', { compilerState: { id: 'compilation', hash: stateHash(2) },
      toolResult: { output: 'Original incomplete report', outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' } })
    const originalReport = structuredClone(report)
    expect((await execute()).result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(receipts.get('body')).toEqual(originalBody); expect(receipts.get('continuity')).toEqual(originalReport)
    noDispatch()
  })
  it('replays a confirmed body refusal without inventing saved prose or starting a review', async () => {
    const refusal = new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', 'User edited the chapter')
    const saved = knownFailure('parent', refusal.code), original = structuredClone(saved)
    expect(await execute()).toEqual(original)
    expect(saved.result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'CHAPTER_REVISION_CONFLICT' })
    expect(receipts.has('body')).toBe(false); expect(mocks.failure).not.toHaveBeenCalled(); noDispatch()
  })
  it('recovers a lost original receipt reply without another body transaction', async () => {
    const saved = historicalParent('completed'), originalReceipt = structuredClone(saved), original = mocks.effect.getMockImplementation()!
    mocks.effect.mockImplementationOnce(async (...args) => { await original(...args); throw Error('original receipt reply lost') })
    await expect(execute()).rejects.toThrow('original receipt reply lost')
    expect(await execute()).toEqual(originalReceipt)
    expect(receipts.get('body')).toMatchObject({ result: { memoryJobId: 'original-memory-job', progress: { kind: 'content_revision' } } })
    expect(mocks.failure).not.toHaveBeenCalled(); noDispatch()
  })
})
