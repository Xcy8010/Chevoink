import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertChapterReviewRevision, originalChapterReviewRequirements, readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { qualityReportCheckedCurrentContent, qualityReportMatchesContent } from '../../api/lib/agent/quality-report-contract.js'
import { commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import { nextReviewDispatch, reviewDispatchKey } from '../../api/lib/agent/review-dispatch.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as humanity from '../../api/lib/agent/humanity-quality.js'
import { advanceTerminalCoverage, terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectTerminalReview, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { projectCurrentReviewNextStep, currentReviewNextStepGuidance } from '../../api/lib/agent/review-dispatch.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { prepareTerminalProposalInput } from '../../api/lib/agent/terminal-proposal-context.js'
import { terminalProcessingExhaustedMessage, terminalProcessingPlan } from '../../api/lib/agent/terminal-processing.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

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
    chapter: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(chapter), update: vi.fn() },
    storyCompilation: { findFirst: vi.fn().mockResolvedValue(compilation), findFirstOrThrow: vi.fn().mockResolvedValue(compilation), findMany: vi.fn().mockResolvedValue([compilation]),
      update: vi.fn(async ({ data }) => Object.assign(compilation, data)) },
    chapterQualityReport: { findUnique: vi.fn().mockResolvedValue(report), findFirst: vi.fn().mockResolvedValue(report), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
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
  it('keeps proposal-only unknown work actionable within the original two processing claims', async () => {
    const f = fixture('修改第44章。完成连续性与人类感检查。')
    Object.assign(f.task.scope, { terminalCoverageProtocol: 2, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 })
    const base = terminalCandidateSchema.parse({ exitState: { knowledge: ['未获证实的旧线索归属。'] } })
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['门已经锁好'] } })
    const context = terminalEvidenceContext(f.chapter, null, 2, 1, terminalCoverageInput(f.task, {}, f.chapter, candidate, 2), 5, 2)
    const response = (selected: typeof candidate, verdict: 'supported' | 'unknown') => ({ findings: [],
      semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: '核对合成章节全文。', findingIndexes: [] })),
      terminalVerdicts: [{ path: selected === base ? 'exitState.knowledge.0' : 'exitState.objects.0', verdict,
        sourceEvidence: verdict === 'supported' ? [{ segmentId: 'c0', quote: candidate.exitState.objects[0] }] : [] }],
      terminalProofVerdicts: [], terminalDispositions: [] })
    const prior = inspectContinuityResponse(JSON.stringify(response(base, 'unknown')), { previous: null, current: f.chapter.content, terminalEvidence: context }, true, 8, base)
    expect(prior.complete).toBe(true)
    const staged = prepareTerminalProposalInput({ spec: f.task, preparedContext: {},
      validation: { independentCheck: 'complete', terminalCandidate: base, continuityCriticResponse: prior.audit },
      content: f.chapter.content, previousContent: null, candidate, originalContext: context, nextContext: context })!
    expect(staged.changes?.proposals).toHaveLength(1)
    const proposal = staged.changes!.proposals[0], reason = '当前正文无法确认旧线索归属，保留原提议。'
    const evidence = { ...context, proposalChanges: staged.changes }
    const inspected = inspectContinuityResponse(JSON.stringify({ ...response(candidate, 'supported'),
      proposalDispositions: [{ id: proposal.id, outcome: 'unknown', reason, sourceEvidence: [] }] }),
    { previous: null, current: f.chapter.content, terminalEvidence: evidence }, true, 8, candidate)
    expect(inspected.complete).toBe(true)
    Object.assign(f.compilation.validation, { terminalCandidate: candidate, continuityCriticResponse: inspected.audit,
      coverage: compilerContinuityCoverage({ chapter: f.chapter, bridge: f.bridge, sceneTasks: f.sceneTasks, source: null, terminalCandidate: candidate }) })
    f.compilation.preparedContext = { terminalProposalReview: staged.state }
    const before = structuredClone({ validation: f.compilation.validation, preparedContext: f.compilation.preparedContext })
    const readiness = await readChapterReviewReadiness(f.tx, f.subject)
    expect(readiness).toMatchObject({ continuity: 'complete', terminalReview: { state: 'unverified', currentResultVerified: true } })
    expect.soft(readiness?.terminalReview?.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `proposals.${proposal.id}`, verdict: 'unknown', field: proposal.field, claim: proposal.claim, reason }),
    ]))
    expect.soft(readiness?.terminalProcessing?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `proposals.${proposal.id}`, reason, field: proposal.field, claim: proposal.claim }),
    ]))
    const subject = { userId: f.subject.userId, novelId: f.subject.novelId, taskSpec: f.task }
    const key = runtimeJson({ kind: 'terminal-processing', version: 1, userId: f.subject.userId, novelId: f.subject.novelId,
      taskId: f.task.id, chapterId: f.chapter.id, contentHash: runtimeJson({ content: f.chapter.content }).hash,
      sourceHash: runtimeJson({ previousContent: '', previousChapterId: null }).hash,
      contractHash: runtimeJson(JSON.parse(JSON.stringify(f.task))).hash }).hash
    const attempts = new Set([`terminal-processing:${key}:0`])
    const plan = terminalProcessingPlan(readiness, subject, attempts)
    expect.soft(plan).toMatchObject({ kind: 'process', claim: `terminal-processing:${key}:1` })
    expect.soft(plan?.guidance ?? '').toContain(proposal.claim)
    expect.soft(plan?.guidance ?? '').toContain(reason)
    attempts.add(`terminal-processing:${key}:1`)
    const exhausted = terminalProcessingPlan(readiness, subject, attempts)
    expect.soft(exhausted).toMatchObject({ kind: 'process', key })
    expect(exhausted?.claim).toBeUndefined()
    expect(terminalProcessingExhaustedMessage(readiness, exhausted)).toContain('当前终态复核结果已收到，仍有1项未获证实')
    expect({ validation: f.compilation.validation, preparedContext: f.compilation.preparedContext }).toEqual(before)
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    expect(f.db.chapterBridge.update).not.toHaveBeenCalled()
    expect(f.db.chapterQualityReport.update).not.toHaveBeenCalled()
    for (const change of ['missing', 'corrupt', 'source-change'] as const) {
      Object.assign(f.compilation.validation, structuredClone(before.validation))
      if (change === 'missing') Object.assign(f.compilation.validation, { continuityCriticResponse: undefined })
      if (change === 'corrupt') Object.assign(f.compilation.validation, { continuityCriticResponse: { ...inspected.audit, rawResponse: { complete: true, content: 'corrupt synthetic response' } } })
      if (change === 'source-change') f.db.chapter.findMany.mockResolvedValue([{ id: 'new-source', title: 'Earlier', revision: 1,
        orderIndex: 43, content: 'A newly inserted synthetic predecessor.' }] as never)
      if (change === 'source-change') {
        await expect(readChapterReviewReadiness(f.tx, f.subject)).rejects.toMatchObject({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' })
        continue
      }
      const invalid = await readChapterReviewReadiness(f.tx, f.subject)
      expect(invalid?.terminalReview?.currentResultVerified, change).toBe(false)
      // Even an old exhausted plan cannot turn an unverifiable report into a received current result.
      expect(terminalProcessingExhaustedMessage(invalid, exhausted), change).not.toContain('结果已收到')
    }
  })
  it.each(['检查当前章节', '写下一章，不用检查', '写下一章，跳过质量检查和连续性检查'])(
    'cannot bypass previously supported facts with reprepare and empty commit even when checks were not required: %s', async prompt => {
      const f = fixture(prompt)
      Object.assign(f.task.scope, { terminalCoverageProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 })
      const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['门已经锁好'] } })
      const evidence = terminalEvidenceContext(f.chapter, null, 2, 1, terminalCoverageInput(f.task, {}, f.chapter, candidate))
      const reviewed = inspectTerminalReview(candidate, f.chapter.content, JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.objects.0',
        verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '门已经锁好' }] }] }), true, evidence)!
      f.compilation.preparedContext = { terminalFactCoverage: advanceTerminalCoverage(f.task, {}, f.chapter, reviewed) }
      f.compilation.validation = null as never
      const readiness = await readChapterReviewReadiness(f.tx, f.subject)
      expect(readiness).toMatchObject({ ready: true, checksRequired: false, terminalReview: { state: 'unverified' } })
      const step = projectCurrentReviewNextStep(readiness!)
      expect(step.state).toBe('terminal_review_required')
      expect(currentReviewNextStepGuidance(step)).toContain('当前完整独立检查尚待确认')
      await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' })
      expect(f.db.chapterBridge.update).not.toHaveBeenCalled()
      expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    })
  it.each(['current', 'repaired', 'rejected', 'wrong-hash', 'wrong-offset', 'stale-context', 'latest-failed', 'stale-revision'])(
    'projects conditional quality edit evidence only from an owned complete current report: %s', async scenario => {
      const f = fixture('修改第44章。完成连续性与人类感检查。')
      Object.assign(f.report.deterministicMetrics, { qualityContextHash: 'current-context' })
      vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({} as never)
      vi.spyOn(humanity, 'qualityReviewContextHash').mockReturnValue(scenario === 'stale-context' ? 'changed-context' : 'current-context')
      const text = '门已经锁好', start = f.chapter.content.indexOf(text)
      const finding = { id: 'proven', signal: 'description_load', severity: 'warning', disposition: 'pending', authorFeedback: null,
        startOffset: start, endOffset: start + text.length, evidenceExcerpt: text, evidenceHash: sha(text), explanation: '合成复核', suggestion: '合成局部建议' }
      if (scenario === 'repaired') finding.disposition = 'repaired'
      if (scenario === 'rejected') Object.assign(finding, { authorFeedback: 'rejected' })
      if (scenario === 'wrong-hash') finding.evidenceHash = sha('其他原文')
      if (scenario === 'wrong-offset') finding.startOffset++
      if (scenario === 'latest-failed') f.report.status = 'failed'
      if (scenario === 'stale-revision') f.report.chapterRevision--
      f.report.findings = [finding] as never
      const result = await readChapterReviewReadiness(f.tx, f.subject, undefined, { reviewBoundEvidence: true })
      expect(result?.reviewBoundEvidence?.anchors).toHaveLength(scenario === 'current' ? 1 : 0)
      expect((await readChapterReviewReadiness(f.tx, f.subject))?.reviewBoundEvidence).toBeUndefined()
      expect(f.db.storyCompilation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original', 'resumed'] } }) }))
      expect(f.db.chapterQualityReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chapterId: f.chapter.id, compilationId: f.compilation.id, runId: { in: ['original', 'resumed'] } }) }))
    })
  it.each(['current', 'previous', 'narrative-only', 'unlocated', 'failed-coverage', 'plan-calibration'])(
    'uses structured current continuity quotes without a narrative/previous-source fallback: %s', async scenario => {
      const f = fixture('修改第44章。无需人类感检查。')
      const text = '门已经锁好'
      Object.assign(f.compilation.validation, { findings: [{ signal: 'location_time', severity: scenario === 'plan-calibration' ? 'warning' : 'error', evidence: `本章“${text}”需复核`, suggestion: '核对',
        ...(scenario === 'narrative-only' ? {} : { sourceEvidence: [{ source: scenario === 'previous' ? 'previous' : 'current', quote: scenario === 'unlocated' ? '不存在原文' : text }] }) }],
        errorCount: scenario === 'plan-calibration' ? 0 : 1, warningCount: scenario === 'plan-calibration' ? 1 : 0 })
      if (scenario === 'failed-coverage') f.chapter.title += '新标题'
      const result = await readChapterReviewReadiness(f.tx, f.subject, undefined, { reviewBoundEvidence: true })
      expect(result?.reviewBoundEvidence?.anchors).toHaveLength(scenario === 'current' ? 1 : 0)
    })
  it('keeps old automatic-window interpretation while fresh strict requires every actual unhandled report ref', async () => {
    const f = fixture()
    const findings = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, source: 'critic', signal: 'emotion_grounding', severity: 'advisory',
      disposition: 'pending', authorFeedback: null, feedbackReason: null, startOffset: i * 2, endOffset: i * 2 + 1,
      evidenceExcerpt: '门', explanation: '动作不足', suggestion: '补动作', confidence: 0.9 }))
    f.report.findings = findings as never
    expect((await readChapterReviewReadiness(f.tx, f.subject))?.requiredDecisions).toHaveLength(8)
    f.task.scope.reviewProtocol = 1
    findings[8].startOffset = findings[0].startOffset; findings[8].endOffset = findings[0].endOffset
    findings[9].startOffset = 999; findings[9].endOffset = 1000
    Object.assign(findings[9], { authorFeedback: 'rejected', feedbackReason: '此处保持克制', severity: 'error' })
    const current = await readChapterReviewReadiness(f.tx, f.subject)
    expect(current).toMatchObject({ ready: true, completeStrictReview: true, decisionPending: true, qualityErrorCount: 1 })
    expect(current?.requiredDecisions?.map(item => item.findingId)).toEqual(findings.map(item => item.id))
    expect(current?.qualityCandidateCount).toBeLessThanOrEqual(8)
    Object.assign(findings[9], { disposition: 'repaired' })
    expect((await readChapterReviewReadiness(f.tx, f.subject))?.requiredDecisions).toHaveLength(9)
    f.task.creativeFreedom = 'bold'
    expect((await readChapterReviewReadiness(f.tx, f.subject))?.completeStrictReview).toBe(false)
  })
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
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ ready: false, quality: 'stale', qualityReportId: null })
    const query = f.db.chapterQualityReport.findFirst.mock.calls[0][0]
    expect(query.where).not.toHaveProperty('chapterRevision')
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })
  it.each(['failed', 'analyzing'] as const)('keeps current %s quality blocked, but permits only the new revision assessment', async status => {
    const f = fixture()
    f.report.status = status
    Object.assign(f.report.deterministicMetrics, { independentCheck: 'unavailable' })
    const before = structuredClone(f.report)
    const available = new Set(['quality_analyze'])
    const current = await readChapterReviewReadiness(f.tx, f.subject)
    expect(current).toMatchObject({ ready: false, quality: 'incomplete', qualityReportId: null })
    expect(nextReviewDispatch(current, available, new Set()).kind).toBe('blocked')
    f.chapter.content += '他继续追查脚印。'; f.chapter.revision++
    f.refreshContinuity()
    const next = await readChapterReviewReadiness(f.tx, f.subject)
    expect(next).toMatchObject({ ready: false, quality: 'stale', qualityReportId: null, requiredTools: [{ name: 'quality_analyze', args: { compilationId: f.compilation.id } }] })
    expect(nextReviewDispatch(next, available, new Set([reviewDispatchKey(current!, 'quality_analyze')])).kind).toBe('tool')
    expect(nextReviewDispatch(next, available, new Set([reviewDispatchKey(next!, 'quality_analyze')])).kind).toBe('blocked')
    expect(nextReviewDispatch(next, new Set(), new Set()).kind).toBe('blocked')
    expect(f.report).toEqual(before)
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    expect(f.db.chapterQualityReport.update).not.toHaveBeenCalled()
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('keeps current unavailable continuity incomplete but makes it stale after a legitimate new revision', async () => {
    const f = fixture()
    f.compilation.validation.independentCheck = 'unavailable'
    f.compilation.validation.checkRounds = 9
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ continuity: 'incomplete', continuityExhausted: false })
    f.chapter.content += '他保存了新线索。'; f.chapter.revision++
    await expect(readChapterReviewReadiness(f.tx, f.subject)).resolves.toMatchObject({ continuity: 'stale', continuityExhausted: false,
      requiredTools: expect.arrayContaining([{ name: 'continuity_validate', args: { compilationId: f.compilation.id } }]) })
    expect(f.compilation.validation).toMatchObject({ checkedRevision: 3, checkRounds: 9, independentCheck: 'unavailable' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
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
  it('blocks unchecked retention after automatic correction is consumed without changing findings', async () => {
    const f = fixture()
    Object.assign(f.compilation.validation, { errorCount: 1, findings: [{ signal: 'object', severity: 'error', evidence: '同一物件状态仍冲突', suggestion: '交作者确认' }],
      newDraftRevision: { version: 1, taskId: f.task.id, chapterId: f.chapter.id, compilationId: f.compilation.id, checkedRevision: 2 } })
    vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'candidate' } as never)
    await expect(commitChapterBridge(f.terminal, f.tx)).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })
    expect(memory.saveStoryMemory).not.toHaveBeenCalled()
    expect(f.bridge.committedAt).toBeNull()
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
    expect(originalChapterReviewRequirements({ prompt: '写下一章，不用质量检查', spec: { intent: 'write', qualityMode: 'premium',
      scope: { writing: { kind: 'bounded', targets: [{ chapterId: 'current', orderIndex: 1 }] } } } }, { id: 'current', orderIndex: 1 }))
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
