import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as original from '../../api/lib/agent/original-request.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import { assertChapterManuscriptRevision, assertChapterReviewRevision, isChapterRevisionChannelOpen, probeChapterReviewRevision, continuityDecisionBinding } from '../../api/lib/agent/chapter-review-guard.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readNewDraftRevision, readNewDraftWritingAuthority, prohibitsNewDraftRevision } from '../../api/lib/agent/writing-scope.js'

afterEach(() => vi.restoreAllMocks())
describe('review driven manuscript mutation admission', () => {
  function fixture(prompt: string, validation: Record<string, unknown> | null, reports: Array<{ chapterRevision: number }> = []) {
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt, spec: null, taskId: 'task', sourceRunId: 'original-run', parentRunId: null })
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original-run', 'resumed-run'])
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), chapter: { findFirst: vi.fn().mockResolvedValue(null) },
      storyCompilation: { findMany: vi.fn().mockResolvedValue(validation ? [{ validation }] : []) },
      chapterQualityReport: { findMany: vi.fn().mockResolvedValue(reports) } } as unknown as Prisma.TransactionClient
    return { db, subject: { userId: 'u', novelId: 'n', runId: 'resumed-run' }, chapter: { id: 'c', revision: 4 } }
  }
  it.each([null, {}])('allows a first draft without an assessment: %s', async validation => {
    const f = fixture('写下一章', validation)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
  })
  it.each([
    { checkedRevision: 4, checkRounds: 1, independentCheck: 'complete', errorCount: 0, warningCount: 6 },
    { checkedRevision: 3, checkRounds: 2, independentCheck: 'complete', errorCount: 1 },
    { checkRounds: 1, independentCheck: 'unavailable' },
  ])('a warning, stale error or failed attempt adds no repair authority: %j', async validation => {
    const f = fixture('写下一章', validation)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
  })
  it.each(['写下一章', '检查并修复当前章'])('historical count does not revoke authority but stale evidence still blocks mutation: %s', async prompt => {
    const f = fixture(prompt, { checkRounds: 3, checkedRevision: 3, errorCount: 1 })
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: prompt === '写下一章' ? 'REPAIR_NOT_AUTHORIZED' : 'REVIEW_REPAIR_RECHECK_REQUIRED' })
  })
  it.each(['continuity', 'quality'])('allows one explicitly authorized atomic revision, then blocks reuse of old %s evidence', async kind => {
    const f = fixture('检查并修复当前章', kind === 'continuity' ? { checkRounds: 1, checkedRevision: 4 } : null,
      kind === 'quality' ? [{ chapterRevision: 4 }] : [])
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
    f.chapter.revision++
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
    expect(f.db.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'resumed-run'] }, chapterId: 'c', userId: 'u', novelId: 'n' }) }))
    expect(f.db.chapterQualityReport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'resumed-run'] } }) }))
  })
  it.each(['parent', 'child'])('inherits continuity evidence across the original %s lineage without collecting unrelated work', async direction => {
    const f = fixture('写下一章', null)
    f.subject.runId = direction === 'parent' ? 'original-run' : 'child-run'
    vi.mocked(original.originalTaskRunIds).mockResolvedValue(['original-run', 'child-run'])
    vi.mocked(f.db.storyCompilation.findMany).mockImplementation((async (args: Prisma.StoryCompilationFindManyArgs) => {
      const ids = (args?.where?.runId as { in: string[] }).in
      const evidenceRun = direction === 'parent' ? 'child-run' : 'original-run'
      return ids.includes(evidenceRun) ? [{ validation: { checkedRevision: 4, checkRounds: 1, warningCount: 6 } }] as never : []
    }) as never)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      runId: { in: ['original-run', 'child-run'] }, userId: 'u', novelId: 'n', chapterId: 'c',
    }) }))
  })
  it('repreparing cannot hide the old checked revision that already drove one patch', async () => {
    const f = fixture('检查并修复当前章', null)
    f.chapter.revision = 5
    vi.mocked(f.db.storyCompilation.findMany).mockImplementation((async (args: Prisma.StoryCompilationFindManyArgs) => [
      ...(!args?.where?.status ? [{ validation: { checkedRevision: 4, checkRounds: 1 } }] : []),
      { validation: { checkRounds: 1 } },
    ]) as never)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
  })
})

describe('one atomic factual correction in the original new draft', () => {
  function fixture(prompt = '写下一章') {
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    const spec = buildTaskSpec({ runId: 'original-run', novelId: 'n', prompt })
    spec.intent = 'write'
    spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 41, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    const request = { prompt, spec, taskId: spec.id, sourceRunId: 'original-run', parentRunId: null }
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue(request)
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original-run', 'child-run'])
    const chapter = { id: 'new41', title: '合成新章', revision: 3, orderIndex: 41, content: '门先锁着，随后却说从未锁门。' }
    const binding = { version: 1, taskId: spec.id, targets: [{ orderIndex: 41, chapterId: chapter.id }] }
    const bridge = { toChapterId: chapter.id, targetRevision: chapter.revision, fromChapterId: null, sourceRevision: null, committedAt: null }
    const scenes = [{ ordinal: 1, goal: '开门', turn: '发现门锁' }]
    const validation = { checkRounds: 1, autoRepairRounds: 0, checkedChapterId: chapter.id, checkedRevision: chapter.revision,
      independentCheck: 'complete', errorCount: 1, warningCount: 0, findings: [{ signal: 'object', severity: 'error', evidence: '同一扇门锁着却从未锁门', suggestion: '保留门锁事实' }],
      coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks: scenes, source: null }) }
    const compilation = { id: 'compiler', status: 'active', stage: 'check', validation, bridge, sceneTasks: scenes }
    const rows = [compilation]
    const source = { writingBindings: binding }
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), agentRun: { findFirstOrThrow: vi.fn().mockResolvedValue(source),
      findFirst: vi.fn().mockResolvedValue({ mode: 'act', taskRootId: null, session: { userId: 'u', novelId: 'n', sandboxMode: 'workspace', toolPolicy: null } }) },
      chapter: { findFirst: vi.fn().mockResolvedValue(chapter) }, chapterQualityReport: { findMany: vi.fn().mockResolvedValue([]) },
      storyCompilation: { findMany: vi.fn().mockImplementation(async () => rows), update: vi.fn().mockImplementation(async ({ data }) => { compilation.validation = data.validation; return compilation }) },
    }
    const tx = db as unknown as Prisma.TransactionClient
    const subject = { userId: 'u', novelId: 'n', runId: 'child-run' }
    return { tx, db, subject, chapter, request, spec, binding, source, validation, compilation, rows }
  }
  function completeQuality(f: ReturnType<typeof fixture>, candidates = 0) {
    const report = { id: 'q', compilationId: f.compilation.id, chapterRevision: f.chapter.revision, repairRound: 0, status: 'passed',
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(f.chapter.content).digest('hex') },
      findings: Array.from({ length: candidates }, (_, index) => ({ severity: 'warning', startOffset: index * 4, endOffset: index * 4 + 2,
        disposition: 'pending', authorFeedback: null })) }
    f.db.chapterQualityReport.findMany.mockResolvedValue([report] as never)
    return report
  }
  it('separates repeated original manuscript authority from the bounded automatic decision and paid counters', async () => {
    const f = fixture(), report = completeQuality(f, 2)
    f.validation.checkRounds = 3
    report.repairRound = 1
    const before = structuredClone(report)
    const consume = await assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after: '第一处改动，其他意见未处理。' })
    await consume?.()
    const receipt = readNewDraftRevision(f.compilation.validation)
    for (const mutation of ['range', 'replace', 'append'] as const) {
      await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation, after: '后续合法修改。' })).resolves.toBeUndefined()
    }
    expect(f.compilation.validation).toMatchObject({ checkRounds: 3, autoRepairRounds: 0, newDraftRevision: receipt })
    expect(report).toEqual(before)
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toMatchObject({ open: false, code: 'REVIEW_AUTOMATION_STOPPED' })
  })
  it.each(['malformed', 'foreign-task', 'foreign-chapter'] as const)('ordinary writes fail closed for %s historical receipt', async scenario => {
    const f = fixture()
    Object.assign(f.compilation.validation, { newDraftRevision: scenario === 'malformed' ? { version: 1 } : {
      version: 1, taskId: scenario === 'foreign-task' ? 'another-task' : f.spec.id,
      chapterId: scenario === 'foreign-chapter' ? 'another-chapter' : f.chapter.id, compilationId: 'old-compiler', checkedRevision: 2,
    } })
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: f.chapter.content }))
      .rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('an ordinary no-op neither mints a correction nor pretends to process current candidates', async () => {
    const f = fixture()
    completeQuality(f, 2)
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: f.chapter.content })).resolves.toBeUndefined()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
  })
  it('explicit original existing-chapter repair permits repeated manuscript edits after paid repair without reopening it', async () => {
    const f = fixture('检查并修复当前章'), report = completeQuality(f)
    f.spec.scope.writing!.targets[0].chapterId = f.chapter.id
    report.repairRound = 1
    f.validation.checkRounds = 3
    const before = structuredClone(f.compilation.validation)
    for (const after of ['第一处改动。', '第二处改动。']) {
      await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after })).resolves.toBeUndefined()
    }
    expect(f.compilation.validation).toEqual(before)
    expect(report.repairRound).toBe(1)
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toMatchObject({ open: false, code: 'REVIEW_AUTOMATION_STOPPED' })
  })
  it.each(['no-change-request', 'hard-constraint', 'missing-canonical-binding'] as const)('ordinary manuscript admission preserves %s denial', async scenario => {
    const f = fixture(scenario === 'no-change-request' ? '写下一章，不要修改本章正文' : '写下一章')
    if (scenario === 'hard-constraint') f.spec.hardConstraints.push({ id: 'preserve', kind: 'author_directive', text: '不要修改本章正文' })
    if (scenario === 'missing-canonical-binding') f.source.writingBindings = null as never
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '不应写入。' }))
      .rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['forged-id', 'old-report', 'duplicate', 'blank-reason'] as const)('ordinary write validates supplied retained bindings: %s', async scenario => {
    const f = fixture(), quality = completeQuality(f, 1)
    Object.assign(quality.findings[0], { id: 'finding-id' })
    const retained = { source: 'quality' as const, reportId: scenario === 'old-report' ? 'old-report' : quality.id,
      findingId: scenario === 'forged-id' ? '0' : 'finding-id', reason: scenario === 'blank-reason' ? ' ' : '保留作者声口。' }
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after: '只改事实。',
      retainedFindings: scenario === 'duplicate' ? [retained, retained] : [retained] })).rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['read_only', 'deny', 'review'] as const)('closes automatic delivery reachability for authenticated %s execution restrictions', async restriction => {
    const f = fixture()
    completeQuality(f)
    f.db.agentRun.findFirst.mockResolvedValue({ mode: restriction === 'review' ? 'review' : 'act', taskRootId: null,
      session: { userId: 'u', novelId: 'n', sandboxMode: restriction === 'read_only' ? 'read_only' : 'workspace',
        toolPolicy: restriction === 'deny' ? { contentWrite: 'deny' } : null } } as never)
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toMatchObject({ open: false, code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['range', 'append'] as const)('denies %s before consumption for two current findings while the shape-free probe stays open', async mutation => {
    const f = fixture()
    f.validation.findings.push({ ...f.validation.findings[0], evidence: '第二个合成互斥事实' })
    f.validation.errorCount = 2
    completeQuality(f)
    const before = structuredClone(f.compilation)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation })).rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    expect(f.compilation).toEqual(before)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace' })
    await consume?.()
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace' })).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
  })
  it('counts safe quality candidates alongside continuity errors, including warnings', async () => {
    const f = fixture()
    completeQuality(f, 1)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range' })).rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  function mixedFixture() {
    const f = fixture()
    f.chapter.content = '甲句。中句。乙句。'
    f.validation.findings = [
      { signal: 'object', severity: 'error', evidence: '当前原文「甲句」与确认事实互斥', suggestion: '校正第一处' },
      { signal: 'object', severity: 'error', evidence: '当前原文「乙句」与确认事实互斥', suggestion: '校正第二处' },
    ]
    f.validation.errorCount = 2
    f.validation.coverage = compilerContinuityCoverage({ chapter: f.chapter, bridge: f.compilation.bridge, sceneTasks: f.compilation.sceneTasks, source: null })
    const report = completeQuality(f, 1)
    Object.assign(report.findings[0], { id: 'finding-middle', evidenceExcerpt: '中句。', startOffset: 3, endOffset: 6 })
    return { ...f, report }
  }
  it('admits one atomic batch while an incidental full rewrite cannot count untouched middle evidence', async () => {
    const f = mixedFixture()
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '丙句。中句。丁句。' }))
      .rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    const retainedFindings = [{ source: 'quality' as const, reportId: 'q', findingId: 'finding-middle', reason: '保留人物刻意重复的声口，不能安全删去。' }]
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range', mergedBatch: true,
      after: '丙句。中句。丁句。', editRanges: [{ start: 0, end: 2, newText: '丙句' }, { start: 6, end: 8, newText: '丁句' }], retainedFindings })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0, newDraftRevision: { retainedFindings } })
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toMatchObject({ open: false, code: 'REVIEW_AUTOMATION_STOPPED' })
  })
  it.each(['old-report', 'unknown-id', 'blank-reason', 'duplicate'] as const)('rejects invalid current-candidate retention: %s', async scenario => {
    const f = mixedFixture()
    const item = { source: 'quality' as const, reportId: 'q', findingId: 'finding-middle', reason: '保留当前声口' }
    if (scenario === 'old-report') item.reportId = 'old-q'
    if (scenario === 'unknown-id') item.findingId = 'foreign'
    if (scenario === 'blank-reason') item.reason = ' '
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '丙句。中句。丁句。',
      retainedFindings: scenario === 'duplicate' ? [item, item] : [item] })).rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('persists retain-only decisions without consuming CAS allowance and invalidates them on changed report evidence', async () => {
    const f = mixedFixture()
    const reportId = continuityDecisionBinding(f.compilation.id, f.chapter.revision, f.validation)
    const retainedFindings = [
      ...['0', '1'].map(findingId => ({ source: 'continuity' as const, reportId, findingId, reason: '不能安全改动正文，保留真实错误交作者核对。' })),
      { source: 'quality' as const, reportId: 'q', findingId: 'finding-middle', reason: '人物刻意声口，当前建议不能安全应用。' },
    ]
    await assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: f.chapter.content, retainedFindings })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0, errorCount: 2 })
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(false)
    const writes = f.db.storyCompilation.update.mock.calls.length
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '甲新句。中新句。乙新句。' }))
      .rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range', mergedBatch: true,
      after: '甲新句。中新句。乙新句。' })).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.update).toHaveBeenCalledTimes(writes)
    Object.assign(f.report.findings[0], { suggestion: '当前新建议' })
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
  })
  it('allows one range candidate, but an append cannot spend even that correction', async () => {
    const f = fixture()
    completeQuality(f)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'append' })).rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range' })).resolves.toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['missing-quality', 'failed-quality', 'analyzing-quality', 'stale-quality', 'hash-quality', 'foreign-compilation',
    'repaired-quality', 'incomplete-quality', 'malformed-continuity', 'coverage', 'count', 'source'] as const)(
    'actual mutation requires complete current persisted checks: %s', async scenario => {
      const f = fixture(), report = completeQuality(f)
      if (scenario === 'missing-quality') f.db.chapterQualityReport.findMany.mockResolvedValue([])
      if (scenario === 'failed-quality') report.status = 'failed'
      if (scenario === 'analyzing-quality') report.status = 'analyzing'
      if (scenario === 'stale-quality') report.chapterRevision--
      if (scenario === 'hash-quality') report.deterministicMetrics.contentHash = '0'.repeat(64)
      if (scenario === 'foreign-compilation') report.compilationId = 'other'
      if (scenario === 'repaired-quality') report.status = 'repaired'
      if (scenario === 'incomplete-quality') report.deterministicMetrics.independentCheck = 'unavailable'
      if (scenario === 'malformed-continuity') f.validation.findings = [{ severity: 'error' }] as never
      if (scenario === 'coverage') f.validation.coverage.reviewHash = '0'.repeat(64)
      if (scenario === 'count') f.validation.warningCount = 1
      if (scenario === 'source') Object.assign(f.compilation.bridge, { fromChapterId: 'source', sourceRevision: 1 })
      await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace' })).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
      expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    })
  it('pending candidates prove only prepayment reachability, never actual write admission', async () => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    const pendingQuality = { compilationId: f.compilation.id, candidates: 2 }
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', requireQualityChannel: true, pendingQuality }))
      .rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['unreviewed', 'failed', 'coverage', 'foreign-compilation'] as const)('pending quality prepayment blocks %s continuity before any report exists', async scenario => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    if (scenario === 'unreviewed') f.compilation.validation = null as never
    if (scenario === 'failed') f.validation.independentCheck = 'unavailable'
    if (scenario === 'coverage') f.validation.coverage.reviewHash = '0'.repeat(64)
    const pendingQuality = { compilationId: scenario === 'foreign-compilation' ? 'other' : f.compilation.id, candidates: 1 }
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, requireCurrentContinuity: true, pendingQuality }))
      .resolves.toMatchObject({ open: false, code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.db.chapterQualityReport.findMany).toHaveReturned()
  })
  it.each(['current', 'waived', 'explicit-repair'] as const)('pending quality prepayment preserves %s admission without consuming anything', async scenario => {
    const f = fixture(scenario === 'waived' ? '写下一章，不用连续性检查' : scenario === 'explicit-repair' ? '检查并修复当前章' : '写下一章')
    f.validation.errorCount = 0; f.validation.findings = []
    if (scenario !== 'current') f.compilation.validation = null as never
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, requireCurrentContinuity: true,
      pendingQuality: { compilationId: f.compilation.id, candidates: 1 } })).resolves.toEqual({ open: true })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('honors a quality-only original waiver without inventing a report requirement', async () => {
    const f = fixture('写下一章，不用质量检查')
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace' })).resolves.toBeTypeOf('function')
  })
  it('leaves explicit existing repair authority independent of new-draft prechecks and mutation shape', async () => {
    const f = fixture('检查并修复当前章')
    f.spec.scope.writing!.targets[0].chapterId = f.chapter.id
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'append' })).resolves.toBeUndefined()
  })
  it('admits one merged correction without changing original authority or counters, consumes after CAS and blocks a fresh recheck', async () => {
    const f = fixture(), frozenSpec = structuredClone(f.spec)
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    expect(consume).toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0, newDraftRevision: { taskId: f.spec.id, chapterId: 'new41', compilationId: 'compiler', checkedRevision: 3 } })
    f.chapter.revision++
    Object.assign(f.compilation.validation, { checkedRevision: 4, checkRounds: 2 })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    expect(f.spec).toEqual(frozenSpec)
  })
  it.each(['parent', 'child', 'reprepare'] as const)('cannot hide consumption with %s execution', async direction => {
    const f = fixture()
    await (await assertChapterReviewRevision(f.tx, f.subject, f.chapter))?.()
    if (direction === 'parent') f.subject.runId = 'original-run'
    if (direction === 'reprepare') {
      f.compilation.status = 'abandoned'
      f.rows.unshift({ ...f.compilation, id: 'new-compiler', status: 'active', validation: f.validation })
    }
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    expect(f.db.storyCompilation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'child-run'] }, chapterId: 'new41' }) }))
  })
  it.each(['existing', 'missing-binding', 'foreign-binding', 'wrong-slot', 'wrong-novel', 'wrong-intent', 'proposal', 'selection', 'no-frozen-scope',
    'warning', 'stale', 'failed', 'wrong-chapter', 'coverage', 'scenes', 'source', 'committed', 'completed', 'later-failure', 'later-prepare', 'no-body', 'paid-repair-reserved'] as const)(
    'denies %s evidence without consuming a correction', async scenario => {
      const f = fixture()
      if (scenario === 'existing') f.spec.scope.writing!.targets[0].chapterId = f.chapter.id
      if (scenario === 'missing-binding') f.source.writingBindings = null as never
      if (scenario === 'foreign-binding') f.binding.taskId = 'foreign-task'
      if (scenario === 'wrong-slot') f.chapter.orderIndex = 42
      if (scenario === 'wrong-novel') f.spec.scope.novelId = 'foreign-novel'
      if (scenario === 'wrong-intent') f.spec.intent = 'review'
      if (scenario === 'proposal') f.spec.writingPacing = 'proposal_only'
      if (scenario === 'selection') f.spec.scope.selection = { chapterId: f.chapter.id, start: 0, end: 1 }
      if (scenario === 'no-frozen-scope') delete f.spec.scope.writing
      if (scenario === 'warning') { f.validation.errorCount = 0; f.validation.findings[0].severity = 'warning' }
      if (scenario === 'stale') f.validation.checkedRevision--
      if (scenario === 'failed') f.validation.independentCheck = 'unavailable'
      if (scenario === 'wrong-chapter') f.validation.checkedChapterId = 'different'
      if (scenario === 'coverage') f.validation.coverage.contentHash = '0'.repeat(64)
      if (scenario === 'scenes') f.compilation.sceneTasks = []
      if (scenario === 'source') Object.assign(f.compilation.bridge, { fromChapterId: 'source', sourceRevision: 1 })
      if (scenario === 'committed') f.compilation.bridge.committedAt = new Date() as never
      if (scenario === 'completed') f.compilation.status = 'completed'
      if (scenario === 'later-failure') f.rows.unshift({ ...f.compilation, id: 'later', validation: { ...f.validation, independentCheck: 'unavailable' } })
      if (scenario === 'later-prepare') f.rows.unshift({ ...f.compilation, id: 'later', validation: { checkRounds: 1 } as never })
      if (scenario === 'no-body') f.chapter.content = ''
      if (scenario === 'paid-repair-reserved') f.validation.autoRepairRounds = 1
      await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: scenario === 'foreign-binding' ? 'RUNTIME_RECEIPT_INVALID'
        : scenario === 'stale' ? 'REVIEW_REPAIR_RECHECK_REQUIRED' : 'REPAIR_NOT_AUTHORIZED' })
      expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    })
  it.each(['写下一章，不要修改正文', 'Write the next chapter. Do not edit the draft.', '写下一章。不要做任何改写',
    '写下一章，不要修改前文和新稿', 'Write the next chapter. Do not edit previous chapters or the draft.', '写下一章，不要修改已有章节及本章正文'])('preserves explicit no-change requests: %s', async prompt => {
    const f = fixture(prompt)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('respects frozen hard constraints, while earlier chapter protection does not forbid correction of this new chapter', async () => {
    const f = fixture()
    f.spec.hardConstraints.push({ id: 'keep-draft', kind: 'author_directive', text: '不要修改本章正文' })
    await expect(readNewDraftWritingAuthority(f.tx, f.subject, f.chapter)).resolves.toBeNull()
    expect(prohibitsNewDraftRevision('不要修改前文')).toBe(false)
  })
  it('reports an open channel without consuming the one merged correction', async () => {
    const f = fixture()
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('a complete quality report cannot close an unspent factual correction by moving the compiler to repair', async () => {
    const f = fixture()
    f.compilation.stage = 'repair'
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ newDraftRevision: { checkedRevision: 3 } })
  })
  it('reports closed after the merged correction is consumed, without consuming anything itself', async () => {
    const f = fixture()
    await (await assertChapterReviewRevision(f.tx, f.subject, f.chapter))?.()
    f.chapter.revision++
    Object.assign(f.compilation.validation, { checkedRevision: 4, checkRounds: 2 })
    expect(f.db.storyCompilation.update).toHaveBeenCalledTimes(1)
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(false)
    expect(f.db.storyCompilation.update).toHaveBeenCalledTimes(1)
  })
  it.each(['exhausted', 'unauthorized', 'committed-window', 'later-failure'] as const)('reports a closed channel while edits stay blocked: %s', async scenario => {
    const f = fixture()
    if (scenario === 'exhausted') Object.assign(f.validation, { checkRounds: 3, independentCheck: 'unavailable' })
    if (scenario === 'unauthorized') f.spec.intent = 'review'
    if (scenario === 'committed-window') f.compilation.bridge.committedAt = new Date() as never
    if (scenario === 'later-failure') f.rows.unshift({ ...f.compilation, id: 'later', validation: { ...f.validation, independentCheck: 'unavailable' } })
    await expect(isChapterRevisionChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(false)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('admits the one unspent correction from the final complete check without replenishing checks', async () => {
    const f = fixture()
    Object.assign(f.validation, { checkRounds: 3 })
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    expect(consume).toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 3, autoRepairRounds: 0, newDraftRevision: { checkedRevision: 3 } })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
  })
  it('admits one strict-mode quality correction from a complete report bound to the active compilation', async () => {
    const f = fixture()
    f.validation.checkRounds = 9
    f.validation.errorCount = 0; f.validation.findings = []
    const quality = { id: 'q', compilationId: 'compiler', chapterRevision: f.chapter.revision, repairRound: 0, status: 'passed',
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(f.chapter.content).digest('hex') },
      findings: [{ id: 'q1', severity: 'warning', startOffset: 0, endOffset: 2, disposition: 'pending', authorFeedback: null }] }
    vi.mocked(f.db.chapterQualityReport.findMany).mockImplementation((async (args: Prisma.ChapterQualityReportFindManyArgs) => (args?.include ? [quality] : []) as never) as never)
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true })
    expect(consume).toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ newDraftRevision: { taskId: f.spec.id, chapterId: 'new41', compilationId: 'compiler', checkedRevision: 3 } })
    expect(f.db.chapterQualityReport.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ include: { findings: true } }))
  })
  it('probes a pending strict-mode report on an uncommitted compilation without consuming the correction', async () => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    const pendingQuality = { compilationId: 'compiler', candidates: 2 }
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    f.compilation.bridge.committedAt = new Date() as never
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toMatchObject({ open: false })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each([
    { status: 'failed', reprepare: false }, { status: 'analyzing', reprepare: false },
    { status: 'failed', reprepare: true }, { status: 'analyzing', reprepare: true },
  ])('latest $status quality assessment blocks older advice (reprepare=$reprepare)', async ({ status, reprepare }) => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    const older = { id: 'older', compilationId: 'compiler', chapterRevision: f.chapter.revision, repairRound: 0, status: 'needs_repair',
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(f.chapter.content).digest('hex') },
      findings: [{ id: 'advice', severity: 'warning', startOffset: 0, endOffset: 2, disposition: 'pending', authorFeedback: null }] }
    if (reprepare) f.rows.unshift({ ...f.compilation, id: 'later-compiler' })
    const latest = { ...older, id: 'latest', compilationId: reprepare ? 'later-compiler' : older.compilationId, status, findings: [] }
    vi.mocked(f.db.chapterQualityReport.findMany).mockImplementation((async (args: Prisma.ChapterQualityReportFindManyArgs) =>
      (args?.include ? [latest, older] : []) as never) as never)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toMatchObject({ open: false })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('keeps the strict-mode channel closed without a complete bound report or with zero candidates', async () => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true })).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality: { compilationId: 'compiler', candidates: 0 } })).resolves.toMatchObject({ open: false })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('keeps a pending factual error in its own channel: strict-mode quality repair cannot consume it', async () => {
    const f = fixture()
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true })).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
})
