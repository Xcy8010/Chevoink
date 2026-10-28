import { describe, expect, it, vi } from 'vitest'
import { continuityRecoveryFixture } from '../helpers/continuity-recovery-fixture.js'
import { applyContinuitySparseRepair, continuityResponseRepairPlan, continuitySparseRepairRequest } from '../../api/lib/agent/continuity-response-repair.js'
import { applyContinuityReassessment, runContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalReportCorrection, terminalReportRecoveryResult } from '../../api/lib/agent/terminal-report-recovery.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe('production-shaped invalid continuity response recovers without false passage', () => {
  it('repairs only the three bad addressed rows; keeps all 18 unknown facts/13 proposals and both real replies', () => {
    const f = continuityRecoveryFixture(), before = JSON.stringify(f.original), plan = continuityResponseRepairPlan(f.original, f.bodies)!
    expect(f.original.complete).toBe(false)
    expect(plan.bad.map(({ address }) => address)).toEqual([1, 3, 9])
    expect(plan.replacements.map(row => row.candidateIndex)).toEqual([2, 3])
    const request = continuitySparseRepairRequest('Independent editor.', 'Frozen source.', f.original, f.bodies)!
    expect(request.content).not.toContain(f.raw)
    expect(request.content).toContain('"candidateIndex":2')
    expect(request.system).toContain('corrections')
    const raw = JSON.stringify(f.patch), result = applyContinuityReassessment(f.original, raw, f.bodies, 4)
    expect(result).toMatchObject({ complete: true, audit: { reassessment: { kind: 'sparse_table_repair', original: f.original.audit,
      rawResponse: { content: JSON.stringify(raw) }, projection: { mask: [1, 3, 9].map(address => ({ table: 'terminalDispositions', address })) } } } })
    const projected = JSON.parse(JSON.parse(result.audit.rawResponse.content))
    expect(projected).toEqual(f.wire)
    expect(projected.findings).toEqual(f.bad.findings)
    expect(projected.semanticChecks).toEqual(f.bad.semanticChecks)
    expect(projected.terminalVerdicts).toEqual(f.bad.terminalVerdicts)
    expect(projected.proposalDispositions).toEqual(f.bad.proposalDispositions)
    const review = currentTerminalReview({ independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: result.audit }, f.content, f.context)
    expect(review).toMatchObject({ supported: false, factCoverage: { complete: false }, proposals: { complete: false } })
    expect(review?.factCoverage?.dispositions).toHaveLength(18)
    expect(JSON.stringify(f.original)).toBe(before)
  })
  it.each(['wrong-base', 'missing', 'duplicate', 'wrong-address', 'transient-target', 'extra-opinion', 'duplicate-key', 'two-objects', 'truncated'])('rejects an unsafe sparse reply: %s', kind => {
    const f = continuityRecoveryFixture(), patch = structuredClone(f.patch)
    if (kind === 'wrong-base') patch.baseResponseHash = 'b'.repeat(64)
    if (kind === 'missing') patch.corrections.pop()
    if (kind === 'duplicate') patch.corrections[1] = structuredClone(patch.corrections[0])
    if (kind === 'wrong-address') patch.corrections[0].replacement.obligationIndex = 2
    if (kind === 'transient-target') Object.assign(patch.corrections[0].replacement, { outcome: 'replaced', candidateIndex: 0 })
    if (kind === 'extra-opinion') Object.assign(patch, { findings: [] })
    let raw = JSON.stringify(patch)
    if (kind === 'duplicate-key') raw = raw.replace('"corrections":', '"corrections":[],"corrections":')
    if (kind === 'two-objects') raw += '{}'
    if (kind === 'truncated') raw = raw.slice(0, -1)
    expect(() => applyContinuitySparseRepair(f.original, raw, f.bodies)).toThrow()
    expect(f.validation.independentCheck).toBe('unavailable')
  })
  it.each(['first', 'second', 'projection', 'nested-projection', 'marker', 'wrapper'])('replays the provider pair at every commit/proof read and refuses tampered %s', kind => {
    const f = continuityRecoveryFixture(), result = applyContinuityReassessment(f.original, JSON.stringify(f.patch), f.bodies, 4)
    const audit = JSON.parse(JSON.stringify(result.audit))
    if (kind === 'first') audit.reassessment.original.rawResponse.content = JSON.stringify(f.raw + ' changed')
    if (kind === 'second') audit.reassessment.rawResponse.content = JSON.stringify(JSON.stringify({ ...f.patch, baseResponseHash: 'b'.repeat(64) }))
    if (kind === 'projection') audit.reassessment.projection.mask = []
    if (kind === 'nested-projection') delete audit.reassessment.projection
    if (kind === 'marker') delete audit.responseProjection
    if (kind === 'wrapper') delete audit.reassessment
    expect(currentTerminalReview({ independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: audit }, f.content, f.context)).toBeNull()
  })
  it('gives the actual contract failure actionable recovery while retaining every original uncertain opinion', () => {
    const f = continuityRecoveryFixture(), before = JSON.stringify(f.validation)
    const correction = terminalReportCorrection(f.validation, f.content, f.context, null)!
    expect(correction.paths).toHaveLength(31)
    expect(correction.guidance).toContain('"reported"')
    expect(correction.guidance).toContain('"outcome":"unknown"')
    expect(correction.guidance).toContain('inheritedProofs')
    expect(terminalReportRecoveryResult(f.validation, f.content, f.context, null)).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE', reviewCompleted: false, summary: '连续性检查失败' })
    expect(currentTerminalReview(f.validation, f.content, f.context)).toBeNull()
    expect(JSON.stringify(f.validation)).toBe(before)
  })
  it.each(['ordinary-missing', 'ordinary-duplicate', 'unknown-source', 'invented-quote', 'transient-inheritance', 'raw-hash', 'body', 'context'])('never treats invalid candidate evidence as a validated advisory input: %s', kind => {
    const f = continuityRecoveryFixture(), bad = structuredClone(f.bad)
    if (kind === 'ordinary-missing') bad.terminalVerdicts.pop()
    if (kind === 'ordinary-duplicate') bad.terminalVerdicts[1] = structuredClone(bad.terminalVerdicts[0])
    if (kind === 'unknown-source') bad.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'c999' }]
    if (kind === 'invented-quote') Object.assign(bad.terminalVerdicts[0].sourceEvidence[0], { quote: 'Invented source statement.' })
    if (kind === 'transient-inheritance') bad.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'p0' }]
    const inspected = inspectContinuityResponse(JSON.stringify(bad), f.bodies, true, 8, f.candidate, undefined, { responseContract: 3 })
    const validation = { ...f.validation, continuityCriticResponse: structuredClone(inspected.audit) }
    if (kind === 'raw-hash') validation.continuityCriticResponse.contentHash = 'b'.repeat(64)
    if (kind === 'body') f.content += ' changed'
    if (kind === 'context') f.context.current.revision++
    const correction = terminalReportCorrection(validation, f.content, f.context, null)
    if (kind === 'invented-quote') {
      // An authenticated bad quote is repairable report data, never validated evidence.
      expect(correction?.issues).toContainEqual({ path: 'exitState.action', reason: 'report_reference_invalid' })
      expect(terminalReportRecoveryResult(validation, f.content, f.context, null)?.outcome).toBe('failed')
      expect(currentTerminalReview(validation, f.content, f.context)).toBeNull()
    } else expect(correction).toBeNull()
  })
  it.each(['billing', 'provider', 'slot'] as const)('keeps one existing paid recovery slot and never dispatches for unknown %s', async kind => {
    const f = continuityRecoveryFixture(), claim = vi.fn(async () => true), dispatch = vi.fn(async () => ({ content: JSON.stringify(f.patch), complete: true }))
    const result = await runContinuityReassessment({ original: f.original, bodies: f.bodies, system: 'Editor.', content: 'Source.', reassessmentProtocol: 4,
      billingKnown: kind !== 'billing', providerComplete: kind !== 'provider', slotUsed: kind === 'slot', signal: new AbortController().signal, assertCurrent: async () => {}, claim, dispatch })
    expect(result).toBe(f.original)
    expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })
  it('retains explicit protocol4 diagnostics when the only second reply is still malformed; no third request', async () => {
    const f = continuityRecoveryFixture(), dispatch = vi.fn(async () => ({ content: f.raw, complete: true }))
    const result = await runContinuityReassessment({ original: f.original, bodies: f.bodies, system: 'Editor.', content: 'Source.', reassessmentProtocol: 4,
      billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal, assertCurrent: async () => {}, claim: async () => true, dispatch })
    expect(result).toMatchObject({ complete: false, audit: { reassessment: { kind: 'sparse_table_repair_failed', protocol: 4, classification: 'invalid' } } })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(runtimeJson(f.original.audit).hash).not.toBe(runtimeJson(result.audit).hash)
    expect(terminalReportCorrection({ ...f.validation, continuityCriticResponse: result.audit }, f.content, f.context, null)).not.toBeNull()
  })
})
