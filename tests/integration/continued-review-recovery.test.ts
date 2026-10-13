import { describe, expect, it } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { readContinuedReviewRecovery, readAuthorContinuedReviewUsageIds } from '../../api/lib/agent/continued-review-recovery.js'

describe.runIf(available)('ordinary author Continue preserves real unknown billing while retiring only its prior execution slot', () => {
  it.each(['quality', 'continuity', 'no-author', 'post-admission'] as const)('%s uses authenticated PostgreSQL call/admission/input evidence', scenario => fixture(async f => {
    try {
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '原授权章节复核' })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running',
        usage: { totalTokens: 329762, checkpoint: { stagnantBatches: 9, tokenBudget: 500, reviewAttempts: ['original-consumed'] } } } })
      const startAt = new Date(Date.now() + 5000), resultAt = new Date(startAt.getTime() + 1000)
      const toolName = scenario === 'continuity' ? 'continuity_validate' as const : 'quality_analyze' as const
      const pending = { compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName, callId: 'exact-prior-call' }
      const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: new Date(resultAt.getTime() + 10), payload: {} } })
      if (scenario !== 'no-author') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started',
        createdAt: new Date(resultAt.getTime() + 1000), payload: { authorContinue: { eventId: pause.id, afterSeq: 3 } } } })
      const delta = scenario === 'post-admission' ? 2000 : 0
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: delta ? 5 : 1, type: 'tool.call', createdAt: new Date(startAt.getTime() + delta),
        payload: { callId: pending.callId, toolName, args: { chapterId: f.chapterId, compilationId: compilation.id } } } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: delta ? 6 : 2, type: 'tool.result', createdAt: new Date(resultAt.getTime() + delta),
        payload: { callId: pending.callId, toolName, ok: false, failureCode: 'AI_PROVIDER_TRANSPORT' } } })
      const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
        providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider', modelTier: 'standard', multiplierBps: 12000,
        action: toolName === 'quality_analyze' ? 'agent3HumanityCritic' : 'agent3ContinuityCritic', requestTokens: null, responseTokens: null,
        usageSource: 'unknown', billingStatus: 'pending_usage', creditChargeMilli: 0, reservedCreditMilli: 18023, durationMs: 0,
        billingSnapshot: { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }, createdAt: new Date(startAt.getTime() + delta + 100) } })
      const beforeUsage = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })
      const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      const recovered = await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, [pending]))
      expect(recovered).toHaveLength(['quality', 'continuity'].includes(scenario) ? 1 : 0)
      if (recovered.length) {
        const first = recovered[0]
        expect(first.receipt).toMatchObject({ status: 'author_continued_review', usageOutcome: 'unknown_preserved', usageIds: [usage.id],
          sourceCallId: pending.callId, taskId: f.spec.id })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'review.reconciled', createdAt: new Date(resultAt.getTime() + 1100),
          payload: JSON.parse(JSON.stringify({ callId: pending.callId, chapterId: pending.chapterId, compilationId: pending.compilationId, revision: 1, receipt: first.receipt })) } })
        expect(await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, []))).toEqual([{ ...first, persisted: true }])
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 2, content: '真实保存的修订正文' } })
        expect(await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, []))).toEqual([])
        expect(await prisma.$transaction(tx => readAuthorContinuedReviewUsageIds(tx, f))).toEqual(new Set([usage.id]))
      }
      expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toEqual(beforeUsage)
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(beforeRun)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
})
