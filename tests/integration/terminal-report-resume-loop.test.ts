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

describe.runIf(available)('complete terminal report resumes through processing and real commit', () => {
  it.each(['commit', 'repeat'] as const)('preserves the original stalled task and permits only genuine next work: %s', async scenario => fixture(async f => {
    const prompt = '修改本章', body = 'The sensor remains offline.', started = Date.now() - 5000
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 15, content: body, wordCount: body.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: prompt })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Synthetic repair record', entryState: empty, goal: 'Record sensor', obstacle: 'Offline', choice: 'Record', cost: 'Time', turn: 'Repair pending', exitState: empty,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The sensor has been repaired.'] } })
    const accurate = terminalCandidateSchema.parse({ exitState: { objects: [body] } })
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
    let turn = 0
    const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async () => {
      turn++
      if (turn > 8) throw new Error('Repeated observations must still stop')
      const call = scenario === 'repeat' ? { id: `same-report-${turn}`, name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: compilation.id }) }
        : turn === 1 ? { id: 'correct-candidate', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id, terminalState: accurate }) }
          : turn === 2 ? { id: 'real-commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId: compilation.id }) } : undefined
      return { content: call ? '' : 'Completed.', reasoning: '', finishReason: call ? 'tool_calls' : 'stop', toolCalls: call ? [call] : [],
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...f, prompt, mode: 'build', resume: true, eventStartSeq: 4, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    expect(main).toHaveBeenCalled()
    expect(network).toHaveBeenCalledTimes(scenario === 'commit' ? 1 : 0)
    if (scenario === 'commit') {
      expect(requests[0].url).toBe('https://provider.invalid/v1/chat/completions')
      const request = JSON.parse(requests[0].body)
      expect(request.messages.at(-1).content).toContain(body)
      const frozenRequest = JSON.parse(request.messages.at(-1).content)
      expect(frozenRequest.catalog.terminal).toMatchObject({ ordinary: [{ claimIndex: 0, field: 'objects', claim: body }],
        candidates: [{ claimIndex: 0, field: 'objects', claim: body }], proofs: [], obligations: [],
        proposals: [{ proposalIndex: 0, field: 'objects', claim: candidate.exitState.objects[0] }] })
    }
    const criticUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, agentRunId: f.runId, action: 'agent3ContinuityCritic' } })
    expect(criticUsage).toHaveLength(scenario === 'commit' ? 1 : 0)
    const savedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const finalBridge = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })
    const state = (savedRun.usage as { checkpoint: typeof checkpoint }).checkpoint
    expect(state.reviewAttempts).toContain('old-continuity-attempt')
    expect(state.progressSignatures).toEqual(expect.arrayContaining([...seen]))
    expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { lte: 4 } }, orderBy: { seq: 'asc' } })).toEqual(historical)
    expect(state.progressSignatures.filter(key => key.endsWith(',"terminal"]'))).toHaveLength(1)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ revision: 15, content: body })
    if (scenario === 'commit') {
      expect(criticUsage[0]).toMatchObject({ billingStatus: 'settled', usageSource: 'reported', reservedCreditMilli: 0, requestTokens: 10, responseTokens: 0 })
      expect(finalBridge.committedAt).not.toBeNull()
      expect(finalBridge.objectState).toEqual([body])
      expect(savedRun.status).toBe('completed')
      expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, seq: { gt: 4 }, type: 'tool.result', payload: { path: ['ok'], equals: false } } })).toBe(0)
    } else {
      expect(finalBridge.committedAt).toBeNull()
      expect(state.stagnantBatches).toBeGreaterThanOrEqual(4)
      expect(savedRun.status).toBe('paused')
      expect((await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id)))?.terminalReview?.state).toBe('unverified')
    }
  }, undefined, '修改本章', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 1 }), 30000)
})
