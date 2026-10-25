import { describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { prepareCompilerTerminalProposals } from '../../api/lib/agent/terminal-proposal-context.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { legacyContinuityAssessmentKey, continuityReassessmentRequest, bindLegacyContinuityAssessment, readLegacyContinuityAssessment,
  type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { persistHumanityQualityReport, buildHumanityQualityContext, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { buildManualReviewRepairFacts, quoteManualReviewRepair, submitManualReviewRepair, readManualReviewRepair } from '../../api/lib/agent/manual-review-repair-service.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as credits from '../../api/lib/credits.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as ai from '../../api/lib/ai-service.js'
import { repairEventId, repairHash } from '../../api/lib/agent/manual-review-repair-store.js'

const prompt = '修改第一章，只输出标题和正文'

describe.runIf(available)('manual repair actual legacy report, draft provenance, commit and final delivery in PostgreSQL', () => {
  it('keeps both old raws, all seven opinions, consumed slot and fees; one authenticated complete repair maps two old questions and preserves the emotion draft', () => fixture(async f => {
    const oldSecret = env.authSessionSecret
    env.authSessionSecret = 'synthetic-manual-repair-flow-secret-at-least-32-characters'
    try {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
      const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async () => { throw Error('A paid main closing turn is not authorized') })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running', startRequest: { prompt },
        modelTier: 'speed', reasoningEffort: 'high' } })
      const content = 'The packet remains sealed. The parcel destination remains unresolved. The deposit receipt remains unresolved.'
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, wordCount: content.length, revision: 4 } })
      const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
      const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
      await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inventory', entryState: empty, goal: 'Record the questions', obstacle: 'Time',
        choice: 'Keep the questions open', cost: 'Time', turn: 'Recorded', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: chapter.revision })
      let saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      const oldQuestions = ['The parcel destination remains unresolved.', 'The deposit receipt remains unresolved.']
      const base = terminalCandidateSchema.parse({ exitState: { emotion: ['A reply remains pending.'], openLoops: oldQuestions } })
      const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'],
        openLoops: ['Where the parcel went remains a question.', 'The deposit receipt is still an open question.'] } })
      const scope = compilerEvidenceScope(chapter, null), coverage = (value: typeof candidate) => compilerContinuityCoverage({ chapter, bridge: saved.bridge,
        sceneTasks: saved.sceneTasks, source: null, terminalCandidate: value }, 11)
      const originContext = terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(f.spec, saved.preparedContext, chapter, base, 2), 6, 2)
      const originInput: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies: { previous: null, current: content, terminalEvidence: originContext },
        terminalCandidate: base, sourceScope: scope, parserVersion: 8, reassessmentProtocol: 5, bindingHash: runtimeJson(coverage(base)).hash,
        system: 'Synthetic frozen complete reviewer.', content: 'Synthetic original complete material.', targetType: 'story_compilation', targetId: compilation.id }
      const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Both complete semantic dimensions independently reviewed.', findingIndexes: [] }))
      const originWire = { findings: [], semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(base).map((fact, claimIndex) => ({ claimIndex,
        verdict: fact.field === 'emotion' ? 'unknown' : 'supported', sourceEvidence: fact.field === 'emotion' ? [] : [{ segmentId: 'c0' }] })), terminalProofVerdicts: [], terminalDispositions: [] }
      const price = { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 10000 }
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', multiplierBps: 10000,
        reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>, reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
      const protectedUsage = [], protectedArtifacts = []
      async function paid(action: string) {
        const row = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', providerName: runtime.provider,
          modelName: runtime.modelName, modelTier: 'speed', multiplierBps: 10000, action, requestTokens: 12, responseTokens: 8, usageSource: 'reported',
          billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: 23, billingSnapshot: price, billingEvidence: { responseObserved: true }, durationMs: 0 } })
        protectedUsage.push(row); return row.id
      }
      async function artifact(metadata: unknown) {
        const row = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Synthetic immutable original review',
          content: 'Synthetic complete raw transport audit.', metadata: runtimeJson(metadata).value } }); protectedArtifacts.push(row)
      }
      const originUsage = await paid('agent3ContinuityCritic'), originCall = 'synthetic-emotion-origin', originKey = legacyContinuityAssessmentKey({ runId: f.runId, callId: originCall }, originInput)
      const origin = inspectContinuityResponse(JSON.stringify(originWire), originInput.bodies, true, 8, base, scope, { responseContract: 3 })
      expect(origin.complete).toBe(true)
      await artifact({ version: 1, continuityAssessmentRequestKey: originKey, assessmentChapterId: chapter.id, callId: originCall, input: originInput })
      await artifact({ version: 1, assessmentRequestOwnerKey: originKey, stage: 'first', callId: originCall, usageIds: [originUsage] })
      await artifact({ version: 1, assessmentKey: originKey, assessmentResponseKey: originKey, stage: 'first', callId: originCall, usageIds: [originUsage], input: originInput,
        audit: origin.audit, response: { content: JSON.stringify(JSON.stringify(originWire)), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } })
      await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: [], independentCheck: 'complete', expectedChapterRevision: chapter.revision,
        terminalCandidate: base, coverage: coverage(base), continuityCriticResponse: bindLegacyContinuityAssessment(origin, { ...f, callId: originCall } as ToolContext, originInput).audit })
      saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      const nextContext = terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(f.spec, saved.preparedContext, chapter, candidate, 2), 6, 2)
      expect(nextContext.factCoverage?.obligations).toHaveLength(2)
      const proposals = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: saved.preparedContext, validation: saved.validation,
        chapter, source: null, candidate, nextContext })!
      expect(proposals.changes?.proposals).toHaveLength(1)
      nextContext.proposalChanges = proposals.changes
      const frozen: LegacyAssessmentInput = { ...originInput, bodies: { previous: null, current: content, terminalEvidence: nextContext }, terminalCandidate: candidate,
        bindingHash: runtimeJson(coverage(candidate)).hash, content: 'Synthetic failed complete current material.' }
      const oldFindings = Array.from({ length: 7 }, (_, index) => ({ signal: 'object', severity: 'warning', evidence: `The text says “invented quote ${index}”.`,
        suggestion: 'Inspect the complete source.', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: `invented quote ${index}` }] }))
      const common = { semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(candidate).map((_, claimIndex) => ({ claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })),
        terminalProofVerdicts: [], terminalDispositions: [0, 1].map(obligationIndex => ({ obligationIndex, outcome: 'unknown', reason: 'The old question mapping remains unverified.', sourceEvidence: [] })),
        proposalDispositions: [{ proposalIndex: 0, outcome: 'unknown', reason: 'The old emotional draft remains pending.', sourceEvidence: [] }] }
      const firstWire = { ...common, findings: oldFindings }, secondWire = { ...common, findings: [], decisions: oldFindings.map((_, index) => ({ index, action: 'retract',
        reason: 'The source says “another absent quotation”.', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: content }] })) }
      const first = inspectContinuityResponse(JSON.stringify(firstWire), frozen.bodies, true, 8, candidate, scope, { responseContract: 3 })
      const second = inspectContinuityResponse(JSON.stringify(secondWire), frozen.bodies, true, 8, candidate, scope, { responseContract: 3 })
      const callId = 'synthetic-original-failed-pair', key = legacyContinuityAssessmentKey({ runId: f.runId, callId }, frozen)
      const firstUsage = await paid('agent3ContinuityCritic'), secondUsage = await paid('agent3ContinuityCriticSecondPass')
      await artifact({ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, callId, input: frozen })
      await artifact({ version: 1, fullReassessmentKey: key, callId, input: frozen, original: first.audit, usageIds: [firstUsage],
        request: continuityReassessmentRequest(frozen.system, frozen.content, first, frozen.bodies, false, 5) })
      for (const [stage, usageId, wire, audit] of [['first', firstUsage, firstWire, first.audit], ['reassessment', secondUsage, secondWire, second.audit]] as const) {
        await artifact({ version: 1, assessmentRequestOwnerKey: key, stage, callId, usageIds: [usageId] })
        await artifact({ version: 1, assessmentKey: key, assessmentResponseKey: `${key}:${stage}`, stage, callId, usageIds: [usageId], input: frozen, audit,
          response: { content: JSON.stringify(JSON.stringify(wire)), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } })
      }
      const received = await prisma.$transaction(tx => readLegacyContinuityAssessment(tx, { ...f, callId } as ToolContext, frozen))
      expect(received).toMatchObject({ recoveryReady: true, inspected: { complete: false } })
      await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: [], independentCheck: 'unavailable', expectedChapterRevision: chapter.revision,
        terminalCandidate: candidate, coverage: coverage(candidate), continuityCriticResponse: bindLegacyContinuityAssessment(received.inspected, { ...f, callId } as ToolContext, frozen).audit })
      const qualityHash = qualityReviewContextHash(await buildHumanityQualityContext(f.userId, f.novelId, chapter.id, f.runId))
      await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced',
        criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {}, qualityContextHash: qualityHash })
      const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy', activeExecutionMs: 1000, stagnantBatches: 4,
        runStartedAt: Date.now(), resumeCount: 3, compactionCount: 1, maxTurns: 27, tokenBudget: 500, writeProgress: 1, writeBaseline: 0,
        readProgress: 7, readBaseline: 0, progressSignatures: [], reviewAttempts: Array.from({ length: 8 }, (_, index) => `original-claim-${index}`),
        consumedReviewDecisionFeedback: ['e'.repeat(64)], pendingReviews: [], inheritedTokens: 10, inheritedTurns: 26, manualResumeCount: 0 }
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 27, usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, checkpoint } } })
      const ready = await prisma.$transaction(tx => buildManualReviewRepairFacts(tx, f.userId, f.runId))
      expect(ready.review.manifest.manualRepair?.originalFindings).toHaveLength(7)
      const wire = { ...common, findings: [], semanticChecks: checks.map(({ findingIndexes: _indexes, ...row }) => ({ ...row, findingIds: [] })),
        terminalDispositions: [0, 1].map(obligationIndex => ({ obligationIndex, outcome: 'replaced', candidateIndex: obligationIndex + 1,
          reason: 'This old question remains open in the explicitly selected current question; the mystery has not been solved.', sourceEvidence: [{ segmentId: 'c0' }] })),
        originalFindingDispositions: oldFindings.map((_, index) => ({ index, action: 'retract', reason: 'The old “invented quote” was unsupported after complete independent review.', sourceEvidence: [{ segmentId: 'c0' }] })) }
      const transport = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wire) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } })))
      vi.stubGlobal('fetch', transport)
      const quote = await quoteManualReviewRepair(f.userId, f.runId)
      await submitManualReviewRepair(f.userId, f.runId, { intent: 'repair_failed_review_once', quoteToken: quote.quoteToken })
      await vi.waitFor(async () => expect((await readManualReviewRepair(f.userId, f.runId)).status).toMatchObject({ state: 'complete', terminalCommitted: true }), { timeout: 10000 })
      expect(transport).toHaveBeenCalledOnce(); expect(main).not.toHaveBeenCalled()
      const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      expect(finished.status).toBe('completed'); expect((finished.usage as { checkpoint: unknown }).checkpoint).toEqual(checkpoint)
      const final = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
      expect(final).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: 4 } })
      const audit = (final.validation as { continuityCriticResponse: { terminalEvidence: typeof nextContext } }).continuityCriticResponse
      const binding = await readTerminalDraftBinding(prisma, { ...f, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: final.preparedContext }, chapter, final.validation, audit.terminalEvidence)
      expect(currentTerminalReview(final.validation, content, audit.terminalEvidence, binding)).toMatchObject({ deliveryEligibility: { eligible: true, basis: 'current_supported_with_preserved_drafts' } })
      const manualCtx = { ...f, callId: ready.operationId } as ToolContext
      const dispatch = await prisma.agentRunEvent.findUniqueOrThrow({ where: { id: repairEventId(ready.operationId, 'dispatch') } })
      const newUsageId = (dispatch.payload as { value: { usageId: string } }).value.usageId
      const exactUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const exactLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      for (const scenario of ['missing-grant', 'wrong-dispatch', 'old-raw-drift', 'ledger-drift'] as const) {
        await expect(prisma.$transaction(async tx => {
          if (scenario === 'missing-grant') await tx.agentRunEvent.delete({ where: { id: repairEventId(ready.operationId, 'authorized') } })
          if (scenario === 'wrong-dispatch') {
            const payload = structuredClone(dispatch.payload) as { value: { usageId: string }; hash: string }
            payload.value.usageId = 'foreign-usage'; payload.hash = repairHash(payload.value)
            await tx.agentRunEvent.update({ where: { id: dispatch.id }, data: { payload } })
          }
          if (scenario === 'old-raw-drift') {
            const old = protectedArtifacts.find(row => (row.metadata as { stage?: string; assessmentKey?: string }).stage === 'first'
              && (row.metadata as { assessmentKey?: string }).assessmentKey === key)!
            const metadata = structuredClone(old.metadata) as { response: { content: string } }
            metadata.response.content = JSON.stringify('A different complete raw response.')
            await tx.agentArtifact.update({ where: { id: old.id }, data: { metadata } })
          }
          if (scenario === 'ledger-drift') await tx.creditLedgerEntry.update({ where: { idempotencyKey: `usage:${newUsageId}` }, data: { deltaMilli: { decrement: 1 } } })
          await readLegacyContinuityAssessment(tx, manualCtx, ready.input)
        })).rejects.toBeDefined()
      }
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(exactUsage)
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(exactLedger)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      expect(await prisma.aiUsageLog.findMany({ where: { id: { in: protectedUsage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual([...protectedUsage].sort((a, b) => a.id.localeCompare(b.id)))
      expect(await prisma.agentArtifact.findMany({ where: { id: { in: protectedArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual([...protectedArtifacts].sort((a, b) => a.id.localeCompare(b.id)))
    } finally {
      env.authSessionSecret = oldSecret
      await prisma.creditLedgerEntry.deleteMany({ where: { userId: f.userId } }); await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }); await prisma.creditAccount.deleteMany({ where: { userId: f.userId } })
    }
  }, undefined, prompt, { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
