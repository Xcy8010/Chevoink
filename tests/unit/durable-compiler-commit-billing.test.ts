import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool, ToolContext } from '../../api/lib/agent/tools/types.js'
import { executePreparedCompilerWork } from '../../api/lib/agent/tools/durable-compiler.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({ admitted: vi.fn(), manifest: vi.fn(), confirmations: vi.fn(), readiness: vi.fn(),
  billing: vi.fn(), prepareReviews: vi.fn(), recover: vi.fn(), effect: vi.fn(), failure: vi.fn(), execute: vi.fn(),
  tx: { agentOperation: { findMany: vi.fn(), count: vi.fn() }, agentEffectReceipt: { findUnique: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() },
    storyCompilation: { findUniqueOrThrow: vi.fn() } } }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', () => ({ readAdmittedReviewWork: mocks.admitted,
  requiredCommitReviewManifest: mocks.manifest, readWritingServiceConfirmations: mocks.confirmations }))
vi.mock('../../api/lib/agent/tools/durable-quality.js', () => ({ executePreparedQualityWork: mocks.recover }))
vi.mock('../../api/lib/agent/tools/durable-continuity.js', () => ({ executePreparedContinuityWork: mocks.recover }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ commitOperationEffect: mocks.effect, recordToolFailure: mocks.failure }))
vi.mock('../../api/lib/agent/runtime-compiler-observation.js', async original => ({ ...await original<object>(), compilerStateHash: async () => 'a'.repeat(64) }))
vi.mock('../../api/lib/agent/chapter-review-guard.js', () => ({ readChapterReviewReadiness: mocks.readiness }))
vi.mock('../../api/lib/agent/continuity-review.js', () => ({ readContinuityRequestBilling: mocks.billing }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: async () => ({ taskId: 'task' }), originalTaskRunIds: async () => ['run'] }))
vi.mock('../../api/lib/agent/tools/story-compiler-tools.js', () => ({ prepareChapterCommitReviews: mocks.prepareReviews }))

const lease = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const ctx: ToolContext = { userId: 'user', novelId: 'novel', runId: 'run', sessionId: 'session', callId: 'commit', mode: 'build',
  creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
const tool: AgentTool = { name: 'chapter_bridge_commit', title: '提交章节', description: '合成本地提交', parameters: z.object({ compilationId: z.string() }),
  permission: { plan: 'deny', build: 'allow', review: 'deny' }, readOnly: false, execute: mocks.execute }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.admitted.mockResolvedValue({ operation: { id: 'commit-op', inputHash: 'b'.repeat(64), operationKey: 'commit' }, input: {
    args: { compilationId: 'comp' }, baseline: null, normalization: { sourceRevision: 1, sourceSnapshotHash: 'c'.repeat(64) } } })
  mocks.tx.agentOperation.findMany.mockResolvedValue([])
  mocks.tx.agentOperation.count.mockResolvedValue(0)
  mocks.manifest.mockResolvedValue({ chapterId: 'chapter' })
  mocks.readiness.mockResolvedValue({ ready: true, requiredTools: [] })
  mocks.billing.mockResolvedValue({ known: false, hasRequest: true })
  mocks.tx.agentEffectReceipt.findUnique.mockResolvedValue(null)
  mocks.tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ id: 'root', novelId: 'novel', sessionId: 'session' })
  mocks.tx.storyCompilation.findUniqueOrThrow.mockResolvedValue({ chapterId: 'chapter' })
  mocks.execute.mockResolvedValue({ output: '章节已提交', display: { kind: 'storyCompiler', compilationId: 'comp', phase: 'commit', title: '章节已提交' } })
  mocks.effect.mockImplementation(async (_lease, operationId, _hash, apply) => {
    const result = await apply(mocks.tx)
    return { operationId, result, resultHash: runtimeJson(result).hash }
  })
  mocks.failure.mockImplementation(async (_lease, input) => ({ result: { outcome: 'failed', code: input.code } }))
})

describe('durable local commit and paid review admission', () => {
  it('commits ready reports without checking or retrying unrelated unknown provider work', async () => {
    const result = await executePreparedCompilerWork(ctx, lease, 'commit-op', tool)
    expect(result.result).toMatchObject({ toolResult: { output: '章节已提交' }, compilerState: { id: 'comp' } })
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.billing).not.toHaveBeenCalled()
    expect(mocks.effect).toHaveBeenCalledOnce()
    expect(mocks.confirmations).not.toHaveBeenCalled()
    expect(mocks.prepareReviews).not.toHaveBeenCalled()
  })

  it.each(['continuity_validate', 'quality_analyze'] as const)('does not silently turn local commit into a paid %s dispatch', async name => {
    mocks.prepareReviews.mockImplementation(async (current: ToolContext) => current.registeredReview!(name, { compilationId: 'comp' }))
    expect((await executePreparedCompilerWork(ctx, lease, 'commit-op', tool)).result).toMatchObject({ toolResult: { output: '章节已提交' } })
    expect(mocks.prepareReviews).not.toHaveBeenCalled()
    expect(mocks.billing).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.effect).toHaveBeenCalledOnce()
  })

  it('commits the actual saved chapter independently of missing report advice without changing report state', async () => {
    mocks.prepareReviews.mockResolvedValue({ outcome: 'failed', failureCode: 'QUALITY_CHECK_REQUIRED', output: '当前质量报告缺失' })
    expect((await executePreparedCompilerWork(ctx, lease, 'commit-op', tool)).result).toMatchObject({ toolResult: { output: '章节已提交' } })
    expect(mocks.prepareReviews).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.effect).toHaveBeenCalledOnce()
  })
})

it.each(['known-result', 'unknown-result'] as const)('recovers an existing internal check before completing its original parent: %s', async scenario => {
  const snapshot = runtimeJson({ input: { original: 'unchanged' } })
  mocks.tx.agentOperation.findMany.mockResolvedValue([{ id: 'old-quality', action: 'quality_analyze', inputSnapshot: snapshot.value, inputHash: snapshot.hash }])
  if (scenario === 'unknown-result') mocks.recover.mockRejectedValue(new (await import('../../api/lib/prisma.js')).DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', 'unknown original result'))
  if (scenario === 'known-result') {
    await executePreparedCompilerWork(ctx, lease, 'commit-op', tool)
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(ctx, lease, 'old-quality')
    expect(mocks.recover.mock.invocationCallOrder[0]).toBeLessThan(mocks.effect.mock.invocationCallOrder[0])
  } else {
    await expect(executePreparedCompilerWork(ctx, lease, 'commit-op', tool)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled()
  }
  expect(mocks.prepareReviews).not.toHaveBeenCalled(); expect(mocks.manifest).not.toHaveBeenCalled()
})
