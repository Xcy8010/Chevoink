import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { terminalInputDecisionFixture } from '../helpers/terminal-input-decision-fixture.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { readLegacyContinuityAssessment, bindLegacyContinuityAssessment, reserveLegacyContinuityAssessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readTerminalInputDecision } from '../../api/lib/agent/terminal-input-decision.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { observeChapterReviewProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'

const prompt = '修改第一章，只输出标题和正文'
const scenarios = [{ stagnant: 3, action: 'same' }, { stagnant: 4, action: 'same' }, { stagnant: 4, action: 'read' },
  { stagnant: 4, action: 'native-exhausted' }, { stagnant: 4, action: 'change' }, { stagnant: 4, action: 'body-drift' },
  { stagnant: 4, action: 'audit-drift' }] as const

describe.runIf(available)('one persisted decision for a settled invalid terminal input', () => {
  it.each(scenarios)('hands control to the main model at stagnant=$stagnant, action=$action', ({ stagnant, action }) => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((name, owner) => name === 'storyCompiler' || name !== 'memory2' && feature(name, owner))
    const startedAt = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).createdAt
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 4, content: 'The packet remains sealed. The table remains dry.' } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
    const state = { knowledge: [], emotion: [], body: [], objects: ['The packet remains sealed.'], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inventory', entryState: state, goal: 'Read', obstacle: 'Time',
      choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: chapter.revision })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
    const draft = terminalDraftFixture('emotion', { chapter, taskId: f.spec.id, ctx: f, compilationId: compilation.id,
      candidate: terminalDraftFixture().candidate,
      originBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null,
        terminalCandidate: terminalDraftFixture('emotion').base }, 11)).hash,
      currentBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null,
        terminalCandidate: terminalDraftFixture().candidate }, 11)).hash })
    const preparedContext = { ...(saved.preparedContext as Record<string, unknown>), ...draft.preparedContext }
    const synthetic = terminalInputDecisionFixture({ runId: f.runId, taskSpec: f.spec, chapter, compilationId: compilation.id,
      bridge: saved.bridge, scenes: saved.sceneTasks, preparedContext, proposals: draft.nextContext.proposalChanges })
    expect(synthetic.first.audit.classification).toBe('source_invalid'); expect(synthetic.second.complete).toBe(true)
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call',
      payload: { callId: synthetic.callId, toolName: 'continuity_validate', args: { compilationId: compilation.id } } } })
    const window = credits.getCreditWindow(), charge = 23
    const account = await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, dailyUsedMilli: 41 * charge,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const usage = [], ledger = [], usageIds = new Map<string, string>()
    for (let index = 0; index < 41; index++) {
      const row = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: index < 3 ? 'story_compilation' : 'agentRun', targetId: index < 3 ? compilation.id : f.runId,
        providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed', multiplierBps: 10000,
        action: index === 0 || index === 2 ? 'agent3ContinuityCritic' : index === 1 ? 'agent3ContinuityCriticSecondPass' : 'agentLoopTurn', requestTokens: 12, responseTokens: 8,
        usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: charge, billingEvidence: { responseObserved: true }, durationMs: 0 } })
      usage.push(row)
      if (index < 2) usageIds.set(index ? 'second-usage' : 'first-usage', row.id)
      if (index === 2) usageIds.set('usage-origin', row.id)
      ledger.push(await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: row.id,
        idempotencyKey: `synthetic-decision:${row.id}`, deltaMilli: -charge, dailyDeltaMilli: -charge, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } }))
    }
    const artifacts = []
    for (const row of [...draft.rows.filter(row => row.id.startsWith('origin-')).map(row => row.metadata), ...synthetic.metadata]) {
      const metadata = { ...row }
      if ('usageIds' in metadata && Array.isArray(metadata.usageIds)) metadata.usageIds = metadata.usageIds.map(id => usageIds.get(String(id))!)
      artifacts.push(await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Synthetic original independent evidence',
        content: 'Synthetic independent evidence.', metadata: runtimeJson(metadata).value } }))
    }
    const ctx = { ...f, callId: synthetic.callId, signal: new AbortController().signal } as ToolContext
    const received = await prisma.$transaction(tx => readLegacyContinuityAssessment(tx, ctx, synthetic.frozen))
    expect(received).toMatchObject({ recoveryReady: true, billingKnown: true, providerComplete: true, inspected: { complete: false, audit: { classification: 'source_invalid' } } })
    const bound = bindLegacyContinuityAssessment(received.inspected, ctx, synthetic.frozen)
    // Establish the real unknown original report first. The report transaction
    // then derives pending from the candidate change; no fixture-side pending
    // injection bypasses the normal producer/source contract.
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, terminalCandidate: draft.base,
      findings: [], independentCheck: 'complete', coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge,
        sceneTasks: saved.sceneTasks, source: null, terminalCandidate: draft.base }, 11), continuityCriticResponse: draft.bound.audit })
    await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, terminalCandidate: synthetic.candidate,
      findings: [], independentCheck: 'unavailable', coverage: synthetic.coverage, continuityCriticResponse: bound.audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision,
      mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', payload: { callId: synthetic.callId,
      toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' } } })
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', payload: { reason: 'model_stalled' } } })
    const plan = await prisma.$transaction(tx => readTerminalInputDecision(tx, f, compilation.id))
    expect(plan, JSON.stringify({ validation: bound.audit.classification, received: received.inspected.complete })).not.toBeNull()
    const oldClaims = Array.from({ length: 8 }, (_, index) => `original-review:${index}`)
    if (action === 'native-exhausted') oldClaims.push(...plan!.nativeClaims)
    const oldFeedback = ['e'.repeat(64)], seen = new Set<string>()
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    observeChapterReviewProgress(seen, readiness!.progressEvidence, { ...f, taskSpec: f.spec, expectedOriginalTaskId: f.spec.id })
    for (const phase of ['prepare', 'scenes'] as const) {
      const action = phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build'
      const milestone = { version: 1 as const, userId: f.userId, novelId: f.novelId, runId: f.runId, targetOrderIndex: chapter.orderIndex, phase }
      expect(observeWritingWorkflowMilestone(seen, action, milestone, { ...f, taskSpec: f.spec })).toBe(true)
      expect(observeWritingWorkflowMilestone(seen, action, milestone, { ...f, taskSpec: f.spec })).toBe(false)
    }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: startedAt.getTime(),
      activeExecutionMs: recoverRunElapsedMs(startedAt.getTime(), pause.createdAt.getTime(), [{ type: 'run.paused', at: pause.createdAt.getTime() }]),
      stagnantBatches: stagnant, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 1, writeBaseline: 0, readProgress: 7, readBaseline: 0, progressSignatures: [...seen], reviewAttempts: oldClaims,
      consumedReviewDecisionFeedback: oldFeedback, pendingReviews: [], inheritedTokens: 10, inheritedTurns: 26, manualResumeCount: 0 }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 26, startedAt,
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, checkpoint } } })
    const originalRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const originalPending = ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).preparedContext as {
      terminalProposalReview: { pending: unknown[] } }).terminalProposalReview.pending
    expect(originalPending).toHaveLength(1)
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
      multiplierBps: 10000, reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    const network = vi.fn(() => { throw Error('No network request is authorized') }); vi.stubGlobal('fetch', network)
    const order: string[] = []
    const critic = vi.spyOn(ai, 'generateTextCompletion').mockImplementation(async (_system, _content, options) => {
      order.push('critic'); expect(action).toBe('change'); expect(main).toHaveBeenCalledOnce()
      const row = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed',
        multiplierBps: 10000, action: 'agent3ContinuityCritic', requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled',
        reservedCreditMilli: 0, creditChargeMilli: 0, billingEvidence: { responseObserved: true }, durationMs: 0 } })
      const trace = beginTextRequest(row.id).record
      await options.beforeProviderDispatch?.(row.id)
      Object.assign(trace, { status: 'terminal', billingKnown: true })
      const raw = JSON.stringify({ ...synthetic.secondWire, decisions: undefined, semanticChecks: Object.entries(synthetic.secondWire.semanticChecks).map(([kind, row]) => ({ kind, result: row.result, reason: row.reason, findingIds: [] })), terminalVerdicts: [0, 1].map(claimIndex => ({ claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })) })
      options.onObservedCompletion?.({ usageId: row.id, content: raw, finishReason: 'stop', toolCalls: [] })
      return raw
    })
    let expectedChapter = chapter
    const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async ({ messages }) => {
      order.push('main')
      const count = main.mock.calls.length
      expect(count).toBeLessThanOrEqual(action === 'read' ? 2 : 1)
      expect(messages.some(message => typeof message.content === 'string' && message.content.includes('terminalPatchBase') && message.content.includes('another absent quotation'))).toBe(true)
      if (action === 'body-drift') expectedChapter = await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5, content: `${chapter.content} A later independent edit.` } })
      if (action === 'audit-drift') {
        const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        const validation = current.validation as Record<string, unknown>
        await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation,
          continuityCriticResponse: { ...(validation.continuityCriticResponse as Record<string, unknown>), contentHash: 'f'.repeat(64) } }).value } })
      }
      const name = action === 'read' && count === 1 ? 'chapter_read' : 'continuity_validate'
      const args = name === 'chapter_read' ? { chapterId: chapter.id } : { compilationId: compilation.id,
        terminalPatch: { baseCandidateHash: runtimeJson(synthetic.candidate).hash,
          ...(action === 'change' ? { addFacts: [{ field: 'objects', claim: 'The table remains dry.' }] } : {}) },
        ...(action !== 'change' ? { focus: 'Same semantic subject with a new focus.' } : {}) }
      return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `synthetic-decision-${count}`, name, arguments: JSON.stringify(args) }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    const execute = (eventId: string, afterSeq: number, author = true) => executeAgentRun({ ...f, prompt, mode: 'build', resume: true,
      ...(author ? { authorContinue: { eventId, afterSeq } } : {}), eventStartSeq: afterSeq, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    await execute(pause.id, 3)
    const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const failedTools = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, type: 'tool.result', seq: { gt: 3 } }, select: { payload: true }, orderBy: { seq: 'asc' } })
    const savedCheckpoint = (finished.usage as { checkpoint: typeof checkpoint }).checkpoint
    expect(finished).toMatchObject({ taskSpec: originalRun.taskSpec, modelTier: originalRun.modelTier, customModelId: originalRun.customModelId, reasoningEffort: originalRun.reasoningEffort })
    expect(savedCheckpoint.reviewAttempts).toEqual(expect.arrayContaining(oldClaims))
    expect(savedCheckpoint.reviewAttempts.filter(item => item.startsWith('terminal-processing:'))).toEqual(action === 'native-exhausted' ? plan!.nativeClaims : [])
    expect(savedCheckpoint.consumedReviewDecisionFeedback).toEqual(action === 'native-exhausted' ? oldFeedback
      : [...oldFeedback, plan!.key, ...(action === 'read' ? [plan!.readKey] : [])])
    if (action === 'change') {
      expect({ status: finished.status, error: finished.errorMessage, failedTools }).toMatchObject({ status: 'completed', error: null })
      expect(failedTools.map(row => (row.payload as { ok: boolean }).ok)).toEqual([true, true])
      expect(order).toEqual(['main', 'critic']); expect(critic).toHaveBeenCalledOnce()
      expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ terminalCommitted: true })
    } else {
      expect({ status: finished.status, error: finished.errorMessage, failedTools }).toMatchObject({ status: 'paused' })
      expect(main).toHaveBeenCalledTimes(action === 'native-exhausted' ? 0 : action === 'read' ? 2 : 1)
      expect(critic).not.toHaveBeenCalled()
      expect(savedCheckpoint.stagnantBatches).toBeGreaterThanOrEqual(stagnant)
      if (action === 'body-drift' || action === 'audit-drift' || action === 'native-exhausted') expect(failedTools).toEqual([])
      else expect(failedTools.map(row => row.payload)).toEqual([
        ...(action === 'read' ? [expect.objectContaining({ toolName: 'chapter_read', ok: true })] : []),
        expect.objectContaining({ toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' }),
      ])
      for (const author of action === 'body-drift' || action === 'audit-drift' ? [] : [true, false]) {
        const latest = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' }, orderBy: { seq: 'desc' } })
        const tail = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
        const beforeCalls = main.mock.calls.length
        await execute(latest.id, tail.seq, author)
        expect(main).toHaveBeenCalledTimes(beforeCalls); expect(critic).not.toHaveBeenCalled()
        const resumed = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        expect(resumed.status).toBe('paused')
        expect((resumed.usage as { checkpoint: typeof checkpoint }).checkpoint.consumedReviewDecisionFeedback).toEqual(savedCheckpoint.consumedReviewDecisionFeedback)
      }
      // Even a new call ID and prompt cannot use the lifecycle directly to buy
      // this unchanged failed subject after an author admission.
      if (action !== 'body-drift' && action !== 'audit-drift') {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
        expect(await prisma.$transaction(tx => reserveLegacyContinuityAssessment(tx, { ...ctx, callId: 'different-call' },
          { ...synthetic.frozen, content: 'Different rendering.', bindingHash: 'b'.repeat(64) }, async () => {}))).toBe('blocked')
      }
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(41)
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(expectedChapter)
    expect(((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).preparedContext as {
      terminalProposalReview: { pending: unknown[] } }).terminalProposalReview.pending).toEqual(originalPending)
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(artifacts))
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: usage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(usage))
    expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(ledger))
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(account)
    expect(network).not.toHaveBeenCalled()
  }, undefined, prompt, { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
