import { createHash } from 'node:crypto'
import { persistCurrentContinuityReport, continuityOpinionsFromSourceQuotes } from '../support/current-continuity-report.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { describe, expect, it, vi } from 'vitest'
import { fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { assertChapterManuscriptRevision, readChapterReviewReadiness, readChapterReviewWriteAdmission } from '../../api/lib/agent/chapter-review-guard.js'
import { commitChapterBridge, prepareStoryCompilation, recordStoryCompilerWrite, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readCompletedWritingDelivery } from '../../api/lib/agent/writing-scope.js'
import { readReviewCycle } from '../../api/lib/agent/review-cycle.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { chapterWriteTool, chapterAppendTool, chapterEditRangeTool, preflightChapterReviewWrite } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as aiService from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as sessionTitle from '../../api/lib/agent/session-title.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const prompt = '修改第一章，只要标题和正文。'
const initial = '门锁仍在。屋里没有灯。她没有回答。桌上有书。墙上有钟。窗边有椅。地上有箱。'
const initialEvidence = ['门锁仍在', '屋里没有灯', '她没有回答', '桌上有书', '墙上有钟', '窗边有椅', '地上有箱']
const mandatoryPrompt = '修改第一章，只要标题和正文，质量必须通过后才能交付。'
describe('mandatory quality pass through persisted current warning repair', () => {
  it.each([
    ['legacy', false], ['durable', false], ['legacy', true], ['durable', true],
  ] as const)('repairs a current warning then really commits under %s, repeated evidence=%s', async (protocol, duplicate) => fixture(async f => {
    if (protocol === 'legacy') {
      const spec = structuredClone(f.spec); delete spec.scope.reviewProtocol
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0,
        taskSpec: JSON.parse(JSON.stringify(spec)), startRequest: { prompt: mandatoryPrompt } } })
    }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    expect(original.spec).toMatchObject({ intent: 'revise', scope: { writing: { kind: 'bounded', titleAndBodyOnly: true,
      targets: [{ chapterId: f.chapterId, orderIndex: 1 }] } } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
    const usageCount = await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })
    const body = `门锁仍在。屋里没有灯。灯光落在桌上。${duplicate ? '灯光落在桌上。' : ''}她没有回答。`
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, revision: 4, wordCount: body.length } })
    const prepared = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '修改本章' })
    const compilationId = prepared.compilation.id
    await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '合成场景', entryState: { action: '进屋' },
      goal: '看门锁', obstacle: '灯灭了', choice: '等待', cost: '时间', turn: '她打开灯', exitState: { action: '等待回应' },
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const assess = async (severity?: 'advisory' | 'warning', evidence = '屋里没有灯。', last = false) => {
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      await persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: chapter.revision })
      const sources = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
        chapterRevision: chapter.revision }, chapter.content)
      const selected = sources.entries.filter(entry => entry.text === evidence)
      const source = last ? selected.at(-1) : selected[0]
      if (severity) expect(source).toBeDefined()
      return persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: chapter.revision,
        mode: 'balanced', deterministicMetrics: {}, deterministicFindings: [], criticComplete: true, sources,
        criticFindings: severity ? [{ signal: 'description_load', sourceId: source!.id, quote: source!.text, severity,
          explanation: '合成质量意见', suggestion: '修改这处已定位的正文', confidence: 0.9 }] : [] })
    }
    const mutate = (after: string, ranges?: Array<{ start: number; end: number; newText: string }>, rollback = false) => prisma.$transaction(async tx => {
      const chapter = await tx.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const callback = await assertChapterManuscriptRevision(tx, f, chapter, { mutation: ranges ? 'range' : 'replace', after, editRanges: ranges })
      expect((await tx.chapter.updateMany({ where: { id: chapter.id, revision: chapter.revision }, data: { content: after,
        wordCount: after.length, revision: { increment: 1 } } })).count).toBe(1)
      await callback?.()
      await recordStoryCompilerWrite({ ...f, chapterId: chapter.id, chapterOrderIndex: 1, chapterRevision: chapter.revision + 1 }, tx)
      if (rollback) throw new Error('synthetic rollback after mandatory-warning CAS')
    })
    await assess('advisory')
    const finalBody = body.replace('屋里没有灯', '屋里灯亮着')
    await mutate(finalBody)
    const warningReport = await assess('warning', '灯光落在桌上。', duplicate)
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))
    expect(readiness).toMatchObject({ ready: true, quality: 'complete', mustPassPending: true, qualityPassRequired: true,
      qualityErrorCount: 0, reviewCycle: { verificationStarted: true, transitionCount: 1 } })
    const warning = warningReport.findings[0]
    const start = duplicate ? finalBody.lastIndexOf(warning.evidenceExcerpt) : finalBody.indexOf(warning.evidenceExcerpt)
    const end = start + warning.evidenceExcerpt.length
    const ranges = [{ start, end, newText: '灯光照着桌面。' }]
    const after = finalBody.slice(0, start) + ranges[0].newText + finalBody.slice(end)
    const proposal = { chapterId: f.chapterId, revision: 5, after, editRanges: ranges }
    const admission = () => prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, proposal))
    expect(await admission()).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    const terminal = { ...f, compilationId, chapterSummary: '她进屋等待回应。', lastUnfinishedAction: '等待回应',
      exitState: { action: '等待回应', location: '门口', knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      hookDecision: '', delayedHookReason: '', openingStructure: '进屋', endingStructure: '等待' }
    await expect(commitChapterBridge({ ...terminal, retainedFindings: readiness!.requiredDecisions!.map(ref => ({ ...ref,
      reason: '合成留置理由不能代替原任务明确要求的质量通过。' })) })).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, f))).toBeNull()
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: warningReport.id }, include: { findings: true } }))
      .toMatchObject({ status: 'needs_repair', findings: [expect.objectContaining({ severity: 'warning', disposition: 'pending' })] })
    // Ordinary author-approved edits are not revoked by a review's old anchors.
    // They still require a fresh report before delivery.
    for (const at of [start, end]) expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { ...proposal,
      after: finalBody.slice(0, at) + '新增' + finalBody.slice(at), editRanges: [{ start: at, end: at, newText: '新增' }] })))
      .toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { ...proposal,
      after: after.replace('门锁仍在', '门已打开'), editRanges: undefined }))).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    if (duplicate) {
      expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { ...proposal,
        after: finalBody.replace(warning.evidenceExcerpt, ranges[0].newText), editRanges: undefined }))).toMatchObject({ kind: 'allow', basis: 'original_writing' })
      await prisma.qualityFinding.update({ where: { id: warning.id }, data: { evidenceHash: '0'.repeat(64) } })
      expect(await admission()).toMatchObject({ kind: 'allow', basis: 'original_writing' })
      await prisma.qualityFinding.update({ where: { id: warning.id }, data: { evidenceHash: sha(warning.evidenceExcerpt),
        startOffset: start - 1, endOffset: end - 1 } })
      expect(await admission()).toMatchObject({ kind: 'allow', basis: 'original_writing' })
      await prisma.qualityFinding.update({ where: { id: warning.id }, data: { startOffset: start, endOffset: end } })
    }
    await prisma.chapterQualityReport.update({ where: { id: warningReport.id }, data: { deterministicMetrics: { independentCheck: 'unavailable',
      contentHash: sha(finalBody) } } })
    expect(await admission()).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: false, quality: 'incomplete' })
    await prisma.chapterQualityReport.update({ where: { id: warningReport.id }, data: { deterministicMetrics: {
      independentCheck: 'complete', contentHash: '0'.repeat(64) } } })
    expect(await admission()).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: false, quality: 'incomplete' })
    // A complete report from outside the original task remains outside its grant.
    const earlierOwned = await prisma.chapterQualityReport.findMany({ where: { compilationId, id: { not: warningReport.id }, runId: f.runId }, select: { id: true, runId: true } })
    await prisma.chapterQualityReport.updateMany({ where: { id: { in: earlierOwned.map(report => report.id) } }, data: { runId: null } })
    await prisma.chapterQualityReport.update({ where: { id: warningReport.id }, data: { deterministicMetrics: warningReport.deterministicMetrics!, runId: null } })
    expect(await admission()).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: false, quality: 'missing' })
    await prisma.chapterQualityReport.update({ where: { id: warningReport.id }, data: { runId: f.runId } })
    for (const report of earlierOwned) await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { runId: report.runId } })
    await expect(mutate(after, ranges, true)).rejects.toThrow('synthetic rollback after mandatory-warning CAS')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 5, content: finalBody })
    await mutate(after, ranges)
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: false, quality: 'stale' })
    await persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: 6 })
    await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    const passed = await assess()
    expect(passed).toMatchObject({ status: 'passed', chapterRevision: 6, findings: [] })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: true, mustPassPending: false,
      qualityPassRequired: true, decisionPending: false, qualityErrorCount: 0 })
    expect(await commitChapterBridge({ ...terminal, expectedChapterRevision: 6, expectedContentHash: runtimeJson({ content: after }).hash })).toMatchObject({ chapterRevision: 6 })
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, f))).toMatchObject({ chapters: [{ id: f.chapterId, revision: 6, content: after }] })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
    const cycle = readReviewCycle(saved.preparedContext, { taskId: original.taskId, userId: f.userId, novelId: f.novelId, chapterId: f.chapterId })!
    expect(cycle.transitions.map(step => step.after.revision)).toEqual([5, 6])
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(budget)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(usageCount)
    expect(await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))).toEqual(original)
    expect(await prisma.chapterQualityReport.count({ where: { compilationId } })).toBe(3)
  }, undefined, mandatoryPrompt, { freezeWriting: true }))
})
// This suite deliberately has no availability/skip gate. Its real PostgreSQL
// assertions are required in the same-SHA whole CI, not simulated locally.
describe('legacy review convergence through actual loop and terminal delivery', () => {
  it('preserves author editing after r7→r13 and completes despite six known invalid tool calls', async () => fixture(async f => {
    const spec = structuredClone(f.spec); delete spec.scope.reviewProtocol
    const request = withHumanAdmission({ sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId,
      mode: 'build', prompt, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced', attachments: [] })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0,
      taskSpec: JSON.parse(JSON.stringify(spec)), startRequest: JSON.parse(JSON.stringify(request)), status: 'running' } })
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: initial, revision: 7, wordCount: initial.length } })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
    const prepared = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '修改本章' })
    await saveSceneTasks({ ...f, compilationId: prepared.compilation.id, tasks: [{ purpose: '合成场景', entryState: { action: '进屋' },
      goal: '看门锁', obstacle: '灯灭了', choice: '等待', cost: '时间', turn: '灯光落下', exitState: { action: '等待回应' },
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const assess = async (evidence: string[], severity = 'advisory') => {
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      await persistCurrentContinuityReport({ ...f, compilationId: prepared.compilation.id, expectedChapterRevision: chapter.revision })
      return prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
        compilationId: prepared.compilation.id, chapterId: f.chapterId, chapterRevision: chapter.revision, status: 'needs_repair',
        deterministicMetrics: { independentCheck: 'complete', contentHash: sha(chapter.content) }, findings: { create: evidence.map(text => ({
          userId: f.userId, novelId: f.novelId, signal: 'description_load', source: 'critic', severity,
          startOffset: chapter.content.indexOf(text), endOffset: chapter.content.indexOf(text) + text.length,
          evidenceExcerpt: text, evidenceHash: sha(text), explanation: '合成审美意见', suggestion: '考虑更多动作', confidence: 0.9 })) } }, include: { findings: true } })
    }
    await assess(initialEvidence)
    let body = initial
    for (let i = 0; i < 6; i++) {
      const after = body.replace(i ? `灯光${i}落在桌上` : '屋里没有灯', `灯光${i + 1}落在桌上`)
      await prisma.$transaction(async tx => {
        const chapter = await tx.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const callback = await assertChapterManuscriptRevision(tx, f, chapter, { mutation: 'replace', after })
        expect((await tx.chapter.updateMany({ where: { id: chapter.id, revision: chapter.revision }, data: { content: after, revision: { increment: 1 } } })).count).toBe(1)
        await callback?.()
        await recordStoryCompilerWrite({ ...f, chapterId: chapter.id, chapterOrderIndex: 1, chapterRevision: chapter.revision + 1 }, tx)
      })
      body = after
    }
    const assessedFinal = await assess(['灯光6落在桌上', ...initialEvidence.slice(2)])
    const finalReport = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: assessedFinal.id }, include: { findings: true } })
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f))
    expect(readiness).toMatchObject({ ready: true, decisionPending: false, mustPassPending: false, continuityErrorCount: 0, qualityErrorCount: 0,
      reviewCycle: { verificationStarted: true, baselineRevision: 7, transitionCount: 6 } })
    const ctx: ToolContext = { ...f, chapterId: f.chapterId, callId: 'direct', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} }
    const proposals = [
      { name: 'chapter_edit_range', args: { chapterId: f.chapterId, oldText: '灯光6落在桌上', newText: '灯光洒满桌面' } },
      { name: 'chapter_write', args: { chapterId: f.chapterId, content: body.replace('灯光6落在桌上', '灯光映着桌面') } },
      { name: 'chapter_append', args: { chapterId: f.chapterId, content: '她看了看灯。' } },
    ]
    await persistCurrentContinuityReport({ ...f, compilationId: prepared.compilation.id, focus: 'synthetic-incomplete', independentCheck: 'unavailable', expectedChapterRevision: 13 })
    expect(await preflightChapterReviewWrite(ctx, proposals[0].name, proposals[0].args)).toMatchObject({ kind: 'allow' })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f))).toMatchObject({ ready: false, continuity: 'incomplete' })
    // A complete factual error authorizes its precise current source quote,
    // even when the original corresponding anchor was already attempted.
    await persistCurrentContinuityReport({ ...f, compilationId: prepared.compilation.id, focus: 'synthetic-current-error', opinions: snapshot => continuityOpinionsFromSourceQuotes([{ signal: 'object', severity: 'error',
      evidence: '当前“灯光6落在桌上”与场景已熄灯状态冲突。', suggestion: '把这处灯光改为黑暗。',
      sourceEvidence: [{ source: 'current', quote: '灯光6落在桌上' }] }], snapshot), expectedChapterRevision: 13 })
    expect(await preflightChapterReviewWrite(ctx, 'chapter_edit_range', { chapterId: f.chapterId, oldText: '灯光6落在桌上', newText: '桌上漆黑一片' })).toMatchObject({ kind: 'allow', basis: 'original_writing' })
    await expect(prisma.$transaction(async tx => {
      const chapter = await tx.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const after = body.replace('灯光6落在桌上', '桌上漆黑一片')
      const callback = await assertChapterManuscriptRevision(tx, f, chapter, { mutation: 'replace', after })
      expect((await tx.chapter.updateMany({ where: { id: chapter.id, revision: 13 }, data: { content: after, revision: { increment: 1 } } })).count).toBe(1)
      await callback?.()
      expect((await tx.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).revision).toBe(14)
      throw new Error('synthetic caller rollback after authorized real CAS')
    })).rejects.toThrow('synthetic caller rollback after authorized real CAS')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(13)
    await persistCurrentContinuityReport({ ...f, compilationId: prepared.compilation.id, expectedChapterRevision: 13 })
    for (const proposal of proposals) expect(await preflightChapterReviewWrite(ctx, proposal.name, proposal.args)).toMatchObject({ kind: 'allow' })
    // Each real adapter can apply its original author grant atomically. Caller
    // rollback preserves the actual r13 manuscript and its original reports.
    for (const [index, tool] of [chapterEditRangeTool, chapterWriteTool, chapterAppendTool].entries()) {
      await expect(prisma.$transaction(async tx => {
        const result = await tool.execute({ ...ctx, transaction: tx, callId: `direct-${index}` }, tool.parameters.parse(proposals[index].args) as never)
        expect(result.display).toMatchObject({ kind: 'chapterDiff', revision: 14 })
        expect(await tx.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 14 })
        throw new Error('synthetic author-adapter rollback')
      })).rejects.toThrow('synthetic author-adapter rollback')
    }
    expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { chapterId: f.chapterId, revision: 13, after: body }))).toMatchObject({ basis: 'no_change' })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    const scope = { taskId: original.taskId, userId: f.userId, novelId: f.novelId, chapterId: f.chapterId }
    expect(readReviewCycle(saved.preparedContext, scope)?.transitions.map(step => step.after.revision)).toEqual([8, 9, 10, 11, 12, 13])
    const runtime = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
      multiplierBps: 10000, reasoningEffort: 'low' as const, reasoningEfforts: ['none', 'low'] as Array<'none' | 'low'>,
      reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: credits.getCreditWindow().startedAt, periodEndsAt: credits.getCreditWindow().endsAt } })
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(sessionTitle, 'autoNameSession').mockResolvedValue(undefined)
    const feature = featureFlags.isAgent2FeatureEnabled
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
    const provider = vi.fn(() => { throw new Error('No extra critic or writer request is authorized by this fixture') })
    vi.stubGlobal('fetch', provider)
    let turn = 0
    expect(readiness!.requiredDecisions).toEqual([])
    expect(readiness!.retainedDecisions).toEqual([])
    expect(readiness!.decisionDetails!.filter(item => item.source === 'quality').map(item => item.findingId).sort()).toEqual(finalReport.findings.map(item => item.id).sort())
    vi.spyOn(aiService, 'chatWithTools').mockImplementation(async request => {
      turn++
      const calls = turn === 1
        ? [{ id: 'read-final-opinions', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId: prepared.compilation.id }) }]
        : turn === 2 ? [
        ...Array.from({ length: 6 }, (_, index) => ({ id: `polish-${index}`, name: 'chapter_edit_range',
          arguments: JSON.stringify({ chapterId: f.chapterId, oldText: `absent-anchor-${index}`, newText: '未应用' }) })),
        { id: 'actual-final-commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId: prepared.compilation.id,
          chapterSummary: '她在门口等待回应。' }) },
      ] : []
      if (turn === 2) {
        const observed = request.messages.filter(item => item.role === 'tool').find(item => item.toolCallId === 'read-final-opinions')!
        for (const finding of finalReport.findings) {
          expect(observed.content).toContain(finding.id)
          expect(observed.content).toContain(finding.evidenceExcerpt)
          expect(observed.content).toContain(finding.suggestion)
        }
      }
      return { content: calls.length ? '' : '本章完成。', reasoning: '', finishReason: calls.length ? 'tool_calls' : 'stop', toolCalls: calls,
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'queued' } })
    await executeAgentRun({ ...f, mode: 'build', prompt, modelTier: 'speed', qualityMode: 'balanced', creativeFreedom: 'balanced' })
    expect(turn).toBe(2)
    const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    expect(events.filter(event => event.type === 'tool.result' && String((event.payload as { callId: string }).callId).startsWith('polish-'))).toHaveLength(6)
    expect(events.filter(event => event.type === 'tool.result' && String((event.payload as { callId: string }).callId).startsWith('polish-')).every(event =>
      (event.payload as { ok: boolean }).ok === false)).toBe(true)
    expect(events.filter(event => event.type === 'tool.result').map(event => event.payload)).toContainEqual(expect.objectContaining({ callId: 'actual-final-commit', ok: true }))
    expect(provider).not.toHaveBeenCalled()
    expect(events.filter(event => event.type === 'tool.call' && (event.payload as { toolName: string }).toolName === 'continuity_validate')).toEqual([])
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toMatchObject({ status: 'completed' })
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, f))).toMatchObject({ chapters: [{ id: f.chapterId, revision: 13, content: body }] })
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: finalReport.id }, include: { findings: true } })).toEqual(finalReport)
    expect(finalReport.status).toBe('needs_repair')
    const delivered = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, prepared.compilation.id))
    expect(delivered).toMatchObject({ revision: 13, ready: true, decisionPending: false, terminalCommitted: true, retainedDecisions: [] })
    expect(delivered!.decisionDetails!.filter(item => item.source === 'quality').map(item => ({ findingId: item.findingId, evidence: item.evidence, suggestion: item.suggestion }))).toEqual(
      finalReport.findings.map(item => ({ findingId: item.id, evidence: item.evidenceExcerpt, suggestion: item.suggestion })))
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })).validation).not.toHaveProperty('retainedReviewDecision')
    expect(await prisma.chapterQualityReport.count({ where: { runId: f.runId } })).toBe(2)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(budget)
    expect(await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))).toEqual(original)
  }, undefined, prompt, { freezeWriting: true }))
})
