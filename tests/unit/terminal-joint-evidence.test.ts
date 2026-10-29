import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { terminalEvidenceContext, type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, inspectTerminalReview, currentTerminalReview, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts, terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment, continuityReassessmentRequest } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { buildTerminalFactProofs, readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { terminalReviewStateHash } from '../../api/lib/agent/chapter-review-guard.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { continuitySourceSegments } from '../../api/lib/agent/continuity-review-context.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const previous = { id: 'prior', revision: 3, orderIndex: 1, content: 'The main circuit outputs thirty units.' }
const chapter = { id: 'current', revision: 2, orderIndex: 2, content: 'The reserve now reads one unit.' }
const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The main outputs thirty units and the reserve reads one unit.'] } })
const inheritance = { priorEndState: 'established', currentState: 'unchanged' }
const semanticChecks = Object.fromEntries(['action_direction', 'state_progression'].map(kind => [kind, { result: 'clear', reason: 'Independent full-body judgment.', findingIndexes: [] }]))
function context(version: 4 | 5 = 5): TerminalEvidenceContext {
  return { ...terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: 'task', chapterId: chapter.id, obligations: [] }, version), previous: {
    id: previous.id, revision: previous.revision, orderIndex: 1, contentHash: hash(previous.content), start: 0, end: previous.content.length,
    joinedStart: 0, joinedEnd: previous.content.length, segments: [{ segmentId: 'p0', start: 0, end: previous.content.length, quote: previous.content, hash: runtimeJson({ text: previous.content }).hash }], carried: [],
  } }
}
function response() {
  const fact = terminalCandidateFacts(candidate)[0]
  return { findings: [], semanticChecks, terminalDispositions: [], terminalProofVerdicts: [], terminalVerdicts: [
    { factId: fact.id, path: fact.path, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }, { segmentId: 'p0' }], inheritance },
  ] }
}
const inspect = (parts: unknown, evidence = context(), state = candidate) => inspectContinuityResponse(JSON.stringify(parts), { previous: previous.content, current: chapter.content, terminalEvidence: evidence }, true, 8, state)

describe('request-owned joint terminal evidence v5', () => {
  it('accepts agreeing addresses and jointly attested c/p evidence only in the new frozen contract', () => {
    const parts = response(), before = JSON.stringify(parts), evidence = context()
    expect(inspect(parts)).toMatchObject({ complete: true, audit: { classification: 'complete', terminalEvidence: { verdictProtocol: 5 } } })
    const review = inspectTerminalReview(candidate, chapter.content, JSON.stringify(parts), true, evidence)
    expect(review).toMatchObject({ supported: true, verdicts: [{ basis: 'inherited', sourceEvidence: [{ segmentId: 'c0', quote: chapter.content }, { segmentId: 'p0', quote: previous.content }] }] })
    expect(inspect(parts, context(4))).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid' } })
    const pathOnly = { ...parts, terminalVerdicts: parts.terminalVerdicts.map(({ factId: _id, ...rest }) => rest) }
    expect(inspect(pathOnly, context(4)).complete).toBe(false)
    expect(JSON.stringify(parts)).toBe(before)
    expect(terminalReviewInput(candidate, evidence)).toContain('组合主张可逐引用选择两章原文')
    expect(terminalReviewInput(candidate, context(4))).toContain('禁止混用 cN/pN/tN')
  })

  it.each(['alias-conflict', 'unknown-id', 'unknown-path', 'duplicate', 'missing-inheritance', 'uncertain-prior', 'changed', 'nonpersistent', 'wrong-source-quote', 'invented-span'] as const)('rejects incomplete or conflicting provenance: %s', scenario => {
    const parts = response(), item = parts.terminalVerdicts[0]
    let state = candidate
    if (scenario === 'alias-conflict' || scenario === 'unknown-path') item.path = 'exitState.objects.0'
    if (scenario === 'unknown-id') item.factId = 'f'.repeat(64)
    if (scenario === 'duplicate') parts.terminalVerdicts.push(structuredClone(item))
    if (scenario === 'missing-inheritance') delete (item as { inheritance?: unknown }).inheritance
    if (scenario === 'uncertain-prior') item.inheritance = { ...inheritance, priorEndState: 'uncertain' }
    if (scenario === 'changed') item.inheritance = { ...inheritance, currentState: 'changed' }
    if (scenario === 'nonpersistent') { state = terminalCandidateSchema.parse({ exitState: { location: 'The main outputs thirty units and the reserve reads one unit.' } }); const fact = terminalCandidateFacts(state)[0]; item.factId = fact.id; item.path = fact.path }
    if (scenario === 'wrong-source-quote') Object.assign(item.sourceEvidence[0], { quote: previous.content })
    if (scenario === 'invented-span') item.sourceEvidence[0].segmentId = 'c999'
    expect(inspect(parts, context(), state).complete).toBe(false)
  })

  it.each(['unknown', 'planned', 'negated', 'attributed'])('keeps a valid non-support judgment without semantic auto-repair: %s', async verdict => {
    const parts = response(); parts.terminalVerdicts[0].verdict = verdict
    delete (parts.terminalVerdicts[0] as { inheritance?: unknown }).inheritance
    const evidence = context(), bodies = { previous: previous.content, current: chapter.content, terminalEvidence: evidence }, original = inspect(parts)
    expect(original.complete).toBe(true)
    expect(inspectTerminalReview(candidate, chapter.content, JSON.stringify(parts), true, evidence)?.supported).toBe(false)
    const replayed = inspectContinuityResponse(JSON.stringify(parts), bodies, true, 8, candidate)
    expect(replayed).toEqual(original)
    expect(inspectTerminalReview(candidate, chapter.content, JSON.stringify(parts), true, evidence)?.verdicts[0].verdict).toBe(verdict)
    expect(JSON.parse(replayed.audit.rawResponse.content)).toBe(JSON.stringify(parts))
  })

  it('uses the same contract in a bounded complete reassessment and emits field diagnostics', () => {
    const bodies = { previous: previous.content, current: chapter.content, terminalEvidence: context() }
    const bad = { ...response(), terminalVerdicts: [{ ...response().terminalVerdicts[0], extra: 'invalid' }] }, first = inspect(bad)
    expect(first.audit.terminalReviewDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('terminalVerdicts') })]))
    const request = continuityReassessmentRequest('frozen', 'full request', first, bodies)
    expect(request.content).toContain('terminalReviewDiagnostics')
    const final = applyContinuityReassessment(first, JSON.stringify({ decisions: [], ...response() }), bodies)
    expect(final).toMatchObject({ complete: true, audit: { reassessment: { decisions: [] }, terminalEvidence: { verdictProtocol: 5 } } })
    const old = inspect(bad, context(4))
    expect(old.audit.terminalReviewDiagnostics).toBeUndefined()
    expect(() => applyContinuityReassessment(old, JSON.stringify({ decisions: [], ...response() }), { ...bodies, terminalEvidence: context(4) })).toThrow()
  })

  it('relocates each direct quote only within its own frozen source', () => {
    const current = 'c'.repeat(300) + chapter.content, prior = 'p'.repeat(300) + previous.content, evidence = context()
    evidence.current.contentHash = runtimeJson({ content: current }).hash
    Object.assign(evidence.previous!, { contentHash: hash(prior), end: prior.length, joinedEnd: prior.length,
      segments: continuitySourceSegments({ previous: prior, current: '' }).map(part => ({ segmentId: part.segmentId, quote: part.quote, start: Number(part.segmentId.slice(1)) * 300,
        end: Number(part.segmentId.slice(1)) * 300 + part.quote.length, hash: runtimeJson({ text: part.quote }).hash })) })
    const parts = response()
    Object.assign(parts.terminalVerdicts[0].sourceEvidence[0], { quote: chapter.content })
    Object.assign(parts.terminalVerdicts[0].sourceEvidence[1], { quote: previous.content })
    const review = inspectTerminalReview(candidate, current, JSON.stringify(parts), true, evidence)
    expect(review).toMatchObject({ supported: true, relocations: [{ source: 'current', originalSegmentId: 'c0', actualSegmentId: 'c1' }, { source: 'previous', originalSegmentId: 'p0', actualSegmentId: 'p1' }] })
    Object.assign(parts.terminalVerdicts[0].sourceEvidence[0], { quote: previous.content })
    expect(inspectTerminalReview(candidate, current, JSON.stringify(parts), true, evidence)).toBeNull()
  })

  it('exposes a selected proof candidate address for an unresolved alias obligation', () => {
    const first = context(), parts = response(), parsed = inspect(parts), review = inspectTerminalReview(candidate, chapter.content, JSON.stringify(parts), true, first)!
    const validation = { checkedChapterId: chapter.id, checkedRevision: chapter.revision,
      coverage: compilerContinuityCoverage({ chapter, bridge: {}, sceneTasks: [], source: null, terminalCandidate: candidate }, 11),
      terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: parsed.audit }
    const carried = buildTerminalFactProofs({ compilationId: 'second-compile', chapter, validation, stateHash: 'a'.repeat(64), evidence: first, review })
    expect(review).not.toHaveProperty('deliveryEligibility')
    expect(carried).toHaveLength(1)
    const next = { id: 'third', orderIndex: 3, revision: 1, content: 'The officer closes the log.' }, old = { field: 'knowledge' as const, claim: 'The circuit resource readings remain on record.', id: terminalFactId('knowledge', 'The circuit resource readings remain on record.') }
    const evidence = terminalEvidenceContext(next, null, 2, 1, { version: 2, taskId: 'task', chapterId: next.id, obligations: [old] }, 5)
    evidence.previous = { ...first.previous!, id: chapter.id, orderIndex: 2, revision: chapter.revision, contentHash: hash(chapter.content), end: chapter.content.length, joinedEnd: chapter.content.length, segments: [], carried }
    const fact = terminalCandidateFacts(candidate)[0], prompt = terminalReviewInput(candidate, evidence)
    expect(prompt).toContain(`已选择历史候选的稳定目标：${JSON.stringify([{ factId: fact.id, field: fact.field, claim: fact.claim }])}`)
    const report = { findings: [], semanticChecks, terminalVerdicts: [], terminalProofVerdicts: [{ proofHash: carried[0].proofHash, currentState: 'unchanged', reason: 'The whole current body preserves the circuit readings.' }],
      terminalDispositions: [{ id: old.id, outcome: 'replaced', candidateFactId: fact.id, reason: 'The complete unresolved record is carried by this supported candidate.', sourceEvidence: [] }] }
    expect(inspectTerminalReview(candidate, next.content, JSON.stringify(report), true, evidence)?.supported).toBe(true)
    const unknownReport = { ...report, terminalProofVerdicts: [{ ...report.terminalProofVerdicts[0], currentState: 'uncertain' }],
      terminalDispositions: [{ id: old.id, outcome: 'unknown', reason: 'No new attestation discharges the old obligation.', sourceEvidence: [] }] }
    const unknown = inspectTerminalReview(candidate, next.content, JSON.stringify(unknownReport), true, evidence)!
    expect(unknown).toMatchObject({ supported: false, verdicts: [{ verdict: 'unknown', basis: 'inherited' }] })
    expect(unknown).not.toHaveProperty('deliveryEligibility')
    expect(buildTerminalFactProofs({ compilationId: 'unknown-without-authority', chapter: next, validation,
      stateHash: 'b'.repeat(64), evidence, review: unknown })).toEqual([])
    report.terminalDispositions[0].candidateFactId = old.id
    expect(inspectTerminalReview(candidate, next.content, JSON.stringify(report), true, evidence)).toBeNull()
  })

  it.each(['none', 'current-revision', 'previous-revision', 'anchor', 'anchor-removed', 'predecessor', 'field', 'claim'] as const)('revalidates a three-chapter mixed → unchanged proof chain: %s', async tamper => {
    const compilations = new Map<string, Record<string, unknown>>()
    const chapters = [previous, chapter, { id: 'third', revision: 1, orderIndex: 3, content: 'The officer closes the log.' }]
    function save(current: typeof chapter, evidence: TerminalEvidenceContext, parts: Record<string, unknown>) {
      const raw = JSON.stringify({ findings: [], semanticChecks, terminalDispositions: [], ...parts })
      const parsed = inspectContinuityResponse(raw, { previous: null, current: current.content, terminalEvidence: evidence }, true, 8, candidate)
      expect(parsed.complete).toBe(true)
      const bridge = { committedAt: new Date(1), targetRevision: current.revision }, sceneTasks: unknown[] = []
      const stateHash = terminalReviewStateHash(bridge, sceneTasks)
      const validation = { checkedChapterId: current.id, checkedRevision: current.revision, independentCheck: 'complete', terminalCandidate: candidate,
        coverage: compilerContinuityCoverage({ chapter: current, bridge, sceneTasks, source: null, terminalCandidate: candidate }, 11), continuityCriticResponse: parsed.audit }
      const review = currentTerminalReview(validation, current.content, evidence)!
      expect(review.supported).toBe(true)
      const proofs = buildTerminalFactProofs({ compilationId: current.id + '-compile', chapter: current, validation, stateHash, evidence, review })
      compilations.set(current.id + '-compile', { id: current.id + '-compile', chapterId: current.id, bridge, sceneTasks, validation,
        preparedContext: { terminalFactProofs: proofs, terminalCandidateHash: review.candidateHash, terminalContentHash: review.contentHash, terminalReviewProof: { version: 2, terminalStateHash: stateHash } } })
      return proofs
    }
    const mixed = save(chapter, context(), { terminalVerdicts: response().terminalVerdicts, terminalProofVerdicts: [] })
    expect(mixed[0].anchors.map(anchor => anchor.chapterId)).toEqual([chapter.id, previous.id])
    expect(mixed[0]).toMatchObject({ depth: 1, nodes: [expect.objectContaining({ chapterId: chapter.id, previousChapterId: previous.id })] })
    const third = chapters[2], evidence = terminalEvidenceContext(third, null, 2, 1, { version: 2, taskId: 'task', chapterId: third.id, obligations: [] }, 5)
    evidence.previous = { ...context().previous!, id: chapter.id, revision: chapter.revision, orderIndex: 2, contentHash: hash(chapter.content), end: chapter.content.length, joinedEnd: chapter.content.length, segments: [], carried: mixed }
    const chain = save(third, evidence, { terminalVerdicts: [], terminalProofVerdicts: [{ proofHash: mixed[0].proofHash, currentState: 'unchanged', reason: 'Independently checked the full new chapter; no change.' }] })
    expect(chain[0].depth).toBe(2)
    const currentChapters = structuredClone(chapters), last = compilations.get(third.id + '-compile')!
    const facts = (last.preparedContext as { terminalFactProofs: typeof chain }).terminalFactProofs
    if (tamper === 'current-revision') currentChapters[1].revision++
    if (tamper === 'previous-revision') currentChapters[0].revision++
    if (tamper === 'anchor') facts[0].anchors[0].quote = 'Forged quotation.'
    if (tamper === 'anchor-removed') facts[0].anchors.pop()
    if (tamper === 'field') facts[0].field = 'objects'
    if (tamper === 'claim') facts[0].claim += ' Changed.'
    // Re-seal the tampered outer record: rejection must also come from the
    // actual source/review/claim binding, not only an obsolete outer digest.
    facts[0].proofHash = runtimeJson({ field: facts[0].field, claim: facts[0].claim, anchors: facts[0].anchors, nodes: facts[0].nodes }).hash
    const tx = { storyCompilation: { findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => where.id ? compilations.get(where.id) : last) }, chapter: { findFirst: vi.fn(async ({ where, select }: { where: { id?: string; orderIndex?: { lt: number } }; select?: unknown }) => where.id ? currentChapters.find(c => c.id === where.id) : select ? { id: tamper === 'predecessor' ? 'foreign' : currentChapters.filter(c => c.orderIndex < where.orderIndex!.lt).at(-1)?.id } : null) } } as unknown as Prisma.TransactionClient
    const actual = await readTerminalInheritance(tx, { userId: 'author', novelId: 'novel' }, third)
    expect(actual).toEqual(tamper === 'none' ? chain : [])
  })
})
