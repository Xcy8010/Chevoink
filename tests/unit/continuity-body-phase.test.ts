import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
import { reviewContinuity } from '../../api/lib/agent/continuity-review.js'
import { legacyContinuityAssessmentKey } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { continuitySubjectIdentity, continuityWorkSubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as recovery from '../../api/lib/agent/review-request-recovery.js'
import { currentContinuityRunnerFixture } from '../helpers/current-continuity-runner-fixture.js'

afterEach(() => vi.restoreAllMocks())

// Frozen subject hashes remain an audit reader. They do not decide whether an
// ordinary current report may run, write or submit another manuscript revision.
describe('current body reports replace the retired phase court', () => {
  it('preserves candidate hashes and keeps historical absent/empty candidate identities distinct', () => {
    const current = { id: 'chapter', revision: 4, orderIndex: 1, contentHash: runtimeJson({ content: '原文' }).hash }
    const context = { protocol: 2 as const, verdictProtocol: 6 as const, current, previous: null,
      factCoverage: { version: 2 as const, taskId: 'task', chapterId: 'chapter', obligations: [] } }
    const base = { chapterId: current.id, revision: current.revision, targetType: 'story_compilation', targetId: 'compilation',
      bodies: { current: '原文', previous: null, terminalEvidence: context }, sourceScope: { currentOrderIndex: 1, previous: [] } }
    const candidate = terminalCandidateSchema.parse({ exitState: {} })
    expect(continuitySubjectIdentity({ ...base, terminalCandidate: candidate })).toBe(runtimeJson({ chapterId: current.id, revision: current.revision,
      targetType: base.targetType, targetId: base.targetId, current, previousContent: null, sourceScope: base.sourceScope, previous: null,
      facts: [], selectedProofs: [], coverage: { taskId: 'task', chapterId: current.id, obligations: [] }, proposals: null }).hash)
    expect(continuitySubjectIdentity(base)).not.toBe(continuitySubjectIdentity({ ...base, terminalCandidate: candidate }))
    expect(continuityWorkSubjectIdentity({ kind: 'check', chapter: current, compiler: { id: base.targetId }, sourceBodies: base.bodies, sourceScope: base.sourceScope }))
      .toBe(continuitySubjectIdentity(base))
  })
  it.each(['initial-spent', 'verification-spent', 'changed-focus', 'author-continue', 'malformed-counter', 'missing-r4-receipt', 'parser8-failure', 'parser10-failure'] as const)(
    'checks the actual r5 and r6 normally while preserving the old %s audit and prices', async marker => {
      const f = currentContinuityRunnerFixture(), old = { checkRounds: marker === 'malformed-counter' ? 'broken' : 3, autoRepairRounds: 1,
        oldFailure: { classification: 'projection_invalid', parserVersion: marker === 'parser8-failure' ? 8 : 10, raw: '{"findings":[]}' },
        newDraftRevision: { checkedRevision: 3, afterRevision: 4, marker } }
      f.compilation.validation = structuredClone(old)
      f.compilation.preparedContext = { oldPaidPhase: { marker, consumed: true } }
      const dispatch = f.dispatch(() => '{"findings":[]}')
      expect(await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch })).toMatchObject({ reviewCompleted: true })
      const paid = structuredClone(f.fees), first = structuredClone(f.report())
      expect(await reviewContinuity({ ...f.ctx, callId: 'another-call' }, { compilationId: 'compilation' }, { allowRepair: false, dispatch })).toMatchObject({ reviewCompleted: true })
      expect(f.fees).toEqual(paid); expect(f.requests).toHaveLength(1)
      f.chapter.content += '她重新核对了一页。'; f.chapter.revision++
      expect(await reviewContinuity({ ...f.ctx, callId: 'current-revision' }, { compilationId: 'compilation' }, { allowRepair: false, dispatch })).toMatchObject({ reviewCompleted: true })
      expect(f.requests).toHaveLength(2); expect(f.report().revision).toBe(6)
      expect(f.compilation.validation).toMatchObject(old)
      expect(f.compilation.preparedContext).toEqual({ oldPaidPhase: { marker, consumed: true } })
      expect((f.artifacts.get(first.id)!.metadata as { continuityReport: unknown }).continuityReport).toEqual(first)
      expect(f.report()).not.toHaveProperty('terminalCandidate'); expect(f.report()).not.toHaveProperty('phasePlan')
    })
  it('does not make a failed known pair require a special revision receipt before checking the actual changed body', async () => {
    const f = currentContinuityRunnerFixture()
    const failed = await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => '{bad') })
    expect(failed).toMatchObject({ outcome: 'failed', reviewCompleted: false })
    const original = structuredClone(f.report()), fees = structuredClone(f.fees)
    f.chapter.content += '她核对金额后继续记账。'; f.chapter.revision++
    expect(await reviewContinuity({ ...f.ctx, callId: 'after-real-current-change' }, { compilationId: 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(() => '{"findings":[]}') })).toMatchObject({ reviewCompleted: true })
    expect(f.fees.slice(0, fees.length)).toEqual(fees)
    expect((f.artifacts.get(original.id)!.metadata as { continuityReport: unknown }).continuityReport).toEqual(original)
    expect(f.report().revision).toBe(6)
  })
  it.each(['known-invalid-pair', 'first-not-dispatched', 'second-not-dispatched'] as const)('uses the real old %s physical closure without certifying its report', async kind => {
    const f = currentContinuityRunnerFixture()
    const input = { chapterId: f.chapter.id, revision: 4, bodies: { current: '旧稿', previous: null }, system: 'Frozen legacy review.', content: 'Full old input.',
      targetType: 'story_compilation' as const, targetId: f.compilation.id }
    const key = legacyContinuityAssessmentKey(f.ctx, input), reservation = { id: 'old-reservation', runId: f.ctx.runId,
      metadata: { continuityAssessmentRequestKey: key, assessmentChapterId: f.chapter.id, callId: f.ctx.callId, input } }
    const records = kind === 'first-not-dispatched' ? [{ id: 'not-sent', metadata: { firstAssessmentNotDispatchedKey: key, callId: f.ctx.callId,
      usageIds: [], outcome: 'guard_failed_before_dispatch' } }]
      : [{ id: 'old-response', metadata: { assessmentKey: key, stage: 'first', usageIds: ['first-fee'], response: { content: 'original invalid bytes' } } },
        ...(kind === 'known-invalid-pair' ? [{ id: 'second-response', metadata: { assessmentKey: key, stage: 'reassessment', usageIds: ['second-fee'], response: { content: 'original invalid second bytes' } } }]
          : [{ id: 'second-claim', metadata: { fullReassessmentKey: key } }, { id: 'second-not-sent', metadata: { fullReassessmentNotDispatchedKey: key,
            callId: f.ctx.callId, usageIds: [], outcome: 'guard_failed_before_dispatch' } }])]
    for (const id of kind === 'first-not-dispatched' ? [] : kind === 'known-invalid-pair' ? ['first-fee', 'second-fee'] : ['first-fee'])
      f.fees.push({ id, usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 })
    f.history.mockImplementation(async ({ where }) => where?.OR?.some(item => item.metadata && typeof item.metadata === 'object'
      && 'path' in item.metadata && item.metadata.path?.includes('assessmentChapterId')) ? [reservation] as never : records as never)
    const journal = vi.spyOn(recovery, 'readReviewRequestRecoveryEvidence')
    const old = structuredClone({ reservation, records, fees: f.fees })
    expect(await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(() => '{"findings":[]}') })).toMatchObject({ reviewCompleted: true })
    expect(journal).not.toHaveBeenCalled()
    expect({ reservation, records, fees: f.fees.slice(0, old.fees.length) }).toEqual(old)
    expect(f.requests).toHaveLength(1); expect(f.report().revision).toBe(5)
    expect(f.report().rawResponses).toEqual(['{"findings":[]}'])
  })
  it.each(['foreign-user', 'foreign-novel', 'foreign-task', 'missing-compilation'] as const)('does not register or dispatch outside the actual %s scope', async fault => {
    const f = currentContinuityRunnerFixture(), ctx = { ...f.ctx, ...(fault === 'foreign-user' ? { userId: 'other' } : fault === 'foreign-novel' ? { novelId: 'other' } : fault === 'foreign-task' ? { runId: 'other' } : {}) }
    await expect(reviewContinuity(ctx, { compilationId: fault === 'missing-compilation' ? 'missing' : 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(() => '{"findings":[]}') })).rejects.toBeInstanceOf(DataAccessError)
    expect(f.requests).toEqual([]); expect(f.fees).toEqual([]); expect(f.artifacts.size).toBe(0)
  })
  it.each(['pending-usage', 'pending-settlement', 'native-unknown', 'missing-bound-fee', 'unseen-second'] as const)('retains the real %s physical uncertainty before dispatch', async fault => {
    const f = currentContinuityRunnerFixture()
    if (fault === 'pending-usage' || fault === 'pending-settlement') f.fees.push({ id: 'old', usageSource: fault === 'pending-usage' ? 'unknown' : 'reported',
      billingStatus: fault === 'pending-usage' ? 'pending_usage' : 'pending_settlement', requestTokens: fault === 'pending-usage' ? null : 12, responseTokens: fault === 'pending-usage' ? null : 8, reservedCreditMilli: 3 })
    if (fault === 'native-unknown') { const inputSnapshot = { kind: 'provider', action: 'continuity_critic', input: {} }; f.operations.push({ id: 'native-old',
      status: 'unknown', inputSnapshot, inputHash: runtimeJson(inputSnapshot).hash, attempts: [], events: [] }) }
    if (fault === 'missing-bound-fee' || fault === 'unseen-second') {
      const input = { chapterId: f.chapter.id, revision: 4, bodies: { current: '旧正文', previous: null }, system: 'Frozen old reviewer.', content: 'Frozen old request.',
        targetType: 'story_compilation' as const, targetId: f.compilation.id }
      const key = legacyContinuityAssessmentKey(f.ctx, input), reservation = { id: 'reservation', runId: f.ctx.runId,
        metadata: { continuityAssessmentRequestKey: key, assessmentChapterId: f.chapter.id, callId: f.ctx.callId, input } }
      const records = [{ id: 'binding', metadata: { assessmentRequestOwnerKey: key, usageIds: ['old-fee'], stage: 'first' } },
        ...(fault === 'unseen-second' ? [{ id: 'second-claimed', metadata: { fullReassessmentKey: key } }] : [])]
      if (fault === 'unseen-second') f.fees.push({ id: 'old-fee', usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 })
      f.history.mockImplementation(async ({ where }) => where?.OR?.some(item => item.metadata && typeof item.metadata === 'object'
        && 'path' in item.metadata && item.metadata.path?.includes('assessmentChapterId')) ? [reservation] as never : records as never)
      vi.spyOn(recovery, 'readReviewRequestRecoveryEvidence').mockResolvedValue([])
    }
    const before = structuredClone(f.fees)
    await expect(reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => '{"findings":[]}') }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(f.requests).toEqual([]); expect(f.fees).toEqual(before); expect(f.artifacts.size).toBe(0)
  })
  it.each(['current-revision', 'current-body', 'previous-revision', 'previous-body', 'previous-order'] as const)('does not bind a report after actual %s changes', async fault => {
    const f = currentContinuityRunnerFixture(), raw = '{"findings":[]}'
    await expect(reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => {
      if (fault === 'current-revision') f.chapter.revision++
      if (fault === 'current-body') f.chapter.content += '作者新正文。'
      if (fault === 'previous-revision') f.previous[0].revision++
      if (fault === 'previous-body') f.previous[0].content += '作者更正前章。'
      if (fault === 'previous-order') f.previous[0].orderIndex--
      return raw
    }) })).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    expect(f.bind).not.toHaveBeenCalled(); expect(f.report().rawResponses).toEqual([raw]); expect(f.fees).toHaveLength(1)
  })
  it.each(['cancel-before', 'cancel-after', 'owner-before', 'owner-after'] as const)('keeps the actual %s boundary without applying a report or prose', async fault => {
    const f = currentContinuityRunnerFixture(); let ownerCurrent = !fault.includes('owner-before')
    if (fault === 'cancel-before') f.controller.abort()
    f.ctx.assertCurrentExecution = async () => { if (!ownerCurrent) throw new DataAccessError(409, 'RUNTIME_PARENT_LEASE_LOST', '旧owner已结束') }
    await expect(reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => {
      if (fault === 'cancel-after') f.controller.abort()
      if (fault === 'owner-after') ownerCurrent = false
      return '{"findings":[]}'
    }) })).rejects.toBeDefined()
    expect(f.bind).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(fault.endsWith('after') ? 1 : 0)
    if (fault.endsWith('after')) expect(f.report()).toMatchObject({ complete: false, rawResponses: ['{"findings":[]}'], billingKnown: true })
  })
  it('returns a real issue as a complete report without declaring that the plot passed', async () => {
    const f = currentContinuityRunnerFixture()
    const result = await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(() => JSON.stringify({ findings: [f.opinion(f.chapter.content, 'error')] })) })
    expect(result).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required' })
    expect(result.outcome).not.toBe('failed'); expect(f.report().findings[0].severity).toBe('error')
    expect(result.output).toContain(f.report().findings[0].explanation)
    expect(result.summary).toContain('1 错误')
  })
  it('keeps a source-unlocated opinion and its raw response instead of treating it as an empty passing report', async () => {
    const f = currentContinuityRunnerFixture(), opinion = { ...f.opinion(), evidence: [{ sourceId: 'not-in-this-source' }] }
    const result = await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(request => request.action === 'agent3ContinuityCritic' ? JSON.stringify({ findings: [opinion] }) : '{"corrections":[]}') })
    expect(result).toMatchObject({ outcome: 'failed', reviewCompleted: false })
    expect(f.report()).toMatchObject({ opinions: [opinion], unlocatedIndexes: [0], complete: false })
    expect(f.requests).toHaveLength(2); expect(f.fees).toHaveLength(2)
  })
})
