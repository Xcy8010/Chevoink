import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { consumeCredits, consumeCreditsInTransaction, getCreditWindow, refundCreditCharge } from '../../api/lib/credits.js'
import { createAgentGoal, actOnAgentGoal, readAgentGoal } from '../../api/lib/agent/goal-service.js'
import { withGoalExecutionContext, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { generateCoverImageData } from '../../api/lib/ai-service.js'
import * as toolConfig from '../../api/lib/tool-model-config.js'
import * as novelData from '../../api/lib/data/novel.js'
import { reconcileGoalUsage } from '../../api/lib/agent/goal-budget.js'

const imageTransport = vi.hoisted(() => vi.fn())
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: imageTransport }))

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(() => prisma.$disconnect())
afterEach(() => { vi.restoreAllMocks(); imageTransport.mockReset() })

async function fixture(work: (context: GoalExecutionContext) => Promise<void>, explicitLimits = false) {
  const previous = env.agentGoalEnabled
  env.agentGoalEnabled = true
  const user = await prisma.user.create({ data: { nickname: `goal-fee-${randomUUID()}`, passwordHash: 'fixture-only' } })
  try {
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: user.id, dailyAllowanceMilli: 10000,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '固定费用合成测试', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '固定费用测试' } })
    const goal = await createAgentGoal(user.id, { sessionId: session.id }, { requestId: randomUUID(), objective: '调研封面', options: { mode: 'build' },
      ...(explicitLimits ? { limits: { tokenLimit: 1000, activeTimeLimitMs: 60_000 } } : {}) }, { authenticatedHttp: true })
    const run = await prisma.agentRun.create({ data: { userId: user.id, novelId: novel.id, sessionId: session.id,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running', inputSummary: 'fixture' } })
    await prisma.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: 1n,
      runId: run.id, continuationIndex: 1, trigger: 'author', sourceEventId: randomUUID() } })
    await work({ goalId: goal.id, revision: 1, epoch: 1n, userId: user.id, novelId: novel.id, sessionId: session.id, runId: run.id })
  } finally {
    await prisma.agentGoalCommand.deleteMany({ where: { userId: user.id } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.aiUsageLog.deleteMany({ where: { userId: user.id } })
    await prisma.coverAsset.deleteMany({ where: { ownerUserId: user.id } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
    env.agentGoalEnabled = previous
  }
}

describe.skipIf(!dbAvailable)('goal fixed-fee ledger integration', () => {
  it.each(['success', 'timeout', 'partial-body', 'all-rejected', 'all-empty'] as const)(
    'keeps separate physical legacy image observations for routed %s without mirroring wallet charges twice', async scenario => {
      await fixture(async context => {
        vi.spyOn(toolConfig, 'getToolModelRuntime').mockResolvedValue({ provider: 'primary-fixture', modelName: 'primary-image', baseUrl: 'https://primary.invalid/generate', apiKey: 'isolated-primary-key',
          routes: [{ id: randomUUID(), provider: 'backup-fixture', modelName: 'backup-image', baseUrl: 'https://backup.invalid/generate', apiKey: 'isolated-backup-key' }] })
        vi.spyOn(novelData, 'normalizeCoverImageUrl').mockResolvedValue('/api/uploads/novel-covers/fixture.png')
        imageTransport.mockImplementation(async (endpoint: string) => {
          if (endpoint === 'https://primary.invalid/generate') return new Response('{"error":{"message":"fixture unavailable"}}', { status: 503 })
          expect(endpoint).toBe('https://backup.invalid/generate')
          if (scenario === 'timeout') throw new DOMException('fixture request timeout', 'TimeoutError')
          if (scenario === 'partial-body') return new Response(new ReadableStream({ start(stream) {
            stream.enqueue(new TextEncoder().encode('{"data":[')); stream.error(Error('fixture response body lost'))
          } }))
          if (scenario === 'all-rejected') return new Response('{"error":{"message":"fixture unavailable"}}', { status: 503 })
          return new Response(JSON.stringify({ data: scenario === 'all-empty' ? [] : [{ url: 'https://images.invalid/cover.png' }] }))
        })
        const generate = () => withGoalExecutionContext(context, () => generateCoverImageData(context.userId,
          { novelId: context.novelId, prompt: '合成封面测试', size: '768x1024', count: 1 }))
        if (scenario === 'success') expect((await generate()).images).toHaveLength(1)
        else await expect(generate()).rejects.toThrow()
        expect(imageTransport).toHaveBeenCalledTimes(2)
        const logs = await prisma.aiUsageLog.findMany({ where: { userId: context.userId, action: 'generateCoverImage' } })
        expect(logs).toHaveLength(2)
        const first = logs.find(log => log.modelName === 'primary-image')!, last = logs.find(log => log.modelName === 'backup-image')!
        expect(first).toMatchObject({ billingStatus: 'provider_rejected', creditChargeMilli: 0, usageSource: 'fixed_unit' })
        const unknown = scenario === 'timeout' || scenario === 'partial-body'
        expect(last).toMatchObject({ billingStatus: unknown ? 'pending_usage' : scenario === 'success' ? 'observed' : 'provider_rejected',
          creditChargeMilli: scenario === 'success' ? 6000 : 0, usageSource: unknown ? 'unknown' : 'fixed_unit' })
        const observations = await prisma.agentGoalUsage.findMany({ where: { goalId: context.goalId, sourceKey: { startsWith: 'legacy:' } } })
        expect(new Set(observations.map(row => row.sourceKey))).toEqual(new Set(logs.map(log => `legacy:${log.id}`)))
        expect(observations.find(row => row.sourceKey === `legacy:${first.id}`)).toMatchObject({ status: 'rejected', creditsMicros: 0n })
        expect(observations.find(row => row.sourceKey === `legacy:${last.id}`)).toMatchObject({ status: unknown ? 'unknown' : scenario === 'success' ? 'known' : 'rejected', creditsMicros: 0n })
        expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId, kind: 'usage', deltaMilli: -6000 } })).toBe(1)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId, kind: 'refund', deltaMilli: 6000 } })).toBe(scenario === 'success' ? 0 : 1)
        const budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
        expect(budget).toMatchObject({ creditsUsedMicros: scenario === 'success' ? 6000000n : 0n, tokensUsed: 0n, tokensReserved: 0n })
        const before = observations.map(({ sourceKey, status, creditsMicros }) => ({ sourceKey, status, creditsMicros })).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
        await reconcileGoalUsage(context.goalId)
        const after = (await prisma.agentGoalUsage.findMany({ where: { goalId: context.goalId, sourceKey: { startsWith: 'legacy:' } } }))
          .map(({ sourceKey, status, creditsMicros }) => ({ sourceKey, status, creditsMicros })).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
        expect(after).toEqual(before)
        expect(await prisma.agentGoalUsage.count({ where: { goalId: context.goalId, status: 'unknown' } })).toBe(unknown ? 1 : 0)
        expect(imageTransport).toHaveBeenCalledTimes(2)
        const assets = await prisma.coverAsset.findMany({ where: { ownerUserId: context.userId } })
        expect(assets).toHaveLength(scenario === 'success' ? 1 : 0)
        if (scenario === 'success') expect(assets[0].modelName).toBe('backup-image')
      })
    })
  it.each(['image_generation', 'web_search', 'web_fetch'])('counts %s once and refunds after cancellation without reopening the goal', async sourceType => {
    await fixture(async context => {
      const key = `goal-fixed:${randomUUID()}`
      const input = { userId: context.userId, amountMilli: 2000, kind: 'usage', sourceType, idempotencyKey: key }
      await withGoalExecutionContext(context, () => consumeCredits(input))
      await withGoalExecutionContext(context, () => consumeCredits(input))
      let budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
      expect(budget).toMatchObject({ creditsUsedMicros: 2_000_000n, tokensUsed: 0n, tokensReserved: 0n })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId, kind: 'usage' } })).toBe(1)
      const goal = (await readAgentGoal(context.userId, context.sessionId))!
      await actOnAgentGoal(context.userId, context.sessionId, context.goalId,
        { requestId: randomUUID(), expectedStateVersion: goal.stateVersion, action: 'cancel' })
      await expect(withGoalExecutionContext(context, () => consumeCredits({ ...input, idempotencyKey: `${key}:late` })))
        .rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
      await refundCreditCharge(context.userId, key, 'fixture-refund')
      await refundCreditCharge(context.userId, key, 'fixture-refund')
      budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
      expect(budget.creditsUsedMicros).toBe(0n)
      expect((await readAgentGoal(context.userId, context.sessionId))?.status).toBe('cancelled')
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId, kind: 'refund' } })).toBe(1)
    })
  })

  it('rolls wallet, goal usage and goal events back together', async () => {
    await fixture(async context => {
      const before = (await readAgentGoal(context.userId, context.sessionId))!
      await expect(withGoalExecutionContext(context, () => prisma.$transaction(async tx => {
        await consumeCreditsInTransaction(tx, { userId: context.userId, amountMilli: 2000, kind: 'usage',
          sourceType: 'web_search', idempotencyKey: `rollback:${randomUUID()}` })
        throw new Error('fixture transaction rollback')
      }))).rejects.toThrow('fixture transaction rollback')
      expect(await prisma.agentGoalUsage.count({ where: { goalId: context.goalId } })).toBe(0)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId } })).toBe(0)
      expect((await readAgentGoal(context.userId, context.sessionId))?.stateVersion).toBe(before.stateVersion)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: context.userId } })).dailyUsedMilli).toBe(0)
    })
  })

  it.each(['tokens', 'time'])('does not charge another fixed-fee tool after the %s budget is exhausted', async kind => {
    await fixture(async context => {
      const budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
      await prisma.agentGoalBudget.update({ where: { goalId: context.goalId }, data: kind === 'tokens'
        ? { tokensUsed: budget.tokenLimit } : { activeTimeMs: budget.activeTimeLimitMs } })
      await expect(withGoalExecutionContext(context, () => consumeCredits({ userId: context.userId, amountMilli: 2000,
        kind: 'usage', sourceType: 'web_search', idempotencyKey: `exhausted:${randomUUID()}` })))
        .rejects.toMatchObject({ code: 'GOAL_BUDGET_EXHAUSTED' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: context.userId } })).toBe(0)
      expect(await prisma.agentGoalUsage.count({ where: { goalId: context.goalId } })).toBe(0)
    }, true)
  })
})
