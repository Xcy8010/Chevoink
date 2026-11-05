import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
const original = vi.hoisted(() => ({ prompt: '完成指定的两章并复查', taskId: 'task' }))
const native = vi.hoisted(() => ({ state: vi.fn(), evidence: vi.fn(), snapshot: vi.fn() }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ originalTaskRunIds: vi.fn(async () => ['original', 'continue']) }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ readEffectiveWritingRequest: vi.fn(async () => original) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: native.state }))
vi.mock('../../api/lib/agent/runtime-evidence.js', () => ({ collectDurableToolEvidence: native.evidence }))
vi.mock('../../api/lib/agent/continuity-review.js', () => ({ buildContinuitySnapshot: native.snapshot }))
import { readWritingCollaborationDigest, WRITING_COLLABORATION_GUIDANCE } from '../../api/lib/agent/writing-collaboration.js'
const subject = { userId: 'author', novelId: 'novel', runId: 'continue' }
const content = '原稿保留。'
const contentHash = createHash('sha256').update(content).digest('hex')
function database() {
  return { agentRun: { findFirst: vi.fn(async () => ({ taskRootId: null as string | null })) },
    agentExecutionState: { findUnique: vi.fn(async () => ({ taskRootId: 'root' })) },
    agentMessage: { findMany: vi.fn(async () => [{ parts: [{ type: 'tool-call', toolName: 'chapter_write', status: 'success', display: { chapterId: 'chapter' } }] }]) },
    chapter: { findMany: vi.fn(async () => [{ id: 'chapter', title: '目标章', orderIndex: 2, revision: 3, content }]) },
    agentArtifact: { findFirst: vi.fn(async () => null as { metadata: unknown } | null) },
    chapterQualityReport: { findFirst: vi.fn(async () => null as { id: string; chapterRevision: number; status: string; deterministicMetrics: unknown } | null) },
    agentEffectReceipt: { findUniqueOrThrow: vi.fn(async () => ({ result: { toolResult: { display: { kind: 'chapterRef', chapterId: 'chapter' } } } })) },
    agentOperation: { findUniqueOrThrow: vi.fn(async () => ({ inputSnapshot: { input: { args: {} } } })) },
  }
}
const read = (db: ReturnType<typeof database>) => readWritingCollaborationDigest(db as unknown as Prisma.TransactionClient, subject)
beforeEach(() => { vi.clearAllMocks(); native.state.mockResolvedValue({ frame: { revision: 5 } }); native.evidence.mockResolvedValue({ effects: [] }); native.snapshot.mockResolvedValue({ contextHash: 'current-dependencies' }) })

it('retains original multi-chapter goal and distinguishes saved text from both missing checks', async () => {
  const db = database(), digest = await read(db)
  expect(digest).toContain(original.prompt)
  expect(digest).toContain('"body":"当前已有保存正文"')
  expect(digest).toContain('"continuity":"未调用"')
  expect(digest).toContain('"humanity":"未调用"')
  expect(db.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original', 'continue'] }, run: { userId: 'author', novelId: 'novel' } }) }))
  expect(db.chapter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['chapter'] }, authorId: 'author', novelId: 'novel' }) }))
})
it('does not invent a chapter workflow before a real relevant tool result', async () => {
  const db = database(); db.agentMessage.findMany.mockResolvedValue([])
  expect(await read(db)).toBe('')
  expect(db.chapter.findMany).not.toHaveBeenCalled()
})
it('includes a review-only target without requiring a body mutation', async () => {
  const db = database(); db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', toolName: 'continuity_validate', status: 'success', display: { chapterId: 'chapter' } }] }])
  expect(await read(db)).toContain('"chapterId":"chapter"')
})
it('reports empty native creations from durable evidence even when UI projection has not run', async () => {
  const db = database(); db.agentRun.findFirst.mockResolvedValue({ taskRootId: 'root' })
  native.evidence.mockResolvedValue({ effects: [{ operationId: 'effect', action: 'chapter_create', outcome: 'succeeded' }] })
  db.chapter.findMany.mockResolvedValue([{ id: 'chapter', title: '目标章', orderIndex: 2, revision: 1, content: '' }])
  expect(await read(db)).toContain('空章，正文未写入')
  expect(db.agentMessage.findMany).not.toHaveBeenCalled()
})
it('does not turn failed native effects into saved chapter progress', async () => {
  const db = database(); db.agentRun.findFirst.mockResolvedValue({ taskRootId: 'root' })
  native.evidence.mockResolvedValue({ effects: [{ operationId: 'effect', action: 'chapter_create', outcome: 'failed' }] })
  expect(await read(db)).toBe('')
  expect(db.agentEffectReceipt.findUniqueOrThrow).not.toHaveBeenCalled()
})
it('checks complete continuity against actual current predecessor/plan dependencies, not just body revision', async () => {
  const db = database(); db.agentArtifact.findFirst.mockResolvedValue({ metadata: { continuityReport: { chapterId: 'chapter', revision: 3, contentHash, contextHash: 'old-predecessor-set', complete: true, billingKnown: true } } })
  expect(await read(db)).toContain('"continuity":"已过期"')
  native.snapshot.mockResolvedValue({ contextHash: 'old-predecessor-set' })
  expect(await read(db)).toContain('当前版本报告已取得，意见另行判断')
})
it('keeps unknown billing, incomplete report and stale quality separate from pass', async () => {
  const db = database(); db.agentArtifact.findFirst.mockResolvedValue({ metadata: { continuityReport: { revision: 3, contentHash, contextHash: 'current-dependencies', complete: true, billingKnown: false } } })
  db.chapterQualityReport.findFirst.mockResolvedValue({ id: 'q', chapterRevision: 3, status: 'repaired', deterministicMetrics: { contentHash, independentCheck: 'complete' } })
  expect(await read(db)).toContain('费用或结果待核')
  expect(await read(db)).toContain('当前正文尚无完整独立报告')
  db.agentArtifact.findFirst.mockResolvedValue({ metadata: { continuityReport: { revision: 3, contentHash, contextHash: 'current-dependencies', complete: false, billingKnown: true } } })
  expect(await read(db)).toContain('报告未完成')
})
it.each(['PLAN_CONTEXT_STALE', 'PLAN_CONTEXT_INVALID', 'CHAPTER_NOT_FOUND'])('keeps advisory %s recoverable without stopping normal chapter work', async code => {
  const db = database(); db.agentArtifact.findFirst.mockResolvedValue({ metadata: { continuityReport: { revision: 3, contentHash, contextHash: 'current-dependencies', complete: true, billingKnown: true } } })
  native.snapshot.mockRejectedValue(new DataAccessError(409, code, '参考版本已变'))
  expect(await read(db)).toContain('依赖需重新核对，未当作通过')
  expect(await read(db)).toContain('当前已有保存正文')
})
it('does not swallow real receipt or ownership corruption as advisory staleness', async () => {
  const db = database(); db.agentArtifact.findFirst.mockResolvedValue({ metadata: { continuityReport: {} } })
  native.snapshot.mockRejectedValue(new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '回执损坏'))
  await expect(read(db)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
})
it('states collaboration responsibilities without creating a save or review permission gate', () => {
  expect(WRITING_COLLABORATION_GUIDANCE).toContain('不构成普通保存的阶段门')
  expect(WRITING_COLLABORATION_GUIDANCE).toContain('首轮遗漏')
  expect(WRITING_COLLABORATION_GUIDANCE).toContain('人类感')
})
