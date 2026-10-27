import { describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import type { TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { advanceTerminalCoverage } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { continuitySubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { bindLegacyContinuityAssessment, runContinuityReassessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { buildContinuityReviewManifest, continuityReviewV4Request, continuityReviewV4ResponseSchema, inspectContinuityV4, normalizeContinuityV4Projection, normalizeContinuityV4ProjectionV2, validateStoredContinuityV4Projection, buildContinuityInvalidRowRepair, failedContinuityV4Repair, applyContinuityV4Repair } from '../../api/lib/agent/continuity-review-v4.js'
import { readAuthenticatedContinuityAssessment, isContinuityV4Inspection } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as originalRequests from '../../api/lib/agent/original-request.js'
import * as lifecycle from '../../api/lib/agent/assessment-response-lifecycle.js'
import * as coordinator from '../../api/lib/agent/continuity-coordinator.js'
import * as sources from '../../api/lib/agent/compiler-continuity-source.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { buildTerminalFactProofs, readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { continuityDecisionBinding, terminalReviewStateHash } from '../../api/lib/agent/chapter-review-guard.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import type { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalReviewAddressCatalog } from '../../api/lib/agent/terminal-review-addresses.js'
import type { TerminalInheritanceReadScope } from '../../api/lib/agent/terminal-inheritance-chain.js'

function fixture(duplicate = false, pendingProposal = true, pendingCoverage = true) {
  const quote = 'The brass seal remains intact.', oldClaim = 'The pump awaits a replacement seal.'
  const current = `${'x'.repeat(290)}${quote} The clerk waits.${duplicate ? `${'y'.repeat(280)}${quote}` : ''}`
  const previous = 'The old pump awaits a replacement.'
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The brass seal remains intact.'], openLoops: [oldClaim] } })
  const rootChapter = { id: 'previous', revision: 2, orderIndex: 1, content: previous }
  const rootCandidate = terminalCandidateSchema.parse({ exitState: { openLoops: [oldClaim] } })
  const rootEvidence: TerminalEvidenceContext = { protocol: 2, current: { id: rootChapter.id, revision: 2, orderIndex: 1,
    contentHash: runtimeJson({ content: previous }).hash }, previous: null }
  const rootInspection = inspectContinuityResponse(JSON.stringify({ findings: [],
    semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full canonical report.', findingIndexes: [] })),
    terminalVerdicts: [{ path: 'exitState.openLoops.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: previous }] }] }),
  { current: previous, previous: null, terminalEvidence: rootEvidence }, true, 8, rootCandidate)
  const rootBridge = { committedAt: new Date(1), targetRevision: 2 }, rootStateHash = terminalReviewStateHash(rootBridge, [])
  const rootValidation = { checkedChapterId: rootChapter.id, checkedRevision: 2, independentCheck: 'complete',
    coverage: { protocolVersion: 11, contentHash: rootEvidence.current.contentHash, terminalHash: runtimeJson(rootCandidate).hash },
    terminalCandidate: rootCandidate, continuityCriticResponse: rootInspection.audit }
  const rootReview = currentTerminalReview(rootValidation, previous, rootEvidence)!
  const carried = buildTerminalFactProofs({ compilationId: 'old-compiler', chapter: rootChapter, validation: rootValidation,
    stateHash: rootStateHash, evidence: rootEvidence, review: rootReview })
  const rootCompilation = { id: 'old-compiler', chapterId: rootChapter.id, validation: rootValidation, bridge: rootBridge, sceneTasks: [],
    preparedContext: { terminalFactProofs: carried, terminalCandidateHash: runtimeJson(rootCandidate).hash,
      terminalContentHash: rootEvidence.current.contentHash, terminalReviewProof: { version: 2, terminalStateHash: rootStateHash } } }
  const draft = terminalDraftFixture('emotion', { chapter: { id: 'chapter', revision: 4, orderIndex: 2, content: current }, taskId: 'task',
    ctx: { userId: 'user', novelId: 'novel', runId: 'run' }, compilationId: 'compilation', candidate,
    originBindingHash: 'b'.repeat(64), currentBindingHash: 'c'.repeat(64) })
  const context: TerminalEvidenceContext = { ...draft.nextContext,
    previous: { id: 'previous', revision: 2, orderIndex: 1, contentHash: runtimeJson({ content: previous }).hash,
      start: 0, end: previous.length, joinedStart: 0, joinedEnd: previous.length,
      segments: [{ segmentId: 'p0', start: 0, end: previous.length, quote: previous, hash: runtimeJson({ text: previous }).hash }],
      carried },
    factCoverage: { version: 2, taskId: 'task', chapterId: 'chapter', obligations: pendingCoverage ? [{ id: terminalFactId('openLoops', 'The distant crate remains unaccounted for.'),
      field: 'openLoops', claim: 'The distant crate remains unaccounted for.' }] : [] } }
  context.proposalChanges = { ...context.proposalChanges!, sourceHash: runtimeJson({ previous: context.previous }).hash }
  const bodies = { current, previous, terminalEvidence: context }, sourceScope = { currentOrderIndex: 2, previous: [{ orderIndex: 1, startOffset: 0, endOffset: previous.length }] }
  const planBody = { version: 1 as const, originalTaskId: 'task', originalAdmissionId: 'run', chapterId: 'chapter', compilationId: 'compilation',
    authorityHash: 'f'.repeat(64), semanticSubjectHash: continuitySubjectIdentity({ chapterId: 'chapter', revision: 4, targetType: 'story_compilation',
      targetId: 'compilation', bodies, terminalCandidate: candidate, sourceScope })!, modelPriceHash: 'b'.repeat(64), budgetOwner: 'task',
    phases: [{ kind: 'initial_review' as const, limit: 1, authoritySourceRef: 'original-admission:run' }] }
  const manifest = buildContinuityReviewManifest({ subject: { userId: 'user', novelId: 'novel', taskId: 'task', targetType: 'story_compilation',
    targetId: 'compilation', chapterId: 'chapter', revision: 4 }, bodies, candidate, sourceScope, sourceHash: runtimeJson({ previous }).hash,
    sourceVersions: { current: context.current, previous: context.previous }, verifiedCoverage: context.factCoverage,
    draftProposals: context.proposalChanges ?? null, typedLineage: { version: 1, phasePlan: { ...planBody, hash: runtimeJson(planBody).hash }, priorFindings: [], establishedIssues: [] } })
  const frozen = { manifest, bodies, candidate, sourceScope }
  const wire = { findings: [{ findingId: 'f0', signal: 'object', severity: 'error', reasonCode: 'manuscript_conflict',
    explanation: 'An independent candidate issue remains for the author to verify.', suggestion: 'Verify necessity before editing.',
    manuscriptEvidence: [{ segmentId: 'c1', quote: 'The clerk waits.' }, { segmentId: 'c1', quote: 'intact.' }] }],
  semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reasonCode: 'consistent', explanation: 'Whole manuscript review.', findingIds: [] })),
  terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', reasonCode: 'consistent', explanation: 'The exact current quote supports the claim.', manuscriptEvidence: [{ segmentId: 'c1', quote }] }],
  terminalProofVerdicts: [{ proofIndex: 0, currentState: 'uncertain', reasonCode: 'insufficient_evidence',
    explanation: `The prior claim “${oldClaim}” and anchor “${previous}” do not establish a new answer; current text says “The clerk waits.”.` }],
  terminalDispositions: pendingCoverage ? [{ obligationIndex: 0, outcome: 'unknown', reasonCode: 'retained_obligation', explanation: 'This question remains pending.', manuscriptEvidence: [] }] : [],
  proposalDispositions: [{ proposalIndex: 0, outcome: pendingProposal ? 'unknown' : 'retracted', reasonCode: 'insufficient_evidence',
    explanation: 'The old draft “A reply remains pending.” is not established.', manuscriptEvidence: [{ segmentId: 'c1', quote: 'The clerk waits.' }] }],
  issueDispositions: [] }
  const input: LegacyAssessmentInput = { chapterId: 'chapter', revision: 4, bodies, sourceScope, terminalCandidate: candidate,
    parserVersion: 10, reassessmentProtocol: 7, continuityManifest: manifest, targetType: 'story_compilation', targetId: 'compilation',
    system: 'Frozen contract5 reviewer.', content: 'Complete synthetic frozen request.', bindingHash: 'c'.repeat(64) }
  const inspect = (value: unknown = wire, complete = true) => inspectContinuityV4(JSON.stringify(value), frozen, complete)
  return { quote, oldClaim, current, context, frozen, wire, input, inspect, hash: runtimeJson(input).hash, rootChapter, rootCompilation }
}

describe('explicit whole-report projection normalization', () => {
  it.each(['preserve', 'changed', 'ordinary-unknown', 'chain-drift', 'hard-obligation', 'canonical-coverage', 'origin-missing', 'unretained-error',
    'committed-reopened', 'legacy-commit', 'native-commit', 'unknown-commit'] as const)(
    'authenticates preserved scope without rewriting any verdict: %s', async scenario => {
      const f = fixture(false, false), ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
      const wire = structuredClone(f.wire)
      if (scenario === 'changed') wire.terminalProofVerdicts[0].currentState = 'changed'
      if (scenario === 'ordinary-unknown') { wire.terminalVerdicts[0].verdict = 'unknown'; wire.terminalVerdicts[0].reasonCode = 'insufficient_evidence' }
      const first = f.inspect(wire), derived = bindLegacyContinuityAssessment(normalizeContinuityV4Projection(first, f.hash), ctx, f.input)
      expect(derived.complete, JSON.stringify({ classification: derived.audit.classification, diagnostics: derived.parsed?.diagnostics })).toBe(true)
      const parsedInput = lifecycle.legacyAssessmentInputSchema.parse(f.input)
      expect(runtimeJson(parsedInput).hash).toBe(f.hash)
      expect(runtimeJson(bindLegacyContinuityAssessment(first, ctx, parsedInput, true).audit).hash).toBe(runtimeJson(derived.audit).hash)
      const validation: Record<string, unknown> = { checkedChapterId: 'chapter', checkedRevision: 4, independentCheck: 'complete',
        coverage: { protocolVersion: 11, contentHash: runtimeJson({ content: f.current }).hash, terminalHash: runtimeJson(f.frozen.candidate).hash },
        terminalCandidate: f.frozen.candidate, continuityCriticResponse: derived.audit }
      validation.effectiveReport = await coordinator.stageEffectiveContinuityReport({ agentArtifact: { findUnique: async () => null,
        create: async () => ({}) } } as unknown as Prisma.TransactionClient, ctx,
      { compilationId: 'compilation', audit: derived.audit, previousValidation: {} })
      if (scenario !== 'unretained-error') {
        const reportId = continuityDecisionBinding('compilation', 4, validation)
        validation.retainedReviewDecision = { version: 1, chapterId: 'chapter', revision: 4, contentHash: runtimeJson({ content: f.current }).hash,
          continuityBinding: reportId, qualityReportId: null, qualityReportHash: null,
          findings: [{ source: 'continuity', reportId, findingId: '0', reason: 'The independent opinion remains recorded; the author retains the current wording after verifying its scope.' }] }
      }
      const obligation = f.context.factCoverage!.obligations[0]
      const preparedContext = { terminalProposalReview: { version: 1, taskId: 'task', chapterId: 'chapter', pending: f.context.proposalChanges!.proposals,
        lastInput: { input: f.context.proposalChanges!, pendingHash: runtimeJson(f.context.proposalChanges!.proposals).hash } },
      terminalFactCoverage: { version: 1, taskId: 'task', chapterId: 'chapter', facts: [obligation],
        lastReview: { bodyHash: runtimeJson({ content: f.current }).hash, candidateHash: runtimeJson(f.frozen.candidate).hash, input: f.context.factCoverage } } }
      const original = { taskId: 'task', sourceRunId: 'run', parentRunId: null, prompt: '写下一章',
        spec: { id: 'task', scope: { terminalCoverageProtocol: 2 }, hardConstraints: scenario === 'hard-obligation' ? [{ text: 'Close the crate question in this chapter.' }] : [], postconditions: [] } }
      const carried = structuredClone(f.context.previous!.carried!)
      if (scenario === 'chain-drift') carried[0].nodes[0].bodyHash = '0'.repeat(64)
      const mocks = [
        vi.spyOn(originalRequests, 'readOriginalTaskRequest').mockResolvedValue(original as unknown as Awaited<ReturnType<typeof originalRequests.readOriginalTaskRequest>>),
        vi.spyOn(originalRequests, 'originalTaskRunIds').mockResolvedValue(['run']),
        vi.spyOn(coordinator, 'authenticateEffectiveContinuityReport').mockResolvedValue(true),
        vi.spyOn(coordinator, 'readNormalizedContinuityCoverageOrigins').mockResolvedValue(scenario === 'origin-missing' ? null : {
          origins: [{ factId: obligation.id, reservationId: 'actual-old-applied-reservation', reportHash: '1'.repeat(64),
            bodyHash: '2'.repeat(64), sourceHash: '3'.repeat(64), candidateHash: '4'.repeat(64), revision: 3 }],
        } as Awaited<ReturnType<typeof coordinator.readNormalizedContinuityCoverageOrigins>>),
        vi.spyOn(lifecycle, 'readLegacyContinuityAssessment').mockResolvedValue({ inspected: first, billingKnown: true, providerComplete: true,
          recoveryReady: true } as Awaited<ReturnType<typeof lifecycle.readLegacyContinuityAssessment>>),
        vi.spyOn(sources, 'readCompilerContinuitySource').mockResolvedValue({ terminalInheritance: carried } as Awaited<ReturnType<typeof sources.readCompilerContinuitySource>>),
      ]
      const nativeResult = { toolResult: { display: { compilationId: 'old-committed-compilation', phase: 'commit' } } }, nativeHash = runtimeJson(nativeResult).hash
      const db = { agentArtifact: { findMany: vi.fn(async () => [{ runId: 'run', metadata: { input: f.input, callId: 'original' } }]),
        findFirst: vi.fn(async () => ({ createdAt: new Date(10) })) },
      agentRunEvent: { findMany: vi.fn(async ({ where }: { where: { type: string } }) => where.type === 'tool.result'
        ? ['legacy-commit', 'unknown-commit'].includes(scenario) ? [{ runId: 'run', payload: { toolName: 'chapter_bridge_commit', ok: true,
          callId: 'old-commit', display: { compilationId: 'old-committed-compilation', phase: 'commit' } } }] : []
        : scenario === 'legacy-commit' ? [{ payload: { callId: 'old-commit', toolName: 'chapter_bridge_commit', args: { compilationId: 'old-committed-compilation' } } }] : []) },
      agentEffectReceipt: { findMany: vi.fn(async () => scenario === 'native-commit' ? [{ operationId: 'native-old-commit',
        operation: { status: 'succeeded' }, result: nativeResult, resultHash: nativeHash }] : []) },
      agentExecutionOutbox: { findFirst: vi.fn(async () => ({ payload: { operationId: 'native-old-commit', resultHash: nativeHash } })) },
      storyCompilation: { count: vi.fn(async () => scenario === 'canonical-coverage' ? 1 : 0),
        findMany: vi.fn(async () => [{ id: 'compilation', preparedContext: scenario === 'committed-reopened'
          ? { ...preparedContext, terminalReviewProof: { version: 2 }, terminalContentHash: 'old-canonical-body' } : preparedContext, bridge: null, chapter: null }]),
        findFirst: vi.fn(async () => ({ chapterId: 'chapter' })) } } as unknown as Prisma.TransactionClient
      const chapter = { id: 'chapter', revision: 4, orderIndex: 2, content: f.current }, binding = { taskId: 'task', preparedContext }
      const before = runtimeJson({ validation, preparedContext }).hash
      try {
        const authenticated = await readTerminalDraftBinding(db, { ...ctx, compilationId: 'compilation' }, binding, chapter, validation, f.context)
        const review = currentTerminalReview(validation, f.current, f.context, authenticated)!
        expect(review?.deliveryEligibility.eligible, JSON.stringify({ keys: Object.keys(authenticated), reservationReads: vi.mocked(db.agentArtifact.findMany).mock.calls.length,
          receiptReads: vi.mocked(lifecycle.readLegacyContinuityAssessment).mock.calls.length })).toBe(scenario === 'preserve')
        expect(review?.supported).toBe(false)
        expect(review?.proofChecks?.[0].currentState).toBe(scenario === 'changed' ? 'changed' : 'uncertain')
        expect(runtimeJson({ validation, preparedContext }).hash).toBe(before)
        if (scenario !== 'preserve') return
        expect(review.deliveryEligibility).toMatchObject({ basis: 'preserved_canonical_with_pending_scope', preservation: {
          inherited: [{ path: 'exitState.openLoops.0', proofHash: carried[0].proofHash }], pendingCoverageIds: [obligation.id] } })
        const forged = currentTerminalReview(validation, f.current, f.context, { ...authenticated, scopeAuthority: { ...authenticated.scopeAuthority } })
        expect(forged?.deliveryEligibility.eligible).toBe(false)
        const removedDecision = { ...validation }; delete removedDecision.retainedReviewDecision
        expect(currentTerminalReview(removedDecision, f.current, f.context, authenticated)).toBeNull()
        const bridge = { committedAt: new Date(2), targetRevision: 4 }, stateHash = terminalReviewStateHash(bridge, [])
        const proofs = buildTerminalFactProofs({ compilationId: 'compilation', chapter, validation, stateHash, evidence: f.context, review })
        const preserved = proofs.find(proof => proof.claim === f.oldClaim)!
        expect(preserved.anchors).toEqual(carried[0].anchors)
        expect(preserved.nodes.slice(1)).toEqual(carried[0].nodes)
        expect(proofs.some(proof => terminalFactId(proof.field, proof.claim) === obligation.id)).toBe(false)
        expect(preserved.nodes[0]).toMatchObject({ preservation: { version: 1, basis: 'preserved_canonical', sourceProofHash: carried[0].proofHash,
          sourceNodesHash: runtimeJson(carried[0].nodes).hash, auditHash: runtimeJson(derived.audit).hash,
          policyHash: review.deliveryEligibility.preservation!.policyHash } })
        expect(readAuthenticatedContinuityAssessment(derived.audit, f.current, f.context, true)?.supported).toBe(false)
        const committed = { id: 'compilation', runId: 'run', chapterId: chapter.id, bridge, sceneTasks: [], validation,
          preparedContext: { ...preparedContext, terminalFactProofs: proofs, terminalCandidateHash: runtimeJson(f.frozen.candidate).hash,
            terminalContentHash: f.context.current.contentHash, terminalReviewProof: { version: 2, terminalStateHash: stateHash,
              scopePreservation: { version: 1, auditHash: runtimeJson(derived.audit).hash, policyHash: review.deliveryEligibility.preservation!.policyHash,
                pendingCoverageIds: [obligation.id] } } } }
        const compilationRead = vi.fn(async ({ where }: { where: { id?: string; chapterId?: string } }) =>
          where.id === f.rootCompilation.id || where.chapterId === f.rootChapter.id ? f.rootCompilation : committed)
        const chainDb = { ...db, storyCompilation: { ...db.storyCompilation, findFirst: compilationRead, findMany: vi.fn(async () => [{ ...committed, chapter }]) }, chapter: {
          findFirst: vi.fn(async ({ where }: { where: { id?: string; orderIndex?: unknown } }) => where.id === chapter.id ? chapter : f.rootChapter) } } as unknown as Prisma.TransactionClient
        expect(await readTerminalInheritance(chainDb, ctx, chapter)).toEqual(proofs)
        const modified = structuredClone(preserved), node = modified.nodes[0].preservation!
        node.sourceProofHash = '0'.repeat(64)
        modified.proofHash = runtimeJson({ field: modified.field, claim: modified.claim, anchors: modified.anchors, nodes: modified.nodes }).hash
        committed.preparedContext.terminalFactProofs = proofs.map(proof => proof.claim === f.oldClaim ? modified : proof)
        expect((await readTerminalInheritance(chainDb, ctx, chapter)).some(proof => proof.claim === f.oldClaim)).toBe(false)
        committed.preparedContext.terminalFactProofs = proofs
        type Entry = { chapter: typeof chapter; compilation: Record<string, unknown>; proofs: typeof proofs;
          input?: LegacyAssessmentInput; first?: ReturnType<typeof inspectContinuityV4>; callId?: string }
        const entries: Entry[] = [{ chapter: f.rootChapter, compilation: f.rootCompilation, proofs: carried },
          { chapter, compilation: committed, proofs, input: f.input, first, callId: ctx.callId }]
        const byChapter = (id: string) => entries.find(entry => entry.chapter.id === id)!
        const sourceFor = (entry: Entry, inherited: typeof proofs, orderIndex: number) => ({ id: entry.chapter.id, revision: entry.chapter.revision,
          content: entry.chapter.content, scope: 'current_and_previous_3_bounded' as const, targetOrderIndex: orderIndex,
          bridgeSource: entry.chapter, terminalInheritance: inherited, preceding: [{ ...entry.chapter, title: 'Synthetic canonical source',
            contentHash: createHash('sha256').update(entry.chapter.content).digest('hex'), start: 0, end: entry.chapter.content.length,
            joinedStart: 0, joinedEnd: entry.chapter.content.length }] })
        const replayDb = { ...chainDb, storyCompilation: { ...chainDb.storyCompilation,
          findFirst: vi.fn(async ({ where }: { where: { id?: string; chapterId?: string } }) => entries.find(entry => where.id
            ? entry.compilation.id === where.id : entry.chapter.id === where.chapterId)?.compilation ?? null),
          findMany: vi.fn(async ({ where }: { where: { chapterId: string } }) => entries.filter(entry => entry.chapter.id === where.chapterId)
            .map(entry => ({ ...entry.compilation, chapter: entry.chapter }))) },
        chapter: { findFirst: vi.fn(async ({ where }: { where: { id?: string; orderIndex?: { lt: number } } }) => where.id
          ? byChapter(where.id)?.chapter ?? null : entries.filter(entry => entry.chapter.orderIndex < where.orderIndex!.lt)
            .sort((a, b) => b.chapter.orderIndex - a.chapter.orderIndex)[0]?.chapter ?? null) },
        agentArtifact: { ...chainDb.agentArtifact, findMany: vi.fn(async ({ where }: { where: { metadata: { equals: string } } }) =>
          entries.filter(entry => entry.input && lifecycle.legacyContinuityAssessmentKey({ ...ctx, callId: entry.callId! }, entry.input) === where.metadata.equals)
            .map(entry => ({ runId: 'run', metadata: { input: entry.input, callId: entry.callId } }))) } } as unknown as Prisma.TransactionClient
        vi.mocked(lifecycle.readLegacyContinuityAssessment).mockImplementation(async (_db, _ctx, input) => ({
          inspected: entries.find(entry => entry.input?.targetId === input.targetId)!.first!, billingKnown: true, providerComplete: true, recoveryReady: true,
        } as Awaited<ReturnType<typeof lifecycle.readLegacyContinuityAssessment>>))
        vi.mocked(sources.readCompilerContinuitySource).mockImplementation(async (tx, owner, target, sourceId, _protocol, readScope) => {
          const previous = byChapter(sourceId!)
          return sourceFor(previous, await readTerminalInheritance(tx, owner, previous.chapter, readScope), target.orderIndex)
        })
        for (let index = 2; index <= 3; index++) {
          const previous = entries.at(-1)!, next = { ...chapter, id: `preserved-${index}`, orderIndex: index + 1 }, compilationId = `preserved-comp-${index}`
          const source = sourceFor(previous, previous.proofs, next.orderIndex), evidence = terminalEvidenceContext(next, source, 2, 1,
            { version: 2, taskId: 'task', chapterId: next.id, obligations: [] }, 6, 2)
          const bodies = { current: next.content, previous: previous.chapter.content, terminalEvidence: evidence }
          const sourceScope = { currentOrderIndex: next.orderIndex, previous: [{ orderIndex: previous.chapter.orderIndex, startOffset: 0, endOffset: previous.chapter.content.length }] }
          const { hash: _oldPlan, ...oldPlan } = f.frozen.manifest.typedLineage!.phasePlan
          const plan = { ...oldPlan, chapterId: next.id, compilationId,
            semanticSubjectHash: continuitySubjectIdentity({ chapterId: next.id, revision: next.revision, targetType: 'story_compilation', targetId: compilationId,
              bodies, sourceScope, terminalCandidate: f.frozen.candidate })! }
          const manifest = buildContinuityReviewManifest({ subject: { ...f.frozen.manifest.subject, chapterId: next.id, targetId: compilationId }, bodies,
            candidate: f.frozen.candidate, sourceScope, sourceHash: runtimeJson({ previous: bodies.previous }).hash,
            sourceVersions: { current: evidence.current, previous: evidence.previous }, verifiedCoverage: evidence.factCoverage, draftProposals: null,
            typedLineage: { version: 1, phasePlan: { ...plan, hash: runtimeJson(plan).hash }, priorFindings: [], establishedIssues: [] } })
          const input: LegacyAssessmentInput = { ...f.input, chapterId: next.id, targetId: compilationId, bodies, sourceScope, continuityManifest: manifest }
          const catalog = terminalReviewAddressCatalog(f.frozen.candidate, evidence)
          const raw = JSON.stringify({ findings: [], semanticChecks: f.wire.semanticChecks, terminalVerdicts: [],
            terminalProofVerdicts: catalog.proofs.map(({ proofIndex, fact }) => ({ proofIndex, currentState: fact.claim === f.oldClaim ? 'uncertain' : 'unchanged',
              reasonCode: fact.claim === f.oldClaim ? 'insufficient_evidence' : 'inherited_unchanged', explanation: `The inherited claim “${fact.claim}” remains recorded.` })),
            terminalDispositions: [], issueDispositions: [] })
          const inspection = inspectContinuityV4(raw, { manifest, bodies, candidate: f.frozen.candidate, sourceScope }), callId = `known-${index}`
          const normalized = bindLegacyContinuityAssessment(normalizeContinuityV4Projection(inspection, runtimeJson(input).hash), { ...ctx, callId }, input)
          expect(normalized.complete).toBe(true)
          const nextValidation = { checkedChapterId: next.id, checkedRevision: 4, independentCheck: 'complete', terminalCandidate: f.frozen.candidate,
            coverage: { protocolVersion: 11, contentHash: evidence.current.contentHash, terminalHash: runtimeJson(f.frozen.candidate).hash },
            continuityCriticResponse: normalized.audit, effectiveReport: await coordinator.stageEffectiveContinuityReport({ agentArtifact: {
              findUnique: async () => null, create: async () => ({}) } } as unknown as Prisma.TransactionClient, ctx,
            { compilationId, audit: normalized.audit, previousValidation: {} }) }
          const entry: Entry = { chapter: next, compilation: { id: compilationId, chapterId: next.id, runId: 'run', validation: nextValidation,
            preparedContext: {}, bridge: { committedAt: new Date(20 + index), targetRevision: 4 }, sceneTasks: [] }, proofs: [], input, first: inspection, callId }
          entries.push(entry)
          const binding = await readTerminalDraftBinding(replayDb, { ...ctx, compilationId }, { taskId: 'task', preparedContext: {} }, next, nextValidation, evidence)
          const reviewed = currentTerminalReview(nextValidation, next.content, evidence, binding)!
          expect(reviewed.deliveryEligibility.eligible).toBe(true)
          const stateHash = terminalReviewStateHash(entry.compilation.bridge, [])
          entry.proofs = buildTerminalFactProofs({ compilationId, chapter: next, validation: nextValidation, evidence, review: reviewed, stateHash })
          entry.compilation.preparedContext = { terminalFactProofs: entry.proofs, terminalCandidateHash: reviewed.candidateHash,
            terminalContentHash: evidence.current.contentHash, terminalReviewProof: { version: 2, terminalStateHash: stateHash } }
        }
        const last = entries.at(-1)!
        vi.mocked(lifecycle.readLegacyContinuityAssessment).mockClear()
        expect((await readTerminalInheritance(replayDb, ctx, last.chapter)).find(proof => proof.claim === f.oldClaim)?.depth).toBe(4)
        expect(lifecycle.readLegacyContinuityAssessment).toHaveBeenCalledTimes(3)
        const scope: TerminalInheritanceReadScope = { identities: new Set(), authenticating: new Set([
          JSON.stringify([ctx.userId, ctx.novelId, last.compilation.id, last.chapter.id])]), authenticated: new Map() }
        expect(await readTerminalInheritance(replayDb, ctx, last.chapter, scope)).toEqual([])
        expect(scope.identities.size).toBeLessThanOrEqual(128)
        const lastPrepared = last.compilation.preparedContext as { terminalFactProofs: typeof proofs }
        const lastCarried = last.proofs.find(proof => proof.claim === f.oldClaim)!
        lastPrepared.terminalFactProofs = Array.from({ length: 200 }, (_, index) => {
          const bad = structuredClone(lastCarried); bad.nodes[0].bodyHash = index.toString(16).padStart(64, '0')
          bad.proofHash = runtimeJson({ field: bad.field, claim: bad.claim, anchors: bad.anchors, nodes: bad.nodes }).hash
          return bad
        })
        vi.mocked(lifecycle.readLegacyContinuityAssessment).mockClear()
        expect(await readTerminalInheritance(replayDb, ctx, last.chapter)).toEqual([])
        expect(lifecycle.readLegacyContinuityAssessment).toHaveBeenCalledTimes(3)
      } finally { mocks.forEach(mock => mock.mockRestore()) }
    })
  it('keeps explanatory quotations separate from strict structured evidence in future full requests', () => {
    const f = fixture(), before = structuredClone(f.input)
    const request = continuityReviewV4Request(f.frozen, 'Write the next synthetic chapter.', 'Frozen synthetic context.')
    expect(request.system).toContain('解释里的引号不自动成为正文锚点或事实认证')
    expect(request.system).toContain('显式 manuscriptEvidence/quote 与 priorFindingRef/quote 仍必须逐字符合各自冻结来源')
    expect(request.system).not.toContain('解释中带引号的文字必须来自')
    expect(f.input).toEqual(before)
  })
  it('normalizes a returned known whole report before spending its sparse repair slot', async () => {
    const f = fixture(), claim = vi.fn(async () => false), dispatch = vi.fn(async () => { throw Error('No second provider request is allowed') })
    const result = await runContinuityReassessment({ original: f.inspect(), bodies: f.input.bodies, system: f.input.system, content: f.input.content,
      reassessmentProtocol: 7, billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal,
      assertCurrent: async () => {}, claim, dispatch, normalizationInputHash: f.hash })
    expect(result.complete).toBe(true)
    expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })
  it('cannot use a newly interpretable first frame to discard an already-claimed second frame', async () => {
    const f = fixture(), first = f.inspect(), claim = vi.fn(async () => true), dispatch = vi.fn(async () => { throw Error('No new request is allowed') })
    const result = await runContinuityReassessment({ original: first, bodies: f.input.bodies, system: f.input.system, content: f.input.content,
      reassessmentProtocol: 7, billingKnown: true, providerComplete: true, slotUsed: true, signal: new AbortController().signal,
      assertCurrent: async () => {}, claim, dispatch, normalizationInputHash: f.hash })
    expect(result).toEqual(first)
    expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })
  it('preserves the strict parser10, every raw row, errors and uncertainty while binding exact source roles', () => {
    const f = fixture(), first = f.inspect(), rawAudit = structuredClone(first.audit), recordHash = runtimeJson(first.parsed!.record).hash
    const shape = continuityReviewV4ResponseSchema(f.frozen).safeParse(f.wire)
    expect(shape.success, JSON.stringify(shape.success ? [] : shape.error.issues)).toBe(true)
    expect(first.complete).toBe(false)
    const derived = normalizeContinuityV4Projection(first, f.hash), marker = derived.audit.continuityV4.projectionNormalization!
    expect(derived.complete, JSON.stringify(derived.parsed?.diagnostics)).toBe(true)
    expect(first.audit).toEqual(rawAudit)
    expect(f.inspect().complete).toBe(false)
    expect(derived.parsed!.record).toEqual(f.wire)
    expect(runtimeJson(derived.parsed!.record).hash).toBe(recordHash)
    expect(derived.findings).toHaveLength(1)
    expect(marker).toMatchObject({ version: 1, originalParserVersion: 10, originReportHash: runtimeJson(rawAudit).hash, frozenInputHash: f.hash,
      mappings: expect.arrayContaining([{ table: 'terminalVerdicts', index: 0, kind: 'current_evidence_span', referenceIndex: 0,
        originalSegmentId: 'c1', quoteHash: expect.any(String), range: { start: 290, end: 290 + f.quote.length, segmentIds: ['c0', 'c1'] } }]) })
    expect(marker.mappings.map(mapping => mapping.kind)).toEqual(expect.arrayContaining(['proof_claim_audit', 'proof_anchor_audit', 'proposal_claim_audit', 'current_explanation_span']))
    const review = readAuthenticatedContinuityAssessment(derived.audit, f.current, f.context, true)
    expect(review).toMatchObject({ supported: false, proofChecks: [{ currentState: 'uncertain' }], factCoverage: { complete: false } })
    expect(validateStoredContinuityV4Projection(derived.audit, f.current, f.context)?.complete).toBe(true)
  })
  it.each(['unknown-address', 'nonoverlap-address', 'wrong-source', 'missing-quote', 'ambiguous-quote', 'other-proof', 'missing-table', 'truncated'] as const)(
    'does not normalize %s by choosing a fragment or inventing a source', kind => {
      const f = fixture(kind === 'ambiguous-quote'), wire = structuredClone(f.wire)
      if (kind === 'unknown-address') wire.terminalVerdicts[0].manuscriptEvidence[0].segmentId = 'c99'
      if (kind === 'nonoverlap-address') wire.terminalVerdicts[0].manuscriptEvidence[0] = { segmentId: 'c0', quote: 'The clerk waits.' }
      if (kind === 'wrong-source') wire.terminalVerdicts[0].manuscriptEvidence[0].segmentId = 'p0'
      if (kind === 'missing-quote') wire.terminalVerdicts[0].manuscriptEvidence[0].quote = 'This span is not in the original body.'
      if (kind === 'other-proof') wire.terminalProofVerdicts[0].proofIndex = 1
      if (kind === 'missing-table') wire.terminalDispositions = []
      const first = f.inspect(wire, kind !== 'truncated')
      expect(normalizeContinuityV4Projection(first, f.hash).complete).toBe(false)
      expect(first.parsed?.record).toEqual(kind === 'truncated' ? undefined : wire)
    })
  it('keeps explanatory historical quotation non-evidentiary and rejects the same invented phrase as structured evidence', () => {
    const f = fixture(), phrase = 'a wholly fabricated literal phrase', wire = structuredClone(f.wire)
    wire.terminalProofVerdicts[0].explanation = `The earlier opinion uses “${phrase}”; its truth remains unverified.`
    const strict = f.inspect(wire), derived = normalizeContinuityV4Projection(strict, f.hash)
    expect(strict.complete).toBe(false)
    expect(derived.complete).toBe(true)
    expect(derived.audit.continuityV4.projectionNormalization?.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'terminalProofVerdicts', index: 0, kind: 'non_evidentiary_explanation' })]))
    expect(derived.parsed!.record).toEqual(wire)
    expect(readAuthenticatedContinuityAssessment(derived.audit, f.current, f.context, true)).toMatchObject({ supported: false,
      proofChecks: [{ currentState: 'uncertain' }] })
    wire.terminalVerdicts[0].manuscriptEvidence[0].quote = phrase
    expect(normalizeContinuityV4Projection(f.inspect(wire), f.hash).complete).toBe(false)
  })
  it('binds the same exact cross-chunk structured span for a prose finding without changing either reference', () => {
    const f = fixture(), wire = structuredClone(f.wire)
    wire.findings[0].manuscriptEvidence[0] = { segmentId: 'c1', quote: f.quote }
    const derived = normalizeContinuityV4Projection(f.inspect(wire), f.hash)
    expect(derived.complete).toBe(true)
    expect(derived.parsed!.record).toEqual(wire)
    expect(derived.findings[0].sourceEvidence).toEqual([{ source: 'current', quote: f.quote }, { source: 'current', quote: 'intact.' }])
    expect(derived.audit.continuityV4.projectionNormalization?.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'findings', index: 0, referenceIndex: 0, kind: 'current_evidence_span' })]))
  })
  it.each(['missing-marker', 'origin', 'raw', 'input', 'mapping', 'rehash-mapping', 'rehash-origin', 'derivation', 'body'] as const)('rejects %s normalization lineage drift', kind => {
    const f = fixture(), derived = normalizeContinuityV4Projection(f.inspect(), f.hash), audit = structuredClone(derived.audit)
    const marker = audit.continuityV4.projectionNormalization!
    if (kind === 'missing-marker') delete audit.continuityV4.projectionNormalization
    if (kind === 'origin' || kind === 'rehash-origin') marker.originReportHash = '0'.repeat(64)
    if (kind === 'raw') marker.rawHash = '0'.repeat(64)
    if (kind === 'input') marker.frozenInputHash = 'invalid'
    if (kind === 'mapping' || kind === 'rehash-mapping') marker.mappings[0].range!.start++
    if (kind.startsWith('rehash-')) { const { derivationHash: _old, ...value } = marker; marker.derivationHash = runtimeJson(value).hash }
    if (kind === 'derivation') marker.derivationHash = '0'.repeat(64)
    expect(validateStoredContinuityV4Projection(audit, kind === 'body' ? `${f.current} changed` : f.current, f.context)).toBeNull()
  })
  it('rebinds the same physical report to its real reservation without modifying its raw or original parser', () => {
    const f = fixture(), first = f.inspect(), ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
    const strict = bindLegacyContinuityAssessment(first, ctx, f.input)
    const derived = bindLegacyContinuityAssessment(normalizeContinuityV4Projection(first, f.hash), ctx, f.input)
    expect(derived.complete).toBe(true)
    expect(derived.audit.continuityV4.projectionNormalization?.originReportHash).toBe(runtimeJson(strict.audit).hash)
    expect(derived.audit.rawResponse).toEqual(strict.audit.rawResponse)
    expect(validateStoredContinuityV4Projection(derived.audit, f.current, f.context)?.complete).toBe(true)
    const forged = structuredClone(derived.audit)
    forged.assessmentRequest!.inputHash = '0'.repeat(64)
    expect(validateStoredContinuityV4Projection(forged, f.current, f.context)).toBeNull()
  })
})

function repairedBackgroundFixture() {
  const f = fixture(false, false, false), current = f.current + 'z'.repeat(400)
  const candidate = terminalCandidateSchema.parse({ exitState: { ...f.frozen.candidate.exitState, location: 'The clerk waits.' } })
  const obligation = { id: terminalFactId('knowledge', 'The earlier address is remembered.'), field: 'knowledge' as const, claim: 'The earlier address is remembered.' }
  const priorCandidate = terminalCandidateSchema.parse({ exitState: { knowledge: [obligation.claim] } })
  const priorBody = obligation.claim, priorChapter = { ...f.rootChapter, id: 'historical-knowledge', content: priorBody }
  const priorContext = terminalEvidenceContext(priorChapter, null, 2)
  const priorAudit = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
    ({ kind, result: 'clear', reason: 'The synthetic canonical body establishes the exact old knowledge.', findingIndexes: [] })),
    terminalVerdicts: [{ path: 'exitState.knowledge.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: priorBody }] }] }),
    { current: priorBody, previous: null, terminalEvidence: priorContext }, true, 8, priorCandidate)
  const priorValidation = { checkedChapterId: priorChapter.id, checkedRevision: priorChapter.revision, independentCheck: 'complete',
    coverage: { protocolVersion: 11, contentHash: priorContext.current.contentHash, terminalHash: runtimeJson(priorCandidate).hash },
    terminalCandidate: priorCandidate, continuityCriticResponse: priorAudit.audit }
  const priorReview = currentTerminalReview(priorValidation, priorBody, priorContext)!
  const availableKnowledge = buildTerminalFactProofs({ compilationId: 'historical-knowledge-compilation', chapter: priorChapter, validation: priorValidation,
    stateHash: 'a'.repeat(64), evidence: priorContext, review: priorReview })[0]
  const carried = [...f.context.previous!.carried!, { ...availableKnowledge, segmentId: 't1' }]
  const context: TerminalEvidenceContext = { ...f.context, previous: { ...f.context.previous!, carried }, current: { ...f.context.current, contentHash: runtimeJson({ content: current }).hash },
    factCoverage: { ...f.context.factCoverage!, obligations: [obligation] },
    proposalChanges: { ...f.context.proposalChanges!, bodyHash: runtimeJson({ content: current }).hash } }
  delete context.proposalChanges
  const bodies = { ...f.frozen.bodies, current, terminalEvidence: context }
  const manifest = buildContinuityReviewManifest({ ...f.frozen.manifest, bodies, candidate, verifiedCoverage: context.factCoverage, draftProposals: null })
  const frozen = { ...f.frozen, bodies, candidate, manifest }, catalog = terminalReviewAddressCatalog(candidate, context)
  const location = catalog.claims.find(row => row.field === 'location')!
  const record: Record<string, unknown> = { ...structuredClone(f.wire),
    terminalVerdicts: [{ ...f.wire.terminalVerdicts[0], claimIndex: catalog.claims.find(row => row.field === 'objects')!.claimIndex }, { claimIndex: location.claimIndex, verdict: 'supported', reasonCode: 'consistent',
      explanation: 'The current clause supplies this location.', manuscriptEvidence: [{ segmentId: 'c1', quote: 'The clerk waits.' }] }],
    terminalDispositions: [{ obligationIndex: 0, outcome: 'replaced', candidateIndex: location.claimIndex, reasonCode: 'consistent',
      explanation: 'The old address was assigned to the current location.', manuscriptEvidence: [{ segmentId: 'c2', quote: 'The clerk waits.' }] }] }
  record.terminalProofVerdicts = f.wire.terminalProofVerdicts.map(row => ({ ...row, currentState: 'unchanged', reasonCode: 'inherited_unchanged' }))
  delete record.proposalDispositions
  const firstRecord = structuredClone(record)
  firstRecord.terminalDispositions = [{ obligationIndex: 0, outcome: 'ended', reasonCode: 'completed_obligation',
    explanation: 'A malformed original reference.', manuscriptEvidence: [{ segmentId: 'c999' }] }]
  const first = inspectContinuityV4(JSON.stringify(firstRecord), frozen), plan = buildContinuityInvalidRowRepair(first)!
  expect(plan, JSON.stringify({ classification: first.audit.classification, diagnostics: first.parsed?.diagnostics })).not.toBeNull()
  const second = JSON.stringify({ corrections: plan.mask.map(item => ({ ...item, value: (record[item.table] as unknown[])[item.index] })) })
  const failed = failedContinuityV4Repair(first, second, true), input = { ...f.input, bodies, terminalCandidate: candidate, continuityManifest: manifest }
  return { ...f, current, context, frozen, candidate, obligation, record, firstRecord, first, plan, second, failed, input, hash: runtimeJson(input).hash }
}

describe('explicit version2 physical sparse-repair interpretation', () => {
  it('keeps both physical replies and rejects the wrong-field replacement without inventing a model verdict', () => {
    const f = repairedBackgroundFixture(), before = runtimeJson(f.failed.audit).hash
    expect(() => applyContinuityV4Repair(f.first, f.second, true)).toThrow('remain invalid')
    const derived = normalizeContinuityV4Projection(f.failed, f.hash)
    expect(derived.complete, JSON.stringify(derived.parsed?.diagnostics)).toBe(true)
    expect(derived.audit.continuityV4.first).toEqual(f.failed.audit.continuityV4.first)
    expect(derived.audit.continuityV4.failedRepair).toEqual(f.failed.audit.continuityV4.failedRepair)
    expect(derived.parsed!.record).toEqual(f.record)
    expect(derived.findings).toHaveLength(1)
    expect(derived.findings[0].severity).toBe('error')
    expect(derived.terminalReview).toMatchObject({ supported: false, factCoverage: { complete: false, dispositions: [],
      serverRejectedReplacements: [{ id: f.obligation.id, obligationIndex: 0, code: 'replacement_target_invalid' }] } })
    const marker = derived.audit.continuityV4.projectionNormalization!
    expect(marker).toMatchObject({ version: 2, frozenInputHash: f.hash, repairPlanHash: runtimeJson(f.plan).hash,
      repairResponseHash: createHash('sha256').update(f.second).digest('hex'), serverRejectedReplacements: [{ originalRowHash: runtimeJson((f.record.terminalDispositions as unknown[])[0]).hash }] })
    expect(marker.mappings).toContainEqual(expect.objectContaining({ kind: 'current_evidence_relocated', originalSegmentId: 'c2', range: expect.objectContaining({ segmentIds: ['c1'] }) }))
    expect(validateStoredContinuityV4Projection(derived.audit, f.current, f.context)?.audit).toEqual(derived.audit)
    expect(readAuthenticatedContinuityAssessment(derived.audit, f.current, f.context, true)?.supported).toBe(false)
    expect(runtimeJson(f.failed.audit).hash).toBe(before)
  })
  it.each(['first', 'second', 'mask', 'body', 'candidate', 'input', 'server-row', 'diagnostic'] as const)('rejects two-response %s tampering', field => {
    const f = repairedBackgroundFixture(), derived = normalizeContinuityV4Projection(f.failed, f.hash), audit = structuredClone(derived.audit)
    expect(derived.complete).toBe(true)
    const marker = audit.continuityV4
    if (field === 'first') marker.first.content = JSON.stringify('{}')
    if (field === 'second') marker.failedRepair!.response.content = JSON.stringify('{}')
    if (field === 'mask') marker.projectionNormalization!.repairPlanHash = '0'.repeat(64)
    if (field === 'body') marker.frozen.bodies.current += 'different'
    if (field === 'candidate') marker.frozen.candidate.exitState.location = 'another location'
    if (field === 'input') marker.projectionNormalization!.frozenInputHash = '0'.repeat(64)
    if (field === 'server-row') marker.projectionNormalization!.serverRejectedReplacements![0].id = '0'.repeat(64)
    if (field === 'diagnostic') marker.projectionNormalization!.originalDiagnostics = []
    expect(validateStoredContinuityV4Projection(audit, f.current, f.context)).toBeNull()
  })
  it.each(['missing', 'ambiguous', 'previous', 'unknown-address', 'changed-address', 'extra-correction', 'current-unknown'] as const)('does not rescue %s evidence or alter an independent judgment', kind => {
    const f = repairedBackgroundFixture(), second = JSON.parse(f.second), target = second.corrections.find((row: { table: string }) => row.table === 'terminalDispositions')
    if (kind === 'missing') target.value.manuscriptEvidence[0].quote = 'Never present in this body.'
    if (kind === 'ambiguous') target.value.manuscriptEvidence[0] = { segmentId: 'c0', quote: 'zz' }
    if (kind === 'previous') target.value.manuscriptEvidence[0].segmentId = 'p0'
    if (kind === 'unknown-address') target.value.manuscriptEvidence[0].segmentId = 'c999'
    if (kind === 'changed-address') target.value.obligationIndex = 1
    if (kind === 'extra-correction') second.corrections.push({ ...target, index: 99 })
    if (kind === 'current-unknown') {
      const row = second.corrections.find((item: { table: string }) => item.table === 'terminalVerdicts')
      row.value.verdict = 'unknown'
    }
    const result = normalizeContinuityV4Projection(failedContinuityV4Repair(f.first, JSON.stringify(second), true), f.hash)
    if (kind === 'current-unknown') { expect(result.complete).toBe(true); expect(result.terminalReview?.verdicts.some(row => row.verdict === 'unknown')).toBe(true); expect(result.terminalReview?.supported).toBe(false) }
    else expect(result.complete).toBe(false)
  })
})

  it.each(['background', 'single-background', 'repaired-valid-background', 'hard-obligation', 'other-request', 'current-unknown', 'selected-proof-unknown', 'source-changed', 'origin-missing', 'saved-policy-tamper'] as const)(
    'authenticates explicit version2 historical scope only: %s', async scenario => {
      const f = scenario === 'single-background' ? scopeOnlyBackgroundFixture('single') : scenario === 'repaired-valid-background' ? scopeOnlyBackgroundFixture('repaired') : repairedBackgroundFixture()
      const ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
      if (scenario === 'current-unknown' || scenario === 'selected-proof-unknown') {
        const response = JSON.parse(f.second)
        if (scenario === 'current-unknown') response.corrections.find((row: { table: string }) => row.table === 'terminalVerdicts').value.verdict = 'unknown'
        else response.corrections.find((row: { table: string }) => row.table === 'terminalProofVerdicts').value.currentState = 'uncertain'
        f.failed = failedContinuityV4Repair(f.first, JSON.stringify(response), true)
      }
      const derived = bindLegacyContinuityAssessment(normalizeContinuityV4ProjectionV2(f.failed, f.hash), ctx, f.input)
      expect(derived.complete).toBe(true)
      const validation: Record<string, unknown> = { independentCheck: 'complete', checkedChapterId: 'chapter', checkedRevision: 4,
        coverage: { protocolVersion: 11, contentHash: f.context.current.contentHash, terminalHash: runtimeJson(f.candidate).hash },
        terminalCandidate: f.candidate, continuityCriticResponse: derived.audit }
      validation.effectiveReport = await coordinator.stageEffectiveContinuityReport({ agentArtifact: { findUnique: async () => null, create: async () => ({}) } } as unknown as Prisma.TransactionClient, ctx,
        { compilationId: 'compilation', audit: derived.audit, previousValidation: {} })
      const reportId = continuityDecisionBinding('compilation', 4, validation)
      validation.retainedReviewDecision = { version: 1, chapterId: 'chapter', revision: 4, contentHash: f.context.current.contentHash,
        continuityBinding: reportId, qualityReportId: null, qualityReportHash: null,
        findings: [{ source: 'continuity', reportId, findingId: '0', reason: 'This synthetic error is explicitly retained under the original author instruction.' }] }
      const spec = { id: 'task', scope: { terminalCoverageProtocol: 2 }, hardConstraints: scenario === 'hard-obligation' ? [{ text: 'Resolve the earlier address in this chapter.' }] : [], postconditions: [] }
      const preparedContext: Record<string, unknown> = { terminalFactCoverage: { version: 1, taskId: 'task', chapterId: 'chapter', facts: [],
        lastReview: { bodyHash: f.context.current.contentHash, candidateHash: runtimeJson(f.candidate).hash, input: f.context.factCoverage } } }
      if (scenario === 'saved-policy-tamper') preparedContext.terminalReviewProof = { version: 2, scopePreservation: { version: 2, policyHash: '0'.repeat(64),
        auditHash: runtimeJson(derived.audit).hash, pendingCoverageIds: [f.obligation.id] } }
      const mocks = [
        vi.spyOn(originalRequests, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', sourceRunId: 'run', parentRunId: null,
          prompt: scenario === 'other-request' ? 'Resolve every historical issue.' : '写下一章', spec } as unknown as Awaited<ReturnType<typeof originalRequests.readOriginalTaskRequest>>),
        vi.spyOn(originalRequests, 'originalTaskRunIds').mockResolvedValue(['run']),
        vi.spyOn(coordinator, 'authenticateEffectiveContinuityReport').mockResolvedValue(true),
        vi.spyOn(coordinator, 'readNormalizedContinuityCoverageOrigins').mockResolvedValue(scenario === 'origin-missing' ? null : { origins: [{ factId: f.obligation.id, revision: 3 }] } as Awaited<ReturnType<typeof coordinator.readNormalizedContinuityCoverageOrigins>>),
        vi.spyOn(lifecycle, 'readLegacyContinuityAssessment').mockResolvedValue({ inspected: f.failed, billingKnown: true, providerComplete: true, recoveryReady: true } as Awaited<ReturnType<typeof lifecycle.readLegacyContinuityAssessment>>),
        vi.spyOn(sources, 'readCompilerContinuitySource').mockResolvedValue({ id: f.context.previous!.id, revision: f.context.previous!.revision,
          content: f.frozen.bodies.previous!, scope: 'current_and_previous_3_bounded', targetOrderIndex: 2, bridgeSource: null, terminalInheritance: f.context.previous!.carried,
          preceding: [{ ...f.context.previous!, revision: scenario === 'source-changed' ? 99 : f.context.previous!.revision, title: 'Synthetic canonical predecessor' }]
        } as Awaited<ReturnType<typeof sources.readCompilerContinuitySource>>),
      ]
      const db = { agentArtifact: { findMany: vi.fn(async () => [{ runId: 'run', metadata: { input: f.input, callId: 'original' } }]) } } as unknown as Prisma.TransactionClient
      try {
        const chapter = { id: 'chapter', revision: 4, orderIndex: 2, content: f.current }, before = runtimeJson({ validation, preparedContext }).hash
        const binding = await readTerminalDraftBinding(db, { ...ctx, compilationId: 'compilation' }, { taskId: 'task', preparedContext }, chapter, validation, f.context)
        const review = currentTerminalReview(validation, f.current, f.context, binding)!
        expect(review?.deliveryEligibility.eligible).toBe(['background', 'single-background', 'repaired-valid-background'].includes(scenario))
        expect(review?.supported).toBe(false)
        if (['background', 'single-background', 'repaired-valid-background'].includes(scenario)) {
          expect(review.deliveryEligibility.preservation).toMatchObject({ version: 2, pendingCoverageIds: [f.obligation.id] })
          expect(review.factCoverage?.serverRejectedReplacements ?? []).toHaveLength(scenario === 'background' ? 1 : 0)
          expect(f.context.previous!.carried!.some(fact => terminalFactId(fact.field, fact.claim) === f.obligation.id)).toBe(true)
          expect(terminalReviewAddressCatalog(f.candidate, f.context).proofs.some(row => terminalFactId(row.fact.field, row.fact.claim) === f.obligation.id)).toBe(false)
          const next = advanceTerminalCoverage(spec, preparedContext, chapter, review, f.context.factCoverage)!
          expect(next.facts).toContainEqual(f.obligation)
          expect(review.factCoverage?.dispositions.some(row => row.id === f.obligation.id)).toBe(scenario !== 'background')
          expect(buildTerminalFactProofs({ compilationId: 'compilation', chapter, validation, stateHash: 'a'.repeat(64), evidence: f.context, review })
            .some(proof => terminalFactId(proof.field, proof.claim) === f.obligation.id)).toBe(false)
        }
        expect(runtimeJson({ validation, preparedContext }).hash).toBe(before)
      } finally { mocks.forEach(mock => mock.mockRestore()) }
    })

it.each(['known', 'unknown-fee', 'missing-claim', 'changed-claim', 'changed-second', 'truncated-second'] as const)(
  'reconstructs the actual legacy two-response reader before free derivation: %s', async scenario => {
    const f = repairedBackgroundFixture(), ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
    const phase = vi.spyOn(coordinator, 'readContinuityPhaseClaim').mockResolvedValue(true)
    const response = (raw: string) => ({ content: JSON.stringify(raw), finishReason: 'stop', transportComplete: true, toolCalls: [] })
    const frames = [{ stage: 'first', input: f.input, usageIds: ['first'], audit: f.first.audit, response: response(JSON.stringify(f.firstRecord)) },
      { stage: 'reassessment', input: f.input, usageIds: ['second'], audit: inspectContinuityV4(f.second, f.frozen).audit, response: response(f.second) }]
    if (scenario === 'changed-second') frames[1].audit.contentHash = '0'.repeat(64)
    if (scenario === 'truncated-second') frames[1].response.transportComplete = false
    const claim = { input: f.input, original: f.first.audit,
      request: lifecycle.continuityReassessmentRequest(f.input.system, f.input.content, f.first, f.input.bodies, false, 7) }
    if (scenario === 'changed-claim') claim.request = { ...claim.request, content: 'Different request' }
    const usage = ['first', 'second'].map((id, index) => ({ id, action: index ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic',
      usageSource: scenario === 'unknown-fee' && index === 1 ? 'unknown' : 'reported', billingStatus: scenario === 'unknown-fee' && index === 1 ? 'pending_usage' : 'settled',
      requestTokens: 10, responseTokens: 10, reservedCreditMilli: 0, creditChargeMilli: 1 }))
    const db = { agentArtifact: { findMany: vi.fn(async ({ where }: { where: { metadata: { path: string[] } } }) => {
      if (where.metadata.path[0] === 'assessmentKey') return frames.map(metadata => ({ metadata }))
      if (where.metadata.path[0] === 'assessmentRequestOwnerKey') return frames.map(frame => ({ metadata: { stage: frame.stage, usageIds: frame.usageIds } }))
      throw Error('Unexpected synthetic metadata path')
    }), findFirst: vi.fn(async () => scenario === 'missing-claim' ? null : { metadata: claim }) },
    aiUsageLog: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => usage.filter(row => where.id.in.includes(row.id))) } } as unknown as Prisma.TransactionClient
    const before = JSON.stringify({ frames, usage, claim })
    try {
      const actual = await lifecycle.readLegacyContinuityAssessment(db, ctx, f.input)
      expect(actual.inspected.complete).toBe(scenario === 'known')
      expect(actual.billingKnown).toBe(scenario !== 'unknown-fee')
      if (scenario === 'known') {
        if (!isContinuityV4Inspection(actual.inspected)) throw Error('Expected the authenticated frozen v4 result')
        expect(actual.inspected.audit.continuityV4.projectionNormalization?.version).toBe(2)
        expect(actual.inspected.terminalReview?.factCoverage?.serverRejectedReplacements).toHaveLength(1)
        expect(actual.usageIds).toEqual(['first', 'second'])
      }
      expect(JSON.stringify({ frames, usage, claim })).toBe(before)
    } finally { phase.mockRestore() }
  })

function scopeOnlyBackgroundFixture(mode: 'single' | 'repaired') {
  const f = repairedBackgroundFixture(), record = structuredClone(f.record)
  record.terminalVerdicts = (record.terminalVerdicts as Array<Record<string, unknown>>).map(row => ({ ...row, manuscriptEvidence: [{ segmentId: 'c1' }] }))
  record.terminalProofVerdicts = (record.terminalProofVerdicts as Array<Record<string, unknown>>).map(row => ({ ...row, explanation: 'The full body leaves this selected proof unchanged.' }))
  record.terminalDispositions = [{ obligationIndex: 0, outcome: 'unknown', reasonCode: 'historical_reference',
    explanation: 'The previous knowledge remains recorded as background; this chapter does not settle it.', manuscriptEvidence: [] }]
  if (mode === 'single') {
    const first = inspectContinuityV4(JSON.stringify(record), f.frozen)
    expect(first.complete).toBe(true)
    return { ...f, first, failed: first, record }
  }
  const second = JSON.stringify({ corrections: f.plan.mask.map(item => ({ ...item, value: (record[item.table] as unknown[])[item.index] })) })
  const repaired = applyContinuityV4Repair(f.first, second, true)
  expect(repaired.complete).toBe(true)
  for (const table of Object.keys(f.plan.fixed)) {
    const rows = f.first.parsed!.record[table] as unknown[]
    rows.forEach((row, index) => {
      if (!f.plan.mask.some(item => item.table === table && item.index === index))
        expect((repaired.parsed!.record[table] as unknown[])[index]).toEqual(row)
    })
  }
  return { ...f, second, failed: repaired, record: repaired.parsed!.record }
}

it.each(['single', 'repaired'] as const)('version2 preserves background after a legitimate %s report without inventing mechanical changes', mode => {
  const f = scopeOnlyBackgroundFixture(mode), before = runtimeJson(f.failed.audit).hash
  const derived = normalizeContinuityV4ProjectionV2(f.failed, f.hash), marker = derived.audit.continuityV4.projectionNormalization!
  expect(derived.complete).toBe(true)
  expect(marker).toMatchObject({ version: 2, mode: mode === 'single' ? 'single_report' : 'sparse_repair', mappings: [] })
  expect(derived.parsed!.record).toEqual(f.record)
  expect(derived.terminalReview?.supported).toBe(false)
  expect(derived.terminalReview?.factCoverage?.dispositions).toMatchObject([{ id: f.obligation.id, outcome: 'unknown' }])
  if (mode === 'single') {
    expect(marker).not.toHaveProperty('serverRejectedReplacements'); expect(marker).not.toHaveProperty('repairResponseHash'); expect(marker).not.toHaveProperty('repairPlanHash')
    expect(derived.audit.continuityV4).not.toHaveProperty('repair'); expect(derived.audit.continuityV4).not.toHaveProperty('failedRepair')
    expect(normalizeContinuityV4Projection(f.failed, f.hash)).toEqual(f.failed)
  } else {
    expect(derived.audit.continuityV4.repair).toEqual(f.failed.audit.continuityV4.repair)
    expect(marker.serverRejectedReplacements).toEqual([])
  }
  expect(validateStoredContinuityV4Projection(derived.audit, f.current, f.context)?.audit).toEqual(derived.audit)
  expect(runtimeJson(f.failed.audit).hash).toBe(before)
  for (const kind of ['phantom-second', 'input-hash', 'raw', 'source', 'candidate'] as const) {
    const forged = structuredClone(derived.audit)
    if (kind === 'phantom-second') Object.assign(forged.continuityV4, { failedRepair: { response: { content: JSON.stringify('{}'), complete: true, encoding: 'json-string', version: 1 } } })
    if (kind === 'input-hash') forged.continuityV4.projectionNormalization!.frozenInputHash = '0'.repeat(64)
    if (kind === 'raw') forged.continuityV4.first.content = JSON.stringify('{}')
    if (kind === 'source') forged.continuityV4.frozen.bodies.terminalEvidence!.previous!.revision++
    if (kind === 'candidate') forged.continuityV4.frozen.candidate.exitState.location = 'another place'
    expect(validateStoredContinuityV4Projection(forged, f.current, f.context)).toBeNull()
  }
})

it('normalizes a strict complete single report before any repair claim or provider request and keeps frozen v1 replay exact', async () => {
  const f = scopeOnlyBackgroundFixture('single'), claim = vi.fn(async () => true), dispatch = vi.fn(async () => ({ content: '{}', complete: true }))
  const derived = await runContinuityReassessment({ original: f.first, bodies: f.input.bodies, system: f.input.system, content: f.input.content,
    reassessmentProtocol: 7, billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal,
    assertCurrent: async () => {}, claim, dispatch, normalizationInputHash: f.hash })
  if (!isContinuityV4Inspection(derived)) throw Error('Expected the frozen native v4 interpretation')
  expect(derived.audit.continuityV4.projectionNormalization).toMatchObject({ version: 2, mode: 'single_report', mappings: [] })
  expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  const old = fixture(), strict = old.inspect(), v1 = normalizeContinuityV4Projection(strict, old.hash), hash = runtimeJson(v1.audit).hash
  expect(v1.audit.continuityV4.projectionNormalization?.version).toBe(1)
  expect(normalizeContinuityV4ProjectionV2(v1, old.hash)).toBe(v1)
  expect(runtimeJson(validateStoredContinuityV4Projection(v1.audit, old.current, old.context)!.audit).hash).toBe(hash)
})


it.each(['single', 'repaired', 'existing-second', 'unknown-billing', 'cancelled'] as const)(
  'the actual native producer derives only authenticated physical reports without another fee slot: %s', async mode => {
    const f = scopeOnlyBackgroundFixture(mode === 'repaired' ? 'repaired' : 'single')
    const admitted = await import('../../api/lib/agent/runtime-writing-service.js')
    const leases = await import('../../api/lib/agent/runtime-lease.js')
    const operations = await import('../../api/lib/agent/runtime-operations.js')
    const auxiliary = await import('../../api/lib/agent/runtime-auxiliary-call.js')
    const tools = await import('../../api/lib/agent/tools/story-compiler-tools.js')
    const { executePreparedContinuityWork } = await import('../../api/lib/agent/tools/durable-continuity.js')
    const controller = new AbortController(), context = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'native', signal: controller.signal } as ToolContext
    const lease = { userId: 'user', runId: 'run', taskRootId: 'task', ownerId: 'worker', claimId: 'claim', epoch: 1n }
    const work = { kind: 'check', version: 23, compiler: null, standaloneContextHash: 'a'.repeat(64),
      chapter: { id: f.context.current.id, revision: f.context.current.revision, orderIndex: f.context.current.orderIndex, title: 'Synthetic', content: f.current },
      terminalCandidate: f.candidate, sourceBodies: f.frozen.bodies, sourceScope: f.frozen.sourceScope, continuityManifest: f.frozen.manifest,
      reassessmentProtocol: 7, sourceId: null, coverage: { version: 1, protocolVersion: 11, contentHash: runtimeJson({ content: f.current }).hash, charCount: f.current.length, sourceHash: null },
      criticSystem: f.input.system, criticInput: f.input.content, repairSystem: '', repair: false, cached: null,
      route: { provider: 'fixture', model: 'fixture', baseUrl: 'https://provider.invalid/v1', maxOutputTokens: 16384 },
      price: { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'fixture', rates: { inputNano: 1, cacheNano: 1, outputNano: 1 } } }
    const operation = { id: 'native-operation', inputHash: runtimeJson({ work }).hash }, data = { args: {}, work }
    let committed: { result: unknown; resultHash: string } | null = null, secondObserved = false
    const tx = { agentOperation: { findUniqueOrThrow: vi.fn(async () => ({ status: committed ? 'succeeded' : 'prepared', effectReceipt: committed })),
      findUnique: vi.fn(async ({ where }: { where: { taskRootId_operationKey: { operationKey: string } } }) =>
        where.taskRootId_operationKey.operationKey.endsWith(':continuity_reassessment') && !secondObserved ? null : { id: 'critic-operation', status: 'succeeded' }) },
      agentProviderAttempt: { findUnique: vi.fn(async () => ({ status: 'succeeded', usageReceipt: { source: mode === 'unknown-billing' ? 'unknown' : 'reported',
        settlementStatus: 'settled', promptTokens: 12, completionTokens: 8 } })) },
      agentArtifact: { findFirst: vi.fn(async () => mode === 'existing-second' ? { metadata: { preserved: true } } : null), create: vi.fn(async () => ({})) } }
    const spies: Array<{ mockRestore: () => void }> = [vi.spyOn(admitted, 'readAdmittedReviewWork').mockResolvedValue({ operation, input: data } as never),
      vi.spyOn(leases, 'withRunLease').mockImplementation((async (_lease: unknown, run: (db: unknown) => unknown) => run(tx)) as never),
      vi.spyOn(operations, 'commitOperationEffect').mockImplementation((async (_lease: unknown, _id: string, _hash: string, run: (db: unknown) => Promise<unknown>) => {
        const result = await run(tx); return committed = { result, resultHash: runtimeJson(result).hash }
      }) as never), vi.spyOn(tools, 'buildStandaloneContinuityContext').mockResolvedValue({ contextHash: 'a'.repeat(64) } as never)]
    const provider = vi.spyOn(auxiliary, 'callDurableAuxiliary').mockImplementation(async input => {
      input.signal.throwIfAborted()
      if (input.step === 'continuity_reassessment') secondObserved = true
      return { content: input.step === 'continuity_critic' ? JSON.parse(f.first.audit.rawResponse.content) : f.second,
        finishReason: 'stop', toolCalls: [] } as never
    })
    const save = vi.spyOn(tools, 'saveStandaloneContinuityReport').mockResolvedValue({ output: 'Actual frozen report saved.', summary: 'Complete' })
    spies.push(provider, save)
    try {
      if (mode === 'cancelled') controller.abort()
      const before = runtimeJson({ operation, data }).hash
      if (['existing-second', 'unknown-billing', 'cancelled'].includes(mode)) {
        await expect(executePreparedContinuityWork(context, lease, operation.id)).rejects.toBeDefined()
        expect(save).not.toHaveBeenCalled(); expect(committed).toBeNull()
        expect(tx.agentArtifact.create).not.toHaveBeenCalled()
      } else {
        const receipt = await executePreparedContinuityWork(context, lease, operation.id)
        expect(save).toHaveBeenCalledOnce()
        const audit = save.mock.calls[0][7]!
        expect(audit).toMatchObject({ continuityV4: { projectionNormalization: { version: 2, mode: mode === 'single' ? 'single_report' : 'sparse_repair', mappings: [] } } })
        expect(validateStoredContinuityV4Projection(audit, f.current, f.context)?.audit).toEqual(audit)
        expect(audit.rawResponse.content).toBe(f.first.audit.rawResponse.content)
        expect(provider).toHaveBeenCalledTimes(mode === 'single' ? 1 : 2)
        expect(tx.agentArtifact.create).toHaveBeenCalledTimes(mode === 'single' ? 0 : 1)
        expect(await executePreparedContinuityWork(context, lease, operation.id)).toEqual(receipt)
        expect(save).toHaveBeenCalledOnce(); expect(provider).toHaveBeenCalledTimes(mode === 'single' ? 1 : 2)
      }
      expect(runtimeJson({ operation, data }).hash).toBe(before)
    } finally { spies.reverse().forEach(spy => spy.mockRestore()) }
  })


it.each(['legacy', 'legacy-application', 'issued-v2', 'wrong-marker', 'wrong-reservation', 'wrong-usage'] as const)(
  'the actual reader preserves an old complete legal repair hash unless its exact v2 application exists: %s', async scenario => {
    const f = scopeOnlyBackgroundFixture('repaired'), ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
    const strict = bindLegacyContinuityAssessment(f.failed, ctx, f.input), issued = bindLegacyContinuityAssessment(f.failed, ctx, f.input, 2)
    if (!isContinuityV4Inspection(issued)) throw Error('Expected the frozen typed report')
    const app = { reservationId: 'reservation', usageIds: ['first', 'second'], projectionNormalization: structuredClone(issued.audit.continuityV4.projectionNormalization!) }
    if (scenario === 'legacy-application') delete (app as Record<string, unknown>).projectionNormalization
    if (scenario === 'wrong-marker') app.projectionNormalization.derivationHash = '0'.repeat(64)
    if (scenario === 'wrong-reservation') app.reservationId = 'another'
    if (scenario === 'wrong-usage') app.usageIds = ['first']
    const response = (raw: string) => ({ content: JSON.stringify(raw), finishReason: 'stop', transportComplete: true, toolCalls: [] })
    const frames = [{ stage: 'first', input: f.input, usageIds: ['first'], audit: f.first.audit, response: response(JSON.parse(f.first.audit.rawResponse.content)) },
      { stage: 'reassessment', input: f.input, usageIds: ['second'], audit: inspectContinuityV4(f.second, f.frozen).audit, response: response(f.second) }]
    const claim = { input: f.input, original: f.first.audit, request: lifecycle.continuityReassessmentRequest(f.input.system, f.input.content, f.first, f.input.bodies, false, 7) }
    const usage = ['first', 'second'].map((id, index) => ({ id, action: index ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic',
      usageSource: 'reported', billingStatus: 'settled', requestTokens: 10, responseTokens: 10, reservedCreditMilli: 0, creditChargeMilli: 1 }))
    const db = { agentArtifact: { findMany: vi.fn(async ({ where }: { where: { metadata: { path: string[] } } }) => {
      if (where.metadata.path[0] === 'assessmentKey') return frames.map(metadata => ({ metadata }))
      if (where.metadata.path[0] === 'assessmentRequestOwnerKey') return frames.map(frame => ({ metadata: { stage: frame.stage, usageIds: frame.usageIds } }))
      if (where.metadata.path[0] === 'assessmentApplicationKey') return scenario === 'legacy' ? [] : [{ metadata: app }]
      if (where.metadata.path[0] === 'continuityAssessmentRequestKey') return [{ id: 'reservation', metadata: { callId: ctx.callId, input: f.input } }]
      throw Error('Unexpected synthetic metadata path')
    }), findFirst: vi.fn(async () => ({ metadata: claim })) }, aiUsageLog: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => usage.filter(row => where.id.in.includes(row.id))) } } as unknown as Prisma.TransactionClient
    const phase = vi.spyOn(coordinator, 'readContinuityPhaseClaim').mockResolvedValue(true), before = JSON.stringify({ frames, claim, usage, app })
    try {
      const read = await lifecycle.readLegacyContinuityAssessment(db, ctx, f.input)
      const rebound = bindLegacyContinuityAssessment(read.inspected, ctx, f.input)
      expect(read.inspected.complete).toBe(true); expect(read.billingKnown).toBe(true)
      expect(rebound.audit).toEqual(scenario === 'issued-v2' ? issued.audit : strict.audit)
      expect(runtimeJson(rebound.audit).hash).toBe(runtimeJson(scenario === 'issued-v2' ? issued.audit : strict.audit).hash)
      expect(JSON.stringify({ frames, claim, usage, app })).toBe(before)
    } finally { phase.mockRestore() }
  })


it.each(['retained', 'unretained', 'changed-previous'] as const)(
  'the real first-chapter binding retains historical unknown only with exact null-source evidence: %s', async scenario => {
    const f = repairedBackgroundFixture(), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The brass seal remains intact.'], location: 'The clerk waits.' } })
    const context: TerminalEvidenceContext = { ...f.context, current: { ...f.context.current, orderIndex: 1 }, previous: null }
    const bodies = { previous: null, current: f.current, terminalEvidence: context }, sourceScope = { currentOrderIndex: 1, previous: [] }
    const manifest = buildContinuityReviewManifest({ ...f.frozen.manifest, bodies, candidate, sourceScope, sourceHash: null,
      sourceVersions: { current: context.current, previous: null }, verifiedCoverage: context.factCoverage, draftProposals: null })
    const record = { findings: [{ findingId: 'f0', signal: 'object', severity: 'error', reasonCode: 'manuscript_conflict',
      explanation: 'The independent synthetic opinion compares these current observations.', suggestion: 'Review the retained opinion within the original scope.',
      manuscriptEvidence: [{ segmentId: 'c1', quote: 'seal remains intact.' }, { segmentId: 'c1', quote: 'The clerk waits.' }] }],
    semanticChecks: ['action_direction', 'state_progression'].map((kind, index) => ({ kind, result: index ? 'conflict' : 'clear',
      reasonCode: index ? 'manuscript_conflict' : 'consistent', explanation: 'The complete synthetic report keeps the original opinion.', findingIds: index ? ['f0'] : [] })),
    terminalVerdicts: terminalReviewAddressCatalog(candidate, context).claims.map(row => ({ claimIndex: row.claimIndex, verdict: 'supported',
      reasonCode: 'consistent', explanation: 'The current body supports this actual claim.', manuscriptEvidence: [{ segmentId: 'c1' }] })), terminalProofVerdicts: [],
    terminalDispositions: [{ obligationIndex: 0, outcome: 'unknown', reasonCode: 'historical_reference',
      explanation: 'The original knowledge remains historical background without a current resolution.', manuscriptEvidence: [] }], issueDispositions: [] }
    const first = inspectContinuityV4(JSON.stringify(record), { manifest, bodies, candidate, sourceScope })
    expect(first.complete, JSON.stringify(first.parsed?.diagnostics)).toBe(true)
    const input = { ...f.input, bodies, terminalCandidate: candidate, continuityManifest: manifest, sourceScope }, ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
    const derived = bindLegacyContinuityAssessment(normalizeContinuityV4ProjectionV2(first, runtimeJson(input).hash), ctx, input)
    const validation: Record<string, unknown> = { independentCheck: 'complete', checkedChapterId: 'chapter', checkedRevision: 4, errorCount: 1,
      coverage: { protocolVersion: 11, contentHash: context.current.contentHash, terminalHash: runtimeJson(candidate).hash }, terminalCandidate: candidate, continuityCriticResponse: derived.audit }
    validation.effectiveReport = await coordinator.stageEffectiveContinuityReport({ agentArtifact: { findUnique: async () => null, create: async () => ({}) } } as unknown as Prisma.TransactionClient,
      ctx, { compilationId: 'compilation', audit: derived.audit, previousValidation: {} })
    const reportId = continuityDecisionBinding('compilation', 4, validation)
    if (scenario !== 'unretained') validation.retainedReviewDecision = { version: 1, chapterId: 'chapter', revision: 4, contentHash: context.current.contentHash,
      continuityBinding: reportId, qualityReportId: null, qualityReportHash: null,
      findings: [{ source: 'continuity', reportId, findingId: '0', reason: 'Retain the actual independent opinion without claiming it was repaired.' }] }
    const spec = { id: 'task', scope: { terminalCoverageProtocol: 2 }, hardConstraints: [], postconditions: [] }, preparedContext = {
      terminalFactCoverage: { version: 1, taskId: 'task', chapterId: 'chapter', facts: [], lastReview: { bodyHash: context.current.contentHash,
        candidateHash: runtimeJson(candidate).hash, input: context.factCoverage } } }
    const mocks = [vi.spyOn(originalRequests, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', sourceRunId: 'run', parentRunId: null, prompt: '写下一章', spec } as never),
      vi.spyOn(originalRequests, 'originalTaskRunIds').mockResolvedValue(['run']), vi.spyOn(coordinator, 'authenticateEffectiveContinuityReport').mockResolvedValue(true),
      vi.spyOn(coordinator, 'readNormalizedContinuityCoverageOrigins').mockResolvedValue({ origins: [{ factId: f.obligation.id, revision: 3 }] } as never),
      vi.spyOn(lifecycle, 'readLegacyContinuityAssessment').mockResolvedValue({ inspected: first, billingKnown: true, providerComplete: true, recoveryReady: true } as never),
      vi.spyOn(sources, 'readCompilerContinuitySource').mockResolvedValue(null)]
    const db = { agentArtifact: { findMany: vi.fn(async () => [{ runId: 'run', metadata: { input, callId: 'original' } }]) } } as unknown as Prisma.TransactionClient
    try {
      const expectedContext = scenario === 'changed-previous' ? { ...context, previous: f.context.previous } : context
      const before = runtimeJson({ validation, preparedContext, input }).hash
      const chapter = { id: 'chapter', revision: 4, orderIndex: 1, content: f.current }
      const binding = await readTerminalDraftBinding(db, { ...ctx, compilationId: 'compilation' }, { taskId: 'task', preparedContext }, chapter, validation, expectedContext)
      const review = currentTerminalReview(validation, f.current, expectedContext, binding)
      expect(review?.deliveryEligibility.eligible ?? false).toBe(scenario === 'retained')
      if (scenario === 'retained') {
        expect(binding.scopeAuthority).toBeDefined()
        expect(review).toMatchObject({ supported: false, deliveryEligibility: { eligible: true,
          preservation: { version: 2, pendingCoverageIds: [f.obligation.id] } }, factCoverage: { dispositions: [{ outcome: 'unknown' }] } })
        expect(advanceTerminalCoverage(spec, preparedContext, chapter, review!, context.factCoverage)?.facts).toContainEqual(f.obligation)
        expect(buildTerminalFactProofs({ compilationId: 'compilation', chapter, validation, stateHash: 'a'.repeat(64), evidence: context, review: review! })
          .some(proof => terminalFactId(proof.field, proof.claim) === f.obligation.id)).toBe(false)
        expect(mocks[5]).not.toHaveBeenCalled()
      } else expect(binding.scopeAuthority).toBeUndefined()
      expect(runtimeJson({ validation, preparedContext, input }).hash).toBe(before)
    } finally { mocks.forEach(mock => mock.mockRestore()) }
  })
