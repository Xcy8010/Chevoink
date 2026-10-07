import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertChapterReviewRevision, originalChapterReviewRequirements, readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { qualityReportCheckedCurrentContent, qualityReportMatchesContent } from '../../api/lib/agent/quality-report-contract.js'
import { commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import * as memory from '../../api/lib/agent/story-memory.js'

afterEach(() => vi.restoreAllMocks())
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(prompt = '写下一章') {
  const subject = { userId: 'u', novelId: 'n', runId: 'resumed' }
  const chapter = { id: 'c44', title: '门后的脚印', revision: 3, orderIndex: 44, content: '门已经锁好。他绕到墙根，在泥地里找到了一串脚印。' }
  const bridge = { id: 'bridge', toChapterId: chapter.id, targetRevision: 3, fromChapterId: null, sourceRevision: null, committedAt: null,
    location: '墙根', recentOpenings: [], recentEndings: [] }
  const sceneTasks = [{ ordinal: 1, goal: '寻找线索', turn: '发现脚印', status: 'checked' }]
  const compilation = { id: 'compiler', runId: 'original', chapterId: chapter.id, status: 'active', stage: 'check', bridge, sceneTasks, chapter,
    preparedContext: {}, validation: { independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: chapter.revision,
      checkRounds: 1, autoRepairRounds: 0, findings: [], errorCount: 0, warningCount: 0,
      coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null }) } }
  const task = buildTaskSpec({ runId: 'original', novelId: 'n', prompt })
  task.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: null, orderIndex: 44 }], titleAndBodyOnly: false, repairAuthorized: false }
  vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt, spec: task, taskId: task.id, sourceRunId: 'original', parentRunId: null })
  vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original', 'resumed'])
  vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
  const report = { id: 'q3', chapterId: chapter.id, compilationId: compilation.id, chapterRevision: 3, status: 'passed', repairRound: 0,
    deterministicMetrics: { independentCheck: 'complete', contentHash: sha(chapter.content) }, findings: [] }
  const db = { $queryRaw: vi.fn().mockResolvedValue([]),
    agentRun: { findFirstOrThrow: vi.fn().mockResolvedValue({ writingBindings: { version: 1, taskId: task.id, targets: [{ orderIndex: 44, chapterId: chapter.id }] } }),
      findFirst: vi.fn().mockResolvedValue({ mode: 'act', taskRootId: null, session: { userId: 'u', novelId: 'n', sandboxMode: 'workspace', toolPolicy: null } }) },
    chapter: { findFirst: vi.fn().mockResolvedValue(chapter), update: vi.fn() },
    storyCompilation: { findFirst: vi.fn().mockResolvedValue(compilation), findMany: vi.fn().mockResolvedValue([compilation]),
      update: vi.fn(async ({ data }) => Object.assign(compilation, data)) },
    chapterQualityReport: { findFirst: vi.fn().mockResolvedValue(report), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    chapterBridge: { update: vi.fn(async ({ data }) => Object.assign(bridge, data)) },
    sceneTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  const tx = db as unknown as Prisma.TransactionClient
  const terminal = { userId: 'u', novelId: 'n', compilationId: compilation.id, chapterSummary: '寻找门外线索',
    exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
    lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '锁门', endingStructure: '脚印' }
  const refreshContinuity = () => { Object.assign(compilation.validation, { checkedRevision: chapter.revision,
    coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null }) }) }
  return { subject, chapter, bridge, sceneTasks, compilation, task, report, db, tx, terminal, refreshContinuity }
}

describe('persisted current review readiness', () => {
  it('reads server-owned original lineage without reserving or consuming any budget', async () => {
    const f = fixture()
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ ready: true, checksRequired: true,
      continuity: 'complete', quality: 'complete', requiredTools: [] })
    expect(f.db.storyCompilation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      userId: 'u', novelId: 'n', id: 'compiler', runId: { in: ['original', 'resumed'] } }) }))
    expect(f.db.$queryRaw).not.toHaveBeenCalled()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.db.chapterQualityReport.update).not.toHaveBeenCalled()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
  })
  it.each(['missing', 'failed', 'analyzing', 'repaired', 'wrong-hash', 'old-revision'] as const)('blocks delivery with %s quality, even when the revision channel is closed', async scenario => {
    const f = fixture()
    if (scenario === 'missing') f.db.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    if (scenario === 'failed') f.report.status = 'failed'
    if (scenario === 'analyzing') f.report.status = 'analyzing'
    if (scenario === 'repaired') { f.report.status = 'repaired'; Object.assign(f.report.deterministicMetrics, { repairedContentHash: sha(f.chapter.content) }) }
    if (scenario === 'wrong-hash') f.report.deterministicMetrics.contentHash = sha('其他章节完整正文')
    if (scenario === 'old-revision') f.report.chapterRevision--
    Object.assign(f.compilation.validation, { newDraftRevision: { version: 1, taskId: f.task.id, chapterId: f.chapter.id,
      compilationId: f.compilation.id, checkedRevision: 2 } })
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: false,
      requiredTools: [{ name: 'quality_analyze', args: { compilationId: 'compiler' } }] })
    if (scenario === 'analyzing' || scenario === 'failed') await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ quality: 'incomplete' })
    const proposal = vi.spyOn(memory, 'saveStoryMemory')
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.db.chapterBridge.update).not.toHaveBeenCalled()
    expect(f.db.sceneTask.updateMany).not.toHaveBeenCalled()
    expect(proposal).not.toHaveBeenCalled()
  })
  it.each(['missing', 'failed', 'body', 'title', 'scenes', 'malformed-findings', 'count-mismatch'] as const)('requires a complete current continuity check after %s', async scenario => {
    const f = fixture()
    if (scenario === 'missing') f.compilation.validation = null as never
    if (scenario === 'failed') f.compilation.validation.independentCheck = 'unavailable'
    if (scenario === 'body') f.chapter.content += '他停住了。'
    if (scenario === 'title') { f.chapter.title = '新章名'; f.chapter.revision++ }
    if (scenario === 'scenes') f.sceneTasks[0].goal = '救出同伴'
    if (scenario === 'malformed-findings') f.compilation.validation.findings = [{ severity: 'error' }] as never
    if (scenario === 'count-mismatch') f.compilation.validation.errorCount = 1
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: false,
      requiredTools: expect.arrayContaining([{ name: 'continuity_validate', args: { compilationId: 'compiler' } }]) })
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('a latest failed assessment cannot revive an earlier passing report by filtering on revision', async () => {
    const f = fixture()
    f.report.status = 'failed'; f.report.chapterRevision--
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: false, quality: 'incomplete' })
    const query = f.db.chapterQualityReport.findFirst.mock.calls[0][0]
    expect(query.where).not.toHaveProperty('chapterRevision')
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })
  it('denied stale repair then missing quality cannot commit, and a recheck consumes no correction', async () => {
    const f = fixture()
    Object.assign(f.compilation.validation, { errorCount: 1, findings: [{ signal: 'object', severity: 'error', evidence: '同一门锁状态冲突', suggestion: '保留锁门事实' }] })
    f.chapter.title = '第四十四章 门后'; f.chapter.revision++
    f.db.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    Object.assign(f.compilation.validation, { errorCount: 0, findings: [] }); f.refreshContinuity()
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
  })
  it('requires a fresh critic after body repair, keeping patch receipts separate from assessment evidence', async () => {
    const f = fixture(), before = f.chapter.content
    f.chapter.content += '他顺着墙根往前走。'; f.chapter.revision++
    Object.assign(f.report, { chapterRevision: f.chapter.revision, status: 'repaired', repairRound: 1 })
    Object.assign(f.report.deterministicMetrics, { repairedContentHash: sha(f.chapter.content), sourceRevision: 3 })
    expect(qualityReportMatchesContent(f.report, f.chapter.revision, f.chapter.content)).toBe(true)
    expect(qualityReportCheckedCurrentContent(f.report, f.chapter.revision, f.chapter.content)).toBe(false)
    expect(f.report.deterministicMetrics.contentHash).toBe(sha(before))
    f.refreshContinuity()
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    const checkedReport = { ...f.report, id: 'q4', status: 'passed', repairRound: 0,
      deterministicMetrics: { independentCheck: 'complete', contentHash: sha(f.chapter.content) } }
    f.db.chapterQualityReport.findFirst.mockResolvedValue(checkedReport)
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: true, qualityReportId: 'q4' })
  })
  it('preserves checked input across COMMIT and invalidates the terminal proof on later story-state changes', async () => {
    const f = fixture(), originalCoverage = structuredClone(f.compilation.validation.coverage)
    vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'candidate' } as never)
    await expect(commitChapterBridge(f.terminal, f.tx)).resolves.toMatchObject({ chapterRevision: 3 })
    expect(f.compilation.validation.coverage).toEqual(originalCoverage)
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: true, continuity: 'complete' })
    const beforeWrites = f.db.storyCompilation.update.mock.calls.length
    await expect(commitChapterBridge(f.terminal, f.tx)).resolves.toMatchObject({ chapterRevision: 3 })
    expect(f.db.storyCompilation.update).toHaveBeenCalledTimes(beforeWrites)
    f.bridge.location = '城门'
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: false, continuity: 'stale' })
  })
  it('terminal evidence uses scene ordinals even when the database returns commit scenes in another order', async () => {
    const f = fixture()
    f.sceneTasks.push({ ordinal: 2, goal: '跟踪脚印', turn: '抵达街口', status: 'checked' })
    f.refreshContinuity(); f.sceneTasks.reverse()
    vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'candidate' } as never)
    await expect(commitChapterBridge(f.terminal, f.tx)).resolves.toMatchObject({ chapterRevision: 3 })
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: true, continuity: 'complete' })
  })
  it('retains current checked errors after the merged correction is consumed without promoting them to passed', async () => {
    const f = fixture()
    Object.assign(f.compilation.validation, { errorCount: 1, findings: [{ signal: 'object', severity: 'error', evidence: '同一物件状态仍冲突', suggestion: '交作者确认' }],
      newDraftRevision: { version: 1, taskId: f.task.id, chapterId: f.chapter.id, compilationId: f.compilation.id, checkedRevision: 2 } })
    vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'candidate' } as never)
    await expect(commitChapterBridge(f.terminal, f.tx)).resolves.toMatchObject({ chapterRevision: 3, retainedIssueCount: 1 })
    expect(f.compilation.validation).toMatchObject({ independentCheck: 'complete', errorCount: 1, checkRounds: 1,
      newDraftRevision: { checkedRevision: 2 } })
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: true, continuityErrorCount: 1, quality: 'complete' })
  })
  it.each(['balanced', 'premium'] as const)('mode %s cannot be waived by compiler/model arguments', async mode => {
    const f = fixture(); f.task.qualityMode = mode
    f.db.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    await expect(commitChapterBridge({ ...f.terminal, requireQuality: false }, f.tx)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
  })
  it.each(['检查当前章节', '写下一章，不用检查', '写下一章，跳过质量检查和连续性检查'])('preserves original non-writing or explicit skip: %s', async prompt => {
    const f = fixture(prompt)
    f.compilation.validation = null as never; f.db.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: true, checksRequired: false, requiredTools: [] })
    vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'candidate' } as never)
    await expect(commitChapterBridge(f.terminal, f.tx)).resolves.toMatchObject({ chapterRevision: 3 })
  })
  it('a quality-only original waiver retains the continuity obligation', () => {
    expect(originalChapterReviewRequirements({ prompt: '写下一章，不用质量检查', spec: { intent: 'write', qualityMode: 'premium' } }))
      .toEqual({ continuity: true, quality: false })
  })
  it.each(['写下一章，不要跳过质量检查', '写下一章，不得跳过连续性检查', 'Write next chapter. Do not skip any checks'])('mandatory checks cannot be inverted into a waiver: %s', async prompt => {
    const f = fixture(prompt)
    f.db.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    expect(originalChapterReviewRequirements({ prompt, spec: { intent: 'write', qualityMode: 'premium' } })).toEqual({ continuity: true, quality: true })
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    expect(f.db.chapterBridge.update).not.toHaveBeenCalled()
  })
  it.each(['写下一章，不要检查标题', '写下一章，不用检查错别字', '不要检查第1章，写下一章', '写下一章，不用检查标题质量'])('a local check waiver does not waive chapter delivery: %s', prompt => {
    expect(originalChapterReviewRequirements({ prompt, spec: { intent: 'write', qualityMode: 'premium' } }))
      .toEqual({ continuity: true, quality: true })
  })
})
