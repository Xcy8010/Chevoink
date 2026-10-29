import { buildContinuityReviewManifest, inspectContinuityV4 } from '../../api/lib/agent/continuity-review-v4.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { currentTerminalReview, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import { calculateV2UserChargeMilli } from '../../api/lib/billing/pricing.js'

describe.runIf(available)('native continuity origin remains a real operation and receipt chain', () => {
  it.each([21, 22] as const)('preserves frozen work%s UNKNOWN while current native origin/cache cannot certify or inherit it', version => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const lease = await claim(f), content = 'The guard waits. The packet remains sealed.'
    expect(await prisma.agentRun.update({ where: { id: f.runId, status: 'queued' }, data: { status: 'running' } })).toMatchObject({ status: 'running' })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, wordCount: content.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review the synthetic chapter.' })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Wait', entryState: empty, goal: 'Wait', obstacle: 'Time', choice: 'Wait', cost: 'Time', turn: 'Wait', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const firstCandidate = terminalCandidateSchema.parse({ exitState: { openLoops: ['The guard waits.'] } }), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
    const tools = [chapterBridgeGetTool, continuityValidateTool], args = { compilationId: compilation.id }
    const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: compilation.id }) },
      { id: 'origin', name: 'continuity_validate', arguments: JSON.stringify(args) },
      { id: 'origin-cache', name: 'continuity_validate', arguments: JSON.stringify(args) },
      { id: 'same-subject-new-wire', name: 'continuity_validate', arguments: JSON.stringify({ ...args, terminalState: firstCandidate, focus: 'Retired candidate arguments cannot buy another verdict.' }) },
      { id: 'current', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id, terminalState: candidate }) },
      { id: 'cache', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) }]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'user', content: 'Review this chapter.' }, { role: 'assistant', content: null, toolCalls: calls }] } })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const runtime = { tier: 'speed' as const, multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>, reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'native-origin', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
    const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: [] }, 6, 2)
    const bodies = { current: content, previous: null, terminalEvidence: context }, sourceScope = compilerEvidenceScope(chapter, null)
    const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic original complete independent review.',
      ...(version === 21 ? { findingIndexes: [] } : { findingIds: [] }) })), terminalVerdicts: [{ claimIndex: 0, verdict: 'unknown', sourceEvidence: [] }], terminalProofVerdicts: [], terminalDispositions: [] }
    const historicalRaw = JSON.stringify(wire)
    const manifest = buildContinuityReviewManifest({ subject: { userId: f.userId, novelId: f.novelId, taskId: f.spec.id,
      targetType: 'story_compilation', targetId: compilation.id, chapterId: chapter.id, revision: chapter.revision }, bodies, candidate: firstCandidate, sourceScope,
      sourceHash: null, sourceVersions: { current: context.current, previous: null }, verifiedCoverage: context.factCoverage, draftProposals: null })
    const historicalInspection = version === 21 ? inspectContinuityResponse(historicalRaw, bodies, true, 8, firstCandidate, sourceScope, { responseContract: 3 })
      : inspectContinuityV4(historicalRaw, { bodies, manifest, candidate: firstCandidate, sourceScope })
    expect(historicalInspection.complete).toBe(true)
    const originalAudit = { independentCheck: 'complete', terminalCandidate: firstCandidate, continuityCriticResponse: historicalInspection.audit }
    expect(currentTerminalReview(originalAudit, content, context)?.deliveryEligibility.eligible).not.toBe(true)
    const historical = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Frozen work' + version + ' UNKNOWN source',
      content: historicalRaw, metadata: runtimeJson({ frozenWorkVersion: version, originalAudit, rawResponse: historicalRaw }).value } })
    const network = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', network)
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    expect(await step()).toMatchObject({ result: { reviewCompleted: true, reviewOutcome: 'complete' } })
    const origin = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate',
      inputSnapshot: { path: ['input', 'callId'], equals: 'origin' } }, include: { effectReceipt: true, events: true, children: { include: { attempts: { include: { usageReceipt: true } }, events: true } } } })
    expect(origin.status).toBe('succeeded'); expect(origin.effectReceipt).not.toBeNull()
    expect(origin.events).toContainEqual(expect.objectContaining({ type: 'effect.committed' }))
    expect(origin.children[0].attempts[0].usageReceipt).toMatchObject({ source: 'reported', settlementStatus: 'settled' })
    const reusedOrigin = await step()
    expect(reusedOrigin, JSON.stringify(reusedOrigin)).toMatchObject({ result: { reviewCompleted: true, reviewOutcome: 'complete' } })
    expect(network).toHaveBeenCalledOnce()
    const originCache = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate', operationKey: `exec:2` }, include: { effectReceipt: true, children: true } })
    expect(originCache.inputSnapshot).toMatchObject({ input: { work: { kind: 'continuityReview', chapterId: chapter.id, revision: chapter.revision } } })
    expect(originCache.effectReceipt).not.toBeNull(); expect(originCache.children).toHaveLength(0)
    expect(await step()).toMatchObject({ result: { outcome: 'failed', failureCode: 'TOOL_CONTRACT_RETIRED' } })
    expect(network).toHaveBeenCalledOnce()
    expect(await step()).toMatchObject({ result: { outcome: 'failed', failureCode: 'TOOL_CONTRACT_RETIRED' } })
    expect(await step()).toMatchObject({ result: { reviewCompleted: true } })
    expect(network).toHaveBeenCalledOnce()
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    expect(saved.validation).toMatchObject({ continuityReport: { complete: true, chapterId: chapter.id, revision: chapter.revision, findings: [] } })
    expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
    expect(currentTerminalReview(originalAudit, content, context)?.deliveryEligibility.eligible).not.toBe(true)
    const protectedUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }), protectedArtifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    // Native provider results settle through operation receipts, not legacy logs.
    const nativeAttempts = () => prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId, kind: 'provider' } },
      include: { usageReceipt: true, operation: { include: { events: { orderBy: { id: 'asc' } } } } }, orderBy: { id: 'asc' } })
    const nativeLedger = () => prisma.creditLedgerEntry.findMany({ where: { userId: f.userId, kind: 'usage' }, orderBy: { id: 'asc' } })
    const protectedAttempts = await nativeAttempts(), protectedLedger = await nativeLedger()
    expect(protectedUsage).toHaveLength(0)
    expect(protectedAttempts).toHaveLength(1); expect(protectedLedger).toHaveLength(1)
    expect(new Set(protectedAttempts.map(row => row.operationId)).size).toBe(1)
    expect(new Set(protectedLedger.map(row => row.idempotencyKey)).size).toBe(1)
    for (const attempt of protectedAttempts) {
      expect(attempt).toMatchObject({ attemptKey: '1', status: 'succeeded', runId: f.runId,
        operation: { taskRootId: f.rootId, kind: 'provider', action: 'continuity_critic', status: 'succeeded' },
        usageReceipt: { attemptId: attempt.id, source: 'reported', promptTokens: 12, completionTokens: 8, settlementStatus: 'settled' } })
      expect(attempt.operation.events.filter(event => event.type === 'provider.result.recorded')).toEqual([
        expect.objectContaining({ eventKey: `result:${attempt.id}:${attempt.resultHash}`, payload: { attemptId: attempt.id, status: 'succeeded', resultHash: attempt.resultHash } }),
      ])
      const ledger = protectedLedger.find(row => row.referenceId === attempt.operationId)
      expect(ledger).toMatchObject({ userId: f.userId, kind: 'usage', sourceType: 'model_tokens', idempotencyKey: `operation:${attempt.operationId}`,
        requestTokens: 12, responseTokens: 8,
        metadata: { taskRootId: f.rootId, operationId: attempt.operationId, attemptId: attempt.id, requestHash: attempt.requestHash,
          pricingVersion: 'credits-v2-itemized', rateCardId: 'native-origin', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 },
          usageRevision: attempt.usageReceipt!.revision, observationHash: attempt.usageReceipt!.observationHash } })
      expect(ledger!.deltaMilli).toBe(-calculateV2UserChargeMilli(12, 8, null, { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 }))
      expect(ledger!.deltaMilli).toBeLessThan(0)
      expect(attempt.operation.events.filter(event => event.type === 'credit.settled')).toEqual([
        expect.objectContaining({ eventKey: `settlement:${attempt.operationId}`, payload: expect.objectContaining({ operationId: attempt.operationId,
          attemptId: attempt.id, usageRevision: attempt.usageReceipt!.revision, amountMilli: -ledger!.deltaMilli, chargedMilli: -ledger!.deltaMilli, shortfallMilli: 0 }) }),
      ])
    }

    // Historical effect loss cannot be replaced by a child provider success.
    await prisma.$transaction(async tx => {
      await tx.agentEffectReceipt.delete({ where: { operationId: origin.id } })
      // A current provider child's success cannot certify the independent old UNKNOWN.
      expect(currentTerminalReview(originalAudit, content, context)?.deliveryEligibility.eligible).not.toBe(true)
      expect(await tx.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
      throw Error('rollback synthetic missing-effect probe')
    }).catch(error => { if (!(error instanceof Error) || error.message !== 'rollback synthetic missing-effect probe') throw error })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    expect(await commitChapterBridge({ ...f, compilationId: compilation.id, chapterSummary: 'The packet remains sealed.', exitState: candidate.exitState,
      lastUnfinishedAction: '', hookDecision: 'none', delayedHookReason: '', openingStructure: '', endingStructure: '', requireQuality: true }))
      .toMatchObject({ chapterId: chapter.id, chapterRevision: chapter.revision })
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    expect(committed).toMatchObject({ status: 'completed' })
    expect(committed.preparedContext).not.toHaveProperty('terminalFactProofs')
    const nextRunId = randomUUID(), next = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Next', content: 'Later.', orderIndex: 2, orderInVolume: 2, wordCount: 6 } })
    const nextSpec = buildTaskSpec({ runId: nextRunId, novelId: f.novelId, chapterId: next.id, prompt: '写下一章', continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalCoverageProtocol: 2 })
    await prisma.agentRun.create({ data: { id: nextRunId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: next.id, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0, taskSpec: JSON.parse(JSON.stringify(nextSpec)), startRequest: { prompt: '写下一章' } } })
    const nextSubject = { ...f, runId: nextRunId }
    const source = await readCompilerContinuitySource(prisma, nextSubject, next, chapter.id, 11)
    expect(source && 'terminalInheritance' in source ? source.terminalInheritance?.map(fact => fact.claim) : []).toEqual([])
    expect(network).toHaveBeenCalledTimes(1)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(protectedUsage)
    expect(await nativeAttempts()).toEqual(protectedAttempts)
    expect(await nativeLedger()).toEqual(protectedLedger)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: protectedArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(protectedArtifacts)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).preparedContext).toEqual(committed.preparedContext)
  }, undefined, '修改第一章，只输出标题和正文', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2, freezeWriting: true }))
})
