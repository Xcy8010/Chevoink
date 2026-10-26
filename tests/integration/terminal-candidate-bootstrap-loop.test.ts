import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import * as agents from '../../api/lib/agent/agents.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { originalChapterReviewRequirements } from '../../api/lib/agent/chapter-review-requirements.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { bindLegacyContinuityAssessment, legacyContinuityAssessmentKey, readLegacyContinuityAssessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { terminalFeedbackSlots } from '../../api/lib/agent/terminal-feedback-handoff.js'
import { terminalProcessingPlan } from '../../api/lib/agent/terminal-processing.js'
import { prepareTerminalProposalInput } from '../../api/lib/agent/terminal-proposal-context.js'
import { observeChapterReviewProgress, observeSemanticReadProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { allowsChapterOnlyCompletion, freezeWritingScope, readRecoveredChapterDelivery } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'

const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)
const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic whole-body review.', findingIndexes: [] }))
const recoveryPrompt = '修改第一章'

describe.runIf(available)('authenticated native review hands a rejected current-state candidate back to the original task', () => {
  it.each(['before-turn', 'after-read', 'recover-transient', 'recover-quality-decision', 'recover-unknown-commit', 'recover-missing-commit'] as const)('handles current evidence after exhausted claims and repeated Continue: %s', scenario => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const startedAt = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId }, select: { createdAt: true } })).createdAt
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: {
      content: 'The packet remains on the desk.', revision: 8, wordCount: 29 } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt: recoveryPrompt } } })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const spec = original.spec as typeof f.spec
    expect(chapter.orderIndex).toBe(1)
    expect(spec.scope.writing).toMatchObject({ kind: 'bounded', targets: [{ orderIndex: chapter.orderIndex }] })
    if (scenario.startsWith('recover-')) expect(allowsChapterOnlyCompletion(original.prompt, false)).toBe(true)
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: 'Review the synthetic saved chapter.' })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Record', entryState: empty, goal: 'Record', obstacle: 'None', choice: 'Wait', cost: 'Time', turn: 'Wait', exitState: empty,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
    const recovery = scenario.startsWith('recover-')
    const base = terminalCandidateSchema.parse({ exitState: recovery ? { emotion: ['Unconfirmed operator tension.'] } : { knowledge: ['The sender owns the packet.'] } })
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains on the desk.'] } })
    const context = terminalEvidenceContext(chapter, source, 2, 1, terminalCoverageInput(spec, saved.preparedContext, chapter, candidate, 2), 5, 2)
    const prior = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: checks,
      terminalVerdicts: terminalCandidateFacts(base).map(fact => ({ path: fact.path, verdict: 'unknown', sourceEvidence: [] })), terminalProofVerdicts: [], terminalDispositions: [] }),
    { current: chapter.content, previous: source?.content ?? null, terminalEvidence: context }, true, 8, base)
    expect(prior.complete).toBe(true)
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, independentCheck: 'complete', findings: [], terminalCandidate: base,
      coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: base }, 11), continuityCriticResponse: prior.audit })
    const priorSaved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const staged = prepareTerminalProposalInput({ spec, preparedContext: priorSaved.preparedContext, validation: priorSaved.validation,
      content: chapter.content, previousContent: source?.content ?? null, candidate, originalContext: context, nextContext: context })!
    const proposal = staged.changes!.proposals[0], reason = 'The current body does not identify the packet owner.'
    const inspected = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: checks,
      terminalVerdicts: [{ path: 'exitState.objects.0', verdict: 'supported', sourceEvidence: [{ segmentId: 'c0', quote: chapter.content }] }],
      terminalProofVerdicts: [], terminalDispositions: [], proposalDispositions: [{ id: proposal.id, outcome: 'unknown', reason, sourceEvidence: [] }] }),
    { current: chapter.content, previous: source?.content ?? null, terminalEvidence: { ...context, proposalChanges: staged.changes } }, true, 8, candidate)
    expect(inspected.complete).toBe(true)
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, independentCheck: 'complete', findings: [], terminalCandidate: candidate,
      coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate }, 11), continuityCriticResponse: inspected.audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision,
      mode: 'balanced', criticComplete: true, criticFindings: scenario === 'recover-quality-decision' ? [{ signal: 'reader_pull', severity: 'warning', quote: chapter.content,
        explanation: 'The saved beat is quiet.', suggestion: 'Consider the pace without changing the established packet location.', confidence: 0.8 }] : [],
      deterministicFindings: [], deterministicMetrics: {} })
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    expect(readiness?.terminalReview).toMatchObject({ state: 'unverified', currentResultVerified: true, deliveryEligible: recovery, unresolved: [{ claim: proposal.claim, reason }] })
    if (scenario === 'recover-quality-decision') {
      expect(readiness).toMatchObject({ ready: true, decisionPending: true, mustPassPending: false })
      expect(readiness?.requiredDecisions).toHaveLength(1)
    }
    const key = runtimeJson({ kind: 'terminal-processing', version: 1, userId: f.userId, novelId: f.novelId, taskId: spec.id, chapterId: chapter.id,
      contentHash: readiness!.progressEvidence!.contentHash, sourceHash: readiness!.terminalProcessing!.sourceHash,
      contractHash: readiness!.terminalProcessing!.contractHash }).hash
    if (scenario === 'recover-quality-decision') expect(terminalProcessingPlan(readiness, { ...f, taskSpec: spec }, new Set())).toBeNull()
    const claims = [0, 1].map(index => `terminal-processing:${key}:${index}`)
    const seen = new Set<string>()
    observeChapterReviewProgress(seen, readiness!.progressEvidence, { ...f, taskSpec: spec, expectedOriginalTaskId: spec.id })
    observeSemanticReadProgress(seen, 'chapter_read', chapter.content, { targetId: chapter.id, contentHash: createHash('sha256').update(chapter.content).digest('hex'), start: 0, end: chapter.content.length })
    for (const phase of ['prepare', 'scenes'] as const) observeWritingWorkflowMilestone(seen, phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build',
      { version: 1, userId: f.userId, novelId: f.novelId, runId: f.runId, targetOrderIndex: chapter.orderIndex, phase }, { ...f, taskSpec: spec })
    const pauseSeq = scenario === 'recover-unknown-commit' ? 2 : 1
    if (scenario === 'recover-unknown-commit') {
      claims.push(`terminal-commit:${key}`)
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: {
        toolName: 'chapter_bridge_commit', callId: `terminal_commit_${key.slice(0, 40)}`, args: { compilationId: compilation.id } } } })
    }
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: pauseSeq, type: 'run.paused', payload: { reason: 'model_stalled' } } })
    // A nonzero saved turn requires an actual execution interval. Missing
    // startedAt correctly stops resume before any author feedback is emitted.
    const activeExecutionMs = recoverRunElapsedMs(startedAt.getTime(), pause.createdAt.getTime(), [{ type: 'run.paused', at: pause.createdAt.getTime() }])
    expect(activeExecutionMs).toBe(pause.createdAt.getTime() - startedAt.getTime())
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs, stagnantBatches: scenario === 'after-read' ? 3 : 7,
      runStartedAt: startedAt.getTime(), resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0,
      progressSignatures: [...seen], reviewAttempts: claims, pendingReviews: [], inheritedTokens: 10, inheritedTurns: 1, manualResumeCount: 0 }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 26, startedAt,
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, checkpoint } } })
    const window = credits.getCreditWindow()
    const account = await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, dailyUsedMilli: 23,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const historicalUsage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
      targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed', multiplierBps: 10000,
      action: 'agent3ContinuityCritic', requestTokens: 10, responseTokens: 0, usageSource: 'reported', billingStatus: 'settled',
      billingEvidence: { responseObserved: true }, reservedCreditMilli: 0, creditChargeMilli: 23, durationMs: 0 } })
    const historicalCharge = await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage',
      referenceId: historicalUsage.id, idempotencyKey: `synthetic-historical:${historicalUsage.id}`, deltaMilli: -23, dailyDeltaMilli: -23,
      modelTier: 'speed', multiplierBps: 10000, requestTokens: 10, responseTokens: 0 } })
    const network = vi.fn(() => { throw Error('Exhausted claims must not dispatch a provider request') })
    vi.stubGlobal('fetch', network)
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture', multiplierBps: 10000,
      reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
    if (scenario === 'recover-missing-commit') {
      const availableTools = agents.getToolsForAgent
      vi.spyOn(agents, 'getToolsForAgent').mockImplementation((...args) => availableTools(...args).filter(tool => tool.name !== 'chapter_bridge_commit'))
    }
    let closingCalls = 0
    const closingSummary = 'The packet remains on the desk; its location stays unchanged.'
    const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async request => {
      const { messages } = request
      const current = await readChapterReviewReadiness(prisma, f, compilation.id)
      if (current?.terminalCommitted) {
        // A default creative wrap-up follows a real commit. It is not another
        // candidate decision, continuity request or manuscript mutation.
        expect(['recover-transient', 'recover-quality-decision']).toContain(scenario)
        expect(current).toMatchObject({ ready: true, decisionPending: false, terminalReview: { deliveryEligible: true } })
        const capture = await prisma.$transaction(tx => readRecoveredChapterDelivery(tx, f))
        expect(capture?.chapters).toMatchObject([{ id: chapter.id, revision: chapter.revision, content: chapter.content }])
        expect(JSON.stringify(messages)).toContain(chapter.content)
        expect(request).toMatchObject({ model: 'fixture', provider: 'fixture', usageLog: {
          userId: f.userId, agentRunId: f.runId, modelTier: 'speed', multiplierBps: 10000 } })
        expect(closingCalls++).toBe(0)
        expect(main).toHaveBeenCalledTimes(scenario === 'recover-quality-decision' ? 2 : 1)
        return { content: closingSummary, reasoning: '', finishReason: 'stop', toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
      }
      if (scenario === 'recover-quality-decision') {
        expect(main).toHaveBeenCalledOnce()
        expect(JSON.stringify(messages)).toContain('The saved beat is quiet.')
        return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'synthetic-current-decision', name: 'chapter_bridge_commit',
          arguments: JSON.stringify({ compilationId: compilation.id, retainedFindings: readiness!.requiredDecisions!.map(item => ({ ...item,
            reason: 'The quiet beat preserves the current packet state; keep the original prose and this warning for the author.' })) }) }],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
      }
      if (scenario !== 'after-read' || main.mock.calls.length > 1) throw Error('No further primary request is permitted')
      return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'synthetic-repeat-read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: chapter.id }) }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const resume = (eventId: string, afterSeq: number) => executeAgentRun({ ...f, prompt: recoveryPrompt, mode: 'build', resume: true,
      authorContinue: { eventId, afterSeq }, eventStartSeq: afterSeq, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    let afterSeq = pauseSeq
    await resume(pause.id, afterSeq)
    if (recovery) {
      const succeeded = scenario === 'recover-transient' || scenario === 'recover-quality-decision'
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
      if (scenario === 'recover-quality-decision') expect(saved.validation).toMatchObject(before.validation as object)
      else expect(saved.validation).toEqual(before.validation)
      expect(saved.preparedContext).toMatchObject(before.preparedContext as object)
      expect(saved).toMatchObject({ status: succeeded ? 'completed' : before.status, stage: succeeded ? 'commit' : before.stage })
      expect(saved.bridge!.committedAt !== null).toBe(succeeded)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      if (succeeded) {
        const errors = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'error', seq: { gt: pauseSeq } }, select: { payload: true } })
        expect({ errorMessage: finished.errorMessage, errors }).toEqual({ errorMessage: null, errors: [] })
        const finals = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'text.final', seq: { gt: pauseSeq } } })
        expect(finals.filter(event => !(event.payload as { asReasoning?: boolean }).asReasoning)
          .map(event => (event.payload as { text: string }).text)).toEqual([closingSummary])
      }
      expect(finished).toMatchObject({ status: succeeded ? 'completed' : 'paused', taskSpec: spec,
        modelTier: beforeRun.modelTier, customModelId: beforeRun.customModelId, reasoningEffort: beforeRun.reasoningEffort })
      const attempts = (finished.usage as { checkpoint: { reviewAttempts: string[] } }).checkpoint.reviewAttempts
      expect(attempts.filter(item => item.startsWith('terminal-processing:'))).toEqual(claims.filter(item => item.startsWith('terminal-processing:')))
      if (succeeded) {
        expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ terminalCommitted: true,
          terminalReview: { state: 'unverified', deliveryEligible: true, unresolved: [{ claim: proposal.claim, verdict: 'unknown' }] } })
        expect((await readTerminalInheritance(prisma, f, chapter)).map(item => [item.field, item.claim])).toEqual([['objects', candidate.exitState.objects[0]]])
        for (let repeated = 0; repeated < 2; repeated++) await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
        expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(finished)
      } else {
        const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { gt: pauseSeq } }, orderBy: { seq: 'asc' } })
        const notices = events.filter(event => event.type === 'error')
        expect(notices).toHaveLength(1)
        const stopped = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        expect(notices[0].payload).toMatchObject({ code: 'run_paused', recoverable: true, message: stopped.errorMessage })
        expect((notices[0].payload as { message: string }).message)
          .toContain(scenario === 'recover-missing-commit' ? '缺少章节终态提交能力' : '已有执行记录但尚未确认完成')
        expect(events.filter(event => event.type === 'text.final')).toEqual([])
      }
      const calls = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.call', seq: { gt: pauseSeq } } })
      expect(calls.map(event => (event.payload as { toolName: string }).toolName)).toEqual(succeeded ? ['chapter_bridge_commit'] : [])
      expect(closingCalls).toBe(succeeded ? 1 : 0)
      expect(main).toHaveBeenCalledTimes(scenario === 'recover-quality-decision' ? 2 : succeeded ? 1 : 0)
      expect(network).not.toHaveBeenCalled()
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })).toEqual([historicalUsage])
      expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(account)
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId } })).toEqual([historicalCharge])
      return
    }
    for (let continuation = 0; continuation < 3; continuation++) {
      const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
      const currentEvents = events.filter(event => event.seq > afterSeq)
      const notices = currentEvents.filter(event => event.type === 'error')
      expect(notices).toHaveLength(1)
      const stopped = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      expect(notices[0].payload).toMatchObject({ code: 'run_paused', recoverable: true, message: stopped.errorMessage })
      expect(currentEvents.filter(event => event.type === 'text.final')).toEqual([])
      const { message: text } = notices[0].payload as { message: string }
      expect(text).toContain(`第${chapter.orderIndex}章（版本${chapter.revision}）：`)
      expect(text).toContain('当前终态复核结果已收到，仍有1项未获证实')
      expect(text).toContain(proposal.claim)
      expect(text).toContain(reason)
      expect(text).not.toContain('未取得有效独立结果')
      const stop = currentEvents.filter(event => event.type === 'run.paused').at(-1)!
      expect(stop?.payload).toMatchObject({ reason: 'needs_input' })
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toMatchObject({ status: 'paused', errorMessage: expect.stringContaining('当前终态复核结果已收到') })
      if (continuation < 2) {
        afterSeq = events.at(-1)!.seq
        await resume(stop.id, afterSeq)
      }
    }
    expect(main).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })).toEqual(before)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(run.status).toBe('paused')
    expect((run.usage as { checkpoint: { reviewAttempts: string[] } }).checkpoint.reviewAttempts).toEqual(claims)
    const toolCalls = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.call' }, orderBy: { seq: 'asc' } })
    expect(toolCalls.map(event => (event.payload as { toolName: string }).toolName)).toEqual([])
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'tool.call', payload: { path: ['toolName'], equals: 'chapter_bridge_commit' } } })).toBe(0)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })).toEqual([historicalUsage])
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: account.userId } })).toEqual(account)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId } })).toEqual([historicalCharge])
  }, undefined, recoveryPrompt, { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)

  it.each([...(['settled', 'unknown'] as const).flatMap(billing => (['commit', 'repeat', 'restart'] as const).map(scenario => [billing, scenario] as const)), ...(['old-slots', 'local-refusal', 'consumed-local-candidate', 'objects', 'source-address', 'commit-reserved', 'commit-unknown', 'multiple-candidates', 'no-proposal'] as const).map(scenario => ['settled', scenario] as const)])(
    'preserves failed requests without converting Continue into a paid phase: %s / %s', (billing, scenario) => fixture(async f => {
    const pendingProvider = billing === 'unknown' && scenario === 'repeat'
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    // Every synthetic historical event precedes the real Continue admission,
    // including on fast CI workers. Keep the saved-version evidence on the
    // same clock; moving only calls would invalidate local-refusal proof.
    const start = Date.now() - 60_000, at = (ms: number) => new Date(start + ms)
    const body = 'He stops at the control-room doorway, before turning the wheel. The packet remains on the desk.'
      + (scenario === 'source-address' ? ' The current output remains unverified.' : ''), accurate = 'At the control-room doorway, before crossing it.'
    const bad = terminalCandidateSchema.parse({ exitState: { location: scenario === 'objects' ? accurate : 'Inside the first door of the control room.',
      action: 'Preparing to turn the first-door wheel.', ...(scenario === 'objects' ? { objects: ['The packet has been archived.'] } : {}),
      ...(scenario === 'source-address' ? { knowledge: ['An earlier reading proves the current output.'] } : {}) }, lastUnfinishedAction: 'The first-door wheel has not been turned.' })
    if (scenario === 'consumed-local-candidate') bad.exitState.emotion.push('Unverified tension about a distant event.')
    const good = terminalCandidateSchema.parse({ exitState: { location: accurate, action: 'Preparing to turn the control-room doorway wheel.',
      ...(scenario === 'objects' ? { objects: ['The packet remains on the desk.'] } : {}),
      ...(scenario === 'source-address' ? { knowledge: ['The current output remains unverified.'] } : {}) }, lastUnfinishedAction: 'The doorway wheel has not been turned.' })
    const badFacts = terminalCandidateFacts(bad), goodFacts = terminalCandidateFacts(good)
    const correction = { baseCandidateHash: runtimeJson(bad).hash,
      removeFactIds: badFacts.filter(fact => !goodFacts.some(current => current.id === fact.id)).map(fact => fact.id),
      addFacts: goodFacts.filter(fact => !badFacts.some(current => current.id === fact.id)).map(({ field, claim }) => ({ field, claim })) }
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2, revision: 8, content: body, wordCount: body.length, updatedAt: at(-1) } })
    await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Synthetic predecessor', orderIndex: 1, orderInVolume: 1, revision: 15,
      content: 'He crossed the first door, the middle chamber, then the second door into the control room.', wordCount: 90 } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null, createdAt: at(-2), startRequest: { prompt: '修复本章' } } })
    // Freeze only after the synthetic chapter directory is final. The fixture
    // starts at order1; an already-frozen scope must never be reinterpreted
    // after moving that chapter to order2 for the predecessor topology.
    const admitted = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, f, admitted.spec as typeof f.spec, '修复本章'))
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskSpec: JSON.parse(JSON.stringify(spec)) } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: 'Review the saved chapter.' })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Record position', entryState: empty, goal: 'Record', obstacle: 'Door', choice: 'Wait', cost: 'Time', turn: 'At doorway', exitState: empty,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
    expect(source?.content).toContain('second door')
    const evidence = terminalEvidenceContext(chapter, source, 2, 1, terminalCoverageInput(original.spec, saved.preparedContext, chapter, bad, 2), 5)
    const rejectedPath = scenario === 'source-address' ? 'exitState.knowledge.0' : scenario === 'objects' ? 'exitState.objects.0' : 'exitState.location'
    const rejected = { findings: [], semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(bad).map(fact => scenario === 'repeat'
      ? { factId: fact.id, verdict: 'unknown', sourceEvidence: [] }
      : { factId: fact.id, verdict: 'supported',
      sourceEvidence: [{ segmentId: 'c0' }, ...(fact.path === rejectedPath ? [{ segmentId: scenario === 'source-address' ? 'p99' : 'p0',
        ...(scenario === 'source-address' ? { quote: source!.content.slice(0, 40) } : {}) }] : [])],
      ...(scenario === 'source-address' && fact.path === rejectedPath ? { inheritance: { priorEndState: 'established', currentState: 'unchanged' } } : {}) }), terminalProofVerdicts: [], terminalDispositions: [] }
    const bodies = { current: body, previous: source!.content, terminalEvidence: evidence }, scope = compilerEvidenceScope(chapter, source)
    const inspected = inspectContinuityResponse(JSON.stringify(rejected), bodies, true, 8, bad, scenario === 'repeat' ? scope : undefined)
    if (scenario === 'repeat') expect(inspected).toMatchObject({ complete: true, audit: { classification: 'complete' } })
    else expect(inspected).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', terminalReviewDiagnostics: [{
      code: scenario === 'source-address' ? 'evidence_quote_invalid' : 'inheritance_invalid', path: rejectedPath }] } })
    const coverage = compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: bad }, 11)
    let audit = inspected.audit
    let knownRepeatUsage: Awaited<ReturnType<typeof prisma.aiUsageLog.create>> | undefined
    const knownRepeatArtifacts: Awaited<ReturnType<typeof prisma.agentArtifact.create>>[] = []
    if (scenario === 'repeat') {
      // A previously received, settled UNKNOWN is the initial current report.
      // Its actual frozen frame is authenticated before seeding its genuine
      // milestone. The separate old unknown-fee row below is never settled.
      const ctx = { ...f, callId: 'initial-known-unknown' } as Parameters<typeof readLegacyContinuityAssessment>[1]
      const input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, terminalCandidate: bad,
        parserVersion: 8, reassessmentProtocol: 2, sourceScope: scope, system: 'Synthetic frozen UNKNOWN reviewer.', content: 'Synthetic full frozen chapter review.',
        bindingHash: runtimeJson(coverage).hash, targetType: 'story_compilation', targetId: compilation.id }
      const key = legacyContinuityAssessmentKey(ctx, input)
      knownRepeatUsage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic-known', modelTier: 'speed',
        multiplierBps: 10000, action: 'agent3ContinuityCritic', requestTokens: 10, responseTokens: 0, usageSource: 'reported', billingStatus: 'settled',
        reservedCreditMilli: 0, creditChargeMilli: 0, billingEvidence: { responseObserved: true }, durationMs: 0, createdAt: at(0) } })
      for (const metadata of [
        { version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, input, callId: ctx.callId, admissionId: null },
        { version: 1, assessmentRequestOwnerKey: key, stage: 'first', callId: ctx.callId, usageIds: [knownRepeatUsage.id] },
        { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage: 'first' }).hash, input, stage: 'first', callId: ctx.callId,
          usageIds: [knownRepeatUsage.id], response: { content: JSON.stringify(JSON.stringify(rejected)), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] }, audit: inspected.audit },
      ]) knownRepeatArtifacts.push(await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Synthetic known UNKNOWN response',
        content: 'Synthetic frozen response and ownership.', metadata: runtimeJson(metadata).value, createdAt: at(1) } }))
      const known = await readLegacyContinuityAssessment(prisma, ctx, input)
      expect(known).toMatchObject({ billingKnown: true, providerComplete: true, recoveryReady: true, inspected: { complete: true } })
      audit = bindLegacyContinuityAssessment(known.inspected, ctx, input).audit as typeof audit
    }
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: 8, independentCheck: scenario === 'repeat' ? 'complete' : 'unavailable', findings: [], terminalCandidate: bad,
      coverage, continuityCriticResponse: audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: 8, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    if (scenario === 'repeat') expect(readiness?.terminalReview).toMatchObject({ state: 'unverified', currentResultVerified: true })
    else expect(readiness?.terminalCorrection).toMatchObject({ paths: [rejectedPath] })
    expect(originalChapterReviewRequirements({ prompt: original.prompt, spec })).toEqual({ continuity: true, quality: true })
    expect(readiness).toMatchObject({ quality: 'complete', requiredTools: scenario === 'repeat' ? [] : [{ name: 'continuity_validate' }] })
    if (scenario === 'repeat') expect(readiness).toMatchObject({ continuity: 'complete', ready: true,
      terminalReview: { state: 'unverified', currentResultVerified: true, deliveryEligible: false } })
    if (scenario === 'repeat') expect(readiness?.progressEvidence?.phases).toContain('terminal')
    else expect(readiness?.progressEvidence?.phases).not.toContain('terminal')
    const slots = terminalFeedbackSlots(readiness, { ...f, taskSpec: spec })!
    expect(slots).toHaveLength(4)
    const processingKey = terminalProcessingPlan(readiness, { ...f, taskSpec: spec }, new Set())!.key
    const seen = new Set<string>()
    // Previously persisted quality and workflow receipts cannot reset the
    // exhausted stall counter when this original task is continued again.
    observeChapterReviewProgress(seen, readiness!.progressEvidence, { ...f, taskSpec: spec, expectedOriginalTaskId: spec.id })
    observeSemanticReadProgress(seen, 'chapter_read', body, { targetId: chapter.id, contentHash: createHash('sha256').update(body).digest('hex'), start: 0, end: body.length })
    for (const phase of ['prepare', 'scenes'] as const) observeWritingWorkflowMilestone(seen, phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build',
      { version: 1, userId: f.userId, novelId: f.novelId, runId: f.runId, targetOrderIndex: 2, phase }, { ...f, taskSpec: spec })
    const validation = (await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, select: { validation: true } })).validation as { checkedAt: string }
    const checkedAt = Date.parse(validation.checkedAt)
    expect(Number.isFinite(checkedAt)).toBe(true)
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: { ...validation, checkedAt: at(1000).toISOString() } } })
    const old = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id, targetType: 'story_compilation', targetId: compilation.id,
      providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed', multiplierBps: 10000, action: 'agent3ContinuityCritic',
      ...(billing === 'unknown' ? { requestTokens: null, responseTokens: null, usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 18023 }
        : { requestTokens: 10, responseTokens: 0, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, billingEvidence: { responseObserved: true } }),
      creditChargeMilli: 0, durationMs: 0, createdAt: at(100) } })
    await prisma.agentRunEvent.createMany({ data: [{ runId: f.runId, seq: 1, type: 'tool.call', createdAt: at(0), payload: { callId: 'original-ended', toolName: 'continuity_validate', args: { compilationId: compilation.id } } },
      { runId: f.runId, seq: 2, type: 'tool.result', createdAt: at(1001), payload: { callId: 'original-ended', toolName: 'continuity_validate', ok: false,
        failureCode: billing === 'unknown' ? 'AI_PROVIDER_TRANSPORT' : 'CONTINUITY_REPORT_INCOMPLETE',
        ...(billing === 'settled' ? { reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: 8,
          contentHash: createHash('sha256').update(body).digest('hex'), usageIds: [old.id] } } : {}) } }] })
    const pauseSeq = scenario === 'local-refusal' || scenario === 'consumed-local-candidate' || scenario === 'commit-unknown' ? 6 : 3
    if (scenario === 'commit-unknown') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4,
      type: 'tool.call', createdAt: at(2000), payload: { callId: `terminal_commit_${processingKey.slice(0, 40)}`,
        toolName: 'chapter_bridge_commit', args: { compilationId: compilation.id } } } })
    if (scenario === 'local-refusal') await prisma.agentRunEvent.createMany({ data: [
      { runId: f.runId, seq: 4, type: 'tool.call', createdAt: at(2000), payload: { callId: 'local-stale', toolName: 'continuity_validate',
        args: { compilationId: compilation.id, terminalPatch: { baseCandidateHash: 'f'.repeat(64) } } } },
      { runId: f.runId, seq: 5, type: 'tool.result', createdAt: at(2100), payload: { callId: 'local-stale', toolName: 'continuity_validate', ok: false,
        failureCode: 'CONTINUITY_INPUT_STALE' } },
    ] })
    if (scenario === 'consumed-local-candidate') await prisma.agentRunEvent.createMany({ data: [
      { runId: f.runId, seq: 4, type: 'tool.call', createdAt: at(2000), payload: { callId: 'local-field-count', toolName: 'continuity_validate',
        args: { compilationId: compilation.id, terminalPatch: correction } } },
      { runId: f.runId, seq: 5, type: 'tool.result', createdAt: at(2100), payload: { callId: 'local-field-count', toolName: 'continuity_validate', ok: false,
        failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED', reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: chapter.revision,
          contentHash: createHash('sha256').update(body).digest('hex'), usageIds: [] } } },
    ] })
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: pauseSeq, type: 'run.paused', createdAt: at(2200), payload: { reason: 'model_stalled' } } })
    const history = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 200, stagnantBatches: scenario === 'local-refusal' ? 4 : 7, runStartedAt: start, resumeCount: 0, compactionCount: 0,
      maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0, progressSignatures: [...seen], reviewAttempts: ['old-attempt'],
      pendingReviews: scenario === 'local-refusal' ? [{ compilationId: compilation.id, chapterId: chapter.id, revision: 8, toolName: 'continuity_validate', callId: 'local-stale' }] : billing === 'unknown' ? [{ compilationId: compilation.id, chapterId: chapter.id, revision: 8, toolName: 'continuity_validate', callId: 'original-ended' }] : [],
      consumedReviewDecisionFeedback: scenario === 'old-slots' ? [...slots] : [] as string[], inheritedTokens: 0, inheritedTurns: 0, manualResumeCount: 0 }
    if (scenario === 'commit-reserved' || scenario === 'commit-unknown') checkpoint.reviewAttempts.push(`terminal-commit:${processingKey}`)
    if (scenario === 'consumed-local-candidate') checkpoint.reviewAttempts.push(...[0, 1].map(index => `terminal-processing:${processingKey}:${index}`))
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 26, startedAt: at(0), usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, checkpoint } } })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture', multiplierBps: 10000,
      reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
    let calls = 0
    const network = vi.fn(async () => {
      calls++
      if (scenario === 'repeat') throw Error('The authenticated current UNKNOWN must not dispatch another critic')
      if (calls > 1) throw Error('No extra critic request is permitted')
      // Historical rejected reports above retain their original v5 identities.
      // Only this newly frozen provider request uses local addresses.
      const parts = { findings: [], semanticChecks: checks.map(({ findingIndexes: _indexes, ...check }) => ({ ...check, findingIds: [] })), terminalVerdicts: goodFacts.map((_fact, claimIndex) => ({ claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })), terminalProofVerdicts: [], terminalDispositions: [],
          proposalDispositions: badFacts.filter(fact => !goodFacts.some(current => current.id === fact.id)).map((fact, proposalIndex) => {
            const replacement = goodFacts.find(current => current.field === fact.field)
            return { proposalIndex, outcome: replacement ? 'replaced' : 'retracted',
              reason: 'The complete saved body supports the doorway state; the old assertion confused intent or location.',
              sourceEvidence: [{ segmentId: 'c0' }], ...(replacement ? { candidateIndex: goodFacts.indexOf(replacement) } : {}) }
          }) }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(parts) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', network)
    const main = vi.spyOn(ai, 'chatWithTools').mockRejectedValue(Error('Continue cannot create another paid candidate decision'))
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const originalUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const originalAccount = await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })
    const originalLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    await executeAgentRun({ ...f, prompt: '修复本章', mode: 'build', resume: true, authorContinue: { eventId: pause.id, afterSeq: pauseSeq }, eventStartSeq: pauseSeq,
      modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    if (scenario === 'restart' || scenario === 'repeat') {
      const last = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
      await executeAgentRun({ ...f, prompt: '修复本章', mode: 'build', resume: true, authorContinue: { eventId: last.id, afterSeq: last.seq }, eventStartSeq: last.seq,
        modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    }
    expect(main).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalUsage)
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(originalAccount)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old)
    expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { lte: pauseSeq } }, orderBy: { seq: 'asc' } })).toEqual(history)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content: body, revision: 8 })
    const final = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(final).toEqual(before)
    expect(final.bridge!.committedAt).toBeNull()
    expect(run.status).toBe('paused')
    const resumed = run.usage as { checkpoint: typeof checkpoint }
    expect(resumed.checkpoint.reviewAttempts).toEqual(expect.arrayContaining(checkpoint.reviewAttempts))
    expect(resumed.checkpoint.consumedReviewDecisionFeedback ?? []).toEqual(checkpoint.consumedReviewDecisionFeedback ?? [])
    if (pendingProvider) expect(resumed.checkpoint.pendingReviews).toEqual(checkpoint.pendingReviews)
    if (knownRepeatUsage) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: knownRepeatUsage.id } })).toEqual(knownRepeatUsage)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: knownRepeatArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } }))
      .toEqual([...knownRepeatArtifacts].sort((left, right) => left.id.localeCompare(right.id)))
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, seq: { gt: pauseSeq }, type: 'tool.call' } })).toBe(0)
  }, undefined, '修复本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 1 }), 30000)
})
