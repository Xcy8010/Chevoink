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
import { prepareStoryCompilation, recordStoryCompilerWrite } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { tokenPriceSchema } from '../../api/lib/billing/token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'

// Legacy usage logs have their own user FK; clean only this fixture's real
// billing rows after assertions, before the shared durable fixture removes user.
const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)

const retryRuntime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', multiplierBps: 10000, reasoningEffort: 'low', reasoningEfforts: ['none', 'low'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const qualityCompletion = (content: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const qualityRateLimit = (usage?: object) => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' },
  ...(usage === undefined ? {} : { usage }) }), { status: 429 })

// Only release the route retry's 60-second timer early. PostgreSQL transaction
// timers, Date, review deadlines and AbortSignal deadlines remain real.
function interceptQualityRetryWait() {
  const realTimeout = globalThis.setTimeout, waits: number[] = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 60_000) return realTimeout(callback, ms, ...args)
    waits.push(ms)
    return realTimeout(callback, 0, ...args)
  }) as typeof setTimeout)
  return waits
}

async function currentContinuity(f: Parameters<Parameters<typeof fixture>[0]>[0], compilationId: string) {
  const { result } = await persistCurrentContinuityReport({ ...f, compilationId })
  expect(result).toMatchObject({ reviewCompleted: true })
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
  expect(compilation.validation).toMatchObject({ continuityReport: { chapterId: chapter.id, revision: chapter.revision,
    contentHash: createHash('sha256').update(chapter.content).digest('hex'), complete: true, billingKnown: true } })
}

async function prepareRetryQuality(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
  const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '完整质量检查' })
  const compilationId = prepared.compilation.id
  await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
  await currentContinuity(f, compilationId)
  const window = credits.getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  const ctx: ToolContext = { ...f, callId: 'rate-limit-quality', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium', modelRuntime: retryRuntime,
    signal: new AbortController().signal, emit: () => {} }
  return { ctx, compilationId }
}

describe.runIf(available)('actual quality tool zero-fee retry and format recovery in PostgreSQL', () => {
  it.each(['primary-absent', 'primary-zero', 'recovery-absent', 'recovery-zero', 'both'] as const)(
    '%s applies the complete format recovery and reuses it without additional HTTP', scenario => fixture(async f => {
      const { ctx, compilationId } = await prepareRetryQuality(f)
      const waits = interceptQualityRetryWait(), queue: Response[] = []
      const primaryRejected = scenario.startsWith('primary') || scenario === 'both'
      const recoveryRejected = scenario.startsWith('recovery') || scenario === 'both'
      if (primaryRejected) queue.push(qualityRateLimit(scenario === 'primary-zero' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined))
      queue.push(qualityCompletion('broken JSON'))
      if (recoveryRejected) queue.push(qualityRateLimit(scenario === 'recovery-zero' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined))
      queue.push(qualityCompletion('{"findings":[]}'))
      const expectedRequests = queue.length
      const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body))
        expect(request.model).toBe(retryRuntime.modelName)
        expect(request.reasoning_effort).toBe('none')
        expect(request.tools).toBeUndefined()
        expect(request.messages[1].content).toContain('原文')
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${retryRuntime.apiKey}`)
        const next = queue.shift()
        if (!next) throw new Error('unexpected extra HTTP request')
        return next
      })
      vi.stubGlobal('fetch', fetcher)
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect((await qualityAnalyzeTool.execute(ctx, { compilationId, chapterId: f.chapterId })).outcome).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(expectedRequests)
      expect(waits).toEqual(Array.from({ length: Number(primaryRejected) + Number(recoveryRejected) }, () => 60_000))
      const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3Humanity' } }, orderBy: { createdAt: 'asc' } })
      expect(paid).toHaveLength(expectedRequests)
      expect(paid.filter(row => row.action === 'agent3HumanityCritic')).toHaveLength(primaryRejected ? 2 : 1)
      expect(paid.filter(row => row.action === 'agent3HumanityFormatRecovery')).toHaveLength(recoveryRejected ? 2 : 1)
      for (const payment of paid) {
        expect(payment).toMatchObject({ modelName: retryRuntime.modelName, multiplierBps: retryRuntime.multiplierBps, reservedCreditMilli: 0 })
        if (payment.billingStatus === 'provider_rejected') expect(payment).toMatchObject({ usageSource: 'prepared', requestTokens: null, responseTokens: null, creditChargeMilli: 0 })
        else {
          expect(payment).toMatchObject({ usageSource: 'reported', billingStatus: 'settled' })
          expect(payment.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(payment.billingSnapshot), payment.requestTokens!, payment.responseTokens!, payment.promptCacheHitTokens))
          if (payment.requestTokens === 0 && payment.responseTokens === 0) expect(payment.billingEvidence).toMatchObject({ providerRejection: { status: 429 } })
        }
      }
      const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      expect(reports).toHaveLength(2)
      expect(reports[0]).toMatchObject({ status: 'failed', deterministicMetrics: { independentCheck: 'unavailable', formatRecovery: { state: 'claimed' },
        criticResponse: { rawResponse: { encoding: 'json-string', content: JSON.stringify('broken JSON'), complete: true } } } })
      expect(reports[1]).toMatchObject({ status: 'passed', deterministicMetrics: { independentCheck: 'complete', formatRecovery: { state: 'completed', reportId: reports[0].id },
        criticResponse: { rawResponse: { encoding: 'json-string', content: JSON.stringify('{"findings":[]}'), complete: true } } } })
      expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, ctx, { chapterId: f.chapterId }))).toBeNull()
      await qualityAnalyzeTool.execute(ctx, { compilationId, chapterId: f.chapterId })
      await qualityAnalyzeTool.execute({ ...ctx, callId: 'same-input-quality-reuse' }, { compilationId, chapterId: f.chapterId })
      expect(fetcher).toHaveBeenCalledTimes(expectedRequests)
      for (const payment of paid) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toBeNull()
    }))

  it.each(['primary-empty', 'primary-partial', 'primary-unknown', 'primary-pending-settlement',
    'recovery-empty', 'recovery-partial', 'recovery-unknown', 'recovery-pending-settlement'] as const)(
    '%s retains all accounting and never retries or produces a ready report', scenario => fixture(async f => {
      const { ctx, compilationId } = await prepareRetryQuality(f)
      const waits = interceptQualityRetryWait(), recovery = scenario.startsWith('recovery'), failure = scenario.replace(/^(primary|recovery)-/, '')
      const failedAction = recovery ? 'agent3HumanityFormatRecovery' : 'agent3HumanityCritic'
      if (failure === 'pending-settlement') {
        const consume = credits.consumeTokenCredits
        vi.spyOn(credits, 'consumeTokenCredits').mockImplementation(async args => {
          const payment = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: args.usageLogId } })
          if (payment.action === failedAction) throw new Error('fixture settlement unavailable')
          return consume(args)
        })
      }
      let requests = 0
      const fetcher = vi.fn(async () => {
        requests++
        if (recovery && requests === 1) return qualityCompletion('broken JSON')
        if (failure === 'unknown') throw new TypeError('fetch failed after dispatch')
        return qualityRateLimit(failure === 'empty' ? {} : failure === 'partial' ? { prompt_tokens: 10 } : { prompt_tokens: 0, completion_tokens: 0 })
      })
      vi.stubGlobal('fetch', fetcher)
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const result = await qualityAnalyzeTool.execute(ctx, { compilationId, chapterId: f.chapterId }).catch(error => ({ outcome: 'failed', failureCode: error.code ?? error.name }))
      expect(result.outcome).toBe('failed')
      expect(fetcher).toHaveBeenCalledTimes(recovery ? 2 : 1)
      expect(waits).toEqual([])
      const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3Humanity' } } })
      expect(paid).toHaveLength(recovery ? 2 : 1)
      for (const payment of paid) {
        expect(payment.modelName).toBe(retryRuntime.modelName); expect(payment.multiplierBps).toBe(retryRuntime.multiplierBps)
        if (payment.action === failedAction) {
          expect(payment.billingStatus).toBe(failure === 'pending-settlement' ? 'pending_settlement' : 'pending_usage')
          expect(payment.creditChargeMilli).toBe(0)
          if (failure === 'partial') expect(payment).toMatchObject({ requestTokens: 10, responseTokens: null })
          if (failure === 'pending-settlement') expect(payment).toMatchObject({ requestTokens: 0, responseTokens: 0 })
        } else {
          expect(payment).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', requestTokens: 10, responseTokens: 5, reservedCreditMilli: 0 })
          expect(payment.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(payment.billingSnapshot), 10, 5, payment.promptCacheHitTokens))
        }
      }
      const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId } })
      expect(reports.every(report => report.status === 'failed')).toBe(true)
      for (const report of reports) expect(report.deterministicMetrics).not.toMatchObject({ independentCheck: 'complete' })
      if (recovery) {
        expect(reports).toHaveLength(1)
        expect(reports[0].deterministicMetrics).toMatchObject({ formatRecovery: { state: 'claimed' } })
      }
      expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, ctx, { chapterId: f.chapterId }))).toBeNull()
      // The original claimed recovery cannot reopen after an unknown result.
      if (recovery) {
        await qualityAnalyzeTool.execute({ ...ctx, callId: 'unknown-recovery-replay' }, { compilationId, chapterId: f.chapterId }).catch(() => {})
        expect(fetcher).toHaveBeenCalledTimes(2)
      }
      for (const payment of paid) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    }))
})

describe.runIf(available)('settled legacy quality format recovery', () => {
  it.each(['live-valid', 'live-failed', 'old-valid', 'old-repair', 'old-unknown', 'old-stale', 'old-context', 'old-foreign', 'old-tampered', 'old-concurrent', 'old-reprepare', 'live-cancelled', 'live-mechanical'] as const)(
    '%s preserves paid identity and permits only one authenticated recovery', async scenario => fixture(async f => {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查并按原授权修订本章' })
      const compilationId = prepared.compilation.id
      await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
      await currentContinuity(f, compilationId)
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real',
        multiplierBps: 10000, reasoningEffort: 'low' as const, reasoningEfforts: ['none', 'low'] as Array<'none' | 'low'>,
        reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
      const resolveRuntime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
      vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
      const controller = new AbortController()
      const ctx: ToolContext = { ...f, callId: 'new-quality', mode: 'build', creativeFreedom: scenario === 'old-repair' ? 'balanced' : 'stable',
        qualityMode: 'premium', modelRuntime: runtime, signal: controller.signal, emit: () => {} }
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
        const content = scenario === 'live-failed' ? 'broken JSON\0' : scenario === 'live-mechanical' ? '说明：[合成文字噪声\n{"findings":[],}\n备注：[非报告文字' : seedingOld || scenario === 'live-valid' && requests === 1 || scenario === 'live-cancelled' ? 'broken JSON'
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
        // Earlier caller without live recovery. Its unique call/result
        // interval and actual settled usage remain authoritative.
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
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: new Date(Math.max(Date.now(), report.createdAt.getTime()) + 1),
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
      if (scenario === 'live-mechanical') {
        expect(fetchMock).toHaveBeenCalledOnce()
        const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
        expect(paid).toHaveLength(1)
        expect(paid[0]).toMatchObject({ action: 'agent3HumanityCritic', usageSource: 'reported', billingStatus: 'settled' })
        const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId } })
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({ status: 'passed', deterministicMetrics: { independentCheck: 'complete', criticResponse: { parserVersion: 3, classification: 'complete' } } })
        expect(reports[0].deterministicMetrics).not.toHaveProperty('formatRecovery')
        expect(reports[0].deterministicMetrics).toMatchObject({ criticResponse: { rawResponse: { encoding: 'json-string', complete: true } } })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
        expect(JSON.stringify(result)).not.toContain('合成文字噪声')
        return
      }
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
      const malformed = scenario === 'live-failed' ? 'broken JSON\0' : 'broken JSON'
      expect(reports[0].deterministicMetrics).toMatchObject({ criticResponse: { contentHash: createHash('sha256').update(malformed).digest('hex'),
        rawResponse: { encoding: 'json-string', content: JSON.stringify(malformed), complete: true } } })
      expect(JSON.stringify(result)).not.toContain('rawResponse')
    }))
})
