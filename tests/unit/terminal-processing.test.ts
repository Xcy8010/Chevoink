import { expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { terminalProcessingExhaustedMessage, terminalProcessingPhaseGapMessage, terminalProcessingPlan } from '../../api/lib/agent/terminal-processing.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { projectCurrentReviewNextStep } from '../../api/lib/agent/review-dispatch.js'

function fixture() {
  const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', chapterId: 'chapter', prompt: '修改本章' })
  taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 6, chapterId: 'chapter' }], titleAndBodyOnly: false, repairAuthorized: true }
  const subject = { userId: 'owner', novelId: 'novel', taskSpec }, content = 'The packet remains on the desk.'
  const review: ChapterReviewReadiness = { ready: false, checksRequired: true, compilationId: 'compiler', chapterId: 'chapter', revision: 8,
    continuity: 'incomplete', quality: 'complete', continuityErrorCount: 0, qualityErrorCount: 0, qualityReportId: 'quality',
    requiredTools: [{ name: 'continuity_validate', args: { compilationId: 'compiler' } }],
    terminalReview: { state: 'unverified', unresolved: [] },
    progressEvidence: { taskId: taskSpec.id, userId: 'owner', novelId: 'novel', chapterId: 'chapter', orderIndex: 6,
      contentHash: runtimeJson({ content }).hash, phases: [] },
    terminalProcessing: { contractHash: runtimeJson(JSON.parse(JSON.stringify(taskSpec))).hash, sourceHash: runtimeJson({ previous: 'A request was issued.' }).hash,
      candidate: terminalCandidateSchema.parse({ exitState: { objects: ['The packet was archived.'] } }),
      content, previous: 'A request was issued.', inherited: [], issues: [{ path: 'exitState.objects.0', reason: 'inheritance_invalid' }] } }
  return { subject, review }
}

it('reports the exact unresolved current fact without inventing a missing main-model fee cap', () => {
  const { review } = fixture()
  review.terminalReview = { state: 'unverified', currentResultVerified: true, unresolved: [
    { path: 'exitState.objects.0', verdict: 'unknown', claim: 'The sensor has been repaired.', reason: 'The current body still shows it offline.' },
  ] }
  const before = JSON.stringify(review), message = terminalProcessingPhaseGapMessage(review)
  expect(message).toContain('第6章（版本8）：当前终态复核结果已收到，仍有1项未获证实')
  expect(message).toContain('The sensor has been repaired.')
  expect(message).toContain('The current body still shows it offline.')
  expect(message).not.toContain('授权与费用上限')
  expect(JSON.stringify(review)).toBe(before)
  review.terminalReview.currentResultVerified = false
  expect(terminalProcessingPhaseGapMessage(review)).toContain('当前报告尚不能认证为完整结果')
})

it('prepares current source and candidate once per bounded processing proposal, without claiming progress or success', () => {
  const { subject, review } = fixture(), attempts = new Set<string>(), before = JSON.stringify(review)
  const first = terminalProcessingPlan(review, subject, attempts)!
  expect(first.guidance).toContain(review.terminalProcessing!.content)
  expect(first.guidance).toContain(review.terminalProcessing!.previous)
  expect(first.guidance).toContain('baseCandidateHash')
  attempts.add(first.claim!)
  const second = terminalProcessingPlan(review, subject, attempts)!
  expect(second.key).toBe(first.key)
  expect(second.claim).not.toBe(first.claim)
  attempts.add(second.claim!)
  expect(terminalProcessingPlan(review, subject, attempts)?.claim).toBeUndefined()
  expect(JSON.stringify(review)).toBe(before)
})

it('does not refill on new candidates, report IDs, revision-only changes, serialized restart or old slot history', () => {
  const { subject, review } = fixture(), attempts = new Set<string>(['old-attempt']), first = terminalProcessingPlan(review, subject, attempts)!
  attempts.add(first.claim!)
  review.revision++
  review.compilationId = 'replacement-report'
  review.terminalProcessing!.candidate.exitState.objects[0] = 'A differently worded candidate.'
  const second = terminalProcessingPlan(review, subject, new Set(JSON.parse(JSON.stringify([...attempts]))))!
  expect(second.key).toBe(first.key)
  attempts.add(second.claim!)
  expect(terminalProcessingPlan(review, subject, attempts)?.claim).toBeUndefined()
  expect(attempts.has('old-attempt')).toBe(true)
})

it.each(['owner', 'novel', 'task', 'chapter', 'scope', 'body', 'contract', 'supported', 'no-evidence'] as const)('rejects invalid processing scope or evidence: %s', change => {
  const { subject, review } = fixture()
  if (change === 'owner') subject.userId = 'other'
  if (change === 'novel') subject.novelId = 'other'
  if (change === 'task') review.progressEvidence!.taskId = 'other'
  if (change === 'chapter') review.chapterId = 'other'
  if (change === 'scope') subject.taskSpec.writingPacing = 'proposal_only'
  if (change === 'body') review.terminalProcessing!.content += ' changed'
  if (change === 'contract') review.terminalProcessing!.contractHash = 'invalid'
  if (change === 'supported') review.terminalReview!.state = 'supported'
  if (change === 'no-evidence') review.terminalProcessing = undefined
  expect(terminalProcessingPlan(review, subject, new Set())).toBeNull()
})

it('schedules actual commit once only after current checks and decisions are ready, independent of old progress signatures', () => {
  const { subject, review } = fixture()
  review.ready = true
  review.continuity = 'complete'
  review.requiredTools = []
  review.terminalReview!.state = 'supported'
  review.terminalProcessing!.issues = []
  const attempts = new Set<string>(), plan = terminalProcessingPlan(review, subject, attempts)!
  expect(plan.kind).toBe('commit')
  attempts.add(plan.claim!)
  expect(terminalProcessingPlan(review, subject, attempts)?.claim).toBeUndefined()
  review.decisionPending = true
  expect(terminalProcessingPlan(review, subject, new Set())).toBeNull()
  review.decisionPending = false
  review.terminalCommitted = true
  expect(terminalProcessingPlan(review, subject, new Set())).toBeNull()
})

it('commits delivery-eligible current state without refilling exhausted processing claims and keeps all readiness gates', () => {
  const { subject, review } = fixture(), attempts = new Set<string>()
  attempts.add(terminalProcessingPlan(review, subject, attempts)!.claim!)
  attempts.add(terminalProcessingPlan(review, subject, attempts)!.claim!)
  const occupied = [...attempts]
  review.ready = true
  review.continuity = 'complete'
  review.terminalReview!.deliveryEligible = true
  expect(terminalProcessingPlan(review, subject, attempts)?.kind).toBe('commit')
  for (const gate of ['ready', 'mustPassPending', 'decisionPending', 'owner'] as const) {
    const next = structuredClone(review)
    if (gate === 'ready') next.ready = false
    if (gate === 'mustPassPending') next.mustPassPending = true
    if (gate === 'decisionPending') next.decisionPending = true
    if (gate === 'owner') next.progressEvidence!.userId = 'other'
    expect(terminalProcessingPlan(next, subject, attempts)).toBeNull()
    if (gate === 'decisionPending') expect(projectCurrentReviewNextStep(next).state).toBe('decision_required')
  }
  expect([...attempts]).toEqual(occupied)
})

it('describes verified unknown results only after both current processing claims are occupied, without side effects', () => {
  const { subject, review } = fixture(), attempts = new Set<string>()
  review.terminalReview = { state: 'unverified', currentResultVerified: true,
    unresolved: Array.from({ length: 10 }, (_, index) => ({ path: `proposals.synthetic-${index}`, verdict: 'unknown',
      field: 'knowledge', claim: `Synthetic unresolved assertion ${index}`, reason: 'The current body does not establish this assertion.' })) }
  expect(terminalProcessingExhaustedMessage(review, terminalProcessingPlan(review, subject, attempts))).toBeNull()
  attempts.add(terminalProcessingPlan(review, subject, attempts)!.claim!)
  expect(terminalProcessingExhaustedMessage(review, terminalProcessingPlan(review, subject, attempts))).toBeNull()
  attempts.add(terminalProcessingPlan(review, subject, attempts)!.claim!)
  const before = JSON.stringify({ review, attempts: [...attempts] }), plan = terminalProcessingPlan(review, subject, attempts)
  const message = terminalProcessingExhaustedMessage(review, plan)!
  expect(message).toMatch(/^第6章（版本8）：/u)
  expect(message).toContain('当前终态复核结果已收到，仍有10项未获证实')
  expect(message).toContain('自动候选处理名额已占用，任务保持暂停')
  expect(message).toContain('Synthetic unresolved assertion 0')
  expect(message).toContain('The current body does not establish this assertion.')
  expect(message).not.toContain('Synthetic unresolved assertion 3')
  expect(message).not.toMatch(/未取得有效独立结果|两次.*完成|再次.*继续|proposals\.|terminal-processing:|knowledge/u)
  expect(JSON.stringify({ review, attempts: [...attempts] })).toBe(before)
  for (const verified of [false, undefined]) {
    review.terminalReview.currentResultVerified = verified
    const unavailable = terminalProcessingExhaustedMessage(review, plan)!
    expect(unavailable).toContain('当前终态复核报告不可验证')
    expect(unavailable).not.toContain('结果已收到')
    expect(unavailable).not.toContain('Synthetic unresolved assertion')
  }
  expect(terminalProcessingExhaustedMessage(review, null)).toBeNull()
})
