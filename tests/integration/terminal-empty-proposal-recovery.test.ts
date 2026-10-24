import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { emptyProposalFixture } from '../helpers/empty-proposal-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext, continuitySemanticRule } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { compilerEvidenceScope, continuitySourceAuthorityRule } from '../../api/lib/agent/continuity-source-authority.js'
import { continuityCriticSystem } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { continuityResponseContract, continuityResponseSystem } from '../../api/lib/agent/continuity-response-contract.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { allowsChapterOnlyCompletion } from '../../api/lib/agent/writing-scope.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'

const recoveryPrompt = '修改第一章，只输出标题和正文'

describe.runIf(available)('Continue reuses a settled empty optional proposal table pair', () => {
  it('applies the two original responses, commits once and preserves raw audits, claims, model, body and fees', () => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const prompt = recoveryPrompt, startedAt = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).createdAt
    expect(allowsChapterOnlyCompletion(prompt)).toBe(true)
    expect(f.spec.scope.writing).toMatchObject({ kind: 'bounded', titleAndBodyOnly: true, targets: [{ chapterId: f.chapterId, orderIndex: 1 }] })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 8, content: 'The packet remains sealed.' } })
    const candidate = emptyProposalFixture().candidate
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inventory', entryState: candidate.exitState, goal: 'Read', obstacle: 'Time',
      choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
    expect(source).toBeNull()
    const context = terminalEvidenceContext(chapter, source, 2, 1, terminalCoverageInput(f.spec, saved.preparedContext, chapter, candidate, 2), 6, 2)
    expect(Object.hasOwn(context, 'proposalChanges')).toBe(false)
    const synthetic = emptyProposalFixture(chapter, context), scope = compilerEvidenceScope(chapter, source)
    const original = inspectContinuityResponse(synthetic.raw, synthetic.bodies, true, 8, candidate, scope, { responseContract: 3 })
    expect(original).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', terminalReviewDiagnostics: [{ path: 'proposalDispositions' }] } })
    const coverage = compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate }, 11)
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, findings: [], independentCheck: 'unavailable',
      terminalCandidate: candidate, coverage, continuityCriticResponse: original.audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision,
      mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const callId = 'synthetic-old-empty-proposals', input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies: synthetic.bodies,
      parserVersion: 8, reassessmentProtocol: 5, terminalCandidate: candidate, sourceScope: scope, bindingHash: runtimeJson(coverage).hash,
      system: continuityResponseSystem(`${continuityCriticSystem}\n${continuitySourceAuthorityRule}\n${continuitySemanticRule}`, continuityResponseContract(synthetic.bodies, candidate)),
      content: 'Synthetic original frozen request.', targetType: 'story_compilation', targetId: compilation.id }
    const key = legacyContinuityAssessmentKey({ runId: f.runId, callId }, input), window = credits.getCreditWindow()
    const account = await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, dailyUsedMilli: 46,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const usage = [], ledger = []
    for (const action of ['agent3ContinuityCritic', 'agent3ContinuityCriticSecondPass']) {
      const row = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed',
        multiplierBps: 10000, action, requestTokens: 10, responseTokens: 5, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0,
        creditChargeMilli: 23, billingEvidence: { responseObserved: true }, durationMs: 0 } })
      usage.push(row)
      ledger.push(await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: row.id,
        idempotencyKey: `synthetic-empty:${row.id}`, deltaMilli: -23, dailyDeltaMilli: -23, modelTier: 'speed', multiplierBps: 10000, requestTokens: 10, responseTokens: 5 } }))
    }
    const response = { content: JSON.stringify(synthetic.raw), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] }
    const metadata = [{ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, input, callId, admissionId: null },
      { version: 1, fullReassessmentKey: key, input, callId, original: original.audit, usageIds: [usage[0].id],
        request: continuityReassessmentRequest(input.system, input.content, original, synthetic.bodies, false, 5) },
      ...['first', 'reassessment'].flatMap((stage, index) => [
        { version: 1, assessmentRequestOwnerKey: key, stage, callId, usageIds: [usage[index].id] },
        { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage }).hash, input, stage, callId, usageIds: [usage[index].id], response, audit: original.audit },
      ])]
    const artifacts = []
    for (const value of metadata) artifacts.push(await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview',
      title: 'Synthetic historical response', content: 'Synthetic historical evidence.', metadata: runtimeJson(value).value } }))
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', payload: { reason: 'model_stalled' } } })
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default',
      activeExecutionMs: recoverRunElapsedMs(startedAt.getTime(), pause.createdAt.getTime(), [{ type: 'run.paused', at: pause.createdAt.getTime() }]),
      runStartedAt: startedAt.getTime(), stagnantBatches: 0, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [], reviewAttempts: [], pendingReviews: [],
      inheritedTokens: 10, inheritedTurns: 1, manualResumeCount: 0 }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 4, startedAt,
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, checkpoint } } })
    const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } }), network = vi.fn(() => { throw Error('No new provider request') })
    vi.stubGlobal('fetch', network)
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
      multiplierBps: 10000, reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((name, owner) => name === 'storyCompiler' || name !== 'memory2' && feature(name, owner))
    const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async () => {
      const diagnostic = main.mock.calls.length > 1 ? {
        toolResults: await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.result', seq: { gt: 1 } }, select: { payload: true }, orderBy: { seq: 'asc' } }),
        readiness: await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id)),
      } : undefined
      expect(main, diagnostic ? JSON.stringify(diagnostic) : undefined).toHaveBeenCalledOnce()
      return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'synthetic-resume-new-call', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...f, prompt, mode: 'build', resume: true, authorContinue: { eventId: pause.id, afterSeq: 1 }, eventStartSeq: 1,
      modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const errors = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'error' }, select: { payload: true } })
    const failedTools = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.result', seq: { gt: 1 }, payload: { path: ['ok'], equals: false } }, select: { payload: true } })
    expect(failedTools).toEqual([])
    expect({ status: finished.status, errorMessage: finished.errorMessage, errors }).toEqual({ status: 'completed', errorMessage: null, errors: [] })
    expect(finished).toMatchObject({ taskSpec: beforeRun.taskSpec, modelTier: beforeRun.modelTier, customModelId: beforeRun.customModelId, reasoningEffort: beforeRun.reasoningEffort })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ terminalCommitted: true, terminalReview: { deliveryEligible: true } })
    expect((await readTerminalInheritance(prisma, f, chapter)).map(fact => [fact.field, fact.claim])).toEqual([['objects', candidate.exitState.objects[0]]])
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(artifacts))
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(byId(usage))
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(byId(ledger))
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(account)
    expect((finished.usage as { checkpoint: { reviewAttempts: string[] } }).checkpoint.reviewAttempts.filter(value => value.startsWith('terminal-processing:'))).toEqual([])
    const report = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    expect(runtimeJson(report.validation).value).toMatchObject({ continuityCriticResponse: { formatProjection: { kind: 'empty_optional_proposal_table', version: 1 } } })
    const calls = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.call', seq: { gt: 1 } }, orderBy: { seq: 'asc' } })
    expect(calls.map(row => (row.payload as { toolName: string }).toolName)).toEqual(['continuity_validate', 'chapter_bridge_commit'])
    for (let i = 0; i < 2; i++) await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(finished)
    expect(main).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled()
    expect(createHash('sha256').update(synthetic.raw).digest('hex')).toBe(original.audit.contentHash)
  }, undefined, recoveryPrompt, { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
