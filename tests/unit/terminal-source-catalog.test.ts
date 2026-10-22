import { describe, expect, it } from 'vitest'
import { continuitySourceCatalog, continuitySourceInput } from '../../api/lib/agent/continuity-review-context.js'
import { terminalEvidenceContext, terminalSpanAuditVersion } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalQuoteRange } from '../../api/lib/agent/terminal-quote-range.js'
import { terminalCandidateSchema, terminalResponseFields, inspectTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { freshContinuityResponseContract, continuityReassessmentRequest } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateReplacementIssue } from '../../api/lib/agent/terminal-candidate-patch.js'
import { advanceTerminalCoverage, terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'

function fixture() {
  const early = 'Earlier chapter only. '.padEnd(345, 'E')
  const previous = 'The preceding chapter starts here. '.padEnd(400, 'P')
  const content = 'The reader remains at the control-room doorway.'
  const chapter = { id: 'chapter', revision: 8, orderIndex: 6, content }
  const source = { content: early + previous, preceding: [{ id: 'prior', revision: 2, orderIndex: 5,
    contentHash: runtimeJson({ content: previous }).hash, start: 0, end: previous.length,
    joinedStart: early.length, joinedEnd: early.length + previous.length }] } as unknown as Parameters<typeof terminalEvidenceContext>[1]
  const coverage = { version: 2 as const, taskId: 'task', chapterId: chapter.id, obligations: [] }
  const old = terminalEvidenceContext(chapter, source, 2, 1, coverage, 5)
  const context = terminalEvidenceContext(chapter, source, 2, 1, coverage, 5, 2)
  const bodies = { current: content, previous: early + previous, terminalEvidence: context }
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The preceding chapter starts here.'] } })
  const raw = (segmentId = 'p1', quote = 'The preceding chapter starts here.') => JSON.stringify({ findings: [],
    semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full-body review.', findingIndexes: [] })),
    terminalVerdicts: [{ path: 'exitState.knowledge.0', verdict: 'supported', sourceEvidence: [{ segmentId, quote }],
      inheritance: { priorEndState: 'established', currentState: 'unchanged' } }], terminalProofVerdicts: [] })
  return { early, previous, content, old, context, bodies, candidate, raw }
}

describe('request-owned terminal source catalog', () => {
  it('includes the exact legal chapter prefix with real offsets, preserving the old frozen projection', () => {
    const f = fixture()
    expect(f.old.previous!.segments.map(s => s.segmentId)).toEqual(['p2'])
    expect(f.context.previous!.segments.map(s => s.segmentId)).toEqual(['p1', 'p2'])
    expect(f.context.previous!.segments[0]).toMatchObject({ start: 345, end: 600 })
    expect(f.context.previous!.segments.map(s => s.quote).join('')).toBe(f.previous)
    const range = terminalQuoteRange({ segmentId: 'p1', quote: f.previous.slice(0, 280) }, f.context.previous!.segments)
    expect(range).toEqual({ start: 345, end: 625, segmentIds: ['p1', 'p2'] })
    expect(terminalQuoteRange({ segmentId: 'p0', quote: 'Earlier chapter only.' }, f.context.previous!.segments)).toBeNull()
  })

  it('uses the same legal enum for primary and reassessment while retaining broad prose sources', () => {
    const f = fixture(), catalog = continuitySourceCatalog(f.bodies)
    expect(catalog.continuitySources.some(s => s.segmentId === 'p0')).toBe(true)
    const ids = catalog.terminalSources.map(s => s.segmentId)
    expect(ids).toEqual(['c0', 'p1', 'p2'])
    const fields = terminalResponseFields(true, 5, ids)
    const verdict = JSON.parse(f.raw()).terminalVerdicts
    expect(fields.terminalVerdicts.safeParse(verdict).success).toBe(true)
    expect(fields.terminalVerdicts.safeParse(JSON.parse(f.raw('p0', 'Earlier chapter only.')).terminalVerdicts).success).toBe(false)
    for (const reassessment of [false, true]) {
      expect(freshContinuityResponseContract(reassessment, true, 5, f.bodies)).toContain('"enum":["c0","p1","p2"]')
    }
    const original = inspectContinuityResponse(f.raw('p0', 'Earlier chapter only.'), f.bodies, true, 8, f.candidate)
    expect(continuityReassessmentRequest('system', 'input', original, f.bodies, false, 2).system).toContain('"enum":["c0","p1","p2"]')
    expect(continuitySourceInput(f.bodies)).toContain('"terminalSources"')
    const legacyBodies = { ...f.bodies, terminalEvidence: f.old }
    expect(freshContinuityResponseContract(false, true, 5, legacyBodies)).toBe(freshContinuityResponseContract(false, true, 5))
    expect(continuitySourceInput(legacyBodies)).not.toContain('terminalSources')
  })

  it('still rejects older-chapter quotations and attests the actual clipped coordinates only after full review', () => {
    const f = fixture()
    const good = inspectContinuityResponse(f.raw(), f.bodies, true, 8, f.candidate)
    expect(good.complete).toBe(true)
    expect(inspectTerminalReview(f.candidate, f.content, f.raw(), true, f.context)?.verdicts[0].evidence[0]).toMatchObject({ start: 345, end: 600 })
    expect(inspectContinuityResponse(f.raw('p0', 'Earlier chapter only.'), f.bodies, true, 8, f.candidate).complete).toBe(false)
    expect(terminalSpanAuditVersion({ continuityCriticResponse: good.audit })).toBe(2)
    expect(terminalSpanAuditVersion({ continuityCriticResponse: { parserVersion: 8, terminalEvidence: f.old } })).toBeUndefined()
  })
})

it('requires a replacement instead of deleting unresolved failed candidate fields', () => {
  const f = fixture(), base = terminalCandidateSchema.parse({ exitState: { objects: ['Bent tool remains in the side pocket.'], knowledge: ['Unverified reading.'] } })
  const saved = { independentCheck: 'unavailable', terminalCandidate: base, continuityCriticResponse: { classification: 'terminal_invalid',
    terminalCandidate: base, terminalContentHash: runtimeJson({ content: f.content }).hash } }
  const dropped = terminalCandidateSchema.parse({ exitState: { knowledge: ['A different knowledge claim.'] } })
  expect(terminalCandidateReplacementIssue(saved, dropped, f.content)).toContain('不能只删除')
  const replaced = terminalCandidateSchema.parse({ exitState: { objects: ['The bent tool is recorded in the current pocket.'], knowledge: ['Unverified reading.'] } })
  const before = JSON.stringify(saved)
  expect(terminalCandidateReplacementIssue(saved, replaced, f.content)).toBeNull()
  expect(JSON.stringify(saved)).toBe(before)
  expect(saved.independentCheck).toBe('unavailable')
  const two = terminalCandidateSchema.parse({ exitState: { knowledge: ['First unresolved claim.', 'Second unresolved claim.'] } })
  const pending = { ...saved, terminalCandidate: two, continuityCriticResponse: { ...saved.continuityCriticResponse, terminalCandidate: two } }
  const one = terminalCandidateSchema.parse({ exitState: { knowledge: ['Only the first claim has been reformulated.'] } })
  expect(terminalCandidateReplacementIssue(pending, one, f.content)).toContain('不能只删除')
})

it('keeps verified historical omissions as independent obligations without certifying failed candidates', () => {
  const f = fixture(), spec = { id: 'task', scope: { terminalCoverageProtocol: 2 } }
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The preceding chapter starts here.'] } })
  const prior = [{ field: 'objects', claim: 'The bent tool remains in the side pocket.' }]
  expect(terminalCoverageInput(spec, {}, { id: 'chapter', content: f.content }, candidate, 2)?.obligations).toEqual([])
  const coverage = terminalCoverageInput(spec, {}, { id: 'chapter', content: f.content }, candidate, 2, prior)!
  expect(coverage.obligations).toEqual([expect.objectContaining(prior[0])])
  expect(coverage.inheritedProofsHash).toMatch(/^[a-f0-9]{64}$/u)
  const bodies = { ...f.bodies, terminalEvidence: { ...f.context, factCoverage: coverage } }
  const inspected = inspectContinuityResponse(f.raw(), bodies, true, 8, candidate)
  expect(inspected.complete).toBe(false)
  expect(inspected.audit.terminalReviewDiagnostics).toEqual([expect.objectContaining({ code: 'fact_disposition_invalid' })])
  const empty = terminalCoverageInput(spec, {}, { id: 'chapter', content: f.content }, candidate, 2, [])!
  const state = { terminalFactCoverage: { version: 1, taskId: spec.id, chapterId: 'chapter', facts: [], lastReview: {
    bodyHash: runtimeJson({ content: f.content }).hash, candidateHash: runtimeJson(candidate).hash, input: empty,
  } } }
  const changed = terminalCoverageInput(spec, state, { id: 'chapter', content: f.content }, candidate, 2, prior)!
  expect(changed.obligations).toEqual(coverage.obligations)
  expect(changed.inheritedProofsHash).not.toBe(empty.inheritedProofsHash)
})

it.each(['ended', 'replaced'] as const)('preserves the frozen obligation after its independent %s disposition', outcome => {
  const spec = { id: 'task', scope: { terminalCoverageProtocol: 2 } }
  const chapter = { id: 'chapter', revision: 9, orderIndex: 6,
    content: 'The old pass was destroyed. A new pass now opens the inner door.' }
  const oldClaim = 'The old pass remains usable.'
  const id = runtimeJson({ field: 'knowledge', claim: oldClaim }).hash
  const oldCandidate = terminalCandidateSchema.parse({ exitState: { knowledge: [oldClaim] } })
  const prepared = { terminalFactCoverage: { version: 1, taskId: spec.id, chapterId: chapter.id,
    facts: [{ id, field: 'knowledge', claim: oldClaim }], lastReview: {
      bodyHash: runtimeJson({ content: 'An earlier body.' }).hash, candidateHash: runtimeJson(oldCandidate).hash,
      input: { version: 2, taskId: spec.id, chapterId: chapter.id, obligations: [] },
    } } }
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['A new pass now opens the inner door.'] } })
  const input = terminalCoverageInput(spec, prepared, chapter, candidate, 2, [])!
  expect(input.obligations.map(item => item.id)).toEqual([id])
  const evidence = terminalEvidenceContext(chapter, null, 2, 1, input, 5, 2)
  const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({
    kind, result: 'clear', reason: 'Synthetic full-body review.', findingIndexes: [],
  })), terminalVerdicts: [{ path: 'exitState.knowledge.0', verdict: 'supported',
    sourceEvidence: [{ segmentId: 'c0', quote: candidate.exitState.knowledge[0] }] }], terminalProofVerdicts: [],
  terminalDispositions: [{ id, outcome, reason: 'The current body explicitly destroys the old pass and establishes its replacement.',
    sourceEvidence: [{ segmentId: 'c0', quote: 'The old pass was destroyed.' }],
    ...(outcome === 'replaced' ? { candidatePath: 'exitState.knowledge.0' } : {}),
  }] })
  const review = inspectTerminalReview(candidate, chapter.content, raw, true, evidence)!
  expect(review?.supported).toBe(true)
  const next = advanceTerminalCoverage(spec, prepared, chapter, review, input)!
  expect(next.facts.some(item => item.id === id)).toBe(false)
  expect(next.lastReview.input).toEqual(input)
  expect(terminalCoverageInput(spec, { terminalFactCoverage: next }, chapter, candidate, 2, [])).toEqual(input)
})
