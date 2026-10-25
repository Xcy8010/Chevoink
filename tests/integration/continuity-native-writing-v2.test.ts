import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { coordinatedWriterParameters } from '../../api/lib/agent/coordinated-writing-input.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool, chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { advanceDurableWritingDelivery } from '../../api/lib/agent/runtime-writing-delivery.js'
import { finalizeDurableTask, pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { runReviewedDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import * as continuity from '../../api/lib/agent/tools/durable-continuity.js'
import * as compiler from '../../api/lib/agent/story-compiler.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { loadPersistedEvents } from '../../api/lib/agent/events.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { assertContinuityOwner } from '../../api/lib/agent/continuity-coordinator.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'

describe.runIf(available)('fresh native writing manifest2 actual bounded chain', () => {
  it('accepts queued only through the exact current native lease and rejects stale, foreign or ended owners', () => fixture(async f => {
    let lease = await claim(f)
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
    const fetcher = vi.fn(() => { throw Error('Owner checks cannot dispatch any provider') }); vi.stubGlobal('fetch', fetcher)
    await expect(withRunLease(lease, tx => assertContinuityOwner(tx, { ...f, continuityNativeLease: lease }))).resolves.toBeUndefined()
    await expect(prisma.$transaction(tx => assertContinuityOwner(tx, f))).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    await expect(withRunLease(lease, tx => assertContinuityOwner(tx, { ...f, novelId: 'another-novel', continuityNativeLease: lease })))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    await expect(withRunLease(lease, tx => assertContinuityOwner(tx, { ...f, continuityNativeLease: { ...lease, ownerId: 'old-owner' } })))
      .rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    const old = lease
    await pauseDurableTask(f.userId, f.runId)
    const paused = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: paused.id })
    lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'current-owner')
    await expect(withRunLease(lease, tx => assertContinuityOwner(tx, { ...f, runId: lease.runId, continuityNativeLease: old })))
      .rejects.toBeInstanceOf(Error)
    await prisma.agentRun.update({ where: { id: lease.runId }, data: { usage: { authorEnded: { fulfilled: false } } } })
    await expect(withRunLease(lease, tx => assertContinuityOwner(tx, { ...f, runId: lease.runId, continuityNativeLease: lease })))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
  }))
  it.each(['no-effect', 'ordinary-presentation', 'merged-revision', 'merged-revision-restart'] as const)('%s uses original receipts and deterministic completion', scenario => fixture(async f => {
    const reportEffects = vi.spyOn(compiler, 'validateStoryContinuity')
    let lease = await claim(f)
    const changed = scenario === 'merged-revision' || scenario === 'merged-revision-restart'
    const prompt = scenario === 'ordinary-presentation' ? '完整重写当前章节' : '完整重写当前章节，只输出标题和正文。'
    expect(f.spec.scope.writing?.titleAndBodyOnly).toBe(scenario !== 'ordinary-presentation')
    const content = changed ? '他合上箱盖，核对锁扣。锁扣一直扣紧。锁扣此刻完全松开。' : '他合上箱盖，核对锁扣。锁扣一直扣紧。'
    const after = changed ? '他合上箱盖，核对锁扣。锁扣一直扣紧。他没有解开锁扣，只把箱子推近灯下。' : content
    const writing = { draftComplete: true, actualOutcomes: { exitState: { objects: ['锁扣一直扣紧。'] } },
      scenes: [{ purpose: '检查箱子', goal: '核对锁扣', obstacle: '灯光不足', choice: '挪近灯光', cost: '时间', turn: '核对完成' }],
      chapterSummary: '他核对箱子的锁扣，箱子仍然锁着。', hookDecision: '', delayedHookReason: '', openingStructure: '核对锁扣', endingStructure: '箱子保持锁好' }
    const args = { chapterId: f.chapterId, content, writing }
    const tools: AgentTool[] = [chapterReadTool, { ...chapterWriteTool, parameters: coordinatedWriterParameters(chapterWriteTool, f.spec.scope) },
      { ...chapterEditRangeTool, parameters: coordinatedWriterParameters(chapterEditRangeTool, f.spec.scope) }, storyCompilerPrepareTool,
      sceneTaskBuildTool, continuityValidateTool, qualityAnalyzeTool, chapterBridgeCommitTool]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        successfulToolSignatures: [], messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null,
          toolCalls: [{ id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: 'write', name: 'chapter_write', arguments: JSON.stringify(args) }] }] } })
    const runtime = { tier: 'speed' as const, multiplierBps: 15000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'isolated-placeholder', reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>,
      reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
    const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'native-v2-fixture',
      rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    let requests = 0
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests++
      const body = JSON.parse(String(init.body)), system = String(body.messages[0].content), material = String(body.messages[1].content)
      expect(body.tools).toBeUndefined()
      let report: unknown
      if (system.includes('一次集中局部修订编辑')) {
        const input = JSON.parse(material)
        report = { patches: [{ oldText: '锁扣此刻完全松开。', newText: '他没有解开锁扣，只把箱子推近灯下。' }],
          retainedFindings: input.findings.filter((finding: { source: string }) => finding.source === 'quality').map((finding: { source: string; reportId: string; findingId: string }) =>
            ({ source: finding.source, reportId: finding.reportId, findingId: finding.findingId, reason: '保留本次朴素核对动作的原表达，未声称质量意见已消失。' })) }
      } else if (system.includes('contract5')) {
        const input = JSON.parse(material), initial = requests === 1
        report = { findings: changed && initial ? [{ findingId: 'f0', signal: 'object', severity: 'error', reasonCode: 'manuscript_conflict',
          explanation: '同一时刻锁扣被描述为扣紧和完全松开。', suggestion: '根据本章实际动作统一锁扣状态。',
          manuscriptEvidence: [{ segmentId: 'c0', quote: '锁扣一直扣紧。' }, { segmentId: 'c0', quote: '锁扣此刻完全松开。' }] }] : [],
        semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: changed && initial && kind === 'state_progression' ? 'conflict' : 'clear',
          reasonCode: changed && initial && kind === 'state_progression' ? 'manuscript_conflict' : 'consistent', explanation: '独立核对本次完整正文的动作和状态。',
          findingIds: changed && initial && kind === 'state_progression' ? ['f0'] : [] })),
        terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', reasonCode: 'consistent', explanation: '当前正文直接记载锁扣扣紧。', manuscriptEvidence: [{ segmentId: 'c0' }] }],
        terminalProofVerdicts: [], terminalDispositions: [], issueDispositions: input.establishedIssues.map((_issue: unknown, issueIndex: number) =>
          ({ issueIndex, outcome: 'repaired', reasonCode: 'consistent', explanation: '当前原文只保留锁扣扣紧的状态。', manuscriptEvidence: [{ segmentId: 'c0' }] })) }
      } else report = { findings: [] }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    }); vi.stubGlobal('fetch', fetcher)
    await executeDurableToolStep(lease, new AbortController().signal)
    let oldRequests: Awaited<ReturnType<typeof prisma.agentProviderAttempt.findMany>> | undefined
    if (scenario === 'merged-revision-restart') {
      const prepare = continuity.prepareContinuityWork
      let interrupted = false
      vi.spyOn(continuity, 'prepareContinuityWork').mockImplementation(async (...args) => {
        if (!interrupted && args[2].operationKey.endsWith(':continuity_verify')) {
          interrupted = true
          throw Error('interrupted after actual merged CAS')
        }
        return prepare(...args)
      })
      await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('interrupted after actual merged CAS')
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: after, revision: 3 })
      oldRequests = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, orderBy: { id: 'asc' } })
      await pauseDurableTask(f.userId, lease.runId)
      const paused = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: paused.id })
      lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'after-merged-cas')
    }
    const result = await executeDurableToolStep(lease, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'tool', result: { summary: '正文已保存并提交', display: { after, revision: changed ? 3 : 2 } } })
    expect(result).not.toHaveProperty('result.outcome', 'failed')
    const writer = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, kind: 'tool', action: 'chapter_write' }, include: { effectReceipt: true } })
    expect(writer.inputSnapshot).toMatchObject({ input: { writingManifest: { version: 2 } } })
    expect(writer.effectReceipt?.result).toMatchObject({ writingCompletion: { status: 'completed', steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'quality' }, { step: 'prose_revision' },
      { step: 'continuity_verify' }, { step: 'quality_verify' }, { step: 'commit' }] } })
    expect(fetcher).toHaveBeenCalledTimes(changed ? 5 : 2)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(changed ? 5 : 2)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(changed ? 5 : 2)
    if (oldRequests) expect(await prisma.agentProviderAttempt.findMany({ where: { id: { in: oldRequests.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldRequests)
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { userId: f.userId, chapterId: f.chapterId } })
    expect(compilation).toMatchObject({ status: 'completed', validation: { independentCheck: 'complete', checkedRevision: changed ? 3 : 2,
      continuityCriticResponse: { parserVersion: 10, responseContract: 5 } } })
    expect(reportEffects).toHaveBeenCalledTimes(changed ? 2 : 1)
    for (const [input, tx] of reportEffects.mock.calls) {
      expect(input.expectedContinuityNativeLease).toMatchObject({ userId: f.userId, runId: input.runId, taskRootId: f.rootId })
      expect(tx).toBeDefined()
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: after, revision: changed ? 3 : 2 })
    if (scenario === 'ordinary-presentation') {
      // A real commit does not enlarge the author's presentation contract.
      expect(await advanceDurableWritingDelivery(lease)).toBeNull()
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).status).not.toBe('completed')
      expect(fetcher).toHaveBeenCalledTimes(2)
      return
    }
    expect(await advanceDurableWritingDelivery(lease)).not.toBeNull()
    const state = await loadExecutionState(f.userId, lease.runId)
    const cursor = { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash }
    const currentMemoryJobId = z.object({ memoryJobId: z.string().min(1) }).parse(writer.effectReceipt!.result).memoryJobId
    const beforeEvidence = await collectDurableCompletionEvidence(lease, cursor)
    expect(beforeEvidence.snapshot).toMatchObject({ blockers: [{ code: 'unresolved_memory_job', reference: currentMemoryJobId }],
      memoryJobs: [{ id: currentMemoryJobId, chapterId: f.chapterId, chapterRevision: changed ? 3 : 2, verified: false }] })
    expect((beforeEvidence.snapshot as { blockers: unknown[] }).blockers).toHaveLength(1)
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: currentMemoryJobId } })).toMatchObject({ status: 'pending' })
    await expect(finalizeDurableTask(lease, cursor)).rejects.toMatchObject({ code: 'RUNTIME_COMPLETION_BLOCKED' })
    const originalAttempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })
    const originalLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const historicalJobs = await prisma.memoryExtractionJob.findMany({ where: { novelId: f.novelId, id: { not: currentMemoryJobId } }, orderBy: { id: 'asc' } })
    // Production schedules the current effect's DB-only memory derivative
    // before completion review. Direct finalize must not waive that work.
    expect(await runReviewedDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'completed' })
    const memory = await prisma.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: { taskRootId: f.rootId, operationKey: `memory:${currentMemoryJobId}` } }, include: { effectReceipt: true } })
    expect(memory).toMatchObject({ action: 'memory_extract', status: 'succeeded', parentOperationId: writer.id,
      effectReceipt: { result: { jobId: currentMemoryJobId, status: 'applied', memories: expect.any(Array) } } })
    expect(z.object({ memories: z.array(z.unknown()).min(2) }).parse(memory.effectReceipt!.result).memories).toHaveLength(2)
    expect(memory.effectReceipt!.resultHash).toBe(runtimeJson(memory.effectReceipt!.result).hash)
    expect(await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `effect:${memory.id}` } })).toMatchObject({
      type: 'effect.committed', operationId: memory.id, payload: { operationId: memory.id, resultHash: memory.effectReceipt!.resultHash } })
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: currentMemoryJobId } })).toMatchObject({ status: 'completed' })
    expect(await prisma.projectMemoryEntry.findFirstOrThrow({ where: { novelId: f.novelId, sourceChapterId: f.chapterId, memoryType: 'chapterSummary' } })).toMatchObject({ content: expect.stringContaining(after) })
    const finalReceipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'completion_finalize' } } })
    expect(finalReceipt.result).toMatchObject({ evidence: { blockers: [], memoryJobs: [{ id: currentMemoryJobId, verified: true }] } })
    expect(await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })).toEqual(originalAttempts)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
    expect(await prisma.memoryExtractionJob.findMany({ where: { novelId: f.novelId, id: { not: currentMemoryJobId } }, orderBy: { id: 'asc' } })).toEqual(historicalJobs)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({ status: 'completed' })
    await publishDurableEvents(f.userId, lease.runId, 200)
    const events = await loadPersistedEvents(lease.runId, 0)
    expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'chapter_write')).toMatchObject([{ ok: true }])
    expect(fetcher).toHaveBeenCalledTimes(changed ? 5 : 2)
    const first = await prisma.agentOperation.findFirstOrThrow({ where: { parentOperationId: writer.id, action: 'continuity_validate', operationKey: `writing:${writer.id}:continuity` } })
    expect(runtimeJson((first.inputSnapshot as { input: { work: { price: unknown } } }).input.work.price).hash).toBe(runtimeJson(price).hash)
  }, undefined, scenario === 'ordinary-presentation' ? '完整重写当前章节' : '完整重写当前章节，只输出标题和正文。', { freezeWriting: true, writingCoordinationProtocol: 2, continuityReportProtocol: 5,
    continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
