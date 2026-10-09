import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { readCancelledReviewRetirements } from '../../api/lib/agent/cancelled-review-recovery.js'

describe.runIf(available)('author-exempt cancelled reviewer execution lock', () => {
  it.each(['eligible', 'quality', 'new-body', 'audit-already-persisted', 'no-author', 'not-user-stop', 'wrong-summary', 'missing-result',
    'duplicate-call', 'wrong-chapter', 'wrong-compilation', 'out-of-scope', 'native', 'charged', 'reserved', 'possible-charge',
    'missing-snapshot', 'frozen-charge', 'wrong-tier', 'pending-billing', 'pending-settlement', 'repair-action', 'other-unknown', 'overlap',
    'previous-retired', 'previous-retired-charged', 'previous-retired-missing-audit'] as const)(
    '%s preserves unknown usage and only releases the cancelled exempt lock', scenario => fixture(async f => {
      try {
        const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '原授权章节复核' })
        await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: scenario === 'native' ? f.rootId : null,
          runtimeProtocolVersion: scenario === 'native' ? 1 : 0, status: 'running' } })
        if (scenario === 'out-of-scope') await prisma.agentRun.update({ where: { id: f.runId }, data: {
          taskSpec: JSON.parse(JSON.stringify({ ...f.spec, scope: { ...f.spec.scope, writing: { version: 1, kind: 'bounded', targets: [{ orderIndex: 99, chapterId: null }] } } })) } })
        const start = new Date(Date.now() + 5000), end = new Date(start.getTime() + 1000)
        const toolName = scenario === 'quality' ? 'quality_analyze' as const : 'continuity_validate' as const
        const family = toolName === 'quality_analyze' ? 'agent3Humanity' : 'agent3Continuity'
        const pending = { callId: 'cancelled-check', compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName }
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: start,
          payload: { toolName, callId: pending.callId, args: { chapterId: scenario === 'wrong-chapter' ? 'other' : f.chapterId,
            compilationId: scenario === 'wrong-compilation' ? 'other' : compilation.id } } } })
        const result = scenario === 'missing-result' ? null : await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: end,
          payload: { toolName, callId: pending.callId, ok: false, failureCode: 'UNEXPECTED_TOOL_ERROR', summary: scenario === 'wrong-summary' ? '其他错误' : '已中断' } } })
        const stop = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: new Date(end.getTime() + 10),
          payload: { reason: scenario === 'not-user-stop' ? 'budget' : 'user_stop' } } })
        if (scenario !== 'no-author') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', createdAt: new Date(end.getTime() + 1000),
          payload: { authorContinue: { eventId: stop.id, afterSeq: 3 } } } })
        const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider', modelTier: 'speed',
          action: scenario === 'repair-action' ? `${family}Repair` : `${family}Critic`, requestTokens: null, responseTokens: null, usageSource: 'unknown',
          multiplierBps: scenario === 'possible-charge' ? 1 : 0, creditChargeMilli: scenario === 'charged' ? 1 : 0,
          reservedCreditMilli: scenario === 'reserved' ? 1 : 0,
          billingStatus: scenario === 'pending-billing' ? 'pending_usage' : scenario === 'pending-settlement' ? 'pending_settlement' : 'settled',
          ...(scenario === 'missing-snapshot' ? {} : { billingSnapshot: { version: 'credits-v1-exact', multiplierBps: scenario === 'frozen-charge' ? 1 : 0,
            modelTier: scenario === 'wrong-tier' ? 'other' : 'speed' } }),
          durationMs: 0, createdAt: new Date(start.getTime() + 100) } })
        if (scenario === 'other-unknown') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
          targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'custom', modelName: 'no-provider', action: `${family}Critic`, usageSource: 'unknown', billingStatus: 'pending_usage',
          durationMs: 0, createdAt: new Date(end.getTime() + 100) } })
        if (scenario === 'duplicate-call' || scenario === 'overlap') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 0,
          type: 'tool.call', createdAt: new Date(start.getTime() - 1), payload: { toolName: scenario === 'overlap' ? 'chapter_write' : toolName,
            callId: scenario === 'overlap' ? 'other-call' : pending.callId } } })
        if (scenario === 'new-body') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者修订后的正文', revision: 2 } })
        if (scenario.startsWith('previous-retired')) {
          const oldCall = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: -4, type: 'tool.call', createdAt: new Date(start.getTime() - 3000),
            payload: { toolName, callId: 'old-cancelled', args: { chapterId: f.chapterId, compilationId: compilation.id } } } })
          const oldResult = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: -3, type: 'tool.result', createdAt: new Date(start.getTime() - 2000),
            payload: { toolName, callId: 'old-cancelled', ok: false, failureCode: 'UNEXPECTED_TOOL_ERROR', summary: '已中断' } } })
          const oldStop = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: -2, type: 'run.paused', createdAt: new Date(start.getTime() - 1900), payload: { reason: 'user_stop' } } })
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: -1, type: 'run.started', createdAt: new Date(start.getTime() - 1800), payload: { authorContinue: { eventId: oldStop.id, afterSeq: -2 } } } })
          const priorUsage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
            targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'no-provider', modelTier: 'speed',
            action: `${family}Critic`, requestTokens: null, responseTokens: null, usageSource: 'unknown', multiplierBps: 0,
            creditChargeMilli: scenario === 'previous-retired-charged' ? 1 : 0, reservedCreditMilli: 0, billingStatus: 'settled',
            billingSnapshot: { version: 'credits-v1-exact', multiplierBps: 0, modelTier: 'speed' }, durationMs: 0, createdAt: new Date(oldCall.createdAt.getTime() + 100) } })
          if (scenario !== 'previous-retired-missing-audit') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 0, type: 'review.reconciled', createdAt: new Date(start.getTime() - 1700),
            payload: { callId: 'old-cancelled', chapterId: f.chapterId, revision: 1, compilationId: compilation.id, receipt: {
              status: 'cancelled_review_billing_exempt', usageOutcome: 'unknown_preserved', sourceRunId: f.runId, sourceCallId: 'old-cancelled',
              sourceResultId: oldResult.id, sourceStopEventId: oldStop.id, sourceReportId: null, usageIds: [priorUsage.id], admissionId: `author-continue:${oldStop.id}`,
              currentRevision: 1, currentContentHash: createHash('sha256').update('原文').digest('hex') } } } })
        }
        const beforeUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const beforeCompilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        const read = () => prisma.$transaction(tx => readCancelledReviewRetirements(tx, f, [pending]))
        if (scenario === 'audit-already-persisted') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'review.reconciled',
          createdAt: new Date(end.getTime() + 1100), payload: { callId: pending.callId, chapterId: f.chapterId, revision: 1, compilationId: compilation.id,
            receipt: { status: 'cancelled_review_billing_exempt', usageOutcome: 'unknown_preserved', sourceRunId: f.runId, sourceCallId: pending.callId,
              sourceResultId: result!.id, sourceStopEventId: stop.id, sourceReportId: null, usageIds: [usage.id], admissionId: `author-continue:${stop.id}`,
              currentRevision: 1, currentContentHash: createHash('sha256').update('原文').digest('hex') } } } })
        const recovered = await read()
        expect(recovered).toHaveLength(['eligible', 'quality', 'new-body', 'audit-already-persisted', 'previous-retired'].includes(scenario) ? 1 : 0)
        if (recovered.length) {
          expect(recovered[0]).toMatchObject({ ...pending, persisted: scenario === 'audit-already-persisted', retirement: {
            status: 'cancelled_review_billing_exempt', sourceCallId: pending.callId, sourceStopEventId: stop.id, usageIds: [usage.id], usageOutcome: 'unknown_preserved',
            currentRevision: scenario === 'new-body' ? 2 : 1 } })
          if (scenario === 'audit-already-persisted') expect(recovered[0].retirement.admissionId).toBe(`author-continue:${stop.id}`)
          expect(await read()).toEqual(recovered)
        }
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(beforeUsage)
        expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(beforeCompilation)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})
