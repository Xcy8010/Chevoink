import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema, terminalReviewFailure } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { observeChapterReviewProgress } from '../../api/lib/agent/semantic-progress.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'

const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)

describe.runIf(available)('complete UNKNOWN report does not authorize another judgment', () => {
  it.each(['continue', 'repeat'] as const)('preserves the original report and exact phase gap: %s', async scenario => fixture(async f => {
    const prompt = '修改本章', body = 'The sensor remains offline.', started = Date.now() - 5000
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 15, content: body, wordCount: body.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: prompt })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Synthetic repair record', entryState: empty, goal: 'Record sensor', obstacle: 'Offline', choice: 'Record', cost: 'Time', turn: 'Repair pending', exitState: empty,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The sensor has been repaired.'] } })
    const assess = async (value: typeof candidate, status: 'unknown' | 'supported') => {
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
      const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
      const evidence = terminalEvidenceContext(chapter, source, 2, 1, terminalCoverageInput(original.spec, saved.preparedContext, chapter, value, 2), 2)
      const response = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic whole-body judgment.', findingIndexes: [] })),
        terminalVerdicts: [{ path: 'exitState.objects.0', verdict: status, sourceEvidence: [{ segmentId: 'c0', quote: body }] }], terminalDispositions: [] })
      const inspected = inspectContinuityResponse(response, { previous: source?.content ?? null, current: body, terminalEvidence: evidence }, true, 8, value)
      expect(inspected.complete).toBe(true)
      const result = await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: 15, findings: [], independentCheck: 'complete', terminalCandidate: value,
        coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: value }, 11), continuityCriticResponse: inspected.audit })
      return terminalReviewFailure({ ...result, continuityCriticResponse: inspected.audit }, body, evidence)
    }
    expect(await assess(candidate, 'unknown')).toMatchObject({ reviewCompleted: true })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: 15, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    expect(readiness).toMatchObject({ ready: true, terminalReview: { state: 'unverified' } })
    const seen = new Set<string>()
    expect(observeChapterReviewProgress(seen, { ...readiness!.progressEvidence!, phases: ['continuity', 'quality'] }, { ...f, taskSpec: original.spec as typeof f.spec, expectedOriginalTaskId: original.taskId })).toBe(true)
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 100, stagnantBatches: 7, runStartedAt: started,
      resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0, progressSignatures: [...seen],
      reviewAttempts: ['old-continuity-attempt', `settled-continuity:${compilation.id}:${chapter.id}:15:continuity_validate:protocol8`], inheritedTokens: 0, inheritedTurns: 0, manualResumeCount: 0 }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 18, startedAt: new Date(started), usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, checkpoint } } })
    await prisma.agentRunEvent.createMany({ data: [{ runId: f.runId, seq: 1, type: 'run.started', payload: {}, createdAt: new Date(started) },
      { runId: f.runId, seq: 2, type: 'tool.call', payload: { callId: 'old-unknown', toolName: 'continuity_validate', args: { compilationId: compilation.id } }, createdAt: new Date(started + 20) },
      { runId: f.runId, seq: 3, type: 'tool.result', payload: { callId: 'old-unknown', toolName: 'continuity_validate', ok: false, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' }, createdAt: new Date(started + 80) },
      { runId: f.runId, seq: 4, type: 'run.paused', payload: { reason: 'model_stalled' }, createdAt: new Date(started + 100) }] })
    const historical = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture', multiplierBps: 10000,
      reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
    const requests: Array<{ url: unknown; body: string }> = []
    const network = vi.fn(async (url: unknown, init: RequestInit) => {
      // Contract assertions run outside fetch: an assertion thrown here is
      // correctly treated as an unknown provider result by real billing.
      requests.push({ url, body: String(init.body) })
      const response = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic whole-body judgment.', findingIds: [] })),
        terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [],
        proposalDispositions: [{ proposalIndex: 0, outcome: 'replaced',
          reason: 'The saved body establishes that the sensor remains offline rather than repaired.', candidateIndex: 0,
          sourceEvidence: [{ segmentId: 'c0' }] }] })
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: response }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', network)
    const frozen = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const main = vi.spyOn(ai, 'chatWithTools').mockRejectedValue(Error('Continue cannot purchase a candidate-selection main turn'))
    await executeAgentRun({ ...f, prompt, mode: 'build', resume: true, eventStartSeq: 4, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    if (scenario === 'repeat') {
      const latest = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
      await executeAgentRun({ ...f, prompt, mode: 'build', resume: true, eventStartSeq: latest.seq, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced', authorContinue: true })
    }
    expect(main).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    const savedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const state = (savedRun.usage as { checkpoint: typeof checkpoint }).checkpoint
    expect(savedRun.status).toBe('paused')
    expect(state.reviewAttempts).toContain('old-continuity-attempt')
    expect(state.progressSignatures).toEqual(expect.arrayContaining([...seen]))
    expect(state.writeProgress).toBe(checkpoint.writeProgress)
    expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { lte: 4 } }, orderBy: { seq: 'asc' } })).toEqual(historical)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(frozen)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ revision: 15, content: body })
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).committedAt).toBeNull()
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, seq: { gt: 4 }, type: 'tool.result', payload: { path: ['ok'], equals: false } } })).toBe(0)
  }, undefined, '修改本章', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 1 }), 30000)
})
