import { describe, expect, it, vi } from 'vitest'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildContinuityReviewManifest, inspectContinuityV4, applyContinuityV4Repair, buildContinuityInvalidRowRepair,
  continuityReviewV4Request, validateStoredContinuityV4Projection } from '../../api/lib/agent/continuity-review-v4.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { continuitySubjectIdentity, continuityWorkSubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { nextReviewAction, type ReviewTransition } from '../../shared/review-lifecycle.js'
import { stageTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'

function fixture() {
  const content = 'The packet is sealed. The guard knows the code.'
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The guard knows the code.'] } })
  const context = { protocol: 2 as const, verdictProtocol: 6 as const, spanAddressProtocol: 2 as const,
    current: { id: 'chapter', revision: 4, orderIndex: 3, contentHash: runtimeJson({ content }).hash }, previous: null,
    factCoverage: { version: 2 as const, taskId: 'task', chapterId: 'chapter', obligations: [] } }
  const bodies = { previous: null, current: content, terminalEvidence: context }, sourceScope = { currentOrderIndex: 3, previous: [] }
  const manifest = buildContinuityReviewManifest({ subject: { userId: 'user', novelId: 'novel', taskId: 'task', targetType: 'story_compilation',
    targetId: 'compilation', chapterId: 'chapter', revision: 4 }, bodies, candidate, sourceScope,
    sourceHash: null, sourceVersions: { current: context.current, previous: null }, verifiedCoverage: context.factCoverage, draftProposals: null })
  const frozen = { manifest, bodies, candidate, sourceScope }
  const wire = { findings: [] as unknown[], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'All source material reviewed.', findingIds: [] })),
    terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [] }
  return { content, candidate, context, bodies, sourceScope, manifest, frozen, wire }
}

describe('continuity v4 one manifest and four authenticated projections', () => {
  it('replays all consumers through the common manifest reader, without asking the model to calculate a hash', () => {
    const f = fixture(), raw = JSON.stringify(f.wire), result = inspectContinuityV4(raw, f.frozen)
    expect(result.complete).toBe(true)
    expect(Object.values(result.audit.continuityV4.projections!).map(p => p.valid)).toEqual([true, true, true, true])
    expect(validateStoredContinuityV4Projection(result.audit, f.content, f.context)?.audit).toEqual(result.audit)
    const validation = { independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: result.audit }
    expect(validateStoredContinuityV4Projection(result.audit, f.content, f.context)?.terminalReview).toMatchObject({ supported: true })
    expect(currentTerminalReview(validation, f.content, f.context)).toBeNull()
    expect(currentTerminalReview(validation, f.content, f.context, { taskId: 'task', userId: 'user', novelId: 'novel', compilationId: 'compilation',
      preparedContext: {}, reviewAuthority: { authenticated: true } })).toBeNull()
    const prompt = continuityReviewV4Request(f.frozen, 'Edit chapter three.', 'Frozen context')
    expect(prompt.content).not.toContain(f.manifest.hash)
    expect(prompt.system).toContain('reason是你的解释')
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
  })
  it('treats reason as an explanation and explicit references as evidence, keeping frozen parser8 strict', () => {
    const f = fixture(), reason = 'The earlier opinion quoted “an invented phrase”; that is an explanation, not a source.'
    f.wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'warning', reason, suggestion: 'Consider the pacing.', sourceEvidence: [{ segmentId: 'c0' }] })
    const result = inspectContinuityV4(JSON.stringify(f.wire), f.frozen)
    expect(result.complete).toBe(true)
    expect(result.findings[0].suggestion).toContain(reason)
    expect(result.findings[0].sourceEvidence).toEqual([{ source: 'current', quote: f.content }])
    const old = { ...f.wire, findings: [{ signal: 'object', severity: 'warning', evidence: '当前“an invented phrase”', suggestion: 'Consider the pacing.', sourceEvidence: [{ segmentId: 'c0' }] }],
      semanticChecks: f.wire.semanticChecks.map(({ findingIds: _ids, ...row }) => ({ ...row, findingIndexes: [] })) }
    expect(inspectContinuityResponse(JSON.stringify(old), f.bodies, true, 8, f.candidate, f.sourceScope, { responseContract: 3 }).complete).toBe(false)
  })
  it('preserves a legitimate unknown verdict as a valid independent conclusion, never a repair mask', () => {
    const f = fixture(); f.wire.terminalVerdicts[0].verdict = 'unknown'
    f.wire.terminalVerdicts[0].sourceEvidence = []
    const result = inspectContinuityV4(JSON.stringify(f.wire), f.frozen)
    expect(result.complete).toBe(true); expect(result.terminalReview?.supported).toBe(false)
    expect(() => runtimeJson(result.audit)).not.toThrow()
    expect(validateStoredContinuityV4Projection(runtimeJson(result.audit).value, f.content, f.context)?.terminalReview?.supported).toBe(false)
    expect(buildContinuityInvalidRowRepair(result)).toBeNull()
  })
  it.each(['replaced', 'retracted', 'unknown'] as const)('binds only explicit frozen current addresses for %s draft dispositions', outcome => {
    const f = fixture(), old = terminalCandidateSchema.parse({ exitState: { objects: ['The packet is open.'] } })
    const staged = stageTerminalProposals({ preparedContext: {}, identity: { taskId: 'task', chapterId: 'chapter', bodyHash: f.context.current.contentHash,
      sourceHash: runtimeJson({ previous: null }).hash }, auditHash: 'a'.repeat(64), base: old, candidate: f.candidate, verifiedFactIds: [] })!
    const obligation = { id: terminalFactId('objects', 'The packet was open.'), field: 'objects' as const, claim: 'The packet was open.' }
    const context = { ...f.context, proposalChanges: staged.changes!, factCoverage: { ...f.context.factCoverage, obligations: [obligation] } }
    const bodies = { ...f.bodies, terminalEvidence: context }
    const manifest = buildContinuityReviewManifest({ ...f.manifest, bodies, candidate: f.candidate,
      verifiedCoverage: context.factCoverage, draftProposals: context.proposalChanges })
    const frozen = { ...f.frozen, bodies, manifest }
    const wire = { ...f.wire, terminalDispositions: [{ obligationIndex: 0, outcome: 'ended', reason: 'The complete current body establishes the sealed state.', sourceEvidence: [{ segmentId: 'c0' }] }],
      proposalDispositions: [{ proposalIndex: 0, outcome, reason: 'The independent reviewer preserves the full draft disposition.',
        sourceEvidence: outcome === 'unknown' ? [] : [{ segmentId: 'c0' }], ...(outcome === 'replaced' ? { candidateIndex: 0 } : {}) }] }
    const raw = JSON.stringify(wire), inspected = inspectContinuityV4(raw, frozen)
    expect(inspected.complete, JSON.stringify(inspected.parsed?.diagnostics)).toBe(true)
    expect(inspected.terminalReview?.supported).toBe(outcome !== 'unknown')
    expect(inspected.terminalReview?.factCoverage?.dispositions[0].sourceEvidence).toEqual([{ segmentId: 'c0', quote: f.content }])
    expect(inspected.terminalReview?.proposals?.dispositions[0].sourceEvidence).toEqual(outcome === 'unknown' ? [] : [{ segmentId: 'c0', quote: f.content }])
    expect(inspected.parsed!.record).toEqual(wire)
    expect(inspected.audit.continuityV4.projections!.draftProposals.value).toMatchObject({ rows: wire.proposalDispositions })
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(raw)
    expect(validateStoredContinuityV4Projection(runtimeJson(inspected.audit).value, f.content, context)?.audit).toEqual(inspected.audit)
    for (const ref of [{ segmentId: 'p0' }, { segmentId: 't0' }, { segmentId: 'c999' }, { segmentId: 'c0', quote: f.content }]) {
      const invalid = { ...wire, proposalDispositions: [{ ...wire.proposalDispositions[0], sourceEvidence: [ref] }] }
      expect(inspectContinuityV4(JSON.stringify(invalid), frozen).complete).toBe(false)
    }
  })
  it('repairs only the exact invalid row and preserves the actual first and second responses', () => {
    const f = fixture(); f.wire.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'c999' }]
    const raw = JSON.stringify(f.wire), first = inspectContinuityV4(raw, f.frozen), before = JSON.stringify(first.audit)
    expect(first.complete).toBe(false)
    const plan = buildContinuityInvalidRowRepair(first)!
    expect(plan.mask).toEqual([{ table: 'terminalVerdicts', index: 0 }])
    const second = JSON.stringify({ corrections: [{ table: 'terminalVerdicts', index: 0, value: { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] } }] })
    const result = applyContinuityV4Repair(first, second, true)
    expect(result.complete).toBe(true)
    expect(result.audit.rawResponse.content).toBe(JSON.stringify(raw))
    expect(result.audit.continuityV4.repair?.response.content).toBe(JSON.stringify(second))
    expect(result.parsed!.record.semanticChecks).toEqual(f.wire.semanticChecks)
    expect(validateStoredContinuityV4Projection(result.audit, f.content, f.context)?.complete).toBe(true)
    expect(JSON.stringify(first.audit)).toBe(before)
  })
  it.each(['body', 'source', 'candidate', 'owner', 'manifest', 'projection', 'first', 'second', 'mask', 'marker'] as const)('rejects stored %s tampering', kind => {
    const f = fixture(); f.wire.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'c999' }]
    const first = inspectContinuityV4(JSON.stringify(f.wire), f.frozen)
    const second = JSON.stringify({ corrections: [{ table: 'terminalVerdicts', index: 0, value: { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] } }] })
    const audit = structuredClone(applyContinuityV4Repair(first, second, true).audit), marker = audit.continuityV4
    if (kind === 'body') marker.frozen.bodies.current += ' Changed.'
    if (kind === 'source') marker.frozen.sourceScope.currentOrderIndex++
    if (kind === 'candidate') marker.frozen.candidate.exitState.knowledge.push('New claim.')
    if (kind === 'owner') marker.frozen.manifest.subject.userId = 'other'
    if (kind === 'manifest') marker.manifest.catalogHash = 'f'.repeat(64)
    if (kind === 'projection') marker.projections!.currentTerminal.valid = false
    if (kind === 'first') marker.first.content = JSON.stringify('{}')
    if (kind === 'second') marker.repair!.response.content = JSON.stringify('{}')
    if (kind === 'mask') marker.repair!.plan.mask = []
    if (kind === 'marker') Object.assign(audit, { continuityV4: undefined })
    expect(validateStoredContinuityV4Projection(audit, f.content, f.context)).toBeNull()
  })
  it.each(['duplicate-key', 'duplicate-fact', 'missing-row', 'extra-table', 'missing-finding-address'] as const)('does not guess an ambiguous %s repair', kind => {
    const f = fixture()
    if (kind === 'duplicate-fact') f.wire.terminalVerdicts.push(structuredClone(f.wire.terminalVerdicts[0]))
    if (kind === 'missing-row') f.wire.terminalVerdicts = []
    if (kind === 'extra-table') Object.assign(f.wire, { arbitrary: [] })
    if (kind === 'missing-finding-address') f.wire.findings = [{ signal: 'object', severity: 'warning', reason: 'Unbound.' }]
    const raw = kind === 'duplicate-key' ? JSON.stringify(f.wire).replace('"findings":[]', '"findings":[{"signal":"object"}],"findings":[]') : JSON.stringify(f.wire)
    const result = inspectContinuityV4(raw, f.frozen)
    expect(result.complete).toBe(false); expect(buildContinuityInvalidRowRepair(result)).toBeNull()
  })
  it.each(['billing', 'provider', 'slot', 'cancel'] as const)('does not dispatch an invalid-row repair with %s unresolved', async kind => {
    const f = fixture(); f.wire.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'c999' }]
    const original = inspectContinuityV4(JSON.stringify(f.wire), f.frozen), controller = new AbortController()
    if (kind === 'cancel') controller.abort()
    const claim = vi.fn(async () => true), dispatch = vi.fn(async () => ({ content: '{}', complete: true }))
    const result = await runContinuityReassessment({ original, bodies: f.bodies, system: 'Frozen', content: 'Frozen', reassessmentProtocol: 6,
      billingKnown: kind !== 'billing', providerComplete: kind !== 'provider', slotUsed: kind === 'slot', signal: controller.signal, assertCurrent: async () => {}, claim, dispatch })
    expect(result).toBe(original); expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })
  it.each([21, 22] as const)('native frozen work%s cannot buy the same subject by protocol or focus changes', version => {
    const f = fixture(), work = { kind: 'check', version, chapter: { id: 'chapter', revision: 4 }, compiler: { id: 'compilation' },
      sourceBodies: f.bodies, terminalCandidate: f.candidate, sourceScope: f.sourceScope, criticInput: 'Old focus', reassessmentProtocol: version === 21 ? 5 : 6 }
    const key = continuityWorkSubjectIdentity(work)
    expect(key).not.toBeNull()
    expect(continuityWorkSubjectIdentity({ ...work, version: 22, reassessmentProtocol: 6, criticInput: 'New focus', continuityManifest: f.manifest })).toBe(key)
    expect(continuityWorkSubjectIdentity({ ...work, chapter: { id: 'other', revision: 4 } })).not.toBe(key)
    const changed = { ...f.bodies, terminalEvidence: { ...f.context, factCoverage: { ...f.context.factCoverage, version: 1 as const } } }
    expect(continuityWorkSubjectIdentity({ ...work, sourceBodies: changed })).toBe(key)
  })
  it('does not create a different subject by changing parser, rendering, callId or row ordering', () => {
    const f = fixture(), input = { chapterId: 'chapter', revision: 4, targetType: 'story_compilation', targetId: 'compilation', bodies: f.bodies, terminalCandidate: f.candidate, sourceScope: f.sourceScope }
    const key = continuitySubjectIdentity(input)
    expect(key).not.toBeNull()
    expect(continuitySubjectIdentity({ ...input, parserVersion: 9, content: 'Different guidance', callId: 'new', continuityManifest: f.manifest })).toBe(key)
    expect(continuitySubjectIdentity({ ...input, terminalCandidate: terminalCandidateSchema.parse({ exitState: { knowledge: ['A different fact.'] } }) })).not.toBe(key)
  })
})

const transition: ReviewTransition = { ownerCurrent: true, cancelled: false, contextCurrent: true, reserved: true, rawPresent: true,
  providerComplete: true, billingKnown: true, providerFailed: false, complete: true, sameFailedSubject: false,
  repairAvailable: false, repairConsumed: false, newRequestAllowed: false }
it.each([
  [{ ownerCurrent: false }, 'stale', 'pause'], [{ cancelled: true }, 'stale', 'pause'], [{ contextCurrent: false }, 'stale', 'pause'],
  [{ billingKnown: false, sameFailedSubject: true }, 'provider_unresolved', 'pause'], [{ rawPresent: false }, 'provider_unresolved', 'pause'],
  [{ providerComplete: false }, 'provider_unresolved', 'pause'], [{ providerFailed: true }, 'provider_failed', 'pause'],
  [{ providerFailed: true, rawPresent: false }, 'provider_failed', 'pause'],
  [{ providerFailed: true, rawPresent: false, billingKnown: false }, 'provider_unresolved', 'pause'],
  [{ sameFailedSubject: true }, 'decision_required', 'decision'], [{}, 'complete', 'reuse'],
  [{ complete: false, repairAvailable: true }, 'evidence_repair_required', 'repair'],
  [{ complete: false, repairAvailable: true, repairConsumed: true }, 'evidence_repair_required', 'pause'],
  [{ complete: false }, 'evidence_repair_required', 'pause'],
] as const)('shares strict review transition %j', (change, outcome, action) => {
  expect(nextReviewAction({ ...transition, ...change })).toEqual({ outcome, action })
})
