import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { terminalFeedbackSlots, terminalCorrectionReceiptKey } from '../../api/lib/agent/terminal-feedback-handoff.js'
import { observeChapterReviewProgress, observeSemanticReadProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
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

describe.runIf(available)('authenticated native review hands a rejected current-state candidate back to the original task', () => {
  it.each((['settled', 'unknown'] as const).flatMap(billing => (['commit', 'repeat', 'restart'] as const).map(scenario => [billing, scenario] as const)))(
    'preserves failed requests and permits bounded candidate processing: %s / %s', (billing, scenario) => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const body = 'He stops at the control-room doorway, before turning the wheel.', accurate = 'At the control-room doorway, before crossing it.'
    const bad = terminalCandidateSchema.parse({ exitState: { location: 'Inside the first door of the control room.', action: 'Preparing to turn the first-door wheel.' }, lastUnfinishedAction: 'The first-door wheel has not been turned.' })
    const good = terminalCandidateSchema.parse({ exitState: { location: accurate, action: 'Preparing to turn the control-room doorway wheel.' }, lastUnfinishedAction: 'The doorway wheel has not been turned.' })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2, revision: 8, content: body, wordCount: body.length } })
    await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Synthetic predecessor', orderIndex: 1, orderInVolume: 1, revision: 15,
      content: 'He crossed the first door, the middle chamber, then the second door into the control room.', wordCount: 90 } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt: '修复本章' } } })
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
    const rejected = { findings: [], semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(bad).map(fact => ({ factId: fact.id, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }, ...(fact.field === 'location' ? [{ segmentId: 'p0' }] : [])] })), terminalProofVerdicts: [], terminalDispositions: [] }
    const inspected = inspectContinuityResponse(JSON.stringify(rejected), { current: body, previous: source!.content, terminalEvidence: evidence }, true, 8, bad)
    expect(inspected).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', terminalReviewDiagnostics: [{ code: 'inheritance_invalid', path: 'exitState.location' }] } })
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: 8, independentCheck: 'unavailable', findings: [], terminalCandidate: bad,
      coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: bad }, 11), continuityCriticResponse: inspected.audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: 8, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    expect(readiness?.terminalCorrection).toMatchObject({ paths: ['exitState.location'] })
    expect(readiness).toMatchObject({ quality: 'complete', requiredTools: [{ name: 'continuity_validate' }] })
    expect(readiness?.progressEvidence?.phases).not.toContain('terminal')
    const slots = terminalFeedbackSlots(readiness, { ...f, taskSpec: spec })!
    expect(slots).toHaveLength(4)
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
    const start = checkedAt - 1000, at = (ms: number) => new Date(start + ms)
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
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: at(1002), payload: { reason: 'model_stalled' } } })
    const history = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 200, stagnantBatches: 7, runStartedAt: start, resumeCount: 0, compactionCount: 0,
      maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0, progressSignatures: [...seen], reviewAttempts: ['old-attempt'],
      pendingReviews: billing === 'unknown' ? [{ compilationId: compilation.id, chapterId: chapter.id, revision: 8, toolName: 'continuity_validate', callId: 'original-ended' }] : [],
      consumedReviewDecisionFeedback: [] as string[], inheritedTokens: 0, inheritedTurns: 0, manualResumeCount: 0 }
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
      if (calls > 3) throw Error('No extra critic request is permitted')
      const parts = calls <= 2 ? { ...rejected, ...(calls === 2 ? { decisions: [] } : {}) }
        : { findings: [], semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(good).map(fact => ({ factId: fact.id, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })), terminalProofVerdicts: [], terminalDispositions: [] }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(parts) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', network)
    let turn = 0, interrupted = false
    let firstFeedback: string[] | undefined
    const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async ({ messages }) => {
      if (main.mock.calls.length > (scenario === 'restart' ? 6 : 5)) throw Error('Bounded candidate processing must terminate')
      if (turn === 0) {
        expect(JSON.stringify(messages)).toContain('terminalPatch')
        // Both real bootstrap requests must finish before the original task
        // sees feedback; each original request keeps its exact billing truth.
        expect(network).toHaveBeenCalledTimes(2)
        const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { gt: 3 } }, orderBy: { seq: 'asc' } })
        const bootstrap = events.filter(event => event.type === 'tool.call' && String((event.payload as { callId?: string }).callId).startsWith('continued_review_'))
        expect(bootstrap).toHaveLength(1)
        expect(events.find(event => event.type === 'tool.result' && (event.payload as { callId?: string }).callId === (bootstrap[0].payload as { callId: string }).callId)?.payload)
          .toMatchObject({ ok: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' })
        const current = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        const cp = (current.usage as { checkpoint: typeof checkpoint }).checkpoint
        expect(cp.pendingReviews ?? []).toEqual([])
        expect(cp.consumedReviewDecisionFeedback).toContain(terminalCorrectionReceiptKey(slots))
        expect(cp.reviewAttempts.some(key => key.startsWith(billing === 'settled' ? 'continuity-author-recovery:' : 'author-continued-review:'))).toBe(true)
        expect(cp.stagnantBatches).toBeGreaterThanOrEqual(7)
        if (scenario === 'restart' && !interrupted) {
          expect(cp.consumedReviewDecisionFeedback.filter(key => slots.includes(key))).toEqual([slots[0]])
          firstFeedback = cp.consumedReviewDecisionFeedback
          interrupted = true
          throw new DOMException('Synthetic interruption after the actual handoff checkpoint', 'AbortError')
        }
        if (scenario === 'restart') {
          expect(cp.consumedReviewDecisionFeedback).toEqual(expect.arrayContaining(firstFeedback!))
          expect(cp.consumedReviewDecisionFeedback.filter(key => slots.includes(key))).toEqual(slots.slice(0, 2))
        }
      }
      turn++
      const call = turn === 1 ? { id: 'read-real-body', name: 'chapter_read', arguments: JSON.stringify({ chapterId: chapter.id }) }
        : turn === 2 ? { id: 'read-saved-candidate', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: compilation.id }) }
        : turn === 3 ? { id: 'correct-only-candidate', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id, terminalPatch: scenario === 'repeat'
          ? { baseCandidateHash: runtimeJson(bad).hash }
          : { baseCandidateHash: runtimeJson(bad).hash, removeFactIds: terminalCandidateFacts(bad).map(fact => fact.id), addFacts: terminalCandidateFacts(good).map(({ field, claim }) => ({ field, claim })) } }) }
        : turn === 4 ? { id: scenario === 'repeat' ? 'read-rejected-again' : 'actual-commit', name: scenario === 'repeat' ? 'chapter_bridge_get' : 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId: compilation.id }) } : undefined
      return { content: call ? '' : 'Completed.', reasoning: '', finishReason: call ? 'tool_calls' : 'stop', toolCalls: call ? [call] : [], usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...f, prompt: '修复本章', mode: 'build', resume: true, authorContinue: { eventId: pause.id, afterSeq: 3 }, eventStartSeq: 3, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    if (scenario === 'restart') {
      expect(main).toHaveBeenCalledOnce()
      expect(network).toHaveBeenCalledTimes(2)
      const interruptedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      expect(interruptedRun.status).toBe('paused')
      expect((interruptedRun.usage as { checkpoint: typeof checkpoint }).checkpoint.consumedReviewDecisionFeedback).toEqual(firstFeedback)
      const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
      const stop = events.filter(event => event.type === 'run.paused').at(-1)!
      expect(stop.seq).toBeGreaterThan(3)
      const afterSeq = events.at(-1)!.seq
      await executeAgentRun({ ...f, prompt: '修复本章', mode: 'build', resume: true, authorContinue: { eventId: stop.id, afterSeq }, eventStartSeq: afterSeq, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    }
    expect(network).toHaveBeenCalledTimes(scenario === 'repeat' ? 2 : 3)
    expect(main.mock.calls.length).toBeGreaterThanOrEqual(scenario === 'restart' ? 4 : 3)
    expect(main.mock.calls.length).toBeLessThanOrEqual(scenario === 'restart' ? 6 : 5)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old)
    expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { lte: 3 } }, orderBy: { seq: 'asc' } })).toEqual(history)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content: body, revision: 8 })
    const used = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, id: { not: old.id } } })
    expect(used).toHaveLength(network.mock.calls.length)
    expect(used.every(row => row.usageSource === 'reported' && row.billingStatus === 'settled' && row.reservedCreditMilli === 0)).toBe(true)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(network.mock.calls.length)
    const final = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    expect(final.bridge!.committedAt === null).toBe(scenario === 'repeat')
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe(scenario === 'repeat' ? 'paused' : 'completed')
    if (scenario !== 'repeat') expect(final.bridge).toMatchObject({ location: accurate, lastUnfinishedAction: good.lastUnfinishedAction })
  }, undefined, '修复本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 1 }), 30000)
})
