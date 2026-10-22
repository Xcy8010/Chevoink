import { expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { terminalProcessingPlan } from '../../api/lib/agent/terminal-processing.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

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
