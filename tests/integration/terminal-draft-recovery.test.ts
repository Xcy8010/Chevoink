import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { persistHumanityQualityReport, buildHumanityQualityContext, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { terminalProcessingPlan } from '../../api/lib/agent/terminal-processing.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import { observeChapterReviewProgress } from '../../api/lib/agent/semantic-progress.js'
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { freezeWritingScope, bindWritingChapter } from '../../api/lib/agent/writing-scope.js'
import { createHash } from 'node:crypto'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'

describe.runIf(available)('authenticated never-verified persistent draft recovery', () => {
  it.each([{ crossRevision: false, prompt: '修改第一章，只输出标题和正文' }, { crossRevision: true, prompt: '写第一章，只输出标题和正文' }])(
    'reuses the cache, retains quality decisions and preserves exhausted evidence (crossRevision=$crossRevision)', ({ crossRevision, prompt }) => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((name, owner) => name === 'storyCompiler' || name !== 'memory2' && feature(name, owner))
    const startedAt = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).createdAt
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt } } })
    const claims = Array.from({ length: 36 }, (_, i) => `Entry ${i} remains recorded.`)
    const content = `The packet remains sealed. ${claims.join(' ')}`
    const beforeContent = crossRevision ? content.replace('remains sealed', 'remains securely sealed') : content
    if (crossRevision) {
      // This isolated fixture admits an empty-book first chapter, then binds
      // its frozen null slot through the ordinary server binding function.
      const old = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      await prisma.$transaction(async tx => {
        await tx.chapter.delete({ where: { id: old.id } })
        f.spec = await freezeWritingScope(tx, f, f.spec, prompt)
        expect(f.spec.scope.writing).toMatchObject({ kind: 'bounded', repairAuthorized: false, targets: [{ chapterId: null, orderIndex: 1 }] })
        await tx.agentRun.update({ where: { id: f.runId }, data: { taskSpec: JSON.parse(JSON.stringify(f.spec)), chapterId: null } })
        await tx.chapter.create({ data: { id: old.id, authorId: f.userId, novelId: f.novelId, volumeId: old.volumeId, title: old.title,
          orderIndex: 1, orderInVolume: 1, content: beforeContent, wordCount: beforeContent.length, revision: 3 } })
        await bindWritingChapter(tx, f, 1, old.id)
        await tx.agentRun.update({ where: { id: f.runId }, data: { chapterId: old.id } })
      })
    }
    let chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: beforeContent, revision: crossRevision ? 3 : 4, wordCount: beforeContent.length } })
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.', ...claims.slice(30)], knowledge: claims.slice(0, 30) } })
    expect(terminalCandidateFacts(candidate)).toHaveLength(37)
    const base = terminalCandidateSchema.parse({ exitState: crossRevision ? { emotion: ['A reply remains pending.'] } : { openLoops: ['A reply remains pending.'] } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Record', entryState: candidate.exitState, goal: 'Record', obstacle: 'Time',
      choice: 'Wait', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: chapter.revision })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const coverage = (terminalCandidate: typeof candidate) => compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null, terminalCandidate }, 11)
    const targetChapter = { ...chapter, content, revision: 4, wordCount: content.length }
    const synthetic = terminalDraftFixture(crossRevision ? 'emotion' : 'openLoops', { chapter: targetChapter, originChapter: chapter,
      taskId: f.spec.id, ctx: f, compilationId: compilation.id, candidate,
      originBindingHash: runtimeJson(coverage(base)).hash, currentBindingHash: runtimeJson(compilerContinuityCoverage({ chapter: targetChapter,
        bridge: { ...saved.bridge, targetRevision: 4 }, sceneTasks: saved.sceneTasks, source: null, terminalCandidate: candidate }, 11)).hash })
    if (crossRevision) {
      const wire = { ...synthetic.currentWire, findings: [{ signal: 'object', severity: 'warning', evidence: 'The source says “a missing quotation”.',
        suggestion: 'Check the actual source.', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: 'a missing quotation' }] }] }
      expect(synthetic.inspect(wire, synthetic.nextInput).audit.classification).toBe('source_invalid')
      synthetic.add('pending-only-failure', synthetic.nextInput, wire)
    }
    const window = credits.getCreditWindow()
    const account = await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, dailyUsedMilli: synthetic.usage.length * 23,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const usage = [], ledger = [], usageIds = new Map<string, string>()
    for (const row of synthetic.usage) {
      const value = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed',
        multiplierBps: 10000, action: 'agent3ContinuityCritic', requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled',
        reservedCreditMilli: 0, creditChargeMilli: 23, billingEvidence: { responseObserved: true }, durationMs: 0 } })
      usage.push(value); usageIds.set(String(row.id), value.id)
      ledger.push(await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: value.id,
        idempotencyKey: `synthetic-draft:${value.id}`, deltaMilli: -23, dailyDeltaMilli: -23, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } }))
    }
    const artifacts = []
    for (const row of synthetic.rows) {
      const metadata = { ...row.metadata }
      if (Array.isArray(metadata.usageIds)) metadata.usageIds = metadata.usageIds.map(id => usageIds.get(String(id)))
      if (metadata.assessmentResponseKey) metadata.assessmentResponseKey = runtimeJson({ assessmentKey: metadata.assessmentKey, stage: 'first', usageIds: metadata.usageIds }).hash
      artifacts.push(await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Synthetic paid independent evidence',
        content: 'Synthetic independent evidence.', metadata: runtimeJson(metadata).value } }))
    }
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, terminalCandidate: synthetic.base,
      findings: [], independentCheck: 'complete', coverage: coverage(base), continuityCriticResponse: synthetic.bound.audit })
    if (crossRevision) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex'), start = beforeContent.indexOf('securely sealed')
      const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
        compilationId: compilation.id, chapterId: chapter.id, chapterRevision: 4, mode: 'balanced', status: 'repaired', repairRound: 1,
        deterministicMetrics: { independentCheck: 'complete', sourceRevision: 3, contentHash: hash(beforeContent), repairedContentHash: hash(content) },
        findings: { create: [{ userId: f.userId, novelId: f.novelId, signal: 'reader_pull', source: 'critic', severity: 'warning',
          startOffset: start, endOffset: start + 'securely sealed'.length, evidenceExcerpt: 'securely sealed', evidenceHash: hash('securely sealed'),
          explanation: 'Synthetic bounded quality repair.', suggestion: 'Preserve the sealing fact.', disposition: 'repaired' }] } }, include: { findings: true } })
      artifacts.push(await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'rewriteSelection', title: 'Synthetic consumed quality repair',
        content: JSON.stringify([{ findingId: report.findings[0].id, replacement: 'sealed' }]), metadata: { phase: 'humanity_revision_auto', reportId: report.id,
          findingIds: [report.findings[0].id], sourceRevision: 3, targetRevision: 4 } } }))
      await prisma.agentMessage.create({ data: { runId: f.runId, sessionId: f.sessionId, role: 'assistant', parts: [{ type: 'tool-call', callId: 'synthetic-quality-repair',
        toolName: 'quality_analyze', status: 'success', display: { kind: 'qualityReport', status: 'repaired', reportId: report.id,
          chapterId: chapter.id, chapterRevision: 4, repairRound: 1 }, snapshot: { target: 'chapter', targetId: chapter.id, field: 'content', previousValue: beforeContent } }] } })
      chapter = await prisma.chapter.update({ where: { id: chapter.id }, data: { content, revision: 4, wordCount: content.length } })
      await prisma.chapterBridge.update({ where: { compilationId: compilation.id }, data: { targetRevision: 4 } })
      const prior = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...(prior.validation as Record<string, unknown>),
        newDraftRevision: { version: 1, taskId: f.spec.id, chapterId: chapter.id, compilationId: compilation.id, checkedRevision: 3,
          beforeHash: runtimeJson({ content: beforeContent }).hash, afterHash: runtimeJson({ content }).hash, retainedFindings: [] } }).value } })
    }
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, terminalCandidate: candidate,
      findings: [], independentCheck: 'complete', coverage: crossRevision ? compilerContinuityCoverage({ chapter, bridge: { ...saved.bridge, targetRevision: 4 },
        sceneTasks: saved.sceneTasks, source: null, terminalCandidate: candidate }, 11) : coverage(candidate), continuityCriticResponse: synthetic.validation.continuityCriticResponse })
    const qualityContextHash = qualityReviewContextHash(await buildHumanityQualityContext(f.userId, f.novelId, chapter.id, f.runId))
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced',
      criticComplete: true, criticFindings: [{ signal: 'reader_pull', severity: 'warning', quote: 'The packet remains sealed.',
        explanation: 'The inventory is deliberately quiet.', suggestion: 'Review pacing while preserving the recorded facts.', confidence: 0.8 }],
      deterministicFindings: [], deterministicMetrics: {}, qualityContextHash })
    const network = vi.fn(() => { throw Error('No provider request is authorized in this recovery regression') })
    vi.stubGlobal('fetch', network)
    const critic = vi.spyOn(ai, 'generateTextCompletion').mockImplementation(async () => { throw Error('No new critic judgment') })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
      multiplierBps: 10000, reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    const cached = await continuityValidateTool.execute({ ...f, callId: 'synthetic-current-cache', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} }, { compilationId: compilation.id })
    expect(cached).toMatchObject({ summary: expect.stringContaining('复用') }); expect(cached.outcome).toBeUndefined()
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    expect(readiness).toMatchObject({ ready: true, decisionPending: true, mustPassPending: false,
      terminalReview: { state: 'unverified', deliveryEligible: true, unresolved: [{ verdict: 'unknown', field: crossRevision ? 'emotion' : 'openLoops' }] } })
    expect(readiness!.requiredDecisions).toHaveLength(1)
    expect(readiness!.decisionFeedback).toBeDefined()
    const episode = terminalProcessingPlan({ ...readiness!, terminalReview: { ...readiness!.terminalReview!, deliveryEligible: false } }, { ...f, taskSpec: f.spec }, new Set())!
    expect(episode.kind).toBe('process')
    const processingClaims = [0, 1].map(index => `terminal-processing:${episode.key}:${index}`), consumedFeedback = [readiness!.decisionFeedback!.key]
    const seen = new Set<string>(); observeChapterReviewProgress(seen, readiness!.progressEvidence, { ...f, taskSpec: f.spec, expectedOriginalTaskId: f.spec.id })
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', payload: { reason: 'model_stalled' } } })
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default',
      activeExecutionMs: recoverRunElapsedMs(startedAt.getTime(), pause.createdAt.getTime(), [{ type: 'run.paused', at: pause.createdAt.getTime() }]),
      runStartedAt: startedAt.getTime(), stagnantBatches: 7, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0, progressSignatures: [...seen], reviewAttempts: processingClaims,
      consumedReviewDecisionFeedback: consumedFeedback, pendingReviews: [], inheritedTokens: 10, inheritedTurns: 16, manualResumeCount: 0 }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 16, startedAt,
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, checkpoint } } })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }), beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async () => {
      expect(main).toHaveBeenCalledOnce()
      return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'synthetic-quality-decision', name: 'chapter_bridge_commit',
        arguments: JSON.stringify({ compilationId: compilation.id, retainedFindings: readiness!.requiredDecisions!.map(ref => ({ ...ref,
          reason: 'The quiet inventory is intentional; retain this warning and preserve every established fact.' })) }) }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...f, prompt, mode: 'build', resume: true, authorContinue: { eventId: pause.id, afterSeq: 1 }, eventStartSeq: 1,
      modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } }), after = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const failures = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.result', payload: { path: ['ok'], equals: false } }, select: { payload: true } })
    expect({ status: finished.status, errorMessage: finished.errorMessage, failures }).toEqual({ status: 'completed', errorMessage: null, failures: [] })
    expect(finished).toMatchObject({ taskSpec: beforeRun.taskSpec, modelTier: beforeRun.modelTier, customModelId: beforeRun.customModelId, reasoningEffort: beforeRun.reasoningEffort })
    expect(after).toMatchObject({ status: 'completed', stage: 'commit' })
    expect((after.preparedContext as Record<string, unknown>).terminalProposalReview).toEqual((before.preparedContext as Record<string, unknown>).terminalProposalReview)
    expect((after.validation as Record<string, unknown>).continuityCriticResponse).toEqual((before.validation as Record<string, unknown>).continuityCriticResponse)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ terminalCommitted: true, decisionPending: false,
      terminalReview: { state: 'unverified', deliveryEligible: true, unresolved: [{ verdict: 'unknown', field: crossRevision ? 'emotion' : 'openLoops' }] } })
    const persisted = (finished.usage as { checkpoint: { reviewAttempts: string[]; consumedReviewDecisionFeedback: string[] } }).checkpoint
    expect(persisted.reviewAttempts).toEqual(processingClaims); expect(persisted.consumedReviewDecisionFeedback).toEqual(consumedFeedback)
    expect((await readTerminalInheritance(prisma, f, chapter)).map(fact => fact.claim).sort()).toEqual(terminalCandidateFacts(candidate).map(fact => fact.claim).sort())
    for (let i = 0; i < 2; i++) await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
    const nextRunId = randomUUID(), nextPrompt = '写下一章'
    const nextChapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Synthetic next chapter',
      content: 'The inventory is continued.', orderIndex: 2, orderInVolume: 2, revision: 1 } })
    const nextSpec = buildTaskSpec({ runId: nextRunId, novelId: f.novelId, chapterId: nextChapter.id, prompt: nextPrompt,
      continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 })
    await prisma.agentRun.create({ data: { id: nextRunId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: nextChapter.id,
      mode: 'act', status: 'running', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
      taskSpec: JSON.parse(JSON.stringify(nextSpec)), startRequest: { prompt: nextPrompt } } })
    const inherited = await readCompilerContinuitySource(prisma, { ...f, runId: nextRunId }, nextChapter, chapter.id, 11)
    expect(nextSpec.id).not.toBe(f.spec.id)
    expect(inherited && 'terminalInheritance' in inherited ? inherited.terminalInheritance.map(fact => fact.claim).sort() : []).toEqual(terminalCandidateFacts(candidate).map(fact => fact.claim).sort())
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(artifacts))
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(byId(usage))
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(byId(ledger))
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(account)
    expect(main).toHaveBeenCalledOnce(); expect(critic).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(finished)
  }, undefined, prompt, { freezeWriting: !crossRevision, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
