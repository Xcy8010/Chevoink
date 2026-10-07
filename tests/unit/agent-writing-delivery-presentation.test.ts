import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { createHash } from 'node:crypto'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { probeChapterReviewRevision, readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

const mocks = vi.hoisted(() => ({ original: vi.fn(), preference: vi.fn(), lease: vi.fn(), state: vi.fn(), save: vi.fn() }))
vi.mock('../../api/lib/agent/original-request.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/original-request.js')>(), readOriginalTaskRequest: mocks.original,
  originalTaskRunIds: async () => ['run'],
}))
vi.mock('../../api/lib/agent/writing-request-context.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/writing-request-context.js')>(), readWritingPresentation: mocks.preference,
}))
vi.mock('../../api/lib/agent/runtime-lease.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/runtime-lease.js')>(), withManuscriptRunLease: mocks.lease,
}))
vi.mock('../../api/lib/agent/runtime-state.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/runtime-state.js')>(), readExecutionStateInTransaction: mocks.state, saveExecutionStateInTransaction: mocks.save,
}))
import { readCompletedWritingDelivery, readSavedWritingPresentation, savedChapterPresentationProof, savedChapterPresentationSchema } from '../../api/lib/agent/writing-scope.js'
import { advanceDurableWritingDelivery } from '../../api/lib/agent/runtime-writing-delivery.js'

const subject = { userId: 'author', novelId: 'novel', runId: 'run' }
const token = { ...subject, taskRootId: 'root', owner: 'worker', epoch: 1n }
function fixture(prompt = '完成第一章，只输出标题与正文。', titleAndBodyOnly = true) {
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt, mode: 'build' })
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly, repairAuthorized: true }
  mocks.original.mockResolvedValue({ prompt, spec, taskId: spec.id, sourceRunId: 'run', parentRunId: null })
  const chapter = { id: 'chapter', title: '第一章 旧罗盘', content: '沈桐眼前浮起价值数字。他压住笑意，决定抓住这个独享的机会。', revision: 1, orderIndex: 1 }
  const bridge = { id: 'bridge', toChapterId: chapter.id, fromChapterId: null, targetRevision: chapter.revision, committedAt: new Date(1) }
  const sceneTasks = [{ id: 'scene', ordinal: 1, status: 'completed', goal: '辨识罗盘价值', turn: '决定抓住机会' }]
  const terminal = { id: 'compiler', runId: subject.runId, chapterId: chapter.id, status: 'completed', stage: 'commit',
    preparedContext: { terminalContentHash: runtimeJson({ content: chapter.content }).hash }, bridge, sceneTasks,
    validation: { independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: chapter.revision,
      checkRounds: 1, autoRepairRounds: 0, errorCount: 0, warningCount: 0, findings: [] as Array<{ signal: string; severity: string; evidence: string; suggestion: string }>,
      coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null }) } }
  const quality = { id: 'quality', compilationId: terminal.id, runId: subject.runId, chapterId: chapter.id, chapterRevision: chapter.revision,
    status: 'passed', repairRound: 0, deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') },
    findings: [] as Array<{ id: string; signal: string; severity: string; disposition: string; authorFeedback: null }> }
  const db = { $queryRaw: vi.fn(async () => [{ id: 'novel' }]),
    agentRun: { findFirstOrThrow: vi.fn(async () => ({ writingBindings: null })) },
    chapter: { findFirst: vi.fn(async () => chapter) }, storyCompilation: { findFirst: vi.fn(async () => terminal), findMany: vi.fn(async () => [terminal]) },
    chapterQualityReport: { findFirst: vi.fn(async () => quality), findMany: vi.fn(async () => [quality]) },
    agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => ({ id: 'root', novelId: 'novel' })) },
    agentOperation: { count: vi.fn(async () => 0) }, agentProviderAttempt: { count: vi.fn(async () => 0) },
    agentExecutionOutbox: { create: vi.fn(async () => ({})) } }
  mocks.lease.mockImplementation(async (_token, work) => work(db))
  const state = { frame: { revision: 7, snapshotHash: 'a'.repeat(64), state: { phase: 'idle', messages: [{ role: 'user', content: prompt }] } } }
  mocks.state.mockResolvedValue(state)
  mocks.save.mockImplementation(async (_db, _token, input) => { state.frame = { revision: 8, snapshotHash: 'b'.repeat(64), state: input.snapshot }; return state.frame })
  return { db: db as unknown as Prisma.TransactionClient, mocks: db, chapter, terminal, quality, spec, state }
}
beforeEach(() => { vi.clearAllMocks(); mocks.preference.mockResolvedValue(null) })

describe('saved artifact display withdrawal', () => {
  it('short rewrite can serialize an already successful completion without obtaining auto-completion eligibility', async () => {
    const f = fixture('重写第一章，突出捡漏爽文。', false)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    const delivery = await readSavedWritingPresentation(f.db, subject)
    expect(delivery).toMatchObject({ text: '已保存《第一章 旧罗盘》。', presentationKind: 'completed_saved_only', titleAndBodyOnly: false })
    const proof = savedChapterPresentationProof(subject, delivery!)
    expect(proof).toMatchObject({ targetRunId: 'run', sourceRunId: 'author-correction', sourceMessageId: 'message', chapters: [{ id: 'chapter', revision: 1 }] })
    expect(JSON.stringify(proof)).not.toContain(f.chapter.content)
    expect(savedChapterPresentationSchema.safeParse({ ...proof, text: f.chapter.content }).success).toBe(false)
    mocks.preference.mockResolvedValue({ mode: 'full_text', sourceRunId: 'author-opt-in', sourceMessageId: 'message2' })
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
  })
  it('legacy delivery serializes a short saved confirmation while retaining the immutable original contract and chapter', async () => {
    const f = fixture()
    const originalSpec = structuredClone(f.spec)
    expect((await readCompletedWritingDelivery(f.db, subject))?.text).toContain(f.chapter.content)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    const delivery = await readCompletedWritingDelivery(f.db, subject)
    expect(delivery).toMatchObject({ text: '已保存《第一章 旧罗盘》。', titleAndBodyOnly: true, chapters: [{ id: 'chapter', revision: 1 }] })
    expect(delivery?.text).not.toContain(f.chapter.content)
    expect(f.spec).toEqual(originalSpec)
    mocks.preference.mockResolvedValue({ mode: 'full_text', sourceRunId: 'author-opt-in', sourceMessageId: 'message2' })
    expect((await readCompletedWritingDelivery(f.db, subject))?.text).toContain(f.chapter.content)
  })
  it('durable delivery appends one server confirmation with CAS and no provider operation', async () => {
    const f = fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    expect(await advanceDurableWritingDelivery(token as never)).toMatchObject({ revision: 8 })
    expect(mocks.save).toHaveBeenCalledWith(f.mocks, token, expect.objectContaining({ expectedRevision: 7, expectedHash: 'a'.repeat(64),
      snapshot: expect.objectContaining({ messages: expect.arrayContaining([{ role: 'assistant', content: '已保存《第一章 旧罗盘》。' }]) }) }))
    expect(f.mocks.agentExecutionOutbox.create).toHaveBeenCalledOnce()
    expect(await advanceDurableWritingDelivery(token as never)).toBeNull()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(f.chapter.revision).toBe(1)
  })
  it.each(['operation', 'provider', 'phase'] as const)('does not bypass a pending/unknown %s fence', async pending => {
    const f = fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    if (pending === 'operation') f.mocks.agentOperation.count.mockResolvedValue(1)
    if (pending === 'provider') f.mocks.agentProviderAttempt.count.mockResolvedValue(1)
    if (pending === 'phase') f.state.frame.state.phase = 'awaiting_operation'
    expect(await advanceDurableWritingDelivery(token as never)).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each(['完成第一章，只输出标题与正文；另外生成封面。', '完成第一章，只输出标题与正文；并检查章节质量。', '重写第一章。'])('does not expand auto-completion eligibility: %s', async prompt => {
    const f = fixture(prompt, prompt !== '重写第一章。')
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
  })
  it.each(['重写第一章；另外给我一首诗。', '重写第一章；并提供分析报告。'])('does not erase extra requested chat artifacts: %s', async prompt => {
    const f = fixture(prompt, false)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
  })
  it.each(['stale-content', 'invalid-terminal'] as const)('still rejects %s after withdrawal', async invalid => {
    const f = fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    if (invalid === 'stale-content') f.chapter.content = '作者新正文。'
    else f.terminal.status = 'active'
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
  })
  it.each(['missing', 'failed'] as const)('current continuity cannot replace %s independent quality after withdrawal', async quality => {
    const f = fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    if (quality === 'missing') f.mocks.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    else { f.quality.status = 'failed'; f.quality.deterministicMetrics.independentCheck = 'unavailable' }
    expect(await readChapterReviewReadiness(f.db, subject)).toMatchObject({ ready: false, continuity: 'complete', quality: quality === 'missing' ? 'missing' : 'incomplete' })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
  })
  it('closed completed revision channel preserves current factual errors and quality advice in the saved confirmation', async () => {
    const f = fixture(), chapter = structuredClone(f.chapter)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    f.terminal.validation.errorCount = 1
    f.terminal.validation.findings = [{ signal: 'object', severity: 'error', evidence: '罗盘同一状态仍需作者确认', suggestion: '交作者确认' }]
    f.quality.status = 'needs_repair'
    f.quality.findings = [{ id: 'retained', signal: 'object', severity: 'error', disposition: 'pending', authorFeedback: null }]
    expect(await readChapterReviewReadiness(f.db, subject)).toMatchObject({ ready: true, continuity: 'complete', continuityErrorCount: 1, quality: 'complete', qualityErrorCount: 1 })
    expect(await readCompletedWritingDelivery(f.db, subject)).toMatchObject({ text: '已保存《第一章 旧罗盘》。' })
    expect(f.chapter).toEqual(chapter)
    expect(f.terminal.validation.errorCount).toBe(1)
    expect(f.quality.status).toBe('needs_repair')
    expect(f.quality.findings[0].disposition).toBe('pending')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('current factual errors still block saved presentation while original revision authority keeps the correction channel open', async () => {
    const f = fixture('重写第一章，只输出标题与正文。'), chapter = structuredClone(f.chapter)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    f.terminal.validation.errorCount = 1
    f.terminal.validation.findings = [{ signal: 'object', severity: 'error', evidence: '罗盘同一状态仍冲突', suggestion: '合并确认事实修订' }]
    expect(await readChapterReviewReadiness(f.db, subject)).toMatchObject({ ready: true, continuity: 'complete', continuityErrorCount: 1 })
    expect(await probeChapterReviewRevision(f.db, subject, f.chapter)).toEqual({ open: true })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
    expect(f.chapter).toEqual(chapter)
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
