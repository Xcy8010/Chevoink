import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { prepareContinuityWork, executePreparedContinuityWork } from '../../api/lib/agent/tools/durable-continuity.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { readCompilerObservation } from '../../api/lib/agent/runtime-compiler-observation.js'
import { continuityResponseContract, continuityResponseSystem } from '../../api/lib/agent/continuity-response-contract.js'
import { continuityResponseInput4 } from '../../api/lib/agent/continuity-response-repair.js'
import { currentTerminalReview, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('native continuity origin remains a real operation and receipt chain', () => {
  it.each([21, 22] as const)('authenticates work%s origin, pending current effect, cache and next-task inheritance', version => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const lease = await claim(f), content = 'The guard waits. The packet remains sealed.'
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, wordCount: content.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review the synthetic chapter.' })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Wait', entryState: empty, goal: 'Wait', obstacle: 'Time', choice: 'Wait', cost: 'Time', turn: 'Wait', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const firstCandidate = terminalCandidateSchema.parse({ exitState: { openLoops: ['The guard waits.'] } }), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
    const tools = [chapterBridgeGetTool, continuityValidateTool], args = { compilationId: compilation.id, terminalState: firstCandidate }
    const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: compilation.id }) },
      { id: 'origin', name: 'continuity_validate', arguments: JSON.stringify(args) },
      { id: 'origin-cache', name: 'continuity_validate', arguments: JSON.stringify(args) },
      { id: 'same-subject-new-wire', name: 'continuity_validate', arguments: JSON.stringify({ ...args, focus: 'Different rendering must not buy the same independent verdict.' }) },
      { id: 'current', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id, terminalState: candidate }) },
      { id: 'cache', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id, terminalState: candidate }) }]
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
    const network = vi.fn(async () => {
      const origin = network.mock.calls.length === 1
      const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic complete independent review.', ...(origin && version === 21 ? { findingIndexes: [] } : { findingIds: [] }) })),
        terminalVerdicts: [{ claimIndex: 0, verdict: origin ? 'unknown' : 'supported', sourceEvidence: origin ? [] : [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [],
        ...(!origin ? { proposalDispositions: [{ proposalIndex: 0, outcome: 'unknown', reason: 'The old draft remains unverified.', sourceEvidence: [] }] } : {}) }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(wire) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }); vi.stubGlobal('fetch', network)
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    if (version === 21) {
      // Admit a genuinely frozen old request before dispatch. The provider,
      // usage, result event and business effect below are all real runtime work.
      const state = await loadExecutionState(f.userId, f.runId), baseline = await prisma.$transaction(tx => readCompilerObservation(tx, f.rootId, state.frame.revision, compilation.id))
      const ctx: ToolContext = { ...f, callId: 'origin', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', modelRuntime: runtime, signal: new AbortController().signal, emit: () => {} }
      const admittedArgs = JSON.parse(JSON.stringify(continuityValidateTool.parameters.parse(args)))
      const work = await prepareContinuityWork(ctx, lease, { operationKey: `exec:${state.frame.state.nextOperationSequence}`, observedRevision: state.frame.revision, baseline, args: admittedArgs })
      if (work.kind !== 'check' || !work.sourceBodies || !work.terminalCandidate) throw Error('Expected a synthetic frozen check')
      const { continuityManifest: _manifest, authorRequest: _author, ...old } = work
      const frozen = { ...old, version: 21 as const, reassessmentProtocol: 5 as const,
        criticSystem: continuityResponseSystem('Synthetic frozen continuity reviewer.', continuityResponseContract(work.sourceBodies, work.terminalCandidate)),
        criticInput: continuityResponseInput4('Synthetic frozen source context.', work.sourceBodies, work.terminalCandidate) }
      const prepared = await prepareToolCursorOperation(lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash }, { key: `exec:${state.frame.state.nextOperationSequence}`, action: 'continuity_validate', callId: 'origin', targetId: lease.taskRootId, effectDomain: 'compiler',
        effectiveArgs: admittedArgs, normalize: value => JSON.parse(JSON.stringify(continuityValidateTool.parameters.parse(value))), operationInput: runtimeJson({ novelId: f.novelId, callId: 'origin', args: admittedArgs, baseline, work: frozen }).value })
      await executePreparedContinuityWork(ctx, lease, prepared.operation.id)
      await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
    } else {
      const result = await step()
      expect(result, JSON.stringify(result)).toMatchObject({ result: { failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' } })
    }
    const origin = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate' }, include: { effectReceipt: true, events: true, children: { include: { attempts: { include: { usageReceipt: true } }, events: true } } } })
    expect(origin.status).toBe('succeeded'); expect(origin.effectReceipt).not.toBeNull()
    expect(origin.events).toContainEqual(expect.objectContaining({ type: 'effect.committed' }))
    expect(origin.children[0].attempts[0].usageReceipt).toMatchObject({ source: 'reported', settlementStatus: 'settled' })
    const reusedOrigin = await step()
    expect(reusedOrigin, JSON.stringify(reusedOrigin)).toMatchObject({ result: { failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' } })
    expect(network).toHaveBeenCalledOnce()
    const originCache = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate', operationKey: `exec:2` }, include: { effectReceipt: true, children: true } })
    expect(originCache.inputSnapshot).toMatchObject({ input: { work: { version: 18, cached: [] } } })
    expect(originCache.effectReceipt).not.toBeNull(); expect(originCache.children).toHaveLength(0)
    expect(await step()).toMatchObject({ result: { outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' } })
    expect(network).toHaveBeenCalledOnce()
    expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('连续性检查') } })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }), audit = (saved.validation as { continuityCriticResponse: { terminalEvidence: Parameters<typeof currentTerminalReview>[2] } }).continuityCriticResponse
    const binding = await readTerminalDraftBinding(prisma, { ...f, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: saved.preparedContext }, chapter, saved.validation, audit.terminalEvidence)
    expect(currentTerminalReview(saved.validation, content, audit.terminalEvidence, binding)).toMatchObject({ supported: false, proposals: { complete: false }, deliveryEligibility: { eligible: true, basis: 'current_supported_with_preserved_drafts' } })
    const protectedUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }), protectedArtifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    expect(protectedUsage).toHaveLength(2)
    expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('复用') } })
    // Historical effect loss cannot be replaced by a child provider success.
    await prisma.$transaction(async tx => {
      await tx.agentEffectReceipt.delete({ where: { operationId: origin.id } })
      const denied = await readTerminalDraftBinding(tx, { ...f, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: saved.preparedContext }, chapter, saved.validation, audit.terminalEvidence)
      expect(currentTerminalReview(saved.validation, content, audit.terminalEvidence, denied)?.deliveryEligibility.eligible).not.toBe(true)
      throw Error('rollback synthetic missing-effect probe')
    }).catch(error => { if (!(error instanceof Error) || error.message !== 'rollback synthetic missing-effect probe') throw error })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    await commitChapterBridge({ ...f, compilationId: compilation.id, chapterSummary: 'The packet remains sealed.', exitState: candidate.exitState, lastUnfinishedAction: '', hookDecision: 'none', delayedHookReason: '', openingStructure: '', endingStructure: '', requireQuality: true })
    const nextRunId = randomUUID(), next = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Next', content: 'Later.', orderIndex: 2, orderInVolume: 2, wordCount: 6 } })
    const nextSpec = buildTaskSpec({ runId: nextRunId, novelId: f.novelId, chapterId: next.id, prompt: '写下一章', continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalCoverageProtocol: 2 })
    await prisma.agentRun.create({ data: { id: nextRunId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: next.id, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0, taskSpec: JSON.parse(JSON.stringify(nextSpec)), startRequest: { prompt: '写下一章' } } })
    const nextSubject = { ...f, runId: nextRunId }
    const source = await readCompilerContinuitySource(prisma, nextSubject, next, chapter.id, 11)
    expect(source && 'terminalInheritance' in source ? source.terminalInheritance?.map(fact => fact.claim) : []).toEqual(['The packet remains sealed.'])
    expect(network).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(protectedUsage)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: protectedArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(protectedArtifacts)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).preparedContext).toMatchObject({ terminalProposalReview: { pending: [expect.objectContaining({ field: 'openLoops' })] } })
  }, undefined, '修改第一章，只输出标题和正文', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2, freezeWriting: true }))
})
