import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { prisma } from '../../api/lib/prisma.js'
import { commitChapterBridge, prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as aiService from '../../api/lib/ai-service.js'

describe.runIf(available)('terminal candidates at the actual transaction boundary', () => {
  it.each(['pending_usage', 'pending_settlement', 'pending_authorization'] as const)('commits current checked prose while preserving an earlier %s request and its ledger', async billingStatus => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const content = '她把信放在桌上，留在门边等待回答。'
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 4 } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '修订本章' })
    const compilationId = compilation.id, candidate = terminalCandidateSchema.parse({ exitState: {} })
    await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '等待回答', entryState: candidate.exitState, goal: '获得回应', obstacle: '屋里无人答话',
      choice: '留在门边', cost: '时间', turn: '放下信件', exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const pending = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId,
      targetType: 'agentRun', targetId: f.runId, providerType: 'text', providerMode: 'builtin', modelName: 'synthetic-model', action: 'agentLoopTurn',
      modelTier: 'speed', multiplierBps: 10000, creditChargeMilli: 0, reservedCreditMilli: 123, billingStatus,
      usageSource: billingStatus === 'pending_settlement' ? 'reported' : 'unknown',
      requestTokens: billingStatus === 'pending_settlement' ? 10 : null, responseTokens: billingStatus === 'pending_settlement' ? 2 : null,
      billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }, durationMs: 10 } })
    const ledgerBefore = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    await persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: 4 })
    const terminal = { ...f, compilationId, chapterSummary: '她放下信件，等待回答。', ...candidate,
      hookDecision: '', delayedHookReason: '', openingStructure: '放信', endingStructure: '等待', expectedChapterRevision: 4 }
    await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
    await persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: 4, mode: 'balanced', criticComplete: true,
      criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const provider = vi.spyOn(aiService, 'generateTextCompletion')
    const first = await commitChapterBridge(terminal)
    expect(first).toMatchObject({ compilationId, chapterId: f.chapterId, chapterRevision: 4 })
    const saved = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })
    expect(saved.committedAt).not.toBeNull()
    expect(await commitChapterBridge(terminal)).toEqual(first)
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toEqual(saved.committedAt)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledgerBefore)
    expect(provider).not.toHaveBeenCalled()
  }, undefined, '修改本章', { freezeWriting: true }))

  it('commits current reports without certifying candidate prose, invalidates changed evidence and preserves cancellation', async () => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const content = '医师确认林舟右掌骨裂，尚未愈合。他留在门口等候。'
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 4 } })
    const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '修订本章' })
    const compilationId = prepared.compilation.id
    const unknown = terminalCandidateSchema.parse({ exitState: {} })
    await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '等候诊治', entryState: unknown.exitState, goal: '治伤', obstacle: '骨裂',
      choice: '等待', cost: '时间', turn: '确认伤情', exitState: unknown.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: 4 })
    await persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: 4, mode: 'balanced', criticComplete: true,
      criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const candidate = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌骨裂'] } })
    const terminal = { ...f, compilationId, chapterSummary: '医师确认伤情。', ...candidate, hookDecision: '', delayedHookReason: '', openingStructure: '诊治', endingStructure: '等待' }
    const baseline = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })
    // Candidate strings are no longer fact certification or a submission gate.
    // Even a mismatched extra string cannot overwrite the existing fact ledger.
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '医师确认林舟右掌没有骨裂。' } })
    await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content } })
    const first = await commitChapterBridge(terminal)
    const committed = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })
    expect(committed.bodyState).toEqual(baseline.bodyState)
    const count = await prisma.projectMemoryEntry.count({ where: { sourceChapterId: f.chapterId } })
    expect(await commitChapterBridge(terminal)).toEqual(first)
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toEqual(committed.committedAt)
    expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: f.chapterId } })).toBe(count)
    await expect(commitChapterBridge({ ...terminal, exitState: { ...candidate.exitState, body: ['林舟双掌骨裂'] } })).resolves.toEqual(first)
    await expect(commitChapterBridge({ ...terminal, ...unknown })).resolves.toEqual(first)
    const corrected = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌骨裂，尚未愈合'] } })
    await commitChapterBridge({ ...terminal, ...corrected })
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).bodyState).toEqual(baseline.bodyState)
    expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: f.chapterId } })).toBe(count)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused' } })
    await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).bodyState).toEqual(baseline.bodyState)
  }, undefined, '修改本章', { freezeWriting: true }))
})
