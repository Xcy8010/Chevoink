import * as humanity from '../../api/lib/agent/humanity-quality.js'
import { currentReviewReadinessFixture } from '../helpers/current-review-readiness-fixture.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceReviewCycle, beginReviewCycle, projectReviewCycle, projectReviewCycleWrite, attemptedReviewCycleRefs, markReviewCycleVerification, readReviewCycle, reviewCycleContentHash, reviewCycleFinding, verificationQualityAdviceRequiresDecision, qualityReviewCycleContext } from '../../api/lib/agent/review-cycle.js'
import { observedReviewCycleVerification, observedReviewCycleVerificationBody } from '../../api/lib/agent/review-cycle-store.js'
import { currentReviewNextStepGuidance, projectCurrentReviewNextStep } from '../../api/lib/agent/review-dispatch.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readChapterReviewReadiness, readChapterReviewWriteAdmission } from '../../api/lib/agent/chapter-review-guard.js'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'

afterEach(() => vi.restoreAllMocks())

const scope = { taskId: 'task', userId: 'u', novelId: 'n', chapterId: 'c' }
const content = '门锁仍在。屋里没有灯。她没有回答。'
const finding = (body: string, evidence = '她没有回答', id = 'f4', severity = 'advisory') => reviewCycleFinding({
  source: 'quality', reportId: `q${id}`, findingId: id, signal: 'emotion_grounding', severity, evidence }, body)
function baseline() {
  return beginReviewCycle(scope, { compilationId: 'comp', revision: 4, content, ready: true,
    required: { continuity: true, quality: true }, binding: { contentHash: reviewCycleContentHash(content), continuityBinding: 'comp:r4:actual',
      qualityReportId: 'q4', qualityReportHash: 'a'.repeat(64) }, findings: [finding(content)] })
}
function revisions() {
  let cycle = baseline(), body = content
  const bodies = [body.replace('屋里没有灯', '屋里灯亮着'), body.replace('门锁仍在', '门锁还在').replace('屋里没有灯', '屋里灯亮着'),
    body.replace('门锁仍在', '门锁还在').replace('屋里没有灯', '灯光落在桌上')]
  bodies.forEach((after, i) => { cycle = advanceReviewCycle(cycle, { beforeRevision: 4 + i, before: body, afterRevision: 5 + i, after }); body = after })
  return { cycle, body }
}
describe('verified prior review context for the next quality critic', () => {
  it('exposes only actual contiguous edits ending at the current saved body', () => {
    const { cycle, body } = revisions()
    const projected = qualityReviewCycleContext(cycle, { revision: 7, content: body })!
    expect(projected.baseline.body.revision).toBe(4)
    expect(projected.transitions.map(step => step.after.revision)).toEqual([5, 6, 7])
    expect(projected.current).toEqual({ revision: 7, contentHash: reviewCycleContentHash(body) })
    expect(qualityReviewCycleContext(cycle, { revision: 8, content: body })).toBeNull()
    expect(qualityReviewCycleContext(cycle, { revision: 7, content: body + 'new' })).toBeNull()
    expect(qualityReviewCycleContext(baseline(), { revision: 4, content })).toBeNull()
    expect(qualityReviewCycleContext(null, { revision: 7, content: body })).toBeNull()
    const gap = structuredClone(cycle); gap.transitions[1].contiguous = false
    expect(qualityReviewCycleContext(gap, { revision: 7, content: body })).toBeNull()
  })
  it('keeps new original rationale while leaving legacy missing rationale missing', () => {
    const { cycle, body } = revisions()
    expect(qualityReviewCycleContext(cycle, { revision: 7, content: body })!.baseline.findings[0]).not.toHaveProperty('explanation')
    cycle.baseline!.findings[0].explanation = 'The prior critic requested more explicit grounding.'
    cycle.baseline!.findings[0].suggestion = 'Preserve the fact while adding a concrete action.'
    const saved = readReviewCycle(JSON.parse(JSON.stringify({ reviewCycle: cycle })), scope)!
    expect(qualityReviewCycleContext(saved, { revision: 7, content: body })!.baseline.findings[0]).toMatchObject({
      explanation: cycle.baseline!.findings[0].explanation, suggestion: cycle.baseline!.findings[0].suggestion })
    const marked = markReviewCycleVerification(saved, { revision: 7, contentHash: reviewCycleContentHash(body) })
    expect(qualityReviewCycleContext(marked, { revision: 7, content: body })).toEqual(qualityReviewCycleContext(saved, { revision: 7, content: body }))
    expect(() => readReviewCycle({ reviewCycle: saved }, { ...scope, taskId: 'foreign' })).toThrow()
  })
})

describe('current mandatory quality warning write admission', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  async function current(mandatory = true, duplicate = false) {
    const { cycle, body } = revisions()
    const text = '灯光落在桌上', manuscript = duplicate ? `${body}${text}。` : body
    const chapter = { id: 'c', title: '本章', orderIndex: 1, revision: 7, content: manuscript }
    const spec = { intent: 'revise', qualityMode: 'balanced', creativeFreedom: 'balanced', scope: { reviewProtocol: 1 } }
    vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: scope.taskId, sourceRunId: 'r', parentRunId: null,
      prompt: mandatory ? '修改本章，质量必须通过后才能交付。' : '修改本章。', spec })
    vi.spyOn(originalRequest, 'originalTaskRunIds').mockResolvedValue(['r'])
    const bridge = { fromChapterId: null, sourceRevision: null, targetRevision: 7, committedAt: null }
    const scenes: Array<{ ordinal: number }> = []
    const compilation = { chapter, id: 'comp', chapterId: chapter.id, status: 'active', stage: 'check', bridge, sceneTasks: scenes,
      validation: { independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: 7, findings: [], errorCount: 0, warningCount: 0,
        coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks: scenes, source: null }) },
      preparedContext: { reviewCycle: markReviewCycleVerification(cycle, cycle.transitions.at(-1)!.after) } }
    const start = duplicate ? manuscript.lastIndexOf(text) : manuscript.indexOf(text)
    const warning = { id: 'w', signal: 'description_load', severity: 'warning', disposition: 'pending', authorFeedback: null,
      evidenceExcerpt: text, evidenceHash: sha(text), startOffset: start, endOffset: start + text.length, explanation: '意见', suggestion: '修订' }
    const report = { id: 'current-q', status: 'needs_repair', chapterRevision: 7, findings: [warning],
      deterministicMetrics: { independentCheck: 'complete', contentHash: sha(manuscript), qualityContextHash: 'current-context' } }
    const db = { agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'r' }) }, chapter: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(chapter) }, storyCompilation: { findFirst: vi.fn().mockResolvedValue(compilation), findMany: vi.fn().mockResolvedValue([compilation]) },
      chapterQualityReport: { findFirst: vi.fn().mockResolvedValue(report) } }
    const tx = db as unknown as Prisma.TransactionClient
    const subject = { userId: scope.userId, novelId: scope.novelId, runId: 'r' }
    const proposal = { chapterId: chapter.id, revision: 7, after: manuscript.slice(0, start) + '桌上漆黑一片' + manuscript.slice(warning.endOffset),
      editRanges: [{ start, end: warning.endOffset, newText: '桌上漆黑一片' }] }
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({} as never)
    vi.spyOn(humanity, 'qualityReviewContextHash').mockReturnValue('current-context')
    await currentReviewReadinessFixture(tx, subject, compilation)
    const historicalWarningAdmission = async (input: Pick<typeof proposal, 'after'> & { editRanges?: typeof proposal.editRanges } = proposal) => {
      const current = await readChapterReviewReadiness(tx, subject, compilation.id, { reviewBoundEvidence: true })
      return projectReviewCycleWrite(compilation.preparedContext.reviewCycle, { before: chapter.content, after: input.after,
        ranges: input.editRanges, verificationStarted: true, baselineObligations: [], currentErrorAnchors: [],
        currentRequiredQualityAnchors: current?.qualityPassRequired && current.mustPassPending && warning.severity === 'warning'
          ? current.reviewBoundEvidence!.anchors : [] })
    }
    return { tx, db, subject, chapter, compilation, warning, report, proposal, historicalWarningAdmission }
  }
  it('allows the exact current warning required by the original pass constraint without changing its severity or readiness', async () => {
    const f = await current()
    expect(await readChapterReviewReadiness(f.tx, f.subject)).toMatchObject({ ready: true, mustPassPending: true, qualityPassRequired: true,
      qualityErrorCount: 0, reviewCycle: { verificationStarted: true } })
    expect(await readChapterReviewWriteAdmission(f.tx, f.subject, f.proposal)).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(f.warning.severity).toBe('warning')
    expect(f.report.status).toBe('needs_repair')
  })
  it('uses only the persisted exact occurrence for repeated source evidence, never guessed positions', async () => {
    const f = await current(true, true)
    expect((await readChapterReviewReadiness(f.tx, f.subject))!.reviewCycleFindings![0].anchor).toEqual({ start: f.warning.startOffset,
      end: f.warning.endOffset, text: f.warning.evidenceExcerpt })
    expect(await readChapterReviewWriteAdmission(f.tx, f.subject, f.proposal)).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(await readChapterReviewWriteAdmission(f.tx, f.subject, { ...f.proposal, after: f.chapter.content.replace('灯光落在桌上', '桌上漆黑一片'),
      editRanges: undefined })).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(await f.historicalWarningAdmission({ ...f.proposal, after: f.chapter.content.replace('灯光落在桌上', '桌上漆黑一片'), editRanges: undefined })).toMatchObject({ kind: 'decision_required' })
  })
  it.each(['hash', 'offset', 'fraction', 'empty', 'missing'] as const)('rejects repeated evidence with unproven %s', async invalid => {
    const f = await current(true, true)
    if (invalid === 'hash') f.warning.evidenceHash = '0'.repeat(64)
    else if (invalid === 'offset') { f.warning.startOffset--; f.warning.endOffset-- }
    else if (invalid === 'fraction') f.warning.startOffset += 0.5
    else if (invalid === 'empty') f.warning.endOffset = f.warning.startOffset
    else Reflect.deleteProperty(f.warning, 'evidenceHash')
    expect((await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id, { reviewBoundEvidence: true }))?.reviewBoundEvidence?.anchors).toEqual([])
    expect(await f.historicalWarningAdmission()).toMatchObject({ kind: 'decision_required' })
  })
  it.each(['hash', 'offset'] as const)('does not wash contradictory persisted %s through a unique-quote fallback', async invalid => {
    const f = await current()
    if (invalid === 'hash') f.warning.evidenceHash = '0'.repeat(64)
    else { f.warning.startOffset--; f.warning.endOffset-- }
    expect((await readChapterReviewReadiness(f.tx, f.subject, f.compilation.id, { reviewBoundEvidence: true }))?.reviewBoundEvidence?.anchors).toEqual([])
    expect(await f.historicalWarningAdmission()).toMatchObject({ kind: 'decision_required' })
  })
  it('retains the unique-quote path when an old record has no position/hash proof, and never trusts generic duplicate offsets', async () => {
    const f = await current()
    for (const key of ['startOffset', 'endOffset', 'evidenceHash']) Reflect.deleteProperty(f.warning, key)
    expect(await readChapterReviewWriteAdmission(f.tx, f.subject, f.proposal)).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(reviewCycleFinding({ source: 'quality', reportId: 'q', findingId: 'f', signal: 'description_load', severity: 'warning',
      evidence: '相同句', startOffset: 4, endOffset: 7 }, '相同句。相同句。').anchor).toBeNull()
  })
  it.each(['ordinary', 'advisory', 'failed', 'stale', 'bodyHash', 'repaired'] as const)('keeps original edit authority independent of legacy mandatory repair evidence to %s', async excluded => {
    const f = await current(excluded !== 'ordinary')
    if (excluded === 'advisory') f.warning.severity = 'advisory'
    else if (excluded === 'failed') f.report.deterministicMetrics.independentCheck = 'unavailable'
    else if (excluded === 'stale') f.report.chapterRevision--
    else if (excluded === 'bodyHash') f.report.deterministicMetrics.contentHash = '0'.repeat(64)
    else if (excluded === 'repaired') f.warning.disposition = 'repaired'
    const review = await readChapterReviewReadiness(f.tx, f.subject)
    if (['failed', 'stale', 'bodyHash'].includes(excluded)) expect(review?.ready).toBe(false)
    expect(await f.historicalWarningAdmission()).toMatchObject({ kind: 'decision_required' })
  })
  it('preserves original editing scope while rejecting a stale body proposal', async () => {
    const f = await current()
    for (const at of [f.warning.startOffset, f.warning.endOffset]) {
      expect(await readChapterReviewWriteAdmission(f.tx, f.subject, { ...f.proposal,
        after: f.chapter.content.slice(0, at) + '新增' + f.chapter.content.slice(at), editRanges: [{ start: at, end: at, newText: '新增' }] }))
        .toMatchObject({ kind: 'allow', basis: 'original_writing' })
    }
    expect(await readChapterReviewWriteAdmission(f.tx, f.subject, { ...f.proposal,
      after: f.proposal.after.replace('门锁还在', '门已敞开'), editRanges: undefined })).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    f.db.chapter.findFirst.mockResolvedValueOnce(null)
    await expect(readChapterReviewWriteAdmission(f.tx, f.subject, f.proposal)).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
  })
})
describe('server review cycle lineage and final verification', () => {
  it('permits several original writes before verification, then denies new advice and broad locator overlap', () => {
    const { cycle, body } = revisions()
    const after = body.replace('灯光落在桌上', '灯光照着桌面')
    const input = { before: body, after, baselineObligations: [finding(content)], currentErrorAnchors: [] }
    expect(projectReviewCycleWrite(cycle, { ...input, verificationStarted: false })).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    const verified = markReviewCycleVerification(cycle, { revision: 7, contentHash: reviewCycleContentHash(body) })
    expect(projectReviewCycleWrite(verified, { ...input, verificationStarted: true })).toMatchObject({ kind: 'decision_required' })
    expect(projectReviewCycleWrite(verified, { ...input, verificationStarted: true,
      ranges: [{ start: 0, end: body.length, newText: after }] })).toMatchObject({ kind: 'decision_required' })
    expect(projectReviewCycleWrite(verified, { ...input, after: body + '新审美动作。', verificationStarted: true })).toMatchObject({ kind: 'decision_required' })
    expect(projectReviewCycleWrite(verified, { ...input, after: body, verificationStarted: true })).toMatchObject({ kind: 'allow', basis: 'no_change' })
  })
  it('permits only exact unattempted baseline evidence or current genuine error, never repeated attempts', () => {
    const { cycle, body } = revisions()
    const verified = markReviewCycleVerification(cycle, { revision: 7, contentHash: reviewCycleContentHash(body) })
    const after = body.replace('她没有回答', '她轻轻点头')
    const input = { before: body, after, verificationStarted: true, baselineObligations: [finding(content)], currentErrorAnchors: [] }
    expect(projectReviewCycleWrite(verified, input)).toMatchObject({ kind: 'allow', basis: 'baseline_obligation' })
    const attempted = advanceReviewCycle(verified, { beforeRevision: 7, before: body, afterRevision: 8, after })
    expect(attemptedReviewCycleRefs(attempted)).toEqual([expect.objectContaining({ findingId: 'f4' })])
    const restored = advanceReviewCycle(attempted, { beforeRevision: 8, before: after, afterRevision: 9, after: body })
    expect(projectReviewCycleWrite(restored, input)).toMatchObject({ kind: 'decision_required' })
    const start = body.indexOf('灯光落在桌上'), text = '灯光落在桌上'
    expect(projectReviewCycleWrite(verified, { ...input, after: body.replace(text, '桌上没有灯光'),
      currentErrorAnchors: [{ start, end: start + text.length, text }] })).toMatchObject({ kind: 'allow', basis: 'current_error' })
    expect(projectReviewCycleWrite(verified, { ...input, baselineObligations: [{ ...finding(content), reportId: 'foreign' }] })).toMatchObject({ kind: 'decision_required' })
  })
  it('keeps mandatory warning evidence separate from errors and denies a hull across two proof anchors', () => {
    const { cycle, body } = revisions()
    const verified = markReviewCycleVerification(cycle, { revision: 7, contentHash: reviewCycleContentHash(body) })
    const text = '灯光落在桌上', start = body.indexOf(text), end = start + text.length
    const input = { before: body, after: body.replace(text, '灯光照着桌面'), verificationStarted: true,
      baselineObligations: [], currentErrorAnchors: [], currentRequiredQualityAnchors: [{ start, end, text }] }
    expect(projectReviewCycleWrite(verified, input)).toMatchObject({ kind: 'allow', basis: 'current_required_quality' })
    expect(projectReviewCycleWrite(verified, { ...input, currentRequiredQualityAnchors: undefined })).toMatchObject({ kind: 'decision_required' })
    const second = '她没有回答', secondStart = body.indexOf(second)
    expect(projectReviewCycleWrite(verified, { ...input, after: body.slice(0, start) + '合并修改' + body.slice(secondStart + second.length),
      currentRequiredQualityAnchors: [...input.currentRequiredQualityAnchors, { start: secondStart, end: secondStart + second.length, text: second }] }))
      .toMatchObject({ kind: 'decision_required' })
    expect(readReviewCycle(JSON.parse(JSON.stringify({ reviewCycle: verified })), scope)).toEqual(verified)
  })
  it('infers old v1 verification only from actual CAS-bound saved assessment and preserves the evidence across restart', () => {
    const { cycle, body } = revisions()
    const validation = { independentCheck: 'unavailable', checkedRevision: 7, coverage: { contentHash: reviewCycleContentHash(body) } }
    expect(observedReviewCycleVerification(cycle, validation, null, { revision: 7, content: body })).toBe(true)
    expect(observedReviewCycleVerification(cycle, { ...validation, checkedRevision: 99 }, null, { revision: 7, content: body })).toBe(false)
    expect(observedReviewCycleVerification(cycle, { ...validation, coverage: { contentHash: '0'.repeat(64) } }, null, { revision: 7, content: body })).toBe(false)
    const evidence = observedReviewCycleVerificationBody(cycle, validation, null, { revision: 7, content: body })
    expect(evidence).toBeTruthy()
    const copied = readReviewCycle(JSON.parse(JSON.stringify({ reviewCycle: markReviewCycleVerification(cycle, evidence || cycle.transitions[2].after) })), scope)!
    expect(observedReviewCycleVerification(copied, null, null, { revision: 7, content: body })).toBe(true)
    const external = body + '作者外部输入。', gap = advanceReviewCycle(copied, { beforeRevision: 8, before: external, afterRevision: 9, after: external + '额外段落。' })
    expect(projectReviewCycleWrite(gap, { before: external + '额外段落。', after: external.replace('她没有回答', '她点头') + '额外段落。',
      verificationStarted: true, baselineObligations: [finding(content)], currentErrorAnchors: [] })).toMatchObject({ kind: 'decision_required' })
  })
  it('defer predicate excludes errors, mandatory pass, empty candidates and initial assessment', () => {
    const ready = { reviewCycle: { edited: true }, mustPassPending: false, qualityPassRequired: false }
    expect(verificationQualityAdviceRequiresDecision(ready, [{ severity: 'advisory' }, { severity: 'warning' }])).toBe(true)
    expect(verificationQualityAdviceRequiresDecision(ready, [{ severity: 'error' }])).toBe(false)
    expect(verificationQualityAdviceRequiresDecision({ ...ready, qualityPassRequired: true }, [{ severity: 'warning' }])).toBe(false)
    expect(verificationQualityAdviceRequiresDecision({ ...ready, mustPassPending: true }, [{ severity: 'warning' }])).toBe(false)
    expect(verificationQualityAdviceRequiresDecision(ready, [])).toBe(false)
    expect(verificationQualityAdviceRequiresDecision(null, [{ severity: 'advisory' }])).toBe(false)
  })
  it('records real r4 to r6 to r7 edits without a rounds limit or rebinding the initial reports', () => {
    const { cycle, body } = revisions()
    expect(cycle.baseline).toEqual(baseline().baseline)
    expect(cycle.transitions.map(step => step.after.revision)).toEqual([5, 6, 7])
    const step = projectReviewCycle(cycle, { revision: 7, contentHash: reviewCycleContentHash(body), ready: false, pending: true, findings: [] })
    expect(step).toMatchObject({ phase: 'verification', edited: true, transitionCount: 3, baselineRevision: 4 })
  })
  it('recognizes the same uniquely anchored issue despite different report IDs and rephrased commentary', () => {
    const { cycle, body } = revisions()
    const current = finding(body, '她没有回答', 'rephrased-r7')
    expect(projectReviewCycle(cycle, { revision: 7, contentHash: reviewCycleContentHash(body), ready: true, pending: true,
      findings: [current] }).findings).toEqual([{ source: 'quality', reportId: current.reportId, findingId: current.findingId,
      relation: 'same_issue', baselineRef: { source: 'quality', reportId: 'qf4', findingId: 'f4' } }])
  })
  it('marks a genuine escalation of the same issue as regression, never auto-resolves a new error', () => {
    const { cycle, body } = revisions()
    const result = projectReviewCycle(cycle, { revision: 7, contentHash: reviewCycleContentHash(body), ready: true, pending: true,
      findings: [finding(body, '她没有回答', 'severe', 'error'), finding(body, '灯光落在桌上', 'new-error', 'error')] })
    expect(result.findings.map(item => item.relation)).toEqual(['regression', 'unknown'])
    expect(result.phase).toBe('verification')
  })
  it('requires explicit current retain or regression decisions for fresh final stylistic advice', () => {
    const { cycle, body } = revisions(), current = finding(body, '灯光落在桌上', 'new-r7')
    const projected = projectReviewCycle(cycle, { revision: 7, contentHash: reviewCycleContentHash(body), ready: true, pending: true, findings: [current] })
    expect(projected.findings[0].relation).toBe('new_advisory')
    const readiness: ChapterReviewReadiness = { ready: true, checksRequired: true, compilationId: 'comp', chapterId: 'c', revision: 7,
      continuity: 'complete', quality: 'complete', continuityErrorCount: 0, qualityErrorCount: 0, qualityReportId: current.reportId,
      requiredTools: [], decisionPending: true, requiredDecisions: [current], reviewCycle: projected }
    const step = projectCurrentReviewNextStep(readiness)!
    expect(step.state).toBe('decision_required')
    expect(step.pending[0]).toEqual(current)
    expect(currentReviewNextStepGuidance(step)).toContain('留置不是修复，也不是检查通过')
    expect(projectCurrentReviewNextStep({ ...readiness, mustPassPending: true })!.state).toBe('must_pass_required')
    expect(projectCurrentReviewNextStep({ ...readiness, ready: false, quality: 'incomplete', requiredTools: [{ name: 'quality_analyze', args: { compilationId: 'comp' } }] })!.state).toBe('check_required')
  })
  it('keeps edited anchors or ambiguous duplicates unknown rather than inventing a match', () => {
    const cycle = advanceReviewCycle(baseline(), { beforeRevision: 4, before: content, afterRevision: 5, after: content.replace('她没有回答', '她轻轻点头') })
    const body = content.replace('她没有回答', '她轻轻点头')
    expect(projectReviewCycle(cycle, { revision: 5, contentHash: reviewCycleContentHash(body), ready: true, pending: true,
      findings: [finding(body, '她轻轻点头')] }).findings[0].relation).toBe('unknown')
    expect(finding('她没有回答。她没有回答。').anchor).toBeNull()
  })
  it('leaves a no-op unchanged and rejects a nonexistent or concurrent transition', () => {
    const cycle = baseline()
    expect(advanceReviewCycle(cycle, { beforeRevision: 4, before: content, afterRevision: 4, after: content })).toBe(cycle)
    const external = '外部作者改了原文。' + content
    const gap = advanceReviewCycle(cycle, { beforeRevision: 5, before: external, afterRevision: 6, after: external + '灯灭了。' })
    expect(gap.transitions[0].contiguous).toBe(false)
    expect(projectReviewCycle(gap, { revision: 6, contentHash: reviewCycleContentHash(external + '灯灭了。'), ready: true, pending: true,
      findings: [finding(external + '灯灭了。')] }).findings[0].relation).toBe('unknown')
    expect(readReviewCycle({ reviewCycle: gap }, scope)).toEqual(gap)
    expect(() => advanceReviewCycle(cycle, { beforeRevision: 4, before: content, afterRevision: 6, after: content + '灯灭了。' })).toThrow()
    expect(() => advanceReviewCycle(cycle, { beforeRevision: 4, before: content, afterRevision: 5, after: content + '灯灭了。',
      ranges: [{ start: 0, end: 1, newText: '无关' }] })).toThrow()
  })
  it('survives restart/reprepare serialization, rejects foreign or broken history, and never reconstructs old missing proof', () => {
    const { cycle, body } = revisions()
    const persisted = JSON.parse(JSON.stringify({ reviewCycle: cycle, other: true }))
    expect(readReviewCycle(persisted, scope)).toEqual(cycle)
    expect(readReviewCycle({}, scope)).toBeNull()
    expect(() => readReviewCycle(persisted, { ...scope, taskId: 'other' })).toThrow()
    persisted.reviewCycle.transitions[1].before.revision++
    expect(() => readReviewCycle(persisted, scope)).toThrow()
    expect(projectReviewCycle(null, { revision: 7, contentHash: reviewCycleContentHash(body), ready: false, pending: false, findings: [] }))
      .toMatchObject({ phase: 'assessment', edited: false, baselineRevision: null })
  })
  it('projects the same coordination phase for legacy and durable without changing frozen obligations', () => {
    const base: ChapterReviewReadiness = { ready: true, checksRequired: true, compilationId: 'comp', chapterId: 'c', revision: 4,
      continuity: 'complete', quality: 'complete', continuityErrorCount: 0, qualityErrorCount: 0, qualityReportId: 'q', requiredTools: [],
      decisionPending: true, requiredDecisions: [finding(content)] }
    const legacy = projectCurrentReviewNextStep(base)!, durable = projectCurrentReviewNextStep({ ...base, reviewProtocol: 1 })!
    const { decisionBatchesAvailable: legacyBatches, ...legacyCoordination } = legacy
    const { decisionBatchesAvailable: durableBatches, ...durableCoordination } = durable
    expect(legacyCoordination).toEqual(durableCoordination)
    expect(legacyBatches).toBe(false)
    expect(durableBatches).toBe(true)
    expect(base.reviewProtocol).toBeUndefined()
    expect(projectCurrentReviewNextStep({ ...base, decisionPending: false })!.phase).toBe('resolution')
  })
  it('does not capture incomplete assessments as a baseline', () => {
    expect(() => beginReviewCycle(scope, { compilationId: 'comp', revision: 4, content, ready: false,
      binding: baseline().baseline!.binding, required: { continuity: true, quality: true }, findings: [] })).toThrow()
  })
})

describe('quality report binding hash version compatibility', () => {
  it('retains old unversioned binding bytes while preserving explicit version2', () => {
    const old = baseline(), before = JSON.stringify(old)
    expect(readReviewCycle({ reviewCycle: old }, scope)).toEqual(old)
    expect(JSON.stringify(old)).toBe(before)
    const current = structuredClone(old); current.baseline!.binding.qualityReportHashVersion = 2
    expect(readReviewCycle({ reviewCycle: current }, scope)?.baseline?.binding).toEqual(current.baseline!.binding)
  })
  it('rejects an unknown stored hash version instead of treating it as legacy', () => {
    const cycle = baseline()
    Object.assign(cycle.baseline!.binding, { qualityReportHashVersion: 3 })
    expect(() => readReviewCycle({ reviewCycle: cycle }, scope)).toThrowError(expect.objectContaining({ code: 'REVIEW_CYCLE_CONFLICT' }))
  })
})