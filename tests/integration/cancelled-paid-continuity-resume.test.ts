import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { readCancelledReviewRetirements } from '../../api/lib/agent/cancelled-review-recovery.js'
import { buildContinuitySnapshot, readContinuityRequestBilling, reviewContinuity } from '../../api/lib/agent/continuity-review.js'
import { commitChapterBridge, prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('paid continuity cancellation and actual authored resume', () => {
  it('continues after a prior receipt-wait pause, keeps the original bill unknown, checks and really commits the same saved chapter', async () => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const content = '门闩仍锁着。她在门外等待答复。'
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 7 } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'premium', intentSummary: '修订本章' })
    const compilationId = compilation.id
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '等待答复', entryState: state, goal: '获得回应', obstacle: '门仍锁着',
      choice: '留在门外', cost: '时间', turn: '无人应答', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const pending = { toolName: 'continuity_validate' as const, chapterId: f.chapterId, compilationId, revision: 7, callId: 'interrupted-check' }
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: { toolName: pending.toolName,
      callId: pending.callId, args: { chapterId: f.chapterId, compilationId } } } })
    const controller = new AbortController()
    const ctx: ToolContext = { ...f, chapterId: f.chapterId, mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
      callId: pending.callId, signal: controller.signal, emit: () => {} }
    let physicalCalls = 0
    const unknownPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
      rateCardId: 'synthetic-frozen', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
    await expect(reviewContinuity(ctx, { compilationId }, { allowRepair: false, dispatch: async () => {
      physicalCalls++
      await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
        targetType: 'continuity_report', targetId: compilationId, providerType: 'text', providerMode: 'builtin', modelName: 'synthetic-model',
        modelTier: 'speed', multiplierBps: 10000, billingSnapshot: unknownPrice, action: 'agent3ContinuityCritic',
        requestTokens: null, responseTokens: null, usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 16384, durationMs: 0 } })
      controller.abort()
      controller.signal.throwIfAborted()
      throw new Error('unreachable synthetic cancellation')
    } })).rejects.toBeDefined()
    const unknown = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId } })
    const result = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', payload: {
      toolName: pending.toolName, callId: pending.callId, ok: false, failureCode: 'UNEXPECTED_TOOL_ERROR', summary: '已中断' } } })
    const stop = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused',
      createdAt: new Date(result.createdAt.getTime() + 1), payload: { reason: 'user_stop' } } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', createdAt: new Date(stop.createdAt.getTime() + 1),
      payload: { authorContinue: { eventId: stop.id, afterSeq: 3 } } } })
    const oldWait = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'run.paused',
      createdAt: new Date(stop.createdAt.getTime() + 2), payload: { reason: 'review_receipt_pending' } } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 6, type: 'run.started', createdAt: new Date(stop.createdAt.getTime() + 3),
      payload: { authorContinue: { eventId: oldWait.id, afterSeq: 5 } } } })
    const budget = await prisma.agentTaskBudget.findUnique({ where: { taskRootId: f.rootId } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const plans = await prisma.$transaction(tx => readCancelledReviewRetirements(tx, f, [pending]))
    expect(plans).toHaveLength(1)
    expect(plans[0].retirement).toMatchObject({ status: 'cancelled_review', usageOutcome: 'unknown_preserved', usageIds: [unknown.id] })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 7, type: 'review.reconciled', createdAt: new Date(stop.createdAt.getTime() + 4),
      payload: runtimeJson({ ...pending, receipt: plans[0].retirement }).value } })
    const snapshot = await buildContinuitySnapshot(ctx, { compilationId })
    expect(await readContinuityRequestBilling(prisma, ctx, snapshot)).toMatchObject({ known: true, hasRequest: true, usageIds: [], retiredUsageIds: [unknown.id] })
    let currentUsageId = ''
    const dispatch = async () => {
      physicalCalls++
      const current = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
        targetType: 'continuity_report', targetId: compilationId, providerType: 'text', providerMode: 'builtin', modelName: 'synthetic-model',
        action: 'agent3ContinuityCritic', usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 3, durationMs: 1 } })
      currentUsageId = current.id
      return { content: '{"findings":[]}', usageIds: [current.id], billingKnown: true }
    }
    const resumed = { ...ctx, callId: 'continued-check', signal: new AbortController().signal }
    expect(await reviewContinuity(resumed, { compilationId }, { allowRepair: false, dispatch })).toMatchObject({ reviewCompleted: true })
    const checked = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
    expect(checked.validation).toMatchObject({ continuityReport: { complete: true, billingKnown: true, usageIds: [currentUsageId] } })
    await reviewContinuity({ ...resumed, callId: 'cached-check' }, { compilationId }, { allowRepair: false, dispatch })
    expect(physicalCalls).toBe(2)
    await persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: 7, mode: 'premium', criticComplete: true,
      criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    expect(await commitChapterBridge({ ...f, compilationId, chapterSummary: '她留在锁着的门外等待。', exitState: state, lastUnfinishedAction: '',
      hookDecision: '', delayedHookReason: '', openingStructure: '等待', endingStructure: '未获回应', expectedChapterRevision: 7 })).toMatchObject({ chapterRevision: 7 })
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).not.toBeNull()
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: unknown.id } })).toEqual(unknown)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.agentTaskBudget.findUnique({ where: { taskRootId: f.rootId } })).toEqual(budget)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 7, content })
  }, undefined, '修复本章', { freezeWriting: true }))
})
