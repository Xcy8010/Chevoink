import { beginReviewCycle } from '../../api/lib/agent/review-cycle.js'
import * as sourceReads from '../../api/lib/agent/compiler-continuity-source.js'
import { createHash } from 'node:crypto'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as original from '../../api/lib/agent/original-request.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import { assertChapterManuscriptRevision, assertChapterReviewRevision, probeChapterReviewRevision, continuityDecisionBinding, readChapterReviewReadiness, originalChapterReviewRequirements, recordChapterReviewDecisions } from '../../api/lib/agent/chapter-review-guard.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readNewDraftRevision, readNewDraftWritingAuthority, prohibitsNewDraftRevision } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'

async function paidChannelOpen(...args: Parameters<typeof probeChapterReviewRevision>) {
  return (await probeChapterReviewRevision(...args)).open
}
afterEach(() => vi.restoreAllMocks())
describe('review driven manuscript mutation admission', () => {
  function fixture(prompt: string, validation: Record<string, unknown> | null, reports: Array<{ chapterRevision: number }> = []) {
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt, spec: null, taskId: 'task', sourceRunId: 'original-run', parentRunId: null })
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original-run', 'resumed-run'])
    const chapter = { id: 'c', title: '原章', revision: 4, orderIndex: 1, content: '当前保存的正文。' }
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), chapter: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(chapter) },
      storyCompilation: { findMany: vi.fn().mockResolvedValue(validation ? [{ validation }] : []) },
      chapterQualityReport: { findMany: vi.fn().mockResolvedValue(reports) } } as unknown as Prisma.TransactionClient
    return { db, subject: { userId: 'u', novelId: 'n', runId: 'resumed-run' }, chapter }
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
  it.each(['写下一章', '检查并修复当前章'])('historical count and stale advice cannot replace original mutation authority: %s', async prompt => {
    const f = fixture(prompt, { checkRounds: 3, checkedRevision: 3, errorCount: 1 })
    const before = structuredClone({ checkRounds: 3, checkedRevision: 3, errorCount: 1 })
    if (prompt === '写下一章') await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    else await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
    expect((await f.db.storyCompilation.findMany())[0].validation).toEqual(before)
  })
  it.each(['continuity', 'quality'])('explicit author permission survives a revision while old %s evidence remains old', async kind => {
    const f = fixture('检查并修复当前章', kind === 'continuity' ? { checkRounds: 1, checkedRevision: 4 } : null,
      kind === 'quality' ? [{ chapterRevision: 4 }] : [])
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
    f.chapter.revision++
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
    expect(kind === 'continuity' ? (await f.db.storyCompilation.findMany())[0].validation : (await f.db.chapterQualityReport.findMany())[0]).toMatchObject({ [kind === 'continuity' ? 'checkedRevision' : 'chapterRevision']: 4 })
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
  it('repreparing preserves old checked revisions without closing explicit author permission', async () => {
    const f = fixture('检查并修复当前章', null)
    f.chapter.revision = 5
    vi.mocked(f.db.storyCompilation.findMany).mockImplementation((async (args: Prisma.StoryCompilationFindManyArgs) => [
      ...(!args?.where?.status ? [{ validation: { checkedRevision: 4, checkRounds: 1 } }] : []),
      { validation: { checkRounds: 1 } },
    ]) as never)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
    expect((await f.db.storyCompilation.findMany())[0].validation).toMatchObject({ checkedRevision: 4, checkRounds: 1 })
  })
})

describe('current reviews and original new-draft manuscript authority', () => {
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
    const compilation = { id: 'compiler', chapterId: chapter.id, chapter, runId: 'original-run', preparedContext: {} as Record<string, unknown>, status: 'active', stage: 'check', validation, bridge, sceneTasks: scenes }
    const rows = [compilation]
    const source = { writingBindings: binding }
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), agentRun: { findFirstOrThrow: vi.fn().mockResolvedValue(source),
      findFirst: vi.fn().mockResolvedValue({ mode: 'act', taskRootId: null, runtimeProtocolVersion: 0, session: { userId: 'u', novelId: 'n', sandboxMode: 'workspace', toolPolicy: null } }) },
      chapter: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockImplementation(async (args?: Prisma.ChapterFindFirstArgs) =>
        args?.where?.revision !== undefined && args.where.revision !== chapter.revision ? null : chapter) }, chapterQualityReport: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
      storyCompilation: { findMany: vi.fn().mockImplementation(async (args?: Prisma.StoryCompilationFindManyArgs) => rows.filter(row => !args?.where?.id || args.where.id === row.id)), findFirst: vi.fn().mockImplementation(async (args?: Prisma.StoryCompilationFindFirstArgs) => rows.find(row => !args?.where?.id || args.where.id === row.id) ?? null),
        findFirstOrThrow: vi.fn().mockResolvedValue(compilation), update: vi.fn().mockImplementation(async ({ data }) => Object.assign(compilation, data)) },
    }
    db.chapterQualityReport.findFirst.mockImplementation(async (args?: Prisma.ChapterQualityReportFindFirstArgs) =>
      (await db.chapterQualityReport.findMany()).find((report: { compilationId: string }) => !args?.where?.compilationId || report.compilationId === args.where.compilationId) ?? null)
    const tx = db as unknown as Prisma.TransactionClient
    const subject = { userId: 'u', novelId: 'n', runId: 'child-run' }
    const result = { tx, db, subject, chapter, request, spec, binding, source, validation, compilation, rows }
    completeContinuity(result)
    return result
  }
  function completeContinuity(f: ReturnType<typeof fixture>) {
    const table = buildQualityEvidenceSources({ userId: f.subject.userId, novelId: f.subject.novelId, chapterId: f.chapter.id, chapterRevision: f.chapter.revision }, f.chapter.content)
    const contextHash = runtimeJson({ taskId: f.request.taskId, chapterId: f.chapter.id,
      sources: [{ chapterId: f.chapter.id, revision: f.chapter.revision, orderIndex: f.chapter.orderIndex, contentHash: table.contentHash }],
      authorRequest: f.request.prompt, focus: null }).hash
    const report = { version: 1, id: `continuity-${contextHash}`, chapterId: f.chapter.id, taskId: f.request.taskId, revision: f.chapter.revision,
      contextHash, contentHash: table.contentHash, complete: true, billingKnown: true, opinions: [], unlocatedIndexes: [], usageIds: [], rawResponses: [],
      findings: f.validation.findings.map((finding, index) => ({ ...finding, id: String(index), explanation: finding.evidence,
        startOffset: index ? 6 : 0, endOffset: index ? 8 : 2, references: [] })) }
    Object.assign(f.compilation.validation, { continuityReport: report })
    return report
  }
  function completeQuality(f: ReturnType<typeof fixture>, candidates = 0) {
    const report = { id: 'q', compilationId: f.compilation.id, chapterRevision: f.chapter.revision, repairRound: 0, status: 'passed',
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(f.chapter.content).digest('hex') },
      findings: Array.from({ length: candidates }, (_, index) => ({ id: `quality-${index}`, source: 'critic', signal: 'emotion_grounding',
        severity: 'warning', startOffset: index * 4, endOffset: index * 4 + 2, evidenceExcerpt: f.chapter.content.slice(index * 4, index * 4 + 2),
        explanation: '合成建议', suggestion: '合成修法', confidence: 0.9, disposition: 'pending', authorFeedback: null })) }
    f.db.chapterQualityReport.findMany.mockResolvedValue([report] as never)
    return report
  }
  it('rereads actual source context for each pre-CAS admission without running the historical inheritance court', async () => {
    const f = fixture(), quality = completeQuality(f, 1)
    const baseline = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(baseline?.ready).toBe(true)
    f.compilation.preparedContext.reviewCycle = beginReviewCycle({ taskId: f.spec.id, userId: f.subject.userId,
      novelId: f.subject.novelId, chapterId: f.chapter.id }, { compilationId: f.compilation.id, revision: f.chapter.revision,
      content: f.chapter.content, ready: true, binding: baseline!.decisionBinding!, required: originalChapterReviewRequirements(f.request, f.chapter),
      findings: baseline!.reviewCycleFindings ?? [], obligations: baseline!.requiredDecisions ?? [] })
    const originalRevision = f.chapter.revision
    const sourceRead = vi.spyOn(sourceReads, 'readCompilerContinuitySource').mockResolvedValue(null)
    const retainedFindings = [{ source: 'quality' as const, reportId: quality.id, findingId: quality.findings[0].id, reason: 'Keep the original voice.' }]
    const first = await assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after: 'First legitimate change.', retainedFindings })
    expect(first).toBeTypeOf('function')
    const firstReads = f.db.chapter.findMany.mock.calls.length
    expect(f.db.chapter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ authorId: 'u', orderIndex: { lt: 41 } }) }))
    const second = await assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after: 'Second legitimate change.', retainedFindings })
    expect(second).toBeTypeOf('function')
    expect(f.db.chapter.findMany.mock.calls.length).toBeGreaterThan(firstReads)
    expect(sourceRead).not.toHaveBeenCalled()
    // Neither admission consumed a revision or cached the whole readiness.
    expect(f.chapter.revision).toBe(originalRevision)
    expect(f.compilation.preparedContext.reviewCycle).toMatchObject({ transitions: [] })
  })
  it('records actual repeated manuscript CAS without consuming historical paid counters or closing current authority', async () => {
    const f = fixture(), report = completeQuality(f, 2)
    f.validation.checkRounds = 3
    report.repairRound = 1
    const before = structuredClone(report)
    const consume = await assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after: '第一处改动，其他意见未处理。' })
    f.chapter.content = '第一处改动，其他意见未处理。'; f.chapter.revision++
    await consume?.()
    for (const mutation of ['range', 'replace', 'append'] as const) {
      const next = await assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation, after: '后续合法修改。' + mutation })
      f.chapter.content = '后续合法修改。' + mutation; f.chapter.revision++
      await next?.()
    }
    expect(f.compilation.validation).toMatchObject({ checkRounds: 3, autoRepairRounds: 0 })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    expect(f.compilation.preparedContext.reviewCycle).toMatchObject({ transitions: expect.any(Array) })
    expect(report).toEqual(before)
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toEqual({ open: true })
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ continuity: 'stale', quality: 'stale', terminalCommitted: false })
  })
  it.each(['malformed', 'foreign-task', 'foreign-chapter'] as const)('preserves the %s historical receipt without making it a new manuscript gate', async scenario => {
    const f = fixture()
    Object.assign(f.compilation.validation, { newDraftRevision: scenario === 'malformed' ? { version: 1 } : {
      version: 1, taskId: scenario === 'foreign-task' ? 'another-task' : f.spec.id,
      chapterId: scenario === 'foreign-chapter' ? 'another-chapter' : f.chapter.id, compilationId: 'old-compiler', checkedRevision: 2,
    } })
    const before = structuredClone(f.compilation.validation)
    if (scenario === 'malformed') expect(() => readNewDraftRevision(f.compilation.validation)).toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
    else expect(readNewDraftRevision(f.compilation.validation)).toMatchObject({ chapterId: scenario === 'foreign-chapter' ? 'another-chapter' : f.chapter.id })
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: f.chapter.content })).resolves.toBeUndefined()
    expect(f.compilation.validation).toEqual(before)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('an ordinary no-op neither mints a correction nor pretends to process current candidates', async () => {
    const f = fixture()
    completeQuality(f, 2)
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: f.chapter.content })).resolves.toBeUndefined()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
  })
  it('explicit original existing-chapter repair permits repeated manuscript edits after paid repair without reopening it', async () => {
    const f = fixture('检查并修复当前章'), report = completeQuality(f)
    f.spec.scope.writing!.targets[0].chapterId = f.chapter.id
    report.repairRound = 1
    f.validation.checkRounds = 3
    const before = structuredClone(f.compilation.validation)
    for (const after of ['第一处改动。', '第二处改动。']) {
      expect(await assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after })).toBeTypeOf('function')
    }
    expect(f.compilation.validation).toEqual(before)
    expect(report.repairRound).toBe(1)
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toEqual({ open: true })
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
      retainedFindings: scenario === 'duplicate' ? [retained, retained] : [retained] })).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
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
  it.each(['range', 'append'] as const)('current findings do not ban an authorized %s or claim their own resolution', async mutation => {
    const f = fixture()
    f.validation.findings.push({ ...f.validation.findings[0], evidence: '第二个合成互斥事实' })
    f.validation.errorCount = 2
    completeQuality(f)
    completeContinuity(f)
    const before = structuredClone(f.compilation)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation })).resolves.toBeUndefined()
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    expect(f.compilation).toEqual(before)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ continuityErrorCount: 2, decisionPending: true, terminalCommitted: false })
  })
  it('counts safe quality candidates alongside continuity errors, including warnings', async () => {
    const f = fixture()
    completeQuality(f, 1)
    const ready = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(ready).toMatchObject({ continuityErrorCount: 1, qualityCandidateCount: 1, decisionPending: true })
    expect(ready!.requiredDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'quality', reportId: 'q', findingId: 'quality-0' })]))
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range' })).resolves.toBeUndefined()
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
    completeContinuity(f)
    return { ...f, report }
  }
  it.each([false, true])('records a real atomic batch without treating untouched middle advice as repaired (historical candidate=%s)', async withTerminal => {
    const f = mixedFixture()
    if (withTerminal) {
      const terminalCandidate = terminalCandidateSchema.parse({ exitState: {} })
      Object.assign(f.validation, { terminalCandidate })
      f.validation.coverage = compilerContinuityCoverage({ chapter: f.chapter, bridge: f.compilation.bridge, sceneTasks: f.compilation.sceneTasks, source: null, terminalCandidate })
    }
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '丙句。中句。丁句。' }))
      .resolves.toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    const retainedFindings = [{ source: 'quality' as const, reportId: 'q', findingId: 'finding-middle', reason: '保留人物刻意重复的声口，不能安全删去。' }]
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range', mergedBatch: true,
      after: '丙句。中句。丁句。', editRanges: [{ start: 0, end: 2, newText: '丙句' }, { start: 6, end: 8, newText: '丁句' }], retainedFindings })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    f.chapter.content = '丙句。中句。丁句。'; f.chapter.revision++
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0, retainedReviewDecision: { findings: retainedFindings } })
    expect(f.report.findings[0]).toMatchObject({ evidenceExcerpt: '中句。', disposition: 'pending' })
    expect(f.compilation.preparedContext.reviewCycle).toMatchObject({ transitions: [{ after: { revision: 4 } }] })
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toEqual({ open: true })
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ continuity: 'stale', quality: 'stale', terminalCommitted: false })
  })
  it.each(['old-report', 'unknown-id', 'blank-reason', 'duplicate'] as const)('rejects invalid current-candidate retention: %s', async scenario => {
    const f = mixedFixture()
    const item = { source: 'quality' as const, reportId: 'q', findingId: 'finding-middle', reason: '保留当前声口' }
    if (scenario === 'old-report') item.reportId = 'old-q'
    if (scenario === 'unknown-id') item.findingId = 'foreign'
    if (scenario === 'blank-reason') item.reason = ' '
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '丙句。中句。丁句。',
      retainedFindings: scenario === 'duplicate' ? [item, item] : [item] })).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('accepts a real located quality patch that preserves the quoted phrase while adding the missing detail', async () => {
    const f = mixedFixture()
    const after = '丙句。中句。补充动作。丁句。'
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after,
      editRanges: [{ start: 0, end: 2, newText: '丙句' }, { start: 3, end: 6, newText: '中句。补充动作。' }, { start: 6, end: 8, newText: '丁句' }] }))
      .resolves.toBeTypeOf('function')
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
    const retainedReadiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(retainedReadiness).toMatchObject({ decisionPending: false, continuityErrorCount: 2, qualityCandidateCount: 1, terminalCommitted: false })
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    const writes = f.db.storyCompilation.update.mock.calls.length
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after: '甲新句。中新句。乙新句。' }))
      .resolves.toBeTypeOf('function')
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range', mergedBatch: true,
      after: '甲新句。中新句。乙新句。' })).resolves.toBeTypeOf('function')
    expect(f.db.storyCompilation.update).toHaveBeenCalledTimes(writes)
    Object.assign(f.report.findings[0], { suggestion: '当前新建议' })
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ decisionPending: true })
  })
  it('an authorized append or range is independent of a historical correction slot and leaves report errors untouched', async () => {
    const f = fixture()
    completeQuality(f)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'append' })).resolves.toBeUndefined()
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'range' })).resolves.toBeUndefined()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ continuityErrorCount: 1, decisionPending: true, terminalCommitted: false })
  })
  it.each(['missing-quality', 'failed-quality', 'analyzing-quality', 'stale-quality', 'hash-quality', 'foreign-compilation',
    'repaired-quality', 'incomplete-quality', 'malformed-continuity', 'coverage', 'count', 'source'] as const)(
    'author admission does not promote an invalid or historical %s report into a current check', async scenario => {
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
      await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace' })).resolves.toBeUndefined()
      const readiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
      if (!['malformed-continuity', 'coverage', 'count', 'source'].includes(scenario)) expect(readiness?.quality).not.toBe('complete')
      if (scenario === 'foreign-compilation') expect(report.compilationId).toBe('other')
      expect(readiness?.terminalCommitted).toBe(false)
      expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
      expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    })
  it('pending candidates neither grant extra authority nor count as a completed quality report', async () => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    const pendingQuality = { compilationId: f.compilation.id, candidates: 2 }
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', requireQualityChannel: true, pendingQuality }))
      .resolves.toBeUndefined()
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ quality: 'missing', terminalCommitted: false })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['unreviewed', 'failed', 'coverage', 'foreign-compilation'] as const)('pending quality never certifies %s continuity or consumes a paid phase', async scenario => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    if (scenario === 'unreviewed') f.compilation.validation = null as never
    if (scenario === 'failed') f.validation.independentCheck = 'unavailable'
    if (scenario === 'coverage') f.validation.coverage.reviewHash = '0'.repeat(64)
    const pendingQuality = { compilationId: scenario === 'foreign-compilation' ? 'other' : f.compilation.id, candidates: 1 }
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, requireCurrentContinuity: true, pendingQuality }))
      .resolves.toMatchObject({ open: true })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    const readiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(readiness?.quality).toBe('missing')
    if (scenario === 'unreviewed') expect(readiness?.continuity).not.toBe('complete')
    expect(readiness?.terminalCommitted).toBe(false)
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
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'replace' })).resolves.toBeUndefined()
    const readiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(readiness?.requiredTools.some(tool => tool.name === 'quality_analyze')).toBe(false)
    expect(readiness?.continuityErrorCount).toBe(1)
  })
  it('leaves explicit existing repair authority independent of new-draft prechecks and mutation shape', async () => {
    const f = fixture('检查并修复当前章')
    f.spec.scope.writing!.targets[0].chapterId = f.chapter.id
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { mutation: 'append' })).resolves.toBeUndefined()
  })
  it('current checks and repeated admission do not consume a synthetic correction or change original authority', async () => {
    const f = fixture(), frozenSpec = structuredClone(f.spec)
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    expect(consume).toBeUndefined()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    f.chapter.revision++
    Object.assign(f.compilation.validation, { checkedRevision: 4, checkRounds: 2 })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeUndefined()
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ continuity: 'stale', terminalCommitted: false })
    expect(f.spec).toEqual(frozenSpec)
  })
  it.each(['parent', 'child', 'reprepare'] as const)('keeps original lineage and unchanged fees across %s execution without a paid-slot gate', async direction => {
    const f = fixture()
    await (await assertChapterReviewRevision(f.tx, f.subject, f.chapter))?.()
    if (direction === 'parent') f.subject.runId = 'original-run'
    if (direction === 'reprepare') {
      f.compilation.status = 'abandoned'
      f.rows.unshift({ ...f.compilation, id: 'new-compiler', status: 'active', validation: f.validation })
    }
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeUndefined()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    expect(f.db.storyCompilation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'child-run'] }, chapterId: 'new41' }) }))
  })
  it.each(['existing', 'missing-binding', 'foreign-binding', 'wrong-slot', 'wrong-novel', 'wrong-intent', 'proposal', 'selection', 'no-frozen-scope', 'marker-without-frozen-scope',
    'warning', 'stale', 'failed', 'wrong-chapter', 'coverage', 'scenes', 'source', 'committed', 'completed', 'later-failure', 'later-prepare', 'no-body', 'paid-repair-reserved'] as const)(
    'keeps original scope decisions separate from historical %s review state', async scenario => {
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
      if (scenario === 'marker-without-frozen-scope') { delete f.spec.scope.writing; f.spec.scope.writingClarificationProtocol = 1 }
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
      const unauthorized = ['existing', 'missing-binding', 'foreign-binding', 'wrong-slot', 'wrong-novel', 'wrong-intent', 'proposal', 'no-frozen-scope', 'marker-without-frozen-scope'].includes(scenario)
      if (unauthorized) await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: scenario === 'foreign-binding' ? 'RUNTIME_RECEIPT_INVALID' : 'REPAIR_NOT_AUTHORIZED' })
      else if (scenario === 'selection') await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
      else await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeUndefined()
      expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
      expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
      if (scenario === 'stale') expect(f.validation.checkedRevision).toBe(2)
      if (scenario === 'failed') expect(f.validation.independentCheck).toBe('unavailable')
      if (scenario === 'paid-repair-reserved') expect(f.validation.autoRepairRounds).toBe(1)
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
  it('probes original authority without changing reports, counters or the manuscript', async () => {
    const f = fixture()
    const before = structuredClone(f.compilation)
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.compilation).toEqual(before)
  })
  it('a complete quality report cannot close an unspent factual correction by moving the compiler to repair', async () => {
    const f = fixture()
    f.compilation.stage = 'repair'
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    await consume?.()
    expect(consume).toBeUndefined()
    expect(f.compilation.validation).toMatchObject({ checkedRevision: 3, checkRounds: 1 })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
  })
  it('a changed revision remains editable while its old report remains stale', async () => {
    const f = fixture()
    await (await assertChapterReviewRevision(f.tx, f.subject, f.chapter))?.()
    f.chapter.revision++
    Object.assign(f.compilation.validation, { checkedRevision: 4, checkRounds: 2 })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(true)
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ continuity: 'stale', terminalCommitted: false })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['exhausted', 'unauthorized', 'committed-window', 'later-failure'] as const)('only actual author authority closes the current edit probe, not %s platform history', async scenario => {
    const f = fixture()
    if (scenario === 'exhausted') Object.assign(f.validation, { checkRounds: 3, independentCheck: 'unavailable' })
    if (scenario === 'unauthorized') f.spec.intent = 'review'
    if (scenario === 'committed-window') f.compilation.bridge.committedAt = new Date() as never
    if (scenario === 'later-failure') f.rows.unshift({ ...f.compilation, id: 'later', validation: { ...f.validation, independentCheck: 'unavailable' } })
    await expect(paidChannelOpen(f.tx, f.subject, f.chapter)).resolves.toBe(scenario !== 'unauthorized')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
  })
  it('historical final-check counters are preserved without limiting repeated authorized admission', async () => {
    const f = fixture()
    Object.assign(f.validation, { checkRounds: 3 })
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    expect(consume).toBeUndefined()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 3, autoRepairRounds: 0 })
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeUndefined()
  })
  it('strict-mode quality advice remains current and undecided without a paid correction slot', async () => {
    const f = fixture()
    f.validation.checkRounds = 9
    f.validation.errorCount = 0; f.validation.findings = []
    const quality = completeQuality(f, 1)
    quality.findings[0].id = 'q1'
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true })
    expect(consume).toBeUndefined()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).not.toHaveProperty('newDraftRevision')
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ quality: 'complete', qualityCandidateCount: 1, decisionPending: true })
    expect(f.db.chapterQualityReport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u', novelId: 'n', chapterId: f.chapter.id, runId: { in: ['original-run', 'child-run'] } }), include: { findings: true } }))
  })
  it('a pending strict-mode probe cannot claim a report or commit, even with a historical commit timestamp', async () => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    const pendingQuality = { compilationId: 'compiler', candidates: 2 }
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    f.compilation.bridge.committedAt = new Date() as never
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality })).resolves.toEqual({ open: true })
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ quality: 'missing', terminalCommitted: false })
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
    f.db.chapterQualityReport.findMany.mockResolvedValue([latest, older] as never)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeUndefined()
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toEqual({ open: true })
    expect((await readChapterReviewReadiness(f.tx, f.subject, reprepare ? 'later-compiler' : f.compilation.id))?.quality).toBe('incomplete')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('zero candidates never certify a missing report or consume original author authority', async () => {
    const f = fixture()
    f.validation.errorCount = 0; f.validation.findings = []
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true })).resolves.toBeUndefined()
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true, pendingQuality: { compilationId: 'compiler', candidates: 0 } })).resolves.toEqual({ open: true })
    await expect(readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)).resolves.toMatchObject({ quality: 'missing', terminalCommitted: false })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('a quality preflight cannot consume or erase an existing factual error', async () => {
    const f = fixture()
    const before = structuredClone(f.compilation.validation)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter, { requireQualityChannel: true })).resolves.toBeUndefined()
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toBeUndefined()
    expect(f.compilation.validation).toEqual(before)
    expect((await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id))?.continuityErrorCount).toBe(1)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['revision', 'content', 'source-context', 'chapter', 'billing', 'incomplete'] as const)('never promotes a %s mismatched current report into a completed check', async scenario => {
    const f = fixture(), report = completeContinuity(f)
    completeQuality(f)
    if (scenario === 'revision') report.revision--
    if (scenario === 'content') report.contentHash = '0'.repeat(64)
    if (scenario === 'chapter') report.chapterId = 'foreign-chapter'
    if (scenario === 'source-context') f.db.chapter.findMany.mockResolvedValue([{ id: 'previous', title: '前章', revision: 2, orderIndex: 40, content: '真实前文已变化。' }] as never)
    if (scenario === 'billing') report.billingKnown = false
    if (scenario === 'incomplete') report.complete = false
    const before = structuredClone(report)
    const readiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(readiness?.continuity).not.toBe('complete')
    expect(readiness?.requiredTools).toContainEqual({ name: 'continuity_validate', args: { compilationId: f.compilation.id } })
    expect(readiness?.terminalCommitted).toBe(false)
    await expect(probeChapterReviewRevision(f.tx, f.subject, f.chapter)).resolves.toEqual({ open: true })
    expect(report).toEqual(before)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it.each(['balanced', 'stable', 'bold'] as const)('preserves humanity %s advice-decision semantics independently of continuity', async creativeFreedom => {
    const f = fixture()
    f.spec.creativeFreedom = creativeFreedom
    f.validation.findings = []; f.validation.errorCount = 0
    completeContinuity(f)
    const quality = completeQuality(f, 1)
    quality.status = 'needs_repair'
    const readiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(readiness).toMatchObject({ continuity: 'complete', quality: 'complete', qualityCandidateCount: 1, decisionPending: creativeFreedom === 'balanced' })
    expect(quality.findings[0].disposition).toBe('pending')
  })
  it('explicit retention never waives the original hard quality-pass requirement', async () => {
    const f = fixture('检查并修复当前章，质量检查必须通过')
    f.validation.findings = []; f.validation.errorCount = 0
    completeContinuity(f)
    const quality = completeQuality(f, 1)
    quality.status = 'needs_repair'
    const readiness = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(readiness).toMatchObject({ quality: 'complete', qualityPassRequired: true, decisionPending: true })
    await recordChapterReviewDecisions(f.tx, f.subject, readiness!, [{ source: 'quality', reportId: quality.id, findingId: quality.findings[0].id, reason: '保留人物声口，当前意见仍未修复。' }])
    const after = await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id)
    expect(after).toMatchObject({ mustPassPending: true, decisionPending: true, terminalCommitted: false })
    expect(quality.status).toBe('needs_repair')
    expect(quality.findings[0].disposition).toBe('pending')
  })
})
