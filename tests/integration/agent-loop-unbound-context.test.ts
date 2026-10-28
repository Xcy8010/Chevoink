import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import * as aiService from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as sessionTitle from '../../api/lib/agent/session-title.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import * as volumeContext from '../../api/lib/agent/writing-volume.js'
import { readHumanAdmission, withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'

describe.runIf(available)('unbound conversation through the real legacy loop and database context', () => {
  beforeEach(() => {
    const actual = featureFlags.isAgent2FeatureEnabled
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((feature, userId) =>
      feature === 'storyCompiler' || feature !== 'memory2' && actual(feature, userId))
    // Only the provider boundary and optional background title generation are
    // synthetic. Admission, compiler, context, events and finalization use PG.
    vi.spyOn(sessionTitle, 'autoNameSession').mockResolvedValue(undefined)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live provider/network requests are forbidden in this fixture'))
  })

  it.each(['speed', 'custom'] as const)('%s greeting reaches one provider call and finishes without creating a writing target', async tier => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '未命名作品', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '普通问候' } })
    const runId = randomUUID(), prompt = '你好'
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: novel.id, sessionId: session.id, chapterId: null,
      status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      runtimeProtocolVersion: 0, manuscriptRevision: novel.manuscriptRevision, modelTier: tier,
      startRequest: { prompt } } })
    const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({
      tier, multiplierBps: 0, provider: 'fixture', modelName: 'fixture-main', baseUrl: 'https://provider.invalid/v1', apiKey: null,
      reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000,
    })
    const chat = vi.spyOn(aiService, 'chatWithTools').mockImplementation(async request => {
      expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('你好') })
      return {
      content: '你好。', toolCalls: [], reasoning: '', finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null },
      }
    })
    const reader = vi.spyOn(volumeContext, 'readWritingVolumeContext')
    await executeAgentRun({ runId, sessionId: session.id, userId: f.userId, novelId: novel.id, chapterId: null,
      mode: 'build', prompt, modelTier: tier, ...(tier === 'custom' ? { customModelId: 'fixture-custom-route' } : {}) })
    expect(runtime).toHaveBeenCalledWith(tier, f.userId, tier === 'custom' ? 'fixture-custom-route' : undefined, undefined)
    expect(chat).toHaveBeenCalledOnce()
    expect(reader).not.toHaveBeenCalled()
    const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(saved).toMatchObject({ status: 'completed', currentTurn: 1, runtimeProtocolVersion: 0, taskRootId: null })
    expect(saved.taskSpec).toMatchObject({ writingPacing: 'conversation_only' })
    expect(await prisma.agentRunEvent.count({ where: { runId, type: 'error' } })).toBe(0)
    expect(await prisma.agentRunEvent.count({ where: { runId, type: 'run.finished' } })).toBe(1)
    const messages = await prisma.agentMessage.findMany({ where: { runId, role: 'assistant' } })
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toEqual(expect.arrayContaining([{ type: 'text', text: '你好。' }]))
    expect(await prisma.chapter.count({ where: { novelId: novel.id } })).toBe(0)
    expect(await prisma.storyCompilation.count({ where: { runId } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
  }))

  it.each(['settled', 'pending_settlement'] as const)('%s empty response recovery uses the real request, reservation and settlement', async settlement => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '未命名作品', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '普通问候' } })
    const runId = randomUUID(), prompt = '你好'
    const startRequest = withHumanAdmission({ prompt, sessionId: session.id, novelId: novel.id, mode: 'build' })
    expect(readHumanAdmission(startRequest)?.request).toMatchObject({ prompt, sessionId: session.id, novelId: novel.id, mode: 'build' })
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: novel.id, sessionId: session.id, chapterId: null,
      status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      runtimeProtocolVersion: 0, manuscriptRevision: novel.manuscriptRevision, modelTier: 'speed', reasoningEffort: 'high',
      startRequest } })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 500000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const price = { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 10000 }
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue(price)
    const runtime = { tier: 'speed' as const, multiplierBps: 10000, provider: 'deepseek', modelName: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-only', reasoningEffort: 'high' as const,
      reasoningEfforts: ['high' as const], thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    if (settlement === 'pending_settlement') {
      const consume = credits.consumeTokenCredits
      vi.spyOn(credits, 'consumeTokenCredits').mockImplementation(async args => {
        const payment = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: args.usageLogId } })
        if (payment.agentRunId === runId) throw new Error('fixture settlement unavailable')
        return consume(args)
      })
    }
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      expect(_url).toBe('https://api.deepseek.com/v1/chat/completions')
      expect(body).toMatchObject({ model: runtime.modelName, stream: true, thinking: { type: 'enabled' }, reasoning_effort: 'high' })
      const prepared = await prisma.aiUsageLog.findFirstOrThrow({ where: { agentRunId: runId, turn: bodies.length } })
      expect(prepared).toMatchObject({ action: 'agentLoopTurn', providerName: 'deepseek', modelName: runtime.modelName,
        modelTier: 'speed', multiplierBps: 10000, usageSource: 'prepared', billingStatus: 'prepared', billingSnapshot: price })
      expect(prepared.reservedCreditMilli).toBeGreaterThan(0)
      if (bodies.length > 4) throw new Error('unexpected extra provider request')
      const truncated = bodies.length <= 3, completionTokens = truncated ? body.max_tokens as number : 4
      const frame = { choices: [{ delta: truncated ? { reasoning_content: 'Synthetic unfinished reasoning.' } : { content: '你好。' },
        finish_reason: truncated ? 'length' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: completionTokens,
        total_tokens: 12 + completionTokens } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    expect(vi.isMockFunction(aiService.chatWithTools)).toBe(false)
    await executeAgentRun({ runId, sessionId: session.id, userId: f.userId, novelId: novel.id, chapterId: null,
      mode: 'build', prompt, modelTier: 'speed', reasoningEffort: 'high', qualityMode: 'premium' })
    expect(fetcher).toHaveBeenCalledTimes(settlement === 'settled' ? 4 : 1)
    expect(bodies.map(body => body.max_tokens)).toEqual(settlement === 'settled' ? [8192, 16384, 32768, 65536] : [8192])
    const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(saved).toMatchObject({ status: settlement === 'settled' ? 'completed' : 'failed', currentTurn: bodies.length,
      runtimeProtocolVersion: 0, taskRootId: null, modelTier: 'speed', customModelId: null, reasoningEffort: 'high' })
    expect(saved.taskSpec).toMatchObject({ writingPacing: 'conversation_only', qualityMode: 'premium' })
    const payments = await prisma.aiUsageLog.findMany({ where: { agentRunId: runId }, orderBy: { turn: 'asc' } })
    expect(payments).toHaveLength(bodies.length)
    expect(payments[0]).toMatchObject({ usageSource: 'reported', billingStatus: settlement, requestTokens: 12, responseTokens: 8192 })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId, kind: 'usage' } })
    const account = await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })
    if (settlement === 'settled') {
      expect(payments.map(payment => payment.responseTokens)).toEqual([8192, 16384, 32768, 4])
      expect(ledger).toHaveLength(4)
      for (const payment of payments) {
        expect(payment).toMatchObject({ billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, reservedCreditMilli: 0 })
        expect(payment.creditChargeMilli).toBe(credits.calculateTokenChargeMilli(payment.requestTokens!, payment.responseTokens!))
        expect(ledger.find(entry => entry.idempotencyKey === `usage:${payment.id}`)).toMatchObject({ referenceId: runId,
          deltaMilli: -payment.creditChargeMilli, requestTokens: payment.requestTokens, responseTokens: payment.responseTokens })
      }
      expect(account.dailyUsedMilli).toBe(payments.reduce((total, payment) => total + payment.creditChargeMilli, 0))
      const messages = await prisma.agentMessage.findMany({ where: { runId, role: 'assistant' } })
      expect(messages.flatMap(message => message.parts as Array<{ type: string; text?: string }>)).toContainEqual({ type: 'text', text: '你好。' })
    } else {
      expect(payments[0]).toMatchObject({ creditChargeMilli: 0, billingSnapshot: price })
      expect(payments[0].reservedCreditMilli).toBeGreaterThan(0)
      expect(ledger).toEqual([])
      expect(account.dailyUsedMilli).toBe(0)
      expect(saved.errorMessage).toContain('尚未确认')
    }
    expect(await prisma.agentRunEvent.count({ where: { runId, type: 'run.finished' } })).toBe(1)
    expect(await prisma.chapter.count({ where: { novelId: novel.id } })).toBe(0)
    expect(await prisma.storyCompilation.count({ where: { runId } })).toBe(0)
  }))
})
