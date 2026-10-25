import { describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import type { TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { continuitySubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { bindLegacyContinuityAssessment, runContinuityReassessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { buildContinuityReviewManifest, continuityReviewV4Request, continuityReviewV4ResponseSchema, inspectContinuityV4, normalizeContinuityV4Projection, validateStoredContinuityV4Projection } from '../../api/lib/agent/continuity-review-v4.js'
import { readAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
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
