import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { auxiliaryRouteForRuntime,callDurableAuxiliary,resolveDurableAuxiliaryRuntime } from '../../api/lib/agent/runtime-auxiliary-call.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { prepareAuxiliaryModelOperation } from '../../api/lib/agent/runtime-auxiliary-model.js'
import { beginDurableChat } from '../../api/lib/agent/runtime-provider.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { initializeExecutionState,loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { commitChapterBridge,prepareStoryCompilation,saveSceneTasks,validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { applyContinuityPatches } from '../../api/lib/agent/tools/durable-continuity.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { chapterBridgeGetTool,continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as aiService from '../../api/lib/ai-service.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import * as credits from '../../api/lib/credits.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture,novelFixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable continuity actual tool chain', () => {
  it.each(['success', 'chapter-only', 'repair', 'warnings', 'fused-repair', 'format', 'truncated', 'format-retry', 'unknown', 'stale-chapter', 'stale-compiler', 'rollback-resume', 'late-resume', 'protected', 'missing', 'long', 'repair-stale', 'stale-source', 'source-text', 'approval-denied', 'history-over-three', 'single-quotes', 'single-quotes-stale', 'single-quotes-source', 'single-quotes-swapped', 'unavailable-write-recheck'] as const)('%s preserves paid results and atomic business effects', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      let lease = await claim(f)
      const before = scenario === 'long' ? '开头锚点' + '长正文'.repeat(6000) + '末尾锚点' : '原文'
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before, wordCount: before.length } })
      let sourceId: string | undefined
      if (scenario === 'stale-source' || scenario === 'source-text' || scenario === 'single-quotes-source' || scenario === 'single-quotes-swapped') {
        const current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2 } })
        sourceId = (await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: current.volumeId, title: '前章', content: '前文', wordCount: 2, orderIndex: 1, orderInVolume: 1 } })).id
      }
      const compilation = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查本章' })
      const compilationId = compilation.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      if (scenario === 'history-over-three') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { validation: { checkRounds: 9 } } })
      const tools = [chapterBridgeGetTool, continuityValidateTool, ...(scenario === 'unavailable-write-recheck' ? [chapterReadTool, chapterWriteTool] : [])]
      const checkArgs = scenario === 'chapter-only' ? { chapterId: f.chapterId } : { compilationId }
      const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) }, { id: 'check', name: 'continuity_validate', arguments: JSON.stringify(checkArgs) }]
      if (scenario === 'success' || scenario === 'chapter-only') calls.push({ id: 'cached', name: 'continuity_validate', arguments: JSON.stringify(checkArgs) })
      if (scenario === 'unavailable-write-recheck') calls.push(
        { id: 'read-current', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'write-current', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '新文，门已经锁好。' }) },
        { id: 'bridge-current', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
        { id: 'check-current', name: 'continuity_validate', arguments: JSON.stringify(checkArgs) })
      if (scenario === 'missing') calls.shift()
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' && tool.name === 'continuity_validate' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '完整检查本章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'continuity-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const repairing = ['repair', 'warnings', 'fused-repair', 'format-retry', 'rollback-resume', 'repair-stale'].includes(scenario)
      let requests = 0
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body))
        expect(body.max_tokens).toBe(16_384)
        expect(body.tools).toBeUndefined()
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        if (scenario === 'long') { expect(body.messages[1].content).toContain('开头锚点'); expect(body.messages[1].content).toContain('末尾锚点'); expect(body.messages[1].content).toContain(before) }
        if (scenario === 'unknown') throw new Error('fixture unknown critic')
        if (scenario === 'stale-chapter' || scenario === 'repair-stale' && requests === 1) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户新文', revision: { increment: 1 } } })
        if (sourceId) {
          expect(body.messages[1].content).toContain('前章已保存原文（事实证据）：\n前文')
          expect(body.messages[1].content).toContain('章节桥（待核对摘要，不能代替前章原文）')
          if (scenario === 'stale-source') await prisma.chapter.update({ where: { id: sourceId }, data: { content: '新的前文', revision: { increment: 1 } } })
        }
        if (scenario === 'stale-compiler') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { preparedContext: { changed: true } } })
        if (scenario === 'late-resume') await pauseDurableTask(f.userId, lease.runId)
        const content = scenario === 'fused-repair' ? '{"findings":[{"signal":"body","severity":"error","evidence":"原文存在冲突","suggestion":"局部修订","sourceEvidence":[{"source":"current","quote":"原文"}]}],"patches":[{"oldText":"原文","newText":"新文"}]}'
          : scenario === 'unavailable-write-recheck' ? requests === 1 ? 'broken JSON' : '{"findings":[]}'
          : scenario === 'single-quotes-source' || scenario === 'single-quotes-swapped' ? JSON.stringify({ findings: [{ signal: 'object', severity: 'error',
            evidence: scenario === 'single-quotes-source' ? "前章原文：'前文' / 当前正文：'原文'" : "前章原文：'原文' / 当前正文：'前文'", suggestion: '核对真实前后章事实，不自动改写正文' }] })
          : scenario === 'single-quotes' || scenario === 'single-quotes-stale' ? JSON.stringify({ findings: [{ signal: 'object', severity: 'warning',
            evidence: `当前正文：'${scenario === 'single-quotes' ? '原文' : '不在正文的旧引文'}'`, suggestion: '保留真实风险交作者审阅' }] })
          : scenario === 'format' || scenario === 'format-retry' && requests === 2 ? 'broken JSON'
          : requests === 1 ? JSON.stringify({ findings: scenario === 'warnings' ? ['body', 'object', 'knowledge'].map(signal => ({ signal, severity: 'warning', evidence: '原文存在承接风险', suggestion: '局部澄清', sourceEvidence: [{ source: 'current', quote: '原文' }] }))
            : repairing || scenario === 'protected' ? [{ signal: 'body', severity: 'error', evidence: '原文有身体状态冲突', suggestion: '改成新文', sourceEvidence: [{ source: 'current', quote: '原文' }] }] : [] })
          : '{"patches":[{"oldText":"原文","newText":"新文"}]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
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
      if (scenario === 'rollback-resume') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, digest, work) => original(token, id, digest, async tx => { await work(tx); throw new Error('fixture continuity rollback') }))
        await expect(step()).rejects.toThrow('fixture continuity rollback')
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(before)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'continuity_validate' } } })).toBe(0)
        await pauseDurableTask(f.userId, lease.runId)
      }
      if (scenario === 'late-resume') await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      if (scenario === 'late-resume' || scenario === 'rollback-resume') {
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
        const subject = { userId: f.userId, novelId: f.novelId, runId: lease.runId }
        expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, subject, compilationId))).toMatchObject({ continuity: 'incomplete' })
        await step() // real chapter_read creates the current revision observation
        expect(await step()).toMatchObject({ kind: 'tool', result: { summary: expect.stringContaining('更新') } })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 2, content: '新文，门已经锁好。' })
        expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, subject, compilationId))).toMatchObject({ continuity: 'stale', continuityExhausted: false })
        await step() // refresh only the compiler observation, not report evidence
        expect(await step()).toMatchObject({ kind: 'tool', result: { summary: expect.stringContaining('连续性检查') } })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 2,
          independentCheck: 'complete', checkRounds: 2, autoRepairRounds: 0 })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(2)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId }, status: 'unknown' } })).toBe(0)
        return
      }
      const result = await step()
      const failed = ['format', 'truncated', 'stale-chapter', 'stale-compiler', 'missing', 'repair-stale', 'stale-source', 'single-quotes-stale', 'single-quotes-swapped'].includes(scenario)
      expect(result).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { summary: expect.stringContaining('连续性检查') } })
      if (scenario === 'success' || scenario === 'chapter-only') {
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkRounds: 1 })
        expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('复用') } })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkRounds: 1 })
      }
      const expectedRequests = scenario === 'missing' ? 0 : 1
      expect(fetchMock).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(expectedRequests)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.content).toBe(scenario === 'stale-chapter' || scenario === 'repair-stale' ? '用户新文' : before)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      if (scenario === 'history-over-three') expect(saved.validation).toMatchObject({ checkRounds: 10 })
      if (scenario === 'single-quotes') expect(saved.validation).toMatchObject({ independentCheck: 'complete', warningCount: 1, unlocatedEvidenceCount: 0 })
      if (scenario === 'single-quotes-stale') expect(saved.validation).toMatchObject({ independentCheck: 'unavailable', unlocatedEvidenceCount: 1 })
      if (scenario === 'single-quotes-source') expect(saved.validation).toMatchObject({ independentCheck: 'complete', errorCount: 1, unlocatedEvidenceCount: 0 })
      if (scenario === 'single-quotes-swapped') expect(saved.validation).toMatchObject({ independentCheck: 'unavailable', errorCount: 1, unlocatedEvidenceCount: 1 })
      if (scenario === 'history-over-three' || scenario === 'single-quotes') {
        const parent = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate' } })
        expect(parent.inputSnapshot).toMatchObject({ input: { work: { version: 3, coverage: { protocolVersion: 6 } } } })
      }
      if (['missing', 'stale-chapter', 'stale-compiler', 'repair-stale', 'stale-source'].includes(scenario)) expect(saved.validation).toBeNull()
      else expect(saved.validation).toMatchObject({ checkedRevision: 1, independentCheck: failed ? 'unavailable' : 'complete', coverage: { charCount: before.length, contentHash: runtimeJson({ content: before }).hash } })
      if (repairing && scenario !== 'repair-stale') {
        expect(chapter.revision).toBe(1)
        expect(saved.stage).toBe('check')
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBeNull()
      }
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'continuity_validate')).toMatchObject(scenario === 'success' || scenario === 'chapter-only' ? [{ ok: true }, { ok: true }] : [{ ok: !failed }])
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
  const retryStep = family === 'quality-evidence' ? 'quality_evidence_correction' : family !== 'continuity' ? 'quality_repair_retry' : 'continuity_repair_retry'
  it.each(['replay', 'read-only', 'stop-resume', 'unknown', 'changed-input', 'wrong-attempt', 'wrong-step', 'skip-critic', 'damaged-prerequisite', 'ordered-repair', 'tools-leak', 'history-leak', 'late-result', 'concurrent', 'missing-result-event', 'cross-family', 'prepared-policy-conflict', 'old-paid-replay', 'old-paid-unknown'] as const)('%s binds paid work to the original pending tool', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: '', parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '检查本章' }, { role: 'assistant', content: null, toolCalls: [{ id: 'critic-call', name: tool.name, arguments: '{}' }] }], successfulToolSignatures: [] } })
      const parent = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
        key: 'exec:0', action: tool.name, callId: 'critic-call', targetId: f.chapterId, effectDomain: 'chapter',
        operationInput: { callId: 'critic-call', args: {} }, effectiveArgs: {}, normalize: parsed => tool.parameters.parse(parsed),
      })
      const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'aux-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
      const request = (step: import('../../api/lib/agent/runtime-auxiliary-model.js').AuxiliaryModelStep = criticStep) => ({
        messages: [{ role: 'user' as const, content: '独立检查原文' }] as import('../../api/lib/ai-service.js').ChatMessage[], tools: [] as import('../../api/lib/ai-service.js').OpenAIToolDefinition[], model: 'fixture', provider: 'fixture',
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
      if (scenario === 'prepared-policy-conflict' || scenario === 'old-paid-replay' || scenario === 'old-paid-unknown') {
        const original = request()
        const savedRequest = { endpoint: 'https://provider.invalid/v1/chat/completions', body: {
          model: 'fixture', messages: original.messages, thinking: { type: 'enabled' }, reasoning_effort: 'high', stream: true,
        } }
        const operationInput = { key: original.durableExecution.operationKey, action: criticStep, request: savedRequest, price,
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
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(scenario === 'old-paid-replay' ? 1 : 0)
        return
      }
      if (scenario === 'read-only') {
        await prisma.agentSession.update({ where: { id: f.sessionId }, data: { sandboxMode: 'read_only' } })
        expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { parentOperationId: parent.operation.id }, dispatchedAt: { not: null } } })).toBe(1)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
        return
      }
      if (scenario === 'wrong-attempt' || scenario === 'wrong-step' || scenario === 'skip-critic' || scenario === 'tools-leak' || scenario === 'history-leak' || scenario === 'cross-family') {
        const invalid = request(scenario === 'cross-family' ? (family !== 'continuity' ? 'continuity_critic' : 'quality_critic') : scenario === 'skip-critic' ? repairStep : criticStep)
        if (scenario === 'wrong-attempt') invalid.durableExecution.attemptKey = '2'
        if (scenario === 'wrong-step') invalid.durableExecution.operationKey += '-other'
        if (scenario === 'tools-leak') invalid.tools = [{ type: 'function', function: { name: 'chapter_write', description: '', parameters: {} } }]
        if (scenario === 'history-leak') invalid.messages.push({ role: 'assistant', content: '从旧章节继续' })
        await expect(chatWithTools(invalid)).rejects.toMatchObject({ code: scenario === 'skip-critic' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.operation.id } })).toBe(0)
        return
      }
      if (scenario === 'unknown') {
        await expect(chatWithTools(request())).rejects.toThrow('fixture lost response')
        await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        await expect(chatWithTools(request(repairStep))).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
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
        await expect(chatWithTools(request(repairStep))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      } else {
        expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}', billing: { chargedMilli: 1 } })
        if (scenario === 'ordered-repair') {
          await chatWithTools(request(repairStep))
          await chatWithTools(request(retryStep))
          await chatWithTools(request(retryStep))
        }
      }
      const count = scenario === 'ordered-repair' ? (family === 'quality-evidence' ? 2 : 3) : 1
      expect(fetchMock).toHaveBeenCalledTimes(count)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(count)
      expect(await readTaskBudget(lease)).toMatchObject({ usedTokens: BigInt(10 * count), attempts: BigInt(count), unresolvedAttempts: 0n })
      expect((await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId: f.userId } })).metadata).toMatchObject({ pricingVersion: 'credits-v2-itemized', rateCardId: 'aux-fixture' })
      const saved = await loadExecutionState(f.userId, lease.runId)
      expect(saved.frame.revision).toBe(parent.pending.revision)
      expect(saved.frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: parent.operation.id, turn: 0 })
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
        apiKey: 'fixture-key', reasoningEffort: 'low' as const, reasoningEfforts: ['low' as const],
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
      const parent = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
        key: 'exec:0', action: tool.name, callId: 'critic-call', targetId: f.chapterId, effectDomain: 'chapter',
        operationInput: { callId: 'critic-call', args: {} }, effectiveArgs: {}, normalize: parsed => tool.parameters.parse(parsed),
      })
      const resolved = await resolveDurableAuxiliaryRuntime({ userId: f.userId, modelRuntime: runtime, modelSelection: selection })
      const route = auxiliaryRouteForRuntime(resolved.runtime, resolved.selection, 1024)
      const price: DurableTokenPrice = { version: 'credits-v1-exact', modelTier: runtime.tier, multiplierBps: 0 }
      const fetchMock = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`))
      vi.stubGlobal('fetch', fetchMock)
      const runtimeSpy = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
      const result = await callDurableAuxiliary({ lease, parentOperationId: parent.operation.id, step: 'continuity_critic', route, price,
        system: 'fixture system', content: 'fixture content', temperature: 0.15, signal: new AbortController().signal, assertCurrent: async () => {} })
      expect(result).toMatchObject({ content: '{"findings":[]}', billing: { status: 'settled', chargedMilli: 0 } })
      expect(runtimeSpy).toHaveBeenCalledWith(runtime.tier, f.userId, selection.customModelId, 'low')
      expect(fetchMock).toHaveBeenCalledOnce()
      const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
      expect(requestBody).toMatchObject({ thinking: { type: 'disabled' }, max_completion_tokens: 1024 })
      expect(requestBody.reasoning_effort).toBeUndefined()
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
  it('ignores critic patches, reuses current findings, and keeps verified factual errors separate from missing checks', async () => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await novelFixture(async f => {
      const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = prepared.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const completion = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValueOnce('{"findings":[{"signal":"body","severity":"error","evidence":"原文存在冲突","suggestion":"局部修订","sourceEvidence":[{"source":"current","quote":"原文"}]}],"patches":[{"oldText":"原文","newText":"修订正文"}]}')
        .mockResolvedValueOnce('{"findings":[]}')
      const ctx: ToolContext = { ...f, callId: 'critic', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ summary: expect.stringContaining('连续性检查') })
      expect(completion).toHaveBeenCalledOnce()
      expect(completion.mock.calls[0][2]).toMatchObject({ maxOutputTokens: 16_384, reasoningEffort: 'low' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '原文', revision: 1 })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 1, errorCount: 1 })
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ summary: expect.stringContaining('复用') })
      expect(completion).toHaveBeenCalledOnce()
      await expect(commitChapterBridge({ ...f, compilationId, chapterSummary: '摘要', exitState: state, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '收束' })).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
    })
  })
  it.each(['unavailable', 'stale-critic', 'stale-commit', 'source-commit', 'commit-rollback', 'commit', 'tool-unavailable', 'tool-stale', 'repair-race'] as const)('%s never certifies another revision or partially commits memory', async scenario => {
    await novelFixture(async f => {
      const first = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const targetId = scenario === 'source-commit' ? (await prisma.chapter.create({ data: { novelId: f.novelId, authorId: f.userId, volumeId: first.volumeId,
        orderIndex: 2, orderInVolume: 2, title: '待提交的新章', content: '原文', wordCount: 2 } })).id : f.chapterId
      const prepared = await prepareStoryCompilation({ ...f, chapterId: targetId, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = prepared.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const terminal = { userId: f.userId, novelId: f.novelId, compilationId, chapterSummary: '章节摘要', exitState: state,
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '发现线索' }
      const changeChapter = () => prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户修改', revision: { increment: 1 } } })
      if (scenario.startsWith('tool-') || scenario === 'repair-race') {
        let calls = 0
        vi.spyOn(aiService, 'generateTextCompletion').mockImplementation(async () => {
          calls++
          if (scenario === 'tool-unavailable') return 'not JSON'
          if (scenario === 'tool-stale') { await changeChapter(); return '{"findings":[]}' }
          if (calls === 1) return '{"findings":[{"signal":"body","severity":"error","evidence":"原文存在冲突","suggestion":"局部修订","sourceEvidence":[{"source":"current","quote":"原文"}]}]}'
          await changeChapter()
          return '{"patches":[{"oldText":"原文","newText":"模型修改"}]}'
        })
        const ctx: ToolContext = { ...f, callId: 'critic', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
        const check = continuityValidateTool.execute(ctx, { compilationId })
        if (scenario === 'tool-unavailable') expect(await check).toMatchObject({ outcome: 'failed', summary: '独立连续性复核未完成' })
        else if (scenario === 'tool-stale') {
          await expect(check).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
          expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('用户修改')
        } else {
          expect(await check).toMatchObject({ summary: expect.stringContaining('连续性检查') })
          expect(calls).toBe(1)
          expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
          await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })
          return
        }
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: scenario === 'tool-stale' ? 2 : 1 })
        const validation = (await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation
        if (scenario === 'tool-unavailable') expect(validation).toMatchObject({ checkedRevision: 1, independentCheck: 'unavailable' })
        else {
          expect(validation).toMatchObject({ checkRounds: 1 })
          expect(validation).not.toHaveProperty('checkedRevision')
          expect(validation).not.toHaveProperty('coverage')
          expect(validation).not.toHaveProperty('independentCheck', 'complete')
        }
        return
      }
      if (scenario === 'stale-critic') await changeChapter()
      const check = validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: scenario === 'unavailable' ? 'unavailable' : 'complete' })
      if (scenario === 'stale-critic') {
        await expect(check).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      await check
      if (scenario === 'stale-commit') await changeChapter()
      if (scenario === 'source-commit') await changeChapter()
      if (scenario === 'unavailable' || scenario === 'stale-commit') {
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: scenario === 'stale-commit' ? 2 : 1 })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 1, independentCheck: scenario === 'unavailable' ? 'unavailable' : 'complete' })
        return
      } else if (scenario === 'source-commit') {
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
      } else if (scenario === 'commit-rollback') {
        await expect(prisma.$transaction(async tx => { await commitChapterBridge(terminal, tx); throw new Error('fixture-commit-rollback') })).rejects.toThrow('fixture-commit-rollback')
      } else {
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(2)
        expect(await prisma.memoryEvidence.count({ where: { memory: { novelId: f.novelId } } })).toBe(2)
        return
      }
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('active')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toBeNull()
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.sceneTask.count({ where: { compilationId, status: 'completed' } })).toBe(0)
    })
  })
})
