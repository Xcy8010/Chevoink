import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as recoveryClaims from '../../api/lib/agent/quality-format-recovery.js'
import { buildHumanityQualityContext, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { readQualityFormatRecovery, claimQualityFormatRecovery } from '../../api/lib/agent/quality-format-recovery.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { prepareStoryCompilation, recordStoryCompilerWrite, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

// Legacy usage logs have their own user FK; clean only this fixture's real
// billing rows after assertions, before the shared durable fixture removes user.
const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)

describe.runIf(available)('settled legacy quality format recovery', () => {
  it.each(['live-valid', 'live-failed', 'old-valid', 'old-repair', 'old-unknown', 'old-stale', 'old-context', 'old-foreign', 'old-tampered', 'old-concurrent', 'old-reprepare', 'live-cancelled'] as const)(
    '%s preserves paid identity and permits only one authenticated recovery', async scenario => fixture(async f => {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查并按原授权修订本章' })
      const compilationId = prepared.compilation.id
      await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
      await validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: 'complete' })
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real',
        multiplierBps: 10000, reasoningEffort: 'low' as const, reasoningEfforts: ['none', 'low'] as Array<'none' | 'low'>,
        reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
      const resolveRuntime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
      vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
      const controller = new AbortController()
      const ctx: ToolContext = { ...f, callId: 'new-quality', mode: 'build', creativeFreedom: scenario === 'old-repair' ? 'balanced' : 'stable',
        qualityMode: 'premium', signal: controller.signal, emit: () => {} }
      let requests = 0
      let seedingOld = false
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe('fixture')
        expect(body.reasoning_effort).toBe('none')
        expect(body.thinking?.type).not.toBe('enabled')
        expect(body.tools).toBeUndefined()
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        if (scenario === 'old-repair' && !seedingOld && requests === 1) resolveRuntime.mockRejectedValue(new Error('Recovery repair must retain its frozen model'))
        if (scenario === 'live-cancelled') controller.abort()
        const content = seedingOld || scenario === 'live-failed' || scenario === 'live-valid' && requests === 1 || scenario === 'live-cancelled' ? 'broken JSON'
          : scenario === 'old-repair' ? requests === 1 ? JSON.stringify({ findings: [{ signal: 'emotion_grounding', severity: 'warning', quote: '原文',
            explanation: '缺少人物具体动作', suggestion: '落实为具体动作', confidence: 0.9 }] }) : '{"patches":[{"findingId":"'+(await prisma.qualityFinding.findFirstOrThrow({ where: { report: { chapterId: f.chapterId }, source: 'critic' } })).id+'","replacement":"新文"}]}'
            : '{"findings":[]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', fetchMock)
      const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
      const contextHash = qualityReviewContextHash(bundle)
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      let sourceReportId: string | undefined
      if (scenario.startsWith('old-')) {
        // Genuine historical hash-only audit: the raw model reply was not
        // retained. Its unique call/result interval and settled usage survive.
        const callId = 'old-quality', calledAt = new Date(Date.now() - 1000)
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: calledAt,
          payload: { toolName: 'quality_analyze', callId, args: { compilationId, chapterId: f.chapterId } } } })
        // Simulate the pre-recovery caller, with real HTTP completion and
        // settlement. Only the newer live claim is absent; no receipt is invented.
        const oldClaim = vi.spyOn(recoveryClaims, 'claimCurrentQualityFormatRecovery').mockResolvedValueOnce(null)
        seedingOld = true
        expect(await qualityAnalyzeTool.execute({ ...ctx, callId }, { compilationId, chapterId: f.chapterId }))
          .toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' })
        oldClaim.mockRestore()
        seedingOld = false
        const report = await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId } })
        sourceReportId = report.id
        requests = 0
        fetchMock.mockClear()
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: new Date(Date.now() + 1),
          payload: { toolName: 'quality_analyze', callId, ok: false, failureCode: 'QUALITY_REPORT_INCOMPLETE' } } })
        const subject = { userId: f.userId, novelId: f.novelId, runId: f.runId }
        const eligibility = await prisma.$transaction(tx => readQualityFormatRecovery(tx, subject, { chapterId: f.chapterId }))
        expect(eligibility).toMatchObject({ reportId: report.id, compilationId, chapterId: f.chapterId, chapterRevision: 1, contextHash })
        if (scenario === 'old-unknown') await prisma.aiUsageLog.updateMany({ where: { userId: f.userId }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
        if (scenario === 'old-stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '用户新文' } })
        if (scenario === 'old-context') await prisma.novel.update({ where: { id: f.novelId }, data: { categoryName: '作者新创作规格' } })
        if (scenario === 'old-tampered') await prisma.agentRunEvent.updateMany({ where: { runId: f.runId, type: 'tool.result' }, data: { payload: { toolName: 'quality_analyze', callId: 'forged', ok: false, failureCode: 'QUALITY_REPORT_INCOMPLETE' } } })
        if (scenario === 'old-foreign') {
          const foreign = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
            status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', startRequest: { prompt: '无关新任务' } } })
          expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, { ...subject, runId: foreign.id }, { chapterId: f.chapterId }))).toBeNull()
          expect(await prisma.$transaction(tx => claimQualityFormatRecovery(tx, { ...subject, runId: foreign.id }, eligibility!))).toBe(false)
          expect(fetchMock).not.toHaveBeenCalled()
          return
        }
        if (['old-unknown', 'old-stale', 'old-context', 'old-tampered'].includes(scenario)) {
          expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, subject, { chapterId: f.chapterId }))).toBeNull()
          expect(await prisma.$transaction(tx => claimQualityFormatRecovery(tx, subject, eligibility!))).toBe(false)
          expect(fetchMock).not.toHaveBeenCalled()
          return
        }
        if (scenario === 'old-concurrent' || scenario === 'old-reprepare') {
          const claims = await Promise.all([0, 1].map(() => prisma.$transaction(tx => claimQualityFormatRecovery(tx, subject, eligibility!))))
          expect(claims.sort()).toEqual([false, true])
          if (scenario === 'old-reprepare') {
            await prisma.storyCompilation.update({ where: { id: compilationId }, data: { status: 'abandoned' } })
            const second = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '重新准备相同正文' })
            expect(second.compilation.id).not.toBe(compilationId)
            expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, subject, { chapterId: f.chapterId }))).toBeNull()
            // A fresh critic input may be checked; a second malformed result
            // cannot buy a second format recovery for unchanged正文版本.
            seedingOld = true
            expect(await qualityAnalyzeTool.execute(ctx, { compilationId: second.compilation.id, chapterId: f.chapterId }))
              .toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' })
            expect(fetchMock).toHaveBeenCalledOnce()
            expect(await prisma.aiUsageLog.count({ where: { userId: f.userId, action: 'agent3HumanityFormatRecovery' } })).toBe(0)
            expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
            return
          }
          expect(await qualityAnalyzeTool.execute(ctx, { compilationId, chapterId: f.chapterId })).toMatchObject({ outcome: 'failed' })
          expect(fetchMock).not.toHaveBeenCalled()
          return
        }
      }
      const action = qualityAnalyzeTool.execute(ctx, { compilationId, chapterId: f.chapterId })
      if (scenario === 'live-cancelled') {
        await expect(action).rejects.toBeDefined()
        expect(fetchMock).toHaveBeenCalledOnce()
        return
      }
      const result = await action
      if (scenario === 'live-failed') expect(result).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' })
      else expect(result.outcome).toBeUndefined()
      const expected = scenario === 'live-valid' || scenario === 'live-failed' || scenario === 'old-repair' ? 2 : 1
      expect(fetchMock).toHaveBeenCalledTimes(expected)
      const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3Humanity' } }, orderBy: { createdAt: 'asc' } })
      expect(paid.every(item => item.usageSource === 'reported' && item.billingStatus === 'settled')).toBe(true)
      expect(paid.filter(item => item.action === 'agent3HumanityFormatRecovery')).toHaveLength(1)
      expect(paid).toHaveLength(expected + (scenario.startsWith('old-') ? 1 : 0))
      const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      expect(reports).toHaveLength(2)
      expect(reports[0]).toMatchObject({ status: 'failed', deterministicMetrics: { formatRecovery: { state: 'claimed' } } })
      expect(reports[1]).toMatchObject({ status: scenario === 'live-failed' ? 'failed' : scenario === 'old-repair' ? 'repaired' : 'passed',
        deterministicMetrics: { formatRecovery: { reportId: sourceReportId ?? reports[0].id, state: scenario === 'live-failed' ? 'failed' : 'completed' } } })
      expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, { userId: f.userId, novelId: f.novelId, runId: f.runId }, { chapterId: f.chapterId }))).toBeNull()
      if (scenario !== 'old-repair') {
        const after = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        expect(after).toEqual(before)
        const calls = fetchMock.mock.calls.length
        const again = await qualityAnalyzeTool.execute(ctx, { compilationId, chapterId: f.chapterId })
        expect(again.outcome).toBe(scenario === 'live-failed' ? 'failed' : undefined)
        expect(fetchMock).toHaveBeenCalledTimes(calls)
      } else {
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '新文', revision: before.revision + 1 })
        expect(reports[1].repairRound).toBe(1)
      }
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('active')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toBeNull()
      expect(reports[0].deterministicMetrics).toMatchObject({ criticResponse: { contentHash: createHash('sha256').update('broken JSON').digest('hex') } })
    }))
})
