import { describe, expect, it } from 'vitest'
import { manualRepairFixture } from '../support/manual-review-repair-fixture.js'
import { buildContinuityReviewManifest, inspectContinuityV4, validateStoredContinuityV4Projection, buildContinuityInvalidRowRepair,
  continuityReviewV4Request } from '../../api/lib/agent/continuity-review-v4.js'
import { manualReviewRepairOperationId, validManualFindingDispositions } from '../../api/lib/agent/manual-review-repair-contract.js'
import { submitManualReviewRepairSchema } from '../../shared/contracts/manual-review-repair.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe('explicit one-request complete continuity repair contract', () => {
  it('independently binds all 45 facts, 25 proofs, both old open loops, pending emotion, two semantic checks and all seven opinions', () => {
    const f = manualRepairFixture(), before = JSON.stringify(f), raw = JSON.stringify(f.wire)
    const inspected = inspectContinuityV4(raw, f.frozen)
    expect(inspected.complete, JSON.stringify(inspected.parsed?.diagnostics)).toBe(true)
    expect(inspected.terminalReview?.verdicts).toHaveLength(45)
    expect(inspected.terminalReview?.factCoverage?.complete).toBe(true)
    expect(inspected.terminalReview?.proposals?.dispositions).toMatchObject([{ outcome: 'unknown' }])
    expect(validateStoredContinuityV4Projection(inspected.audit, f.content, f.context)?.complete).toBe(true)
    expect(buildContinuityInvalidRowRepair(inspected)).toBeNull()
    expect(JSON.stringify(f)).toBe(before)
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(raw)
    const request = continuityReviewV4Request(f.frozen, 'Review the original chapter.', 'Both complete old responses remain read-only.')
    expect(request.system).toContain('不要求本章解决谜题')
    expect(request.system).toContain('旧unknown不得自动')
    expect(request.system).toContain('finding.reason必须逐字等于原finding.evidence')
    expect(request.system).toContain('缩写、改述或改变判断必须用replace')
    expect(JSON.parse(request.content).originalFindings).toHaveLength(7)
  })
  it.each(['missing', 'duplicate', 'invented', 'missing_evidence', 'bad_source', 'retract_link', 'missing_replace', 'unbound_confirm'] as const)('rejects %s original disposition without selecting a good fragment', kind => {
    const f = manualRepairFixture(), wire: Record<string, unknown> = structuredClone(f.wire)
    const decisions = wire.originalFindingDispositions as Array<Record<string, unknown>>
    if (kind === 'missing') decisions.pop()
    if (kind === 'duplicate') decisions[6] = decisions[0]
    if (kind === 'invented') decisions[6].index = 7
    if (kind === 'missing_evidence') decisions[0].sourceEvidence = []
    if (kind === 'bad_source') decisions[0].sourceEvidence = [{ segmentId: 'c999' }]
    if (kind === 'retract_link') decisions[0].findingId = 'f0'
    if (kind === 'missing_replace') decisions[0].action = 'replace'
    if (kind === 'unbound_confirm') { decisions[0].action = 'confirm'; decisions[0].findingId = 'f0' }
    const result = inspectContinuityV4(JSON.stringify(wire), f.frozen)
    expect(result.complete).toBe(false)
    expect(buildContinuityInvalidRowRepair(result)).toBeNull()
  })
  it('preserves valid coverage UNKNOWN as an honest blocker rather than a format retry or automatic alias match', () => {
    const f = manualRepairFixture()
    const wire = { ...f.wire, terminalDispositions: f.wire.terminalDispositions.map(row => ({ obligationIndex: row.obligationIndex, outcome: 'unknown', reason: 'The mapping is not independently established.', sourceEvidence: [] })) }
    const inspected = inspectContinuityV4(JSON.stringify(wire), f.frozen)
    expect(inspected.complete).toBe(true)
    expect(inspected.terminalReview?.factCoverage?.complete).toBe(false)
    expect(inspected.terminalReview?.supported).toBe(false)
    expect(buildContinuityInvalidRowRepair(inspected)).toBeNull()
  })
  it.each(['body', 'candidate', 'source', 'raw', 'disposition'] as const)('rejects stored %s drift on complete replay', kind => {
    const f = manualRepairFixture(), audit = structuredClone(inspectContinuityV4(JSON.stringify(f.wire), f.frozen).audit)
    if (kind === 'body') audit.continuityV4.frozen.bodies.current += ' Changed.'
    if (kind === 'candidate') audit.continuityV4.frozen.candidate.exitState.knowledge = ['Changed.']
    if (kind === 'source') audit.continuityV4.frozen.bodies.previous = 'Changed.'
    if (kind === 'raw') audit.rawResponse.content = JSON.stringify('{}')
    if (kind === 'disposition') audit.continuityV4.manifest.manualRepair!.originalFindings.pop()
    expect(validateStoredContinuityV4Projection(audit, f.content, f.context)).toBeNull()
  })
  it('requires the exact author intent and keeps operation identity independent of quote refresh', () => {
    const f = manualRepairFixture(), identity = { candidate: f.candidate, bodies: f.frozen.bodies }
    expect(manualReviewRepairOperationId('task', 'f'.repeat(64), identity)).toBe(manualReviewRepairOperationId('task', 'f'.repeat(64), structuredClone(identity)))
    for (const intent of ['continue', 'authorContinue', 'protocol_upgrade', undefined]) expect(submitManualReviewRepairSchema.safeParse({ intent, quoteToken: 'token' }).success).toBe(false)
    expect(submitManualReviewRepairSchema.safeParse({ intent: 'repair_failed_review_once', quoteToken: 'token', modelTier: 'speed' }).success).toBe(false)
    expect(() => buildContinuityReviewManifest({ ...f.frozen.manifest, bodies: f.frozen.bodies, candidate: f.candidate,
      manualRepair: { ...f.manualRepair, originalTaskId: 'other-task' } })).toThrow()
  })
  it('binds confirm and replace to real final findings while keeping explanatory quotes out of manuscript evidence', () => {
    const f = manualRepairFixture(), original = { signal: 'object', severity: 'warning', evidence: f.content, suggestion: 'Inspect the complete source.', sourceEvidence: [{ source: 'current', quote: f.content }] }
    const manual = { ...f.manualRepair, originalFindings: [original] }
    const findings = [{ findingId: 'f0', ...original, reason: original.evidence, sourceEvidence: [{ segmentId: 'c0' }] }]
    const decision = { index: 0, action: 'confirm', reason: 'The independent evidence supports the same opinion.', sourceEvidence: [{ segmentId: 'c0' }], findingId: 'f0' }
    expect(validManualFindingDispositions(manual, [decision], findings, f.frozen.bodies)).toBe(true)
    expect(validManualFindingDispositions(manual, [{ ...decision, action: 'replace' }], findings, f.frozen.bodies)).toBe(true)
    expect(validManualFindingDispositions(manual, [decision], [{ ...findings[0], severity: 'error' }], f.frozen.bodies)).toBe(false)
    expect(validManualFindingDispositions(manual, [decision], [{ ...findings[0], reason: 'A changed opinion using the same references.' }], f.frozen.bodies)).toBe(false)
    expect(validManualFindingDispositions(manual, [{ ...decision, action: 'replace' }], [{ ...findings[0], reason: 'A changed opinion using the same references.' }], f.frozen.bodies)).toBe(true)
    expect(runtimeJson(f.manualRepair).hash).not.toBe(runtimeJson(manual).hash)
  })
})
