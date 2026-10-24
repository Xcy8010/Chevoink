import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTerminalFactProofs, readTerminalInheritance, terminalAssessmentHash } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { terminalEvidenceContext, type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse, continuityFailureOutput } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalReviewStateHash } from '../../api/lib/agent/chapter-review-guard.js'
import { stageTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable', reason: '合成事实继承。', findingIndexes: [] }))
const initial = terminalCandidateSchema.parse({ exitState: { openLoops: ['过滤泵检修等零件'] } })
const baseContext = (id: string, orderIndex: number, content: string): TerminalEvidenceContext => ({ protocol: 2,
  current: { id, orderIndex, revision: 1, contentHash: runtimeJson({ content }).hash }, previous: null })
function assessment(chapter: { id: string; orderIndex: number; revision: number; content: string }, evidence: TerminalEvidenceContext,
  candidate: typeof initial, verdicts: unknown[]) {
  const raw = JSON.stringify({ findings: [], terminalVerdicts: verdicts, semanticChecks: checks })
  const inspected = inspectContinuityResponse(raw, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
  const validation = { checkedChapterId: chapter.id, checkedRevision: 1, checkedAt: 'old', checkRounds: 1,
    coverage: compilerContinuityCoverage({ chapter, bridge: {}, sceneTasks: [], source: null, terminalCandidate: candidate }, 11),
    terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
  return { validation, review: currentTerminalReview(validation, chapter.content, evidence) }
}

function sharedFactFixture() {
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: Array.from({ length: 20 }, (_, i) => `物件${i}仍在柜内`) } })
  const chapter = { id: 'shared-chapter', orderIndex: 1, revision: 1, content: candidate.exitState.objects.join('。') + '。' }
  const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: 'shared-task', chapterId: chapter.id, obligations: [] }, 5, 2)
  const proposals = stageTerminalProposals({ preparedContext: {}, identity: { taskId: 'shared-task', chapterId: chapter.id,
    bodyHash: context.current.contentHash, sourceHash: runtimeJson({ previous: null }).hash }, auditHash: 'a'.repeat(64),
    base: terminalCandidateSchema.parse({ exitState: { ...candidate.exitState, emotion: ['一个尚未证实的旧情绪提议'] } }), candidate, verifiedFactIds: [] })!
  const evidence = { ...context, proposalChanges: proposals.changes }
  const raw = JSON.stringify({ findings: [], semanticChecks: checks, terminalDispositions: [], terminalProofVerdicts: [],
    terminalVerdicts: candidate.exitState.objects.map((claim, i) => ({ path: `exitState.objects.${i}`, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0', quote: claim }] })),
    proposalDispositions: proposals.changes!.proposals.map(proposal => ({ id: proposal.id, outcome: 'unknown', reason: '原提议没有获得证实。', sourceEvidence: [] })) })
  const inspected = inspectContinuityResponse(raw, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
  expect(inspected.complete).toBe(true)
  const bridge = { committedAt: new Date(1), targetRevision: 1 }, sceneTasks: unknown[] = []
  const stateHash = terminalReviewStateHash(bridge, sceneTasks)
  const validation = { checkedChapterId: chapter.id, checkedRevision: 1, independentCheck: 'complete', terminalCandidate: candidate,
    coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null, terminalCandidate: candidate }, 11), continuityCriticResponse: inspected.audit }
  const preparedContext = { terminalProposalReview: proposals.state, terminalCandidateHash: runtimeJson(candidate).hash,
    terminalContentHash: context.current.contentHash, terminalReviewProof: { version: 2, terminalStateHash: stateHash } }
  const review = currentTerminalReview(validation, chapter.content, evidence, { taskId: 'shared-task', preparedContext })!
  expect(review).toMatchObject({ supported: false, deliveryEligibility: { eligible: true, basis: 'current_supported_with_preserved_drafts' } })
  const proofs = buildTerminalFactProofs({ compilationId: 'shared-compilation', chapter, validation, stateHash, evidence, review })
  expect(proofs).toHaveLength(20)
  const compilation = { id: 'shared-compilation', runId: 'shared-run', chapterId: chapter.id, bridge, sceneTasks, validation,
    preparedContext: { ...preparedContext, terminalFactProofs: proofs } }
  const run = { id: 'shared-run', sessionId: 'shared-session', taskRootId: null, startRequest: { prompt: '写第一章' }, taskSpec: { id: 'shared-task' } }
  const tx = { storyCompilation: { findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => !where.id || where.id === compilation.id ? compilation : null) },
    chapter: { findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => where.id === chapter.id ? chapter : null) },
    agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run) },
    agentChildExecutionGrant: { findUnique: vi.fn(async () => null) }, agentSession: { findFirst: vi.fn(async () => null) } }
  return { chapter, compilation, proofs, tx, read: () => readTerminalInheritance(tx as unknown as Prisma.TransactionClient,
    { userId: 'author', novelId: 'novel' }, chapter) }
}
describe('bounded flat terminal fact chains', () => {
  it('authenticates each shared compilation once and preserves the full raw report and exact proof output', async () => {
    const f = sharedFactFixture(), before = JSON.stringify(f.compilation)
    expect(await f.read()).toEqual(f.proofs)
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledTimes(1)
    expect(f.tx.agentRun.findFirstOrThrow).toHaveBeenCalledTimes(2)
    expect(f.tx.agentChildExecutionGrant.findUnique).toHaveBeenCalledTimes(1)
    expect(f.tx.agentSession.findFirst).toHaveBeenCalledTimes(1)
    expect(f.tx.storyCompilation.findFirst).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.compilation)).toBe(before)
    expect(runtimeJson(await f.read()).hash).toBe(runtimeJson(f.proofs).hash)
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledTimes(2)
    expect(f.tx.storyCompilation.findFirst).toHaveBeenCalledTimes(2)
  })

  it.each(['stateHash', 'validationHash', 'candidateHash', 'path', 'chapterId'] as const)('does not let a forged first node %s poison later facts', async field => {
    const f = sharedFactFixture(), first = f.proofs[0], expected = structuredClone(f.proofs.slice(1))
    first.nodes[0][field] = field === 'path' ? 'exitState.objects.1' : field === 'chapterId' ? 'foreign-chapter' : 'f'.repeat(64)
    first.proofHash = runtimeJson({ field: first.field, claim: first.claim, anchors: first.anchors, nodes: first.nodes }).hash
    expect(await f.read()).toEqual(expected.map((fact, i) => ({ ...fact, segmentId: `t${i}` })))
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })

  it.each(['revision', 'body', 'validation', 'proof', 'proposal'] as const)('freshly rejects %s drift on the next invocation', async tamper => {
    const f = sharedFactFixture()
    expect(await f.read()).toEqual(f.proofs)
    if (tamper === 'revision') f.chapter.revision++
    if (tamper === 'body') f.chapter.content += '正文已变化。'
    if (tamper === 'validation') f.compilation.validation.continuityCriticResponse.contentHash = 'f'.repeat(64)
    if (tamper === 'proof') f.compilation.preparedContext.terminalReviewProof.terminalStateHash = 'f'.repeat(64)
    if (tamper === 'proposal') f.compilation.preparedContext.terminalProposalReview.lastInput.pendingHash = 'f'.repeat(64)
    expect(await f.read()).toEqual([])
    expect(f.tx.storyCompilation.findFirst).toHaveBeenCalledTimes(2)
  })

  it('never authenticates a compilation as another chapter, then rereads its real identity on a new invocation', async () => {
    const f = sharedFactFixture(), original = structuredClone(f.proofs), foreign = { ...f.chapter, id: 'foreign-chapter' }
    f.tx.chapter.findFirst.mockImplementation(async ({ where }) => where.id === foreign.id ? foreign : where.id === f.chapter.id ? f.chapter : null)
    for (const fact of f.proofs) {
      fact.nodes[0].chapterId = foreign.id
      fact.proofHash = runtimeJson({ field: fact.field, claim: fact.claim, anchors: fact.anchors, nodes: fact.nodes }).hash
    }
    expect(await readTerminalInheritance(f.tx as unknown as Prisma.TransactionClient, { userId: 'author', novelId: 'novel' }, foreign)).toEqual([])
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledTimes(1)
    f.proofs.splice(0, f.proofs.length, ...original)
    expect(await f.read()).toEqual(original)
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledTimes(2)
  })

  it('propagates original task authentication failures without caching a passed fact', async () => {
    const f = sharedFactFixture(), failure = new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', 'Synthetic original task failure')
    f.tx.agentRun.findFirst.mockRejectedValueOnce(failure)
    await expect(f.read()).rejects.toBe(failure)
    expect(await f.read()).toEqual(f.proofs)
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledTimes(2)
  })

  it.each(['field', 'claim'])('retains a rejected carried %s binding and exposes its exact internal recovery path', kind => {
    const first = { id: 'first', orderIndex: 1, revision: 1, content: '冷却泵仍待检修。' }
    const evidence = baseContext(first.id, 1, first.content)
    const { validation, review } = assessment(first, evidence, initial,
      [{ path: 'exitState.openLoops.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '冷却泵仍待检修' }] }])
    const carried = buildTerminalFactProofs({ compilationId: 'first-compilation', chapter: first, validation, evidence, review: review!, stateHash: 'a'.repeat(64) })
    const current = { id: 'second', orderIndex: 2, revision: 2, content: '他取出清单。' }
    const context = { ...baseContext(current.id, 2, current.content), previous: { id: first.id, revision: 1, orderIndex: 1,
      contentHash: createHash('sha256').update(first.content).digest('hex'), start: 0, end: first.content.length,
      joinedStart: 0, joinedEnd: first.content.length, segments: [], carried } }
    const candidate = terminalCandidateSchema.parse({ exitState: kind === 'field' ? { objects: initial.exitState.openLoops }
      : { openLoops: ['冷却泵修好后才能启航'] } })
    const path = kind === 'field' ? 'exitState.objects.0' : 'exitState.openLoops.0'
    const response = JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: [{ path, verdict: 'supported', basis: 'inherited',
      sourceEvidence: [{ segmentId: 't0', quote: '冷却泵仍待检修' }], inheritance: { priorEndState: 'established', currentState: 'unchanged' } }] })
    const before = structuredClone({ candidate, context, response })
    const rejected = inspectContinuityResponse(response, { previous: first.content, current: current.content, terminalEvidence: context }, true, 8, candidate)
    expect(rejected.complete).toBe(false)
    expect(rejected.audit).toMatchObject({ classification: 'terminal_invalid', terminalReviewDiagnostics: [
      { code: 'carried_fact_mismatch', path, referenceIndex: 0, segmentId: 't0' }] })
    expect(continuityFailureOutput(rejected.audit, 'original failure')).toContain(path)
    expect({ candidate, context, response }).toEqual(before)
    const corrected = JSON.stringify({ ...JSON.parse(response), terminalVerdicts: [{ ...JSON.parse(response).terminalVerdicts[0], path: 'exitState.openLoops.0' }] })
    expect(assessment(current, context, initial, JSON.parse(corrected).terminalVerdicts).review?.supported).toBe(true)
  })
  it('ignores cache counters/time while binding semantic coverage and actual response', () => {
    const chapter = { id: 'c', orderIndex: 1, revision: 1, content: '过滤泵仍需检修。' }
    const { validation } = assessment(chapter, baseContext(chapter.id, 1, chapter.content), initial,
      [{ path: 'exitState.openLoops.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '过滤泵仍需检修' }] }])
    expect(terminalAssessmentHash(validation)).toBe(terminalAssessmentHash({ ...validation, checkedAt: 'new', checkRounds: 99 }))
    expect(terminalAssessmentHash(validation)).not.toBe(terminalAssessmentHash({ ...validation, continuityCriticResponse: { ...validation.continuityCriticResponse, contentHash: 'b'.repeat(64) } }))
    const base = { chapter, bridge: {}, sceneTasks: [], source: null, terminalCandidate: initial }
    expect(compilerContinuityCoverageMatches(compilerContinuityCoverage(base, 10), compilerContinuityCoverage(base, 11))).toBe(false)
  })
  it('limits each fact to16 nodes while a new directly proven fact starts its own root', () => {
    let previous: ReturnType<typeof buildTerminalFactProofs> = []
    let previousBody = '', previousId = ''
    for (let index = 1; index <= 16; index++) {
      const chapter = { id: `c${index}`, revision: 1, orderIndex: index, content: index === 1 ? '过滤泵仍需检修。' : index === 16 ? '新锁栓已经断裂。' : '她取走清单。' }
      const evidence = baseContext(chapter.id, index, chapter.content)
      if (index > 1) evidence.previous = { id: previousId, revision: 1, orderIndex: index - 1, contentHash: createHash('sha256').update(previousBody).digest('hex'),
        start: 0, end: previousBody.length, joinedStart: 0, joinedEnd: previousBody.length, segments: [], carried: previous }
      const candidate = index === 16 ? terminalCandidateSchema.parse({ exitState: { ...initial.exitState, objects: ['新锁栓已经断裂'] } }) : initial
      const verdicts = [{ path: 'exitState.openLoops.0', verdict: 'supported', basis: index === 1 ? 'current' : 'inherited',
        sourceEvidence: [{ segmentId: index === 1 ? 'c0' : 't0', quote: '过滤泵仍需检修' }],
        ...(index === 1 ? {} : { inheritance: { priorEndState: 'established', currentState: 'unchanged' } }) },
      ...(index === 16 ? [{ path: 'exitState.objects.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '新锁栓已经断裂' }] }] : [])]
      const { validation, review } = assessment(chapter, evidence, candidate, verdicts)
      expect(review?.supported).toBe(true)
      previous = buildTerminalFactProofs({ compilationId: `compile${index}`, chapter, validation, evidence, review: review!, stateHash: 'a'.repeat(64) })
      previousBody = chapter.content; previousId = chapter.id
    }
    expect(previous.find(fact => fact.field === 'openLoops')?.depth).toBe(16)
    expect(previous.find(fact => fact.field === 'objects')?.depth).toBe(1)
    const chapter = { id: 'next', revision: 1, orderIndex: 17, content: '她关好了箱盖。' }, evidence = baseContext(chapter.id, 17, chapter.content)
    evidence.previous = { id: previousId, revision: 1, orderIndex: 16, contentHash: createHash('sha256').update(previousBody).digest('hex'),
      start: 0, end: previousBody.length, joinedStart: 0, joinedEnd: previousBody.length, segments: [], carried: previous }
    const old = previous.find(fact => fact.field === 'openLoops')!, fresh = previous.find(fact => fact.field === 'objects')!
    const verdict = (id: string, path: string, quote: string, value = 'supported') => ({ path, verdict: value, basis: 'inherited', sourceEvidence: [{ segmentId: id, quote }],
      inheritance: { priorEndState: 'established', currentState: 'unchanged' } })
    expect(assessment(chapter, evidence, initial, [verdict(old.segmentId, 'exitState.openLoops.0', '过滤泵仍需检修')]).review).toBeNull()
    expect(assessment(chapter, evidence, initial, [verdict(old.segmentId, 'exitState.openLoops.0', '过滤泵仍需检修', 'unknown')]).review?.supported).toBe(false)
    const freshCandidate = terminalCandidateSchema.parse({ exitState: { objects: ['新锁栓已经断裂'] } })
    const accepted = assessment(chapter, evidence, freshCandidate, [verdict(fresh.segmentId, 'exitState.objects.0', '新锁栓已经断裂')])
    expect(accepted.review?.supported).toBe(true)
    expect(buildTerminalFactProofs({ compilationId: 'next', chapter, evidence, ...accepted, review: accepted.review!, stateHash: 'a'.repeat(64) })[0].depth).toBe(2)
  })
})
