import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { continuityFullReviewKey, reviewReceiptsKnown, REVIEW_REASSESSMENT_RULE } from '../../api/lib/agent/review-baseline.js'
import { readStandalonePriorQualityJudgment } from '../../api/lib/agent/standalone-quality-history.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as leaseRuntime from '../../api/lib/agent/runtime-lease.js'
import * as history from '../../api/lib/agent/standalone-quality-history.js'
import { buildCriticInput } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { prepareQualityWork, qualityWorkContextProjection } from '../../api/lib/agent/tools/durable-quality.js'
import { qualityReviewContextHash, type buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

afterEach(() => vi.restoreAllMocks())
const subject = { userId: 'u', novelId: 'n', runId: 'run' }, chapter = { id: 'c', revision: 5 }

describe('full-review source identity and physical receipts', () => {
  const snapshot = { chapter: { id: 'c' }, original: { taskId: 'task', prompt: '检查并局部修复' },
    sources: [{ chapterId: 'c', revision: 5, orderIndex: 2, source: 'current' as const, content: '本章原文。' },
      { chapterId: 'p', revision: 3, orderIndex: 1, source: 'previous' as const, content: '前章原文。' }] }
  it.each(['body', 'revision', 'source-id', 'order', 'source-order', 'author', 'task', 'plan'] as const)('invalidates a genuine %s dependency change', kind => {
    const next = structuredClone(snapshot)
    if (kind === 'body') next.sources[1].content += '新事实。'
    if (kind === 'revision') next.sources[1].revision++
    if (kind === 'source-id') next.sources[1].chapterId = 'other'
    if (kind === 'order') next.sources[1].orderIndex++
    if (kind === 'source-order') next.sources.reverse()
    if (kind === 'author') next.original.prompt += '新要求。'
    if (kind === 'task') next.original.taskId = 'other-task'
    expect(continuityFullReviewKey(next, kind === 'plan' ? 'new-plan' : null)).not.toBe(continuityFullReviewKey(snapshot, null))
  })
  it('requires every actual own receipt and refuses an empty report even when task-wide billing is known', () => {
    const billing = { known: true, usageIds: ['legacy'], nativeReceiptIds: ['native'] }
    expect(reviewReceiptsKnown({ billingKnown: true, usageIds: [] }, billing)).toBe(false)
    expect(reviewReceiptsKnown({ billingKnown: true, usageIds: ['legacy'], nativeReceiptIds: ['missing'] }, billing)).toBe(false)
    expect(reviewReceiptsKnown({ billingKnown: true, usageIds: ['legacy'], nativeReceiptIds: ['native'] }, billing)).toBe(true)
    expect(reviewReceiptsKnown({ billingKnown: false, usageIds: ['legacy'] }, billing)).toBe(false)
    expect(reviewReceiptsKnown({ billingKnown: true, usageIds: ['legacy'] }, { ...billing, known: false })).toBe(false)
  })
  it('does not suppress genuine missed issues or upgrade subjective retained advice', () => {
    expect(REVIEW_REASSESSMENT_RULE).toContain('不能为维持前次结论忽略新发现或真实漏报')
    expect(REVIEW_REASSESSMENT_RULE).toContain('不能把保留的主观建议升级为事实错误')
    expect(REVIEW_REASSESSMENT_RULE).toContain('不能仅因旧报告未报就认定新发现是回归')
  })
})

describe('standalone quality history is fresh-input-only and task-owned', () => {
  function fixture() {
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'original-task', sourceRunId: 'source', prompt: '作者请求', spec: null, parentRunId: null })
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['source', 'run'])
    const findFirst = vi.fn().mockResolvedValue({ id: 'old', chapterRevision: 5, status: 'stale', deterministicMetrics: {
      independentCheck: 'complete', sourceRevision: 4, contentHash: 'old-body-hash' }, findings: [{ id: 'f', severity: 'advisory', disposition: 'repaired', explanation: '旧主观建议' }] })
    return { db: { chapterQualityReport: { findFirst } } as unknown as Prisma.TransactionClient, findFirst }
  }
  it('reads complete older source assessments only from authenticated author/task/chapter lineage', async () => {
    const f = fixture(), result = await readStandalonePriorQualityJudgment(f.db, subject, chapter)
    expect(result).toMatchObject({ taskId: 'original-task', reportId: 'old', reportRevision: 5, sourceRevision: 4,
      sourceContent: null, sourceContentStatus: 'not_recorded', findings: [{ severity: 'advisory', disposition: 'repaired' }] })
    expect(f.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u', novelId: 'n', chapterId: 'c',
      chapter: { authorId: 'u' }, compilationId: null, runId: { in: ['source', 'run'] },
      deterministicMetrics: { path: ['independentCheck'], equals: 'complete' },
      OR: [{ chapterRevision: { lt: 5 } }, { chapterRevision: 5, AND: [{ deterministicMetrics: { path: ['sourceRevision'], lt: 5 } }] }] }) }))
    expect(original.originalTaskRunIds).toHaveBeenCalledWith(f.db, subject, expect.objectContaining({ taskId: 'original-task' }))
  })
  it.each(['current', 'unavailable', 'absent'] as const)('does not promote %s history to a baseline', async kind => {
    const f = fixture()
    f.findFirst.mockResolvedValue(kind === 'absent' ? null : { id: 'not-old-complete', chapterRevision: 5, status: 'stale',
      deterministicMetrics: { independentCheck: kind === 'unavailable' ? 'unavailable' : 'complete', sourceRevision: kind === 'current' ? 5 : 4 }, findings: [] })
    expect(await readStandalonePriorQualityJudgment(f.db, subject, chapter)).toBeNull()
  })
  it('enriches fresh input while preserving the exact v14 context projection and already-saved input', async () => {
    const f = fixture(), judgment = await readStandalonePriorQualityJudgment(f.db, subject, chapter)
    const bundle = { chapter: { ...chapter, title: '合成章', content: '当前正文。', novel: { tagNames: [] } }, compilation: null,
      charter: null, profiles: [], anchors: [], feedback: [], recentChapters: [], originalRequest: '只局部修订', chapterWritingBackground: [] } as unknown as Awaited<ReturnType<typeof buildHumanityQualityContext>>
    const savedInput = buildCriticInput(bundle, {}), frozen = { version: 14, criticInput: savedInput }, frozenHash = runtimeJson(frozen).hash
    const projection = runtimeJson(qualityWorkContextProjection(bundle, 14)).hash, context = qualityReviewContextHash(bundle)
    const fresh = buildCriticInput(bundle, {}, undefined, undefined, judgment)
    expect(fresh).toContain('旧主观建议'); expect(fresh).toContain('未保存的旧版全文保持未知')
    expect(savedInput).not.toContain('旧主观建议')
    expect(runtimeJson(frozen).hash).toBe(frozenHash)
    expect(runtimeJson(qualityWorkContextProjection(bundle, 14)).hash).toBe(projection)
    expect(qualityReviewContextHash(bundle)).toBe(context)
  })
  it('returns original prepared v14 work without reading fresh history or rewriting its input', async () => {
    const work = { kind: 'check', version: 14, compiler: null, chapter: { ...chapter, title: '合成章', content: '已冻结原文。' },
      contextHash: 'a'.repeat(64), recentContents: [], feedback: [], mode: 'premium', repair: false,
      criticInput: '原v14冻结输入', criticSystem: '原规则', repairSystem: '原局改规则', cached: null, route: null, price: null }
    const inputSnapshot = { input: { work } }, inputHash = runtimeJson(inputSnapshot).hash
    const db = { agentOperation: { findUnique: vi.fn().mockResolvedValue({ inputSnapshot, inputHash }) } } as unknown as Prisma.TransactionClient
    vi.spyOn(leaseRuntime, 'withRunLease').mockImplementation(async (_token, read) => read(db))
    const readHistory = vi.spyOn(history, 'readStandalonePriorQualityJudgment')
    const ctx = { ...subject } as ToolContext
    const lease = { ...subject, taskRootId: 'task', ownerId: 'owner', claimId: 'claim', epoch: 1n }
    expect(await prepareQualityWork(ctx, lease, { operationKey: 'original', observedRevision: 1, baseline: null, args: {} })).toEqual(work)
    expect(runtimeJson(inputSnapshot).hash).toBe(inputHash)
    expect(readHistory).not.toHaveBeenCalled()
  })
})
