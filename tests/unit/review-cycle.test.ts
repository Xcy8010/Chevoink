import { describe, expect, it } from 'vitest'
import { advanceReviewCycle, beginReviewCycle, projectReviewCycle, readReviewCycle, reviewCycleContentHash, reviewCycleFinding, verificationQualityAdviceRequiresDecision } from '../../api/lib/agent/review-cycle.js'
import { currentReviewNextStepGuidance, projectCurrentReviewNextStep } from '../../api/lib/agent/review-dispatch.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

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
describe('server review cycle lineage and final verification', () => {
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
    expect(currentReviewNextStepGuidance(step)).toContain('不能因每次完整检查又有新措辞就自动开启下一轮润色')
    expect(projectCurrentReviewNextStep({ ...readiness, mustPassPending: true })!.state).toBe('must_pass_required')
    expect(projectCurrentReviewNextStep({ ...readiness, ready: false, quality: 'incomplete', requiredTools: [{ name: 'quality_analyze', args: { compilationId: 'comp' } }] })!.state).toBe('blocked')
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
    expect(legacy).toEqual(durable)
    expect(base.reviewProtocol).toBeUndefined()
    expect(projectCurrentReviewNextStep({ ...base, decisionPending: false })!.phase).toBe('resolution')
  })
  it('does not capture incomplete assessments as a baseline', () => {
    expect(() => beginReviewCycle(scope, { compilationId: 'comp', revision: 4, content, ready: false,
      binding: baseline().baseline!.binding, required: { continuity: true, quality: true }, findings: [] })).toThrow()
  })
})
