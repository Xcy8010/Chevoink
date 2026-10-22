import { expect, it } from 'vitest'
import { terminalCandidateSchema, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { freshContinuityResponseContract } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { advanceTerminalProposals, inspectTerminalProposalDispositions, readTerminalProposalInput,
  readTerminalProposalState, stageTerminalProposals, terminalProposalGuidance } from '../../api/lib/agent/terminal-proposal-review.js'

function fixture() {
  const body = 'The spare gauge reads two. The operator has not reached the inner room.'
  const identity = { taskId: 'task', chapterId: 'chapter', bodyHash: runtimeJson({ content: body }).hash, sourceHash: 'b'.repeat(64) }
  const base = terminalCandidateSchema.parse({ exitState: { knowledge: ['The spare gauge and output share a single reading.'],
    emotion: ['The operator is suspicious about a distant event.'], objects: ['The bent tool remains in the side pocket.'] } })
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The spare gauge reads two.', 'The output remains unchanged.'],
    objects: ['The bent tool remains in the side pocket.'] } })
  const verified = [terminalFactId('objects', base.exitState.objects[0])]
  const prepared = stageTerminalProposals({ preparedContext: {}, identity, auditHash: 'a'.repeat(64), base, candidate, verifiedFactIds: verified })!
  if (!prepared.changes) throw Error('Fixture must have two pending proposals')
  const staged = { ...prepared, changes: prepared.changes }
  const segments = [{ segmentId: 'c0', quote: body }]
  const verdicts = [{ path: 'exitState.knowledge.0', verdict: 'supported' }, { path: 'exitState.knowledge.1', verdict: 'supported' }]
  const dispositions = staged.changes.proposals.map(proposal => ({ id: proposal.id,
    outcome: proposal.field === 'emotion' ? 'retracted' : 'replaced', reason: 'Synthetic independent review of the original proposal.',
    sourceEvidence: [{ segmentId: 'c0', quote: 'The spare gauge reads two.' }],
    ...(proposal.field === 'knowledge' ? { candidateFactId: terminalFactId('knowledge', candidate.exitState.knowledge[0]) } : {}) }))
  return { identity, base, candidate, verified, staged, segments, verdicts, dispositions }
}

it('replays knowledge plus emotion replacement as pending proposals, without treating field counts as truth', () => {
  const f = fixture()
  expect(f.staged.changes.proposals.map(item => item.field)).toEqual(['knowledge', 'emotion'])
  expect(f.staged.state.pending).toHaveLength(2)
  expect(f.staged.changes.proposals.every(item => item.origin.auditHash === 'a'.repeat(64))).toBe(true)
  expect(terminalProposalGuidance(f.staged.changes)).toContain('此目录不能解除factCoverage中的已验证事实')
  expect(terminalProposalGuidance()).toBe('')
})

it('retains all prior unresolved proposals when another patch changes the latest candidate', () => {
  const f = fixture(), empty = terminalCandidateSchema.parse({ exitState: {} })
  const next = stageTerminalProposals({ preparedContext: { terminalProposalReview: f.staged.state }, identity: f.identity,
    auditHash: 'c'.repeat(64), base: f.candidate, candidate: empty, verifiedFactIds: f.verified })!
  expect(next.state.pending).toHaveLength(4)
  expect(next.state.pending.slice(0, 2)).toEqual(f.staged.state.pending)
  expect(next.state.pending.some(item => item.field === 'objects')).toBe(false)
  expect(f.staged.state.pending).toHaveLength(2)
})

it('never downgrades a verified bent-tool fact into a retractable proposal', () => {
  const f = fixture(), dropped = terminalCandidateSchema.parse({ exitState: {} })
  const staged = stageTerminalProposals({ preparedContext: {}, identity: f.identity, auditHash: 'a'.repeat(64),
    base: f.base, candidate: dropped, verifiedFactIds: f.verified })!
  if (!staged.changes) throw Error('Fixture must retain unverified proposals')
  expect(staged.changes.proposals.some(item => item.id === f.verified[0])).toBe(false)
  const malicious = structuredClone(staged.changes)
  malicious.proposals[0] = { ...malicious.proposals[0], id: f.verified[0], field: 'objects', claim: f.base.exitState.objects[0] }
  expect(inspectTerminalProposalDispositions(malicious, [], dropped, [], f.segments, f.verified)).toBeNull()
})

it('consumes only a complete independent result and reconstructs its full frozen input after pending shrinks', () => {
  const f = fixture(), prepared = { terminalProposalReview: f.staged.state }
  const checked = inspectTerminalProposalDispositions(f.staged.changes, f.dispositions, f.candidate, f.verdicts, f.segments, f.verified)!
  expect(checked.complete).toBe(true)
  expect(advanceTerminalProposals(f.staged.state, f.staged.changes, { supported: false, proposals: checked })).toBe(f.staged.state)
  const state = advanceTerminalProposals(f.staged.state, f.staged.changes, { supported: true, proposals: checked })
  expect(state.pending).toEqual([])
  expect(readTerminalProposalInput({ terminalProposalReview: state }, f.identity, f.candidate)).toEqual(f.staged.changes)
  expect(readTerminalProposalState(prepared, f.identity)?.pending).toHaveLength(2)
  expect(readTerminalProposalInput({ terminalProposalReview: state }, { ...f.identity, sourceHash: 'd'.repeat(64) }, f.candidate)).toBeUndefined()
})

it.each(['omitted', 'duplicate', 'extra', 'unknown-id', 'bad-quote', 'previous-source', 'unsupported-target', 'retracted-target', 'missing-evidence', 'candidate-drift'] as const)(
  'refuses malformed or unbound independent disposition: %s', scenario => {
    const f = fixture(), rows = structuredClone(f.dispositions), candidate = structuredClone(f.candidate)
    if (scenario === 'omitted') rows.pop()
    if (scenario === 'duplicate') rows[1] = structuredClone(rows[0])
    if (scenario === 'extra') rows.push(structuredClone(rows[0]))
    if (scenario === 'unknown-id') rows[0].id = 'f'.repeat(64)
    if (scenario === 'bad-quote') rows[0].sourceEvidence[0].quote = 'An invented sentence.'
    if (scenario === 'previous-source') rows[0].sourceEvidence[0].segmentId = 'p0'
    if (scenario === 'unsupported-target') f.verdicts[0].verdict = 'unknown'
    if (scenario === 'retracted-target') rows[1].candidateFactId = rows[0].candidateFactId
    if (scenario === 'missing-evidence') rows[1].sourceEvidence = []
    if (scenario === 'candidate-drift') candidate.exitState.knowledge[0] = 'Different claim.'
    expect(inspectTerminalProposalDispositions(f.staged.changes, rows, candidate, f.verdicts, f.segments, f.verified)).toBeNull()
  })

it('keeps unknown proposals pending, rejects stray new fields on legacy inputs, and refuses altered input receipts', () => {
  const f = fixture(), rows = structuredClone(f.dispositions)
  rows[1] = { ...rows[1], outcome: 'unknown', sourceEvidence: [] }
  const checked = inspectTerminalProposalDispositions(f.staged.changes, rows, f.candidate, f.verdicts, f.segments, f.verified)!
  expect(checked.complete).toBe(false)
  expect(advanceTerminalProposals(f.staged.state, f.staged.changes, { supported: true, proposals: checked })).toBe(f.staged.state)
  expect(inspectTerminalProposalDispositions(undefined, undefined, f.candidate, [], [], [])).toBeUndefined()
  expect(inspectTerminalProposalDispositions(undefined, rows, f.candidate, [], [], [])).toBeNull()
  expect(() => advanceTerminalProposals(f.staged.state, { ...f.staged.changes, candidateHash: 'f'.repeat(64) }, { supported: true, proposals: checked })).toThrow()
})

it('fails closed on state corruption, another task, or combined catalogue overflow instead of truncating obligations', () => {
  const f = fixture(), corrupt = structuredClone(f.staged.state)
  corrupt.pending.pop()
  expect(() => readTerminalProposalState({ terminalProposalReview: corrupt }, f.identity)).toThrow()
  const unbound = structuredClone(f.staged.state)
  unbound.pending[0].origin.auditHash = 'f'.repeat(64)
  unbound.lastInput.pendingHash = runtimeJson(unbound.pending).hash
  expect(() => readTerminalProposalState({ terminalProposalReview: unbound }, f.identity)).toThrow()
  expect(() => readTerminalProposalState({ terminalProposalReview: f.staged.state }, { ...f.identity, taskId: 'other' })).toThrow()
  expect(readTerminalProposalState({}, f.identity)).toBeUndefined()
  expect(() => stageTerminalProposals({ preparedContext: {}, identity: f.identity, auditHash: 'a'.repeat(64),
    base: f.base, candidate: f.candidate, verifiedFactIds: Array.from({ length: 200 }, (_, i) => String(i).padStart(64, '0')) })).toThrow()
})

it('explicitly persists empty pending when all old proposals become independently verified facts', () => {
  const f = fixture(), upgradedIds = [...f.verified, ...f.staged.state.pending.map(item => item.id)]
  const staged = stageTerminalProposals({ preparedContext: { terminalProposalReview: f.staged.state }, identity: f.identity,
    auditHash: 'a'.repeat(64), base: f.candidate, candidate: f.candidate, verifiedFactIds: upgradedIds })!
  expect(staged.state.pending).toEqual([])
  expect(staged.changes).toBeUndefined()
  expect(staged.state.lastInput.input).toEqual(f.staged.changes)
  expect(readTerminalProposalState({ terminalProposalReview: staged.state }, f.identity)?.pending).toEqual([])
})

it('binds the new obligation schema in primary parsing while preserving the old frozen response contract', () => {
  const f = fixture(), chapter = { id: f.identity.chapterId, revision: 8, orderIndex: 6,
    content: [...f.candidate.exitState.knowledge, ...f.candidate.exitState.objects].join(' ') }
  const baseContext = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: 'task', chapterId: chapter.id, obligations: [] }, 5, 2)
  const staged = stageTerminalProposals({ preparedContext: {}, identity: { ...f.identity,
    bodyHash: runtimeJson({ content: chapter.content }).hash, sourceHash: runtimeJson({ previous: null }).hash },
  auditHash: 'a'.repeat(64), base: f.base, candidate: f.candidate, verifiedFactIds: f.verified })!
  if (!staged.changes) throw Error('Fixture must have a proposal catalogue')
  const context = { ...baseContext, proposalChanges: staged.changes }, bodies = { current: chapter.content, previous: null, terminalEvidence: context }
  const rows = f.dispositions.map(item => ({ ...item, id: staged.changes.proposals.find(proposal => proposal.id === item.id)!.id }))
  const response = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic contract fixture.', findingIndexes: [] })),
    terminalVerdicts: [...f.candidate.exitState.knowledge.map((claim, index) => ({ path: `exitState.knowledge.${index}`, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0', quote: claim }] })),
      { path: 'exitState.objects.0', verdict: 'supported', sourceEvidence: [{ segmentId: 'c0', quote: f.candidate.exitState.objects[0] }] }],
    terminalProofVerdicts: [], terminalDispositions: [], proposalDispositions: rows }
  const inspected = inspectContinuityResponse(JSON.stringify(response), bodies, true, 8, f.candidate)
  expect(inspected.complete).toBe(true)
  expect(freshContinuityResponseContract(false, true, 5, bodies)).toContain('proposalDispositions')
  expect(terminalReviewInput(f.candidate, context)).toContain('未证实的旧候选提议')
  const { proposalDispositions: _new, ...legacy } = response
  expect(inspectContinuityResponse(JSON.stringify(legacy), bodies, true, 8, f.candidate).complete).toBe(false)
  const oldBodies = { ...bodies, terminalEvidence: baseContext }
  expect(inspectContinuityResponse(JSON.stringify(legacy), oldBodies, true, 8, f.candidate).complete).toBe(true)
  expect(freshContinuityResponseContract(false, true, 5, oldBodies)).not.toContain('proposalDispositions')
  expect(inspectContinuityResponse(JSON.stringify(response), oldBodies, true, 8, f.candidate).complete).toBe(false)
})
