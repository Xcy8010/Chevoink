import { describe, expect, it, vi } from 'vitest'
import { inspectContinuityV4 } from '../../api/lib/agent/continuity-review-v4.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { terminalInputDecisionFixture } from '../helpers/terminal-input-decision-fixture.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite, validateStoryContinuity, readPersistedWritingWorkflowMilestones } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { observeChapterReviewProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { getActiveRun } from '../../api/lib/agent/active-runs.js'
import { readLegacyContinuityAssessment, bindLegacyContinuityAssessment, markLegacyContinuityAssessmentApplication } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readTerminalInputDecision } from '../../api/lib/agent/terminal-input-decision.js'
import { buildContinuitySupplementQuestion, persistContinuitySupplementQuestion, continuitySupplementQuestionArgs,
  readContinuitySupplementState, knownContinuitySupplementCall, authenticateSupplementalContinuityReport,
  executeContinuitySupplement, executeContinuitySupplementTool, claimContinuityPhase, readKnownContinuityReplay } from '../../api/lib/agent/continuity-coordinator.js'
import { readNormalizedContinuityCoverageOrigins, saveContinuitySourceRecovery } from '../../api/lib/agent/continuity-coordinator.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { executeAgentRun, handleToolCall } from '../../api/lib/agent/loop.js'
import { runCheckpointSchema, recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import { reviewDispatchKey } from '../../api/lib/agent/review-dispatch.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { resolveLoopRunQuestion } from '../../api/lib/agent/run-service.js'
import { RunEventBus, loadPersistedEvents } from '../../api/lib/agent/events.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import * as projections from '../../api/lib/agent/continuity-review-v4.js'
import { advanceTerminalCoverage } from '../../api/lib/agent/terminal-fact-coverage.js'
import { readAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const prompt = '修改第一章，只输出标题和正文'
const options = { freezeWriting: true, continuityEvidenceProtocol: 1 as const, terminalEvidenceProtocol: 2 as const,
  terminalQuoteAddressProtocol: 1 as const, terminalCoverageProtocol: 2 as const }
const runtime = { tier: 'speed', provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-only', multiplierBps: 15000, reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 } satisfies NonNullable<ToolContext['modelRuntime']>
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'original-supplement-fixture',
  rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
// The HTTP fixtures report 12/8 tokens and omit cache evidence. Preserve that
// unknown cache policy and price the seed and actual settlement identically.
const chargeMilli = priceTokenEvidence(price, 12, 8, null)
const ledgerPrice = { pricingVersion: price.version, rateCardId: price.rateCardId, rates: price.rates,
  cacheHitTokens: null, cacheMissTokens: null, cachePricingPolicy: 'unknown-cache-discount-2026-09-09', platformAbsorbsDifference: true }

async function assertSupplementSettlement(userId: string, compilationId: string, usage: { id: string; creditChargeMilli: number }) {
  const rows = await prisma.creditLedgerEntry.findMany({ where: { idempotencyKey: `usage:${usage.id}` } })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ userId, kind: 'usage', sourceType: 'model_tokens', referenceId: compilationId,
    idempotencyKey: `usage:${usage.id}`, deltaMilli: -chargeMilli, dailyDeltaMilli: -chargeMilli, bonusDeltaMilli: 0,
    modelTier: runtime.tier, multiplierBps: price.multiplierBps, requestTokens: 12, responseTokens: 8, metadata: ledgerPrice })
  expect(usage.creditChargeMilli).toBe(chargeMilli)
  expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(4)
  expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).toMatchObject({
    dailyUsedMilli: 4 * chargeMilli, bonusBalanceMilli: 0,
  })
}

// The same project-native synthetic legacy pair used by the exhausted-input
// regression is applied through the real report producer. No old admission,
// claim, raw response, price or coverage ledger is upgraded to contract5.
async function originalFailure(f: Fixture, conflict = false, qualityReady = false, pendingFact = false, originalPrompt = prompt) {
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ ...price, rateCardId: 'new-admin-price-must-not-replace-original' })
  const main = vi.spyOn(ai, 'chatWithTools').mockRejectedValue(Error('No main-model turn is authorized by this phase'))
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0,
    taskRootId: null, startRequest: { prompt: originalPrompt }, modelTier: 'speed', reasoningEffort: 'high',
    usage: { promptTokens: 36, completionTokens: 24, totalTokens: 60, checkpoint: { reviewAttempts: ['original-consumed-claim'] } } } })
  const content = (conflict ? 'The packet remains sealed. The packet is open. The table remains dry.' : 'The packet remains sealed. The table remains dry.')
    + (pendingFact ? ' A reply remains pending.' : '')
  const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 4, content, wordCount: content.length } })
  const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
  const state = { knowledge: [], emotion: [], body: [], objects: ['The packet remains sealed.'], relationships: [], openLoops: [] }
  await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inventory', entryState: state, goal: 'Read', obstacle: 'Time',
    choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: chapter.revision })
  const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  const draft = terminalDraftFixture(pendingFact ? 'openLoops' : 'emotion', { chapter, taskId: f.spec.id, ctx: f, compilationId: compilation.id,
    candidate: terminalDraftFixture().candidate,
    originBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null,
      terminalCandidate: terminalDraftFixture(pendingFact ? 'openLoops' : 'emotion').base }, 11)).hash,
    currentBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null,
      terminalCandidate: terminalDraftFixture().candidate }, 11)).hash })
  const originWire = pendingFact ? { ...draft.originWire, terminalVerdicts: [{ claimIndex: 0, verdict: 'supported',
    sourceEvidence: [{ segmentId: 'c0', quote: 'A reply remains pending.' }] }] } : draft.originWire
  const originInspection = draft.inspect(originWire, draft.input), originBound = bindLegacyContinuityAssessment(originInspection, { ...draft.ctx, callId: 'origin' }, draft.input)
  const preparedContext = { ...(saved.preparedContext as Record<string, unknown>), ...(pendingFact ? {} : draft.preparedContext),
    ...(pendingFact ? { terminalFactCoverage: advanceTerminalCoverage(f.spec, {}, chapter,
      readAuthenticatedContinuityAssessment(originBound.audit, chapter.content, draft.context, true)!, draft.context.factCoverage) } : {}) }
  const old = terminalInputDecisionFixture({ runId: f.runId, taskSpec: f.spec, chapter, compilationId: compilation.id,
    bridge: saved.bridge, scenes: saved.sceneTasks, preparedContext, proposals: pendingFact ? undefined : draft.nextContext.proposalChanges })
  await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: { callId: old.callId,
    toolName: 'continuity_validate', args: { compilationId: compilation.id } } } })
  const window = credits.getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000000, dailyUsedMilli: 3 * chargeMilli,
    periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  const usageIds = new Map<string, string>()
  for (const [index, key] of ['first-usage', 'second-usage', 'usage-origin'].entries()) {
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
      targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', providerName: runtime.provider,
      modelName: runtime.modelName, modelTier: runtime.tier, multiplierBps: runtime.multiplierBps, billingSnapshot: price,
      action: index === 1 ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic', requestTokens: 12, responseTokens: 8,
      usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: chargeMilli,
      billingEvidence: { responseObserved: true }, durationMs: 0 } })
    usageIds.set(key, usage.id)
    await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'usage', sourceType: 'model_tokens', referenceId: compilation.id,
      idempotencyKey: `usage:${usage.id}`, deltaMilli: -chargeMilli, dailyDeltaMilli: -chargeMilli, bonusDeltaMilli: 0,
      modelTier: runtime.tier, multiplierBps: price.multiplierBps, requestTokens: 12, responseTokens: 8, metadata: ledgerPrice } })
  }
  for (const metadata of [...draft.rows.filter(row => row.id.startsWith('origin-')).map(row => ({ ...row.metadata,
    ...(pendingFact && row.metadata.stage === 'first' ? { audit: originInspection.audit, response: { content: JSON.stringify(JSON.stringify(originWire)),
      encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } } : {}) })), ...old.metadata]) {
    const next = { ...metadata }
    if (Array.isArray(next.usageIds)) next.usageIds = next.usageIds.map(id => usageIds.get(String(id))!)
    await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Synthetic original evidence',
      content: 'Synthetic original evidence.', metadata: runtimeJson(next).value } })
  }
  const ctx: ToolContext = { ...f, callId: old.callId, continuityOwnerSeq: 3, signal: new AbortController().signal,
    mode: 'build', qualityMode: 'balanced', creativeFreedom: 'balanced', modelRuntime: runtime, emit: () => {} }
  const received = await prisma.$transaction(tx => readLegacyContinuityAssessment(tx, ctx, old.frozen))
  expect(received).toMatchObject({ recoveryReady: true, billingKnown: true, providerComplete: true, inspected: { complete: false } })
  const bound = bindLegacyContinuityAssessment(received.inspected, ctx, old.frozen)
  await prisma.$transaction(async tx => {
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, terminalCandidate: draft.base,
      findings: [], independentCheck: 'complete', coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge,
        sceneTasks: saved.sceneTasks, source: null, terminalCandidate: draft.base }, 11), continuityCriticResponse: originBound.audit }, tx)
    // Direct validation is only the report producer. Reuse the real application
    // writer in that same transaction, as the actual tool does; no fake receipt.
    await markLegacyContinuityAssessmentApplication(tx, { ...ctx, callId: 'origin' }, originBound)
  })
  await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, terminalCandidate: old.candidate,
    findings: [], independentCheck: 'unavailable', coverage: old.coverage, continuityCriticResponse: bound.audit })
  if (qualityReady) await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id,
    chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
  await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', payload: { callId: old.callId,
    toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' } } })
  await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.started', payload: { type: 'run.started', seq: 3 } } })
  const decision = await prisma.$transaction(tx => readTerminalInputDecision(tx, ctx, compilation.id))
  expect(decision).not.toBeNull()
  expect(await prisma.$transaction(tx => readKnownContinuityReplay(tx, ctx, compilation.id))).toBeNull()
  const sourceTarget = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, select: { preparedContext: true } })
  await prisma.$transaction(tx => saveContinuitySourceRecovery(tx, ctx, { compilationId: compilation.id, chapterId: chapter.id,
    preparedContext: sourceTarget.preparedContext, originalAssessmentKey: old.key }))
  const question = await prisma.$transaction(tx => buildContinuitySupplementQuestion(tx, ctx, decision!))
  await prisma.$transaction(tx => persistContinuitySupplementQuestion(tx, ctx, question))
  const before = {
    artifacts: await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } }),
    usage: await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
    ledger: await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
    run: await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } }),
    compilation: await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }),
  }
  const approve = async (answer = question.accept) => {
    const args = await continuitySupplementQuestionArgs(prisma, ctx, question.requestId)
    const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    const bus = new RunEventBus(f.runId, tail.seq)
    const pending = handleToolCall({ id: question.callId, name: 'ask_user', arguments: JSON.stringify({ question: args.question, options: args.options }) },
      [{ ...askUserTool, execute: (ctx: ToolContext, raw: unknown) => askUserTool.execute(ctx, askUserTool.parameters.parse(raw)) }],
      { ...ctx, callId: question.callId, continuityQuestion: { requestId: question.requestId } }, bus, 'synthetic-question', f.runId)
    try {
      await vi.waitFor(async () => expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('awaiting_approval'))
      await expect(resolveLoopRunQuestion(f.userId, f.runId, question.callId, answer, question.requestId)).resolves.toEqual({ resolved: true })
      expect(await pending).toMatchObject({ part: { status: 'success' } })
    } finally { await bus.close() }
  }
  const invoke = async (callId: string, dispatchAllowed = true, ownerSeq = ctx.continuityOwnerSeq) => {
    const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    const bus = new RunEventBus(f.runId, tail.seq)
    try {
      return await handleToolCall({ id: callId, name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) },
        [{ ...continuityValidateTool, execute: (ctx: ToolContext, raw: unknown) => continuityValidateTool.execute(ctx, continuityValidateTool.parameters.parse(raw)) }],
        { ...ctx, callId, continuityOwnerSeq: ownerSeq,
          continuitySupplement: { requestId: question.requestId, dispatchAllowed } }, bus, 'synthetic-supplement', f.runId, undefined, () => bus.persist())
    } finally { await bus.close() }
  }
  const unchangedOriginal = async () => {
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: before.artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before.artifacts)
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: before.usage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before.usage)
    expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: before.ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before.ledger)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(run).toMatchObject({ taskSpec: before.run.taskSpec, modelTier: before.run.modelTier,
      reasoningEffort: before.run.reasoningEffort, customModelId: before.run.customModelId })
    expect((run.usage as { checkpoint: unknown }).checkpoint).toEqual((before.run.usage as { checkpoint: unknown }).checkpoint)
    expect(main).not.toHaveBeenCalled()
  }
  return { ctx, chapter, compilation, old, question, before, main, approve, invoke, unchangedOriginal }
}

function wireFor(question: Awaited<ReturnType<typeof originalFailure>>['question'], kind: 'unknown' | 'conflict' | 'invalid' | 'complete') {
  const context = question.frozen.input.bodies.terminalEvidence!
  const finding = { findingId: 'f0', signal: 'object', severity: 'error', reasonCode: 'manuscript_conflict',
    explanation: 'The packet is sealed and open at the same time.', suggestion: 'Resolve the incompatible states within the original scope.',
    manuscriptEvidence: [{ segmentId: 'c0', quote: 'The packet remains sealed.' }, { segmentId: 'c0', quote: 'The packet is open.' }] }
  const wire = { findings: kind === 'conflict' ? [finding] : [], semanticChecks: ['action_direction', 'state_progression'].map((key, index) => ({ kind: key,
    result: kind === 'conflict' && index === 1 ? 'conflict' : 'clear', reasonCode: kind === 'conflict' && index === 1 ? 'manuscript_conflict' : 'consistent',
    explanation: kind === 'conflict' && index === 1 ? finding.explanation : 'Full manuscript evidence is internally consistent.',
    findingIds: kind === 'conflict' && index === 1 ? ['f0'] : [] })),
    terminalVerdicts: [{ claimIndex: 0, verdict: kind === 'unknown' ? 'unknown' : 'supported',
      reasonCode: kind === 'unknown' ? 'insufficient_evidence' : 'consistent', explanation: 'Independent judgment of the whole current claim.',
      manuscriptEvidence: kind === 'unknown' ? [] : [{ segmentId: kind === 'invalid' ? 'c999' : 'c0' }] }],
    terminalProofVerdicts: [], terminalDispositions: (context.factCoverage?.obligations ?? []).map((_, obligationIndex) => ({ obligationIndex,
      outcome: 'unknown', reasonCode: 'insufficient_evidence', explanation: 'This full obligation remains independently unverified.', manuscriptEvidence: [] })),
    ...(context.proposalChanges ? { proposalDispositions: context.proposalChanges.proposals.map((_, proposalIndex) => ({ proposalIndex,
      outcome: kind === 'complete' ? 'retracted' : 'unknown', reasonCode: kind === 'complete' ? 'consistent' : 'insufficient_evidence',
      explanation: 'The manuscript explicitly records packet and table states; the earlier reply proposal is not established by those states.',
      manuscriptEvidence: kind === 'complete' ? [{ segmentId: 'c0' }] : [] })) } : {}),
    issueDispositions: question.frozen.input.continuityManifest!.typedLineage!.establishedIssues.map((_, issueIndex) => ({ issueIndex,
      outcome: 'unknown', reasonCode: 'insufficient_evidence', explanation: 'The established issue remains unverified.', manuscriptEvidence: [] })) }
  const inspected = inspectContinuityV4(JSON.stringify(wire), { manifest: question.frozen.input.continuityManifest!, bodies: question.frozen.input.bodies,
    candidate: question.frozen.input.terminalCandidate!, sourceScope: question.frozen.input.sourceScope! })
  expect(inspected.complete, JSON.stringify({ classification: inspected.audit.classification, diagnostics: inspected.parsed?.diagnostics })).toBe(kind !== 'invalid')
  return wire
}

describe.runIf(available)('original persistent supplemental phase: real questions, transport, events and settlement', () => {
  it.each(['same-owner', 'new-owner-expired'] as const)(
    '%s applies the marked whole-report normalization for free without rewriting the original failure', scenario => fixture(async f => {
      const s = await originalFailure(f); await s.approve()
      const wire = wireFor(s.question, 'unknown')
      wire.proposalDispositions![0].explanation = 'The earlier draft “A reply remains pending.” is not established by current manuscript evidence.'
      const raw = JSON.stringify(wire)
      const network = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } }))); vi.stubGlobal('fetch', network)
      // This first call reproduces the already-deployed strict parser10
      // consumer, while all real grant/dispatch/fee/application writes run.
      const strict = vi.spyOn(projections, 'normalizeContinuityV4Projection').mockImplementation(first => first)
      try { expect(await s.invoke('original-strict-paid-report')).toMatchObject({ part: { status: 'failed' }, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }) }
      finally { strict.mockRestore() }
      const before = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
      const failure = before.find(row => (row.metadata as { continuitySupplementApplication?: { reportComplete?: boolean } }).continuitySupplementApplication?.reportComplete === false)!
      expect(failure).toBeDefined()
      const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const usage = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).usage
      let ownerSeq = s.ctx.continuityOwnerSeq
      let time: ReturnType<typeof vi.spyOn> | undefined
      try {
        if (scenario === 'new-owner-expired') {
          const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
          ownerSeq = tail.seq + 1
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: ownerSeq, type: 'run.started', payload: { type: 'run.started', seq: ownerSeq } } })
          time = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(s.question.expiresAt) + 1)
        }
        expect((await readContinuitySupplementState(prisma, { ...s.ctx, continuityOwnerSeq: ownerSeq }, s.old.key)).kind).toBe('known_result')
        expect(await s.invoke('free-complete-projection-application', false, ownerSeq)).toMatchObject({ reviewCompleted: true,
          reviewOutcome: 'decision_required', part: { status: 'success' } })
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })
        const audit = (saved.validation as Record<string, unknown>).continuityCriticResponse as projections.ContinuityV4Inspection['audit']
        const originalReportHash = (failure.metadata as { continuitySupplementApplication: { reportHash: string } }).continuitySupplementApplication.reportHash
        expect(saved.validation).toMatchObject({ independentCheck: 'complete' })
        expect(audit.continuityV4.projectionNormalization).toMatchObject({ version: 1, originReportHash: originalReportHash,
          frozenInputHash: runtimeJson(s.question.frozen.input).hash,
          mappings: [expect.objectContaining({ table: 'proposalDispositions', index: 0, kind: 'proposal_claim_audit' })] })
        expect(JSON.parse(audit.rawResponse.content)).toBe(raw)
        expect(projections.validateStoredContinuityV4Projection(audit, s.chapter.content, s.question.frozen.input.bodies.terminalEvidence)?.parsed?.record).toEqual(wire)
        expect(await authenticateSupplementalContinuityReport(prisma, s.ctx, audit)).toBe(true)
        const origins = await readNormalizedContinuityCoverageOrigins(prisma, s.ctx,
          { compilationId: saved.id, chapterId: s.chapter.id, preparedContext: saved.preparedContext }, audit)
        expect(origins).not.toBeNull()
        expect(origins!.currentFactIds).toEqual([])
        expect(runtimeJson((saved.preparedContext as { terminalFactCoverage: unknown }).terminalFactCoverage).hash).not.toBe(origins!.ledgerHash)
        const originalApplication = before.find(row => typeof (row.metadata as { assessmentApplicationKey?: unknown }).assessmentApplicationKey === 'string')!
        await expect(prisma.$transaction(async tx => {
          await tx.agentArtifact.update({ where: { id: originalApplication.id }, data: { metadata: {
            ...(originalApplication.metadata as object), reservationId: 'not-the-authenticated-original-reservation' } } })
          await expect(readNormalizedContinuityCoverageOrigins(tx, s.ctx,
            { compilationId: saved.id, chapterId: s.chapter.id, preparedContext: saved.preparedContext }, audit)).rejects.toBeInstanceOf(Error)
          throw Error('rollback damaged original source application')
        })).rejects.toThrow('rollback damaged original source application')
        expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('applied')
        const applications = await prisma.agentArtifact.findMany({ where: { runId: f.runId,
          metadata: { path: ['continuitySupplementProjectionApplication', 'requestId'], equals: s.question.requestId } } })
        expect(applications).toHaveLength(1)
        expect(applications[0].metadata).toMatchObject({ continuitySupplementProjectionApplication: {
          originReportHash: originalReportHash, reportHash: runtimeJson(audit).hash, reportComplete: true } })
        const events = await loadPersistedEvents(f.runId, 3)
        expect(events.filter(event => event.type === 'tool.result' && event.callId === 'free-complete-projection-application')).toMatchObject([{ ok: true }])
        // The unverified claim remains UNKNOWN and cannot force a commit.
        expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ committedAt: null })
        for (const damage of ['missing-normalization-application', 'wrong-origin'] as const) {
          await expect(prisma.$transaction(async tx => {
            if (damage === 'missing-normalization-application') await tx.agentArtifact.delete({ where: { id: applications[0].id } })
            else await tx.agentArtifact.update({ where: { id: applications[0].id }, data: { metadata: { version: 1,
              continuitySupplementProjectionApplication: { ...(applications[0].metadata as { continuitySupplementProjectionApplication: object }).continuitySupplementProjectionApplication,
                originReportHash: '0'.repeat(64) } } } })
            expect(await authenticateSupplementalContinuityReport(tx, s.ctx, audit)).toBe(false)
            throw Error('rollback synthetic normalization source damage')
          })).rejects.toThrow('rollback synthetic normalization source damage')
        }
        await s.invoke('duplicate-normalization-application', false, ownerSeq)
        expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).toEqual(saved)
        expect(await prisma.agentArtifact.findMany({ where: { id: { in: before.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before)
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(fees)
        expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).usage).toEqual(usage)
        expect(network).toHaveBeenCalledOnce(); expect(s.main).not.toHaveBeenCalled()
      } finally { time?.mockRestore() }
      await s.unchangedOriginal()
    }, undefined, prompt, options), 30000)

  it('preserves uncommitted draft coverage through same-call retention, bridge and successor reads', () => fixture(async f => {
    const s = await originalFailure(f, true, true, true, '修改第一章')
    expect(f.spec.hardConstraints).toEqual([]); expect(f.spec.postconditions).toEqual([])
    await s.approve()
    const wire = wireFor(s.question, 'conflict')
    wire.findings[0].explanation += ' The earlier opinion “old preliminary wording” is explanatory discussion.'
    const raw = JSON.stringify(wire), network = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } })))
    vi.stubGlobal('fetch', network)
    const strict = vi.spyOn(projections, 'normalizeContinuityV4Projection').mockImplementation(first => first)
    try { expect(await s.invoke('old-strict-paid-draft-report')).toMatchObject({ failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }) }
    finally { strict.mockRestore() }
    const originals = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(await s.invoke('free-draft-report-apply', false)).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required', part: { status: 'success' } })
    const before = await readChapterReviewReadiness(prisma, f, s.compilation.id)
    expect(before).toMatchObject({ continuity: 'complete', continuityErrorCount: 1, decisionPending: true,
      terminalReview: { currentResultVerified: true, deliveryEligible: false } })
    const retainedFindings = before!.requiredDecisions!.map(item => ({ ...item,
      reason: 'Retain the independent opinion explicitly for the author; no wording repair or completion of the pending reply is claimed.' }))
    const committed = await chapterBridgeCommitTool.execute({ ...s.ctx, callId: 'same-call-retention-and-commit' }, { compilationId: s.compilation.id, retainedFindings })
    expect(committed).not.toMatchObject({ outcome: 'failed' }); expect(committed).not.toHaveProperty('failureCode')
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })
    const pendingId = terminalFactId('openLoops', 'A reply remains pending.')
    expect(saved.validation).toMatchObject({ errorCount: 1, retainedReviewDecision: { findings: retainedFindings }, continuityCriticResponse: {
      continuityV4: { projectionNormalization: { version: 1 } } } })
    expect(saved.preparedContext).toMatchObject({ terminalFactCoverage: { facts: expect.arrayContaining([{ id: pendingId,
      field: 'openLoops', claim: 'A reply remains pending.' }]) }, terminalReviewProof: { scopePreservation: { version: 1, pendingCoverageIds: [pendingId] } } })
    const audit = (saved.validation as { continuityCriticResponse: projections.ContinuityV4Inspection['audit'] }).continuityCriticResponse
    expect(projections.validateStoredContinuityV4Projection(audit, s.chapter.content, s.question.frozen.input.bodies.terminalEvidence)?.parsed?.record).toEqual(wire)
    const source = await readCompilerContinuitySource(prisma, f, { orderIndex: s.chapter.orderIndex + 1 }, s.chapter.id, 11)
    expect(source && 'terminalInheritance' in source && Array.isArray(source.terminalInheritance)
      ? source.terminalInheritance.some(fact => terminalFactId(fact.field, fact.claim) === pendingId) : false).toBe(false)
    expect(source && 'terminalInheritance' in source ? source.terminalInheritance : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'objects', claim: 'The packet remains sealed.' })]))
    await recordStoryCompilerWrite({ ...f, chapterOrderIndex: s.chapter.orderIndex, chapterRevision: s.chapter.revision })
    expect((await readChapterReviewReadiness(prisma, f, s.compilation.id))?.terminalReview?.deliveryEligible).toBe(false)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(fees)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: originals.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(originals)
    expect(network).toHaveBeenCalledOnce(); expect(s.main).not.toHaveBeenCalled()
  }, undefined, '修改第一章', options), 30000)

  it.each(['approve-in-loop', 'paused-accepted-new-owner', 'known-normalized-decision', 'applied-normalized-current-decisions'] as const)(
    '%s advances the existing phase before stagnation without counting approval as content', scenario => fixture(async f => {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
      vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
      const enabled = flags.isAgent2FeatureEnabled
      vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((name, owner) => name === 'storyCompiler' || name !== 'memory2' && enabled(name, owner))
      const appliedScenario = scenario === 'applied-normalized-current-decisions'
      const decisionScenario = scenario === 'known-normalized-decision' || appliedScenario
      const s = await originalFailure(f, decisionScenario, true, appliedScenario)
      if (scenario !== 'approve-in-loop') await s.approve()
      const paid = vi.fn(async () => {
        const wire = wireFor(s.question, 'conflict')
        if (wire.proposalDispositions?.length) wire.proposalDispositions[0].explanation = 'The earlier draft “A reply remains pending.” is not independently established.'
        if (appliedScenario) {
          const finding = wire.findings[0]
          wire.findings = Array.from({ length: 4 }, (_, index) => ({ ...finding, findingId: `f${index}`,
            explanation: `Independent opinion ${index + 1} compares “a historical annotation” with current packet evidence.` }))
          wire.semanticChecks[1].findingIds = wire.findings.map(item => item.findingId)
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wire) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8 } }))
      })
      if (decisionScenario) {
        vi.stubGlobal('fetch', paid)
        const strict = vi.spyOn(projections, 'normalizeContinuityV4Projection').mockImplementation(first => first)
        try { expect(await s.invoke('original-paid-format-failure')).toMatchObject({ failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }) }
        finally { strict.mockRestore() }
        expect(paid).toHaveBeenCalledOnce()
        if (appliedScenario) {
          const quotes = ['The packet remains sealed.', 'packet remains sealed.', 'remains sealed.', 'The packet is open.', 'packet is open.',
            'is open.', 'The table remains dry.', 'table remains dry.', 'remains dry.', 'sealed. The packet', 'open. The table']
          const quality = await persistHumanityQualityReport({ ...f, compilationId: s.compilation.id, chapterId: s.chapter.id,
            chapterRevision: s.chapter.revision, mode: 'balanced', criticComplete: true, deterministicFindings: [], deterministicMetrics: {},
            criticFindings: quotes.map((quote, index) => ({ signal: 'emotion_grounding', severity: 'advisory', quote,
              explanation: `Current advisory opinion ${index + 1}; evidence is preserved.`, suggestion: 'Assess this advice without mechanically changing facts.', confidence: 0.8 })) })
          expect(quality).toMatchObject({ status: 'passed' })
          expect(quality.findings).toHaveLength(11)
          expect(await s.invoke('successful-free-application-before-resume', false)).toMatchObject({ reviewCompleted: true, part: { status: 'success' } })
          expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('applied')
        }
        s.main.mockImplementation(async () => {
          const current = await readChapterReviewReadiness(prisma, f, s.compilation.id)
          expect(current).toMatchObject({ ready: true, continuity: 'complete', continuityErrorCount: appliedScenario ? 4 : 1, decisionPending: true })
          expect(current!.requiredDecisions).toHaveLength(appliedScenario ? 15 : 1)
          if (appliedScenario) {
            expect(current).toMatchObject({ quality: 'complete', requiredTools: [], terminalReview: { currentResultVerified: true, deliveryEligible: false } })
            expect(current!.requiredDecisions!.filter(item => item.source === 'quality')).toHaveLength(11)
            expect(await loadPersistedEvents(f.runId, pause.seq)).not.toContainEqual(expect.objectContaining({ type: 'run.paused' }))
          }
          return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'ordinary-current-report-decision', name: 'chapter_bridge_commit',
            arguments: JSON.stringify({ compilationId: s.compilation.id, retainedFindings: current!.requiredDecisions!.map(item => ({ ...item,
              reason: 'Keep this independent opinion and the original wording explicitly pending for the author; no repair or factual clearance is claimed.' })) }) }],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
        })
      }
      const review = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, s.compilation.id))
      const signatures = new Set<string>()
      observeChapterReviewProgress(signatures, review?.progressEvidence,
        { userId: f.userId, novelId: f.novelId, expectedOriginalTaskId: f.spec.id, taskSpec: f.spec })
      for (const milestone of await readPersistedWritingWorkflowMilestones({ ...f, taskSpec: f.spec }))
        observeWritingWorkflowMilestone(signatures, milestone.phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build', milestone,
          { userId: f.userId, novelId: f.novelId, runId: f.runId, taskSpec: f.spec })
      const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
      const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 1, type: 'run.paused', payload: { reason: 'needs_input' } } })
      const checkpoint = runCheckpointSchema.parse({ version: 2, controlPolicy: 'until_completion', origin: 'system_default',
        runStartedAt: Date.now() - 1000, activeExecutionMs: 100, stagnantBatches: appliedScenario ? 7 : scenario === 'approve-in-loop' ? 4 : 5,
        resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500, writeProgress: 3, writeBaseline: 0, readProgress: 11, readBaseline: 0,
        progressSignatures: [...signatures], reviewAttempts: ['original-consumed-claim', ...(appliedScenario ? [reviewDispatchKey(review!, 'merged')] : [])], pendingReviews: [],
        consumedReviewDecisionFeedback: ['e'.repeat(64), ...(review?.decisionFeedback ? [review.decisionFeedback.key] : [])],
        inheritedTokens: 0, inheritedTurns: 0, manualResumeCount: 0 })
      const beforeResume = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 27, startedAt: new Date(checkpoint.runStartedAt),
        usage: { ...(beforeResume.usage as object), checkpoint: JSON.parse(JSON.stringify(checkpoint)) } } })
      let approvedQuestion = s.question
      const network = vi.fn(async () => {
        if (decisionScenario) throw Error('A known paid whole report cannot dispatch again during free application or ordinary decision')
        const current = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        expect(runCheckpointSchema.parse((current.usage as { checkpoint: unknown }).checkpoint)).toMatchObject({ stagnantBatches: 5,
          readProgress: 11, writeProgress: 3, tokenBudget: 500, maxTurns: 1,
          consumedReviewDecisionFeedback: checkpoint.consumedReviewDecisionFeedback })
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wireFor(approvedQuestion, 'complete')) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8 } }))
      }); vi.stubGlobal('fetch', network)
      const running = executeAgentRun({ ...f, prompt, mode: 'build', resume: true, authorContinue: { eventId: pause.id, afterSeq: pause.seq },
        eventStartSeq: pause.seq, modelTier: 'speed', reasoningEffort: 'high', qualityMode: 'balanced', creativeFreedom: 'balanced' })
      try {
        if (scenario === 'approve-in-loop') {
          await vi.waitFor(async () => expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('awaiting_approval'))
          const card = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId, type: 'tool.call', seq: { gt: pause.seq },
            payload: { path: ['toolName'], equals: 'ask_user' } }, orderBy: { seq: 'desc' } })
          const args = (card.payload as { args: { requestId: string } }).args
          const row = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: args.requestId } })
          approvedQuestion = (row.metadata as unknown as { continuitySupplementQuestion: typeof s.question }).continuitySupplementQuestion
          await resolveLoopRunQuestion(f.userId, f.runId, approvedQuestion.callId, approvedQuestion.accept, approvedQuestion.requestId)
        }
        await running
      } finally { getActiveRun(f.runId)?.controller.abort(); await running }
      if (decisionScenario) { expect(network).not.toHaveBeenCalled(); expect(s.main).toHaveBeenCalledOnce(); expect(paid).toHaveBeenCalledOnce() }
      else { expect(network).toHaveBeenCalledOnce(); expect(s.main).not.toHaveBeenCalled() }
      const events = await loadPersistedEvents(f.runId, pause.seq)
      expect(events.filter(event => event.type === 'tool.call' && event.toolName === 'ask_user')).toHaveLength(scenario === 'approve-in-loop' ? 1 : 0)
      const reviews = events.filter(event => event.type === 'tool.result' && event.toolName === 'continuity_validate')
      if (appliedScenario) expect(reviews).toEqual([])
      else expect(reviews).toMatchObject([{ ok: true }])
      for (const event of reviews) expect(event).not.toHaveProperty('reviewOutcome')
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      expect(run.status).toBe('completed')
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ committedAt: expect.any(Date), targetRevision: 4 })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toMatchObject({ revision: 4, content: s.chapter.content })
      expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('applied')
      const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
      await assertSupplementSettlement(f.userId, s.compilation.id, fee)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(4)
      expect(await prisma.agentArtifact.findMany({ where: { id: { in: s.before.artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(s.before.artifacts)
      expect(await prisma.aiUsageLog.findMany({ where: { id: { in: s.before.usage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(s.before.usage)
      expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: s.before.ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(s.before.ledger)
      expect(runCheckpointSchema.parse((run.usage as { checkpoint: unknown }).checkpoint)).toMatchObject({ tokenBudget: 500, maxTurns: 1,
        reviewAttempts: expect.arrayContaining(['original-consumed-claim']), consumedReviewDecisionFeedback: decisionScenario
          ? expect.arrayContaining(checkpoint.consumedReviewDecisionFeedback) : checkpoint.consumedReviewDecisionFeedback })
      if (decisionScenario) {
        const compiled = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })
        expect(compiled.validation).toMatchObject({ errorCount: appliedScenario ? 4 : 1,
          continuityCriticResponse: { continuityV4: { projectionNormalization: { version: 1 } } } })
        const decisions = (compiled.validation as { retainedReviewDecision: { findings: Array<{ source: string; findingId: string }> } }).retainedReviewDecision.findings
        expect(decisions).toHaveLength(appliedScenario ? 15 : 1)
        expect(decisions).toEqual(expect.arrayContaining([{ source: 'continuity', reportId: expect.any(String), findingId: '0', reason: expect.any(String) }]))
      }
    }, undefined, prompt, scenario === 'applied-normalized-current-decisions' ? { ...options, reviewProtocol: 1 } : options), 30000)

  it('requires the dedicated question endpoint answer; reject/replay/ordinary Continue buy zero calls', () => fixture(async f => {
    const s = await originalFailure(f)
    const network = vi.fn(() => { throw Error('No provider call is authorized') }); vi.stubGlobal('fetch', network)
    await expect(resolveLoopRunQuestion(f.userId, f.runId, s.question.callId, '继续', s.question.requestId)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    await s.approve(s.question.reject)
    await expect(resolveLoopRunQuestion(f.userId, f.runId, s.question.callId, s.question.accept, s.question.requestId)).resolves.toEqual({ resolved: true })
    expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('no_authority')
    for (const callId of ['continue-without-grant', 'changed-call']) {
      await expect(executeContinuitySupplementTool({ ...s.ctx, callId,
        continuitySupplement: { requestId: s.question.requestId, dispatchAllowed: true } }, { compilationId: s.compilation.id })).rejects.toBeDefined()
    }
    expect(network).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(3)
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['unknown', 'conflict', 'invalid', 'dispatch-unknown'] as const)('%s uses one physical request and preserves honest tool outcome on duplicate Continue', kind => fixture(async f => {
    const s = await originalFailure(f, kind === 'conflict'); await s.approve()
    const raw = JSON.stringify(wireFor(s.question, kind === 'dispatch-unknown' ? 'complete' : kind))
    const network = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe(runtime.modelName); expect(body.messages.map((row: { content: string }) => row.content)).toEqual([s.question.frozen.input.system, s.question.frozen.input.content])
      expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'tool.call', payload: { path: ['callId'], equals: 'one-supplement' } } })).toBe(1)
      if (kind === 'dispatch-unknown') throw Error('Synthetic connection closed after physical dispatch')
      return new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
    }); vi.stubGlobal('fetch', network)
    const result = await s.invoke('one-supplement')
    const businessComplete = kind === 'unknown' || kind === 'conflict'
    if (businessComplete) {
      expect(result).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required', part: { status: 'success' } })
      expect(result).not.toHaveProperty('failureCode')
      const audit = ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation as Record<string, unknown>).continuityCriticResponse
      expect(await authenticateSupplementalContinuityReport(prisma, s.ctx, audit)).toBe(true)
    } else expect(result).toMatchObject({ part: { status: 'failed' } })
    const events = (await loadPersistedEvents(f.runId, 3)).filter(event => event.type === 'tool.result' && event.callId === 'one-supplement')
    expect(events).toMatchObject([{ type: 'tool.result', ok: businessComplete }])
    const after = await readContinuitySupplementState(prisma, s.ctx, s.old.key)
    expect(after.kind).toBe(kind === 'dispatch-unknown' ? 'unknown' : 'applied')
    const accountBefore = await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })
    const runBefore = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    for (const callId of ['duplicate-continue', 'worker-restart']) await s.invoke(callId)
    expect(network).toHaveBeenCalledOnce()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(4)
    const added = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
    expect(added).toMatchObject({ billingSnapshot: price, multiplierBps: runtime.multiplierBps })
    if (kind !== 'dispatch-unknown') {
      expect(added).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 })
      await assertSupplementSettlement(f.userId, s.compilation.id, added)
      expect(runBefore.usage).toMatchObject({ promptTokens: 48, completionTokens: 32, totalTokens: 80 })
    }
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(accountBefore)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).usage).toEqual(runBefore.usage)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toEqual(s.chapter)
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ committedAt: null })
    if (businessComplete) expect(await chapterBridgeCommitTool.execute({ ...s.ctx, callId: 'cannot-deliver-unknown-or-conflict' },
      { compilationId: s.compilation.id })).toMatchObject({ outcome: 'failed' })
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it('serializes concurrent continued calls at the original phase and one unique settlement', () => fixture(async f => {
    const s = await originalFailure(f); await s.approve()
    const raw = JSON.stringify(wireFor(s.question, 'unknown'))
    const network = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } })))
    vi.stubGlobal('fetch', network)
    const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    const callIds = ['concurrent-original-phase-a', 'concurrent-original-phase-b']
    // Both executor calls have already journaled their distinct tool identity;
    // concurrency begins at execution, without two buses sharing a seq range.
    for (const [index, callId] of callIds.entries()) await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + index + 1,
      type: 'tool.call', payload: { callId, toolName: 'continuity_validate', args: { compilationId: s.compilation.id } } } })
    const results = await Promise.allSettled(callIds.map(callId => executeContinuitySupplementTool({ ...s.ctx, callId,
      continuitySupplement: { requestId: s.question.requestId, dispatchAllowed: true } }, { compilationId: s.compilation.id })))
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]).toMatchObject({ value: { reviewCompleted: true, reviewOutcome: 'decision_required' } })
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(network).toHaveBeenCalledOnce()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(4)
    const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
    expect(fee).toMatchObject({ billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0 })
    await assertSupplementSettlement(f.userId, s.compilation.id, fee)
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId,
      metadata: { path: ['continuityPhaseClaim', 'phase'], equals: 'full_reassessment' } } })).toBe(1)
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['cancel', 'owner', 'revision'] as const)('keeps settled raw after %s drift and recovers locally only under current authority', drift => fixture(async f => {
    const s = await originalFailure(f); await s.approve()
    const raw = JSON.stringify(wireFor(s.question, 'complete'))
    const network = vi.fn(async () => {
      if (drift === 'cancel') await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused',
        usage: { ...(s.before.run.usage as object), authorEnded: true } } })
      if (drift === 'owner') {
        const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
        // A separate resumed executor owns a disjoint event range. Keep this
        // fence beyond the old bus's in-flight result rather than colliding.
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 1000, type: 'run.started', payload: { type: 'run.started', seq: tail.seq + 1000 } } })
      }
      if (drift === 'revision') await prisma.chapter.update({ where: { id: s.chapter.id }, data: { revision: { increment: 1 }, content: `${s.chapter.content} A new line.` } })
      return new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
    }); vi.stubGlobal('fetch', network)
    const result = await s.invoke('known-raw-before-apply')
    expect(result).toMatchObject({ part: { status: 'failed' } })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })
    expect(saved.validation).toEqual(s.before.compilation.validation)
    expect(saved.preparedContext).toEqual(s.before.compilation.preparedContext)
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ committedAt: null })
    expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('known_result')
    expect(await knownContinuitySupplementCall(prisma, s.ctx, s.question)).toMatchObject({ callId: 'known-raw-before-apply', revision: 4 })
    const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
    expect(fee).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', billingSnapshot: price, requestTokens: 12, responseTokens: 8 })
    await assertSupplementSettlement(f.userId, s.compilation.id, fee)
    const beforeRetry = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(beforeRetry.usage).toMatchObject({ promptTokens: 48, completionTokens: 32, totalTokens: 80 })
    if (drift === 'owner') {
      const owner = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId, type: 'run.started' }, orderBy: { seq: 'desc' } })
      const recovered = await s.invoke('resumed-owner-free-apply', false, owner.seq)
      expect(recovered).toMatchObject({ reviewCompleted: true, part: { status: 'success' } })
      expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('applied')
      const audit = ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation as Record<string, unknown>).continuityCriticResponse
      expect(await authenticateSupplementalContinuityReport(prisma, s.ctx, audit)).toBe(true)
      await s.invoke('another-continue-after-apply', false, owner.seq)
    } else {
      await s.invoke('late-known-raw-must-not-apply', false)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation).toEqual(saved.validation)
      if (drift === 'cancel') {
        await expect(resolveLoopRunQuestion(f.userId, f.runId, s.question.callId, s.question.accept, s.question.requestId)).resolves.toEqual({ resolved: true })
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
      }
    }
    expect(network).toHaveBeenCalledOnce()
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: fee.id } })).toEqual(fee)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).usage).toEqual(beforeRetry.usage)
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['raw-before-apply', 'applied-before-result', 'unknown-dispatch'] as const)(
    'actual loop restart reconciles only authenticated settled pending work: %s', window => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const enabled = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((name, owner) => name === 'storyCompiler' || name !== 'memory2' && enabled(name, owner))
    const s = await originalFailure(f, false, true); await s.approve()
    const callId = `crash-${window}`, raw = JSON.stringify(wireFor(s.question, 'complete'))
    const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 1, type: 'tool.call',
      payload: { callId, toolName: 'continuity_validate', args: { compilationId: s.compilation.id } } } })
    const firstHTTP = vi.fn(async () => {
      if (window === 'unknown-dispatch') throw Error('Synthetic process lost the provider response after dispatch')
      if (window === 'raw-before-apply') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 2,
        type: 'run.started', payload: { type: 'run.started', seq: tail.seq + 2 } } })
      return new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
    }); vi.stubGlobal('fetch', firstHTTP)
    const dispatchContext = { ...s.ctx, callId, continuitySupplement: { requestId: s.question.requestId, dispatchAllowed: true } }
    // Persist the actual call, dispatch, response, fee and (in the second
    // window) report CAS, but never synthesize the missing tool.result.
    if (window === 'applied-before-result') expect(await executeContinuitySupplementTool(dispatchContext,
      { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    else await expect(executeContinuitySupplement(dispatchContext, s.question, true)).rejects.toBeInstanceOf(Error)
    expect(firstHTTP).toHaveBeenCalledOnce()
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'tool.result',
      payload: { path: ['callId'], equals: callId } } })).toBe(0)
    const priorState = await readContinuitySupplementState(prisma, s.ctx, s.old.key)
    expect(priorState.kind).toBe(window === 'raw-before-apply' ? 'known_result' : window === 'applied-before-result' ? 'applied' : 'unknown')
    const immutable = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const account = await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })
    const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const startedAt = beforeRun.startedAt ?? beforeRun.createdAt
    const last = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: last.seq + 1, type: 'run.paused', payload: { reason: 'needs_input' } } })
    const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    const pending = { compilationId: s.compilation.id, chapterId: s.chapter.id, revision: s.chapter.revision,
      toolName: 'continuity_validate' as const, callId }
    const claimKeys = ['original-consumed-claim', reviewDispatchKey(pending, pending.toolName)]
    const checkpoint = runCheckpointSchema.parse({ version: 2, controlPolicy: 'until_completion', origin: 'system_default',
      runStartedAt: startedAt.getTime(), activeExecutionMs: recoverRunElapsedMs(startedAt.getTime(), pause.createdAt.getTime(),
        events.map(event => ({ type: event.type, at: event.createdAt.getTime() }))), stagnantBatches: 0, resumeCount: 0, compactionCount: 0,
      maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 1, readBaseline: 0,
      progressSignatures: [], reviewAttempts: claimKeys, pendingReviews: [pending], consumedReviewDecisionFeedback: [],
      inheritedTokens: 0, inheritedTurns: 0, manualResumeCount: 0 })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 1, startedAt,
      usage: { ...(beforeRun.usage as object), checkpoint: JSON.parse(JSON.stringify(checkpoint)) } } })
    const restartHTTP = vi.fn(() => { throw Error('A restarted loop cannot resend this phase') }); vi.stubGlobal('fetch', restartHTTP)
    const critic = vi.spyOn(ai, 'generateTextCompletion').mockRejectedValue(Error('Known or unknown original requests cannot be purchased again'))
    if (window === 'raw-before-apply') {
      // The send was timely. Current expiry does not destroy a known, settled
      // response or turn its free application into a new paid request.
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(s.question.expiresAt) + 1)
    }
    await executeAgentRun({ ...f, prompt, mode: 'build', resume: true, authorContinue: { eventId: pause.id, afterSeq: pause.seq },
      eventStartSeq: pause.seq, modelTier: 'speed', reasoningEffort: 'high', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const restored = runCheckpointSchema.parse((finished.usage as { checkpoint: unknown }).checkpoint)
    expect(restored.reviewAttempts).toEqual(expect.arrayContaining(claimKeys))
    if (window === 'unknown-dispatch') {
      expect(restored.pendingReviews).toEqual([pending])
      expect(finished.status).toBe('paused')
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation).toEqual(s.before.compilation.validation)
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ committedAt: null })
    } else {
      expect(restored.pendingReviews ?? []).toEqual([])
      expect((await readContinuitySupplementState(prisma, s.ctx, s.old.key)).kind).toBe('applied')
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ committedAt: expect.any(Date) })
      expect(finished.status).toBe('completed')
      const audit = ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation as Record<string, unknown>).continuityCriticResponse
      expect(await authenticateSupplementalContinuityReport(prisma, s.ctx, audit)).toBe(true)
    }
    expect(restartHTTP).not.toHaveBeenCalled(); expect(critic).not.toHaveBeenCalled(); expect(s.main).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(fees)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(account)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: immutable.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(immutable)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toEqual(s.chapter)
    expect(finished).toMatchObject({ taskSpec: beforeRun.taskSpec, modelTier: beforeRun.modelTier, reasoningEffort: beforeRun.reasoningEffort })
  }, undefined, prompt, options), 30000)

  it('expires after reservation but before HTTP without fabricating a dispatch or settled result', () => fixture(async f => {
    const s = await originalFailure(f); await s.approve()
    const reserve = credits.reserveTokenCredits
    const reserved = vi.spyOn(credits, 'reserveTokenCredits').mockImplementation(async (...args) => {
      const result = await reserve(...args)
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(s.question.expiresAt) + 1))
      return result
    })
    const network = vi.fn(() => { throw Error('Expired phase cannot reach HTTP') }); vi.stubGlobal('fetch', network)
    try {
      const result = await s.invoke('expires-after-reserve')
      expect(result).toMatchObject({ part: { status: 'failed' }, failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
      expect(result.observation).toContain('授权已到期')
      expect(reserved).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled(); expect(s.main).not.toHaveBeenCalled()
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(4)
      const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
      expect(fee).toMatchObject({ billingSnapshot: price, requestTokens: null, responseTokens: null, creditChargeMilli: 0,
        usageSource: 'unknown', billingStatus: 'not_dispatched', reservedCreditMilli: 0 })
      expect(await prisma.creditLedgerEntry.count({ where: { idempotencyKey: `usage:${fee.id}` } })).toBe(0)
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId,
        metadata: { path: ['continuitySupplementDispatch', 'requestId'], equals: s.question.requestId } } })).toBe(0)
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId,
        metadata: { path: ['continuitySupplementResponse', 'requestId'], equals: s.question.requestId } } })).toBe(0)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation).toEqual(s.before.compilation.validation)
      await s.unchangedOriginal()
    } finally { vi.useRealTimers() }
  }, undefined, prompt, options), 30000)

  it('a new owner resumes the same proven-unsent claim for its first physical request exactly once', () => fixture(async f => {
    const s = await originalFailure(f); await s.approve()
    const plan = s.question.frozen.input.continuityManifest!.typedLineage!.phasePlan
    const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 1, type: 'tool.call',
      payload: { callId: 'crashed-before-preparation', toolName: 'continuity_validate', args: { compilationId: s.compilation.id } } } })
    expect(await prisma.$transaction(tx => claimContinuityPhase(tx, s.ctx, { plan, chapterId: s.chapter.id, phase: 'full_reassessment',
      operationRef: s.old.key, inputHash: runtimeJson(s.question.frozen.input).hash, ownerEpoch: String(s.ctx.continuityOwnerSeq) }))).toBe(true)
    const claim = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId,
      metadata: { path: ['continuityPhaseClaim', 'phase'], equals: 'full_reassessment' } } })
    const ownerSeq = tail.seq + 2
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: ownerSeq, type: 'run.started', payload: { type: 'run.started', seq: ownerSeq } } })
    expect((await readContinuitySupplementState(prisma, { ...s.ctx, continuityOwnerSeq: ownerSeq }, s.old.key)).kind).toBe('authorized')
    const raw = JSON.stringify(wireFor(s.question, 'unknown'))
    const network = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } }))); vi.stubGlobal('fetch', network)
    expect(await s.invoke('first-physical-send-after-restart', true, ownerSeq)).toMatchObject({ reviewCompleted: true, part: { status: 'success' } })
    await s.invoke('another-continue-after-first-send', true, ownerSeq)
    expect(network).toHaveBeenCalledOnce()
    expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: claim.id } })).toEqual(claim)
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId,
      metadata: { path: ['continuityPhaseClaim', 'phase'], equals: 'full_reassessment' } } })).toBe(1)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(4)
    const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
    await assertSupplementSettlement(f.userId, s.compilation.id, fee)
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['duplicate-current-owner', 'late-old-owner'] as const)(
    'fences %s before usage creation while the legitimate original phase completes once', race => fixture(async f => {
    const s = await originalFailure(f); await s.approve()
    const plan = s.question.frozen.input.continuityManifest!.typedLineage!.phasePlan
    const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
    const oldOwner = tail.seq + 2, currentOwner = oldOwner + 1, oldCallId = 'old-owner-before-usage'
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 1, type: 'tool.call',
      payload: { callId: oldCallId, toolName: 'continuity_validate', args: { compilationId: s.compilation.id } } } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: oldOwner, type: 'run.started', payload: { type: 'run.started', seq: oldOwner } } })
    const oldContext = { ...s.ctx, callId: oldCallId, continuityOwnerSeq: oldOwner,
      continuitySupplement: { requestId: s.question.requestId, dispatchAllowed: true } }
    const latch = () => {
      let open!: () => void
      const wait = new Promise<void>(resolve => { open = resolve })
      return { open, wait }
    }
    const first = latch(), second = latch(), inFlight: Array<Promise<unknown>> = []
    let runtimeEntries = 0
    // This route lookup is after the real claim/execution transaction and
    // before generateTextCompletion creates any usage row. A fetch latch
    // would miss the orphan-usage race entirely.
    const runtimeGate = vi.spyOn(credits, 'getModelTierRuntime').mockClear().mockImplementation(async () => {
      const ordinal = ++runtimeEntries
      if (ordinal === 1) await first.wait
      if (race === 'late-old-owner' && ordinal === 2) await second.wait
      return runtime
    })
    const raw = JSON.stringify(wireFor(s.question, 'unknown'))
    const network = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } }))); vi.stubGlobal('fetch', network)
    const execute = (callId: string, ownerSeq: number) => {
      const result = Promise.allSettled([executeContinuitySupplementTool({ ...s.ctx, callId, continuityOwnerSeq: ownerSeq,
        continuitySupplement: { requestId: s.question.requestId, dispatchAllowed: true } }, { compilationId: s.compilation.id })])
      inFlight.push(result)
      return result
    }
    try {
      let oldResult: ReturnType<typeof execute> | undefined
      if (race === 'late-old-owner') {
        oldResult = execute(oldContext.callId, oldOwner)
        await vi.waitFor(() => expect(runtimeEntries).toBe(1), { timeout: 5000 })
      } else expect(await prisma.$transaction(tx => claimContinuityPhase(tx, oldContext, { plan, chapterId: s.chapter.id,
        phase: 'full_reassessment', operationRef: s.old.key, inputHash: runtimeJson(s.question.frozen.input).hash, ownerEpoch: String(oldOwner) }))).toBe(true)
      const claim = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId,
        metadata: { path: ['continuityPhaseClaim', 'phase'], equals: 'full_reassessment' } } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: currentOwner, type: 'run.started', payload: { type: 'run.started', seq: currentOwner } } })
      const currentCall = 'legitimate-current-owner', duplicateCall = 'duplicate-current-owner'
      for (const [index, callId] of [currentCall, duplicateCall].entries()) await prisma.agentRunEvent.create({ data: {
        runId: f.runId, seq: currentOwner + index + 1, type: 'tool.call',
        payload: { callId, toolName: 'continuity_validate', args: { compilationId: s.compilation.id } } } })
      const currentResult = execute(currentCall, currentOwner)
      await vi.waitFor(() => expect(runtimeEntries).toBe(race === 'late-old-owner' ? 2 : 1), { timeout: 5000 })
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(3)
      expect(network).not.toHaveBeenCalled()
      if (race === 'duplicate-current-owner') {
        const duplicate = await execute(duplicateCall, currentOwner)
        expect(duplicate).toMatchObject([{ status: 'rejected', reason: { code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' } }])
        expect(runtimeGate).toHaveBeenCalledOnce()
      } else {
        // Release the old worker first, while the legitimate current worker
        // still waits before preparation. It must not capture the binding.
        first.open()
        expect(await oldResult).toMatchObject([{ status: 'rejected', reason: { code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' } }])
      }
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(3)
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId,
        metadata: { path: ['continuitySupplementUsage', 'requestId'], equals: s.question.requestId } } })).toBe(0)
      expect(network).not.toHaveBeenCalled()
      first.open(); second.open()
      expect(await currentResult).toMatchObject([{ status: 'fulfilled', value: { reviewCompleted: true, reviewOutcome: 'decision_required' } }])
      expect(network).toHaveBeenCalledOnce()
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(4)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId, billingStatus: 'not_dispatched' } })).toBe(0)
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: claim.id } })).toEqual(claim)
      const executions = await prisma.agentArtifact.findMany({ where: { runId: f.runId,
        metadata: { path: ['continuitySupplementExecution', 'ownerSeq'], equals: currentOwner } } })
      expect(executions).toHaveLength(1)
      expect(executions[0].metadata).toMatchObject({ continuitySupplementExecution: { requestId: s.question.requestId,
        requestHash: s.question.requestHash, ownerSeq: currentOwner, callId: currentCall, inputHash: runtimeJson(s.question.frozen.input).hash } })
      const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
      expect(fee).toMatchObject({ billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0 })
      await assertSupplementSettlement(f.userId, s.compilation.id, fee)
      const bindings = await prisma.agentArtifact.findMany({ where: { runId: f.runId,
        metadata: { path: ['continuitySupplementUsage', 'requestId'], equals: s.question.requestId } } })
      expect(bindings).toHaveLength(1)
      expect(bindings[0].metadata).toMatchObject({ continuitySupplementUsage: { executionId: executions[0].id, usageId: fee.id } })
      await s.unchangedOriginal()
    } finally {
      first.open(); second.open()
      await Promise.allSettled(inFlight)
    }
  }, undefined, prompt, options), 30000)
})
