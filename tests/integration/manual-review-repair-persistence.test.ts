import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { fixture, available } from '../support/agent-durable-runtime-fixture.js'
import { appendManualRepairEvent, readManualRepairEvent } from '../../api/lib/agent/manual-review-repair-store.js'
import { generateTextCompletion } from '../../api/lib/ai-service.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import * as credits from '../../api/lib/credits.js'

describe('manual repair durable primary keys and real PostgreSQL billing', () => {
  it.skipIf(!available)('serializes duplicate semantic claims without rewriting the original claim or making another operation', () => fixture(async f => {
    const operationId = `mrr_${'a'.repeat(56)}`, value = { intent: 'repair_failed_review_once', actorUserId: f.userId, frozen: { kind: 'manual_review_repair', taskId: f.spec.id } }
    const claim = () => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${f.runId} FOR UPDATE`
      return appendManualRepairEvent(tx, f.runId, operationId, 'authorized', value)
    })
    const [first, second] = await Promise.all([claim(), claim()])
    expect(first.id).toBe(second.id)
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'review.manual_repair.authorized' } })).toBe(1)
    const read = await prisma.$transaction(tx => readManualRepairEvent(tx, f.runId, operationId, 'authorized'))
    expect(read?.value).toEqual(value)
    await expect(prisma.$transaction(tx => appendManualRepairEvent(tx, f.runId, operationId, 'authorized', { ...value, actorUserId: 'other' }))).rejects.toMatchObject({ code: 'MANUAL_REVIEW_REPAIR_REFUSED' })
  }))
  it.skipIf(!available)('reserves and settles the exact V2 snapshot once through the actual transport while retaining route metadata', () => fixture(async f => {
    try {
      const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'synthetic-speed-card',
        rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 }, v1CeilingBps: 11000 }
      vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue()
      const operationId = `mrr_${'b'.repeat(56)}`, targetId = 'synthetic-compilation'
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } })))
      vi.stubGlobal('fetch', fetcher)
      let usageId = ''
      await generateTextCompletion('Review all complete inputs.', 'Synthetic complete chapter.', { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
        agentRunId: f.runId, action: 'agent3ContinuityCritic', targetType: 'story_compilation', targetId, explicitModelSelection: true,
        modelRuntime: { tier: 'speed', provider: 'synthetic', modelName: 'synthetic-model', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only',
          multiplierBps: 15000, reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false },
        maxOutputTokens: 64, authorizedRequest: { price, inputTokenCeiling: 4096, maxCreditMilli: priceTokenEvidence(price, 4096, 64, 0),
          manualReviewRepairOperationId: operationId, beforeDispatch: async () => {} }, beforeProviderDispatch: async id => { usageId = id } })
      const paid = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usageId } })
      expect(paid).toMatchObject({ multiplierBps: 15000, billingSnapshot: price, requestTokens: 100, responseTokens: 10,
        billingStatus: 'settled', usageSource: 'reported', reservedCreditMilli: 0, creditChargeMilli: priceTokenEvidence(price, 100, 10, null) })
      expect(fetcher).toHaveBeenCalledOnce()
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { idempotencyKey: `usage:${usageId}` } })
      expect(ledger).toHaveLength(1); expect(ledger[0].deltaMilli).toBe(-paid.creditChargeMilli)
    } finally {
      await prisma.creditLedgerEntry.deleteMany({ where: { userId: f.userId } })
      await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } })
      await prisma.creditAccount.deleteMany({ where: { userId: f.userId } })
    }
  }))
})
