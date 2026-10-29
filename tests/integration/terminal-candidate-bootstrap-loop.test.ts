import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as agents from '../../api/lib/agent/agents.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistHistoricalContinuityAudit as validateStoryContinuity } from '../support/historical-continuity-audit.js'
import { continueCurrentTerminalLoop as continueCurrentReviewWorkflow } from '../support/current-terminal-loop-fixture.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { originalChapterReviewRequirements } from '../../api/lib/agent/chapter-review-requirements.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { bindLegacyContinuityAssessment, legacyContinuityAssessmentKey, readLegacyContinuityAssessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { prepareTerminalProposalInput } from '../../api/lib/agent/terminal-proposal-context.js'
import { observeChapterReviewProgress, observeSemanticReadProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { allowsChapterOnlyCompletion, freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import * as credits from '../../api/lib/credits.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'

const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)
const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic whole-body review.', findingIndexes: [] }))
const recoveryPrompt = '修改第一章'

describe.runIf(available)('historical candidate judgments preserve the original task while current prose reports can complete', () => {
  it.each(['before-turn', 'after-read', 'recover-transient', 'recover-quality-decision', 'recover-unknown-commit', 'recover-missing-commit'] as const)('handles current evidence after exhausted claims and repeated Continue: %s', scenario => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
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
    expect(readiness).toMatchObject({ ready: false, continuity: 'stale' })
    const historicalReview = currentTerminalReview({ terminalCandidate: candidate, continuityCriticResponse: inspected.audit,
      independentCheck: 'complete' }, chapter.content, { ...context, proposalChanges: staged.changes })
    expect(historicalReview).toMatchObject({ supported: false })
    expect(JSON.stringify(inspected.audit)).toContain(proposal.claim)
    expect(JSON.stringify(inspected.audit)).toContain(reason)
    if (scenario === 'recover-quality-decision') {
      expect(readiness).toMatchObject({ ready: false, decisionPending: true, mustPassPending: false })
      expect(readiness?.requiredDecisions).toHaveLength(1)
    }
    const key = runtimeJson({ kind: 'terminal-processing', version: 1, userId: f.userId, novelId: f.novelId, taskId: spec.id, chapterId: chapter.id,
      contentHash: runtimeJson({ content: chapter.content }).hash, sourceHash: runtimeJson({ source }).hash,
      contractHash: runtimeJson(inspected.audit).hash }).hash
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
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
    if (scenario === 'recover-missing-commit') {
      const availableTools = agents.getToolsForAgent
      vi.spyOn(agents, 'getToolsForAgent').mockImplementation((...args) => availableTools(...args).filter(tool => tool.name !== 'chapter_bridge_commit'))
    }
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const history = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    const missingCommit = scenario === 'recover-missing-commit'
    if (scenario === 'recover-unknown-commit') {
      // An orphan local call is reconciled against its atomic database effect.
      // The original critic is settled; no provider request is unknown.
      expect(before).toMatchObject({ id: compilation.id, userId: f.userId, novelId: f.novelId, chapterId: chapter.id,
        bridge: { toChapterId: chapter.id, committedAt: null } })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ revision: chapter.revision, content: chapter.content })
      expect(historicalUsage).toMatchObject({ billingStatus: 'settled', usageSource: 'reported', reservedCreditMilli: 0 })
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId, billingStatus: 'pending_usage' } })).toBe(0)
    }
    const completed = await continueCurrentReviewWorkflow(f, { compilationId: compilation.id, prompt: recoveryPrompt, afterSeq: pauseSeq,
      authorContinue: { eventId: pause.id, afterSeq: pauseSeq }, missingCommit, readFirst: scenario === 'after-read' })
    expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { lte: pauseSeq } }, orderBy: { seq: 'asc' } })).toEqual(history)
    expect((completed.compilation.validation as { continuityCriticResponse: unknown }).continuityCriticResponse)
      .toEqual((before.validation as { continuityCriticResponse: unknown }).continuityCriticResponse)
    expect(completed.compilation.preparedContext).toMatchObject(before.preparedContext as object)
    expect(completed.run).toMatchObject({ taskSpec: spec, modelTier: beforeRun.modelTier,
      customModelId: beforeRun.customModelId, reasoningEffort: beforeRun.reasoningEffort })
    expect((completed.run.usage as { checkpoint: typeof checkpoint }).checkpoint.reviewAttempts).toEqual(expect.arrayContaining(claims))
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: historicalUsage.id } })).toEqual(historicalUsage)
    expect(await prisma.creditLedgerEntry.findUniqueOrThrow({ where: { id: historicalCharge.id } })).toEqual(historicalCharge)
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } }))
      .toMatchObject({ ...account, dailyUsedMilli: account.dailyUsedMilli + completed.actions.length * 7 })
    if (missingCommit) {
      expect(completed.chapter).toEqual(chapter)
      expect(completed.compilation.bridge).toEqual(before.bridge)
      expect(completed.actions).toEqual([])
      expect(completed.events.filter(event => event.type === 'tool.call')).toEqual([])
    } else {
      expect(completed.chapter).toMatchObject({ revision: chapter.revision + 2 })
      expect(completed.chapter.content.trim()).toBe(chapter.content)
      expect(completed.main).toHaveBeenCalled()
      expect(completed.critic).toHaveBeenCalled()
      expect(completed.events.filter(event => event.type === 'tool.result' && !(event.payload as { ok: boolean }).ok)).toEqual([])
      for (let repeated = 0; repeated < 2; repeated++) await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(completed.run)
      if (scenario === 'recover-unknown-commit') expect(completed.events.filter(event =>
        (event.payload as { callId?: string }).callId === `terminal_commit_${key.slice(0, 40)}`)).toEqual([])
    }
  }, undefined, recoveryPrompt, { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)

  it.each([...(['settled', 'unknown'] as const).flatMap(billing => (['commit', 'repeat', 'restart'] as const).map(scenario => [billing, scenario] as const)), ...(['old-slots', 'local-refusal', 'consumed-local-candidate', 'objects', 'source-address', 'commit-reserved', 'commit-unknown', 'multiple-candidates', 'no-proposal'] as const).map(scenario => ['settled', scenario] as const)])(
    'preserves settled history and blocks unresolved provider outcomes: %s / %s', (billing, scenario) => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
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
      const ctx: ToolContext = { ...f, callId: 'initial-known-unknown', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
        signal: new AbortController().signal, emit: () => {} }
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
    // Legacy candidate judgments are inspectable history; only a current prose
    // report satisfies the new required check, even for settled UNKNOWN.
    expect(originalChapterReviewRequirements({ prompt: original.prompt, spec })).toEqual({ continuity: true, quality: true })
    expect(readiness).toMatchObject({ ready: false, quality: 'complete', continuity: 'stale', requiredTools: [{ name: 'continuity_validate' }] })
    expect(readiness?.progressEvidence?.phases).not.toContain('continuity')
    expect(readiness?.progressEvidence?.phases).not.toContain('terminal')
    const processingKey = runtimeJson({ historicalAudit: audit, compilationId: compilation.id, revision: chapter.revision }).hash
    const slots = Array.from({ length: 4 }, (_, index) => runtimeJson({ historicalFeedback: processingKey, index }).hash)
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
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const originalUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const originalAccount = await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })
    const originalLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const unknown = billing === 'unknown'
    if (scenario === 'commit-unknown') {
      expect(before).toMatchObject({ id: compilation.id, userId: f.userId, novelId: f.novelId, chapterId: chapter.id,
        bridge: { toChapterId: chapter.id, committedAt: null } })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ revision: chapter.revision, content: body })
      expect(originalUsage.every(row => row.billingStatus === 'settled' && row.usageSource === 'reported' && row.reservedCreditMilli === 0)).toBe(true)
    }
    const completed = await continueCurrentReviewWorkflow(f, { compilationId: compilation.id, prompt: '修复本章', afterSeq: pauseSeq,
      authorContinue: { eventId: pause.id, afterSeq: pauseSeq }, unknown, readFirst: scenario === 'restart', setupAfterRecovery: scenario === 'local-refusal' })
    if (scenario === 'restart' || scenario === 'repeat') {
      const last = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
      const mainCalls = completed.main.mock.calls.length, criticCalls = completed.critic.mock.calls.length
      await executeAgentRun({ ...f, prompt: '修复本章', mode: 'build', resume: true, authorContinue: { eventId: last.id, afterSeq: last.seq }, eventStartSeq: last.seq,
        modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
      expect(completed.main).toHaveBeenCalledTimes(mainCalls)
      expect(completed.critic).toHaveBeenCalledTimes(criticCalls)
    }
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: originalUsage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(originalUsage)
    expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: originalLedger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } }))
      .toMatchObject({ ...originalAccount, dailyUsedMilli: originalAccount.dailyUsedMilli + completed.actions.length * 7 })
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old)
    expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { lte: pauseSeq } }, orderBy: { seq: 'asc' } })).toEqual(history)
    const final = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect((final.validation as { continuityCriticResponse: unknown }).continuityCriticResponse)
      .toEqual((before.validation as { continuityCriticResponse: unknown }).continuityCriticResponse)
    expect(final.preparedContext).toMatchObject(before.preparedContext as object)
    if (scenario === 'commit-unknown') expect(completed.events.filter(event =>
      (event.payload as { callId?: string }).callId === `terminal_commit_${processingKey.slice(0, 40)}`)).toEqual([])
    const resumed = run.usage as { checkpoint: typeof checkpoint }
    expect(resumed.checkpoint.reviewAttempts).toEqual(expect.arrayContaining(checkpoint.reviewAttempts))
    expect(resumed.checkpoint.consumedReviewDecisionFeedback ?? []).toEqual(checkpoint.consumedReviewDecisionFeedback ?? [])
    if (unknown) {
      expect(final).toEqual(before)
      expect(run.status).toBe('paused')
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalUsage)
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
      expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, seq: { gt: pauseSeq }, type: 'tool.call' } })).toBe(0)
      if (billing === 'unknown') expect(resumed.checkpoint.pendingReviews).toEqual(checkpoint.pendingReviews)
    } else {
      expect(run.status).toBe('completed')
      expect(completed.chapter.content.trim()).toBe(body)
      expect(completed.chapter.revision).toBe(chapter.revision + 2)
      expect(completed.main).toHaveBeenCalled()
      expect(completed.critic).toHaveBeenCalled()
      expect(completed.events.filter(event => event.type === 'tool.result' && !(event.payload as { ok: boolean }).ok)).toEqual([])
    }
    if (knownRepeatUsage) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: knownRepeatUsage.id } })).toEqual(knownRepeatUsage)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: knownRepeatArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } }))
      .toEqual([...knownRepeatArtifacts].sort((left, right) => left.id.localeCompare(right.id)))
  }, undefined, '修复本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 1 }), 30000)
})
