import type { Prisma } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { commitChapterBridge, prepareStoryCompilation, recordStoryCompilerWrite, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { readQualityReviewAdmission } from '../../api/lib/agent/quality-review-admission.js'
import { readQualityFormatRecovery } from '../../api/lib/agent/quality-format-recovery.js'
import { readQualityUnavailableProof } from '../../api/lib/agent/quality-unavailable-proof.js'
import { readOriginalTaskRequest, originalTaskRunIds } from '../../api/lib/agent/original-request.js'
import { buildHumanityQualityContext, persistHumanityQualityReport, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { inspectCriticResponse } from '../../api/lib/agent/quality-evidence.js'
import { initializeExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)
type F = Parameters<Parameters<typeof fixture>[0]>[0]
const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real',
  multiplierBps: 10000, reasoningEffort: 'low' as const, reasoningEfforts: ['none', 'low'] as Array<'none' | 'low'>,
  reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }

// The two continuation chains have separate bounded assertion phases over one
// exact fixture. Every provider call stays inside a 5000ms test, not a hook.
function phaseFixture() {
  let f: F, release: () => void = () => {}, cleanup: Promise<void> | undefined
  beforeAll(async () => {
    let ready: () => void = () => {}, failed: (error: unknown) => void = () => {}
    const admitted = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    const held = new Promise<void>(resolve => { release = resolve })
    cleanup = fixture(async subject => { f = subject; ready(); await held })
    cleanup.catch(failed)
    await admitted
  })
  afterAll(async () => { release(); await cleanup })
  return () => f
}
function installRuntime() {
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
  vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
    rateCardId: 'author-continue-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
}

async function prepare(f: F, legacy: boolean) {
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  if (legacy) await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
  const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '完成原授权正文的当前版本检查' })
  if (legacy) await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁',
    choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
  if (legacy) await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
  const window = credits.getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  installRuntime()
  return compilation.id
}

function provider(response: (request: number) => string | never, continuityRequest?: number) {
  let requests = 0
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    expect(body.reasoning_effort).toBe(requests + 1 === continuityRequest ? 'low' : 'none')
    expect(body.thinking?.type).not.toBe('enabled')
    expect(body.tools).toBeUndefined()
    expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
    const content = response(++requests)
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return Object.assign(fetchMock, { requestCount: () => requests })
}

async function oldCompleteReport(f: F, compilationId: string, dropped: boolean) {
  const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
  const response = JSON.stringify({ findings: dropped ? [{ signal: 'emotion_grounding', severity: 'advisory', quote: '原文', explanation: '合成旧意见', suggestion: '保留待审' }, null] : [] })
  const old = inspectCriticResponse(response)
  expect(old.complete).toBe(true)
  return persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: 1, mode: 'premium', deterministicMetrics: {},
    qualityContextHash: qualityReviewContextHash(bundle), deterministicFindings: [], criticComplete: old.complete,
    criticFindings: old.findings, criticDropped: old.diagnostic.droppedFindings, criticResponseDiagnostic: old.diagnostic })
}

async function legacyHarness(f: F) {
  const compilationId = await prepare(f, true)
  const ctx: ToolContext = { ...f, callId: 'quality', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {} }
  let sequence = 0
  const event = (type: string, payload: Prisma.InputJsonObject) => prisma.agentRunEvent.create({ data: { runId: f.runId, seq: ++sequence, type, payload } })
  const check = async () => {
    const callId = `quality-${sequence + 1}`
    await event('tool.call', { toolName: 'quality_analyze', callId, args: { compilationId, chapterId: f.chapterId } })
    const result = await qualityAnalyzeTool.execute({ ...ctx, callId }, { compilationId, chapterId: f.chapterId })
    await event('tool.result', { toolName: 'quality_analyze', callId, ok: result.outcome !== 'failed', ...(result.failureCode ? { failureCode: result.failureCode } : {}) })
    return result
  }
  const read = () => prisma.$transaction(tx => readQualityFormatRecovery(tx, f, { chapterId: f.chapterId }))
  const admission = () => prisma.$transaction(async tx => readQualityReviewAdmission(tx, await tx.agentRun.findUniqueOrThrow({ where: { id: f.runId } })))
  const pause = () => event('run.paused', { reason: 'review_incomplete', message: '真实已结算格式失败等待作者继续' })
  const resume = (terminal: { id: string }) => event('run.started', { authorContinue: { eventId: terminal.id, afterSeq: sequence } })
  return { compilationId, ctx, check, read, admission, event, pause, resume }
}

describe.runIf(available)('author admissions after settled quality format failures', () => {
  describe('one authored task through distinct persisted continuation phases', () => {
    const get = phaseFixture()
    let h: Awaited<ReturnType<typeof legacyHarness>>, fetchMock: ReturnType<typeof provider>
    let before: Awaited<ReturnType<typeof prisma.chapter.findUniqueOrThrow>>, originalAudit: Prisma.JsonValue
    let sourceReportId: string, firstAdmissionId: string
    beforeAll(async () => {
      const f = get()
    h = await legacyHarness(f)
    fetchMock = provider(request => request <= 3 ? 'synthetic malformed report' : '{"findings":[]}', 5)
    before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    })
    beforeEach(() => { installRuntime(); vi.stubGlobal('fetch', fetchMock) })
    it('persists two format failures then one format-only failure; repeated pause click grants no paid work', async () => {
      const f = get()
    expect(await h.check()).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' })
    expect(fetchMock.requestCount()).toBe(2)
    const originalReports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId }, orderBy: { createdAt: 'asc' } })
    expect(originalReports).toHaveLength(2)
    sourceReportId = originalReports[0].id
    originalAudit = originalReports[0].deterministicMetrics
    expect(await h.read()).toBeNull()
    const firstPause = await h.pause()
    await h.resume(firstPause)
    const firstAdmission = await h.admission()
    firstAdmissionId = firstAdmission!.id
    expect(firstAdmission?.id).toBe(`author-continue:${firstPause.id}`)
    const recovery = await h.read()
    expect(recovery).toMatchObject({ reportId: originalReports[1].id, admissionId: firstAdmission!.id, chapterRevision: 1 })
    expect(await h.check()).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' })
    expect(fetchMock.requestCount()).toBe(3)
    // A second click on this exact pause is the same admission, even when a
    // worker-start event is appended. It cannot buy a new paid request.
    await h.resume(firstPause)
    expect(await h.admission()).toMatchObject({ id: firstAdmission!.id })
    expect(await h.read()).toBeNull()
    expect(await h.check()).toMatchObject({ outcome: 'failed' })
    expect(fetchMock.requestCount()).toBe(3)
    })
    it('a distinct author continue passes current quality and continuity before strict bridge commit', async () => {
      const f = get()
    const secondPause = await h.pause()
    await h.resume(secondPause)
    const secondAdmission = await h.admission()
    expect(secondAdmission?.id).toBe(`author-continue:${secondPause.id}`)
    expect(secondAdmission?.id).not.toBe(firstAdmissionId)
    expect(await h.read()).toMatchObject({ admissionId: secondAdmission!.id, chapterRevision: 1 })
    expect((await h.check()).outcome).toBeUndefined()
    expect(fetchMock.requestCount()).toBe(4)
    expect((await qualityAnalyzeTool.execute(h.ctx, { compilationId: h.compilationId })).outcome).toBeUndefined()
    expect(fetchMock.requestCount()).toBe(4)
    expect((await continuityValidateTool.execute(h.ctx, { compilationId: h.compilationId })).outcome).toBeUndefined()
    expect(fetchMock.requestCount()).toBe(5)
    const current = await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId, status: 'passed' }, orderBy: { createdAt: 'desc' } })
    expect(current.chapterRevision).toBe(before.revision)
    expect(await commitChapterBridge({ ...f, compilationId: h.compilationId, chapterSummary: '原文当前终态', exitState: state,
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '动作', requireQuality: true, qualityReportId: current.id }))
      .toMatchObject({ chapterRevision: before.revision })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: h.compilationId } })).toMatchObject({ status: 'completed' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
    expect(paid).toHaveLength(5)
    expect(paid.every(row => row.usageSource === 'reported' && row.billingStatus === 'settled')).toBe(true)
    expect(paid.filter(row => row.action === 'agent3HumanityFormatRecovery')).toHaveLength(3)
    expect((await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: sourceReportId } })).deterministicMetrics).toEqual(originalAudit)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toMatchObject({ currentTurn: 0 })
    })
  })

  it.each(['ordinary-start', 'pending-usage', 'no-credit'] as const)('%s never resets accounting or pays again without a valid affordable result', async scenario => fixture(async f => {
    const h = await legacyHarness(f), fetchMock = provider(() => 'synthetic malformed report')
    expect(await h.check()).toMatchObject({ outcome: 'failed' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const used = await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })
    const originalUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    if (scenario === 'ordinary-start') {
      await h.event('run.started', { resumed: true })
      expect(await h.admission()).toBeNull()
    } else {
      if (scenario === 'pending-usage') await prisma.aiUsageLog.update({ where: { id: originalUsage[0].id }, data: { agentRunId: f.runId, usageSource: 'unknown', billingStatus: 'pending_usage' } })
      if (scenario === 'no-credit') await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyAllowanceMilli: used.dailyUsedMilli, bonusBalanceMilli: 0 } })
      const terminal = await h.pause()
      await h.resume(terminal)
      expect(await h.admission()).not.toBeNull()
    }
    if (scenario === 'no-credit') await expect(h.check()).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
    else { expect(await h.read()).toBeNull(); expect(await h.check()).toMatchObject({ outcome: 'failed' }) }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(2)
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ dailyUsedMilli: used.dailyUsedMilli })
    if (scenario === 'pending-usage') expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: originalUsage[0].id } })).toMatchObject({ usageSource: 'unknown', billingStatus: 'pending_usage' })
  }))

  it('copied typed startRequest requires the exact actual author message and matching owned request', async () => fixture(async f => {
    const request = withHumanAdmission({ sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build', prompt: '继续原章质量检查' })
    const copy = await prisma.agentRun.create({ data: { userId: f.userId, sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running', startRequest: request } })
    const read = () => prisma.$transaction(async tx => readQualityReviewAdmission(tx, await tx.agentRun.findUniqueOrThrow({ where: { id: copy.id } })))
    expect(await read()).toBeNull()
    const message = await prisma.agentMessage.create({ data: { runId: copy.id, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '其他请求' }] } })
    expect(await read()).toBeNull()
    await prisma.agentMessage.update({ where: { id: message.id }, data: { parts: [{ type: 'text', text: request.prompt }] } })
    expect(await read()).toMatchObject({ id: `author-message:${message.id}` })
    await prisma.agentRun.update({ where: { id: copy.id }, data: { startRequest: withHumanAdmission({ ...request, novelId: 'foreign' }) } })
    expect(await read()).toBeNull()
  }))

  it('settled historical main-model unknown usage remains intact and permits an authored quality check', async () => fixture(async f => {
    const h = await legacyHarness(f), fetchMock = provider(request => request <= 2 ? 'synthetic malformed report' : '{"findings":[]}')
    expect(await h.check()).toMatchObject({ outcome: 'failed' })
    const historical = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId,
      targetType: 'agentRun', targetId: f.runId, providerType: 'text', providerMode: 'system', modelName: 'synthetic-main',
      action: 'agentMain', usageSource: 'unknown', billingStatus: 'settled', durationMs: 0 } })
    const terminal = await h.pause()
    await h.resume(terminal)
    expect(await h.read()).toMatchObject({ admissionId: `author-continue:${terminal.id}` })
    expect((await h.check()).outcome).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
  }))

  it.each([true, false])('legacy new checks never reuse dropped=%s old complete judgments; intact old caches remain free', async dropped => fixture(async f => {
    const h = await legacyHarness(f), fetchMock = provider(() => '{"findings":[]}')
    const old = await oldCompleteReport(f, h.compilationId, dropped)
    expect(old.status).toBe('passed')
    expect((await h.check()).outcome).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(dropped ? 1 : 0)
    const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId } })
    expect(reports).toHaveLength(dropped ? 2 : 1)
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ deterministicMetrics: { droppedFindings: dropped ? 1 : 0 } })
  }))

  it('a real unknown format-only payment with null agentRunId blocks the next human continue without a replay', async () => fixture(async f => {
    const h = await legacyHarness(f)
    const fetchMock = provider(request => { if (request === 3) throw new Error('synthetic unknown format transport'); return 'synthetic malformed report' })
    expect(await h.check()).toMatchObject({ outcome: 'failed' })
    const firstPause = await h.pause()
    await h.resume(firstPause)
    expect(await h.check()).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const unknown = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, billingStatus: 'pending_usage', action: 'agent3HumanityFormatRecovery' } })
    expect(unknown).toMatchObject({ usageSource: 'unknown', agentRunId: null })
    const nextPause = await h.pause()
    await h.resume(nextPause)
    expect(await h.admission()).toMatchObject({ id: `author-continue:${nextPause.id}` })
    expect(await h.read()).toBeNull()
    expect(await h.check()).toMatchObject({ outcome: 'failed' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: unknown.id } })).toEqual(unknown)
  }))
})

async function nativeHarness(f: F) {
    let lease = await claim(f)
    const compilationId = await prepare(f, false)
    const tools = [chapterBridgeGetTool, qualityAnalyzeTool]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'stable', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '完成原任务检查' }, { role: 'assistant', content: null, toolCalls: [
          { id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
          { id: 'quality', name: 'quality_analyze', arguments: JSON.stringify({ compilationId }) }] }] } })
    return { compilationId, get lease() { return lease }, set lease(value: typeof lease) { lease = value },
      step: () => executeDurableToolStep(lease, new AbortController().signal) }
}

describe.runIf(available)('native quality continuation binds real pause and payment receipts', () => {
  it.each(['unknown', 'cached-dropped', 'cached-complete'] as const)('%s retains original frame, budgets and provider identities on human resume', async scenario => fixture(async f => {
    const h = await nativeHarness(f), compilationId = h.compilationId
    let lease = h.lease
    const fetchMock = provider(() => { if (scenario === 'unknown') throw new Error('synthetic unknown provider outcome'); return scenario.startsWith('cached') ? '{"findings":[]}' : 'synthetic malformed report' })
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    if (scenario.startsWith('cached')) {
      const old = await oldCompleteReport(f, compilationId, scenario === 'cached-dropped')
      expect(await step()).toMatchObject({ kind: 'tool' })
      expect(fetchMock).toHaveBeenCalledTimes(scenario === 'cached-dropped' ? 1 : 0)
      const work = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'quality_analyze' } })
      expect(work.inputSnapshot).toMatchObject({ input: { work: { version: 6, parserVersion: 2, cached: scenario === 'cached-dropped' ? null : { id: old.id } } } })
      return
    }
    if (scenario === 'unknown') await expect(step()).rejects.toThrow('synthetic unknown provider outcome')
    else expect(await step()).toMatchObject({ result: { outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' } })
    const initialRequests = scenario === 'unknown' ? 1 : 2
    expect(fetchMock).toHaveBeenCalledTimes(initialRequests)
    const originalState = await loadExecutionState(f.userId, lease.runId)
    await pauseDurableTask(f.userId, lease.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    const first = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, eventKey: `resume:${pause.id}` } })).toBe(1)
    lease = await claim({ ...f, runId: first.run.id }, 'author-continue')
    const resumed = await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })
    expect(await prisma.$transaction(tx => readQualityReviewAdmission(tx, resumed))).toMatchObject({ id: `resume:${pause.id}` })
    const restored = await loadExecutionState(f.userId, lease.runId)
    expect(restored.configuration).toEqual(originalState.configuration)
    expect(restored.frame.state.turn).toBe(originalState.frame.state.turn)
    expect(restored.frame.state.checkpointIndex).toBe(originalState.frame.state.checkpointIndex)
    if (scenario === 'unknown') {
      await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await prisma.agentProviderAttempt.count({ where: { runId: f.runId, status: 'unknown' } })).toBe(1)
      return
    }
  }))
})


describe.runIf(available)('settled native format-only result through independent author continuations', () => {
  const get = phaseFixture()
  let h: Awaited<ReturnType<typeof nativeHarness>>, fetchMock: ReturnType<typeof provider>, compilationId: string, priorRunId: string
  let originalBudget: Awaited<ReturnType<typeof prisma.agentTaskBudget.findUniqueOrThrow>>
  beforeAll(async () => { h = await nativeHarness(get()); compilationId = h.compilationId; fetchMock = provider(() => 'synthetic malformed report') })
  beforeEach(() => { installRuntime(); vi.stubGlobal('fetch', fetchMock) })
  it('authenticates a new pause-bound admission while retaining the original execution frame and financial policy', async () => {
    const f = get()
      await h.step()
      expect(await h.step()).toMatchObject({ result: { outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' } })
      expect(fetchMock.requestCount()).toBe(2)
      originalBudget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      const originalState = await loadExecutionState(f.userId, h.lease.runId)
      await pauseDurableTask(f.userId, h.lease.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: h.lease.runId, pauseEventId: pause.id })
      const duplicate = await resumeDurableTask({ userId: f.userId, runId: h.lease.runId, pauseEventId: pause.id })
      expect(duplicate.run.id).toBe(resumed.run.id)
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, eventKey: `resume:${pause.id}` } })).toBe(1)
      expect(fetchMock.requestCount()).toBe(2)
      h.lease = await claim({ ...f, runId: resumed.run.id }, 'native-format-author')
      priorRunId = resumed.run.id
      const lease = h.lease, restored = await loadExecutionState(f.userId, lease.runId)
      expect(restored.configuration).toEqual(originalState.configuration)
      expect(restored.frame.state.turn).toBe(originalState.frame.state.turn)
      expect(restored.frame.state.checkpointIndex).toBe(originalState.frame.state.checkpointIndex)
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(originalBudget)
    expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, { ...f, runId: lease.runId }, { chapterId: f.chapterId }))).toMatchObject({ admissionId: `resume:${pause.id}` })
    await saveExecutionState(lease, { expectedRevision: restored.frame.revision, expectedHash: restored.frame.snapshotHash,
      snapshot: { ...restored.frame.state, messages: [...restored.frame.state.messages, { role: 'assistant', content: null, toolCalls: [
        { id: 'resumed-bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
        { id: 'resumed-quality', name: 'quality_analyze', arguments: JSON.stringify({ compilationId }) }] }] } })
  })
  it('persists the real format-only failed payment, then reads new eligibility only after a different author pause', async () => {
    const f = get(), lease = h.lease
    await h.step()
    expect(await h.step()).toMatchObject({ result: { outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' } })
    expect(fetchMock.requestCount()).toBe(3)
    const report = await prisma.chapterQualityReport.findFirstOrThrow({ where: { runId: lease.runId }, include: { findings: true } })
    const operation = await prisma.agentOperation.findFirstOrThrow({ where: { originRunId: lease.runId, action: 'quality_analyze' } })
    expect(await prisma.agentOperation.count({ where: { parentOperationId: operation.id, action: 'quality_critic' } })).toBe(0)
    expect(await prisma.agentOperation.count({ where: { parentOperationId: operation.id, action: 'quality_format_recovery' } })).toBe(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(3)
    await pauseDurableTask(f.userId, lease.runId)
    const nextPause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    const next = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: nextPause.id })
    const subject = { ...f, runId: next.run.id }
    const eligibility = await prisma.$transaction(tx => readQualityFormatRecovery(tx, subject, { chapterId: f.chapterId }))
    expect(eligibility).toMatchObject({ reportId: report.id, admissionId: `resume:${nextPause.id}`, chapterRevision: 1 })
    const proof = await prisma.$transaction(async tx => {
      const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
      return readQualityUnavailableProof(tx, subject, ids, report, { id: f.chapterId, revision: 1, content: '原文' }, f.rootId, { allowFormatRecovery: true })
    })
    expect(proof).toMatchObject({ source: 'durable', code: 'QUALITY_REPORT_INCOMPLETE' })
    expect(fetchMock.requestCount()).toBe(3)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '原文', revision: 1 })
    expect(next.run.taskRootId).toBe(f.rootId)
    expect(next.run.id).not.toBe(priorRunId)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(originalBudget)
  })
})
