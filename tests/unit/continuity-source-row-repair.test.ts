import { describe, expect, it, vi } from 'vitest'
import { continuityRecoveryFixture } from '../helpers/continuity-recovery-fixture.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { continuityResponseRepairPlan, applyContinuitySparseRepair } from '../../api/lib/agent/continuity-response-repair.js'
import { applyContinuityReassessment, runContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { currentTerminalReview, terminalReviewFailure } from '../../api/lib/agent/terminal-state-review.js'
import { terminalReportRecoveryResult } from '../../api/lib/agent/terminal-report-recovery.js'

function semanticFixture() {
  const f = continuityRecoveryFixture(), bad = structuredClone(f.wire)
  Object.assign(bad.terminalVerdicts[2].sourceEvidence[0], { quote: 'A fabricated closing quotation.' })
  Object.assign(bad.terminalDispositions[1], { sourceEvidence: [{ segmentId: 'c0', quote: 'A second invented quote.' }] })
  Object.assign(bad.proposalDispositions[5], { outcome: 'replaced', candidateIndex: 2, sourceEvidence: [{ segmentId: 'c0', quote: 'A third invented quote.' }] })
  // This validly addressed disposition depends on the candidate with bad evidence.
  Object.assign(bad.proposalDispositions[7], { outcome: 'replaced', candidateIndex: 2, sourceEvidence: [{ segmentId: 'c0', quote: 'The packet remains sealed.' }] })
  const raw = JSON.stringify(bad), original = inspectContinuityResponse(raw, f.bodies, true, 8, f.candidate, undefined, { responseContract: 3 })
  const plan = continuityResponseRepairPlan(original, f.bodies, 2)!
  const patch = { baseResponseHash: original.audit.contentHash, corrections: plan.bad.map(row => ({ table: row.table, address: row.address,
    replacement: { ...(bad[row.table] as Array<Record<string, unknown>>)[row.index], sourceEvidence: [{ segmentId: 'c0' }] } })) }
  return { ...f, bad, raw, original, plan, patch }
}

describe('protocol5 repairs strict source failures inside the original second slot', () => {
  it('collects all semantic citation failures and dependent positive rows, preserving protocol4', () => {
    const f = semanticFixture()
    expect(continuityResponseRepairPlan(f.original, f.bodies)).toBeNull()
    expect(f.plan.bad.map(({ table, address }) => ({ table, address }))).toEqual([
      { table: 'terminalVerdicts', address: 2 }, { table: 'terminalDispositions', address: 1 },
      { table: 'proposalDispositions', address: 5 }, { table: 'proposalDispositions', address: 7 },
    ])
    expect(f.original.complete).toBe(false)
    expect(f.plan.diagnostics.map(row => row.code)).toEqual(expect.arrayContaining(['evidence_quote_invalid', 'fact_disposition_evidence_invalid', 'proposal_evidence_invalid']))
  })
  it('binds only independently selected frozen IDs and replays the two raw responses without certifying unknown facts', () => {
    const f = semanticFixture(), original = JSON.stringify(f.original), raw = JSON.stringify(f.patch)
    const result = applyContinuityReassessment(f.original, raw, f.bodies, 5)
    expect(result.complete).toBe(true)
    expect(result.audit).toMatchObject({ responseProjection: { version: 2 }, reassessment: { kind: 'sparse_table_repair', rawResponse: { content: JSON.stringify(raw) } } })
    const projected = JSON.parse(JSON.parse(result.audit.rawResponse.content))
    expect(projected.terminalVerdicts[2].sourceEvidence).toEqual([{ segmentId: 'c0', quote: f.content }])
    expect(projected.terminalDispositions[1].outcome).toBe('unknown')
    expect(projected.terminalDispositions).toHaveLength(18)
    expect(projected.proposalDispositions).toHaveLength(13)
    expect(projected.findings).toEqual(f.bad.findings)
    expect(projected.semanticChecks).toEqual(f.bad.semanticChecks)
    const validation = { independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: result.audit }
    expect(currentTerminalReview(validation, f.content, f.context)).toMatchObject({ supported: false, factCoverage: { complete: false }, proposals: { complete: false } })
    expect(terminalReviewFailure(validation, f.content, f.context)).toMatchObject({ reviewOutcome: 'decision_required', reviewCompleted: true })
    expect(terminalReviewFailure(validation, f.content, f.context)).not.toHaveProperty('failureCode')
    expect(JSON.stringify(f.original)).toBe(original)
    const audit = structuredClone(result.audit) as typeof result.audit & { responseProjection: { version: number } }
    audit.responseProjection.version = 1
    expect(currentTerminalReview({ ...validation, continuityCriticResponse: audit }, f.content, f.context)).toBeNull()
  })
  it.each(['unknown-source', 'quote', 'missing', 'duplicate', 'unmasked', 'base'])('rejects %s and never silently repairs raw evidence', kind => {
    const f = semanticFixture(), patch = structuredClone(f.patch)
    if (kind === 'unknown-source') patch.corrections[0].replacement.sourceEvidence[0].segmentId = 'c999'
    if (kind === 'quote') Object.assign(patch.corrections[0].replacement.sourceEvidence[0], { quote: 'Model copied another quote.' })
    if (kind === 'missing') patch.corrections.pop()
    if (kind === 'duplicate') patch.corrections[1] = structuredClone(patch.corrections[0])
    if (kind === 'unmasked') patch.corrections[0].address = 0
    if (kind === 'base') patch.baseResponseHash = 'f'.repeat(64)
    expect(() => applyContinuitySparseRepair(f.original, JSON.stringify(patch), f.bodies, 2)).toThrow()
    expect(f.original.complete).toBe(false)
  })
  it('reports an authenticated pending rejection as failed, while preserving ordinary evidence uncertainty', () => {
    const f = semanticFixture(), validation = { independentCheck: 'unavailable', terminalCandidate: f.candidate, continuityCriticResponse: f.original.audit }
    expect(terminalReportRecoveryResult(validation, f.content, f.context, null)).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE', reviewCompleted: false })
    expect(currentTerminalReview(validation, f.content, f.context)).toBeNull()
  })
  it.each(['billing', 'provider', 'slot'] as const)('does not claim or dispatch a second request with unknown %s', async kind => {
    const f = semanticFixture(), claim = vi.fn(async () => true), dispatch = vi.fn(async () => ({ content: JSON.stringify(f.patch), complete: true }))
    const result = await runContinuityReassessment({ original: f.original, bodies: f.bodies, system: 'Independent reviewer.', content: 'Frozen source.', reassessmentProtocol: 5,
      billingKnown: kind !== 'billing', providerComplete: kind !== 'provider', slotUsed: kind === 'slot', signal: new AbortController().signal, assertCurrent: async () => {}, claim, dispatch })
    expect(result).toBe(f.original); expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })
  it('uses exactly one claimed second request and retains failed5 diagnostics when its response remains invalid', async () => {
    const f = semanticFixture(), dispatch = vi.fn(async () => ({ content: f.raw, complete: true })), claim = vi.fn(async () => true)
    const result = await runContinuityReassessment({ original: f.original, bodies: f.bodies, system: 'Independent reviewer.', content: 'Frozen source.', reassessmentProtocol: 5,
      billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal, assertCurrent: async () => {}, claim, dispatch })
    expect(result).toMatchObject({ complete: false, audit: { reassessment: { protocol: 5, kind: 'sparse_table_repair_failed' } } })
    expect(claim).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce()
  })
})
