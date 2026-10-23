import { describe, expect, it } from 'vitest'
import { terminalReviewAddressCatalog, terminalReviewAddressInput, bindTerminalReviewAddresses } from '../../api/lib/agent/terminal-review-addresses.js'
import { terminalCandidateSchema, inspectTerminalReview, currentTerminalReview, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { TerminalCarriedFact, TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { freshContinuityResponseContract, applyContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { stageTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'

const content = 'The clerk records the request but has not approved it. The pump still awaits a seal.'
const persistent = 'The pump awaits a seal.'
const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The clerk records the request.'], openLoops: [persistent] } })
const proof: TerminalCarriedFact = { proofHash: 'a'.repeat(64), segmentId: 't0', field: 'openLoops', claim: persistent, depth: 1,
  anchors: [{ chapterId: 'previous', revision: 1, contentHash: 'b'.repeat(64), start: 0, end: persistent.length, quote: persistent }],
  nodes: [{ compilationId: 'prior-compilation', chapterId: 'previous', revision: 1, orderIndex: 1, bodyHash: 'b'.repeat(64),
    candidateHash: 'c'.repeat(64), validationHash: 'd'.repeat(64), stateHash: 'e'.repeat(64), path: 'exitState.openLoops.0', previousChapterId: null }] }
function context(): TerminalEvidenceContext {
  return { protocol: 2, verdictProtocol: 6, spanAddressProtocol: 2, quoteAddressProtocol: 1,
    current: { id: 'current', revision: 2, orderIndex: 2, contentHash: runtimeJson({ content }).hash },
    previous: { id: 'previous', revision: 1, orderIndex: 1, contentHash: 'b'.repeat(64), start: 0, end: persistent.length, joinedStart: 0, joinedEnd: persistent.length,
      segments: [], carried: [structuredClone(proof)] },
    factCoverage: { version: 2, taskId: 'task', chapterId: 'current', obligations: [] } }
}
function response() {
  return { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full-body check.', findingIndexes: [] })),
    terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }],
    terminalProofVerdicts: [{ proofIndex: 0, currentState: 'unchanged', reason: 'The saved whole claim remains unchanged in the current body.' }], terminalDispositions: [] }
}

describe('server-bound terminal review addresses', () => {
  it('restores exact original identities and independent judgments, preserving full provider provenance', () => {
    const ctx = context(), wire = response(), raw = JSON.stringify(wire)
    const bound = bindTerminalReviewAddresses(wire, candidate, ctx)
    expect(bound).toMatchObject({ success: true, record: {
      terminalVerdicts: [{ path: 'exitState.knowledge.0', verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }],
      terminalProofVerdicts: [{ proofHash: proof.proofHash, currentState: 'unchanged' }] } })
    expect(inspectTerminalReview(candidate, content, raw, true, ctx)).toMatchObject({ supported: true, responseHash: runtimeJson({ raw }).hash,
      evidenceContextHash: runtimeJson(ctx).hash, proofChecks: [{ proofHash: proof.proofHash }],
      verdicts: [{ path: 'exitState.knowledge.0' }, { path: 'exitState.openLoops.0' }] })
    expect(inspectContinuityResponse(raw, { previous: persistent, current: content, terminalEvidence: ctx }, true, 8, candidate)).toMatchObject({ complete: true })
  })
  it('keeps all actual claims and evidence visible while removing internal hashes from model-facing directories', () => {
    const ctx = context(), catalog = terminalReviewAddressCatalog(candidate, ctx), view = terminalReviewAddressInput(candidate, ctx)
    expect(catalog.claims).toHaveLength(2)
    expect(view).toMatchObject({ ordinary: [{ claimIndex: 0, claim: candidate.exitState.knowledge[0] }], proofs: [{ proofIndex: 0, claim: persistent }] })
    const prompt = terminalReviewInput(candidate, ctx)
    expect(prompt).toContain(persistent)
    expect(prompt).toContain(candidate.exitState.knowledge[0])
    for (const internal of [proof.proofHash, ctx.current.contentHash, ...catalog.claims.map(row => row.id)]) expect(prompt).not.toContain(internal)
    const schema = freshContinuityResponseContract(false, true, 6, { previous: persistent, current: content, terminalEvidence: ctx }, candidate)
    expect(schema).toContain('proofIndex')
    expect(schema).not.toContain('proofHash')
    expect(schema).not.toContain('candidateFactId')
  })
  it.each(['missing-proof', 'duplicate-proof', 'foreign-proof', 'fractional-index', 'carried-as-ordinary', 'old-hash-row'] as const)('rejects an incomplete or misbound frozen address: %s', scenario => {
    const wire: Record<string, unknown> = response()
    if (scenario === 'missing-proof') wire.terminalProofVerdicts = []
    if (scenario === 'duplicate-proof') wire.terminalProofVerdicts = [response().terminalProofVerdicts[0], response().terminalProofVerdicts[0]]
    if (scenario === 'foreign-proof') wire.terminalProofVerdicts = [{ ...response().terminalProofVerdicts[0], proofIndex: 1 }]
    if (scenario === 'fractional-index') wire.terminalProofVerdicts = [{ ...response().terminalProofVerdicts[0], proofIndex: 0.5 }]
    if (scenario === 'carried-as-ordinary') wire.terminalVerdicts = [{ ...response().terminalVerdicts[0], claimIndex: 1 }]
    if (scenario === 'old-hash-row') wire.terminalProofVerdicts = [{ proofHash: proof.proofHash, currentState: 'unchanged', reason: 'Wrong wire contract.' }]
    expect(inspectTerminalReview(candidate, content, JSON.stringify(wire), true, context())).toBeNull()
  })
  it.each(['changed', 'uncertain'] as const)('does not turn a valid %s inheritance judgment into support', currentState => {
    const wire = response()
    wire.terminalProofVerdicts[0].currentState = currentState
    expect(inspectTerminalReview(candidate, content, JSON.stringify(wire), true, context())).toMatchObject({ supported: false,
      verdicts: [{ path: 'exitState.knowledge.0', verdict: 'supported' }, { path: 'exitState.openLoops.0', verdict: 'unknown' }] })
  })
  it('retains exact evidence, current revision and transport completeness boundaries', () => {
    const wire = response(), ctx = context()
    wire.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'c99' }]
    expect(inspectTerminalReview(candidate, content, JSON.stringify(wire), true, ctx)).toBeNull()
    expect(inspectTerminalReview(candidate, content + ' Author edit.', JSON.stringify(response()), true, ctx)).toBeNull()
    expect(inspectTerminalReview(candidate, content, JSON.stringify(response()), false, ctx)).toBeNull()
  })
  it('preserves failed report history and never upgrades an unavailable audit merely because addresses can be decoded', () => {
    const ctx = context(), raw = JSON.stringify(response()), inspected = inspectContinuityResponse(raw, { previous: persistent, current: content, terminalEvidence: ctx }, true, 8, candidate)
    const failed = { terminalCandidate: candidate, independentCheck: 'unavailable', continuityCriticResponse: inspected.audit }
    const before = runtimeJson(failed).hash
    expect(currentTerminalReview(failed, content, ctx)).toBeNull()
    expect(runtimeJson(failed).hash).toBe(before)
    expect(inspectTerminalReview(candidate, content, raw, true, { ...ctx, verdictProtocol: 5 })).toBeNull()
  })
  it('binds all pending proposals and replacement targets to server identities without changing their claims', () => {
    const ctx = context(), base = terminalCandidateSchema.parse({ exitState: { knowledge: ['The clerk approved the request.'] } })
    const staged = stageTerminalProposals({ preparedContext: {}, identity: { taskId: 'task', chapterId: ctx.current.id,
      bodyHash: ctx.current.contentHash, sourceHash: runtimeJson({ previous: ctx.previous }).hash }, auditHash: 'f'.repeat(64), base, candidate,
    verifiedFactIds: [terminalFactId('openLoops', persistent)] })!
    ctx.proposalChanges = staged.changes!
    const wire = { ...response(), proposalDispositions: [{ proposalIndex: 0, outcome: 'retracted', reason: 'The body explicitly says the request was not approved.',
      sourceEvidence: [{ segmentId: 'c0', quote: 'has not approved it' }] }] }
    const before = runtimeJson(ctx).hash
    expect(inspectTerminalReview(candidate, content, JSON.stringify(wire), true, ctx)).toMatchObject({ supported: true,
      proposals: { complete: true, dispositions: [{ id: staged.changes!.proposals[0].id, outcome: 'retracted' }] } })
    expect(runtimeJson(ctx).hash).toBe(before)
    expect(staged.state.pending).toHaveLength(1)
    expect(inspectTerminalReview(candidate, content, JSON.stringify({ ...wire, proposalDispositions: [{ ...wire.proposalDispositions[0], proposalIndex: 1 }] }), true, ctx)).toBeNull()
  })
  it('retains the original complete reassessment and semantic checks under the same short address contract', () => {
    const ctx = context(), bodies = { previous: persistent, current: content, terminalEvidence: ctx }
    const first = inspectContinuityResponse(JSON.stringify({ ...response(), terminalProofVerdicts: [] }), bodies, true, 8, candidate)
    expect(first.complete).toBe(false)
    const final = applyContinuityReassessment(first, JSON.stringify({ ...response(), decisions: [] }), bodies, 2)
    expect(final.complete).toBe(true)
    expect(final.audit).toMatchObject({ reassessment: { original: first.audit } })
    expect(inspectContinuityResponse(JSON.stringify({ ...response(), semanticChecks: [] }), bodies, true, 8, candidate).complete).toBe(false)
  })
  it('cannot omit or silently end a verified obligation, including when an unverified proposal was retracted', () => {
    const ctx = context(), claim = 'A signed instruction is still required.'
    ctx.factCoverage!.obligations = [{ id: terminalFactId('openLoops', claim), field: 'openLoops', claim }]
    const inspect = (terminalDispositions: unknown) => inspectTerminalReview(candidate, content,
      JSON.stringify({ ...response(), terminalDispositions }), true, ctx)
    expect(inspect([])).toBeNull()
    expect(inspect([{ obligationIndex: 1, outcome: 'ended', reason: 'Wrong frozen obligation.', sourceEvidence: [{ segmentId: 'c0' }] }])).toBeNull()
    expect(inspect([{ obligationIndex: 0, outcome: 'ended', reason: 'Not mentioned.', sourceEvidence: [] }])).toBeNull()
    expect(inspect([{ obligationIndex: 0, outcome: 'unknown', reason: 'The instruction remains unresolved.', sourceEvidence: [] }]))
      .toMatchObject({ supported: false, factCoverage: { complete: false } })
    expect(inspect([{ obligationIndex: 0, outcome: 'replaced', reason: 'A new supported pending condition records the same obligation.',
      candidateIndex: 1, sourceEvidence: [] }])).toMatchObject({ supported: true, factCoverage: { complete: true,
      dispositions: [{ id: terminalFactId('openLoops', claim), candidatePath: 'exitState.openLoops.0' }] } })
    expect(inspect([{ obligationIndex: 0, outcome: 'replaced', reason: 'The target was invented.', candidateIndex: 2, sourceEvidence: [] }])).toBeNull()
  })
  it('keeps duplicate literal claims at every actual path instead of deleting a fact to satisfy the table', () => {
    const repeated = terminalCandidateSchema.parse({ exitState: { knowledge: [candidate.exitState.knowledge[0], candidate.exitState.knowledge[0]], openLoops: [persistent] } })
    expect(terminalReviewAddressCatalog(repeated, context()).ordinary).toHaveLength(1)
    expect(inspectTerminalReview(repeated, content, JSON.stringify(response()), true, context())).toMatchObject({ supported: true,
      verdicts: [{ path: 'exitState.knowledge.0' }, { path: 'exitState.knowledge.1' }, { path: 'exitState.openLoops.0' }] })
    const ctx = context(), claim = 'The earlier request remains pending.'
    ctx.factCoverage!.obligations = [{ id: terminalFactId('knowledge', claim), field: 'knowledge', claim }]
    expect(inspectTerminalReview(repeated, content, JSON.stringify({ ...response(), terminalDispositions: [{ obligationIndex: 0,
      outcome: 'replaced', reason: 'The complete current claim represents the old knowledge.', candidateIndex: 0, sourceEvidence: [] }] }), true, ctx))
      .toMatchObject({ supported: true, factCoverage: { dispositions: [{ candidatePath: 'exitState.knowledge.0' }] } })
  })
  it.each(['planned', 'negated', 'attributed', 'unknown'] as const)('retains an independent %s judgment after address binding', verdict => {
    const wire = response()
    wire.terminalVerdicts[0].verdict = verdict
    expect(inspectTerminalReview(candidate, content, JSON.stringify(wire), true, context())).toMatchObject({ supported: false,
      verdicts: [{ path: 'exitState.knowledge.0', verdict }, { path: 'exitState.openLoops.0', verdict: 'supported' }] })
  })
  it('does not let an index move an instantaneous location claim to predecessor evidence', () => {
    const located = terminalCandidateSchema.parse({ exitState: { location: 'Outside the first door.' } }), ctx = context()
    ctx.previous!.segments = [{ segmentId: 'p0', start: 0, end: persistent.length, quote: persistent, hash: runtimeJson({ content: persistent }).hash }]
    const wire = { ...response(), terminalProofVerdicts: [], terminalVerdicts: [{ claimIndex: 0, verdict: 'supported',
      sourceEvidence: [{ segmentId: 'p0', quote: persistent }], inheritance: { priorEndState: 'established', currentState: 'unchanged' } }] }
    expect(inspectTerminalReview(located, content, JSON.stringify(wire), true, ctx)).toBeNull()
  })
  it('does not accept missing or duplicate ordinary addresses even when the total row count agrees', () => {
    const selected = terminalCandidateSchema.parse({ exitState: { knowledge: ['One claim.', 'Another claim.'] } }), ctx = context()
    const row = { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }
    for (const terminalVerdicts of [[row], [row, row]]) expect(inspectTerminalReview(selected, content,
      JSON.stringify({ ...response(), terminalProofVerdicts: [], terminalVerdicts }), true, ctx)).toBeNull()
  })
  it('keeps the observed old proof-hash transcription failure invalid; only a new frozen addressed request can pass', () => {
    const ctx = context(), old = { ...ctx, verdictProtocol: 5 as const }
    const malformed = { ...response(), terminalVerdicts: [{ factId: terminalFactId('knowledge', candidate.exitState.knowledge[0]),
      verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }],
    terminalProofVerdicts: [{ proofHash: 'a'.repeat(63) + 'b', currentState: 'unchanged', reason: 'A complete response with a wrong internal identity.' }] }
    const raw = JSON.stringify(malformed), bodies = { current: content, previous: persistent, terminalEvidence: old }
    const failure = inspectContinuityResponse(raw, bodies, true, 8, candidate)
    expect(failure).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', terminalEvidence: { verdictProtocol: 5 } } })
    const originalHash = runtimeJson(failure.audit).hash
    expect(inspectTerminalReview(candidate, content, raw, true, ctx)).toBeNull()
    expect(inspectTerminalReview(candidate, content, JSON.stringify(response()), true, ctx)).toMatchObject({ supported: true })
    expect(runtimeJson(failure.audit).hash).toBe(originalHash)
  })
})
