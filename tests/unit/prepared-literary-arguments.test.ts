import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { prepareToolCursorOperation, readPreparedLiteraryArguments } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { sceneTaskBuildTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { firstThreePrototypeBuildTool } from '../../api/lib/agent/tools/research-dossier-tools.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'

const mocks = vi.hoisted(() => ({ tx: {} as Record<string, unknown>, leaseError: null as Error | null, effect: vi.fn(), reduce: vi.fn(),
  reject: vi.fn(), approval: vi.fn(), review: vi.fn(), observation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(),
  withRunLease: async (_token: unknown, work: (tx: unknown) => unknown) => { if (mocks.leaseError) throw mocks.leaseError; return work(mocks.tx) },
  withRunLeaseInTransaction: async (tx: unknown, _token: unknown, work: (tx: unknown) => unknown) => { if (mocks.leaseError) throw mocks.leaseError; return work(tx) },
}))
vi.mock('../../api/lib/agent/goal-fence.js', async original => ({ ...await original<object>(), readGoalExecution: async () => undefined }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), rejectToolCursorCall: mocks.reject }))
vi.mock('../../api/lib/agent/runtime-reducer.js', async original => ({ ...await original<object>(), reduceExecutionReceipt: mocks.reduce }))
vi.mock('../../api/lib/agent/runtime-operations.js', async original => ({ ...await original<object>(), commitOperationEffect: mocks.effect }))
vi.mock('../../api/lib/agent/runtime-approval.js', async original => ({ ...await original<object>(), assertToolApproval: mocks.approval }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', async original => ({ ...await original<object>(), readAdmittedReviewWork: mocks.review }))
vi.mock('../../api/lib/agent/runtime-compiler-observation.js', async original => ({ ...await original<object>(), readCompilerObservation: mocks.observation }))

const token = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const actions = ['scene_task_build', 'first_three_prototype_build'] as const
type Action = typeof actions[number]
const baseline = { id: 'compilation', hash: 'b'.repeat(64) }
function fixture(action: Action, fresh = false) {
  const tool = action === 'scene_task_build' ? sceneTaskBuildTool : firstThreePrototypeBuildTool
  const raw = action === 'scene_task_build' ? { tasks: [{ goal: '守住城门' }] } : { story_directions: ['旧案重启'] }
  // Simulate the already-admitted output of the previous normalizer, not a
  // fresh literary decision or a new permission to recreate missing content.
  const oldArgs = action === 'scene_task_build' ? sceneTaskBuildTool.parameters.parse({ tasks: [{
    purpose: '推进第 1 个场景', goal: '守住城门', obstacle: '目标受到具体阻力', choice: '人物必须作出选择',
    cost: '按既有设定记录实际后果，可无额外损失', turn: '场景状态发生变化',
  }] }) : firstThreePrototypeBuildTool.parameters.parse({ genreRisks: ['原已准入的风险'], volumeSpine: ['原脊柱一', '原脊柱二', '原脊柱三'],
    directions: [1, 2].map(index => ({ id: `direction-${index}`, title: `原方向${index}`, readerPromise: '原读者承诺',
      conflictEngine: '原冲突', differentiation: '原差异', risk: '原风险' })),
    chapterBlueprints: [1, 2, 3].map(orderIndex => ({ orderIndex, title: `原第${orderIndex}章`, chapterJob: '原章节任务', concreteEvent: '原事件',
      protagonistChoice: '原选择', cost: '原代价', newInformation: '原信息', exitHook: '原钩子', qualityRisks: [] })) })
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '核对原任务中的已保存资料。' })
  const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: [{ type: 'function', function: { name: action, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
    toolAuthority: [{ name: action, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] }
  const sourceSnapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    messages: [{ role: 'assistant', content: null, toolCalls: [{ id: 'call', name: action, arguments: JSON.stringify(raw) }] }], successfulToolSignatures: [] }
  const source = { taskRootId: 'root', revision: 0, previousHash: null, snapshot: sourceSnapshot, snapshotHash: runtimeJson(sourceSnapshot).hash }
  const pendingSnapshot = { ...structuredClone(sourceSnapshot), phase: 'awaiting_operation', pendingOperationId: 'operation', nextOperationSequence: 1 }
  const pending = { taskRootId: 'root', revision: 1, previousHash: source.snapshotHash, snapshot: pendingSnapshot, snapshotHash: runtimeJson(pendingSnapshot).hash }
  const normalization = { version: 1, rawArguments: JSON.stringify(raw), normalizedArgsHash: runtimeJson(oldArgs).hash,
    sourceRevision: 0, sourceSnapshotHash: source.snapshotHash }
  const input = action === 'scene_task_build' ? { callId: 'call', novelId: 'novel', args: oldArgs, baseline, normalization }
    : { callId: 'call', taskRootId: 'root', args: oldArgs, normalization }
  const captured = runtimeJson({ kind: 'tool', action, parentOperationId: null, input })
  const operation = { id: 'operation', taskRootId: 'root', operationKey: 'exec:0', kind: 'tool', action, status: 'prepared', parentOperationId: null,
    inputSnapshot: captured.value, inputHash: captured.hash }
  const root = { id: 'root', userId: 'user', novelId: 'novel', sessionId: 'session', specSnapshot: JSON.parse(JSON.stringify(spec)) as typeof spec, requestSnapshot: { prompt: '原请求' }, inputHash: '' }
  root.inputHash = runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
  const head = { revision: fresh ? 0 : 1, configuration, configurationHash: runtimeJson({ configuration, inputHash: root.inputHash }).hash }
  const frames = [source, pending]
  const events = frames.map(frame => ({ taskRootId: 'root', type: 'execution.state.saved',
    payload: { revision: frame.revision, previousHash: frame.previousHash, snapshotHash: frame.snapshotHash } }))
  const tx = {
    agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => root) }, agentExecutionState: { findUnique: vi.fn(async () => head), updateMany: vi.fn() },
    agentExecutionFrame: { findFirst: vi.fn(async () => ({ revision: head.revision })), findUnique: vi.fn(async ({ where }) => frames[where.taskRootId_revision.revision]), create: vi.fn() },
    agentExecutionOutbox: { findUnique: vi.fn(async ({ where }) => events[Number(where.eventKey.split(':').at(-1))]), create: vi.fn() },
    agentOperation: { findUniqueOrThrow: vi.fn(async () => operation), findUnique: vi.fn(async () => fresh ? null : operation),
      findFirst: vi.fn(async ({ where }) => Object.entries(where).every(([key, value]) => operation[key as keyof typeof operation] === value) ? operation : null), create: vi.fn() },
    agentProviderAttempt: { create: vi.fn() }, creditLedgerEntry: { create: vi.fn() }, aiUsageLog: { create: vi.fn() },
  }
  mocks.tx = tx
  mocks.observation.mockResolvedValue(baseline)
  mocks.review.mockImplementation(async () => ({ operation, input: (operation.inputSnapshot as { input: unknown }).input }))
  const result = { toolResult: { output: '原操作的已知结果', summary: '原结果' } }
  mocks.effect.mockResolvedValue({ operationId: operation.id, result, resultHash: runtimeJson(result).hash })
  const failed = { outcome: 'failed', effectApplied: false, code: 'TOOL_SCHEMA_INVALID', toolResult: { output: '新参数缺少文学字段，未执行。', summary: '参数校验失败' } }
  mocks.reject.mockResolvedValue({ operation, pending, receipt: { operationId: operation.id, result: failed, resultHash: runtimeJson(failed).hash } })
  const cursor = { expectedRevision: 0, expectedHash: source.snapshotHash }
  const read = () => readPreparedLiteraryArguments(tx as unknown as Prisma.TransactionClient, token, { action, callId: 'call', rawArguments: JSON.stringify(raw), cursor })
  const prepare = (effectiveArgs: unknown = oldArgs, extra: Record<string, unknown> = {}) => prepareToolCursorOperation(token, cursor, {
    key: 'exec:0', action, callId: 'call', targetId: 'root', effectDomain: action === 'scene_task_build' ? 'compiler' : 'task', effectiveArgs,
    normalize: value => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, value]) => value !== undefined)),
    operationInput: runtimeJson({ ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'normalization')), ...extra }).value,
  })
  const noNewWork = () => {
    expect(tx.agentOperation.create).not.toHaveBeenCalled(); expect(tx.agentExecutionFrame.create).not.toHaveBeenCalled()
    expect(tx.agentExecutionOutbox.create).not.toHaveBeenCalled(); expect(tx.agentExecutionState.updateMany).not.toHaveBeenCalled()
    expect(tx.agentProviderAttempt.create).not.toHaveBeenCalled(); expect(tx.creditLedgerEntry.create).not.toHaveBeenCalled(); expect(tx.aiUsageLog.create).not.toHaveBeenCalled()
  }
  return { tool, raw, oldArgs, source, pending, input, operation, root, head, events, tx, cursor, read, prepare, noNewWork,
    rehash: () => { operation.inputHash = runtimeJson(operation.inputSnapshot).hash },
    reconfigure: () => { head.configurationHash = runtimeJson({ configuration, inputHash: root.inputHash }).hash } }
}

beforeEach(() => { vi.clearAllMocks(); mocks.leaseError = null })
afterEach(() => { vi.unstubAllGlobals() })

describe('prepared literary calls keep their original normalized arguments', () => {
  it.each(actions)('%s passes both live selection and ordinary cursor admission with its frozen args and original operation', async action => {
    const f = fixture(action), before = structuredClone(f.operation)
    expect(f.tool.parameters.safeParse(normalizeToolInput(f.tool, f.raw)).success).toBe(false)
    expect(await f.read()).toEqual(f.oldArgs)
    expect((await f.prepare()).operation.id).toBe(f.operation.id)
    expect(await executeDurableToolStep(token, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { output: '原操作的已知结果' } })
    expect(mocks.effect).toHaveBeenCalledOnce()
    expect(mocks.effect.mock.calls[0].slice(0, 3)).toEqual([token, f.operation.id, f.operation.inputHash])
    expect(mocks.reduce).toHaveBeenCalledWith(token, { expectedRevision: 1, expectedHash: f.pending.snapshotHash, operationId: f.operation.id })
    expect(f.operation).toEqual(before); expect(mocks.reject).not.toHaveBeenCalled()
    f.noNewWork()
  })
  it.each(actions)('%s keeps fresh incomplete input rejected without creating literary data or paid work', async action => {
    const f = fixture(action, true)
    expect(await f.read()).toBeNull()
    expect(await executeDurableToolStep(token, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect(mocks.reject).toHaveBeenCalledOnce(); expect(mocks.effect).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled(); f.noNewWork()
  })
  it.each(actions)('%s still rejects changed effective args and a changed complete operation envelope', async action => {
    const f = fixture(action)
    await expect(f.prepare({ ...f.oldArgs, extra: 'changed' })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    await expect(f.prepare(f.oldArgs, { extra: 'changed' })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(mocks.effect).not.toHaveBeenCalled(); f.noNewWork()
  })
  it.each(actions.flatMap(action => ['input-hash', 'args-hash', 'raw', 'source-hash', 'call-id', 'novel-or-root', 'owner', 'source-event', 'pending-messages', 'operation-key'].map(tamper => ({ action, tamper }))))(
    '$action rejects tampered $tamper before effects or new work', async ({ action, tamper }) => {
      const f = fixture(action), saved = (f.operation.inputSnapshot as { input: Record<string, unknown> }).input
      const normalization = saved.normalization as Record<string, unknown>
      if (tamper === 'input-hash') f.operation.inputHash = '0'.repeat(64)
      if (tamper === 'args-hash') normalization.normalizedArgsHash = '0'.repeat(64)
      if (tamper === 'raw') normalization.rawArguments = '{}'
      if (tamper === 'source-hash') normalization.sourceSnapshotHash = '0'.repeat(64)
      if (tamper === 'call-id') saved.callId = 'different-call'
      if (tamper === 'novel-or-root') saved[action === 'scene_task_build' ? 'novelId' : 'taskRootId'] = 'different-scope'
      if (tamper === 'owner') f.root.userId = 'another-author'
      if (tamper === 'source-event') f.events[0].payload.snapshotHash = '0'.repeat(64)
      if (tamper === 'pending-messages') f.pending.snapshot.messages[0].toolCalls[0].arguments = '{}'
      if (tamper === 'operation-key') f.operation.operationKey = 'exec:other'
      if (!['input-hash', 'source-event', 'pending-messages'].includes(tamper)) f.rehash()
      await expect(executeDurableToolStep(token, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.reject).not.toHaveBeenCalled(); f.noNewWork()
    })
  it.each(actions)('%s retains deny and original approval checks on the prepared cursor', async action => {
    const f = fixture(action)
    f.head.configuration.toolAuthority[0].permission = 'deny'; f.reconfigure()
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
    f.head.configuration.toolAuthority[0].permission = 'ask'; f.reconfigure()
    mocks.approval.mockRejectedValueOnce(Object.assign(new Error('Original approval rejected'), { code: 'RUNTIME_APPROVAL_DENIED' }))
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RUNTIME_APPROVAL_DENIED' })
    expect(mocks.approval).toHaveBeenCalledWith(mocks.tx, token, f.source.snapshotHash, 'call', action, JSON.stringify(f.raw), runtimeJson(f.oldArgs).hash)
    expect(mocks.effect).not.toHaveBeenCalled(); f.noNewWork()
  })
  it.each(['succeeded', 'failed'] as const)('keeps %s operations on the existing reduction path without re-normalizing or redispatching', async status => {
    const f = fixture('scene_task_build'); f.operation.status = status
    expect(await executeDurableToolStep(token, new AbortController().signal)).toMatchObject({ kind: 'recovered' })
    expect(mocks.reduce).toHaveBeenCalledOnce(); expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled(); f.noNewWork()
  })
  it('does not recover these arguments under a lost lease', async () => {
    const f = fixture('scene_task_build')
    mocks.leaseError = Object.assign(new Error('Lost lease'), { code: 'RUNTIME_LEASE_LOST' })
    await expect(executeDurableToolStep(token, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    expect(mocks.effect).not.toHaveBeenCalled(); expect(f.tx.agentOperation.findFirst).not.toHaveBeenCalled(); f.noNewWork()
  })
})
