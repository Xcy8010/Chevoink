import * as nativeQuality from '../../api/lib/agent/tools/durable-quality.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { currentNativeToolViews } from '../../api/lib/agent/runtime-tool-view.js'
import { advanceDurableMemory } from '../../api/lib/agent/runtime-memory.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { advanceDurableWritingDelivery } from '../../api/lib/agent/runtime-writing-delivery.js'
import { finalizeDurableTask, pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { runReviewedDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { loadPersistedEvents } from '../../api/lib/agent/events.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { assertContinuityOwner } from '../../api/lib/agent/continuity-coordinator.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'

describe.runIf(available)('current native writing and historical configuration actual bounded chain', () => {
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
  it.each(['no-effect', 'normalized-cross-chunk', 'ordinary-presentation', 'merged-revision', 'merged-revision-restart'] as const)('%s uses original receipts and deterministic completion', scenario => fixture(async f => {
    let lease = await claim(f)
    const changed = scenario === 'merged-revision' || scenario === 'merged-revision-restart'
    const prompt = scenario === 'ordinary-presentation' ? '完整重写当前章节' : '完整重写当前章节，只输出标题和正文。'
    expect(f.spec.scope.writing?.titleAndBodyOnly).toBe(scenario !== 'ordinary-presentation')
    const baseContent = '他合上箱盖，核对锁扣。锁扣一直扣紧。'
    const content = changed ? `${baseContent}锁扣此刻完全松开。` : scenario === 'normalized-cross-chunk' ? `${'x'.repeat(290)}${baseContent}` : baseContent
    const after = changed ? '他合上箱盖，核对锁扣。锁扣一直扣紧。他没有解开锁扣，只把箱子推近灯下。' : content
    const tools: AgentTool[] = [chapterReadTool, chapterWriteTool, storyCompilerPrepareTool, sceneTaskBuildTool, continuityValidateTool, qualityAnalyzeTool, chapterBridgeCommitTool]
    const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
    const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        successfulToolSignatures: [], messages: [{ role: 'user', content: prompt }] } })
    const configurationHash = initialized.head.configurationHash
    const runtime = { tier: 'speed' as const, multiplierBps: 15000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'isolated-placeholder', reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>,
      reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
    const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'native-v2-fixture',
      rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    let requests = 0, mainRequests = 0
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (body.tools) {
        mainRequests++
        expect(body.reasoning_effort).toBe('high')
        expect(JSON.stringify(body.tools)).not.toContain('actualOutcomes')
        expect(body.tools.find((tool: { function: { name: string } }) => tool.function.name === 'chapter_write').function.parameters.properties).not.toHaveProperty('writing')
        const observations = body.messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => message.content).join('\n')
        const compilationId = observations.match(/compilationId=([a-zA-Z0-9_-]+)/u)?.[1]
        const calls = !observations ? [
          { name: 'story_compiler_prepare', args: { chapterId: f.chapterId, intentSummary: '核对箱子锁扣' } },
          { name: 'scene_task_build', args: { tasks: [{ purpose: '检查箱子', entryState: {}, goal: '核对锁扣', obstacle: '灯光不足', choice: '挪近灯光', cost: '时间', turn: '核对完成', exitState: {}, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] } },
          { name: 'chapter_read', args: { chapterId: f.chapterId } }, { name: 'chapter_write', args: { chapterId: f.chapterId, content } },
        ] : [{ name: 'chapter_bridge_commit', args: { compilationId } }]
        if (observations) {
          expect(compilationId).toBeTruthy(); expect(observations).toContain('chapter_write')
          expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content, revision: 2 })
        }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: `main-${mainRequests}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
      }
      requests++
      // The selected main runtime stays high; both auxiliary reviewers use the established non-thinking encoding.
      expect(body.reasoning_effort).toBe('none')
      expect(credits.getModelTierRuntime).toHaveBeenCalledWith('speed', f.userId, null, 'high')
      const system = String(body.messages[0].content), material = String(body.messages[1].content)
      let report: unknown = { findings: [] }
      if (system.includes('你是中文小说连续性编辑')) {
        const input = JSON.parse(material), current = input.sources.find((source: { source: string }) => source.source === 'current')
        expect(current.content).toContain(changed && current.content.includes('完全松开') ? '锁扣此刻完全松开。' : '锁扣一直扣紧。')
        const entries = String(current.evidence).split('\n').flatMap(line => { const match = line.match(/^(q[a-f0-9]{12}) (.+)$/u); return match ? [{ sourceId: match[1], text: JSON.parse(match[2]) as string }] : [] })
        expect(entries.map(entry => entry.text).join('')).toBe(current.content)
        const conflict = entries.find(entry => entry.text === '锁扣此刻完全松开。'), baseline = entries.find(entry => entry.text === '锁扣一直扣紧。')
        if (changed && current.content.includes('完全松开')) { expect(conflict).toBeDefined(); expect(baseline).toBeDefined() }
        if (scenario === 'normalized-cross-chunk') { expect(current.content.indexOf(baseContent)).toBe(290); expect(entries.length).toBeGreaterThan(1) }
        report = { findings: changed && current.content.includes('完全松开') ? [{ signal: 'object', severity: 'error',
          explanation: '同一时刻锁扣被描述为扣紧和完全松开。', suggestion: '保留扣紧的已有动作，把箱子推到灯下核对。', evidence: [{ sourceId: conflict!.sourceId }, { sourceId: baseline!.sourceId }] }] : [] }
      } else if (system.includes('"patches"') && material.startsWith('{')) {
        const input = JSON.parse(material)
        expect(input.findings[0].original).toContain('锁扣此刻完全松开。')
        report = { patches: [{ findingId: input.findings[0].findingId, replacement: input.findings[0].original.replace('锁扣此刻完全松开。', '他没有解开锁扣，只把箱子推近灯下。') }] }
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
    }); vi.stubGlobal('fetch', fetcher)
    const model = async () => {
      const state = await loadExecutionState(f.userId, lease.runId), frame = state.frame
      return chatWithTools({ messages: frame.state.messages, tools: await currentNativeToolViews(state.configuration.tools, f.spec.scope),
        provider: 'fixture', model: 'fixture', providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey, reasoningEffort: 'high', reasoningParameterMode: 'native', signal: new AbortController().signal,
        durableExecution: { lease, operationKey: `exec:${frame.state.nextOperationSequence}`, attemptKey: '1', price, cursor: { expectedRevision: frame.revision, expectedHash: frame.snapshotHash } },
        usageLog: { userId: f.userId, agentRunId: lease.runId, action: 'workspaceAgent', modelTier: 'speed', multiplierBps: price.multiplierBps } })
    }
    await model()
    for (let index = 0; index < 4; index++) {
      const step = await executeDurableToolStep(lease, new AbortController().signal)
      expect(step.kind).toBe('tool'); if (step.kind === 'tool') expect(step.result.outcome).not.toBe('failed')
    }
    const writer = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, kind: 'tool', action: 'chapter_write' }, include: { effectReceipt: true } })
    expect(writer.inputSnapshot).not.toHaveProperty('input.writingManifest')
    expect(writer.effectReceipt?.result).toMatchObject({ toolResult: { display: { kind: 'chapterDiff', after: content, revision: 2 } } })
    if (changed) expect(await advanceDurableMemory(lease)).not.toBeNull()
    await model()
    let oldRequests: Awaited<ReturnType<typeof prisma.agentProviderAttempt.findMany>> | undefined
    if (scenario === 'merged-revision-restart') {
      const prepare = nativeQuality.prepareQualityWork; let interrupted = false
      vi.spyOn(nativeQuality, 'prepareQualityWork').mockImplementation(async (...args) => {
        if (!interrupted && (await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision === 3) { interrupted = true; throw Error('interrupted after actual continuity CAS') }
        return prepare(...args)
      })
      await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('interrupted after actual continuity CAS')
      expect(requests).toBe(3)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: after, revision: 3 })
      oldRequests = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, orderBy: { id: 'asc' } })
      await pauseDurableTask(f.userId, lease.runId)
      const paused = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: paused.id })
      lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'after-current-cas')
    }
    const result = await executeDurableToolStep(lease, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'tool', result: { summary: '章节已提交' } })
    expect(result).not.toHaveProperty('result.outcome', 'failed')
    const expectedReviews = changed ? 5 : 2
    expect(mainRequests).toBe(2); expect(requests).toBe(expectedReviews)
    expect(fetcher).toHaveBeenCalledTimes(expectedReviews + mainRequests)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(expectedReviews + mainRequests)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(expectedReviews + mainRequests)
    if (oldRequests) expect(await prisma.agentProviderAttempt.findMany({ where: { id: { in: oldRequests.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldRequests)
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { userId: f.userId, chapterId: f.chapterId } })
    expect(compilation).toMatchObject({ status: 'completed', stage: 'commit', validation: { independentCheck: 'complete', checkedRevision: changed ? 3 : 2,
      continuityReport: { complete: true, revision: changed ? 3 : 2, findings: [] } } })
    expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'chapter_bridge_commit', status: 'succeeded' } })).toBe(1)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: after, revision: changed ? 3 : 2 })
    expect((await loadExecutionState(f.userId, lease.runId)).head.configurationHash).toBe(configurationHash)
    const commitOperation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_bridge_commit' } })
    const reportOperations = await prisma.agentOperation.findMany({ where: { parentOperationId: commitOperation.id, action: 'continuity_validate' } })
    for (const operation of reportOperations) expect(operation.inputSnapshot).toMatchObject({ input: { work: { kind: 'continuityReview', chapterId: f.chapterId,
      price: { modelTier: 'speed', multiplierBps: price.multiplierBps, rateCardId: price.rateCardId } } } })
    if (scenario === 'ordinary-presentation') {
      // A real commit does not enlarge the author's presentation contract.
      expect(await advanceDurableWritingDelivery(lease)).toBeNull()
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).status).not.toBe('completed')
      expect(fetcher).toHaveBeenCalledTimes(expectedReviews + mainRequests)
      return
    }
    expect(await advanceDurableWritingDelivery(lease)).not.toBeNull()
    const state = await loadExecutionState(f.userId, lease.runId)
    const cursor = { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash }
    const currentMemoryJobId = (await prisma.memoryExtractionJob.findFirstOrThrow({ where: { novelId: f.novelId, chapterId: f.chapterId, chapterRevision: changed ? 3 : 2 } })).id
    const sourceEffect = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId }, result: { path: ['memoryJobId'], equals: currentMemoryJobId } } })
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
    expect(memory).toMatchObject({ action: 'memory_extract', status: 'succeeded', parentOperationId: sourceEffect.operationId,
      effectReceipt: { result: { jobId: currentMemoryJobId, status: 'applied', memories: expect.any(Array) } } })
    const appliedMemories = z.object({ memories: z.array(z.object({ id: z.string(), version: z.number().int().positive(), hash: z.string() })).min(2) })
      .parse(memory.effectReceipt!.result).memories
    expect(appliedMemories).toHaveLength(2)
    expect(memory.effectReceipt!.resultHash).toBe(runtimeJson(memory.effectReceipt!.result).hash)
    expect(await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `effect:${memory.id}` } })).toMatchObject({
      type: 'effect.committed', operationId: memory.id, payload: { operationId: memory.id, resultHash: memory.effectReceipt!.resultHash } })
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: currentMemoryJobId } })).toMatchObject({ status: 'completed' })
    const chapterMemory = await prisma.projectMemoryEntry.findFirstOrThrow({ where: { id: { in: appliedMemories.map(item => item.id) },
      novelId: f.novelId, sourceChapterId: f.chapterId, memoryType: 'chapterSummary' } })
    expect(chapterMemory).toMatchObject({ content: expect.stringContaining(after) })
    expect(appliedMemories.find(item => item.id === chapterMemory.id)).toEqual({ id: chapterMemory.id, version: chapterMemory.version,
      hash: runtimeJson({ title: chapterMemory.title, content: chapterMemory.content }).hash })
    const finalReceipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'completion_finalize' } } })
    expect(finalReceipt.result).toMatchObject({ evidence: { blockers: [], memoryJobs: [{ id: currentMemoryJobId, verified: true }] } })
    expect(await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })).toEqual(originalAttempts)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
    expect(await prisma.memoryExtractionJob.findMany({ where: { novelId: f.novelId, id: { not: currentMemoryJobId } }, orderBy: { id: 'asc' } })).toEqual(historicalJobs)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({ status: 'completed' })
    await publishDurableEvents(f.userId, lease.runId, 200)
    const events = await loadPersistedEvents(lease.runId, 0)
    expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'chapter_write')).toMatchObject([{ ok: true }])
    expect(fetcher).toHaveBeenCalledTimes(expectedReviews + mainRequests)
    const first = await prisma.agentOperation.findFirstOrThrow({ where: { parentOperationId: commitOperation.id, action: 'continuity_validate' }, orderBy: { createdAt: 'asc' } })
    expect(runtimeJson((first.inputSnapshot as { input: { work: { price: unknown } } }).input.work.price).hash).toBe(runtimeJson(price).hash)
  }, undefined, scenario === 'ordinary-presentation' ? '完整重写当前章节' : '完整重写当前章节，只输出标题和正文。', { freezeWriting: true, writingCoordinationProtocol: 2, continuityReportProtocol: 5,
    continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
