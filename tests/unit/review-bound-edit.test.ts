import { afterEach, describe, expect, it, vi } from 'vitest'
import { freezeLocalEditBoundary, localEditGuidance, originalLocalEditBoundary } from '../../api/lib/agent/local-edit-scope.js'
import { reviewBoundEditAllowed, projectReviewBoundEditPlan, unprovenReviewBoundPatchIndexes, type ReviewBoundEvidence } from '../../api/lib/agent/review-bound-edit.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { taskSpecSchema, type TaskSpec } from '../../shared/contracts/task-spec-contracts.js'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'
import { frozenWritingRevisionAuthority } from '../../api/lib/agent/writing-scope.js'
import { readChapterReviewRevisionGuidance, type ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { projectCurrentReviewNextStep, currentReviewNextStepGuidance } from '../../api/lib/agent/review-dispatch.js'

const prompt = '读取第4章当前正文并完成本章检查和提交，不续写，不修改第1至3章。先做连续性和人类感检查；如有确证问题，只对本章必要位置做局部修订并复检，其他保持。'
const body = '门边有灯。她向左转，另一人向右转。门仍关着。'
const chapter = { id: 'four', revision: 7, content: body }
const hash = (content: string) => runtimeJson({ content }).hash
afterEach(() => vi.restoreAllMocks())
function fixture() {
  const writing = { version: 1 as const, kind: 'bounded' as const, targets: [{ orderIndex: 4, chapterId: chapter.id }], titleAndBodyOnly: false, repairAuthorized: false }
  const boundary = freezeLocalEditBoundary(prompt, writing, [chapter], 2)
  expect(boundary?.version).toBe(3)
  if (boundary?.version !== 3) throw Error('Missing conditional policy')
  const start = body.indexOf('向左转'), text = '向左转'
  const evidence: ReviewBoundEvidence = { contentHash: hash(body), cycle: null, anchors: [{ start, end: start + text.length, text,
    source: 'quality', reportId: 'current-report', findingId: 'actual-finding' }] }
  const range = { start, end: start + text.length, newText: '向右转' }
  return { boundary, evidence, range, after: body.replace('向左转', '向右转') }
}
describe('finding-conditioned local repair effects', () => {
  function ready(evidence: ReviewBoundEvidence): ChapterReviewReadiness {
    return { ready: true, checksRequired: true, compilationId: 'compilation', chapterId: chapter.id, revision: chapter.revision,
      continuity: 'complete', quality: 'complete', continuityErrorCount: 0, qualityErrorCount: 0, qualityReportId: 'current-report',
      requiredTools: [], reviewBoundEvidence: evidence, selectionOnly: true }
  }
  it('projects missing checks before any conditional manuscript proposal can execute', () => {
    const f = fixture(), review = ready(f.evidence)
    review.ready = false; review.quality = 'missing'; review.requiredTools = [{ name: 'quality_analyze', args: { compilationId: review.compilationId } }]
    const plan = projectReviewBoundEditPlan(f.boundary, chapter, review, { after: f.after, ranges: [f.range] })
    expect(plan.state).toBe('checks_required')
    expect(plan.requiredTools).toEqual(review.requiredTools)
    expect(plan.guidance).toContain('quality_analyze')
    expect(review.quality).toBe('missing')
  })
  it('projects the same exact evidence boundary for presentation and mixed-batch admission', () => {
    const f = fixture(), review = ready(f.evidence)
    const plan = projectReviewBoundEditPlan(f.boundary, chapter, review,
      { after: f.after, ranges: [f.range, { start: 0, end: 1, newText: '另' }] })
    expect(plan.state).toBe('proposal_outside_evidence')
    expect(plan.unprovenPatchIndexes).toEqual([1])
    expect(plan.anchors).toEqual(f.evidence.anchors)
    expect(plan.guidance).toContain('第2项')
    expect(projectReviewBoundEditPlan(f.boundary, chapter, review, { after: f.after, ranges: [f.range] }).state).toBe('findings_available')
  })
  it.each(['missing', 'wrong-revision', 'wrong-chapter', 'wrong-hash'])(
    'does not advertise edit evidence from %s review state', scenario => {
      const f = fixture(), review = ready(f.evidence)
      if (scenario === 'wrong-revision') review.revision++
      if (scenario === 'wrong-chapter') review.chapterId = 'prior'
      if (scenario === 'wrong-hash') review.reviewBoundEvidence!.contentHash = '0'.repeat(64)
      expect(projectReviewBoundEditPlan(f.boundary, chapter, scenario === 'missing' ? null : review).state).toBe('unavailable')
    })
  it('projects no findings as keep-body, never as a new selection or broad manual repair grant', () => {
    const f = fixture(), review = ready({ ...f.evidence, anchors: [] })
    const plan = projectReviewBoundEditPlan(f.boundary, chapter, review)
    expect(plan.state).toBe('no_proven_findings')
    expect(plan.anchors).toEqual([])
    const guidance = currentReviewNextStepGuidance(projectCurrentReviewNextStep({ ...review, reviewBoundPlan: plan, decisionPending: true }))
    expect(guidance).not.toContain('未明确定位则先请作者补准确原文')
    expect(guidance).toContain('保持正文')
  })
  it('keeps completed manuscript checks distinct from unsupported terminal claims and from edit anchors', () => {
    const f = fixture(), review = ready({ ...f.evidence, anchors: [] })
    review.terminalReview = { state: 'unverified', unresolved: [{ path: 'exitState.emotion.0', verdict: 'unknown' }] }
    const step = projectCurrentReviewNextStep(review)
    expect(step.state).toBe('terminal_review_required')
    expect(step.requiredTools).toEqual([])
    expect(currentReviewNextStepGuidance(step)).toContain('exitState.emotion.0')
    expect(currentReviewNextStepGuidance(step)).toContain('不是正文问题')
    expect(projectReviewBoundEditPlan(f.boundary, chapter, review).anchors).toEqual([])
    review.ready = false; review.quality = 'incomplete'; review.requiredTools = [{ name: 'quality_analyze', args: { compilationId: review.compilationId } }]
    expect(projectCurrentReviewNextStep(review).state).toBe('blocked')
  })
  it('identifies the unproven patch without authorizing any part of a rejected batch', () => {
    const f = fixture(), ranges = [f.range, { start: 0, end: 1, newText: '窗' }]
    expect(unprovenReviewBoundPatchIndexes(body, f.evidence, ranges)).toEqual([1])
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after, ranges)).toBe(false)
    expect(unprovenReviewBoundPatchIndexes(body, f.evidence, [f.range])).toEqual([])
  })
  function frozenSpec() {
    const f = fixture()
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, localEditProtocol: 1 })
    spec.scope = { ...spec.scope, writingTargetProtocol: 2, localEditBoundary: f.boundary,
      writing: { version: 1, kind: 'bounded', targets: [{ orderIndex: 4, chapterId: chapter.id }], titleAndBodyOnly: false, repairAuthorized: false },
      writingInterpretation: { version: 2, requestHash: f.boundary.source.requestHash, scopeHash: '0'.repeat(64), intent: 'revise', reasons: [],
        revisionDenied: false, creationDenied: true, excludedChapterIds: [], operations: [
          ...f.boundary.source.reviews.map(span => ({ ...span, kind: 'review' as const, polarity: 'affirmative' as const })),
          ...f.boundary.source.repairs.map(({ start, end }) => ({ start, end, kind: 'revise' as const, polarity: 'affirmative' as const })),
        ] } }
    spec.scope.writingInterpretation!.scopeHash = frozenWritingScopeHash(spec.scope)
    return spec
  }
  it('keeps conditional guidance separate from unqualified manual and automatic repair authority', async () => {
    const spec = frozenSpec()
    expect(originalLocalEditBoundary(spec)?.version).toBe(3)
    expect(frozenWritingRevisionAuthority(spec, chapter.id)).toBe(false)
    expect(original.originalRepairAuthority({ prompt, spec })).toBe(false)
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt, spec, taskId: spec.id, sourceRunId: 'r', parentRunId: null })
    expect(await readChapterReviewRevisionGuidance({} as Prisma.TransactionClient, { userId: 'u', novelId: 'n', runId: 'r' }, chapter))
      .toBe(localEditGuidance(spec))
  })
  it.each(['broad-repair', 'different-request', 'unknown-target', 'missing-review', 'condition-after-repair'])(
    'rejects a malformed conditional contract instead of granting broad authority: %s', scenario => {
      const spec = frozenSpec(), local = spec.scope.localEditBoundary
      if (local?.version !== 3) throw Error('Missing policy')
      if (scenario === 'broad-repair') spec.scope.writing!.repairAuthorized = true
      if (scenario === 'different-request') local.source.requestHash = 'f'.repeat(64)
      if (scenario === 'unknown-target') local.regions[0].chapterId = 'another'
      if (scenario === 'missing-review') local.source.reviews = []
      if (scenario === 'condition-after-repair') local.source.repairs[0].condition.end = local.source.repairs[0].end + 1
      expect(taskSpecSchema.safeParse(spec).success).toBe(false)
      expect(() => originalLocalEditBoundary(spec)).toThrow()
    })
  it('freezes an executable review phase without a guessed edit quote or broad repair authority', () => {
    const f = fixture()
    expect(f.boundary).toMatchObject({ kind: 'review_bound', regions: [{ chapterId: 'four', revision: 7, contentHash: hash(body), end: body.length }] })
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after, [f.range])).toBe(true)
  })
  it.each(['no-findings', 'wrong-hash', 'wrong-chapter', 'outside', 'cross-gap', 'whole', 'growth', 'wrong-effect', 'overlap', 'edge-insert'])(
    'denies %s without widening the admission baseline', scenario => {
      const f = fixture(), current = { ...chapter }
      let ranges = [f.range], after = f.after
      if (scenario === 'no-findings') f.evidence.anchors = []
      if (scenario === 'wrong-hash') f.evidence.contentHash = hash('different')
      if (scenario === 'wrong-chapter') current.id = 'prior'
      if (scenario === 'outside') ranges = [{ start: 0, end: 1, newText: '窗' }]
      if (scenario === 'cross-gap') ranges = [{ ...f.range, end: body.length - 1 }]
      if (scenario === 'whole') ranges = [{ start: 0, end: body.length, newText: '新全文' }]
      if (scenario === 'growth') { ranges = [{ ...f.range, newText: '过量'.repeat(60) }]; after = body.slice(0, f.range.start) + ranges[0].newText + body.slice(f.range.end) }
      if (scenario === 'wrong-effect') after += '其他文字'
      if (scenario === 'overlap') ranges.push({ ...f.range })
      if (scenario === 'edge-insert') ranges = [{ start: f.range.start, end: f.range.start, newText: '请' }]
      expect(reviewBoundEditAllowed(f.boundary, current, f.evidence, after, ranges)).toBe(false)
    })
  it('preserves independent gaps and every original protected quote', () => {
    const f = fixture()
    f.boundary.regions[0].protectedText = ['向左转']
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after, [f.range])).toBe(false)
    f.boundary.regions[0].protectedText = ['门仍关着']
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after, [f.range])).toBe(true)
  })
  it('accepts adjacent independent net patches inside a proven span, without accepting a whole-body evidence anchor', () => {
    const f = fixture()
    const ranges = [{ start: f.range.start, end: f.range.start + 1, newText: '朝' }, { start: f.range.start + 1, end: f.range.start + 2, newText: '右' }]
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, body.replace('向左转', '朝右转'), ranges)).toBe(true)
    f.evidence.anchors = [{ ...f.evidence.anchors[0], start: 0, end: body.length, text: body }]
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after, [f.range])).toBe(false)
  })
  it('permits two independently proven islands while preserving the exact gap', () => {
    const f = fixture(), text = '向右转', start = body.indexOf(text)
    f.evidence.anchors.push({ ...f.evidence.anchors[0], start, end: start + text.length, text, findingId: 'second' })
    const second = { start, end: start + text.length, newText: '往右转' }
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after.replace('另一人向右转', '另一人往右转'), [f.range, second])).toBe(true)
    expect(reviewBoundEditAllowed(f.boundary, chapter, f.evidence, f.after, [{ ...f.range, end: second.end }])).toBe(false)
  })
  it('cannot adopt an external revision or reset its initial length ceiling using a fresh report', () => {
    const f = fixture(), current = { ...chapter, revision: 8 }
    expect(reviewBoundEditAllowed(f.boundary, current, f.evidence, f.after, [f.range])).toBe(false)
    current.content = body.replace('门边', '窗边')
    f.evidence.contentHash = hash(current.content)
    f.evidence.cycle = { version: 1, scope: { taskId: 't', userId: 'u', novelId: 'n', chapterId: chapter.id }, baseline: null,
      transitions: [{ contiguous: true, before: { revision: 7, contentHash: hash(body) }, after: { revision: 8, contentHash: hash(current.content) }, ranges: [{ start: 0, end: 1, newLength: 1 }] }] }
    expect(reviewBoundEditAllowed(f.boundary, current, f.evidence, f.after.replace('门边', '窗边'), [f.range])).toBe(true)
    f.evidence.cycle.transitions[0].contiguous = false
    expect(reviewBoundEditAllowed(f.boundary, current, f.evidence, f.after, [f.range])).toBe(false)
  })
  it.each(['检查第4章是否需要局部修订', '读取第4章。如有问题，先问我是否局部修订本章', '读取第4章并检查。收到批准后局部修订本章'])(
    'does not turn assessment or approval-dependent wording into an executable conditional policy: %s', request => {
      const f = fixture()
      const writing: TaskSpec['scope']['writing'] = { version: 1, kind: 'bounded', targets: [{ orderIndex: 4, chapterId: chapter.id }], titleAndBodyOnly: false, repairAuthorized: false }
      expect(freezeLocalEditBoundary(request, writing, [chapter], 2)?.version).not.toBe(3)
      expect(f.boundary.version).toBe(3)
    })
})
