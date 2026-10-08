import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { available, fixture as baseFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, recordStoryCompilerWrite, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { buildHumanityQualityContext, qualityReviewContextHash, HUMANITY_CRITIC_VERSION } from '../../api/lib/agent/humanity-quality.js'
import { readQualityFormatRecovery, claimQualityFormatRecovery } from '../../api/lib/agent/quality-format-recovery.js'
import { deleteLoopSessionMessage } from '../../api/lib/agent/session-messages.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as aiService from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as sessionTitle from '../../api/lib/agent/session-title.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { buildQualityEvidenceSources, qualityCorrectionResponseWitness } from '../../api/lib/agent/quality-evidence.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const fixture: typeof baseFixture = (work, ...rest) => baseFixture(async f => {
  try { await work(f) } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
}, ...rest)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

async function seed(f: Parameters<Parameters<typeof fixture>[0]>[0], completeSetup = false) {
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  const at = Date.now() - 60000, time = (ms: number) => new Date(at + ms)
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', taskRootId: null, runtimeProtocolVersion: 0, createdAt: time(-1000) } })
  const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '完成本章检查' })
  if (completeSetup) {
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '推进场景', entryState: state, goal: '找线索', obstacle: '门上锁',
      choice: '绕路', cost: '时间', turn: '发现脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
    await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
    await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: [], expectedChapterRevision: 1, independentCheck: 'complete' })
  }
  const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
  const contextHash = qualityReviewContextHash(bundle), oldRun = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()]
  await prisma.agentRun.create({ data: { id: oldRun, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
    status: 'paused', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: json(f.spec), createdAt: time(500) } })
  const message = await prisma.agentMessage.create({ data: { runId: oldRun, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '继续' }] } })
  await prisma.agentRunEvent.create({ data: { runId: oldRun, seq: 1, type: 'run.paused', payload: {} } })
  const link = (index: number) => ({ version: 1, key: sha(`key-${index}`), taskId: f.spec.id, reportId: ids[index], chapterId: f.chapterId,
    chapterRevision: 1, compilationId: compilation.id, contextHash, evidenceHash: sha(`evidence-${index}`),
    ...(index === 1 ? { admissionId: 'author-continue:old' } : {}) })
  const raw = '{"findings":[]}'
  const metrics = (index: number) => ({ contentHash: sha(bundle.chapter.content), qualityContextHash: contextHash, independentCheck: 'unavailable',
    criticResponse: { version: 1, classification: index === 2 ? 'source_invalid' : 'incomplete_json', contentHash: sha(raw), characterCount: raw.length,
      ...(index === 2 ? { rawResponse: { encoding: 'json-string', complete: true, content: JSON.stringify(raw) } } : {}) },
    formatRecovery: index === 2 ? { ...link(1), state: 'failed' } : { ...link(index), state: 'claimed', claimRunId: oldRun,
      ...(index === 1 ? { claimedAt: time(3000).toISOString() } : {}) },
    ...(index === 1 ? { formatRecoveryHistory: [{ ...link(0), state: 'failed', claimedAt: time(2001).toISOString() }] } : {}) })
  for (let index = 0; index < 3; index++) await prisma.chapterQualityReport.create({ data: { id: ids[index], userId: f.userId,
    novelId: f.novelId, runId: index === 0 ? f.runId : oldRun, compilationId: compilation.id, chapterId: f.chapterId, chapterRevision: 1,
    mode: 'premium', status: 'failed', criticVersion: HUMANITY_CRITIC_VERSION, deterministicMetrics: json(metrics(index)),
    createdAt: time(index * 2000), updatedAt: time(index === 0 ? 1000 : index === 1 ? 3000 : 4000) } })
  for (const offset of [1500, 3500]) await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
    targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'chat', modelName: 'fixture',
    action: 'agent3HumanityFormatRecovery', requestTokens: 10, responseTokens: 5, usageSource: 'reported', billingStatus: 'settled',
    billingEvidence: { responseObserved: true }, durationMs: 100, createdAt: time(offset) } })
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused' } })
  await deleteLoopSessionMessage(f.userId, f.sessionId, message.id)
  expect(await prisma.agentRun.findUnique({ where: { id: oldRun } })).toBeNull()
  expect(await prisma.agentRunEvent.count({ where: { runId: oldRun } })).toBe(0)
  expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: ids[2] } })).toMatchObject({ runId: null })
  const runId = randomUUID()
  const request = withHumanAdmission({ sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build', prompt: '继续',
    modelTier: 'speed', qualityMode: 'premium', creativeFreedom: 'balanced', attachments: [] })
  await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
    status: 'queued', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: json(f.spec), startRequest: json(request) } })
  const authored = await prisma.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '继续' }] } })
  return { subject: { ...f, runId }, ids, oldRun, authored, compilationId: compilation.id, metrics, time }
}

describe.runIf(available)('quality continuation after actual conversation deletion', () => {
  it.each(['single', 'returned-correction'] as const)('%s closes settled historical claims and reserves only the new authored admission', async mode => fixture(async f => {
    const s = await seed(f), before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    if (mode === 'returned-correction') {
      const { id: _id, ...copy } = before.find(item => item.createdAt.getTime() === s.time(3500).getTime())!
      const extra = await prisma.aiUsageLog.create({ data: { ...copy, action: 'agent3HumanityEvidenceCorrection', createdAt: s.time(3800),
        billingEvidence: json(copy.billingEvidence), billingSnapshot: Prisma.JsonNull } })
      before.push(extra); before.sort((a, b) => a.id.localeCompare(b.id))
      await prisma.chapterQualityReport.update({ where: { id: s.ids[2] }, data: { deterministicMetrics: json({ ...s.metrics(2),
        criticResponse: { ...s.metrics(2).criticResponse, evidenceCorrection: qualityCorrectionResponseWitness('{"corrections":[]}') } }) } })
    }
    const recovery = await prisma.$transaction(tx => readQualityFormatRecovery(tx, s.subject))
    expect(recovery).toMatchObject({ reportId: s.ids[2], chapterRevision: 1, admissionId: `author-message:${s.authored.id}` })
    expect(await prisma.$transaction(tx => claimQualityFormatRecovery(tx, s.subject, recovery!))).toBe(true)
    expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, s.subject))).toBeNull()
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
    expect(await prisma.agentRun.findUnique({ where: { id: s.oldRun } })).toBeNull()
  }))
  it.each(['unknown', 'duplicate-payment', 'missing-terminal', 'tampered-response', 'foreign-task', 'no-author', 'correction-timeout'] as const)(
    '%s cannot turn deletion into a fresh paid retry', async scenario => fixture(async f => {
      const s = await seed(f)
      if (scenario === 'unknown') await prisma.aiUsageLog.updateMany({ where: { userId: f.userId }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
      if (scenario === 'duplicate-payment') {
        const paid = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId }, orderBy: { createdAt: 'desc' } })
        const { id: _id, ...copy } = paid
        await prisma.aiUsageLog.create({ data: { ...copy, billingEvidence: json(copy.billingEvidence), billingSnapshot: Prisma.JsonNull } })
      }
      if (scenario === 'missing-terminal') await prisma.chapterQualityReport.update({ where: { id: s.ids[1] }, data: { deterministicMetrics: json({ ...s.metrics(1), formatRecoveryHistory: [] }) } })
      if (scenario === 'tampered-response') await prisma.chapterQualityReport.update({ where: { id: s.ids[2] }, data: { deterministicMetrics: json({ ...s.metrics(2), criticResponse: { ...s.metrics(2).criticResponse, rawResponse: { complete: true, encoding: 'json-string', content: '"tampered"' } } }) } })
      if (scenario === 'foreign-task') await prisma.agentRun.update({ where: { id: s.subject.runId }, data: { taskSpec: json({ ...f.spec, id: randomUUID() }) } })
      if (scenario === 'no-author') await prisma.agentMessage.delete({ where: { id: s.authored.id } })
      if (scenario === 'correction-timeout') {
        const { id: _id, ...copy } = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId }, orderBy: { createdAt: 'desc' } })
        await prisma.aiUsageLog.create({ data: { ...copy, action: 'agent3HumanityEvidenceCorrection', createdAt: s.time(3800),
          billingEvidence: json(copy.billingEvidence), billingSnapshot: Prisma.JsonNull } })
      }
      expect(await prisma.$transaction(tx => readQualityFormatRecovery(tx, s.subject))).toBeNull()
    }))
  it.each(['settled', 'unknown'] as const)('%s correction after orphan recovery does not create another permanent ban or replay', async mode => fixture(async f => {
    const s = await seed(f)
    const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
      multiplierBps: 10000, reasoningEffort: 'low' as const, reasoningEfforts: ['none', 'low'] as Array<'none' | 'low'>,
      reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: credits.getCreditWindow().startedAt, periodEndsAt: credits.getCreditWindow().endsAt } })
    await prisma.agentRun.update({ where: { id: s.subject.runId }, data: { status: 'running' } })
    const sources = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 1 }, '原文')
    const findings = ['explanation_echo', 'emotion_grounding', 'character_voice', 'description_load', 'sentence_homology'].map((signal, index) => ({
      signal, severity: 'advisory', sourceId: index === 4 ? 'bad-source' : sources.entries[0].id, explanation: `意见${index}`, suggestion: `建议${index}` }))
    let requests = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests++
      if (requests === 2 && mode === 'unknown') throw new Error('synthetic unknown correction')
      const content = requests === 1 ? JSON.stringify({ findings }) : requests === 2 ? '{"corrections":[]}' : '{"findings":[]}'
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }))
    const ctx: ToolContext = { ...s.subject, callId: 'new-check', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {} }
    await prisma.agentRunEvent.create({ data: { runId: ctx.runId, seq: 1, type: 'tool.call', payload: { toolName: 'quality_analyze', callId: ctx.callId, args: { compilationId: s.compilationId } } } })
    const checking = qualityAnalyzeTool.execute(ctx, { compilationId: s.compilationId })
    if (mode === 'unknown') await expect(checking).rejects.toThrow()
    else expect(await checking).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_EVIDENCE_UNLOCATED' })
    await prisma.agentRunEvent.create({ data: { runId: ctx.runId, seq: 2, type: 'tool.result', payload: { toolName: 'quality_analyze', callId: ctx.callId, ok: false,
      failureCode: mode === 'unknown' ? 'AI_PROVIDER_UNAVAILABLE' : 'QUALITY_EVIDENCE_UNLOCATED' } } })
    const failed = await prisma.chapterQualityReport.findFirstOrThrow({ where: { runId: ctx.runId }, include: { findings: true }, orderBy: { createdAt: 'desc' } })
    expect(failed).toMatchObject({ status: 'failed', deterministicMetrics: { independentCheck: 'unavailable', unlocatedFindings: 1, droppedFindings: 0 } })
    expect(failed.findings.filter(item => item.source === 'critic')).toHaveLength(4)
    const stopped = await prisma.agentRunEvent.create({ data: { runId: ctx.runId, seq: 3, type: 'run.paused', payload: {} } })
    await prisma.agentRunEvent.create({ data: { runId: ctx.runId, seq: 4, type: 'run.started', payload: { authorContinue: { eventId: stopped.id, afterSeq: 3 } } } })
    const recovery = await prisma.$transaction(tx => readQualityFormatRecovery(tx, s.subject))
    if (mode === 'unknown') expect(recovery).toBeNull()
    else {
      expect(recovery).toMatchObject({ reportId: failed.id })
      expect((await qualityAnalyzeTool.execute({ ...ctx, callId: 'author-check' }, { compilationId: s.compilationId })).outcome).toBeUndefined()
    }
    expect(requests).toBe(mode === 'unknown' ? 2 : 3)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
  }))
})

describe.runIf(available).each(['clean', 'pending-decision'] as const)('typed continue passes inherited restrictions through the real loop: %s', scenario => {
  let f: Parameters<Parameters<typeof fixture>[0]>[0], seeded: Awaited<ReturnType<typeof seed>>
  let release: () => void, cleanup: Promise<void>
  beforeAll(async () => {
    let ready: () => void, reject: (error: unknown) => void
    const admitted = new Promise<void>((resolve, fail) => { ready = resolve; reject = fail })
    const held = new Promise<void>(resolve => { release = resolve })
    cleanup = fixture(async value => { f = value; seeded = await seed(f, true); ready(); await held })
    cleanup.catch(error => reject(error))
    await admitted
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 1000,
      runStartedAt: Date.now() - 60000, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [], stagnantBatches: 0,
      inheritedTokens: 0, inheritedTurns: 0, reviewAttempts: [`${seeded.compilationId}:${f.chapterId}:1:quality_analyze`],
      toolRestrictions: [{ action: 'quality_analyze', target: seeded.compilationId, code: 'QUALITY_REPORT_INCOMPLETE', reason: '旧报告不完整' },
        { action: 'chapter_bridge_commit', target: seeded.compilationId, code: 'REVIEW_DEPENDENCY_UNAVAILABLE', reason: '检查未完成' }] }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { startedAt: new Date(Date.now() - 60000), currentTurn: 2, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, checkpoint } } })
    await prisma.agentRun.update({ where: { id: seeded.subject.runId }, data: { taskSpec: Prisma.DbNull } })
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: credits.getCreditWindow().startedAt, periodEndsAt: credits.getCreditWindow().endsAt } })
  })
  afterAll(async () => { release?.(); await cleanup })
  it('executes the new quality check and commits current chapter without another manual continue', async () => {
    const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
      multiplierBps: 10000, reasoningEffort: 'low' as const, reasoningEfforts: ['none', 'low'] as Array<'none' | 'low'>,
      reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(sessionTitle, 'autoNameSession').mockResolvedValue(undefined)
    const feature = featureFlags.isAgent2FeatureEnabled
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)), revision = body.messages[0].content.includes('局部修订编辑')
      expect(body.reasoning_effort).toBe('none')
      const content = revision ? '{"patches":[]}' : scenario === 'clean' ? '{"findings":[]}' : JSON.stringify({ findings: [{ sourceId: JSON.parse(String(init.body)).messages[1].content.match(/q[a-f0-9]{12}(?:[a-f0-9]{52})?/)[0], signal: 'emotion_grounding', severity: 'advisory', explanation: '合成审美意见', suggestion: '补充动作' }] })
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const revisionErrors: string[] = [], generate = aiService.generateTextCompletion
    vi.spyOn(aiService, 'generateTextCompletion').mockImplementation(async (...args) => {
      try { return await generate(...args) } catch (error) { revisionErrors.push(String(error)); throw error }
    })
    let turn = 0
    vi.spyOn(aiService, 'chatWithTools').mockImplementation(async () => {
      turn++
      const calls = turn === 1 ? [
        { id: 'quality-batch', name: 'quality_analyze', arguments: JSON.stringify({ compilationId: seeded.compilationId }) },
        { id: 'early-commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId: seeded.compilationId }) },
        { id: 'independent-read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
      ] : []
      if (scenario === 'pending-decision' && turn === 2) {
        const report = await prisma.chapterQualityReport.findFirstOrThrow({ where: { runId: seeded.subject.runId }, include: { findings: true }, orderBy: { createdAt: 'desc' } })
        calls.push({ id: 'writer-decision', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '原文',
          retainedFindings: report.findings.map(finding => ({ source: 'quality', reportId: report.id, findingId: finding.id, reason: '此处有意简短，增添动作会改变作者明确保留的停顿。' })) }) },
          { id: 'decided-commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId: seeded.compilationId }) })
      }
      return { content: calls.length ? '' : '本章检查及终态已提交。', reasoning: '', finishReason: calls.length ? 'tool_calls' : 'stop',
        toolCalls: calls,
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...seeded.subject, mode: 'build', prompt: '继续', modelTier: 'speed', qualityMode: 'premium', creativeFreedom: 'stable' })
    expect(revisionErrors).toEqual([])
    const results = await prisma.agentRunEvent.findMany({ where: { runId: seeded.subject.runId, type: 'tool.result' }, orderBy: { seq: 'asc' } })
    expect(results.map(event => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'quality_analyze', ok: true }), expect.objectContaining({ toolName: 'chapter_bridge_commit', ok: true })]))
    if (scenario === 'pending-decision') {
      const calls = await prisma.agentRunEvent.findMany({ where: { runId: seeded.subject.runId, type: 'tool.call' }, orderBy: { seq: 'asc' } })
      expect(calls.map(event => (event.payload as { callId: string }).callId)).toContain('independent-read')
      expect(results.find(event => (event.payload as { callId: string }).callId === 'early-commit')?.payload).toMatchObject({ ok: false, durationMs: 0, summary: expect.stringContaining('未执行') })
      const writer = calls.find(event => (event.payload as { callId: string }).callId === 'writer-decision')!
      const commit = calls.find(event => (event.payload as { callId: string }).callId === 'decided-commit')!
      expect(writer.seq).toBeLessThan(commit.seq)
    }
    expect(fetchMock).toHaveBeenCalledTimes(scenario === 'clean' ? 1 : 3)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: seeded.subject.runId } })).toMatchObject({ status: 'completed',
      usage: { checkpoint: { inheritedTokens: 30, inheritedTurns: 2 } } })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: seeded.compilationId } })).toMatchObject({ status: 'completed' })
  })
})
