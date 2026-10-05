import { Prisma } from '@prisma/client'
import { createHash,randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { applyQualityRepair,buildHumanityQualityContext,getQualityReport,persistHumanityQualityReport,qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import * as toolCursor from '../../api/lib/agent/runtime-tool-cursor.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { commitChapterBridge,prepareStoryCompilation,recordStoryCompilerWrite,saveSceneTasks,validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterBridgeCommitTool,chapterBridgeGetTool,continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as writingExperiments from '../../api/lib/agent/writing-experiments.js'
import * as aiService from '../../api/lib/ai-service.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import * as credits from '../../api/lib/credits.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { DataAccessError,prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('quality report integrity and atomic repair', () => {
  it.each(['complete', 'unavailable', 'unlocated', 'ambiguous', 'report-rollback', 'stale-source', 'repair', 'repair-rollback', 'no-op', 'empty', 'concurrent', 'wrong-compilation', 'tool-fallback', 'foreign-run', 'legacy-report', 'hash-mismatch', 'outer-transaction', 'outer-rollback', 'evidence-corrected', 'evidence-partial', 'evidence-unresolved', 'evidence-ambiguous', 'evidence-credit-failure', 'quality-provider-failure', 'quality-timeout-fallback', 'continuity-provider-failure'] as const)('%s cannot promote unverified reports or partially repair', async scenario => {
    await fixture(async f => {
      const compilation = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '质量检查' })
      const compilationId = compilation.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进', entryState: state, goal: '找线索', obstacle: '锁门', choice: '绕路', cost: '时间', turn: '脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
      await validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: 'complete' })
      const ctx: ToolContext = { ...f, callId: 'quality', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
      if (scenario === 'quality-provider-failure' || scenario === 'continuity-provider-failure') {
        const error = new DataAccessError(402, 'CREDITS_EXHAUSTED', 'fixture credit gate')
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockRejectedValue(error)
        // An explicit focus requests an independent check instead of reusing the fixture's valid baseline.
        const action = scenario === 'quality-provider-failure'
          ? qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })
          : continuityValidateTool.execute(ctx, { compilationId, focus: '额外检查' })
        await expect(action).rejects.toBe(error)
        expect(model).toHaveBeenCalledTimes(1)
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
        return
      }
      if (scenario === 'quality-timeout-fallback') {
        // 每次调用硬超时(env.aiTextTimeoutMs)触发时 AbortSignal.timeout 抛 TimeoutError(非 DataAccessError)：
        // critic 不能让整次检查失败，而应降级为确定性兜底并交付报告(count=1)，根治“挂起→分析不出”。
        const timeout = new DOMException('The operation timed out.', 'TimeoutError')
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockRejectedValue(timeout)
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })).toMatchObject({ outcome: 'failed' })
        expect(model).toHaveBeenCalledTimes(1)
        expect((await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId } })).status).toBe('failed')
        return
      }
      if (scenario.startsWith('evidence-')) {
        if (scenario === 'evidence-ambiguous') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文原文' } })
        const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const finding = { signal: 'emotion_grounding', severity: 'warning', quote: '原...文', explanation: '缺少动作', suggestion: '局部调整', confidence: 0.9 }
        // 一条可绑定、一条不可绑定：部分证据缺失不再让整个报告 failed，未定位计数进入指标，章节桥仍可提交。
        const partial = { signal: 'reader_pull', severity: 'warning', quote: '这段引用不在正文里', explanation: '缺少拉力', suggestion: '补充动作', confidence: 0.8 }
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValueOnce(JSON.stringify({ findings: scenario === 'evidence-partial' ? [finding, partial] : [finding] }))
        if (scenario === 'evidence-credit-failure') model.mockRejectedValueOnce(new DataAccessError(402, 'CREDITS_EXHAUSTED', 'fixture credit gate'))
        else model.mockResolvedValueOnce(JSON.stringify({ corrections: scenario === 'evidence-unresolved' ? [] : [{ index: 0, quote: '原文' }] }))
        const action = qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })
        if (scenario === 'evidence-credit-failure') await expect(action).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
        else if (scenario === 'evidence-corrected' || scenario === 'evidence-partial') expect(await action).not.toHaveProperty('outcome')
        else expect(await action).toMatchObject({ outcome: 'failed', summary: '质量证据定位未完成' })
        expect(model).toHaveBeenCalledTimes(2)
        expect(model.mock.calls[1][2].action).toBe('agent3HumanityEvidenceCorrection')
        const saved = await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId }, include: { findings: true } })
        expect(saved.status).toBe(scenario === 'evidence-corrected' || scenario === 'evidence-partial' ? 'needs_repair' : 'failed')
        if (scenario === 'evidence-corrected') expect(saved.findings[0]).toMatchObject({ evidenceExcerpt: '原文', explanation: finding.explanation, suggestion: finding.suggestion })
        if (scenario === 'evidence-partial') {
          expect(saved.deterministicMetrics).toMatchObject({ independentCheck: 'complete', unlocatedFindings: 1, criticFindingCount: 2, droppedFindings: 0 })
          expect(saved.findings.filter(item => item.source === 'critic')).toEqual([expect.objectContaining({ evidenceExcerpt: '原文', explanation: finding.explanation })])
          expect(await commitChapterBridge({ userId: f.userId, novelId: f.novelId, compilationId, chapterSummary: '摘要', exitState: state, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '脚印', requireQuality: true, qualityReportId: saved.id })).toMatchObject({ compilationId, chapterRevision: 1 })
        }
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: before.content, revision: before.revision })
        return
      }
      if (scenario === 'tool-fallback') {
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValueOnce('{}').mockResolvedValueOnce('{"findings":[]}')
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })).toMatchObject({ outcome: 'failed' })
        expect((await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId } })).status).toBe('failed')
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })).not.toHaveProperty('outcome')
        expect(model).toHaveBeenCalledTimes(2)
        return
      }
      const repairs = ['repair', 'repair-rollback', 'no-op', 'empty', 'concurrent', 'outer-transaction', 'outer-rollback'].includes(scenario)
      if (scenario === 'ambiguous') {
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文原文' } })
        await validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: 'complete' })
      }
      const input = { ...f, compilationId, chapterId: f.chapterId, chapterRevision: 1, mode: 'balanced' as const, deterministicMetrics: {}, deterministicFindings: [],
        criticComplete: scenario !== 'unavailable', criticFindings: repairs || scenario === 'unlocated' || scenario === 'ambiguous'
          ? [{ signal: 'emotion_grounding' as const, severity: 'warning' as const, quote: scenario === 'unlocated' ? '不在正文里' : '原文', explanation: '缺少具体动作', suggestion: '局部调整', confidence: 0.9 }] : [] }
      if (scenario === 'report-rollback') {
        await expect(prisma.$transaction(async tx => { await persistHumanityQualityReport(input, tx); throw new Error('fixture report rollback') })).rejects.toThrow('fixture report rollback')
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
        return
      }
      if (scenario === 'stale-source') {
        await expect(prisma.$transaction(async tx => {
          await tx.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '新正文' } })
          await persistHumanityQualityReport(input, tx)
        })).rejects.toMatchObject({ code: 'QUALITY_SOURCE_STALE' })
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
        return
      }
      if (scenario === 'wrong-compilation') {
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValue('{"findings":[]}')
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId: randomUUID() })).toMatchObject({ outcome: 'failed' })
        expect(model).not.toHaveBeenCalled()
        expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: randomUUID() })).toMatchObject({ outcome: 'failed' })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('active')
        return
      }
      if (scenario === 'foreign-run') {
        const other = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop' } })
        expect((await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, other.id)).compilation).toBeNull()
        await expect(persistHumanityQualityReport({ ...input, runId: other.id })).rejects.toMatchObject({ code: 'QUALITY_COMPILATION_SCOPE_INVALID' })
        expect(await chapterBridgeCommitTool.execute({ ...ctx, runId: other.id }, { compilationId })).toMatchObject({ outcome: 'failed' })
        return
      }
      if (scenario === 'outer-transaction' || scenario === 'outer-rollback') {
        const write = prisma.$transaction(async tx => {
          const report = await persistHumanityQualityReport(input, tx)
          await applyQualityRepair({ ...f, reportId: report.id, replacements: [{ findingId: report.findings[0].id, replacement: '安全改写'.repeat(30) }] }, tx)
          if (scenario === 'outer-rollback') throw new Error('outer effect receipt failed')
        })
        if (scenario === 'outer-rollback') await expect(write).rejects.toThrow('outer effect receipt failed')
        else await write
        const expected = scenario === 'outer-rollback' ? 0 : 1
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(expected)
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'rewriteSelection' } })).toBe(expected)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(1 + expected)
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(1 + expected)
        if (!expected) expect(await prisma.leakageCheck.count({ where: { runId: f.runId } })).toBe(0)
        return
      }
      const report = await persistHumanityQualityReport(input)
      const terminal = { userId: f.userId, novelId: f.novelId, compilationId, chapterSummary: '摘要', exitState: state, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '脚印', requireQuality: true, qualityReportId: report.id }
      if (scenario === 'legacy-report' || scenario === 'hash-mismatch') {
        if (scenario === 'legacy-report') await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { deterministicMetrics: {} } })
        else {
          await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '内容变化但旧版本号未更新' } })
          // Isolate the quality hash gate: continuity has checked the changed body, while quality still covers the old body.
          await validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: 'complete' })
          expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({
            coverage: { contentHash: runtimeJson({ content: '内容变化但旧版本号未更新' }).hash }, independentCheck: 'complete' })
        }
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('completed')
        expect((await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id } })).deterministicMetrics).toEqual(
          scenario === 'legacy-report' ? {} : report.deterministicMetrics)
        return
      }
      if (['unavailable', 'unlocated', 'ambiguous'].includes(scenario)) {
        expect(report.status).toBe('failed')
        if (scenario === 'ambiguous') expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({
          coverage: { contentHash: runtimeJson({ content: '原文原文' }).hash }, independentCheck: 'complete' })
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
        expect((await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id } })).status).toBe('failed')
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('completed')
        return
      }
      if (scenario === 'complete') {
        expect(report.status).toBe('passed')
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
        return
      }
      const replacement = { findingId: report.findings[0].id, replacement: scenario === 'no-op' ? '原文' : '新文' }
      const repairInput = { userId: f.userId, novelId: f.novelId, runId: f.runId, reportId: report.id, replacements: scenario === 'empty' ? [] : [replacement] }
      if (['repair-rollback', 'no-op', 'empty'].includes(scenario)) {
        if (scenario === 'repair-rollback') {
          vi.spyOn(writingExperiments, 'recordWritingSignal').mockRejectedValueOnce(new Error('fixture quality rollback after effects'))
          await expect(applyQualityRepair(repairInput)).rejects.toThrow('fixture quality rollback after effects')
          expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'rewriteSelection' } })).toBe(0)
        } else await expect(applyQualityRepair(repairInput)).rejects.toMatchObject({ code: 'QUALITY_REPAIR_NO_CHANGE' })
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
        expect(await getQualityReport(f.userId, f.novelId, report.id)).toMatchObject({ repairRound: 0, chapterRevision: 1, findings: [{ disposition: 'pending' }] })
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(1)
        return
      }
      if (scenario === 'concurrent') {
        const results = await Promise.allSettled([applyQualityRepair(repairInput), applyQualityRepair(repairInput)])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      } else await applyQualityRepair(repairInput)
      expect(await getQualityReport(f.userId, f.novelId, report.id)).toMatchObject({ repairRound: 1, chapterRevision: 2, status: 'repaired' })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 1 })
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(2)
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'rewriteSelection' } })).toBe(1)
      expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 2 })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 1 })
      expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 2 })
    })
  })
})

describe.runIf(available)('durable quality actual tool chain', () => {
  it.each(['success', 'repair', 'evidence-corrected', 'evidence-unresolved', 'format', 'truncated', 'format-retry', 'unknown', 'stale-chapter', 'stale-compiler', 'rollback-resume', 'late-resume', 'protected', 'missing', 'long', 'repair-stale', 'stale-source', 'approval-denied', 'standalone', 'context-change', 'full-chain', 'original-request', 'original-request-resume', 'legacy-quality-resume', 'legacy-quality-stale'] as const)('%s preserves paid results and atomic business effects', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const authorRequest = '改写当前章为都市异能爽文第一章。主角陆望，31岁，夜班设备维护员。1800字，低谷仅一段；觉醒后识别旧镜头的价值；停在买主报价前；只输出标题与正文。'
    const checkingOriginal = scenario === 'original-request' || scenario === 'original-request-resume'
    const legacyWork = scenario === 'legacy-quality-resume' || scenario === 'legacy-quality-stale'
    await fixture(async f => {
      let lease = await claim(f)
      const before = scenario === 'long' ? '开头锚点' + '长正文'.repeat(6000) + '末尾锚点' : '原文'
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before, wordCount: before.length } })
      let sourceId: string | undefined
      if (scenario === 'stale-source') {
        const current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2 } })
        sourceId = (await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: current.volumeId, title: '前章', content: '前文', wordCount: 2, orderIndex: 1, orderInVolume: 1 } })).id
      }
      const compilation = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查本章' })
      const compilationId = compilation.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const tools = [chapterBridgeGetTool, chapterReadTool, qualityAnalyzeTool, continuityValidateTool, chapterBridgeCommitTool]
      const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) }, { id: 'check', name: 'quality_analyze', arguments: JSON.stringify({ compilationId }) }]
      if (scenario === 'success' || scenario === 'repair' || scenario === 'context-change') calls.push({ id: 'cached', name: 'quality_analyze', arguments: JSON.stringify({ compilationId }) })
      if (scenario === 'standalone') {
        await prisma.storyCompilation.delete({ where: { id: compilationId } })
        calls[0] = { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) }
        calls[1].arguments = JSON.stringify({ chapterId: f.chapterId })
      }
      if (scenario === 'full-chain') {
        calls.splice(1, 0, { id: 'continuity-first', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) }, { id: 'continuity-recheck', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) })
        calls.push({ id: 'continuity', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) }, { id: 'commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId }) })
      }
      if (scenario === 'missing') calls.shift()
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' && tool.name === 'quality_analyze' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '完整检查本章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'quality-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const repairing = ['repair', 'evidence-corrected', 'format-retry', 'rollback-resume', 'repair-stale'].includes(scenario)
      let requests = 0
      let admittedLegacy: { id: string; inputHash: string; inputSnapshot: Prisma.JsonValue } | undefined
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body))
        expect(body.max_tokens).toBe(16_384)
        expect(body.tools).toBeUndefined()
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        if (checkingOriginal) {
          expect(body.messages[1].content).toContain(JSON.stringify(authorRequest))
          expect(body.messages[1].content).toContain('首章收益与情绪强度')
          expect(body.messages[0].content).toContain('不能授权改文')
        }
        if (legacyWork) expect(body.messages[1].content).toBe('合成升级前冻结的完整正文与点评输入')
        if (scenario === 'legacy-quality-stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户新文', revision: { increment: 1 } } })
        if (scenario === 'long') { expect(body.messages[1].content).toContain('开头锚点'); expect(body.messages[1].content).toContain('末尾锚点'); expect(body.messages[1].content).toContain(before) }
        if (scenario === 'unknown') throw new Error('fixture unknown critic')
        if (scenario === 'stale-chapter' || scenario === 'repair-stale' && requests === 1) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户新文', revision: { increment: 1 } } })
        if (sourceId) await prisma.chapter.update({ where: { id: sourceId }, data: { content: '新的前文', revision: { increment: 1 } } })
        if (scenario === 'stale-compiler') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { preparedContext: { changed: true } } })
        if (scenario === 'late-resume') await pauseDurableTask(f.userId, lease.runId)
        const content = scenario === 'evidence-corrected' || scenario === 'evidence-unresolved'
          ? requests === 1
            ? JSON.stringify({ findings: [{ signal: 'emotion_grounding', severity: 'advisory', quote: '错误引用', explanation: '需要更具体动作', suggestion: '保留待审', confidence: 0.9 }] })
            : requests === 2 ? JSON.stringify({ corrections: [{ index: 0, quote: scenario === 'evidence-corrected' ? '原文' : '仍不存在' }] })
              : '{"patches":[{"key":"emotion_grounding:0:2","replacement":"新文"}]}'
          : scenario === 'full-chain' ? [
            '{"findings":[{"signal":"body","severity":"warning","evidence":"原文承接不足","suggestion":"局部澄清"}],"patches":[{"oldText":"原文","newText":"新文"}]}',
            '{"findings":[{"signal":"emotion_grounding","severity":"advisory","quote":"原文","explanation":"需要具体动作","suggestion":"局部落实","confidence":0.9}],"patches":[{"key":"emotion_grounding:0:2","replacement":"禁止改写"}]}',
          ][requests - 1] : scenario === 'context-change' ? '{"findings":[]}' : scenario === 'format' || scenario === 'format-retry' && requests === 2 ? 'broken JSON'
          : requests === 1 ? JSON.stringify({ findings: repairing || scenario === 'protected' ? [{ signal: 'emotion_grounding', severity: 'warning', quote: '原文', explanation: '缺少动作', suggestion: '改成新文', confidence: 0.9 }] : [] })
          : '{"patches":[{"key":"emotion_grounding:0:2","replacement":"新文"}]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario !== 'missing') await step()
      if (legacyWork) {
        // Admit a real v1 operation before provider dispatch, rather than edit
        // an already paid operation's immutable inputs or identity.
        const originalPrepare = toolCursor.prepareToolCursorOperation
        vi.spyOn(toolCursor, 'prepareToolCursorOperation').mockImplementationOnce(async (token, cursor, input, tx) => {
          const snapshot = JSON.parse(JSON.stringify(input.operationInput)) as { work: Record<string, unknown> }
          const { originalRequest: _request, ...legacy } = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
          snapshot.work = { ...snapshot.work, version: 1, contextHash: runtimeJson(JSON.parse(JSON.stringify(legacy))).hash,
            criticInput: '合成升级前冻结的完整正文与点评输入', criticSystem: '合成升级前的只读点评规则；只输出 findings JSON。' }
          const prepared = await originalPrepare(token, cursor, { ...input, operationInput: runtimeJson(snapshot).value }, tx)
          admittedLegacy = { id: prepared.operation.id, inputHash: prepared.operation.inputHash, inputSnapshot: prepared.operation.inputSnapshot }
          throw new Error('fixture pre-upgrade admission interrupted')
        })
        await expect(step()).rejects.toThrow('fixture pre-upgrade admission interrupted')
      }
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
      if (scenario === 'rollback-resume' || scenario === 'original-request-resume' || scenario === 'legacy-quality-resume') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, digest, work) => original(token, id, digest, async tx => { await work(tx); throw new Error('fixture quality rollback') }))
        await expect(step()).rejects.toThrow('fixture quality rollback')
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(before)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'quality_analyze' } } })).toBe(0)
        await pauseDurableTask(f.userId, lease.runId)
      }
      if (scenario === 'late-resume') await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      if (scenario === 'late-resume' || scenario === 'rollback-resume' || scenario === 'original-request-resume' || scenario === 'legacy-quality-resume') {
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'quality-resume')
        runtime.mockRejectedValue(new Error('Must replay without resolving current model configuration'))
      }
      if (scenario === 'unknown') {
        await expect(step()).rejects.toThrow('fixture unknown critic')
        await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      if (scenario === 'full-chain') {
        expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('连续性检查') } })
        expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('连续性检查') } })
      }
      const result = await step()
      const failed = ['evidence-unresolved', 'format', 'truncated', 'stale-chapter', 'stale-compiler', 'missing', 'repair-stale', 'stale-source', 'legacy-quality-stale'].includes(scenario)
      expect(result).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { summary: expect.stringContaining('质量检查') } })
      if (scenario === 'context-change') { await prisma.novel.update({ where: { id: f.novelId }, data: { categoryName: '新的题材边界' } }); expect(await step()).toMatchObject({ result: { summary: '人类感质量检查' } }) }
      if (scenario === 'success' || scenario === 'repair') expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('复用') } })
      if (scenario === 'full-chain') {
        expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('连续性检查') } })
        expect(await step()).toMatchObject({ result: { summary: '提交章节桥与当前故事终态' } })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('completed')
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(2)
      }
      const expectedRequests = scenario === 'missing' ? 0 : ['full-chain', 'context-change', 'evidence-corrected', 'evidence-unresolved'].includes(scenario) ? 2 : 1
      expect(fetchMock).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(expectedRequests)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.content).toBe(scenario === 'stale-chapter' || scenario === 'repair-stale' || scenario === 'legacy-quality-stale' ? '用户新文' : before)
      expect(chapter.revision).toBe(['stale-chapter', 'repair-stale', 'legacy-quality-stale'].includes(scenario) ? 2 : 1)
      if (scenario === 'standalone') {
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId, compilationId: null } })).toBe(1)
        return
      }
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId }, include: { findings: true } })
      if (['missing', 'stale-chapter', 'stale-compiler', 'repair-stale', 'stale-source', 'legacy-quality-stale'].includes(scenario)) expect(reports).toHaveLength(0)
      else {
        expect(reports).toHaveLength(scenario === 'context-change' ? 2 : 1)
        expect(reports[0]).toMatchObject({ chapterRevision: 1, repairRound: 0, status: failed ? 'failed' : repairing && scenario !== 'evidence-corrected' || scenario === 'protected' ? 'needs_repair' : 'passed' })
        expect(reports[0].criticVersion).toBe(legacyWork ? 'humanity-critic.v2' : 'humanity-critic.v3')
      }
      if (admittedLegacy) {
        expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: admittedLegacy.id }, select: { id: true, inputHash: true, inputSnapshot: true } })).toEqual(admittedLegacy)
        expect(fetchMock).toHaveBeenCalledOnce()
      }
      if (scenario === 'evidence-corrected' || scenario === 'full-chain') {
        expect(reports[0].findings).toMatchObject([{ severity: 'advisory', evidenceExcerpt: '原文', disposition: 'pending' }])
        expect(reports[0].deterministicMetrics).toMatchObject({ independentCheck: 'complete', contentHash: createHash('sha256').update(before).digest('hex') })
      }
      if (repairing && scenario !== 'repair-stale') {
        expect(chapter.revision).toBe(1)
        expect(saved.stage).toBe('check')
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBeNull()
      }
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'quality_analyze')).toMatchObject(['success', 'repair', 'context-change'].includes(scenario) ? [{ ok: true }, { ok: true }] : [{ ok: !failed }])
    }, undefined, checkingOriginal ? authorRequest : '修改本章')
  })
})

describe.runIf(available).each(['continuity', 'quality'] as const)('只读检查复用当前真实报告 %s', family => {
  it.each(['apply', 'empty', 'stable', 'bold', 'protected', 'cancelled', 'stale', 'rollback-resume'] as const)('%s 保留正文、真实版本和原付费回执', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '落实检查意见' })
      const compilationId = compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      let originalReportId: string | undefined
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进', entryState: state, goal: '找线索', obstacle: '门锁', choice: '绕路', cost: '时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      if (family === 'continuity') {
        const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { chapter: true, bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
        const coverage = compilerContinuityCoverage({ chapter: current.chapter!, bridge: current.bridge, sceneTasks: current.sceneTasks, source: null })
        await validateStoryContinuity({ ...f, compilationId, findings: ['body', 'object', 'knowledge'].map(signal => ({ signal: signal as 'body' | 'object' | 'knowledge', severity: 'warning', evidence: '原文承接风险', suggestion: '局部澄清' })),
          expectedChapterRevision: 1, independentCheck: 'complete', coverage })
      } else {
        const report = await persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: 1, mode: 'premium', deterministicMetrics: {}, deterministicFindings: [], criticComplete: true,
          criticFindings: [{ signal: 'emotion_grounding', severity: 'advisory', quote: '原文', explanation: '缺少动作', suggestion: '局部改动', confidence: 0.9 }] })
        originalReportId = report.id
        const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
        await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { deterministicMetrics: { ...report.deterministicMetrics as Prisma.JsonObject, qualityContextHash: qualityReviewContextHash(bundle) } } })
      }
      const tool = family === 'continuity' ? continuityValidateTool : qualityAnalyzeTool
      const tools = [chapterBridgeGetTool, tool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: scenario === 'stable' || scenario === 'bold' ? scenario : 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: z.toJSONSchema(item.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '落实本章检查意见' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
            { id: 'repair', name: tool.name, arguments: JSON.stringify({ compilationId }) },
            { id: 'again', name: tool.name, arguments: JSON.stringify({ compilationId }) },
          ] }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'cached-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const signal = new AbortController()
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        expect(body.messages[1].content).toContain('作者新文')
        if (scenario === 'cancelled') signal.abort()
        const content = '{"findings":[]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const step = () => executeDurableToolStep(lease, signal.signal)
      await step()
      if (scenario === 'cancelled') signal.abort()
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新文', revision: { increment: 1 } } })
      if (scenario === 'rollback-resume') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, digest, work) => original(token, id, digest, async tx => { await work(tx); throw new Error('缓存修订回滚') }))
        await expect(step()).rejects.toThrow('缓存修订回滚')
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(1)
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'cached-resume')
        runtime.mockRejectedValue(new Error('恢复不能解析新路由'))
      }
      if (scenario === 'cancelled') {
        await expect(step()).rejects.toBeDefined()
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
        return
      }
      const result = await step()
      if (scenario === 'stale') expect(result).toMatchObject({ result: { summary: expect.stringContaining('检查') } })
      else {
        expect(result.kind).toBe('tool')
        if (result.kind === 'tool') expect(result.result.outcome).not.toBe('failed')
        await step()
      }
      const requests = scenario === 'stale' ? 1 : 0
      expect(fetchMock).toHaveBeenCalledTimes(requests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(requests)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.content).toBe(scenario === 'stale' ? '作者新文' : '原文')
      expect(chapter.revision).toBe(scenario === 'stale' ? 2 : 1)
      if (family === 'quality') {
        expect(originalReportId).toBeDefined()
        const report = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: originalReportId } })
        expect(report.chapterRevision).toBe(1)
        expect(report.repairRound).toBe(0)
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(scenario === 'stale' ? 2 : 1)
        if (scenario === 'stale') expect(await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId, chapterRevision: 2 } })).toMatchObject({
          repairRound: 0, deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update('作者新文').digest('hex') } })
        expect(report.deterministicMetrics).not.toHaveProperty('autoRepairAttempted', true)
      } else {
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
        expect(saved.validation).toMatchObject({ checkedRevision: scenario === 'stale' ? 2 : 1 })
        if (scenario === 'stale') expect(saved.validation).toMatchObject({ independentCheck: 'complete', coverage: { contentHash: runtimeJson({ content: '作者新文' }).hash } })
        expect(saved.validation).not.toHaveProperty('autoRepairRounds', 1)
      }
    })
  })
})

describe.runIf(available)('既有章节独立检查', () => {
  it.each(['continuity_validate', 'quality_analyze'] as const)('无需准备编译即可独立执行 %s，并复用当前报告', async name => {
    await fixture(async f => {
      const lease = await claim(f)
      const tool = name === 'continuity_validate' ? continuityValidateTool : qualityAnalyzeTool
      const tools = [chapterReadTool, tool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: z.toJSONSchema(item.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '只检查已有章' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: 'check', name, arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: 'cached', name, arguments: JSON.stringify({ chapterId: f.chapterId }) },
          ] }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'standalone-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const fetchMock = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`))
      vi.stubGlobal('fetch', fetchMock)
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      await step()
      for (let i = 0; i < 2; i++) {
        const result = await step()
        expect(result).toMatchObject({ kind: 'tool' })
        if (result.kind === 'tool') expect(result.result.outcome).not.toBe('failed')
      }
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.chapterBridge.count({ where: { novelId: f.novelId } })).toBe(0)
      if (name === 'continuity_validate') {
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'continuityReview' } })).toBe(1)
        const ctx: ToolContext = { ...f, callId: 'legacy-cache', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }
        expect((await continuityValidateTool.execute(ctx, { chapterId: f.chapterId })).outcome).not.toBe('failed')
        expect(fetchMock).toHaveBeenCalledOnce()
      }
    }, undefined, '检查当前既有章节')
  })

  it.each(['unread', 'wrong-id', 'stale', 'cancelled', 'format'] as const)('独立连续性检查 %s 不保存伪通过报告或修改正文', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, continuityValidateTool]
      const signal = new AbortController()
      const calls = [{ id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'check', name: 'continuity_validate', arguments: JSON.stringify({ chapterId: scenario === 'wrong-id' ? randomUUID() : f.chapterId }) }]
      if (scenario === 'unread') calls.shift()
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '只检查已有章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'standalone-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const fetchMock = vi.fn(async () => {
        if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者的新正文', revision: { increment: 1 } } })
        if (scenario === 'cancelled') signal.abort()
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: scenario === 'format' ? '无法提供结构化报告' : '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      if (scenario !== 'unread') await executeDurableToolStep(lease, signal.signal)
      const check = executeDurableToolStep(lease, signal.signal)
      if (scenario === 'cancelled') await expect(check).rejects.toBeDefined()
      else expect(await check).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
      expect(fetchMock).toHaveBeenCalledTimes(['unread', 'wrong-id'].includes(scenario) ? 0 : 1)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(scenario === 'stale' ? '作者的新正文' : '原文')
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'continuityReview' } })).toBe(0)
      expect(await prisma.storyCompilation.count({ where: { novelId: f.novelId } })).toBe(0)
    }, undefined, '检查当前既有章节')
  })
})
