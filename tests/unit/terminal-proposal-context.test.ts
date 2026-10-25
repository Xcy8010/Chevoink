import { expect, it } from 'vitest'
import type { TaskSpec } from '../../shared/contracts/index.js'
import { terminalCandidateSchema, currentTerminalReview, terminalReviewFailure } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { attachTerminalProposalInput, prepareCompilerTerminalProposals, prepareTerminalProposalInput,
  terminalProposalIdentity, terminalProposalCacheMatches } from '../../api/lib/agent/terminal-proposal-context.js'
import { advanceTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'

function fixture() {
  const spec = { id: 'task', scope: { terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 } } as TaskSpec
  const chapter = { id: 'chapter', revision: 8, orderIndex: 6, content: 'The gauge reads two. The operator remains outside.' }
  const base = terminalCandidateSchema.parse({ exitState: { knowledge: ['Unverified combined reading.', 'Unverified archive event.'] } })
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The gauge reads two.'] } })
  const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: spec.id, chapterId: chapter.id, obligations: [] }, 5, 2)
  const response = (selected = base) => ({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
    ({ kind, result: 'clear', reason: 'Checked the synthetic body.', findingIndexes: [] })),
  terminalVerdicts: terminalCandidateFacts(selected).map(fact => ({ path: fact.path,
    verdict: chapter.content.includes(fact.claim) ? 'supported' : 'unknown',
    sourceEvidence: chapter.content.includes(fact.claim) ? [{ segmentId: 'c0', quote: fact.claim }] : [] })),
  terminalProofVerdicts: [], terminalDispositions: [] })
  const audit = (selected = base, evidence = context, raw = JSON.stringify(response(selected))) =>
    inspectContinuityResponse(raw, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, selected)
  const prior = audit()
  expect(prior.complete).toBe(true)
  const validation = { independentCheck: 'complete', terminalCandidate: base, continuityCriticResponse: prior.audit }
  const input = { spec, preparedContext: {}, validation, content: chapter.content, previousContent: null,
    candidate, originalContext: context, nextContext: context }
  const staged = prepareTerminalProposalInput(input)!
  if (!staged.changes) throw Error('Synthetic fixture must have pending proposals')
  const evidence = { ...context, proposalChanges: staged.changes }
  const invalid = audit(candidate, evidence) // Missing mandatory proposal dispositions, not a business pass.
  expect(invalid.complete).toBe(false)
  const pendingInput = { ...input, preparedContext: { terminalProposalReview: staged.state },
    validation: { independentCheck: 'unavailable', terminalCandidate: candidate, continuityCriticResponse: invalid.audit }, originalContext: context }
  return { spec, chapter, base, candidate, context, response, audit, input, staged, evidence, pendingInput }
}

it('uses one authenticated producer for request and report reconstruction, without classifying a failed report as passed', () => {
  const f = fixture()
  const fromCompiler = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: {}, validation: f.input.validation,
    chapter: f.chapter, source: null, candidate: f.candidate, nextContext: f.context })
  expect(fromCompiler).toEqual(f.staged)
  const next = prepareTerminalProposalInput(f.pendingInput)!
  expect(next.changes).toEqual(f.staged.changes)
  expect(next.state.pending).toEqual(f.staged.state.pending)
  expect(currentTerminalReview(f.pendingInput.validation, f.chapter.content, f.evidence)).toBeNull()
})

it('reports every proposal-only unknown with its original identity and independent reason without changing saved state', () => {
  const f = fixture()
  const dispositions = f.staged.changes!.proposals.map(proposal => ({ id: proposal.id, outcome: 'unknown',
    reason: `The saved body does not establish the original ${proposal.field} proposal.`, sourceEvidence: [] }))
  const inspected = f.audit(f.candidate, f.evidence, JSON.stringify({ ...f.response(f.candidate), proposalDispositions: dispositions }))
  expect(inspected.complete).toBe(true)
  const validation = { independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: inspected.audit }
  const preparedContext = { terminalProposalReview: f.staged.state }
  const before = structuredClone({ validation, preparedContext })
  const review = currentTerminalReview(validation, f.chapter.content, f.evidence)!
  expect(review).toMatchObject({ supported: false, proposals: { complete: false } })
  expect(review.verdicts.every(item => item.verdict === 'supported')).toBe(true)
  expect(review.factCoverage?.dispositions).toEqual([])
  const failure = terminalReviewFailure(validation, f.chapter.content, f.evidence)!
  expect(failure).toMatchObject({ reviewOutcome: 'decision_required', reviewCompleted: true })
  expect(failure).not.toHaveProperty('failureCode')
  expect({ validation, preparedContext }).toEqual(before)
  for (const [index, proposal] of f.staged.changes!.proposals.entries()) {
    expect.soft(failure.output).toContain(proposal.id)
    expect.soft(failure.output).toContain(proposal.field)
    expect.soft(failure.output).toContain(proposal.claim)
    expect.soft(failure.output).toContain(dispositions[index].reason)
  }
})

it.each(['missing-audit', 'wrong-marker', 'raw-corruption', 'unknown-response'] as const)(
  'refuses same-candidate preparation with an unauthenticated current report: %s', scenario => {
    const f = fixture(), input = structuredClone(f.pendingInput)
    if (scenario === 'missing-audit') delete (input.validation as Partial<typeof input.validation>).continuityCriticResponse
    if (scenario === 'wrong-marker') input.validation.continuityCriticResponse.terminalEvidence!.proposalChanges!.candidateHash = 'f'.repeat(64)
    if (scenario === 'raw-corruption') input.validation.continuityCriticResponse.contentHash = 'f'.repeat(64)
    if (scenario === 'unknown-response') input.validation.continuityCriticResponse.classification = 'response_incomplete'
    expect(() => prepareTerminalProposalInput(input)).toThrow(expect.objectContaining({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' }))
    expect(f.staged.state.pending).toHaveLength(2)
  })

it('does not accept a malformed lifecycle marker or altered parser evidence', () => {
  const f = fixture()
  for (const marker of [{ version: 2, key: 'a'.repeat(64), inputHash: 'b'.repeat(64) },
    { version: 1, key: 'invalid', inputHash: 'b'.repeat(64) }]) {
    const input = structuredClone(f.pendingInput)
    Object.assign(input.validation.continuityCriticResponse, { assessmentRequest: marker })
    expect(() => prepareTerminalProposalInput(input)).toThrow()
  }
})

it.each([1, 2])('upgrades %i pending proposals to verified obligations on the same candidate', count => {
  const f = fixture(), facts = f.staged.state.pending.slice(0, count).map(({ id, field, claim }) => ({ id, field, claim }))
  const input = { ...f.pendingInput, preparedContext: { ...f.pendingInput.preparedContext, terminalFactCoverage: {
    version: 1, taskId: f.spec.id, chapterId: f.chapter.id, facts,
    lastReview: { bodyHash: f.context.current.contentHash, candidateHash: runtimeJson(f.candidate).hash, input: f.context.factCoverage },
  } } }
  const next = prepareTerminalProposalInput(input)!
  expect(next.state.pending).toHaveLength(2 - count)
  expect(terminalProposalCacheMatches({ spec: f.spec, preparedContext: input.preparedContext, validation: input.validation,
    chapter: f.chapter, source: null, candidate: f.candidate, nextContext: f.evidence })).toBe(false)
  if (count === 2) expect(next.changes).toBeUndefined()
  else expect(next.changes!.verifiedFactIds).toEqual(facts.map(fact => fact.id))
})

it('reconstructs a completed report with the full original input, then honors a later no-marker report', () => {
  const f = fixture(), identity = terminalProposalIdentity(f.spec.id, f.context)
  const dispositions = f.staged.changes!.proposals.map(proposal => ({ id: proposal.id, outcome: 'retracted',
    reason: 'The original unverified assertion is not established by the saved body.',
    sourceEvidence: [{ segmentId: 'c0', quote: f.chapter.content }] }))
  const inspected = f.audit(f.candidate, f.evidence, JSON.stringify({ ...f.response(f.candidate), proposalDispositions: dispositions }))
  expect(inspected.complete).toBe(true)
  const validation = { independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: inspected.audit }
  const review = currentTerminalReview(validation, f.chapter.content, f.evidence)!
  const state = advanceTerminalProposals(f.staged.state, f.staged.changes!, review)
  expect(state.pending).toEqual([])
  const preparedContext = { terminalProposalReview: state }
  expect(attachTerminalProposalInput(f.context, { taskId: identity.taskId, preparedContext, validation, candidate: f.candidate })).toEqual(f.evidence)
  expect(terminalProposalCacheMatches({ spec: f.spec, preparedContext, validation, chapter: f.chapter,
    source: null, candidate: f.candidate, nextContext: f.evidence })).toBe(true)
  const nextAudit = f.audit(f.candidate)
  expect(nextAudit.complete).toBe(true)
  expect(attachTerminalProposalInput(f.context, { taskId: identity.taskId, preparedContext,
    validation: { ...validation, continuityCriticResponse: nextAudit.audit }, candidate: f.candidate })).toEqual(f.context)
})

it.each(['body', 'source', 'task', 'chapter', 'candidate'] as const)('blocks stale %s ownership without changing pending state', scenario => {
  const f = fixture(), input = structuredClone(f.pendingInput)
  if (scenario === 'body') input.content += ' Changed.'
  if (scenario === 'source') input.nextContext.previous = { id: 'previous', revision: 1, orderIndex: 5,
    contentHash: 'b'.repeat(64), start: 0, end: 4, joinedStart: 0, joinedEnd: 4, segments: [] }
  if (scenario === 'task') input.spec.id = 'other-task'
  if (scenario === 'chapter') input.nextContext.current.id = 'other-chapter'
  if (scenario === 'candidate') {
    input.candidate = structuredClone(input.candidate)
    input.candidate.exitState.knowledge.push('A different proposal.')
  }
  if (scenario === 'candidate') {
    // A fresh candidate is legitimate only after the current audit authenticates;
    // it keeps every older unresolved proposal and records no verdict itself.
    const next = prepareTerminalProposalInput(input)!
    expect(next.state.pending).toEqual(f.staged.state.pending)
  } else expect(() => prepareTerminalProposalInput(input)).toThrow()
  expect(f.staged.state.pending).toHaveLength(2)
})

it.each([true, false])('retains the actual reassessment wrapper while distinguishing known invalid from unknown: complete=%s', async complete => {
  const f = fixture(), original = f.audit(f.candidate, f.evidence)
  const observed = await runContinuityReassessment({ original, bodies: { previous: null, current: f.chapter.content, terminalEvidence: f.evidence },
    system: 'Synthetic independent critic', content: 'Frozen synthetic input', reassessmentProtocol: 2,
    billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal,
    assertCurrent: async () => {}, claim: async () => true, dispatch: async () => ({ content: 'invalid-json', complete }) })
  // Production lifecycle appends this identity after the parser and before
  // persisting either a complete or failed second response.
  const retained = { ...observed.audit, assessmentRequest: { version: 1, key: 'a'.repeat(64), inputHash: 'b'.repeat(64) } }
  const input = { ...f.pendingInput, validation: { ...f.pendingInput.validation, continuityCriticResponse: retained } }
  const before = JSON.stringify(observed.audit)
  if (complete) expect(prepareTerminalProposalInput(input)?.state.pending).toEqual(f.staged.state.pending)
  else expect(() => prepareTerminalProposalInput(input)).toThrow()
  expect(JSON.stringify(observed.audit)).toBe(before)
  expect(currentTerminalReview(input.validation, f.chapter.content, f.evidence)).toBeNull()
})

it.each([[false, false], [true, false], [false, true], [true, true]])('carries proposals across a revision without relabeling origin: pending=%s restoredBody=%s', (existingPending, restoredBody) => {
  const f = fixture(), chapter = { ...f.chapter, revision: 10, content: restoredBody ? f.chapter.content : f.chapter.content + ' The log remains open.' }
  const selected = existingPending ? f.pendingInput : f.input
  const validation = { ...selected.validation, checkedChapterId: f.chapter.id, checkedRevision: 8, checkedContent: f.chapter.content }
  const nextContext = terminalEvidenceContext(chapter, null, 2, 1, f.context.factCoverage, 5, 2)
  const input = { spec: f.spec, preparedContext: selected.preparedContext, validation, chapter, source: null, candidate: f.candidate, nextContext }
  const proposed = prepareCompilerTerminalProposals(input)!
  expect(proposed.changes!.bodyHash).toBe(runtimeJson({ content: chapter.content }).hash)
  expect(proposed.state.pending).toHaveLength(2)
  expect(proposed.state.pending.every(proposal => proposal.origin.bodyHash === f.context.current.contentHash)).toBe(true)
  expect(proposed.state.pending.map(proposal => proposal.id)).toEqual(f.staged.state.pending.map(proposal => proposal.id))
  const corrupt = { ...input, validation: { ...validation, checkedContent: 'Invented old body.' } }
  expect(() => prepareCompilerTerminalProposals(corrupt)).toThrow()
  expect(f.chapter.revision).toBe(8)
})

it.each(['known', 'corrupt-hash', 'corrupt-raw', 'incomplete', 'wrong-classification'] as const)(
  'keeps first failed candidates independently reviewable without requiring prior proposal state: %s', scenario => {
    const f = fixture()
    const invalid = f.audit(f.base, f.context, JSON.stringify({ ...f.response(), proposalDispositions: 'invalid' }))
    expect(invalid.complete).toBe(false)
    expect(invalid.audit.classification).toBe('terminal_invalid')
    const validation = { independentCheck: 'unavailable', terminalCandidate: f.base, continuityCriticResponse: structuredClone(invalid.audit) }
    if (scenario === 'corrupt-hash') validation.continuityCriticResponse.contentHash = 'f'.repeat(64)
    if (scenario === 'corrupt-raw') validation.continuityCriticResponse.rawResponse.content = JSON.stringify('corrupt')
    if (scenario === 'incomplete') validation.continuityCriticResponse.rawResponse.complete = false
    if (scenario === 'wrong-classification') validation.continuityCriticResponse.classification = 'response_incomplete'
    const input = { ...f.input, validation }
    if (scenario !== 'known') {
      expect(() => prepareTerminalProposalInput(input)).toThrow(expect.objectContaining({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' }))
      return
    }
    const before = JSON.stringify(validation), next = prepareTerminalProposalInput(input)!
    expect(next.state.pending).toHaveLength(2)
    expect(next.state.pending.map(p => p.claim).sort()).toEqual([...f.base.exitState.knowledge].sort())
    expect(currentTerminalReview(validation, f.chapter.content, f.context)).toBeNull()
    expect(JSON.stringify(validation)).toBe(before)
    const chapter = { ...f.chapter, revision: f.chapter.revision + 1, content: f.chapter.content + ' A local edit.' }
    const nextContext = terminalEvidenceContext(chapter, null, 2, 1, f.context.factCoverage, 5, 2)
    const afterEdit = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: {},
      validation: { ...validation, checkedChapterId: f.chapter.id, checkedRevision: f.chapter.revision, checkedContent: f.chapter.content },
      chapter, source: null, candidate: f.candidate, nextContext })!
    expect(afterEdit.state.pending).toHaveLength(2)
    expect(afterEdit.changes?.bodyHash).toBe(nextContext.current.contentHash)
  })
