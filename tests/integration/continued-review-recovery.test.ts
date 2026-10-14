import { describe, expect, it } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { readContinuedReviewRecovery, readAuthorContinuedReviewUsageIds } from '../../api/lib/agent/continued-review-recovery.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe.runIf(available)('ordinary author Continue preserves real unknown billing while retiring only its prior execution slot', () => {
  it.each(['quality', 'continuity', 'no-author', 'post-admission', 'correction', 'correction-no-claim', 'correction-unknown-source', 'correction-late-claim',
    'correction-rejected-source', 'correction-charged-rejection-source', 'correction-reserved-rejection-source',
    'reassessment', 'reassessment-no-claim', 'reassessment-no-first-response', 'reassessment-unknown-first', 'reassessment-late-claim', 'reassessment-extra-attempt'] as const)('%s uses authenticated PostgreSQL call/admission/input evidence', scenario => fixture(async f => {
    try {
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '原授权章节复核' })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running',
        usage: { totalTokens: 329762, checkpoint: { stagnantBatches: 9, tokenBudget: 500, reviewAttempts: ['original-consumed'] } } } })
      const startAt = new Date(Date.now() + 5000), resultAt = new Date(startAt.getTime() + 1000)
      const corrective = scenario.startsWith('correction')
      const reassessed = scenario.startsWith('reassessment')
      const toolName = scenario === 'continuity' || corrective || reassessed ? 'continuity_validate' as const : 'quality_analyze' as const
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
        targetType: corrective || reassessed ? 'story_compilation' : 'chapter', targetId: corrective || reassessed ? compilation.id : f.chapterId,
        providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider', modelTier: 'standard', multiplierBps: 12000,
        action: corrective ? 'agent3ContinuityEvidenceCorrection' : reassessed ? 'agent3ContinuityCriticSecondPass' : toolName === 'quality_analyze' ? 'agent3HumanityCritic' : 'agent3ContinuityCritic', requestTokens: null, responseTokens: null,
        usageSource: 'unknown', billingStatus: 'pending_usage', creditChargeMilli: 0, reservedCreditMilli: 18023, durationMs: 0,
        billingSnapshot: { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }, createdAt: new Date(startAt.getTime() + delta + 100) } })
      if (corrective) {
        const rejectedSource = scenario.includes('rejected-source') || scenario.includes('rejection-source')
        const rejected = rejectedSource ? await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider',
          modelTier: 'standard', multiplierBps: 12000, action: 'agent3ContinuityCritic', requestTokens: null, responseTokens: null,
          usageSource: 'prepared', billingStatus: 'provider_rejected', creditChargeMilli: scenario === 'correction-charged-rejection-source' ? 1 : 0,
          reservedCreditMilli: scenario === 'correction-reserved-rejection-source' ? 1 : 0, durationMs: 0, createdAt: new Date(startAt.getTime() - 2100) } }) : null
        const original = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider',
          modelTier: 'standard', multiplierBps: 12000, action: 'agent3ContinuityCritic', requestTokens: 100, responseTokens: 30,
          usageSource: scenario === 'correction-unknown-source' ? 'unknown' : 'reported', billingStatus: 'settled', creditChargeMilli: 16,
          durationMs: 10, billingEvidence: { responseObserved: true }, createdAt: new Date(startAt.getTime() - 2000) } })
        if (scenario !== 'correction-no-claim') await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview',
          title: '原引用纠正预约', content: '仅测试请求归属', createdAt: new Date(startAt.getTime() + (scenario === 'correction-late-claim' ? 200 : 50)),
          metadata: { version: 1, state: 'claimed', callId: pending.callId, chapterId: f.chapterId, revision: 1,
            targetType: 'story_compilation', targetId: compilation.id, usageIds: rejected ? [rejected.id, original.id] : [original.id] } } })
      }
      let knownFirstId: string | undefined
      if (reassessed) {
        const primary = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider',
          modelTier: 'standard', multiplierBps: 12000, action: 'agent3ContinuityCritic', requestTokens: 100, responseTokens: 30,
          usageSource: scenario === 'reassessment-unknown-first' ? 'unknown' : 'reported', billingStatus: 'settled', creditChargeMilli: 16,
          durationMs: 10, billingEvidence: { responseObserved: true }, createdAt: new Date(startAt.getTime() + 10) } })
        knownFirstId = primary.id
        const input = { chapterId: f.chapterId, revision: 1, bodies: { previous: null, current: '原文' }, system: '原检查规则', content: '完整原文：原文', targetType: 'story_compilation' as const, targetId: compilation.id }
        const audit = inspectContinuityResponse('{"findings":[{"signal":"object","severity":"error","evidence":"当前正文“杜撰引用”存在矛盾。","suggestion":"核实对象。","sourceEvidence":[{"source":"current","segmentId":"c0"}]}]}', input.bodies, true, 6)
        const key = legacyContinuityAssessmentKey({ runId: f.runId, callId: pending.callId }, input)
        await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: '首次请求归属', content: '仅测试真实账目归属',
          createdAt: new Date(startAt.getTime() + 25), metadata: { version: 1, assessmentRequestOwnerKey: key, stage: 'first', callId: pending.callId, usageIds: [primary.id] } } })
        await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: '复评请求归属', content: '仅测试真实账目归属',
          createdAt: new Date(startAt.getTime() + 150), metadata: { version: 1, assessmentRequestOwnerKey: key, stage: 'reassessment', callId: pending.callId, usageIds: [usage.id] } } })
        await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: '首次响应审计', content: '仅测试不可变观察',
          createdAt: new Date(startAt.getTime() + 40), metadata: runtimeJson({ version: 1, assessmentKey: key, stage: 'first', callId: pending.callId,
            assessmentResponseKey: runtimeJson({ assessmentKey: key, stage: 'first', usageIds: [primary.id] }).hash,
            input, usageIds: [primary.id], audit: audit.audit,
            ...(scenario === 'reassessment-no-first-response' ? {} : { response: { content: audit.audit.rawResponse.content, encoding: 'json-string',
              finishReason: 'stop', toolCalls: [], transportComplete: true } }),
          }).value } })
        if (scenario !== 'reassessment-no-claim') await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: '完整复评预约', content: '仅测试一次真实预约',
          createdAt: new Date(startAt.getTime() + (scenario === 'reassessment-late-claim' ? 200 : 50)), metadata: runtimeJson({ version: 1, fullReassessmentKey: key, callId: pending.callId,
            input, original: audit.audit, request: continuityReassessmentRequest(input.system, input.content, audit, input.bodies), usageIds: [primary.id] }).value } })
        if (scenario === 'reassessment-extra-attempt') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider', action: 'agent3ContinuityCriticOutputRecovery',
          requestTokens: 100, responseTokens: 30, usageSource: 'reported', billingStatus: 'settled', durationMs: 10, createdAt: new Date(startAt.getTime() + 20) } })
      }
      const beforeUsage = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })
      const beforeAllUsage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      const recovered = await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, [pending]))
      expect(recovered).toHaveLength(['quality', 'continuity', 'correction', 'correction-rejected-source', 'reassessment'].includes(scenario) ? 1 : 0)
      if (recovered.length) {
        const first = recovered[0]
        const allUsageIds = knownFirstId ? expect.arrayContaining([usage.id, knownFirstId]) : [usage.id]
        expect(first.receipt).toMatchObject({ status: 'author_continued_review', usageOutcome: 'unknown_preserved', usageIds: allUsageIds,
          sourceCallId: pending.callId, taskId: f.spec.id })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'review.reconciled', createdAt: new Date(resultAt.getTime() + 1100),
          payload: JSON.parse(JSON.stringify({ callId: pending.callId, chapterId: pending.chapterId, compilationId: pending.compilationId, revision: 1, receipt: first.receipt })) } })
        expect(await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, []))).toEqual([{ ...first, persisted: true }])
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 2, content: '真实保存的修订正文' } })
        expect(await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, []))).toEqual([])
        expect(await prisma.$transaction(tx => readAuthorContinuedReviewUsageIds(tx, f))).toEqual(new Set(knownFirstId ? [usage.id, knownFirstId] : [usage.id]))
      }
      expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toEqual(beforeUsage)
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(beforeAllUsage)
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(beforeRun)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
})
