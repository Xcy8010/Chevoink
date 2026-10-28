import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { continuitySubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { buildContinuityReviewManifest, continuityReviewV4Request, inspectContinuityV4, applyContinuityV4Repair,
  validateStoredContinuityV4Projection, buildContinuityInvalidRowRepair, normalizeContinuityV4ProjectionV2, failedContinuityV4Repair } from '../../api/lib/agent/continuity-review-v4.js'
import { effectiveContinuityAudit, continuityPhasePlanSchema, validContinuityPhasePlan, continuityUsageRowHash, continuityQuestionOwner, readKnownContinuityReplay,
  nativeContinuityRevisionMaterialMatches } from '../../api/lib/agent/continuity-coordinator.js'
import { inspectAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { readAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'

function fixture() {
  const current = 'The sealed packet is held by the guard. The missing map remains unaccounted for.'
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The guard holds the sealed packet.'], openLoops: ['The missing map remains unaccounted for.'] } })
  const context = { protocol: 2 as const, verdictProtocol: 6 as const, spanAddressProtocol: 2 as const,
    current: { id: 'chapter', revision: 4, orderIndex: 3, contentHash: runtimeJson({ content: current }).hash }, previous: null,
    factCoverage: { version: 2 as const, taskId: 'task', chapterId: 'chapter', obligations: [] } }
  const bodies = { previous: null, current, terminalEvidence: context }, sourceScope = { currentOrderIndex: 3, previous: [] }
  const identity = { chapterId: 'chapter', revision: 4, targetType: 'story_compilation', targetId: 'compilation', bodies, candidate,
    terminalCandidate: candidate, sourceScope }
  const planValue = { version: 1 as const, originalTaskId: 'task', originalAdmissionId: 'run', chapterId: 'chapter', compilationId: 'compilation', authorityHash: 'a'.repeat(64),
    semanticSubjectHash: continuitySubjectIdentity(identity)!, modelPriceHash: 'b'.repeat(64), budgetOwner: 'task',
    phases: [{ kind: 'initial_review' as const, limit: 1, authoritySourceRef: 'original-admission:run' },
      { kind: 'sparse_repair' as const, limit: 1, authoritySourceRef: 'original-admission:run' }] }
  const plan = continuityPhasePlanSchema.parse({ ...planValue, hash: runtimeJson(planValue).hash })
  const base = { subject: { userId: 'user', novelId: 'novel', taskId: 'task', targetType: 'story_compilation' as const,
    targetId: 'compilation', chapterId: 'chapter', revision: 4 }, bodies, candidate, sourceScope,
    sourceHash: null, sourceVersions: { current: context.current }, verifiedCoverage: context.factCoverage, draftProposals: null }
  const prior = { reportHash: 'c'.repeat(64), findingId: 'old0', text: 'The earlier label was “packet”; its allegation was not authenticated.' }
  const manifest = buildContinuityReviewManifest({ ...base, typedLineage: { version: 1, phasePlan: plan, priorFindings: [prior], establishedIssues: [] } })
  const frozen = { manifest, bodies, candidate, sourceScope }
  const wire = { findings: [] as unknown[], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear',
    reasonCode: 'consistent', explanation: 'The full sources show no incompatible events.', findingIds: [] })),
    terminalVerdicts: [0, 1].map(claimIndex => ({ claimIndex, verdict: 'supported', reasonCode: 'consistent',
      explanation: 'The full current text supports this exact claim.', manuscriptEvidence: [{ segmentId: 'c0' }] })),
    terminalProofVerdicts: [], terminalDispositions: [], issueDispositions: [] }
  return { current, candidate, context, bodies, base, prior, plan, frozen, wire }
}

describe('explicit continuity contract5, frozen <=9 replay', () => {
  it.each(['body', 'candidate'] as const)('uses the same live typed explanation rule for a %s report and explicit retraction while replaying strict parser10 unchanged', scope => {
    const f = fixture(), manifest = scope === 'body' ? buildContinuityReviewManifest({ ...f.base, candidate: undefined,
      typedLineage: f.frozen.manifest.typedLineage }) : f.frozen.manifest
    const frozen = { manifest, bodies: f.bodies, sourceScope: f.base.sourceScope, ...(scope === 'candidate' ? { candidate: f.candidate } : {}) }
    const plain = { findings: [], semanticChecks: f.wire.semanticChecks, issueDispositions: [], ...(scope === 'candidate' ? {
      terminalVerdicts: f.wire.terminalVerdicts, terminalProofVerdicts: [], terminalDispositions: [] } : {}) }
    const explained = { ...plain, semanticChecks: plain.semanticChecks.map(row => ({ ...row,
      explanation: 'The label “a prior hypothesis” is explanatory data, not a manuscript quotation.' })) }
    const strictFirst = inspectContinuityV4(JSON.stringify(explained), frozen), strictHash = runtimeJson(strictFirst.audit).hash
    expect(strictFirst.complete).toBe(false)
    const firstProjection = normalizeContinuityV4ProjectionV2(strictFirst, 'a'.repeat(64))
    expect(firstProjection.complete).toBe(true)
    expect(validateStoredContinuityV4Projection(firstProjection.audit, f.current, f.context)?.audit).toEqual(firstProjection.audit)
    expect(runtimeJson(validateStoredContinuityV4Projection(strictFirst.audit, f.current, f.context)!.audit).hash).toBe(strictHash)

    const raw = JSON.stringify({ ...plain, findings: [{ findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'insufficient_evidence',
      explanation: 'An unverified hypothesis remains only an opinion.', suggestion: 'Read the full source.',
      manuscriptEvidence: [{ segmentId: 'c0', quote: 'An invented explicit quotation.' }] }] })
    const first = inspectContinuityV4(raw, frozen), plan = buildContinuityInvalidRowRepair(first)!
    expect(plan.mask).toEqual([{ table: 'findings', index: 0 }])
    const decision = { findingId: 'f0', action: 'retract', reasonCode: 'insufficient_evidence',
      explanation: 'The old opinion “an invented explicit quotation” is unsupported; this explanation does not certify it.',
      manuscriptEvidence: [{ segmentId: 'c0', quote: 'The sealed packet is held by the guard.' }] }
    const second = JSON.stringify({ corrections: [{ table: 'findings', index: 0, value: decision }] })
    expect(() => applyContinuityV4Repair(first, second, true)).toThrow('Typed retraction lacks authentic source references')
    const failed = failedContinuityV4Repair(first, second, true), failedHash = runtimeJson(failed.audit).hash
    const projected = normalizeContinuityV4ProjectionV2(failed, 'a'.repeat(64))
    expect(projected).toMatchObject({ complete: true, findings: [], audit: { continuityV4: { projectionNormalization: { version: 2, mode: 'sparse_repair',
      mappings: [expect.objectContaining({ kind: 'non_evidentiary_explanation', table: 'findings', index: 0 })] } } } })
    expect(projected.audit.rawResponse).toEqual(first.audit.rawResponse)
    expect(projected.audit.continuityV4.failedRepair!.response.content).toBe(JSON.stringify(second))
    expect(validateStoredContinuityV4Projection(projected.audit, f.current, f.context)?.audit).toEqual(projected.audit)
    expect(runtimeJson(failed.audit).hash).toBe(failedHash)
    expect(runtimeJson(validateStoredContinuityV4Projection(failed.audit, f.current, f.context)!.audit).hash).toBe(failedHash)
    expect(() => applyContinuityV4Repair(first, second, true)).toThrow('Typed retraction lacks authentic source references')
    for (const kind of ['bad-quote', 'wrong-prior', 'dangling-finding'] as const) {
      const value = { ...decision, ...(kind === 'bad-quote' ? { manuscriptEvidence: [{ segmentId: 'c0', quote: 'A second invented explicit quote.' }] } : {}),
        ...(kind === 'wrong-prior' ? { priorFindingRef: { reportHash: f.prior.reportHash, findingId: f.prior.findingId, quote: 'Not the frozen earlier opinion.' } } : {}) }
      const malformedFirst = kind === 'dangling-finding' ? inspectContinuityV4(JSON.stringify({ ...JSON.parse(raw), semanticChecks: plain.semanticChecks.map(row =>
        row.kind === 'state_progression' ? { ...row, result: 'conflict', findingIds: ['f0'] } : row) }), frozen) : first
      const mask = buildContinuityInvalidRowRepair(malformedFirst)!
      const malformedSecond = JSON.stringify({ corrections: mask.mask.map(item => ({ ...item,
        value: item.table === 'findings' ? value : (malformedFirst.parsed!.record.semanticChecks as unknown[])[item.index] })) })
      expect(normalizeContinuityV4ProjectionV2(failedContinuityV4Repair(malformedFirst, malformedSecond, true), 'a'.repeat(64)).complete).toBe(false)
    }
  })
  it('reviews the whole body with typed evidence while terminal certification remains unrequested', () => {
    const f = fixture(), { hash: _hash, ...oldPlan } = f.plan
    const planValue = { ...oldPlan, semanticSubjectHash: continuitySubjectIdentity({ chapterId: 'chapter', revision: 4,
      targetType: 'story_compilation', targetId: 'compilation', bodies: f.bodies, sourceScope: f.base.sourceScope })! }
    const plan = continuityPhasePlanSchema.parse({ ...planValue, hash: runtimeJson(planValue).hash })
    const manifest = buildContinuityReviewManifest({ ...f.base, candidate: undefined,
      typedLineage: { ...f.frozen.manifest.typedLineage!, phasePlan: plan } })
    const frozen = { manifest, bodies: f.bodies, sourceScope: f.base.sourceScope }
    const wire = { findings: [], semanticChecks: f.wire.semanticChecks, issueDispositions: [] }
    const request = JSON.parse(continuityReviewV4Request(frozen, 'Review the saved body.', f.current).content)
    expect(request).toMatchObject({ reviewScope: 'body_only', terminalCertification: 'not_requested', catalog: { terminal: null } })
    expect(manifest.candidateHash).toBeNull()
    const result = inspectContinuityV4(JSON.stringify(wire), frozen)
    expect(result).toMatchObject({ complete: true, findings: [], terminalReview: null,
      audit: { parserVersion: 10, responseContract: 5, continuityV4: { projections: {
        prose: { valid: true }, currentTerminal: { valid: false }, historicalCoverage: { valid: false }, draftProposals: { valid: false },
      } } } })
    expect(result.audit).not.toHaveProperty('terminalCandidate')
    expect(result.audit).not.toHaveProperty('terminalContentHash')
    expect(validateStoredContinuityV4Projection(result.audit, f.current, f.context)).toEqual(result)
    expect(inspectContinuityV4(JSON.stringify({ ...wire, terminalVerdicts: [] }), frozen).complete).toBe(false)
    const explained = { ...wire, semanticChecks: wire.semanticChecks.map(row => ({ ...row,
      explanation: 'The old opinion "the packet vanished" is not a manuscript fact.' })) }
    const restored = normalizeContinuityV4ProjectionV2(inspectContinuityV4(JSON.stringify(explained), frozen), 'a'.repeat(64))
    expect(restored).toMatchObject({ complete: true, terminalReview: null })
    expect(restored.audit.rawResponse.content).toBe(JSON.stringify(JSON.stringify(explained)))
    expect(validateStoredContinuityV4Projection(restored.audit, f.current, f.context)).toEqual(restored)
    const falseQuote = { ...wire, findings: [{ findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'insufficient_evidence',
      explanation: 'Check the actual packet.', suggestion: 'Keep the current state.', manuscriptEvidence: [{ segmentId: 'c0', quote: 'The packet vanished.' }] }] }
    expect(normalizeContinuityV4ProjectionV2(inspectContinuityV4(JSON.stringify(falseQuote), frozen), 'a'.repeat(64)).complete).toBe(false)
  })
  it('authenticates original merged-revision message values after JSONB reorders the frozen input', () => {
    const original = { version: 1, planHash: 'a'.repeat(64), content: 'The packet remains sealed.', revision: 4,
      findings: [{ source: 'continuity', findingId: 'f0', evidence: { quote: 'sealed', segmentId: 'c0' } }] }
    const message = JSON.stringify(original), frozen = runtimeJson(original)
    expect(message).not.toBe(JSON.stringify(frozen.value))
    expect(nativeContinuityRevisionMaterialMatches(frozen.value as Record<string, unknown>, frozen.hash, message)).toBe(true)
    expect(nativeContinuityRevisionMaterialMatches(original, frozen.hash, JSON.stringify(frozen.value))).toBe(true)
    // The original physical request is retained byte-for-byte on replay.
    expect(message).toBe(JSON.stringify(original))
  })
  it.each(['changed-value', 'changed-input', 'wrong-hash', 'missing-field', 'duplicate-key', 'escaped-duplicate-key',
    'nested-duplicate-key', 'trailing-object', 'trailing-prose', 'malformed', 'array'] as const)('rejects %s merged-revision material', kind => {
    const input = { version: 1, revision: 4, content: 'Original body.', findings: [{ findingId: 'f0' }] }, frozen = runtimeJson(input)
    const messages = {
      'changed-value': JSON.stringify({ ...input, content: 'Changed body.' }),
      'changed-input': JSON.stringify(input), 'wrong-hash': JSON.stringify(input),
      'missing-field': JSON.stringify({ version: 1, revision: 4, findings: input.findings }),
      'duplicate-key': '{"version":1,"revision":3,"revision":4,"content":"Original body.","findings":[{"findingId":"f0"}]}',
      'escaped-duplicate-key': '{"version":1,"revision":3,"\\u0072evision":4,"content":"Original body.","findings":[{"findingId":"f0"}]}',
      'nested-duplicate-key': '{"version":1,"revision":4,"content":"Original body.","findings":[{"findingId":"bad","findingId":"f0"}]}',
      'trailing-object': `${JSON.stringify(input)} {}`, 'trailing-prose': `${JSON.stringify(input)} done`,
      malformed: JSON.stringify(input).slice(0, -1), array: JSON.stringify([input]),
    }
    expect(nativeContinuityRevisionMaterialMatches(kind === 'changed-input' ? { ...input, revision: 5 } : input,
      kind === 'wrong-hash' ? 'b'.repeat(64) : frozen.hash, messages[kind])).toBe(false)
  })
  it('accepts a full typed report retracting an unestablished draft with current manuscript evidence', () => {
    const f = fixture(), draft = terminalDraftFixture('emotion', { chapter: { id: 'chapter', revision: 4, orderIndex: 3, content: f.current },
      taskId: 'task', ctx: { userId: 'user', novelId: 'novel', runId: 'run' }, compilationId: 'compilation', candidate: f.candidate,
      originBindingHash: 'b'.repeat(64), currentBindingHash: 'b'.repeat(64) })
    const context = { ...f.context, proposalChanges: draft.nextContext.proposalChanges }, bodies = { ...f.bodies, terminalEvidence: context }
    const { hash: _hash, ...oldPlan } = f.plan
    const planBody = { ...oldPlan, semanticSubjectHash: continuitySubjectIdentity({ chapterId: 'chapter', revision: 4, targetType: 'story_compilation',
      targetId: 'compilation', bodies, terminalCandidate: f.candidate, sourceScope: f.frozen.sourceScope })! }
    const manifest = buildContinuityReviewManifest({ ...f.base, bodies, draftProposals: context.proposalChanges,
      typedLineage: { ...f.frozen.manifest.typedLineage!, phasePlan: { ...planBody, hash: runtimeJson(planBody).hash } } })
    const wire = { ...f.wire, proposalDispositions: [{ proposalIndex: 0, outcome: 'retracted', reasonCode: 'consistent',
      explanation: 'The manuscript explicitly records packet and table states; the earlier reply proposal is not established by those states.',
      manuscriptEvidence: [{ segmentId: 'c0' }] }] }
    const result = inspectContinuityV4(JSON.stringify(wire), { ...f.frozen, bodies, manifest })
    expect(result.audit, JSON.stringify(result.parsed?.diagnostics)).toMatchObject({ classification: 'complete' })
    expect(result.complete).toBe(true)
    expect(result.parsed?.record).toEqual(wire)
    for (const manuscriptEvidence of [[{ segmentId: 'c0', quote: 'Invented manuscript quote.' }], [{ segmentId: 'p0' }]]) {
      const invalid = { ...wire, proposalDispositions: [{ ...wire.proposalDispositions[0], manuscriptEvidence }] }
      expect(inspectContinuityV4(JSON.stringify(invalid), { ...f.frozen, bodies, manifest }).complete).toBe(false)
    }
  })
  it('refuses known-result fallback when the current effective pointer exists but is stale', async () => {
    const db = { storyCompilation: { findFirst: vi.fn(async () => ({ chapter: { revision: 4 }, bridge: {}, runId: 'run',
      validation: { independentCheck: 'unavailable', checkedRevision: 4, effectiveReport: { reportHash: 'stale' },
        continuityCriticResponse: { contentHash: 'a'.repeat(64), rawResponse: { content: 'unchanged full raw' } } } })) } }
    // No other delegate exists: choosing another historical report would fail
    // this direct regression before reaching the immutable source reader.
    expect(await readKnownContinuityReplay(db as unknown as Prisma.TransactionClient,
      { userId: 'user', novelId: 'novel', runId: 'run' }, 'compilation')).toBeNull()
  })
  it('keeps a truncated transport invalid and repairs only its declared typed finding row', () => {
    const f = fixture()
    expect(inspectContinuityV4(JSON.stringify(f.wire), f.frozen, false)).toMatchObject({ complete: false, audit: { classification: 'response_incomplete' } })
    f.wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'historical_reference',
      explanation: 'The text supposedly says “a wholly nonexistent quoted manuscript passage”.',
      suggestion: 'Check the original source.', manuscriptEvidence: [{ segmentId: 'c0' }] })
    const first = inspectContinuityV4(JSON.stringify(f.wire), f.frozen)
    expect(first.complete).toBe(false)
    const corrected = applyContinuityV4Repair(first, JSON.stringify({ corrections: [{ table: 'findings', index: 0,
      value: { findingId: 'f0', action: 'retract', reasonCode: 'insufficient_evidence',
        explanation: 'The current source does not establish that allegation; the manuscript is unchanged.', manuscriptEvidence: [{ segmentId: 'c0' }] } }] }), true)
    expect(corrected.complete).toBe(true)
    expect(corrected.parsed!.record.findings).toEqual([])
    for (const key of ['semanticChecks', 'terminalVerdicts', 'terminalProofVerdicts', 'terminalDispositions', 'issueDispositions'])
      expect(corrected.parsed!.record[key]).toEqual((f.wire as Record<string, unknown>)[key])
  })
  it('serializes only explicit question ownership from a full ToolContext', () => {
    const ctx = { userId: 'user', novelId: 'novel', runId: 'run', continuityOwnerSeq: 7,
      emit: () => {}, modelRuntime: { apiKey: 'private-placeholder' }, protectedChapterIds: new Set(['protected']),
      signal: new AbortController().signal }
    expect(continuityQuestionOwner(ctx)).toEqual({ userId: 'user', novelId: 'novel', runId: 'run', ownerSeq: 7 })
    expect(() => runtimeJson(continuityQuestionOwner(ctx))).not.toThrow()
    expect(JSON.stringify(continuityQuestionOwner(ctx))).not.toContain('private-placeholder')
  })
  it('hashes immutable Prisma usage rows through their JSON boundary without changing dates or fee values', () => {
    const date = new Date('2026-10-25T07:03:08.505Z'), row = { id: 'fee', createdAt: date, creditMilli: 11141,
      billingSnapshot: { version: 'credits-v2-itemized', multiplierBps: 11000 }, multiplierBps: 15000 }
    expect(continuityUsageRowHash(row)).toBe(runtimeJson({ ...row, createdAt: date.toISOString() }).hash)
    expect(row.createdAt).toBe(date); expect(row.createdAt.toISOString()).toBe('2026-10-25T07:03:08.505Z')
    expect(continuityUsageRowHash({ ...row, creditMilli: 11142 })).not.toBe(continuityUsageRowHash(row))
  })
  it('uses a distinct wire and replays the entire typed raw lineage', () => {
    const f = fixture(), raw = JSON.stringify(f.wire), result = inspectContinuityV4(raw, f.frozen)
    expect(result.complete, JSON.stringify(result.parsed?.diagnostics)).toBe(true)
    expect(result.audit).toMatchObject({ parserVersion: 10, responseContract: 5 })
    expect(validateStoredContinuityV4Projection(result.audit, f.current, f.context)?.audit).toEqual(result.audit)
    const request = continuityReviewV4Request(f.frozen, 'Continue this chapter.', 'Full frozen context')
    expect(request.system).toContain('contract5'); expect(request.system).toContain('无需要求本章解开')
    expect(request.system).toContain('manuscriptEvidence'); expect(JSON.parse(request.content).priorFindings).toEqual([f.prior])
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
  })
  it('never reinterprets a frozen parser9 response as contract5', () => {
    const f = fixture(), old = buildContinuityReviewManifest(f.base)
    expect(() => inspectAuthenticatedContinuityAssessment(JSON.stringify(f.wire), { bodies: f.bodies, terminalCandidate: f.candidate,
      parserVersion: 9, reassessmentProtocol: 6, continuityManifest: f.frozen.manifest, sourceScope: f.frozen.sourceScope }, true)).toThrow()
    expect(inspectContinuityV4(JSON.stringify(f.wire), { ...f.frozen, manifest: old }).complete).toBe(false)
    expect(() => inspectAuthenticatedContinuityAssessment(JSON.stringify(f.wire), { bodies: f.bodies, terminalCandidate: f.candidate,
      parserVersion: 10, reassessmentProtocol: 7, continuityManifest: old, sourceScope: f.frozen.sourceScope }, true)).toThrow()
  })
  it('binds an explicit short audit quotation while requiring real manuscript evidence for the current finding', () => {
    const f = fixture()
    f.wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'historical_reference',
      explanation: 'The old opinion used “packet”; this is an audit reference only.', suggestion: 'Retain the original data.',
      manuscriptEvidence: [{ segmentId: 'c0' }], priorFindingRef: { reportHash: f.prior.reportHash, findingId: f.prior.findingId, quote: 'packet' } })
    const inspected = inspectContinuityV4(JSON.stringify(f.wire), f.frozen)
    expect(inspected.complete).toBe(true)
    expect(inspected.findings[0].sourceEvidence).toEqual([{ source: 'current', quote: f.current }])
    expect(inspected.findings[0].suggestion).toContain('audit reference')
    const raw = structuredClone(f.wire) as typeof f.wire
    Object.assign(raw.findings[0] as object, { manuscriptEvidence: [] })
    expect(inspectContinuityV4(JSON.stringify(raw), f.frozen).complete).toBe(false)
  })
  it.each(['unlocated-long-quote', 'wrong-prior', 'wrong-prior-quote', 'wrong-source', 'legacy-fields'] as const)('rejects %s without rewriting the raw', kind => {
    const f = fixture(), finding = { findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'historical_reference',
      explanation: 'The old opinion used “packet”; it is not a current fact.', suggestion: 'Preserve the old report.',
      manuscriptEvidence: [{ segmentId: 'c0' }], priorFindingRef: { reportHash: f.prior.reportHash, findingId: f.prior.findingId, quote: 'packet' } }
    if (kind === 'unlocated-long-quote') finding.explanation = 'The opinion asserted “a long nonexistent quotation” without a source.'
    if (kind === 'wrong-prior') finding.priorFindingRef.reportHash = 'd'.repeat(64)
    if (kind === 'wrong-prior-quote') finding.priorFindingRef.quote = 'invented'
    if (kind === 'wrong-source') finding.manuscriptEvidence[0].segmentId = 'c999'
    if (kind === 'legacy-fields') Object.assign(finding, { reason: 'Legacy shape must not be coerced.' })
    f.wire.findings.push(finding)
    const raw = JSON.stringify(f.wire), result = inspectContinuityV4(raw, f.frozen)
    expect(result.complete).toBe(false); expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
  })
  it('keeps a complete UNKNOWN judgment valid and consumes no sparse repair', () => {
    const f = fixture(); Object.assign(f.wire.terminalVerdicts[1], { verdict: 'unknown', reasonCode: 'insufficient_evidence', manuscriptEvidence: [] })
    const result = inspectContinuityV4(JSON.stringify(f.wire), f.frozen)
    expect(result.complete).toBe(true); expect(result.terminalReview?.supported).toBe(false)
    expect(buildContinuityInvalidRowRepair(result)).toBeNull()
  })
  it('does not let historical references certify a current supported fact', () => {
    const f = fixture(); f.wire.terminalVerdicts[0].reasonCode = 'historical_reference'
    expect(inspectContinuityV4(JSON.stringify(f.wire), f.frozen).complete).toBe(false)
  })
  it('repairs only an invalid typed row, retaining the complete original and second raw', () => {
    const f = fixture(); f.wire.terminalVerdicts[0].manuscriptEvidence[0].segmentId = 'c999'
    const raw = JSON.stringify(f.wire), first = inspectContinuityV4(raw, f.frozen), before = structuredClone(first.audit)
    const plan = buildContinuityInvalidRowRepair(first)!
    expect(plan.mask).toEqual([{ table: 'terminalVerdicts', index: 0 }])
    const replacement = { ...f.wire.terminalVerdicts[0], manuscriptEvidence: [{ segmentId: 'c0' }] }
    const second = JSON.stringify({ corrections: [{ table: 'terminalVerdicts', index: 0, value: replacement }] })
    const result = applyContinuityV4Repair(first, second, true)
    expect(result.complete).toBe(true); expect(first.audit).toEqual(before)
    expect(result.parsed!.record.terminalVerdicts).toEqual([replacement, f.wire.terminalVerdicts[1]])
    expect(validateStoredContinuityV4Projection(result.audit, f.current, f.context)?.complete).toBe(true)
  })
  it('treats a phase plan as a bound, never a self-authenticating grant', () => {
    const f = fixture(); expect(validContinuityPhasePlan(f.plan)).toBe(true)
    const changed = structuredClone(f.plan); changed.phases[0].limit = 0
    expect(validContinuityPhasePlan(changed)).toBe(false)
    const repeated = { ...f.plan, phases: [f.plan.phases[0], f.plan.phases[0]] }
    const { hash: _hash, ...body } = repeated
    expect(validContinuityPhasePlan({ ...body, hash: runtimeJson(body).hash })).toBe(false)
  })
  it('never falls back to an old best report when an effective pointer is missing or stale', () => {
    const f = fixture(), audit = inspectContinuityV4(JSON.stringify(f.wire), f.frozen).audit
    expect(effectiveContinuityAudit({ continuityCriticResponse: audit })).toBeNull()
    const pointer = { version: 1, reportArtifactId: 'report', reportHash: runtimeJson(audit).hash, manifestHash: f.frozen.manifest.hash,
      lineageHash: runtimeJson({ assessmentRequest: null, manifest: audit.continuityV4.manifest, first: audit.continuityV4.first, repair: null }).hash }
    expect(effectiveContinuityAudit({ continuityCriticResponse: audit, effectiveReport: pointer })).toEqual(audit)
    expect(effectiveContinuityAudit({ continuityCriticResponse: audit, effectiveReport: { ...pointer, reportHash: 'e'.repeat(64) } })).toBeNull()
  })
  it('requires a typed, source-bound retraction and keeps every fixed row intact', () => {
    const f = fixture()
    f.wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'historical_reference',
      explanation: 'The allegation cited “a long nonexistent quotation” without a source.', suggestion: 'Recheck.', manuscriptEvidence: [{ segmentId: 'c0' }] })
    const raw = JSON.stringify(f.wire), first = inspectContinuityV4(raw, f.frozen)
    expect(first.complete).toBe(false)
    expect(buildContinuityInvalidRowRepair(first)?.mask).toEqual([{ table: 'findings', index: 0 }])
    const envelope = (value: unknown) => JSON.stringify({ corrections: [{ table: 'findings', index: 0, value }] })
    expect(() => applyContinuityV4Repair(first, envelope({ findingId: 'f0', action: 'retract', reason: 'Unlocated “a long nonexistent quotation”.',
      sourceEvidence: [{ segmentId: 'c0' }] }), true)).toThrow()
    expect(() => applyContinuityV4Repair(first, envelope({ findingId: 'f0', action: 'retract', reasonCode: 'historical_reference',
      explanation: 'Unlocated “a long nonexistent quotation”.', manuscriptEvidence: [{ segmentId: 'c0' }] }), true)).toThrow()
    const decision = { findingId: 'f0', action: 'retract', reasonCode: 'historical_reference',
      explanation: 'The earlier “packet” label does not establish the allegation.', manuscriptEvidence: [{ segmentId: 'c0' }],
      priorFindingRef: { reportHash: f.prior.reportHash, findingId: f.prior.findingId, quote: 'packet' } }
    const second = envelope(decision), result = applyContinuityV4Repair(first, second, true)
    expect(result.complete).toBe(true)
    expect(result.parsed!.record.findings).toEqual([])
    for (const key of ['semanticChecks', 'terminalVerdicts', 'terminalProofVerdicts', 'terminalDispositions', 'issueDispositions'])
      expect(result.parsed!.record[key]).toEqual((f.wire as Record<string, unknown>)[key])
    expect(result.audit.continuityV4.repair?.dispositions).toEqual([decision])
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
    expect(validateStoredContinuityV4Projection(result.audit, f.current, f.context)?.complete).toBe(true)
  })
  it('keeps prose p0 and direct-predecessor terminal p0 in separate source catalogues', () => {
    const f = fixture(), archive = 'Distant archive note. '.repeat(20), direct = 'The direct predecessor preserves the packet.'
    const previous = `${archive}\n\n${direct}`
    const context = { ...f.context, previous: { id: 'previous', revision: 2, orderIndex: 2, contentHash: runtimeJson({ content: direct }).hash,
      start: 0, end: direct.length, joinedStart: archive.length + 2, joinedEnd: previous.length,
      segments: [{ segmentId: 'p0', start: archive.length + 2, end: previous.length, quote: direct, hash: runtimeJson({ text: direct }).hash }] } }
    const bodies = { ...f.bodies, previous, terminalEvidence: context }, sourceScope = { currentOrderIndex: 3,
      previous: [{ orderIndex: 1, startOffset: 0, endOffset: archive.length }, { orderIndex: 2, startOffset: archive.length + 2, endOffset: previous.length }] }
    const manifest = buildContinuityReviewManifest({ ...f.base, bodies, sourceScope, sourceHash: 'd'.repeat(64), sourceVersions: context.previous,
      typedLineage: f.frozen.manifest.typedLineage })
    const frozen = { ...f.frozen, manifest, bodies, sourceScope }
    const wire = structuredClone(f.wire)
    Object.assign(wire.terminalVerdicts[0], { explanation: `The selected predecessor says “${direct}”.`, manuscriptEvidence: [{ segmentId: 'p0' }, { segmentId: 'c0' }],
      inheritance: { priorEndState: 'established', currentState: 'unchanged' } })
    wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'warning', reasonCode: 'historical_reference',
      explanation: 'The broad prose scope includes “Distant archive note.”.', suggestion: 'Preserve the distinction.',
      manuscriptEvidence: [{ segmentId: 'p0', quote: 'Distant archive note.' }] })
    const good = inspectContinuityV4(JSON.stringify(wire), frozen)
    expect(good.complete, JSON.stringify(good.parsed?.diagnostics)).toBe(true)
    const issueManifest = buildContinuityReviewManifest({ ...f.base, bodies, sourceScope, sourceHash: 'd'.repeat(64), sourceVersions: context.previous,
      typedLineage: { ...f.frozen.manifest.typedLineage!, establishedIssues: [f.prior] } })
    const issueWire = { ...wire, issueDispositions: [{ issueIndex: 0, outcome: 'present', reasonCode: 'manuscript_conflict', findingId: 'f0',
      explanation: 'The issue concerns “Distant archive note.”.', manuscriptEvidence: [{ segmentId: 'p0', quote: 'Distant archive note.' }] }] }
    expect(inspectContinuityV4(JSON.stringify(issueWire), { ...frozen, manifest: issueManifest }).complete).toBe(true)
    issueWire.issueDispositions[0].manuscriptEvidence[0].quote = direct
    expect(inspectContinuityV4(JSON.stringify(issueWire), { ...frozen, manifest: issueManifest }).complete).toBe(false)
    wire.terminalVerdicts[0].explanation = 'The terminal source incorrectly claims “Distant archive note.”.'
    const bad = inspectContinuityV4(JSON.stringify(wire), frozen)
    expect(bad.complete).toBe(false)
    expect(bad.parsed?.diagnostics).toContainEqual({ table: 'terminalVerdicts', index: 0, code: 'typed_reason_or_provenance_invalid' })
  })
  it.each(['insufficient_evidence', 'historical_reference', 'proposal_pending'] as const)('does not discharge an established issue with %s', reasonCode => {
    const f = fixture(), manifest = buildContinuityReviewManifest({ ...f.base, typedLineage: { ...f.frozen.manifest.typedLineage!, establishedIssues: [f.prior] } })
    const wire = { ...f.wire, issueDispositions: [{ issueIndex: 0, outcome: 'repaired', reasonCode,
      explanation: 'The issue is not established by the current evidence.', manuscriptEvidence: [{ segmentId: 'c0' }] }] }
    expect(inspectContinuityV4(JSON.stringify(wire), { ...f.frozen, manifest }).complete).toBe(false)
    wire.issueDispositions[0].outcome = 'unknown'
    const result = inspectContinuityV4(JSON.stringify(wire), { ...f.frozen, manifest })
    expect(result.complete).toBe(true)
    expect(readAuthenticatedContinuityAssessment(result.audit, f.current, f.context, true)).toMatchObject({ establishedIssuesComplete: false })
  })
  it('can discharge an earlier mistaken issue with current evidence without pretending the body was revised', () => {
    const f = fixture(), manifest = buildContinuityReviewManifest({ ...f.base,
      typedLineage: { ...f.frozen.manifest.typedLineage!, establishedIssues: [f.prior] } })
    const disposition = { issueIndex: 0, outcome: 'repaired', reasonCode: 'consistent',
      explanation: 'The current complete text establishes the packet remains sealed; the earlier allegation does not hold.',
      manuscriptEvidence: [{ segmentId: 'c0', quote: 'The sealed packet is held by the guard.' }] }
    const wire = { ...f.wire, issueDispositions: [disposition] }
    const result = inspectContinuityV4(JSON.stringify(wire), { ...f.frozen, manifest })
    expect(result.complete).toBe(true)
    expect(readAuthenticatedContinuityAssessment(result.audit, f.current, f.context, true)).toMatchObject({ establishedIssuesComplete: true })
    expect(result.parsed!.record.findings).toEqual([])
    expect(result.audit.continuityV4.manifest.subject).toMatchObject({ revision: 4 })
    for (const manuscriptEvidence of [[], [{ segmentId: 'c999' }], [{ segmentId: 'c0', quote: 'A fabricated current passage.' }]]) {
      const invalid = { ...wire, issueDispositions: [{ ...disposition, manuscriptEvidence,
        priorFindingRef: { reportHash: f.prior.reportHash, findingId: f.prior.findingId, quote: 'packet' } }] }
      expect(inspectContinuityV4(JSON.stringify(invalid), { ...f.frozen, manifest }).complete).toBe(false)
    }
  })
  it('keeps a literal prior-opinion reference in a legitimate UNKNOWN disposition without making it manuscript evidence', () => {
    const f = fixture(), obligation = { id: terminalFactId('objects', 'The packet was missing.'), field: 'objects' as const, claim: 'The packet was missing.' }
    const context = { ...f.context, factCoverage: { ...f.context.factCoverage, obligations: [obligation] } }, bodies = { ...f.bodies, terminalEvidence: context }
    const manifest = buildContinuityReviewManifest({ ...f.base, bodies, verifiedCoverage: context.factCoverage, typedLineage: f.frozen.manifest.typedLineage })
    const wire = { ...f.wire, terminalDispositions: [{ obligationIndex: 0, outcome: 'unknown', reasonCode: 'insufficient_evidence',
      explanation: 'The prior “packet” label cannot discharge the complete obligation.', manuscriptEvidence: [],
      priorFindingRef: { reportHash: f.prior.reportHash, findingId: f.prior.findingId, quote: 'packet' } }] }
    const result = inspectContinuityV4(JSON.stringify(wire), { ...f.frozen, manifest, bodies })
    expect(result.complete).toBe(true); expect(result.terminalReview?.factCoverage?.complete).toBe(false)
    expect(result.terminalReview?.factCoverage?.dispositions[0].sourceEvidence).toEqual([])
  })
})
