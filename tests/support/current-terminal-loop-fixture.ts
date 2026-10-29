import { expect, vi } from 'vitest'
import { currentReviewRepairResponse } from './current-review-repair-response.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { recordStoryCompilerWrite } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { readContinuityReport } from '../../api/lib/agent/continuity-review.js'
import { activeChapterScope } from '../../api/lib/data/internal.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import { persistCurrentContinuityReport } from './current-continuity-report.js'

type Subject = { userId: string; novelId: string; sessionId: string; runId: string; chapterId: string }

/** Synthetic isolated author draft, then real registered handlers and body CAS.
 * Draft setup precedes the loop's current source/protection baseline and is not
 * runtime progress. Provider bytes are synthetic; historical records supplied
 * by the caller remain immutable and grant no execution phase. */
export async function continueCurrentTerminalLoop(f: Subject, input: {
  compilationId: string; prompt: string; afterSeq: number; unknown?: boolean; missingCommit?: boolean; readFirst?: boolean; setupAfterRecovery?: boolean;
  authorContinue?: { eventId: string; afterSeq: number };
}) {
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
  vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
  const feature = flags.isAgent2FeatureEnabled
  if (!vi.isMockFunction(feature)) vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
    multiplierBps: 10000, reasoningEffort: 'high', reasoningEfforts: ['high'], reasoningParameterMode: 'native', thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 })
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live provider calls are forbidden in this fixture'))
  const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  const otherChapters = await prisma.chapter.findMany({ where: { authorId: f.userId, novelId: f.novelId, id: { not: original.id } }, orderBy: { id: 'asc' } })
  // A current, author-owned saved revision contains an independently locatable
  // duplicate action. The critic must see its real source row; the repair must
  // delete that exact second paragraph through the normal quality CAS path.
  const originalSource = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: original.id, chapterRevision: original.revision }, original.content)
  const duplicated = original.content + '\n\n' + originalSource.entries.filter(entry => entry.text.trim()).at(-1)!.text
  if (!input.unknown && !input.missingCommit && !input.setupAfterRecovery) {
    await prisma.chapter.update({ where: { id: original.id }, data: { content: duplicated, wordCount: duplicated.length, revision: { increment: 1 } } })
    await recordStoryCompilerWrite({ ...f, chapterOrderIndex: original.orderIndex, chapterRevision: original.revision + 1 })
  }
  if (input.missingCommit) await persistCurrentContinuityReport({ ...f, compilationId: input.compilationId })
  const account = await prisma.creditAccount.findUnique({ where: { userId: f.userId } })
    ?? await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: credits.getCreditWindow().startedAt, periodEndsAt: credits.getCreditWindow().endsAt } })
  const beforeCharge = account.dailyUsedMilli
  const originalRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
  const originalConfig = { taskSpec: originalRun.taskSpec, modelTier: originalRun.modelTier,
    customModelId: originalRun.customModelId, reasoningEffort: originalRun.reasoningEffort }
  const actions: string[] = []
  const modelFailures: unknown[] = []
  const continuityRequests: Array<{ chapterId: string; revision: number; orderIndex: number; source: string; content: string; evidence: string }[]> = []
  const critic = vi.spyOn(ai, 'generateTextCompletion').mockImplementation(async (_system, content, options) => {
    try {
    options.signal?.throwIfAborted()
    expect(options).toMatchObject({ explicitModelSelection: true, userId: f.userId, agentRunId: f.runId,
      modelRuntime: { tier: 'speed', provider: 'fixture', modelName: 'fixture', multiplierBps: 10000,
        reasoningEffort: 'high', reasoningParameterMode: 'native', thinkingEnabled: true } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    actions.push(options.action)
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
      action: options.action, targetType: 'story_compilation', targetId: input.compilationId, providerType: 'text', providerMode: 'custom',
      modelName: 'fixture', modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled',
      reservedCreditMilli: 0, creditChargeMilli: 7, durationMs: 0, billingEvidence: { responseObserved: true } } })
    await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: { increment: 7 } } })
    await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: usage.id,
      idempotencyKey: `current-recovery:${usage.id}`, deltaMilli: -7, dailyDeltaMilli: -7, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } })
    const trace = beginTextRequest(usage.id).record
    trace.status = 'terminal'; trace.billingKnown = true
    if (options.action === 'agent3HumanityCritic') {
      const source = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: chapter.id, chapterRevision: chapter.revision }, chapter.content)
      const repeated = chapter.content === duplicated ? source.entries.filter(entry => entry.text.trim()).at(-1) : null
      if (repeated) expect(content).toContain(repeated.id.slice(0, 13))
      return JSON.stringify({ findings: repeated ? [{ signal: 'explanation_echo', severity: 'warning', sourceId: repeated.id.slice(0, 13),
        explanation: 'This paragraph repeats the saved action without a new event.', suggestion: 'Remove this duplicate paragraph and retain the original action.', confidence: 0.99 }] : [] })
    }
    if (options.action === 'agent3HumanityRevision') {
      const findings = JSON.parse(content.slice(content.lastIndexOf('\n[') + 1)) as Array<{ findingId: string; evidence: string; start: number; end: number }>
      return currentReviewRepairResponse(original.content, duplicated, chapter.content, findings)
    }
    if (options.action === 'agent3ContinuityCritic') {
      const request = JSON.parse(content) as { authorRequest: string; currentChapter: string; sources: typeof continuityRequests[number] }
      const previous = await prisma.chapter.findMany({ where: { authorId: f.userId, ...activeChapterScope(f.novelId), orderIndex: { lt: chapter.orderIndex } },
        orderBy: { orderIndex: 'desc' }, take: 3 })
      expect(request).toMatchObject({ authorRequest: input.prompt, currentChapter: chapter.id })
      expect(request.sources.map(({ chapterId, revision, orderIndex, source, content }) => ({ chapterId, revision, orderIndex, source, content })))
        .toEqual([chapter, ...previous].map(row => ({ chapterId: row.id, revision: row.revision, orderIndex: row.orderIndex,
          source: row.id === chapter.id ? 'current' : 'previous', content: row.content })))
      for (const source of request.sources) {
        const table = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: source.chapterId, chapterRevision: source.revision }, source.content)
        for (const entry of table.entries.filter(entry => entry.text.trim())) expect(source.evidence).toContain(entry.id.slice(0, 13))
      }
      continuityRequests.push(request.sources)
      return '{"findings":[]}'
    }
    throw new Error('Unexpected auxiliary request: ' + options.action)
    } catch (error) { modelFailures.push(error); throw error }
  })
  const summary = input.missingCommit ? '当前任务没有提交权限，正文与历史检查原件保留，尚未完成提交。' : '已删除重复动作，最终版本已完成两项检查并实际提交。'
  const calls: string[] = []
  const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async request => {
    try {
    expect(request).toMatchObject({ model: 'fixture', provider: 'fixture', reasoningEffort: 'high', reasoningParameterMode: 'native', thinkingEnabled: true, usageLog: {
      userId: f.userId, agentRunId: f.runId, modelTier: 'speed', multiplierBps: 10000 } })
    const last = [...request.messages].reverse().find(message => message.role === 'tool')
    let next: string | undefined
    let nextArgs: Record<string, unknown> | undefined
    let retainedFindings: Array<{ source: 'quality' | 'continuity'; reportId: string; findingId: string; reason: string }> | undefined
    if (input.missingCommit) return { content: summary, reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    if (!last || !calls.length) {
      if (input.setupAfterRecovery) {
        const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        expect((saved.usage as { checkpoint?: { pendingReviews?: unknown[] } } | null)?.checkpoint?.pendingReviews ?? []).toEqual([])
        expect(await prisma.agentRunEvent.findFirst({ where: { runId: f.runId, seq: { gt: input.afterSeq }, type: 'review.reconciled' } })).not.toBeNull()
        next = 'chapter_read'; nextArgs = { chapterId: f.chapterId }
      } else next = input.readFirst ? 'chapter_bridge_get' : 'quality_analyze'
    }
    else if (last.toolCallId === 'current-recovery-chapter_read' && input.setupAfterRecovery) {
      expect(last.content).toContain(original.content)
      next = 'chapter_edit_range'; nextArgs = { chapterId: f.chapterId, oldText: original.content, newText: duplicated }
    } else if (last.toolCallId === 'current-recovery-chapter_edit_range' && input.setupAfterRecovery) {
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: duplicated, revision: original.revision + 1 })
      next = 'quality_analyze'
    }
    else if (last.toolCallId === 'current-recovery-chapter_bridge_get') next = 'quality_analyze'
    else if (last.toolCallId === 'current-recovery-quality_analyze') {
      expect(last.content).toContain('修订')
      next = 'continuity_validate'
    } else if (last.toolCallId === 'current-recovery-continuity_validate') {
      expect(last.content).toContain('报告')
      next = 'chapter_bridge_commit'
    } else {
      expect(['current-recovery-chapter_bridge_commit', 'current-recovery-retained-commit']).toContain(last.toolCallId)
      expect(last.content).toContain('提交')
      const raw = String(last.content).split('当前真实意见：')[1]
      if (raw) {
        let details: Array<{ source: 'quality' | 'continuity'; reportId: string; findingId: string }> | undefined
        for (let end = raw.indexOf(']'); end >= 0; end = raw.indexOf(']', end + 1)) {
          try { details = JSON.parse(raw.slice(0, end + 1)); break } catch { /* Read only the real returned array. */ }
        }
        expect(details?.length).toBeGreaterThan(0)
        retainedFindings = details!.map(({ source, reportId, findingId }) => ({ source, reportId, findingId,
          reason: '保留这项实际报告建议：本次只删除明确重复动作，保留其余叙事节奏，供作者继续判断；未声称该建议已修复。' }))
        next = 'chapter_bridge_commit'
      }
    }
    if (next) calls.push(next)
    return { content: next ? '' : summary, reasoning: '', toolCalls: next ? [{ id: retainedFindings ? 'current-recovery-retained-commit' : `current-recovery-${next}`, name: next,
      arguments: JSON.stringify(nextArgs ?? { compilationId: input.compilationId, ...(retainedFindings ? { retainedFindings } : {}) }) }] : [], finishReason: next ? 'tool_calls' : 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    } catch (error) { modelFailures.push(error); throw error }
  })
  await executeAgentRun({ ...f, prompt: input.prompt, mode: 'build', resume: true, eventStartSeq: input.afterSeq,
    ...(input.authorContinue ? { authorContinue: input.authorContinue } : {}), modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
  if (modelFailures.length) throw modelFailures[0]
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: input.compilationId }, include: { bridge: true } })
  const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { gt: input.afterSeq } }, orderBy: { seq: 'asc' } })
  expect(run).toMatchObject(originalConfig)
  expect(await prisma.chapter.findMany({ where: { authorId: f.userId, novelId: f.novelId, id: { not: original.id } }, orderBy: { id: 'asc' } })).toEqual(otherChapters)
  expect(network).not.toHaveBeenCalled()
  network.mockRestore()
  if (input.unknown) {
    expect(critic).not.toHaveBeenCalled(); expect(main).not.toHaveBeenCalled()
    expect(chapter).toEqual(original); expect(compilation.bridge!.committedAt).toBeNull()
    expect(run.status).toBe('paused')
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(beforeCharge)
  } else if (input.missingCommit) {
    expect(critic).not.toHaveBeenCalled(); expect(chapter).toEqual(original)
    expect(compilation.bridge!.committedAt).toBeNull(); expect(run.status).toBe('failed')
    expect(run.errorMessage).toContain('当前授权章节尚无与最新正文和检查报告一致的提交回执')
    expect(events.some(event => event.type === 'error' && (event.payload as { code: string; message: string }).code === 'run_failed'
      && (event.payload as { message: string }).message === run.errorMessage)).toBe(true)
    expect(events.filter(event => event.type === 'tool.call')).toEqual([])
  } else {
    expect(chapter.revision).toBe(original.revision + 2)
    expect(chapter.content.trim()).toBe(original.content.trim())
    const repairRequests = critic.mock.calls.filter(([, , options]) => options.action === 'agent3HumanityRevision')
    expect(repairRequests.length).toBeGreaterThan(0)
    for (const [, , options] of repairRequests) expect(options).toMatchObject({ targetType: 'quality_report', targetId: expect.any(String) })
    expect(new Set(repairRequests.map(([, , options]) => options.targetId)).size).toBe(repairRequests.length)
    const repairs = events.flatMap(event => {
      const payload = event.payload as { toolName?: string; display?: { appliedBodyChange?: unknown } }
      return event.type === 'tool.result' && payload.toolName === 'quality_analyze' && payload.display?.appliedBodyChange ? [payload.display.appliedBodyChange] : []
    })
    expect(repairs).toEqual([expect.objectContaining({ chapterId: chapter.id, sourceRevision: original.revision + 1,
      targetRevision: chapter.revision, before: duplicated, after: chapter.content })])
    expect(continuityRequests).toHaveLength(1)
    expect(run.status).toBe('completed'); expect(compilation.bridge!.committedAt).not.toBeNull()
    const prefix = input.setupAfterRecovery ? ['chapter_read', 'chapter_edit_range'] : input.readFirst ? ['chapter_bridge_get'] : []
    expect(calls.slice(0, prefix.length + 3)).toEqual([...prefix, 'quality_analyze', 'continuity_validate', 'chapter_bridge_commit'])
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, input.compilationId))
    expect(readiness).toMatchObject({ ready: true, revision: chapter.revision, quality: 'complete', continuity: 'complete', terminalCommitted: true, decisionPending: false })
    const finalContinuity = readContinuityReport(compilation.validation, chapter)
    expect(finalContinuity).toMatchObject({ complete: true, billingKnown: true, revision: chapter.revision })
    expect(finalContinuity?.rawResponses).toEqual(['{"findings":[]}'])
    expect(finalContinuity?.usageIds).toHaveLength(1)
    const finalQuality = await prisma.chapterQualityReport.findFirstOrThrow({ where: { userId: f.userId, chapterId: chapter.id, chapterRevision: chapter.revision }, orderBy: { createdAt: 'desc' } })
    expect(finalQuality.deterministicMetrics).toMatchObject({ independentCheck: 'complete' })
    expect(compilation.bridge).toMatchObject({ toChapterId: chapter.id, targetRevision: chapter.revision })
    expect(await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))).toMatchObject({ chapters: [{ id: chapter.id, revision: chapter.revision, content: chapter.content }] })
    expect(events.filter(event => event.type === 'tool.result' && (event.payload as { toolName: string; ok: boolean }).toolName === 'chapter_bridge_commit'
      && (event.payload as { ok: boolean }).ok)).toHaveLength(1)
    expect(events.some(event => event.type === 'text.final' && (/只输出标题和正文/u.test(input.prompt)
      ? (event.payload as { text: string }).text.includes(chapter.content.trim()) : (event.payload as { text: string }).text === summary))).toBe(true)
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(beforeCharge + actions.length * 7)
  }
  return { run, chapter, compilation, events, actions, main, critic, continuityRequests }
}
