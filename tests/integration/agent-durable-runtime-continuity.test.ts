import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { auxiliaryRouteForRuntime,callDurableAuxiliary,resolveDurableAuxiliaryRuntime } from '../../api/lib/agent/runtime-auxiliary-call.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { prepareAuxiliaryModelOperation } from '../../api/lib/agent/runtime-auxiliary-model.js'
import { beginDurableChat } from '../../api/lib/agent/runtime-provider.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { settleProviderOperation, type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { modelRouteRevision, prepareModelCursorOperation, validateModelCursor } from '../../api/lib/agent/runtime-model-cursor.js'
import { currentNativeToolViews } from '../../api/lib/agent/runtime-tool-view.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { initializeExecutionState,loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { commitChapterBridge,prepareStoryCompilation,saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { buildContinuitySnapshot, continuityReviewRequest, readContinuityRequestBilling, type ContinuityReport } from '../../api/lib/agent/continuity-review.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { applyContinuityPatches } from '../../api/lib/agent/tools/durable-continuity.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { chapterBridgeGetTool,continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import * as credits from '../../api/lib/credits.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture,novelFixture,reported } from '../support/agent-durable-runtime-fixture.js'

const legacyReviewRuntime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['none', 'low'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }

describe.runIf(available)('durable continuity actual tool chain', () => {
  it.each(['terminal-contract4', 'terminal-contract4-repair', 'terminal-chain-reassessment', 'terminal-reassessment', 'source-authority-reassessment', 'relocated', 'old5-relocated', 'old6-relocated', 'old7-relocated', 'wrapped-report', 'full-report', 'success', 'chapter-only', 'repair', 'warnings', 'fused-repair', 'format', 'truncated', 'format-retry', 'unknown', 'stale-chapter', 'stale-compiler', 'rollback-resume', 'late-resume', 'protected', 'missing', 'long', 'repair-stale', 'stale-source', 'source-text', 'approval-denied', 'history-over-three', 'single-quotes', 'single-quotes-stale', 'single-quotes-source', 'single-quotes-swapped', 'unavailable-write-recheck'] as const)('%s preserves paid results and atomic business effects', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      let lease = await claim(f)
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
      const relocated = ['relocated', 'old5-relocated', 'old6-relocated', 'old7-relocated'].includes(scenario)
      const repairing = ['repair', 'warnings', 'fused-repair', 'format-retry', 'rollback-resume', 'repair-stale'].includes(scenario)
      const correcting = ['source-authority-reassessment', 'terminal-reassessment', 'terminal-chain-reassessment', 'terminal-contract4-repair'].includes(scenario)
      const cachedCalls = ['success', 'chapter-only', 'source-authority-reassessment', 'terminal-reassessment', 'terminal-chain-reassessment', 'terminal-contract4', 'terminal-contract4-repair'].includes(scenario)
      const before = relocated ? '甲'.repeat(1800) + '唯一引用。' + '乙'.repeat(350)
        : scenario === 'long' ? '开头锚点' + '长正文'.repeat(6000) + '末尾锚点'
          : repairing || scenario === 'protected' ? '原文，门开着，门同时锁着。' : '原文'
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before, wordCount: before.length } })
      let previous: typeof chapter | undefined
      if (['stale-source', 'source-text', 'single-quotes-source', 'single-quotes-swapped'].includes(scenario)) {
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2 } })
        previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId,
          title: '前章', content: '前文', wordCount: 2, orderIndex: 1, orderInVolume: 1 } })
      }
      const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查本章' })
      const compilationId = compilation.id, state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁',
        choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      if (scenario === 'history-over-three') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { validation: { checkRounds: 9 } } })
      const history = relocated ? await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: '冻结旧定位记录',
        content: JSON.stringify({ parser: scenario, segmentId: 'c5', quote: '唯一引用。' }), metadata: { parser: scenario } } }) : null
      const tools = [chapterBridgeGetTool, continuityValidateTool, ...(scenario === 'unavailable-write-recheck' ? [chapterReadTool, chapterWriteTool] : [])]
      const checkArgs = scenario === 'chapter-only' ? { chapterId: f.chapterId } : { compilationId }
      const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
        { id: 'check', name: 'continuity_validate', arguments: JSON.stringify(checkArgs) }]
      if (cachedCalls) calls.push({ id: 'cached', name: 'continuity_validate', arguments: JSON.stringify(checkArgs) })
      if (scenario === 'unavailable-write-recheck') calls.push(
        { id: 'read-current', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'write-current', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '新文，门已经锁好。' }) },
        { id: 'bridge-current', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
        { id: 'check-current', name: 'continuity_validate', arguments: JSON.stringify(checkArgs) })
      if (scenario === 'missing') calls.shift()
      const configuration = { version: 1 as const, mode: 'build' as const, agentType: 'orchestrator' as const,
        creativeFreedom: repairing || scenario === 'protected' ? 'balanced' as const : 'stable' as const, qualityMode: 'premium' as const,
        model: { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high' as const, routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' && tool.name === 'continuity_validate' ? 'ask' as const : 'allow' as const,
          alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] }
      await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle',
        pendingOperationId: null, messages: [{ role: 'user', content: '完整检查本章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ ...legacyReviewRuntime, reasoningEffort: 'high', reasoningEfforts: ['none', 'low', 'high'] })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'continuity-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const table = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: chapter.revision }, before)
      const currentId = (relocated ? table.entries.find(entry => entry.text.includes('唯一引用。'))! : table.entries[0]).id.slice(0, 13)
      const previousId = previous && buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: previous.id,
        chapterRevision: previous.revision }, previous.content).entries[0].id.slice(0, 13)
      const opinion = (index = 0) => ({ signal: 'object', severity: scenario === 'warnings' ? 'warning' : repairing || scenario === 'protected' || scenario === 'single-quotes-source' ? 'error' : 'warning',
        explanation: scenario.startsWith('single-quotes') ? "前后原文：'前文' / '原文'" : '原文承接意见 ' + index,
        suggestion: '核对当前实际动作并保留作者意图', evidence: scenario === 'single-quotes-source' ? [{ sourceId: previousId }, { sourceId: currentId }]
          : [{ sourceId: correcting || scenario === 'single-quotes-stale' || scenario === 'single-quotes-swapped' ? 'missing-source' : currentId }] })
      let requests = 0, corrections = 0
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body)), system = String(body.messages[0].content)
        expect(body.max_tokens).toBe(16_384)
        expect(body.tools).toBeUndefined()
        expect(body.reasoning_effort).toBe('none')
        expect(credits.getModelTierRuntime).toHaveBeenCalledWith('speed', f.userId, null, 'high')
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        const repair = system.includes('只替换列出的本章原文片段'), correction = system.startsWith('只为原意见'), format = system.includes('只纠正这份原回复')
        if (!repair && !correction && !format) {
          const input = JSON.parse(body.messages[1].content)
          expect(input).toMatchObject({ currentChapter: f.chapterId, sources: expect.arrayContaining([expect.objectContaining({ source: 'current', content: requests > 2 ? '新文，门已经锁好。' : before })]) })
          expect(input).not.toHaveProperty('terminalCandidate')
          if (previous) expect(input.sources).toContainEqual(expect.objectContaining({ source: 'previous', chapterId: previous.id, content: '前文' }))
          if (scenario === 'long') expect(input.sources[0].content).toBe(before)
        }
        if (scenario === 'unknown') throw new Error('fixture unknown critic')
        if (scenario === 'stale-chapter' || scenario === 'repair-stale' && repair)
          await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户新文', revision: { increment: 1 } } })
        if (scenario === 'stale-source') await prisma.chapter.update({ where: { id: previous!.id }, data: { content: '新的前文', revision: { increment: 1 } } })
        if (scenario === 'stale-compiler') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { preparedContext: { changed: true } } })
        if (scenario === 'late-resume' && requests === 1) await pauseDurableTask(f.userId, lease.runId)
        let content: string
        if (repair) content = scenario === 'format-retry' ? 'broken repair JSON' : JSON.stringify({ patches: [{ findingId: '0', replacement: '新文，门已经锁好。' }], retainedFindings: [] })
        else if (correction) { corrections++; content = JSON.stringify({ corrections: correcting ? [{ index: 0, evidence: [{ sourceId: currentId }] }] : [] }) }
        else if (scenario === 'format' || scenario === 'unavailable-write-recheck' && requests <= 2) content = 'broken JSON'
        else if (format) content = JSON.stringify({ findings: [opinion()] })
        else if (scenario === 'wrapped-report') content = JSON.stringify({ report: { findings: [opinion()] } })
        else content = JSON.stringify({ findings: scenario === 'full-report' ? Array.from({ length: 31 }, (_, i) => opinion(i))
          : scenario === 'warnings' ? Array.from({ length: 3 }, (_, i) => opinion(i))
            : repairing || scenario === 'protected' || correcting || relocated || scenario.startsWith('single-quotes') ? [opinion()] : [],
          ...(scenario === 'fused-repair' ? { patches: [{ oldText: '原文', newText: 'INJECTED_FROM_CRITIC' }] } : {}) })
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario !== 'missing') await step()
      if (scenario === 'approval-denied') {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected approval')
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'check', approved: false, alwaysAllow: false })
        runtime.mockRejectedValue(new Error('Denied tool must not resolve model configuration'))
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(fetchMock).not.toHaveBeenCalled()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      if (scenario === 'rollback-resume' || scenario.startsWith('old')) {
        const original = runtimeOperations.commitOperationEffect
        const rollback = vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, digest, work) => original(token, id, digest,
          async tx => { await work(tx); throw new Error('fixture continuity rollback') }))
        try { await expect(step()).rejects.toThrow('fixture continuity rollback') } finally { rollback.mockRestore() }
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(before)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'continuity_validate' } } })).toBe(0)
        await pauseDurableTask(f.userId, lease.runId)
      }
      if (scenario === 'late-resume') await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      if (scenario === 'late-resume' || scenario === 'rollback-resume' || scenario.startsWith('old')) {
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'continuity-resume')
        runtime.mockRejectedValue(new Error('Must replay without resolving current model configuration'))
      }
      if (scenario === 'unknown') {
        await expect(step()).rejects.toThrow('fixture unknown critic')
        await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      if (scenario === 'unavailable-write-recheck') {
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' } })
        expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, { ...f, runId: lease.runId }, compilationId))).toMatchObject({ continuity: 'incomplete' })
        await step()
        expect(await step()).toMatchObject({ kind: 'tool', result: { display: { kind: 'chapterDiff', revision: 2 } } })
        await step()
        expect(await step()).toMatchObject({ kind: 'tool', result: { reviewCompleted: true } })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 2, independentCheck: 'complete' })
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(3)
        return
      }
      const result = await step(), failed = ['format', 'truncated', 'format-retry', 'stale-chapter', 'repair-stale', 'stale-source', 'single-quotes-stale', 'single-quotes-swapped'].includes(scenario)
      expect(result).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { summary: expect.stringContaining('连续性') } })
      if (cachedCalls) expect(await step()).toMatchObject({ kind: 'tool', result: { reviewCompleted: true, output: expect.stringContaining('复用已保存报告') } })
      const expectedRequests = repairing && scenario !== 'repair-stale' || ['repair-stale', 'wrapped-report', 'format', 'truncated', 'single-quotes-stale', 'single-quotes-swapped'].includes(scenario) || correcting ? 2 : 1
      expect(fetchMock).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(expectedRequests)
      expect(corrections).toBe(correcting || scenario === 'single-quotes-stale' || scenario === 'single-quotes-swapped' ? 1 : 0)
      const savedChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } }), applied = repairing && !['format-retry', 'repair-stale'].includes(scenario)
      expect(savedChapter).toMatchObject({ revision: scenario === 'stale-chapter' || scenario === 'repair-stale' || applied ? 2 : 1,
        content: scenario === 'stale-chapter' || scenario === 'repair-stale' ? '用户新文' : applied ? '新文，门已经锁好。' : before })
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      if (scenario === 'stale-chapter' || scenario === 'stale-source') expect(saved.validation).toBeNull()
      else expect(saved.validation).toMatchObject({ checkedRevision: 1, continuityReport: { complete: !['format', 'truncated', 'single-quotes-stale', 'single-quotes-swapped'].includes(scenario) } })
      if (scenario === 'full-report') expect(saved.validation).toMatchObject({ warningCount: 31, continuityReport: { opinions: Array.from({ length: 31 }, (_, i) => expect.objectContaining({ explanation: '原文承接意见 ' + i })) } })
      if (scenario === 'wrapped-report') expect(saved.validation).toMatchObject({ continuityReport: { rawResponses: [expect.stringContaining('report'), expect.stringContaining('findings')] } })
      if (scenario === 'history-over-three') expect(saved.validation).toMatchObject({ checkRounds: 9 })
      if (correcting) expect(saved.validation).toMatchObject({ continuityReport: { opinions: [expect.objectContaining({ explanation: '原文承接意见 0' })], rawResponses: expect.any(Array) } })
      if (history) expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history)
      expect((await loadExecutionState(f.userId, lease.runId)).configuration).toEqual(configuration)
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'continuity_validate')).toMatchObject(cachedCalls ? [{ ok: true }, { ok: true }] : [{ ok: !failed }])
    }, undefined, scenario === 'chapter-only' ? '完成当前章节' : '修改本章')
  })
  it('applies only unique nonoverlapping anchors from original content', () => {
    expect(applyContinuityPatches('原文尾部', [{ oldText: '原文', newText: '新文' }, { oldText: '新文', newText: '注入文本' }, { oldText: '文尾', newText: '重叠' }, { oldText: '尾部', newText: '结尾' }])).toEqual({ after: '新文结尾', applied: 2 })
    expect(applyContinuityPatches('aaaa', [{ oldText: 'aaa', newText: 'x' }])).toEqual({ after: 'aaaa', applied: 0 })
  })
})

describe.runIf(available).each(['continuity', 'quality', 'quality-evidence'] as const)('auxiliary model durable admission %s', family => {
  const tool = family !== 'continuity' ? qualityAnalyzeTool : continuityValidateTool
  const criticStep = family !== 'continuity' ? 'quality_critic' : 'continuity_critic'
  const repairStep = family === 'quality-evidence' ? 'quality_evidence_correction' : family !== 'continuity' ? 'quality_repair' : 'continuity_repair'
  const retryStep = family === 'quality-evidence' ? 'quality_evidence_correction' : family !== 'continuity' ? 'quality_repair_retry' : 'continuity_repair'
  it.each([...(['replay', 'read-only', 'stop-resume', 'unknown', 'changed-input', 'wrong-attempt', 'wrong-step', 'skip-critic', 'damaged-prerequisite', 'ordered-repair', 'tools-leak', 'history-leak', 'late-result', 'concurrent', 'missing-result-event', 'cross-family', 'prepared-policy-conflict', 'old-paid-replay', 'old-paid-unknown'] as const),
    ...(family === 'continuity' ? ['typed23-missing-novel', 'typed23-missing-work-fields'] as const : [])])('%s binds paid work to the original pending tool', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: [{ type: 'function', function: { name: tool.name, description: '', parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '检查本章' }], successfulToolSignatures: [] } })
      const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'aux-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
      const mainCursor = { expectedRevision: initial.frame.revision, expectedHash: initial.frame.snapshotHash }
      const views = await currentNativeToolViews(initial.configuration.tools, f.spec.scope)
      await validateModelCursor(lease, mainCursor, { operationKey: 'exec:0', messages: initial.frame.state.messages, tools: views, tier: 'speed', route })
      const mainRequest = { endpoint: route.endpoint, body: { model: route.model, reasoning_effort: route.reasoningEffort, tools: views } }
      const main = await prepareModelCursorOperation(lease, mainCursor, { key: 'exec:0', action: 'workspaceAgent', request: mainRequest, price })
      const mainAttempt = await runtimeOperations.prepareProviderAttempt(lease, { operationId: main.operation.id, attemptKey: '1', provider: route.provider, model: route.model, request: mainRequest })
      await runtimeOperations.markProviderDispatched(lease, mainAttempt.id)
      const mainIdentity = { userId: f.userId, attemptId: mainAttempt.id, requestHash: mainAttempt.requestHash }
      await runtimeOperations.recordProviderUsage({ ...mainIdentity, revision: 1, usage: reported })
      await runtimeOperations.recordProviderResult({ ...mainIdentity, outcome: 'succeeded', result: { content: '', reasoning: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'critic-call', name: tool.name, arguments: '{}' }],
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
      expect(await settleProviderOperation({ ...mainIdentity, lease })).toMatchObject({ status: 'settled' })
      await reduceExecutionReceipt(lease, { expectedRevision: main.pending.revision, expectedHash: main.pending.snapshotHash, operationId: main.operation.id })
      const assistant = await loadExecutionState(f.userId, lease.runId)
      const source = family === 'continuity' ? await buildContinuitySnapshot({ ...f, runId: lease.runId }, {}) : null
      const critic = source && continuityReviewRequest(source)
      const work = source && { kind: 'continuityReview', chapterId: source.chapter.id, revision: source.chapter.revision, contextHash: source.contextHash,
        critic, route: { provider: 'fixture', model: 'fixture', baseUrl: 'https://provider.invalid/v1', maxOutputTokens: 1024 }, price }
      const parent = await prepareToolCursorOperation(lease, { expectedRevision: assistant.frame.revision, expectedHash: assistant.frame.snapshotHash }, {
        key: `exec:${assistant.frame.state.nextOperationSequence}`, action: tool.name, callId: 'critic-call', targetId: f.chapterId, effectDomain: 'chapter',
        operationInput: { callId: 'critic-call', args: {}, ...(scenario === 'typed23-missing-novel' ? { work: { version: 23 } }
          : scenario === 'typed23-missing-work-fields' ? { novelId: f.novelId, work: { version: 23 } }
            : work ? { novelId: f.novelId, work } : {}) },
        effectiveArgs: {}, normalize: parsed => tool.parameters.parse(parsed),
      })
      const request = (step: import('../../api/lib/agent/runtime-auxiliary-model.js').AuxiliaryModelStep = criticStep) => ({
        messages: (critic && step === 'continuity_critic' ? [{ role: 'system' as const, content: critic.system }, { role: 'user' as const, content: critic.content }]
          : [{ role: 'user' as const, content: '独立检查原文' }]) as import('../../api/lib/ai-service.js').ChatMessage[], tools: [] as import('../../api/lib/ai-service.js').OpenAIToolDefinition[], model: 'fixture', provider: 'fixture', maxOutputTokens: 1024,
        providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        reasoningParameterMode: 'native' as const, thinkingEnabled: false, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>,
        durableExecution: { lease, operationKey: `aux:${parent.operation.id}:${step}`, parentOperationId: parent.operation.id, auxiliaryStep: step, attemptKey: '1', price },
        usageLog: { userId: f.userId, agentRunId: lease.runId, action: step, modelTier: 'speed' as const },
      })
      const fetchMock = vi.fn(async () => {
        if (scenario === 'unknown') throw new Error('fixture lost response')
        if (scenario === 'late-result') await pauseDurableTask(f.userId, lease.runId)
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      if (scenario === 'typed23-missing-novel' || scenario === 'typed23-missing-work-fields') {
        await expect(chatWithTools(request())).rejects.toBeInstanceOf(z.ZodError)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.operation.id } })).toBe(0)
        return
      }
      if (family === 'continuity') {
        expect(parent.operation.inputSnapshot).toMatchObject({ input: { novelId: f.novelId, work: { kind: 'continuityReview',
          chapterId: f.chapterId, contextHash: source!.contextHash } } })
      }
      if (scenario === 'prepared-policy-conflict' || scenario === 'old-paid-replay' || scenario === 'old-paid-unknown') {
        const original = request()
        const savedRequest = { endpoint: 'https://provider.invalid/v1/chat/completions', body: {
          model: 'fixture', messages: original.messages, thinking: { type: 'enabled' }, reasoning_effort: 'high', stream: true, max_tokens: 1024,
        } }
        const operationInput: Parameters<typeof prepareAuxiliaryModelOperation>[1] = { key: original.durableExecution.operationKey, action: criticStep, request: savedRequest, price,
          parentOperationId: parent.operation.id, step: criticStep }
        if (scenario === 'prepared-policy-conflict') {
          const prepared = await prepareAuxiliaryModelOperation(lease, operationInput)
          await expect(chatWithTools(original)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
          expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: prepared.id } })).toEqual(prepared)
          expect(await prisma.agentProviderAttempt.count({ where: { operationId: prepared.id } })).toBe(0)
        } else {
          const paid = await beginDurableChat({ execution: original.durableExecution, userId: f.userId, agentRunId: lease.runId,
            action: criticStep, provider: 'fixture', model: 'fixture', request: savedRequest, price, admit: async () => {} })
          if (scenario === 'old-paid-unknown') await paid.interrupted('transport_error')
          else {
            await paid.observe({ promptTokens: 10, completionTokens: 0, cacheHitTokens: null, cacheMissTokens: null, source: 'reported' })
            await paid.finish({ content: '{"findings":[]}', reasoning: '', toolCalls: [], finishReason: 'stop',
              usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } })
          }
          const before = await prisma.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: { taskRootId: f.rootId, operationKey: original.durableExecution.operationKey } } })
          const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockRejectedValue(new Error('Old paid request must not resolve current credentials'))
          const checkCurrent = vi.fn(async () => {})
          const replay = callDurableAuxiliary({ lease, parentOperationId: parent.operation.id, step: criticStep,
            route: { provider: 'fixture', model: 'fixture', baseUrl: 'https://provider.invalid/v1', maxOutputTokens: 1024 }, price,
            system: '当前合成规则', content: '当前合成正文', temperature: 0.15, signal: new AbortController().signal, assertCurrent: checkCurrent })
          if (scenario === 'old-paid-unknown') await expect(replay).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
          else await expect(replay).resolves.toMatchObject({ content: '{"findings":[]}', billing: { status: 'settled', chargedMilli: 1 } })
          expect(runtime).not.toHaveBeenCalled()
          expect(checkCurrent).not.toHaveBeenCalled()
          expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before)
          expect(await prisma.agentProviderAttempt.count({ where: { operationId: before.id } })).toBe(1)
        }
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(scenario === 'old-paid-replay' ? 2 : 1)
        return
      }
      if (scenario === 'read-only') {
        await prisma.agentSession.update({ where: { id: f.sessionId }, data: { sandboxMode: 'read_only' } })
        expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { parentOperationId: parent.operation.id }, dispatchedAt: { not: null } } })).toBe(1)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(2)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
        return
      }
      if (scenario === 'wrong-attempt' || scenario === 'wrong-step' || scenario === 'skip-critic' || scenario === 'tools-leak' || scenario === 'history-leak' || scenario === 'cross-family') {
        const invalid = request(scenario === 'cross-family' ? (family !== 'continuity' ? 'continuity_critic' : 'quality_critic') : scenario === 'skip-critic' ? repairStep : criticStep)
        if (scenario === 'wrong-attempt') invalid.durableExecution.attemptKey = '2'
        if (scenario === 'skip-critic' && family === 'continuity') invalid.durableExecution.auxiliaryStep = 'continuity_coordinated_revision' as typeof repairStep
        if (scenario === 'wrong-step') invalid.durableExecution.operationKey += '-other'
        if (scenario === 'tools-leak') invalid.tools = [{ type: 'function', function: { name: 'chapter_write', description: '', parameters: {} } }]
        if (scenario === 'history-leak') invalid.messages.push({ role: 'assistant', content: '从旧章节继续' })
        await expect(chatWithTools(invalid)).rejects.toMatchObject({ code: scenario === 'skip-critic' && family !== 'continuity' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.operation.id } })).toBe(0)
        return
      }
      if (scenario === 'unknown') {
        await expect(chatWithTools(request())).rejects.toThrow('fixture lost response')
        await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        await expect(chatWithTools(request(repairStep))).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
        return
      }
      if (scenario === 'concurrent') {
        const results = await Promise.allSettled([chatWithTools(request()), chatWithTools(request())])
        expect(results.some(item => item.status === 'fulfilled')).toBe(true)
        for (const item of results) if (item.status === 'rejected') expect(item.reason).toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      } else if (scenario === 'late-result') {
        await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
        expect(await prisma.agentProviderAttempt.findFirst({ where: { operation: { parentOperationId: parent.operation.id } } })).toMatchObject({ status: 'succeeded' })
      } else expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}', billing: { status: 'settled', chargedMilli: 1 } })
      if (scenario === 'stop-resume' || scenario === 'late-result') {
        const oldRequest = request()
        if (scenario === 'stop-resume') await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
        await expect(chatWithTools(oldRequest)).rejects.toThrow()
      }
      if (scenario === 'changed-input') {
        const changed = request(); changed.messages[0].content = '改用另一章'
        await expect(chatWithTools(changed)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      }
      if (scenario === 'damaged-prerequisite' || scenario === 'missing-result-event') {
        const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { parentOperationId: parent.operation.id } } })
        if (scenario === 'damaged-prerequisite') await prisma.agentProviderAttempt.update({ where: { id: attempt.id }, data: { resultHash: '0'.repeat(64) } })
        else {
          await prisma.agentExecutionOutbox.delete({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
          await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        }
        await expect(chatWithTools(request(repairStep))).rejects.toMatchObject({ code: family === 'continuity' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_RECEIPT_INVALID' })
      } else {
        expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}', billing: { chargedMilli: 1 } })
        if (scenario === 'ordered-repair') {
          await chatWithTools(request(repairStep))
          await chatWithTools(request(retryStep))
          await chatWithTools(request(retryStep))
        }
      }
      const count = scenario === 'ordered-repair' ? (family === 'quality-evidence' || family === 'continuity' ? 2 : 3) : 1
      expect(fetchMock).toHaveBeenCalledTimes(count)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(count + 1)
      expect(await readTaskBudget(lease)).toMatchObject({ usedTokens: BigInt(10 * (count + 1)), attempts: BigInt(count + 1), unresolvedAttempts: 0n })
      expect((await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId: f.userId } })).metadata).toMatchObject({ pricingVersion: 'credits-v2-itemized', rateCardId: 'aux-fixture' })
      const saved = await loadExecutionState(f.userId, lease.runId)
      expect(saved.frame.revision).toBe(parent.pending.revision)
      expect(saved.frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: parent.operation.id, turn: 1 })
    })
  })
})

describe.runIf(available)('auxiliary model route inheritance (isolated PG)', () => {
  it.each(['free', 'byok'] as const)('free and BYOK auxiliary calls preserve the admitted %s runtime', async kind => {
    await fixture(async f => {
      const lease = await claim(f)
      const tool = continuityValidateTool
      const isByok = kind === 'byok'
      const runtime = {
        tier: isByok ? 'custom' as const : 'speed' as const,
        multiplierBps: 0,
        provider: 'deepseek',
        modelName: isByok ? 'deepseek-flash' : 'deepseek-v4-flash',
        baseUrl: isByok ? 'https://byok.invalid/v1' : 'https://free.invalid/v1',
        apiKey: 'fixture-key', reasoningEffort: 'low' as const, reasoningEfforts: ['none' as const, 'low' as const],
        thinkingEnabled: true, reasoningParameterMode: 'native' as const, outputTokenParameter: 'max_completion_tokens' as const,
        visionEnabled: false, contextWindowTokens: 64_000,
      }
      const selection = { tier: runtime.tier, customModelId: isByok ? 'fixture-byok-config' : null, reasoningEffort: 'low' as const }
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: runtime.tier, provider: runtime.provider, modelName: runtime.modelName, customModelId: selection.customModelId, reasoningEffort: 'low', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] }
      const initial = await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
        phase: 'idle', pendingOperationId: null, messages: [{ role: 'user' as const, content: '检查本章' },
          { role: 'assistant' as const, content: null, toolCalls: [{ id: 'critic-call', name: tool.name, arguments: '{}' }] }], successfulToolSignatures: [] } })
      const resolved = await resolveDurableAuxiliaryRuntime({ userId: f.userId, modelRuntime: runtime, modelSelection: selection })
      const route = auxiliaryRouteForRuntime(resolved.runtime, resolved.selection, 1024)
      const price: DurableTokenPrice = { version: 'credits-v1-exact', modelTier: runtime.tier, multiplierBps: 0 }
      const source = await buildContinuitySnapshot(f, {}), critic = continuityReviewRequest(source)
      const parent = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
        key: 'exec:0', action: tool.name, callId: 'critic-call', targetId: f.chapterId, effectDomain: 'chapter',
        operationInput: { callId: 'critic-call', args: {}, novelId: f.novelId, work: { kind: 'continuityReview', chapterId: source.chapter.id,
          revision: source.chapter.revision, contextHash: source.contextHash, critic, route, price } }, effectiveArgs: {}, normalize: parsed => tool.parameters.parse(parsed),
      })
      const fetchMock = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`))
      vi.stubGlobal('fetch', fetchMock)
      const runtimeSpy = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
      const result = await callDurableAuxiliary({ lease, parentOperationId: parent.operation.id, step: 'continuity_critic', route, price,
        system: critic.system, content: critic.content, temperature: 0.15, signal: new AbortController().signal, assertCurrent: async () => {} })
      expect(result).toMatchObject({ content: '{"findings":[]}', billing: { status: 'settled', chargedMilli: 0 } })
      expect(runtimeSpy).toHaveBeenCalledWith(runtime.tier, f.userId, selection.customModelId, 'low')
      expect(fetchMock).toHaveBeenCalledOnce()
      const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
      expect(requestBody).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: 1024 })
      expect(requestBody.thinking).toBeUndefined()
      expect(requestBody.max_tokens).toBeUndefined()
      const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { parentOperationId: parent.operation.id } } })
      expect(attempt).toMatchObject({ provider: runtime.provider, model: runtime.modelName, status: 'succeeded' })
      expect(JSON.stringify(attempt.requestSnapshot)).not.toContain('fixture-key')
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
      expect(await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId: f.userId } })).toMatchObject({ deltaMilli: 0, multiplierBps: 0 })
    })
  }, 30_000)
})

describe.runIf(available)('continuity validation and atomic commit', () => {
  it('checks the actual external revision and preserves the original paid report without a phase receipt', async () => {
    await novelFixture(async f => {
      try {
      const before = '卡余80200，已付房租1800。碗8200成交。银行卡余71700。'
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before } })
      const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = prepared.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进交易', entryState: state, goal: '买碗', obstacle: '议价', choice: '成交', cost: '8200', turn: '取得碗', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const table = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 1 }, before)
      const responses = [JSON.stringify({ findings: [{ signal: 'object', severity: 'error',
        explanation: '账户扣除碗款后的余额算术不符。', suggestion: '核对成交款后的余额，不重扣已付房租。',
        evidence: [{ sourceId: table.entries[0].id.slice(0, 13) }, { sourceId: table.entries.at(-1)!.id.slice(0, 13) }] }] }), '{"findings":[]}']
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const completion = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: responses.shift() }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
      vi.stubGlobal('fetch', completion)
      const ctx: ToolContext = { ...f, callId: 'check', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', modelRuntime: legacyReviewRuntime, signal: new AbortController().signal, emit: () => {} }
      const first = await continuityValidateTool.execute(ctx, { compilationId })
      expect(first.output).toContain('卡余80200')
      expect(first.output).toContain('银行卡余71700')
      expect(first.summary).toContain('1 错误')
      const original = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before.replace('71700', '72000'), revision: { increment: 1 } } })
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ reviewCompleted: true, display: { errorCount: 0 } })
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ reviewCompleted: true, output: expect.stringContaining('复用已保存报告') })
      expect(completion).toHaveBeenCalledTimes(2)
      const usage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: 'agent3ContinuityCritic' } })
      expect(usage).toHaveLength(2)
      expect(usage.every(row => row.usageSource === 'reported' && row.billingStatus === 'settled')).toBe(true)
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'continuityReview' } })).toBe(2)
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).toMatchObject({ preparedContext: original.preparedContext,
        validation: { checkedRevision: 2, continuityReport: { complete: true, findings: [] } } })
      expect(await prisma.aiUsageLog.findMany({ where: { id: { in: paid.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(paid)
      expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(artifacts)
      expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(ledger)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    })
  })
  it('ignores critic patches, reuses current findings, and keeps verified factual errors separate from missing checks', async () => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await novelFixture(async f => {
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文，门开着，门同时锁着。' } })
      const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = prepared.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const sourceId = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: chapter.revision }, chapter.content).entries[0].id.slice(0, 13)
      const raw = JSON.stringify({ findings: [{ signal: 'body', severity: 'error', explanation: '原文存在冲突', suggestion: '局部修订', evidence: [{ sourceId }] }],
        patches: [{ oldText: '原文', newText: '未经授权的critic正文' }] })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const completion = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })))
      vi.stubGlobal('fetch', completion)
      const ctx: ToolContext = { ...f, callId: 'critic', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', modelRuntime: legacyReviewRuntime, signal: new AbortController().signal, emit: () => {} }
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ summary: expect.stringContaining('连续性检查') })
      expect(completion).toHaveBeenCalledOnce()
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '原文，门开着，门同时锁着。', revision: 1 })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 1, errorCount: 1 })
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ reviewCompleted: true, output: expect.stringContaining('复用已保存报告') })
      expect(completion).toHaveBeenCalledOnce()
      await persistHumanityQualityReport({ ...f, compilationId, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced',
        criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      await expect(commitChapterBridge({ ...f, compilationId, chapterSummary: '摘要', exitState: state, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '收束' })).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
    })
  })
  it.each(['unavailable', 'stale-critic', 'stale-commit', 'source-commit', 'commit-rollback', 'commit', 'tool-unavailable', 'tool-stale', 'repair-race'] as const)('%s never certifies another revision or partially commits memory', async scenario => {
    await fixture(async f => {
      vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      if (scenario === 'repair-race') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文，门开着，门同时锁着。' } })
      const first = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const target = scenario === 'source-commit' ? await prisma.chapter.create({ data: { novelId: f.novelId, authorId: f.userId,
        volumeId: first.volumeId, orderIndex: 2, orderInVolume: 2, title: '待提交的新章', content: '原文', wordCount: 2 } }) : first
      const { compilation } = await prepareStoryCompilation({ ...f, chapterId: target.id, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = compilation.id, state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁',
        choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const terminal = { ...f, compilationId, chapterSummary: '章节摘要', exitState: state, lastUnfinishedAction: '', hookDecision: '',
        delayedHookReason: '', openingStructure: '动作', endingStructure: '发现线索' }
      const changeChapter = () => prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户修改', revision: { increment: 1 } } })
      if (scenario === 'stale-critic') {
        await changeChapter()
        await expect(persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: 1 })).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      await persistHumanityQualityReport({ ...f, compilationId, chapterId: target.id, chapterRevision: target.revision, mode: 'balanced',
        criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      if (scenario.startsWith('tool-') || scenario === 'repair-race') {
        const table = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: target.id, chapterRevision: target.revision }, target.content)
        const window = getCreditWindow()
        await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
        let calls = 0
        const network = vi.fn(async () => {
          calls++
          let content: string
          if (scenario === 'tool-unavailable') content = 'not JSON'
          else if (scenario === 'tool-stale') { await changeChapter(); content = '{"findings":[]}' }
          else if (calls === 1) content = JSON.stringify({ findings: [{ signal: 'body', severity: 'error', explanation: '原文存在冲突',
            suggestion: '局部修订', evidence: [{ sourceId: table.entries[0].id.slice(0, 13) }] }] })
          else { await changeChapter(); content = '{"patches":[{"findingId":"0","replacement":"模型修改"}],"retainedFindings":[]}' }
          return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
        })
        vi.stubGlobal('fetch', network)
        const ctx: ToolContext = { ...f, chapterId: target.id, callId: 'critic', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
          modelRuntime: legacyReviewRuntime, signal: new AbortController().signal, emit: () => {} }
        const check = continuityValidateTool.execute(ctx, { compilationId })
        if (scenario === 'tool-stale') await expect(check).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
        else expect(await check).toMatchObject({ outcome: 'failed', failureCode: scenario === 'repair-race' ? 'CONTINUITY_INPUT_STALE' : 'CONTINUITY_REPORT_INCOMPLETE' })
        expect(calls).toBe(scenario === 'tool-stale' ? 1 : 2)
        expect(await prisma.aiUsageLog.count({ where: { userId: f.userId, billingStatus: 'settled' } })).toBe(calls)
        if (scenario !== 'tool-unavailable') expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('用户修改')
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
      } else {
        await persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: 1,
          independentCheck: scenario === 'unavailable' ? 'unavailable' : 'complete' })
        if (scenario === 'stale-commit' || scenario === 'source-commit') await changeChapter()
        if (scenario === 'unavailable' || scenario === 'stale-commit' || scenario === 'source-commit')
          await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
        else if (scenario === 'commit-rollback')
          await expect(prisma.$transaction(async tx => { await commitChapterBridge(terminal, tx); throw new Error('fixture-commit-rollback') })).rejects.toThrow('fixture-commit-rollback')
        else {
          expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(2)
          expect(await prisma.memoryEvidence.count({ where: { memory: { novelId: f.novelId } } })).toBe(2)
          return
        }
      }
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('active')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toBeNull()
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.sceneTask.count({ where: { compilationId, status: 'completed' } })).toBe(0)
    }, undefined, '修改第一章和第二章，完成连续性和人类感检查后提交。')
  })
})
describe.runIf(available)('native continuity recovery keeps a complete second response with unknown usage fenced', () => {
  it('does not apply, clear or redispatch a second reply whose usage was not reported', () => fixture(async f => {
    const lease = await claim(f), body = '原文'
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '检查本章' })
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '核查', entryState: state, goal: '核查', obstacle: '未知', choice: '核查', cost: '时间', turn: '核查', exitState: state,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const tools = [chapterBridgeGetTool, continuityValidateTool]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '检查本章' }, { role: 'assistant', content: null, toolCalls: [
          { id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: compilation.id }) },
          { id: 'check', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) }] }] } })
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ ...legacyReviewRuntime, reasoningEffort: 'high', reasoningEfforts: ['none', 'high'] })
    vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
      rateCardId: 'continuity-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
    let requests = 0
    const sourceId = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 1 }, body).entries[0].id.slice(0, 13)
    const network = vi.fn(async () => {
      requests++
      const wire = requests === 1 ? { findings: [{ signal: 'object', severity: 'warning', explanation: '原文承接意见',
        suggestion: '核对当前原文', evidence: [{ sourceId: 'missing-source' }] }] }
        : { corrections: [{ index: 0, evidence: [{ sourceId }] }] }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(wire) }, finish_reason: 'stop' }],
        ...(requests === 1 ? { usage: { prompt_tokens: 12, completion_tokens: 8 } } : {}) })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', network)
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    await expect(step()).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(network).toHaveBeenCalledTimes(2)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toBeNull()
    const originalAttempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })
    const originalRaw = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' }, orderBy: { id: 'asc' } })
    const originalLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    await expect(step()).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(network).toHaveBeenCalledTimes(2)
    expect(await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })).toEqual(originalAttempts)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' }, orderBy: { id: 'asc' } })).toEqual(originalRaw)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
    const auxiliary = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'continuity_evidence_correction' } }, include: { usageReceipt: true } })
    expect(auxiliary.usageReceipt).not.toMatchObject({ source: 'reported', settlementStatus: 'settled' })
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'continuity_validate' } } })).toBe(0)
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2 }))
})

type NativeContinuityFixture = Parameters<Parameters<typeof fixture>[0]>[0]
const nativeRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Independent synthetic owner; only HTTP bytes and injected process failures
 * are controlled. Admission, child requests, settlement, report persistence,
 * pause/resume and chapter CAS all use the registered native entrypoint. */
async function nativeContinuityRecoveryFixture(f: NativeContinuityFixture) {
  vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  let lease = await claim(f)
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
  const before = '原文，门开着，门同时锁着。', after = '新文，门已经锁好。'
  const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before, wordCount: before.length } })
  const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '检查并局部修正当前章节' })
  const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
  await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '核查门的动作', entryState: state, goal: '核查', obstacle: '动作冲突',
    choice: '核对原文', cost: '时间', turn: '保留明确状态', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  const tools = [chapterBridgeGetTool, continuityValidateTool]
  const configuration = { version: 1 as const, mode: 'build' as const, agentType: 'orchestrator' as const,
    creativeFreedom: 'balanced' as const, qualityMode: 'premium' as const,
    model: { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high' as const, routeRevision: 'a'.repeat(64) },
    tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
    toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] }
  await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle',
    pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'user', content: '修改本章，核查并局部修正动作冲突' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'recovery-bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: compilation.id }) },
        { id: 'recovery-check', name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) }] }] } })
  const window = getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ ...legacyReviewRuntime, reasoningEffort: 'high', reasoningEfforts: ['none', 'low', 'high'] })
  vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
    rateCardId: 'native-recovery-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
  const sourceId = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: chapter.revision }, before).entries[0].id.slice(0, 13)
  const criticRaw = JSON.stringify({ findings: [{ signal: 'object', severity: 'error', explanation: '同一句中门同时处于打开与锁闭状态。',
    suggestion: '只修正这处动作冲突，保留其余正文。', evidence: [{ sourceId }] }] })
  const repairRaw = JSON.stringify({ patches: [{ findingId: '0', replacement: after }], retainedFindings: [] })
  let duringHttp: ((repair: boolean) => Promise<void>) | undefined
  const network = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> }
    expect(body.model).toBe('fixture')
    expect(body.messages.map(message => message.role)).toEqual(['system', 'user'])
    const repair = body.messages[0].content.includes('只替换列出的本章原文片段')
    if (repair) expect(JSON.parse(body.messages[1].content)).toMatchObject({ current: before,
      findings: [{ findingId: '0', original: before }] })
    else expect(JSON.parse(body.messages[1].content)).toMatchObject({ currentChapter: chapter.id,
      sources: [expect.objectContaining({ chapterId: chapter.id, revision: chapter.revision, content: before })] })
    await duringHttp?.(repair)
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: repair ? repairRaw : criticRaw }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', network)
  const step = () => executeDurableToolStep(lease, new AbortController().signal)
  expect(await step()).toMatchObject({ kind: 'tool' }) // Real bridge read admits the exact compiler baseline.
  const parent = () => prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate' } })
  const physical = async () => {
    const rows = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
    expect(rows).toHaveLength(1)
    const value = nativeRecord(rows[0].metadata)
    const metadata = { callId: z.string().parse(value.callId), requestClosed: z.boolean().parse(value.requestClosed),
      continuityReport: value.continuityReport as ContinuityReport | undefined }
    expect(metadata.callId).toBe('recovery-check')
    return { artifact: rows[0], metadata }
  }
  const accounting = async () => ({
    attempts: await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } }),
    ledger: await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
    account: await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } }),
  })
  return { chapter, compilation, configuration, before, after, criticRaw, repairRaw, runtime, network, step, parent, physical, accounting,
    token: () => lease, duringHttp: (hook: typeof duringHttp) => { duringHttp = hook },
    resume: async () => {
      await pauseDurableTask(f.userId, lease.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
      lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'native-continuity-recovery')
    } }
}

describe.runIf(available)('native continuity resumes its own interrupted report and repair children', () => {
  it.each(['registered-before-critic', 'repair-marked-before-child', 'repair-settled-before-raw'] as const)(
    'recovers %s through the same parent and call without duplicate provider settlement or CAS', stage => fixture(async f => {
      const h = await nativeContinuityRecoveryFixture(f), failure = new Error('Injected native interruption: ' + stage)
      let interrupted = false
      const artifact = prisma.agentArtifact
      const create = artifact.create.bind(artifact), update = artifact.update.bind(artifact)
      // Prisma exposes virtual descriptors. A spy restore replaces these with undefined; restore captured real methods explicitly.
      artifact.create = (args => {
        const work = async () => {
          const saved = await create(args)
          if (!interrupted && stage === 'registered-before-critic' && args.data.artifactType === 'continuityReview'
            && nativeRecord(args.data.metadata).requestClosed === false) { interrupted = true; throw failure }
          return saved
        }
        // Only awaited queries use this fault wrapper; it performs the actual
        // Prisma write before throwing, never fabricating a successful result.
        return work() as ReturnType<typeof create>
      }) as typeof artifact.create
      artifact.update = (args => {
        const work = async () => {
          const report = nativeRecord(nativeRecord(args.data.metadata).continuityReport)
          if (!interrupted && stage === 'repair-settled-before-raw' && report.repairResponseIndex === 1) {
            interrupted = true; throw failure // Child has already settled; the new raw is not yet persisted here.
          }
          const saved = await update(args)
          if (!interrupted && stage === 'repair-marked-before-child' && report.repairAttempted === true && report.repairResponseIndex === undefined) {
            interrupted = true; throw failure
          }
          return saved
        }
        return work() as ReturnType<typeof update>
      }) as typeof artifact.update
      try { await expect(h.step()).rejects.toThrow(failure.message) }
      finally { artifact.create = create; artifact.update = update }
      expect(interrupted).toBe(true)
      const parent = await h.parent(), frozen = await h.physical(), paid = await h.accounting()
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(h.chapter)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: h.compilation.id } })).validation).toBeNull()
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: parent.id } })).toBe(0)
      expect((await loadExecutionState(f.userId, h.token().runId)).frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: parent.id })
      const charged = stage === 'registered-before-critic' ? 0 : stage === 'repair-marked-before-child' ? 1 : 2
      expect(h.network).toHaveBeenCalledTimes(charged)
      expect(paid.attempts).toHaveLength(charged)
      expect(paid.ledger).toHaveLength(charged)
      expect(paid.attempts.every(attempt => attempt.status === 'succeeded' && attempt.usageReceipt?.settlementStatus === 'settled')).toBe(true)
      const snapshot = await buildContinuitySnapshot({ ...f, runId: h.token().runId }, { compilationId: h.compilation.id })
      expect(await readContinuityRequestBilling(prisma, f, snapshot)).toMatchObject({ known: true, hasRequest: charged > 0 })
      if (stage === 'registered-before-critic') {
        expect(frozen.metadata).toMatchObject({ requestClosed: false })
        expect(frozen.metadata.continuityReport).toBeUndefined()
      } else expect(frozen.metadata.continuityReport).toMatchObject({ complete: true, billingKnown: true, repairAttempted: true,
        rawResponses: [h.criticRaw] })
      const repairChild = await prisma.agentOperation.findFirst({ where: { parentOperationId: parent.id, action: 'continuity_repair' } })
      expect(repairChild !== null).toBe(stage === 'repair-settled-before-raw')
      await h.resume()
      if (stage === 'repair-settled-before-raw') h.runtime.mockRejectedValue(new Error('A settled original child must replay without resolving a new model'))
      expect(await h.step()).toMatchObject({ kind: 'tool', result: { reviewCompleted: false, reviewOutcome: 'stale',
        display: { kind: 'chapterDiff', chapterId: f.chapterId, before: h.before, after: h.after, revision: 2 } } })
      expect(h.network).toHaveBeenCalledTimes(2)
      expect(await h.parent()).toMatchObject({ id: parent.id, inputHash: parent.inputHash, inputSnapshot: parent.inputSnapshot })
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'continuity_validate' } })).toBe(1)
      expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.id } })).toBe(2)
      if (repairChild) expect(await prisma.agentOperation.findFirstOrThrow({ where: { parentOperationId: parent.id, action: 'continuity_repair' } }))
        .toMatchObject({ id: repairChild.id, inputHash: repairChild.inputHash, inputSnapshot: repairChild.inputSnapshot })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 2, content: h.after })
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: parent.id } })).toBe(1)
      expect((await h.physical()).metadata.continuityReport).toMatchObject({ complete: true, billingKnown: true, repairAttempted: true,
        repairResponseIndex: 1, rawResponses: [h.criticRaw, h.repairRaw], repairResult: { display: { chapterId: f.chapterId, revision: 2 } } })
      const final = await h.accounting()
      expect(final.attempts).toHaveLength(2); expect(final.ledger).toHaveLength(2)
      expect(final.attempts.filter(row => paid.attempts.some(original => original.id === row.id))).toEqual(paid.attempts)
      expect(final.ledger.filter(row => paid.ledger.some(original => original.id === row.id))).toEqual(paid.ledger)
      expect(final.account.dailyUsedMilli).toBe(-final.ledger.reduce((sum, row) => sum + row.dailyDeltaMilli, 0))
      expect(await readTaskBudget(h.token())).toMatchObject({ usedTokens: 40n, attempts: 2n, unresolvedAttempts: 0n })
      expect((await loadExecutionState(f.userId, h.token().runId)).configuration).toEqual(h.configuration)
      expect(await h.step()).toMatchObject({ kind: 'idle' })
      expect(h.network).toHaveBeenCalledTimes(2)
      expect(await h.accounting()).toEqual(final)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 2, content: h.after })
    }, undefined, '修改本章'), 30000)
})

describe.runIf(available)('native continuity observes current session manuscript permission during HTTP', () => {
  it.each((['critic', 'repair'] as const).flatMap(stage => (['read_only', 'contentWrite-deny'] as const).map(policy => [stage, policy] as const)))(
    '%s HTTP followed by %s retains paid reports while blocking automatic manuscript effects', (stage, policy) => fixture(async f => {
      const h = await nativeContinuityRecoveryFixture(f)
      let changed = false
      h.duringHttp(async repair => {
        if (changed || repair !== (stage === 'repair')) return
        const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: f.sessionId } })
        await prisma.agentSession.update({ where: { id: f.sessionId }, data: policy === 'read_only' ? { sandboxMode: 'read_only' }
          : { toolPolicy: { ...nativeRecord(session.toolPolicy), contentWrite: 'deny' } } })
        changed = true
      })
      expect(await h.step()).toMatchObject({ kind: 'tool', result: stage === 'critic' ? { reviewCompleted: true }
        : { outcome: 'failed', failureCode: 'REPAIR_NOT_AUTHORIZED' } })
      expect(changed).toBe(true)
      const count = stage === 'critic' ? 1 : 2, parent = await h.parent(), physical = await h.physical(), paid = await h.accounting()
      expect(h.network).toHaveBeenCalledTimes(count)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(h.chapter)
      expect(physical.metadata.continuityReport).toMatchObject({ complete: true, billingKnown: true, rawResponses: stage === 'critic' ? [h.criticRaw] : [h.criticRaw, h.repairRaw],
        opinions: [{ explanation: '同一句中门同时处于打开与锁闭状态。', severity: 'error' }] })
      if (stage === 'critic') {
        expect(physical.metadata.continuityReport?.repairAttempted).toBeUndefined()
        expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.id, action: 'continuity_repair' } })).toBe(0)
      } else expect(physical.metadata.continuityReport).toMatchObject({ repairAttempted: true, repairResponseIndex: 1,
        repairResult: { outcome: 'failed', failureCode: 'REPAIR_NOT_AUTHORIZED' } })
      expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.id } })).toBe(count)
      expect(paid.attempts).toHaveLength(count); expect(paid.ledger).toHaveLength(count)
      expect(paid.attempts.every(attempt => attempt.status === 'succeeded' && attempt.usageReceipt?.source === 'reported'
        && attempt.usageReceipt.settlementStatus === 'settled' && attempt.usageReceipt.promptTokens === 12 && attempt.usageReceipt.completionTokens === 8)).toBe(true)
      expect(await readTaskBudget(h.token())).toMatchObject({ usedTokens: BigInt(20 * count), attempts: BigInt(count), unresolvedAttempts: 0n })
      expect(paid.account.dailyUsedMilli).toBe(-paid.ledger.reduce((sum, row) => sum + row.dailyDeltaMilli, 0))
      const stored = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: h.compilation.id }, include: { bridge: true } })
      expect(stored.validation).toMatchObject({ checkedRevision: h.chapter.revision, errorCount: 1,
        continuityReport: { complete: true, billingKnown: true, rawResponses: stage === 'critic' ? [h.criticRaw] : [h.criticRaw, h.repairRaw] } })
      expect(stored.bridge!.committedAt).toBeNull()
      expect(await prisma.memoryExtractionJob.count({ where: { chapterId: f.chapterId } })).toBe(0)
      expect((await loadExecutionState(f.userId, h.token().runId)).configuration).toEqual(h.configuration)
      expect(await h.step()).toMatchObject({ kind: 'idle' })
      expect(await h.accounting()).toEqual(paid)
      expect(h.network).toHaveBeenCalledTimes(count)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(h.chapter)
    }, undefined, '修改本章'), 30000)
})
