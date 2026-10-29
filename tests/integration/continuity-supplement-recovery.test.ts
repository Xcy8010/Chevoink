import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { terminalInputDecisionFixture } from '../helpers/terminal-input-decision-fixture.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readLegacyContinuityAssessment, bindLegacyContinuityAssessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { buildContinuitySnapshot, reviewContinuity, type ContinuityReport } from '../../api/lib/agent/continuity-review.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { continueCurrentReviewWorkflow } from '../support/current-review-recovery-workflow.js'
import { persistHistoricalContinuityAudit, persistHistoricalCommittedBridge } from '../support/historical-continuity-audit.js'
import * as historyFixtures from '../support/historical-continuity-audit.js'
import { assertContinuityOwner } from '../../api/lib/agent/continuity-coordinator.js'
import * as coordinator from '../../api/lib/agent/continuity-coordinator.js'
import { runCheckpointSchema } from '../../api/lib/agent/checkpoint.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { advanceTerminalCoverage } from '../../api/lib/agent/terminal-fact-coverage.js'
import * as terminalCoverage from '../../api/lib/agent/terminal-fact-coverage.js'
import { readAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { buildTerminalFactProofs } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { qualityNeighborContext } from '../../api/lib/agent/quality-neighbor-context.js'
import * as storyCompiler from '../../api/lib/agent/story-compiler.js'
import * as humanityQuality from '../../api/lib/agent/humanity-quality.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'

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
const inheritedClaim = 'A synthetic historical obligation remains unverified.'

// An independently supported synthetic prologue supplies the omitted fact.
// Its older contract needs no paid-assessment receipt; the original task keeps
// its frozen first-chapter target and never acquires authority over the prologue.
type LegacyPredecessorStore = Pick<typeof prisma, 'chapter' | 'agentRun' | 'agentMessage' | 'storyCompilation' | 'aiUsageLog'>
async function seedLegacyCoveragePredecessor(f: Fixture, target: { volumeId: string }, db: LegacyPredecessorStore = prisma) {
  const chapter = await db.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: target.volumeId,
    title: 'Synthetic prologue', orderIndex: 0, orderInVolume: 0, revision: 1, content: inheritedClaim, wordCount: inheritedClaim.length } })
  const runId = randomUUID(), sourcePrompt = '修改本章'
  const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: chapter.id, prompt: sourcePrompt,
    continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 })
  await db.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
    chapterId: chapter.id, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
    // Match ordinary admission: optional fields in a newly built TaskSpec can
    // be undefined; persist its JSON representation before hashing/validation.
    runtimeProtocolVersion: 0, taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value, startRequest: { prompt: sourcePrompt } } })
  await db.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: sourcePrompt }] } })
  const subject = { userId: f.userId, novelId: f.novelId, runId }
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: [inheritedClaim] } })
  const { compilation } = await prepareStoryCompilation({ ...subject, chapterId: chapter.id, mode: 'balanced', intentSummary: sourcePrompt })
  await saveSceneTasks({ ...subject, compilationId: compilation.id, tasks: [{ purpose: 'Record the synthetic fact', entryState: candidate.exitState,
    goal: 'Record', obstacle: 'Time', choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState,
    styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  const saved = await db.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
  const evidence = terminalEvidenceContext(chapter, null, 2, 1, undefined, 6, 2)
  const inspected = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({
    kind, result: 'clear', reason: 'Independent synthetic prologue review.', findingIndexes: [] })),
    terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [] }),
    { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
  expect(inspected.complete).toBe(true)
  await persistHistoricalContinuityAudit({ ...subject, compilationId: compilation.id, expectedChapterRevision: chapter.revision,
    terminalCandidate: candidate, independentCheck: 'complete', findings: [], continuityCriticResponse: inspected.audit,
    coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null, terminalCandidate: candidate }, 11) })
  await persistHumanityQualityReport({ ...subject, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision,
    mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
  await persistHistoricalCommittedBridge(compilation.id)
  expect(await db.aiUsageLog.count({ where: { agentRunId: runId } })).toBe(0)
  return chapter
}

async function originalFailure(f: Fixture, conflict = false, qualityReady = false, pendingFact = false, originalPrompt = prompt,
  draftField: 'emotion' | 'knowledge' = 'emotion', legacyReceipt = false) {
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ ...price, rateCardId: 'new-admin-price-must-not-replace-original' })
  const main = vi.spyOn(ai, 'chatWithTools').mockRejectedValue(Error('No main-model turn is authorized by this phase'))
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0,
    taskRootId: null, startRequest: { prompt: originalPrompt }, modelTier: 'speed', reasoningEffort: 'high',
    usage: { promptTokens: 36, completionTokens: 24, totalTokens: 60, checkpoint: { reviewAttempts: ['original-consumed-claim'] } } } })
  const content = (conflict ? 'The packet remains sealed. The packet is open. The table remains dry.' : 'The packet remains sealed. The table remains dry.')
    + (pendingFact ? ' A reply remains pending.' : '')
  const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 4, content, wordCount: content.length } })
  const predecessor = legacyReceipt ? await seedLegacyCoveragePredecessor(f, chapter) : null
  const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: originalPrompt })
  const state = { knowledge: [], emotion: [], body: [], objects: ['The packet remains sealed.'], relationships: [], openLoops: [] }
  await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inventory', entryState: state, goal: 'Read', obstacle: 'Time',
    choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: chapter.revision })
  const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
  if (predecessor) {
    expect(source).toMatchObject({ id: predecessor.id, preceding: [expect.objectContaining({ id: predecessor.id, orderIndex: 0 })],
      terminalInheritance: [expect.objectContaining({ field: 'knowledge', claim: inheritedClaim, depth: 1 })] })
  }
  const draft = terminalDraftFixture(pendingFact ? 'openLoops' : draftField, { chapter, taskId: f.spec.id, ctx: f, compilationId: compilation.id,
    candidate: terminalDraftFixture().candidate, source,
    originBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source,
      terminalCandidate: terminalDraftFixture(pendingFact ? 'openLoops' : draftField).base }, 11)).hash,
    currentBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source,
      terminalCandidate: terminalDraftFixture().candidate }, 11)).hash })
  const inherited = { id: terminalFactId('knowledge', inheritedClaim), field: 'knowledge' as const, claim: inheritedClaim }
  const originInput = draft.input
  const currentContext = terminalEvidenceContext(chapter, source, 2, 1,
    terminalCoverage.terminalCoverageInput(f.spec, saved.preparedContext, chapter, draft.base, 2, terminalCoverage.terminalCoverageProofs(source, 2)), 6, 2)
  expect(runtimeJson(originInput.bodies.terminalEvidence).hash).toBe(runtimeJson(currentContext).hash)
  if (legacyReceipt) expect(currentContext.factCoverage?.obligations).toEqual([inherited])
  const baseWire = pendingFact ? { ...draft.originWire, terminalVerdicts: [{ claimIndex: 0, verdict: 'supported',
    sourceEvidence: [{ segmentId: 'c0', quote: 'A reply remains pending.' }] }] } : draft.originWire
  const originWire = legacyReceipt ? { ...baseWire, terminalDispositions: [{ obligationIndex: 0, outcome: 'unknown',
    reason: 'The prior obligation remains independently unverified.', sourceEvidence: [] }] } : baseWire
  const originCall = legacyReceipt ? 'origin-legacy' : 'origin'
  if (legacyReceipt) draft.add(originCall, originInput, originWire)
  const originInspection = draft.inspect(originWire, originInput)
  const originBound = bindLegacyContinuityAssessment(originInspection, { ...draft.ctx, callId: originCall }, originInput)
  const originState = pendingFact ? advanceTerminalCoverage(f.spec, {}, chapter,
    readAuthenticatedContinuityAssessment(originBound.audit, chapter.content, originInput.bodies.terminalEvidence, true)!, originInput.bodies.terminalEvidence!.factCoverage) : undefined
  const preparedContext = { ...(saved.preparedContext as Record<string, unknown>), ...(pendingFact ? {} : draft.preparedContext),
    ...(pendingFact ? { terminalFactCoverage: legacyReceipt ? { ...originState!, facts: originState!.facts.filter(fact => fact.id !== inherited.id) } : originState } : {}) }
  const old = terminalInputDecisionFixture({ runId: f.runId, taskSpec: f.spec, chapter, compilationId: compilation.id,
    bridge: saved.bridge, scenes: saved.sceneTasks, source, preparedContext, proposals: pendingFact ? undefined : draft.nextContext.proposalChanges })
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
  for (const metadata of [...draft.rows.filter(row => row.id.startsWith(originCall + '-')).map(row => ({ ...row.metadata,
    ...(pendingFact && !legacyReceipt && row.metadata.stage === 'first' ? { audit: originInspection.audit, response: { content: JSON.stringify(JSON.stringify(originWire)),
      encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } } : {}) })), ...old.metadata]) {
    const next: Record<string, unknown> = { ...metadata }
    if (Array.isArray(next.usageIds)) next.usageIds = next.usageIds.map(id => usageIds.get(String(id) === 'usage-origin-legacy' ? 'usage-origin' : String(id))!)
    await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Synthetic original evidence',
      content: 'Synthetic original evidence.', metadata: runtimeJson(next).value } })
  }
  const ctx: ToolContext = { ...f, callId: old.callId, continuityOwnerSeq: 3, signal: new AbortController().signal,
    mode: 'build', qualityMode: 'balanced', creativeFreedom: 'balanced', modelRuntime: runtime, emit: () => {} }
  const received = await prisma.$transaction(tx => readLegacyContinuityAssessment(tx, ctx, old.frozen))
  expect(received).toMatchObject({ recoveryReady: true, billingKnown: true, providerComplete: true, inspected: { complete: false } })
  const bound = bindLegacyContinuityAssessment(received.inspected, ctx, old.frozen)
  await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { preparedContext: runtimeJson(preparedContext).value } })
  await persistHistoricalContinuityAudit({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision,
    terminalCandidate: old.candidate, independentCheck: 'unavailable', findings: [], coverage: old.coverage, continuityCriticResponse: bound.audit })
  if (qualityReady) await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id,
    chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
  await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', payload: { callId: old.callId,
    toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' } } })
  await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.started', payload: { type: 'run.started', seq: 3 } } })
  // Explicit closed historical question bytes are data, never a current grant.
  const question = { requestId: runtimeJson({ oldKey: old.key }).hash, callId: 'retired-question', expiresAt: new Date(1).toISOString(),
    accept: 'Original exact approval', reject: 'Original exact rejection', frozen: { input: old.frozen, model: runtime, price } }
  await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Closed pre-refactor question',
    content: 'Frozen historical question; no current execution authority.', metadata: runtimeJson({ historyOnly: true, retiredQuestion: question }).value } })
  const before = {
    artifacts: await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } }),
    usage: await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
    ledger: await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
    run: await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } }),
    compilation: await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }),
  }
  const unchangedOriginal = async () => {
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: before.artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before.artifacts)
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: before.usage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before.usage)
    expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: before.ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before.ledger)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(run).toMatchObject({ taskSpec: before.run.taskSpec, modelTier: before.run.modelTier,
      reasoningEffort: before.run.reasoningEffort, customModelId: before.run.customModelId })
  }
  return { ctx, chapter, compilation, old, question, before, main, unchangedOriginal, inherited }
}

it('serializes the complete synthetic predecessor seed before mocked persistence and binds coverage without erasing the legacy ledger difference', async () => {
  // Invoke the very same seed as PostgreSQL coverage, checking its actual
  // payloads before mocked persistence. This is no claim of database acceptance.
  const prologue = { id: 'synthetic-prologue', title: 'Synthetic prologue', revision: 1, orderIndex: 0, orderInVolume: 0,
    content: inheritedClaim, volumeId: 'volume', authorId: 'owner', novelId: 'novel', wordCount: inheritedClaim.length }
  const chapterWrite = vi.fn<typeof prisma.chapter.create>().mockResolvedValue(prologue as Awaited<ReturnType<typeof prisma.chapter.create>>)
  const runWrite = vi.fn<typeof prisma.agentRun.create>().mockResolvedValue({} as Awaited<ReturnType<typeof prisma.agentRun.create>>)
  const messageWrite = vi.fn<typeof prisma.agentMessage.create>().mockResolvedValue({} as Awaited<ReturnType<typeof prisma.agentMessage.create>>)
  const prepare = vi.spyOn(storyCompiler, 'prepareStoryCompilation').mockResolvedValue({ compilation: { id: 'synthetic-prologue-compilation' } } as Awaited<ReturnType<typeof prepareStoryCompilation>>)
  const scenes = vi.spyOn(storyCompiler, 'saveSceneTasks').mockResolvedValue([])
  const compilationRead = vi.fn<typeof prisma.storyCompilation.findUniqueOrThrow>().mockResolvedValue({ id: 'synthetic-prologue-compilation', bridge: null, sceneTasks: [] } as unknown as Awaited<ReturnType<typeof prisma.storyCompilation.findUniqueOrThrow>>)
  const validate = vi.spyOn(historyFixtures, 'persistHistoricalContinuityAudit').mockResolvedValue({} as Awaited<ReturnType<typeof persistHistoricalContinuityAudit>>)
  const quality = vi.spyOn(humanityQuality, 'persistHumanityQualityReport').mockResolvedValue({} as Awaited<ReturnType<typeof persistHumanityQualityReport>>)
  const commit = vi.spyOn(historyFixtures, 'persistHistoricalCommittedBridge').mockResolvedValue(undefined)
  const usage = vi.fn<typeof prisma.aiUsageLog.count>().mockResolvedValue(0)
  const f = { userId: 'owner', novelId: 'novel', sessionId: 'session' } as Fixture
  // Prisma delegates are proxies: spying on them can restore an undefined
  // method and break later real PostgreSQL fixtures. Keep this store private.
  const db = { chapter: { create: chapterWrite }, agentRun: { create: runWrite }, agentMessage: { create: messageWrite },
    storyCompilation: { findUniqueOrThrow: compilationRead }, aiUsageLog: { count: usage } } as unknown as LegacyPredecessorStore
  expect(await seedLegacyCoveragePredecessor(f, prologue, db)).toEqual(prologue)
  expect(compilationRead).toHaveBeenCalledOnce()
  for (const method of [prisma.chapter.create, prisma.agentRun.create, prisma.agentMessage.create,
    prisma.storyCompilation.findUniqueOrThrow, prisma.aiUsageLog.count]) {
    expect(typeof method).toBe('function')
    expect(vi.isMockFunction(method)).toBe(false)
  }
  for (const operation of [chapterWrite, runWrite, messageWrite, prepare, scenes, validate, quality, commit]) expect(operation).toHaveBeenCalledOnce()
  expect(usage).toHaveBeenCalledOnce()
  for (const payload of [chapterWrite.mock.calls[0][0].data, runWrite.mock.calls[0][0].data, messageWrite.mock.calls[0][0].data,
    prepare.mock.calls[0][0], scenes.mock.calls[0][0], validate.mock.calls[0][0], quality.mock.calls[0][0], commit.mock.calls[0][0]]) {
    expect(() => runtimeJson(payload)).not.toThrow()
  }
  const persisted = runWrite.mock.calls[0][0].data
  const savedSpec = taskSpecSchema.parse(persisted.taskSpec)
  expect(savedSpec).toMatchObject({ runId: persisted.id, goals: ['修改本章'], scope: { novelId: f.novelId,
    chapterIds: [prologue.id], continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 } })
  expect(persisted.taskSpec).not.toHaveProperty('scope.selection')
  expect(persisted.taskSpec).not.toHaveProperty('scope.terminalCoverageProtocol')
  expect(savedSpec.runId).toBeDefined()
  const unpersisted = buildTaskSpec({ runId: savedSpec.runId!, novelId: f.novelId, chapterId: prologue.id, prompt: '修改本章',
    continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 })
  expect(unpersisted.scope).toHaveProperty('selection', undefined)
  expect(() => runtimeJson(unpersisted)).toThrow(expect.objectContaining({ code: 'RUNTIME_INPUT_INVALID' }))
  const report = validate.mock.calls[0][0]
  const candidate = terminalCandidateSchema.parse(report.terminalCandidate)
  const audit = report.continuityCriticResponse as ReturnType<typeof inspectContinuityResponse>['audit']
  const evidence = terminalEvidenceContext(prologue, null, 2, 1, undefined, 6, 2)
  expect(runtimeJson(audit.terminalEvidence).hash).toBe(runtimeJson(evidence).hash)
  const review = readAuthenticatedContinuityAssessment(audit, prologue.content, evidence, true)!
  expect(review).not.toBeNull()
  const { content: previous, ...neighbor } = qualityNeighborContext([prologue])[0]
  const source = { id: prologue.id, revision: prologue.revision, content: previous,
    scope: 'current_and_previous_3_bounded' as const, targetOrderIndex: 1,
    preceding: [{ ...neighbor, joinedStart: 0, joinedEnd: previous.length }], bridgeSource: prologue,
    terminalInheritance: buildTerminalFactProofs({ compilationId: 'synthetic-prologue-compilation', chapter: prologue,
      validation: { checkedChapterId: prologue.id, checkedRevision: prologue.revision, terminalCandidate: candidate,
        independentCheck: 'complete', continuityCriticResponse: audit, coverage: report.coverage },
      stateHash: 'a'.repeat(64), evidence, review }) }
  expect(source.terminalInheritance).toMatchObject([{ field: 'knowledge', claim: inheritedClaim, depth: 1 }])
  const chapter = { id: 'chapter', title: 'Synthetic current', revision: 4, orderIndex: 1,
    content: 'The packet remains sealed. A reply remains pending.' }
  const spec = { id: 'task', scope: { terminalCoverageProtocol: 2 } }
  const draft = terminalDraftFixture('openLoops', { chapter, taskId: spec.id,
    ctx: { userId: 'owner', novelId: 'novel', runId: 'run' }, compilationId: 'compilation', source,
    candidate: terminalDraftFixture().candidate, originBindingHash: 'b'.repeat(64), currentBindingHash: 'c'.repeat(64) })
  const context = terminalEvidenceContext(chapter, source, 2, 1,
    terminalCoverage.terminalCoverageInput(spec, {}, chapter, draft.base, 2, terminalCoverage.terminalCoverageProofs(source, 2)), 6, 2)
  expect(runtimeJson(draft.input.bodies.terminalEvidence).hash).toBe(runtimeJson(context).hash)
  expect(draft.input.bodies.previous).toBe(prologue.content)
  expect(draft.input.sourceScope?.previous).toEqual([{ orderIndex: 0, startOffset: 0, endOffset: prologue.content.length }])
  const bound = draft.inspect({ ...draft.originWire, terminalVerdicts: [{ claimIndex: 0, verdict: 'supported',
    sourceEvidence: [{ segmentId: 'c0', quote: 'A reply remains pending.' }] }] }, draft.input)
  const origin = readAuthenticatedContinuityAssessment(bound.audit, chapter.content, context, true)!
  expect(bound.complete).toBe(true); expect(origin).not.toBeNull()
  const modern = terminalCoverage.advanceTerminalCoverage(spec, {}, chapter, origin, context.factCoverage)!
  const legacy = terminalCoverage.replayLegacyTerminalCoverageReceipt(spec, {}, chapter, origin, context.factCoverage!)!
  const inherited = { id: terminalFactId('knowledge', inheritedClaim), field: 'knowledge', claim: inheritedClaim }
  expect(modern.facts).toContainEqual(inherited); expect(legacy.facts).not.toContainEqual(inherited)
  for (const state of [modern, legacy]) {
    const old = terminalInputDecisionFixture({ runId: 'run', taskSpec: spec, chapter, compilationId: 'compilation',
      bridge: null, scenes: [], source, preparedContext: { terminalFactCoverage: state } })
    const actual = terminalEvidenceContext(chapter, source, 2, 1,
      terminalCoverage.terminalCoverageInput(spec, { terminalFactCoverage: state }, chapter, old.candidate, 2,
        terminalCoverage.terminalCoverageProofs(source, 2)), 6, 2)
    expect(runtimeJson(old.frozen.bodies.terminalEvidence).hash).toBe(runtimeJson(actual).hash)
    expect(old.context.factCoverage?.obligations).toContainEqual(inherited)
    expect(old.frozen.bodies.previous).toBe(prologue.content)
  }
  const missingSource = terminalEvidenceContext(chapter, null, 2, 1, terminalCoverage.terminalCoverageInput(spec, {}, chapter, draft.base, 2), 6, 2)
  expect(runtimeJson(missingSource).hash).not.toBe(runtimeJson(context).hash)
  // Exercise the same restoration that runs before the real PG cases.
  vi.restoreAllMocks()
  for (const method of [prisma.chapter.create, prisma.agentRun.create, prisma.agentMessage.create,
    prisma.storyCompilation.findUniqueOrThrow, prisma.aiUsageLog.count]) {
    expect(typeof method).toBe('function')
    expect(vi.isMockFunction(method)).toBe(false)
  }
})


type Existing = Awaited<ReturnType<typeof originalFailure>>
async function pauseCurrent(f: Fixture, s: Existing, pending: Array<{ compilationId: string; chapterId: string; revision: number; toolName: 'continuity_validate'; callId: string }> = []) {
  const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
  const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: tail.seq + 1, type: 'run.paused', payload: { reason: 'needs_input' } } })
  const checkpoint = runCheckpointSchema.parse({ version: 2, controlPolicy: 'until_completion', origin: 'system_default',
    runStartedAt: s.before.run.createdAt.getTime(), activeExecutionMs: 100, stagnantBatches: 7, resumeCount: 0, compactionCount: 0,
    maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0, progressSignatures: [],
    reviewAttempts: ['original-consumed-claim'], pendingReviews: pending, consumedReviewDecisionFeedback: ['old-feedback'],
    inheritedTokens: 60, inheritedTurns: 16, manualResumeCount: 0 })
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 16, startedAt: s.before.run.createdAt,
    usage: runtimeJson({ ...(s.before.run.usage as object), checkpoint }).value } })
  return pause
}
function currentProvider(kind: 'complete' | 'unknown' | 'conflict' | 'invalid' | 'dispatch-unknown' = 'complete', during?: () => Promise<void>) {
  let physical = 0
  const network = vi.fn(async (_url: unknown, init?: RequestInit) => {
    physical++
    const request = JSON.parse(String(init?.body))
    expect(request.model).toBe(runtime.modelName)
    const payload = JSON.parse(request.messages[1].content)
    const actual = payload.sources.find((source: { source: string }) => source.source === 'current')
    const sourceId = /^q[a-f0-9]{12}/m.exec(actual.evidence)![0]
    expect(sourceId).toHaveLength(13)
    if (kind === 'dispatch-unknown') throw Error('Synthetic response lost after dispatch')
    await during?.()
    const content = kind === 'invalid' && physical > 1 ? '{"corrections":[]}' : JSON.stringify({ findings: kind === 'complete' ? [] : [{ signal: 'object',
      severity: kind === 'unknown' ? 'warning' : 'error', explanation: kind === 'unknown' ? 'This opinion remains uncertain for the author.' : 'The packet state requires author judgment.',
      suggestion: 'Keep the original opinion until its premise is resolved.', evidence: [{ sourceId: kind === 'invalid' ? 'q000000000000' : sourceId }] }] })
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', network)
  return network
}
async function currentReport(s: Existing) {
  return ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation as { continuityReport?: ContinuityReport }).continuityReport
}
async function assertNewSettlement(f: Fixture, s: Existing, count = 1) {
  const added = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
  expect(added).toHaveLength(count)
  for (const row of added) {
    expect(row).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, requestTokens: 12, responseTokens: 8 })
    expect(await prisma.creditLedgerEntry.count({ where: { idempotencyKey: `usage:${row.id}` } })).toBe(1)
  }
  const charge = added.reduce((sum, row) => sum + row.creditChargeMilli, 0)
  expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(3 * chargeMilli + charge)
}
const readOnly = (s: Existing, extra: Partial<ToolContext> = {}) => ({ ...s.ctx, sandboxMode: 'read_only' as const, ...extra })

describe.runIf(available)('historical supplemental records and ordinary current review recovery', () => {
  it.each(['same-owner', 'new-owner-expired'] as const)('%s retains frozen report bytes while current checks ignore retired slots', scenario => fixture(async f => {
    const s = await originalFailure(f)
    if (scenario === 'new-owner-expired') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', payload: { resumed: true } } })
    const network = currentProvider(), ctx = readOnly(s)
    expect(await continuityValidateTool.execute(ctx, { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    const report = await currentReport(s)
    expect(report).toMatchObject({ complete: true, revision: 4, rawResponses: ['{"findings":[]}'] })
    expect(await continuityValidateTool.execute({ ...ctx, callId: 'current-cache' }, { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    expect(await currentReport(s)).toEqual(report); expect(network).toHaveBeenCalledOnce()
    expect(coordinator).not.toHaveProperty('executeContinuitySupplement'); await assertNewSettlement(f, s); await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each([false, true] as const)('retains actual current opinions and commits once with legacy decisionOnly=%s metadata', decisionOnly => fixture(async f => {
    const s = await originalFailure(f, true, true), network = currentProvider('conflict'), ctx = readOnly(s)
    expect(await continuityValidateTool.execute(ctx, { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    const readiness = await readChapterReviewReadiness(prisma, f, s.compilation.id)
    expect(readiness).toMatchObject({ continuity: 'complete', decisionPending: true })
    expect(await chapterBridgeCommitTool.execute(s.ctx, { compilationId: s.compilation.id })).toMatchObject({ outcome: 'failed' })
    const retainedFindings = readiness!.requiredDecisions!.map(item => ({ ...item, reason: 'Retain the actual packet opinion for the author without claiming it was repaired.' }))
    const input = chapterBridgeCommitTool.parameters.parse({ compilationId: s.compilation.id, decisionOnly, retainedFindings })
    expect(await chapterBridgeCommitTool.execute(s.ctx, input)).not.toMatchObject({ outcome: 'failed' })
    const bridge = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })
    expect(bridge.committedAt).toBeInstanceOf(Date)
    expect(await chapterBridgeCommitTool.execute({ ...s.ctx, callId: 'repeat-real-commit' }, input)).not.toMatchObject({ outcome: 'failed' })
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { id: bridge.id } })).toEqual(bridge)
    expect(network).toHaveBeenCalledOnce(); await assertNewSettlement(f, s); await s.unchangedOriginal()
  }, undefined, prompt, { ...options, reviewProtocol: 1 }), 30000)

  it('requires current reports and preserves canonical bridge state during the one actual commit', () => fixture(async f => {
    const s = await originalFailure(f, false, true)
    expect(await chapterBridgeCommitTool.execute(s.ctx, { compilationId: s.compilation.id })).toMatchObject({ outcome: 'failed' })
    const network = currentProvider()
    expect(await continuityValidateTool.execute(readOnly(s), { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    const before = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })
    const args = { compilationId: s.compilation.id, chapterSummary: 'Current saved chapter.' }
    expect(await chapterBridgeCommitTool.execute(s.ctx, args)).not.toMatchObject({ outcome: 'failed' })
    const committed = await prisma.chapterBridge.findUniqueOrThrow({ where: { id: before.id } })
    expect(committed).toMatchObject({ committedAt: expect.any(Date), targetRevision: 4, objectState: before.objectState, knowledgeState: before.knowledgeState })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).preparedContext).not.toHaveProperty('terminalFactProofs')
    expect(await chapterBridgeCommitTool.execute(s.ctx, args)).not.toMatchObject({ outcome: 'failed' })
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { id: before.id } })).toEqual(committed)
    expect(network).toHaveBeenCalledOnce(); await s.unchangedOriginal()
  }, undefined, prompt, { ...options, reviewProtocol: 1 }), 30000)

  it.each(['current', 'legacy'] as const)('preserves %s historical coverage while current evidence invalidates on predecessor changes', scenario => fixture(async f => {
    const s = await originalFailure(f, true, true, true, '修改第一章', 'emotion', scenario === 'legacy')
    await persistCurrentContinuityReport({ ...f, compilationId: s.compilation.id })
    const report = await currentReport(s)
    expect(report!.sourceVersions!.some(source => source.chapterId === s.chapter.id)).toBe(true)
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })
    if (scenario === 'legacy') {
      const predecessor = await prisma.chapter.findFirstOrThrow({ where: { authorId: f.userId, novelId: f.novelId, orderIndex: 0 } })
      expect(report!.sourceVersions!.some(source => source.chapterId === predecessor.id && source.revision === predecessor.revision)).toBe(true)
      await prisma.chapter.update({ where: { id: predecessor.id }, data: { content: predecessor.content + ' Actual author correction.' } })
    } else await prisma.chapter.update({ where: { id: s.chapter.id }, data: { revision: { increment: 1 }, content: s.chapter.content + ' Actual author correction.' } })
    expect(await chapterBridgeCommitTool.execute(s.ctx, { compilationId: s.compilation.id })).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_CHECK_REQUIRED' })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).toEqual(before)
    await s.unchangedOriginal()
  }, undefined, '修改第一章', options), 30000)

  it.each((['approve-in-loop', 'paused-accepted-new-owner', 'known-normalized-decision', 'applied-normalized-current-decisions', 'applied-normalized-current-decisions-direct', 'applied-normalized-current-decisions-legacy-metadata'] as const)
    .flatMap(scenario => (['only-prose', 'default'] as const).flatMap(outputMode =>
      Array.from({ length: scenario.startsWith('applied-normalized-current-decisions') && outputMode === 'default' ? 3 : 1 }, (_, index) =>
        ({ scenario, outputMode, replica: index + 1, requestPrompt: outputMode === 'default' ? '修改第一章' : prompt })))))(
    '$scenario/$outputMode/replica-$replica resumes current review, real body CAS, final reports, exact decisions and one commit', ({ scenario, outputMode, replica, requestPrompt }) => fixture(async f => {
    const applied = scenario.startsWith('applied-normalized-current-decisions')
    const s = await originalFailure(f, scenario.includes('decision'), true, applied, requestPrompt)
    if (applied) {
      const manuscript = ['The packet remains sealed.', 'The table remains dry.', 'The clerk places his pen beside the ledger.',
        'Rain taps against the shutter.', 'A cart rattles past the courtyard.', 'The guard hangs his coat on a wooden peg.',
        'At noon the station bell sounds twice.', 'The operator checks the lamp before entering.', 'A folded map lies beneath the brass weight.',
        'Footsteps fade along the stone corridor.', 'The observer waits without making a promise.'].join('\n\n')
      await prisma.chapter.update({ where: { id: s.chapter.id }, data: { content: manuscript, wordCount: manuscript.length, revision: { increment: 1 } } })
      await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: 5 })
    }
    if (scenario === 'paused-accepted-new-owner') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', payload: { historicalOwnerChanged: true } } })
    const frozenLayout = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Exact original layout',
      content: 'Historical layout is not a current decision or grant.', metadata: runtimeJson({ historyOnly: true, scenario, outputMode, replica,
        priorQuestion: s.question, oldReport: s.old.frozen, oldCoverage: s.old.coverage }).value } })
    const pause = await pauseCurrent(f, s)
    const result = await continueCurrentReviewWorkflow(f, { compilationId: s.compilation.id, prompt: requestPrompt, afterSeq: pause.seq,
      currentDecisions: applied, scenario, readFirst: scenario === 'known-normalized-decision' })
    expect(result.run).toMatchObject({ taskSpec: s.before.run.taskSpec, modelTier: s.before.run.modelTier, customModelId: s.before.run.customModelId, reasoningEffort: s.before.run.reasoningEffort })
    expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: frozenLayout.id } })).toEqual(frozenLayout)
    const final = await currentReport(s)
    expect(final).toMatchObject({ complete: true, revision: result.chapter.revision })
    if (applied) expect(final!.findings).toHaveLength(4)
    expect(result.events.some(event => event.type === 'text.final' && (outputMode === 'only-prose'
      ? (event.payload as { text: string }).text.includes(result.chapter.content.trim()) : !!(event.payload as { text: string }).text))).toBe(true)
    await s.unchangedOriginal()
  }, undefined, requestPrompt, scenario.startsWith('applied-normalized-current-decisions') ? { ...options, reviewProtocol: 1 } : options), 30000)

  it('closed question rejection, replay and ordinary Continue cannot reopen retired paid exports', () => fixture(async f => {
    const s = await originalFailure(f), network = vi.fn(() => { throw Error('No historical dispatch') }); vi.stubGlobal('fetch', network)
    for (const name of ['answerContinuitySupplementQuestion', 'executeContinuitySupplementTool', 'claimContinuityPhase', 'buildContinuitySupplementQuestion'])
      expect(coordinator).not.toHaveProperty(name)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(3)
    expect(network).not.toHaveBeenCalled(); await s.unchangedOriginal()
    // A genuine current check is independent of the expired historical question.
    await persistCurrentContinuityReport({ ...f, compilationId: s.compilation.id })
    expect(await currentReport(s)).toMatchObject({ complete: true }); await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['unknown', 'conflict', 'invalid', 'dispatch-unknown'] as const)('%s preserves honest current result, raw evidence and billing on continuation', kind => fixture(async f => {
    const s = await originalFailure(f, kind === 'conflict'), network = currentProvider(kind), ctx = readOnly(s)
    const result = await continuityValidateTool.execute(ctx, { compilationId: s.compilation.id }).catch(error => ({ outcome: 'failed', failureCode: error.code }))
    if (kind === 'unknown' || kind === 'conflict') {
      expect(result).toMatchObject({ reviewCompleted: true }); expect(result).not.toHaveProperty('failureCode')
      expect(await currentReport(s)).toMatchObject({ complete: true, findings: [expect.any(Object)] })
      expect(await chapterBridgeCommitTool.execute(s.ctx, { compilationId: s.compilation.id })).toMatchObject({ outcome: 'failed' })
      await continuityValidateTool.execute({ ...ctx, callId: 'cached-current-result' }, { compilationId: s.compilation.id })
      expect(network).toHaveBeenCalledOnce(); await assertNewSettlement(f, s)
    } else if (kind === 'invalid') {
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' })
      expect(await currentReport(s)).toMatchObject({ complete: false, opinions: [expect.any(Object)], rawResponses: [expect.any(String), '{"corrections":[]}'] })
      expect(network).toHaveBeenCalledTimes(2); await assertNewSettlement(f, s, 2)
    } else {
      expect(result).toMatchObject({ outcome: 'failed' })
      for (const callId of ['duplicate-continue', 'worker-restart']) await expect(continuityValidateTool.execute({ ...ctx, callId },
        { compilationId: s.compilation.id })).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
      expect(network).toHaveBeenCalledOnce()
      const unknown = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
      expect(unknown).toMatchObject({ usageSource: 'unknown', billingStatus: 'pending_usage' })
    }
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).committedAt).toBeNull()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toEqual(s.chapter); await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it('serializes concurrent current requests before a second physical dispatch or settlement', () => fixture(async f => {
    const s = await originalFailure(f), ctx = readOnly(s)
    let release!: () => void, entered!: () => void
    const latch = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const network = currentProvider('complete', async () => { entered(); await latch })
    const first = continuityValidateTool.execute({ ...ctx, callId: 'current-a' }, { compilationId: s.compilation.id })
    try {
      await started
      await expect(continuityValidateTool.execute({ ...ctx, callId: 'current-b' }, { compilationId: s.compilation.id })).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    } finally { release() }
    expect(await first).toMatchObject({ reviewCompleted: true }); expect(network).toHaveBeenCalledOnce()
    await assertNewSettlement(f, s); await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['cancel', 'owner', 'revision'] as const)('retains known physical bytes after %s drift and applies no stale report', drift => fixture(async f => {
    const s = await originalFailure(f), controller = new AbortController(), args = { compilationId: s.compilation.id }
    const ctx = readOnly(s, { signal: controller.signal, assertCurrentExecution: async tx => assertContinuityOwner(tx, { ...s.ctx, continuityOwnerSeq: 3 }) })
    const snapshot = await buildContinuitySnapshot(ctx, args)
    const dispatch = vi.fn(async () => {
      if (drift === 'cancel') controller.abort()
      if (drift === 'owner') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1003, type: 'run.started', payload: { resumed: true } } })
      if (drift === 'revision') await prisma.chapter.update({ where: { id: s.chapter.id }, data: { content: s.chapter.content + ' Author correction.', revision: { increment: 1 } } })
      return { content: '{"findings":[]}', usageIds: [], billingKnown: true }
    })
    await expect(reviewContinuity(ctx, args, { snapshot, dispatch, allowRepair: false })).rejects.toBeDefined()
    expect(dispatch).toHaveBeenCalledOnce()
    const physical = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId, metadata: { path: ['continuityReport', 'contextHash'], equals: snapshot.contextHash } } })
    expect(physical.metadata).toMatchObject({ continuityReport: { rawResponses: ['{"findings":[]}'] } })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation).toEqual(s.before.compilation.validation)
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).committedAt).toBeNull()
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['raw-before-apply', 'applied-before-result', 'unknown-dispatch'] as const)('restart preserves actual known/unknown request windows: %s', window => fixture(async f => {
    const s = await originalFailure(f, false, true), ctx = readOnly(s), args = { compilationId: s.compilation.id }
    if (window === 'unknown-dispatch') {
      await prisma.aiUsageLog.update({ where: { id: s.before.usage[0].id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null } })
      // This existing old request must stay unknown; snapshot it after fixture setup.
      s.before.usage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    } else if (window === 'applied-before-result') await persistCurrentContinuityReport({ ...f, compilationId: s.compilation.id })
    else {
      const snapshot = await buildContinuitySnapshot(ctx, args)
      const cancelled = new AbortController()
      await expect(reviewContinuity({ ...ctx, signal: cancelled.signal }, args, { snapshot, allowRepair: false, dispatch: async () => {
        cancelled.abort(); return { content: '{"findings":[]}', usageIds: [], billingKnown: true }
      } })).rejects.toBeDefined()
    }
    const pending = { compilationId: s.compilation.id, chapterId: s.chapter.id, revision: 4, toolName: 'continuity_validate' as const, callId: 'old-crash-window' }
    const pause = await pauseCurrent(f, s, window === 'unknown-dispatch' ? [pending] : [])
    const result = await continueCurrentReviewWorkflow(f, { compilationId: s.compilation.id, prompt, afterSeq: pause.seq, unknown: window === 'unknown-dispatch' })
    expect(result.run.status).toBe(window === 'unknown-dispatch' ? 'paused' : 'completed')
    if (window === 'unknown-dispatch') expect(runCheckpointSchema.parse((result.run.usage as { checkpoint: unknown }).checkpoint).pendingReviews).toEqual([pending])
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it('cancellation after reservation prevents HTTP and preserves a proven not-dispatched receipt', () => fixture(async f => {
    const s = await originalFailure(f), controller = new AbortController(), reserve = credits.reserveTokenCredits
    const held = vi.spyOn(credits, 'reserveTokenCredits').mockImplementation(async (...args) => { const result = await reserve(...args); controller.abort(); return result })
    const network = currentProvider()
    await expect(continuityValidateTool.execute(readOnly(s, { signal: controller.signal }), { compilationId: s.compilation.id })).rejects.toBeDefined()
    expect(held).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled()
    const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, id: { notIn: s.before.usage.map(row => row.id) } } })
    expect(fee).toMatchObject({ billingStatus: 'not_dispatched', creditChargeMilli: 0, reservedCreditMilli: 0, requestTokens: null, responseTokens: null })
    expect(await prisma.creditLedgerEntry.count({ where: { idempotencyKey: `usage:${fee.id}` } })).toBe(0)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })).validation).toEqual(s.before.compilation.validation)
    await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it('an old unsent claim cannot prevent the current owner from checking once and reusing its actual report', () => fixture(async f => {
    const s = await originalFailure(f), old = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview',
      title: 'Frozen unsent claim', content: 'Original executor stopped before transport.', metadata: runtimeJson({ historyOnly: true,
        continuityPhaseClaim: { originalTaskId: f.spec.id, phase: 'full_reassessment', ownerEpoch: '3', operationRef: s.old.key } }).value } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', payload: { currentOwner: true } } })
    const network = currentProvider(), ctx = readOnly(s)
    expect(await continuityValidateTool.execute(ctx, { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    expect(await continuityValidateTool.execute({ ...ctx, callId: 'cached-after-restart' }, { compilationId: s.compilation.id })).toMatchObject({ reviewCompleted: true })
    expect(network).toHaveBeenCalledOnce(); expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old)
    await assertNewSettlement(f, s); await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)

  it.each(['duplicate-current-owner', 'late-old-owner'] as const)('fences %s before dispatch without creating an orphan fee', race => fixture(async f => {
    const s = await originalFailure(f), args = { compilationId: s.compilation.id }
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', payload: { currentOwner: true } } })
    const ownerContext = (seq: number, callId: string) => readOnly(s, { callId,
      assertCurrentExecution: async tx => assertContinuityOwner(tx, { ...s.ctx, continuityOwnerSeq: seq }) })
    let release!: () => void, entered!: () => void
    const latch = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const network = currentProvider('complete', async () => { entered(); await latch })
    if (race === 'late-old-owner') {
      await expect(continuityValidateTool.execute(ownerContext(3, 'late-old-owner'), args)).rejects.toBeInstanceOf(DataAccessError)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(3); expect(network).not.toHaveBeenCalled()
    }
    const current = continuityValidateTool.execute(ownerContext(4, 'legitimate-current-owner'), args)
    try {
      await started
      if (race === 'duplicate-current-owner') await expect(continuityValidateTool.execute(ownerContext(4, 'duplicate-current-owner'), args)).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    } finally { release() }
    expect(await current).toMatchObject({ reviewCompleted: true }); expect(network).toHaveBeenCalledOnce()
    await assertNewSettlement(f, s); await s.unchangedOriginal()
  }, undefined, prompt, options), 30000)
})
