import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
const execution = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => {}))
const creditAccess = vi.hoisted(() => vi.fn(async () => {}))
const modelRuntime = vi.hoisted(() => vi.fn(async () => ({ reasoningEffort: 'high' })))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: execution }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: creditAccess, getModelTierRuntime: modelRuntime }))
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { readReviewReceiptWait } from '../../api/lib/agent/review-resume-readiness.js'
import { readReviewRequestRecovery } from '../../api/lib/agent/review-request-recovery.js'

describe.runIf(available)('owned Continue receipt preflight with real persisted requests', () => {
  it.each(['two-rejected', 'rejected-before-settled', 'missing-proof', 'wrong-window', 'foreign-owner', 'duplicate-id', 'wrong-body'] as const)(
    'authenticates historical zero-terminal requests separately: %s', async scenario => fixture(async f => {
      const base = Date.now() - 2000, at = (offset: number) => new Date(base + offset)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const contentHash = createHash('sha256').update(chapter.content).digest('hex')
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, createdAt: at(0) } })
      const first = { callId: 'first-refused', toolName: 'quality_analyze' as const, chapterId: f.chapterId, revision: chapter.revision, compilationId: null }
      const current = { ...first, callId: 'next-failed-check' }
      const createUsage = (offset: number, reported: boolean) => prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId,
        chapterId: f.chapterId, agentRunId: f.runId, targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'system', modelName: 'fixture',
        action: 'agent3HumanityCritic', createdAt: at(offset), durationMs: 5, usageSource: reported ? 'reported' : 'prepared',
        billingStatus: reported ? 'settled' : 'provider_rejected', requestTokens: reported ? 10 : null, responseTokens: reported ? 2 : null } })
      const older = await createUsage(scenario === 'wrong-window' ? 500 : 120, false)
      const latest = await createUsage(320, scenario === 'rejected-before-settled')
      try {
        const event = (seq: number, type: string, payload: object, offset: number) => prisma.agentRunEvent.create({ data: {
          runId: f.runId, seq, type, payload: JSON.parse(JSON.stringify(payload)), createdAt: at(offset) } })
        const proof = (usageId: string) => ({ version: 1, chapterId: f.chapterId, revision: chapter.revision, contentHash, usageIds: [usageId] })
        await event(1, 'tool.call', { callId: first.callId, toolName: first.toolName, args: { chapterId: f.chapterId } }, 100)
        await event(2, 'tool.result', { callId: first.callId, toolName: first.toolName, ok: false, failureCode: 'AI_PROVIDER_ERROR',
          ...(scenario === 'missing-proof' ? {} : { reviewRequestFinished: { ...proof(older.id),
            ...(scenario === 'duplicate-id' ? { usageIds: [older.id, older.id] } : {}), ...(scenario === 'wrong-body' ? { contentHash: 'f'.repeat(64) } : {}) } }) }, 200)
        await event(3, 'tool.call', { callId: current.callId, toolName: current.toolName, args: { chapterId: f.chapterId } }, 300)
        await event(4, 'tool.result', { callId: current.callId, toolName: current.toolName, ok: false, failureCode: 'AI_PROVIDER_ERROR', reviewRequestFinished: proof(latest.id) }, 400)
        const pause = await event(5, 'run.paused', { reason: 'needs_input' }, 450)
        await event(6, 'run.started', { authorContinue: { eventId: pause.id, afterSeq: 5 } }, 600)
        if (scenario === 'foreign-owner') {
          const other = await prisma.user.create({ data: { nickname: 'foreign receipt', passwordHash: 'not-a-real-password' } })
          await prisma.aiUsageLog.update({ where: { id: older.id }, data: { userId: other.id } })
          try {
            expect(await prisma.$transaction(tx => readReviewRequestRecovery(tx, f, [first, current]))).toEqual([])
          } finally { await prisma.aiUsageLog.delete({ where: { id: older.id } }); await prisma.user.delete({ where: { id: other.id } }) }
          return
        }
        const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const recovered = await prisma.$transaction(tx => readReviewRequestRecovery(tx, f, [current]))
        expect(recovered.map(item => item.callId)).toEqual(['two-rejected', 'rejected-before-settled'].includes(scenario) ? [current.callId] : [])
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
  it.each([
    { outcome: 'reported', observedCounts: false }, { outcome: 'reported', observedCounts: true },
    { outcome: 'provider_rejected', observedCounts: false }, { outcome: 'not_dispatched', observedCounts: false },
  ] as const)('waits idempotently then admits only an authoritative $outcome receipt, observedCounts=$observedCounts', async ({ outcome, observedCounts }) => fixture(async f => {
    execution.mockClear(); creditAccess.mockClear(); modelRuntime.mockClear()
    const base = Date.now() - 3000, at = (offset: number) => new Date(base + offset)
    const callId = 'original-paid-quality'
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const contentHash = createHash('sha256').update(chapter.content).digest('hex')
    const pending = { callId, toolName: 'quality_analyze' as const, chapterId: f.chapterId, revision: chapter.revision, compilationId: null }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: base,
      activeExecutionMs: 100, stagnantBatches: 7, resumeCount: 1, compactionCount: 0, maxTurns: 10, tokenBudget: 1000,
      writeProgress: 1, writeBaseline: 0, readProgress: 1, readBaseline: 0, progressSignatures: ['saved-progress'],
      inheritedTokens: 0, inheritedTurns: 0, manualResumeCount: 0, reviewAttempts: ['already-paid'], pendingReviews: [pending] }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null,
      createdAt: at(0), startedAt: at(0), status: 'failed', currentTurn: 4, errorMessage: 'old unconfirmed request',
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, checkpoint } } })
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
      targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'system', providerName: 'fixture',
      modelName: 'fixture', modelTier: 'speed', action: 'agent3HumanityCritic', createdAt: at(1100), durationMs: 50,
      usageSource: observedCounts ? 'reported' : 'unknown', billingStatus: observedCounts ? 'pending_settlement' : 'pending_usage',
      requestTokens: observedCounts ? 10 : null, responseTokens: observedCounts ? 2 : null, reservedCreditMilli: 18023,
      billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }, billingEvidence: { responseObserved: false } } })
    try {
      await prisma.agentRunEvent.createMany({ data: [
        { runId: f.runId, seq: 1, type: 'run.started', createdAt: at(0), payload: {} },
        { runId: f.runId, seq: 2, type: 'tool.call', createdAt: at(1000), payload: { callId, toolName: pending.toolName, args: { chapterId: f.chapterId } } },
        { runId: f.runId, seq: 3, type: 'tool.result', createdAt: at(1200), payload: { callId, toolName: pending.toolName, ok: false,
          failureCode: 'AI_PROVIDER_ERROR', reviewRequestFinished: { version: 1, chapterId: f.chapterId, revision: chapter.revision, contentHash, usageIds: [usage.id] } } },
        { runId: f.runId, seq: 4, type: 'run.paused', createdAt: at(1300), payload: { reason: 'needs_input' } },
      ] })
      const original = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      const eventCount = await prisma.agentRunEvent.count({ where: { runId: f.runId } })
      const messages = await prisma.agentMessage.count({ where: { runId: f.runId } })
      await Promise.all([1, 2, 3].map(() => continueLoopRun(f.userId, f.runId, { modelTier: 'lite', reasoningEffort: 'low' }).then(response => {
        expect(response).toMatchObject({ runId: f.runId, status: 'failed', reviewReceiptWait: { kind: 'waiting_for_original_receipt', checks: ['quality'] } })
        expect(response.eventStartSeq).toBeUndefined()
      })))
      expect(execution).not.toHaveBeenCalled(); expect(creditAccess).not.toHaveBeenCalled(); expect(modelRuntime).not.toHaveBeenCalled()
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(original)
      expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toEqual(usage)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
      expect(await prisma.agentRunEvent.count({ where: { runId: f.runId } })).toBe(eventCount)
      expect(await prisma.agentMessage.count({ where: { runId: f.runId } })).toBe(messages)

      // Fixture-only delivery of an authoritative original receipt, never a
      // new provider request or a guessed reconciliation of production usage.
      await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { reservedCreditMilli: 0,
        ...(outcome === 'reported' ? { usageSource: 'reported', billingStatus: 'settled', requestTokens: 10, responseTokens: 2 }
          : { usageSource: outcome === 'provider_rejected' ? 'prepared' : 'unknown', billingStatus: outcome }) } })
      expect(await prisma.$transaction(tx => readReviewReceiptWait(tx, original))).toBeNull()
      const resumed = await continueLoopRun(f.userId, f.runId)
      expect(resumed).toMatchObject({ runId: f.runId, status: 'running', eventStartSeq: 4 })
      expect(resumed.reviewReceiptWait).toBeUndefined()
      expect(execution).toHaveBeenCalledOnce(); expect(creditAccess).toHaveBeenCalledOnce(); expect(modelRuntime).toHaveBeenCalledOnce()
      const args = execution.mock.calls[0][0]
      const admission = args.authorContinue as { eventId: string; afterSeq: number }
      expect(admission.afterSeq).toBe(4)
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'run.started', payload: { authorContinue: admission } } })
      const recovered = await prisma.$transaction(tx => readReviewRequestRecovery(tx, f, [pending]))
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({ callId, reconciliation: { status: 'terminal_failed_billing_known', usageIds: [usage.id],
        admissionId: `author-continue:${admission.eventId}`, currentRevision: chapter.revision, currentContentHash: contentHash } })
      expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).usage).toEqual(original.usage)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
})
