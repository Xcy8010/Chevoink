import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool, ToolContext } from '../../api/lib/agent/tools/types.js'
import { executePreparedCompilerWork } from '../../api/lib/agent/tools/durable-compiler.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({ admitted: vi.fn(), manifest: vi.fn(), confirmations: vi.fn(), readiness: vi.fn(),
  billing: vi.fn(), prepareReviews: vi.fn(), effect: vi.fn(), failure: vi.fn(), execute: vi.fn(),
  tx: { agentEffectReceipt: { findUnique: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() },
    storyCompilation: { findUniqueOrThrow: vi.fn() } } }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', () => ({ readAdmittedReviewWork: mocks.admitted,
  requiredCommitReviewManifest: mocks.manifest, readWritingServiceConfirmations: mocks.confirmations }))
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
    expect(mocks.confirmations).toHaveBeenCalledWith(mocks.tx, lease, [])
  })

  it.each(['continuity_validate', 'quality_analyze'] as const)('reconciles before a real %s dispatch even when the first readiness was complete', async name => {
    mocks.prepareReviews.mockImplementation(async (current: ToolContext) => current.registeredReview!(name, { compilationId: 'comp' }))
    await expect(executePreparedCompilerWork(ctx, lease, 'commit-op', tool)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(mocks.billing).toHaveBeenCalledExactlyOnceWith(mocks.tx, ctx, { runIds: ['run'], chapter: { id: 'chapter' } }, null)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.effect).not.toHaveBeenCalled()
  })

  it('preserves a newly missing current report as a failure before the local commit', async () => {
    mocks.prepareReviews.mockResolvedValue({ outcome: 'failed', failureCode: 'QUALITY_CHECK_REQUIRED', output: '当前质量报告缺失' })
    expect((await executePreparedCompilerWork(ctx, lease, 'commit-op', tool)).result).toMatchObject({ outcome: 'failed', code: 'QUALITY_CHECK_REQUIRED' })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.effect).not.toHaveBeenCalled()
  })
})
