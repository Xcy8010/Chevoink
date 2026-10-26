import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DataAccessError } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'
import type { AgentTool, ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ tx: { agentTaskRoot: { findUniqueOrThrow: vi.fn() }, agentOperation: { findUnique: vi.fn() }, chapter: { findFirst: vi.fn() } },
  admitted: vi.fn(), prepare: vi.fn(), reject: vi.fn(), original: vi.fn(), execute: vi.fn(), reduce: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(),
  withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(),
  readAdmittedToolOperation: mocks.admitted, prepareToolCursorOperation: mocks.prepare, rejectToolCursorCall: mocks.reject }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: mocks.original }))
vi.mock('../../api/lib/agent/writing-service-coordination.js', () => ({ executeCoordinatedWritingServices: mocks.execute }))
vi.mock('../../api/lib/agent/runtime-reducer.js', async () => {
  const { z } = await import('zod')
  return { reduceExecutionReceipt: mocks.reduce, failedToolResultSchema: z.object({ outcome: z.literal('failed'), effectApplied: z.literal(false), code: z.string(),
    toolResult: z.object({ output: z.string(), summary: z.string() }) }).strict() }
})
import { executeDurableCoordinatedWriter } from '../../api/lib/agent/tools/durable-coordinated-writer.js'

const lease = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const source = { expectedRevision: 2, expectedHash: 'a'.repeat(64) }
const pending = { revision: 3, snapshotHash: 'b'.repeat(64) }
const tool: AgentTool = { name: 'chapter_write', title: '写入正文', description: '', readOnly: false,
  permission: { plan: 'deny', build: 'allow', review: 'deny' },
  parameters: z.object({ chapterId: z.string().optional(), content: z.string(), writing: coordinatedWritingInputSchema }), execute: vi.fn() }
let ctx: ToolContext, spec: ReturnType<typeof buildTaskSpec>, args: Record<string, unknown>, saved: Record<string, unknown>
let parent: { id: string; operationKey: string; action: string; inputHash: string; inputSnapshot: ReturnType<typeof runtimeJson>['value'] }
let recovering: boolean, order: string[]
const prompt = '完整改写本章，本章不用质量检查。'

beforeEach(() => {
  vi.resetAllMocks(); recovering = true; order = []
  spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt })
  spec.writingPacing = 'explicit_writing'; spec.qualityMode = 'balanced'; spec.scope.writingCoordinationProtocol = 1
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  const writing = coordinatedWritingInputSchema.parse({ draftComplete: true, actualOutcomes: { exitState: {} },
    chapterSummary: '已保存的合成摘要', hookDecision: '', delayedHookReason: '', openingStructure: '行动开头', endingStructure: '等待回应' })
  args = { chapterId: 'chapter', content: '实际保存的合成正文。', writing }
  const normalization = { version: 1, rawArguments: JSON.stringify(args), normalizedArgsHash: runtimeJson(args).hash,
    sourceRevision: source.expectedRevision, sourceSnapshotHash: source.expectedHash }
  saved = { novelId: 'novel', callId: 'writer', args: structuredClone(args), expectedRevision: 4, normalization,
    writingManifest: coordinatedWritingManifest({ spec, prompt: '完整改写本章并检查。' }, tool.name, 'chapter', writing) }
  const snapshot = runtimeJson({ kind: 'tool', action: tool.name, parentOperationId: null, input: saved })
  parent = { id: 'parent', operationKey: 'exec:2', action: tool.name, inputHash: snapshot.hash, inputSnapshot: snapshot.value }
  ctx = { userId: 'user', novelId: 'novel', chapterId: 'chapter', runId: 'run', sessionId: 'session', callId: 'writer', mode: 'build',
    creativeFreedom: 'balanced', qualityMode: 'balanced', emit: vi.fn(), signal: new AbortController().signal,
    durableContent: { lease, cursor: { ...source }, operationKey: 'exec:2', chapterId: 'chapter', expectedRevision: 4 } }
  mocks.tx.agentTaskRoot.findUniqueOrThrow.mockImplementation(async () => ({ userId: 'user', novelId: 'novel', sessionId: 'session', specSnapshot: spec }))
  mocks.original.mockImplementation(async () => { order.push('original'); return { spec, prompt } })
  mocks.tx.agentOperation.findUnique.mockImplementation(async () => { order.push('lookup'); return recovering ? { id: 'parent' } : null })
  mocks.admitted.mockImplementation(async () => { order.push('authenticated'); return { operation: parent, input: saved } })
  mocks.tx.chapter.findFirst.mockImplementation(async ({ where }) => where.id === 'chapter' && where.authorId === 'user' && where.novelId === 'novel' ? { orderIndex: 1 } : null)
  mocks.prepare.mockImplementation(async (_lease, _cursor, input) => {
    order.push('prepare')
    const proposed = runtimeJson({ kind: 'tool', action: input.action, parentOperationId: null, input: { ...input.operationInput, normalization } })
    if (recovering && proposed.hash !== parent.inputHash) throw new DataAccessError(409, 'RUNTIME_IDENTITY_CONFLICT', 'Original input hash changed')
    return { operation: recovering ? parent : { ...parent, inputHash: proposed.hash, inputSnapshot: proposed.value }, pending }
  })
  mocks.execute.mockImplementation(async () => { order.push('execute'); const result = { toolResult: { output: '复用原父操作的已知交付' } }
    return { operationId: 'parent', result, resultHash: runtimeJson(result).hash } })
  mocks.reduce.mockImplementation(async () => { order.push('reduce') })
})
const execute = () => executeDurableCoordinatedWriter(ctx, tool, args)
const noWork = () => {
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.reduce).not.toHaveBeenCalled()
  expect(mocks.tx.chapter.findFirst).not.toHaveBeenCalled()
}

describe('authenticated prepared writer manifest recovery', () => {
  it('authenticates before reading a saved manifest, preserves old steps and then uses ordinary cursor/input-hash admission', async () => {
    const before = structuredClone(parent), originalInput = structuredClone(saved)
    expect(coordinatedWritingManifest({ spec, prompt }, tool.name, 'chapter', args.writing)).not.toEqual(saved.writingManifest)
    mocks.tx.agentOperation.findUnique.mockImplementation(async () => {
      order.push('lookup')
      return { id: 'parent', get inputSnapshot() { throw Error('Locator payload must not supply authority') } }
    })
    mocks.tx.chapter.findFirst.mockRejectedValue(Error('Recovery must not derive a fresh ordinal'))
    expect(await execute()).toMatchObject({ output: '复用原父操作的已知交付' })
    expect(order).toEqual(['original', 'lookup', 'authenticated', 'prepare', 'execute', 'reduce'])
    expect(mocks.tx.agentOperation.findUnique).toHaveBeenCalledWith({ where: { taskRootId_operationKey: { taskRootId: 'root', operationKey: 'exec:2' } }, select: { id: true } })
    expect(mocks.admitted).toHaveBeenCalledWith(lease, { operationId: 'parent', action: 'chapter_write', novelId: 'novel', callId: 'writer' }, mocks.tx)
    expect(mocks.prepare).toHaveBeenCalledWith(lease, source, expect.objectContaining({ key: 'exec:2', action: tool.name, callId: 'writer', targetId: 'chapter',
      effectiveArgs: args, operationInput: { novelId: 'novel', callId: 'writer', args, expectedRevision: 4, writingManifest: saved.writingManifest } }))
    expect(mocks.execute).toHaveBeenCalledWith(ctx, lease, 'parent', tool.name)
    expect(mocks.reduce).toHaveBeenCalledWith(lease, { expectedRevision: pending.revision, expectedHash: pending.snapshotHash, operationId: 'parent' })
    expect(mocks.tx.chapter.findFirst).not.toHaveBeenCalled()
    expect(parent).toEqual(before); expect(saved).toEqual(originalInput)
  })
  it.each(['RUNTIME_RECEIPT_INVALID', 'RUNTIME_STATE_CONFLICT', 'RUNTIME_LEASE_LOST'])('does not use a located payload rejected by the original reader: %s', async code => {
    mocks.admitted.mockRejectedValue(new DataAccessError(409, code, 'Original reader refused'))
    await expect(execute()).rejects.toMatchObject({ code })
    noWork()
  })
  it.each(['body', 'writing', 'argument-chapter', 'capability-chapter', 'revision', 'cursor-revision', 'cursor-hash', 'operation-key'] as const)('rejects a changed %s before services or cursor preparation', async changed => {
    if (changed === 'body') args.content = '另一次正文'
    if (changed === 'writing') args.writing = { ...(args.writing as object), chapterSummary: '另一次文学决定' }
    if (changed === 'argument-chapter') args.chapterId = 'another-chapter'
    if (changed === 'capability-chapter') ctx.durableContent!.chapterId = 'another-chapter'
    if (changed === 'revision') ctx.durableContent!.expectedRevision = 5
    if (changed === 'cursor-revision') ctx.durableContent!.cursor!.expectedRevision = 3
    if (changed === 'cursor-hash') ctx.durableContent!.cursor!.expectedHash = 'f'.repeat(64)
    if (changed === 'operation-key') ctx.durableContent!.operationKey = 'exec:other'
    await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    noWork()
  })
  it.each(['missing-manifest', 'chapter', 'writing-hash', 'step-order'] as const)('does not reinterpret an authenticated but invalid frozen %s', async changed => {
    if (changed === 'missing-manifest') delete saved.writingManifest
    else {
      const manifest = structuredClone(saved.writingManifest) as { chapterId: string; writingHash: string; steps: unknown[] }
      if (changed === 'chapter') manifest.chapterId = 'another-chapter'
      if (changed === 'writing-hash') manifest.writingHash = 'f'.repeat(64)
      if (changed === 'step-order') manifest.steps.reverse()
      saved.writingManifest = manifest
    }
    await expect(execute()).rejects.toMatchObject({ code: changed === 'missing-manifest' ? 'RUNTIME_IDENTITY_CONFLICT' : 'RUNTIME_RECEIPT_INVALID' })
    noWork()
  })
  it('retains the ordinary inputHash refusal even after original-reader authentication', async () => {
    parent.inputHash = '0'.repeat(64)
    await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(mocks.admitted).toHaveBeenCalledOnce()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.reduce).not.toHaveBeenCalled()
  })
  it('retains the ordinary approval-denied rejection and receipt reduction path', async () => {
    mocks.prepare.mockRejectedValue(new DataAccessError(409, 'RUNTIME_APPROVAL_DENIED', 'Author declined'))
    const result = { outcome: 'failed', effectApplied: false, code: 'TOOL_APPROVAL_DENIED', toolResult: { output: '原审批拒绝，未执行。', summary: '作者拒绝' } }
    mocks.reject.mockResolvedValue({ operation: parent, pending, receipt: { operationId: 'parent', result, resultHash: runtimeJson(result).hash } })
    expect(await execute()).toMatchObject({ outcome: 'failed', output: result.toolResult.output,
      resultSemantics: { kind: 'failed', reasonCode: 'TOOL_APPROVAL_DENIED', effectState: 'known_not_applied' } })
    expect(mocks.reject).toHaveBeenCalledWith(lease, source, ctx.callId)
    expect(mocks.reduce).toHaveBeenCalledOnce(); expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('derives fresh requirements only when no prior operation exists, using the real owned chapter order', async () => {
    recovering = false
    await execute()
    expect(mocks.admitted).not.toHaveBeenCalled()
    expect(mocks.tx.chapter.findFirst).toHaveBeenCalledWith({ where: { id: 'chapter', authorId: 'user', novelId: 'novel' }, select: { orderIndex: true } })
    const prepared = mocks.prepare.mock.calls[0][2]
    expect(prepared.operationInput.writingManifest.steps.map((step: { step: string }) => step.step)).toEqual(['body', 'continuity', 'commit'])
    expect(prepared.effectiveArgs).toEqual(args)
    expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.execute).toHaveBeenCalledOnce()
  })
  it('refuses a fresh operation when its owned chapter cannot be located', async () => {
    recovering = false; mocks.tx.chapter.findFirst.mockResolvedValue(null)
    await expect(execute()).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(mocks.admitted).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.reduce).not.toHaveBeenCalled()
  })
  it('rejects another root session before looking up a prior operation', async () => {
    mocks.tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ userId: 'user', novelId: 'novel', sessionId: 'another-session', specSnapshot: spec })
    await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(mocks.tx.agentOperation.findUnique).not.toHaveBeenCalled(); expect(mocks.admitted).not.toHaveBeenCalled()
    noWork()
  })
})
