import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import * as aiService from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as sessionTitle from '../../api/lib/agent/session-title.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import * as volumeContext from '../../api/lib/agent/writing-volume.js'

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
})