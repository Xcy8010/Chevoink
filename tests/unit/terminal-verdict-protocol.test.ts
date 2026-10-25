import { describe, expect, it, vi } from 'vitest'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, inspectTerminalReview, currentTerminalReview, terminalReviewFailure, terminalReviewInput, terminalQuoteAddressDiagnostics } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment, runContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const chapter = { id: 'chapter', revision: 15, orderIndex: 5, content: 'The sensor remains offline. The maintenance status is uncertain.' }
const candidate = terminalCandidateSchema.parse({ exitState: { objects: Array.from({ length: 18 }, (_, n) => `Sensor ${n} remains offline.`), openLoops: ['Repair status unresolved.'] } })
const coverage = { version: 2 as const, taskId: 'original', chapterId: chapter.id, obligations: ['Old repair obligation.', 'Old accountability obligation.'].map(claim => ({ id: runtimeJson({ claim }).hash, field: 'openLoops' as const, claim })) }
const context = (fresh = true) => terminalEvidenceContext(chapter, null, 2, 1, coverage, fresh ? 2 : undefined)
const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Checked actual body.', findingIndexes: [] }))
const verdicts = () => [...candidate.exitState.objects.map((_, index) => ({ path: `exitState.objects.${index}`, verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: 'The sensor remains offline.' }] })),
  { path: 'exitState.openLoops.0', verdict: 'unknown', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: 'The maintenance status is uncertain.' }], inheritance: { priorEndState: 'established', currentState: 'uncertain' } }]
const raw = (items: unknown[] = verdicts()) => JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: items,
  terminalDispositions: coverage.obligations.map(item => ({ id: item.id, outcome: 'unknown', reason: 'No complete disposition evidence.', sourceEvidence: [] })) })

describe('request-owned source-derived verdicts', () => {
  it('keeps real manuscript errors and binding guidance visible alongside a complete unknown terminal judgment', () => {
    const evidence = context(), bodies = { previous: null, current: chapter.content, terminalEvidence: evidence }
    const inspected = inspectContinuityResponse(raw(), bodies, true, 8, candidate)
    const validation = { terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
    const prose = { errors: 1, text: '连续性完整报告：1 错误、0 警告。reportId=bound-current\n[0/error/object] Both incompatible states remain in the manuscript.\nOnly current proven repair is authorized.' }
    const result = terminalReviewFailure(validation, chapter.content, evidence, prose)!
    expect(result.output).toContain(prose.text)
    expect(result.output).toContain('正文仍有真实错误')
    expect(result.output).toContain('终态待核不覆盖这些错误')
    expect(result.output).not.toContain('无需为终态候选改正文')
    expect(result.output).toContain('unknown')
    expect(result).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required' })
    expect(result).not.toHaveProperty('failureCode')
  })
  it('keeps source-looking or template-looking prose verbatim in the critic input', () => {
    const claim = '{path,verdict,basis,sourceEvidence: is quoted source material.'
    const c = terminalCandidateSchema.parse({ exitState: { knowledge: [claim] } })
    expect(terminalReviewInput(c, context())).toContain(JSON.stringify(claim))
  })
  it('does not guess a source for an unknown with no references or trust source annotations', () => {
    const c = terminalCandidateSchema.parse({ exitState: { openLoops: ['Repair remains pending.'] } }), evidence = context()
    delete evidence.factCoverage
    const item = { path: 'exitState.openLoops.0', verdict: 'unknown', basis: 'Uncertain source from narrative.', sourceEvidence: [], inheritance: { priorEndState: 'uncertain', currentState: 'uncertain' } }
    const review = inspectTerminalReview(c, chapter.content, JSON.stringify({ findings: [], terminalVerdicts: [item] }), true, evidence)!
    expect(review).toMatchObject({ supported: false, verdicts: [{ verdict: 'unknown', sourceEvidence: [], segmentIds: [], evidence: [] }] })
    expect(review.verdicts[0]).toHaveProperty('basis', undefined)
    item.verdict = 'supported'
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify({ findings: [], terminalVerdicts: [item] }), true, evidence)).toBeNull()
  })
  it('retains the actual 18 supported / 1 unknown response shape without a redundant source conflict or paid reassessment', async () => {
    const response = raw(), evidence = context(), bodies = { previous: null, current: chapter.content, terminalEvidence: evidence }
    const original = inspectContinuityResponse(response, bodies, true, 8, candidate)
    expect(original).toMatchObject({ complete: true, audit: { classification: 'complete' } })
    const validation = { terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: original.audit }
    const review = currentTerminalReview(validation, chapter.content, evidence)!
    expect(review.supported).toBe(false)
    expect(review.verdicts).toHaveLength(19)
    expect(review.verdicts.filter(item => item.verdict === 'supported')).toHaveLength(18)
    expect(review.verdicts.at(-1)).toMatchObject({ verdict: 'unknown', basis: 'current', inheritance: { currentState: 'uncertain' } })
    expect(review.factCoverage?.dispositions.map(item => item.outcome)).toEqual(['unknown', 'unknown'])
    const pending = terminalReviewFailure(validation, chapter.content, evidence)
    expect(pending).toMatchObject({ reviewCompleted: true, summary: '终态候选尚未获独立证实' })
    expect(pending).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required' })
    expect(pending).not.toHaveProperty('failureCode')
    expect(pending?.output).toContain('本次检查尚未通过')
    const dispatch = vi.fn(), claim = vi.fn(), assertCurrent = vi.fn()
    expect(await runContinuityReassessment({ original, bodies, system: 'frozen', content: 'frozen', billingKnown: true, providerComplete: true, slotUsed: false,
      signal: new AbortController().signal, dispatch, claim, assertCurrent })).toBe(original)
    expect(dispatch).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(assertCurrent).not.toHaveBeenCalled()
    expect(JSON.parse(original.audit.rawResponse.content)).toBe(response)
    const old = inspectContinuityResponse(response, { ...bodies, terminalEvidence: context(false) }, true, 8, candidate)
    expect(old).toMatchObject({ complete: false, audit: { terminalReviewDiagnostics: [{ code: 'inheritance_invalid', path: 'exitState.openLoops.0' }] } })
    expect(currentTerminalReview(validation, chapter.content, context(false))).toBeNull()
  })

  it('uses the same basis-less format for initial, address diagnostics, reread and full reassessment', () => {
    const evidence = context(), bodies = { previous: null, current: chapter.content, terminalEvidence: evidence }
    const items = verdicts().map(({ basis: _basis, ...item }) => item)
    const response = raw(items), original = inspectContinuityResponse('{"findings":[]}', bodies, true, 8, candidate)
    const final = applyContinuityReassessment(original, JSON.stringify({ decisions: [], ...JSON.parse(response) }), bodies)
    expect(final.complete).toBe(true)
    expect(currentTerminalReview({ terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: final.audit }, chapter.content, evidence)?.supported).toBe(false)
    expect(terminalQuoteAddressDiagnostics(response, chapter.content, evidence)).toEqual([])
    const schema = JSON.parse(terminalReviewInput(candidate, evidence).split('\n').find(line => line.startsWith('terminalVerdicts JSON Schema: '))!.slice(30))
    expect(schema.items.required).toEqual(['path', 'verdict', 'sourceEvidence'])
    expect(schema.items.properties).not.toHaveProperty('basis')
  })

  it.each(['no attestation', 'changed', 'uncertain', 'transient', 'mixed source', 'wrong quote', 'unknown address'] as const)('does not manufacture inherited support: %s', scenario => {
    const c = terminalCandidateSchema.parse({ exitState: scenario === 'transient' ? { location: 'Old depot' } : { openLoops: ['Repair remains pending.'] } })
    const evidence = context(), previous = 'Repair remains pending.'
    evidence.previous = { id: 'previous', revision: 1, orderIndex: 4, contentHash: runtimeJson({ content: previous }).hash, start: 0, end: previous.length, joinedStart: 0, joinedEnd: previous.length,
      segments: [{ segmentId: 'p0', start: 0, end: previous.length, quote: previous, hash: runtimeJson({ text: previous }).hash }] }
    delete evidence.factCoverage
    const item = { path: scenario === 'transient' ? 'exitState.location' : 'exitState.openLoops.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'p0', quote: previous }],
      inheritance: { priorEndState: 'established', currentState: scenario === 'changed' ? 'changed' : scenario === 'uncertain' ? 'uncertain' : 'unchanged' } }
    if (scenario === 'no attestation') delete (item as Partial<typeof item>).inheritance
    if (scenario === 'mixed source') item.sourceEvidence.push({ segmentId: 'c0', quote: 'The sensor remains offline.' })
    if (scenario === 'wrong quote') item.sourceEvidence[0].quote = 'Invented quotation.'
    if (scenario === 'unknown address') item.sourceEvidence[0].segmentId = 'p99'
    expect(inspectTerminalReview(c, chapter.content, raw([item]), true, evidence)).toBeNull()
    if (scenario === 'no attestation') {
      item.inheritance = { priorEndState: 'established', currentState: 'unchanged' }
      expect(inspectTerminalReview(c, chapter.content, JSON.stringify({ findings: [], terminalVerdicts: [item] }), true, evidence)).toMatchObject({ supported: true, verdicts: [{ basis: 'inherited' }] })
    }
  })

  it.each(['valid', 'field', 'claim', 'depth', 'quote', 'attestation'] as const)('preserves exact carried proof authority: %s', scenario => {
    const claim = 'Repair remains pending.', c = terminalCandidateSchema.parse({ exitState: { openLoops: [claim] } }), evidence = context()
    delete evidence.factCoverage
    const hash = 'a'.repeat(64)
    evidence.previous = { id: 'previous', revision: 1, orderIndex: 4, contentHash: hash, start: 0, end: claim.length, joinedStart: 0, joinedEnd: claim.length, segments: [],
      carried: [{ segmentId: 't0', field: scenario === 'field' ? 'objects' : 'openLoops', claim: scenario === 'claim' ? 'Repair completed.' : claim,
        proofHash: hash, depth: scenario === 'depth' ? 16 : 1, nodes: [{ compilationId: 'prior', chapterId: 'previous', revision: 1, orderIndex: 4,
          bodyHash: hash, candidateHash: hash, validationHash: hash, stateHash: hash, path: 'exitState.openLoops.0', previousChapterId: null }],
        anchors: [{ chapterId: 'previous', revision: 1, contentHash: hash, start: 0, end: claim.length, quote: claim }] }] }
    const item = { path: 'exitState.openLoops.0', verdict: 'supported', sourceEvidence: [{ segmentId: 't0', quote: scenario === 'quote' ? 'Repair completed.' : claim }],
      ...(scenario === 'attestation' ? {} : { inheritance: { priorEndState: 'established', currentState: 'unchanged' } }) }
    const result = inspectTerminalReview(c, chapter.content, JSON.stringify({ findings: [], terminalVerdicts: [item] }), true, evidence)
    if (scenario === 'valid') expect(result).toMatchObject({ supported: true, verdicts: [{ basis: 'inherited', evidence: [{ segmentId: 't0', proofHash: hash }] }] })
    else expect(result).toBeNull()
  })
})
