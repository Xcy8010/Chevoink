import { encryptSecret } from '../../api/lib/secret-box.js'
import { expectToolDenied } from '../support/expect-tool-denied.js'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { assertTaskResponseEligible } from '../../api/lib/agent/task-response.js'
import { taskRespondTool } from '../../api/lib/agent/tools/task-response-tool.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { createNovelPlanArtifact, listNovelPlanArtifacts } from '../../api/lib/agent/plan-artifacts.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('unbound conversation through the real legacy loop and database context', () => {
  const selectionModelIds:string[]=[]
  afterEach(async()=>{
    await prisma.aiModelConfigVersion.deleteMany({where:{modelConfigId:{in:selectionModelIds}}})
    await prisma.aiModelConfig.deleteMany({where:{id:{in:selectionModelIds.splice(0)}}})
  })
  beforeEach(() => {
    const actual = featureFlags.isAgent2FeatureEnabled
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((feature, userId) =>
      feature === 'storyCompiler' || feature !== 'memory2' && actual(feature, userId))
    // Only the provider boundary and optional background title generation are
    // synthetic. Admission, compiler, context, events and finalization use PG.
    vi.spyOn(sessionTitle, 'autoNameSession').mockResolvedValue(undefined)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live provider/network requests are forbidden in this fixture'))
  })

  it.each([false,true])('resumes an actual human markerless Continue without upgrading the task; explicit A to B switch=%s', async switched => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '历史问答继续合成作品', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '第一卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: novel.id, volumeId: volume.id,
      title: '第一章', content: '合成正文保持原样。', orderIndex: 1, orderInVolume: 1 } })
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '原问题继续' } })
    const runId = randomUUID(), prompt = '第一卷要写多少章？', answer = '根据卷纲，第一卷计划二十章。'
    const selectionModels=[]
    if(switched)for(const label of ['a','b']) {
      const tier='builtin_'+randomUUID().replaceAll('-','').slice(0,16)
      const row=await prisma.aiModelConfig.create({data:{key:tier,tier,provider:'fixture',displayName:'Synthetic continue '+label,modelName:'synthetic-'+label,baseUrl:'https://provider.invalid/v1',apiKeyCiphertext:encryptSecret('synthetic-offline-only'),enabled:true,selectable:true,multiplierBps:0,metadata:{reasoningEfforts:['high'],defaultReasoningEffort:'high',reasoningParameterMode:'omit'}}})
      selectionModels.push(row);selectionModelIds.push(row.id)
    }
    const initialTier=selectionModels[0]?.tier??'speed'
    const originalPrice=switched?{version:'credits-v1-exact',modelTier:initialTier,multiplierBps:0}:undefined
    const startedAt = new Date(Date.now() - 2000), stoppedAt = new Date(startedAt.getTime() + 100)
    const startRequest = withHumanAdmission({ sessionId: session.id, novelId: novel.id, chapterId: chapter.id, prompt, mode: 'build' })
    const usage = { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, checkpoint: {
      version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy', runStartedAt: startedAt.getTime(), activeExecutionMs: 100,
      stagnantBatches: 0, resumeCount: 1, compactionCount: 0, maxTurns: 50, tokenBudget: 9000, writeProgress: 0, writeBaseline: 0,
      readProgress: 3, readBaseline: 0, progressSignatures: [], reviewAttempts: ['original-synthetic-settled-receipt'] } }
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id,
      status: 'failed', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
      manuscriptRevision: novel.manuscriptRevision, modelTier: initialTier, reasoningEffort: 'high', currentTurn: 4, startedAt, finishedAt: stoppedAt,
      ...(switched?{modelConfigId:selectionModels[0].id,modelConfigRevision:selectionModels[0].revision,modelPriceSnapshot:originalPrice}:{}),
      startRequest, usage } })
    await prisma.agentMessage.create({ data: { runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    await prisma.agentMessage.create({ data: { runId, sessionId: session.id, role: 'assistant', parts: [
      { type: 'tool-call', callId: 'historical-read', toolName: 'novel_get_context', title: '读取上下文', args: {}, status: 'success', summary: '已读取原问题背景' },
    ] } })
    const subject = { userId: f.userId, novelId: novel.id, sessionId: session.id, runId }
    const frozen = await prisma.$transaction(tx => freezeWritingScope(tx, subject,
      buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt, authorWritingProtocol: 2 }), prompt, 2))
    const admitted = runtimeJson(JSON.parse(JSON.stringify(frozen)))
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: admitted.value } })
    expect(frozen.responseDeliveryProtocol).toBeUndefined()
    expect(frozen.scope.authorEffects?.manuscript).toBe(true)
    await prisma.agentRunEvent.create({ data: { runId, seq: 1, type: 'run.started', createdAt: startedAt, payload: {
      type: 'run.started', runId, seq: 1, ts: startedAt.toISOString(), agent: { type: 'orchestrator', title: '原任务', model: 'speed' }, mode: 'build', title: prompt,
    } } })
    const terminal = await prisma.agentRunEvent.create({ data: { runId, seq: 2, type: 'run.finished', createdAt: stoppedAt, payload: {
      type: 'run.finished', runId, seq: 2, ts: stoppedAt.toISOString(), status: 'failed', usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 },
      artifacts: [], outputSummary: '',
    } } })
    if(switched)await prisma.aiUsageLog.create({data:{userId:f.userId,agentRunId:runId,providerType:'text',providerMode:'synthetic',modelName:'synthetic-a',action:'syntheticOldUnknown',targetType:'agentRun',targetId:runId,durationMs:0,usageSource:'unknown',billingStatus:'pending_usage',reservedCreditMilli:9000}})
    const priorPayments = await prisma.aiUsageLog.findMany({ where: { agentRunId: runId } })
    if(!switched)vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
    const resolver=vi.spyOn(credits, 'getModelTierRuntime')
    if(!switched)resolver.mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture', modelName: 'fixture-main',
      baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000 })
    const callUsage = { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null }
    const chat = vi.spyOn(aiService, 'chatWithTools').mockResolvedValueOnce({ content: '', reasoning: '', finishReason: 'tool_calls',
      toolCalls: ['novel_get_context', 'structure_outline', 'chapter_list_summaries'].map((name, index) => ({ id: `continued-read-${index}`, name, arguments: '{}' })), usage: callUsage })
      .mockImplementationOnce(async input => {
        expect(input.tools?.some(tool => tool.function.name === 'task_respond')).toBe(false)
        for (const index of [0, 1, 2]) expect(input.messages.some(message => message.role === 'tool' && message.toolCallId === `continued-read-${index}`)).toBe(true)
        return { content: answer, reasoning: '', finishReason: 'stop', toolCalls: [], usage: callUsage }
      })
    expect(await continueLoopRun(f.userId, runId,switched?{modelTier:selectionModels[1].tier as `builtin_${string}`,reasoningEffort:'high'}:undefined)).toMatchObject({ runId, status: 'running' })
    await vi.waitFor(async () => expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('completed'), { timeout: 10000, interval: 20 })
    const completed = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(completed).toMatchObject({ currentTurn: 6, outputSummary: answer, runtimeProtocolVersion: 0, taskRootId: null,
      modelTier: switched?selectionModels[1].tier:'speed', customModelId: null, reasoningEffort: 'high', startRequest, usage: { totalTokens: 1070,
        checkpoint: { tokenBudget: 9000, maxTurns: 50, resumeCount: 1, reviewAttempts: usage.checkpoint.reviewAttempts } } })
    if(switched){
      expect(completed).toMatchObject({modelConfigId:selectionModels[1].id,modelConfigRevision:selectionModels[1].revision,modelPriceSnapshot:originalPrice})
      expect(resolver).toHaveBeenCalledWith(selectionModels[1].tier,f.userId,null,'high',{userId:f.userId,runId,modelConfigId:selectionModels[1].id,modelConfigRevision:selectionModels[1].revision})
      expect(chat.mock.calls.every(([input])=>input.model==='synthetic-b')).toBe(true)
    }
    expect(runtimeJson(completed.taskSpec).hash).toBe(admitted.hash)
    const starts = await prisma.agentRunEvent.findMany({ where: { runId, type: 'run.started' }, orderBy: { seq: 'desc' } })
    expect(starts[0].payload).toMatchObject({ authorContinue: { eventId: terminal.id, afterSeq: 2 } })
    const messages = await prisma.agentMessage.findMany({ where: { runId, role: 'assistant' }, orderBy: { createdAt: 'desc' } })
    expect(messages[0].parts).toEqual(expect.arrayContaining([{ type: 'text', text: answer }]))
    expect(await prisma.aiUsageLog.findMany({ where: { agentRunId: runId } })).toEqual(priorPayments)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    expect(await prisma.storyCompilation.count({ where: { runId } })).toBe(0)
  }))

  it('atomically delivers the main Agent native answer despite inferred writing scope and refuses actual prepared work', async () => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '答复交付合成作品', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '第一卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: novel.id, volumeId: volume.id,
      title: '第一章', content: '保留的合成正文。', orderIndex: 1, orderInVolume: 1 } })
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '章节数量问答',
      toolPolicy: { contentWrite: 'allow' } } })
    const runId = randomUUID(), prompt = '第一卷要写多少章？', answer = '第一卷计划写二十章。\n\n当前已保存一章。'
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id,
      status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      runtimeProtocolVersion: 0, manuscriptRevision: novel.manuscriptRevision, startRequest: { prompt } } })
    const subject = { userId: f.userId, novelId: novel.id, sessionId: session.id, runId }
    const fresh = buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt, authorWritingProtocol: 2 })
    const frozen = { ...await prisma.$transaction(tx => freezeWritingScope(tx, subject, fresh, prompt, 2)), responseDeliveryProtocol: 1 as const }
    // Mirror HTTP admission's JSON boundary before capturing the persisted contract.
    const spec = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    const admitted = runtimeJson(spec)
    expect(spec.scope.authorEffects?.manuscript).toBe(true)
    expect(spec.scope.writing?.kind).toBe('bounded')
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: admitted.value } })
    const hash = admitted.hash
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture',
      modelName: 'fixture-main', baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high',
      reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000 })
    const chat = vi.spyOn(aiService, 'chatWithTools')
      .mockResolvedValueOnce({ content: '', reasoning: '', finishReason: 'tool_calls',
        toolCalls: ['novel_get_context', 'structure_outline', 'chapter_list_summaries'].map((name, index) => ({ id: `read-${index}`, name, arguments: '{}' })),
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, promptCacheHitTokens: null, promptCacheMissTokens: null } })
      .mockImplementationOnce(async input => {
        expect(input.tools?.some(tool => tool.function.name === 'task_respond')).toBe(true)
        for (const index of [0, 1, 2]) expect(input.messages.some(message => message.role === 'tool' && message.toolCallId === `read-${index}`)).toBe(true)
        return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'direct-answer', name: 'task_respond', arguments: JSON.stringify({ answer }) }],
          usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, promptCacheHitTokens: null, promptCacheMissTokens: null } }
      })
    await executeAgentRun({ ...subject, chapterId: chapter.id, mode: 'build', prompt })
    expect(chat).toHaveBeenCalledTimes(2)
    const completed = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(completed).toMatchObject({ status: 'completed', currentTurn: 2, outputSummary: answer })
    expect(runtimeJson(completed.taskSpec).hash).toBe(hash)
    const messages = await prisma.agentMessage.findMany({ where: { runId, role: 'assistant' }, orderBy: { createdAt: 'asc' } })
    expect(messages.at(-1)?.parts).toEqual(expect.arrayContaining([{ type: 'text', text: answer }]))
    const events = await prisma.agentRunEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
    expect(events.filter(event => event.type === 'text.final').at(-1)?.payload).toMatchObject({ text: answer })
    expect(events.at(-1)?.payload).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    expect(await prisma.storyCompilation.count({ where: { runId } })).toBe(0)
    const started = await prisma.agentRun.create({ data: { userId: f.userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id,
      status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      runtimeProtocolVersion: 0, manuscriptRevision: novel.manuscriptRevision, startRequest: { prompt } } })
    const startedSpec = { ...spec, id: randomUUID(), runId: started.id }
    await prisma.agentRun.update({ where: { id: started.id }, data: { taskSpec: runtimeJson(startedSpec).value } })
    await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: novel.id, runId: started.id, chapterId: chapter.id,
      targetOrderIndex: 1, sourcePromptHash: runtimeJson(prompt).hash, preparedContext: {} } })
    await expectToolDenied(taskRespondTool.execute({ ...subject, runId: started.id, chapterId: chapter.id, mode: 'build', creativeFreedom: 'balanced',
      qualityMode: 'premium', callId: 'started-reply', signal: new AbortController().signal, emit: () => {}, respondTask: async text => ({
        ...await prisma.$transaction(tx => assertTaskResponseEligible(tx, { ...subject, runId: started.id })), answer: text,
      }) }, { answer }), { code: 'TASK_RESPONSE_WORK_PENDING' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: started.id } })).status).toBe('running')
    expect(await prisma.agentMessage.count({ where: { runId: started.id, role: 'assistant' } })).toBe(0)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
  }))

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
    expect(runtime).toHaveBeenCalledWith(tier, f.userId, tier === 'custom' ? 'fixture-custom-route' : undefined, undefined, {userId:f.userId,runId,modelConfigId:null,modelConfigRevision:null})
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

  it.each([false, true])('persists one change-of-method report before the matching individual check (author prose=%s)', async spoken => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '合成审阅', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '上卷', orderIndex: 1 } })
    const chapters = await Promise.all([16, 17, 18].map(orderIndex => prisma.chapter.create({ data: {
      novelId: novel.id, authorId: f.userId, volumeId: volume.id, title: '合成章' + orderIndex,
      orderIndex, orderInVolume: orderIndex, content: '雨停了。雨停了。' } })))
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '三章审阅' } })
    const prompt = '核对现有三章的衔接并汇报结果。', runId = randomUUID()
    await prisma.agentRun.create({ data: { id: runId, sessionId: session.id, userId: f.userId, novelId: novel.id,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'queued',
      startRequest: withHumanAdmission({ sessionId: session.id, novelId: novel.id, prompt, mode: 'build' }) } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture',
      modelName: 'fixture-main', baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high',
      reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000 })
    // The offline model has no auxiliary provider. Both author-prose cases
    // see the same real failed tool receipt; only the main response differs.
    vi.spyOn(storyMemory, 'syncNovelMemoryProjection').mockResolvedValue({
      chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: true,
    })
    const authorReport = '三章的批查没有返回完整报告，我先单独核对其中一章。'
    const calls = [
      { name: 'chapter_review_batch', args: { chapterIds: chapters.map(chapter => chapter.id), reviewType: 'continuity' } },
      { name: 'continuity_validate', args: { chapterId: chapters[0].id, readOnly: true } },
      { name: 'continuity_validate', args: { chapterId: chapters[1].id, readOnly: true } },
    ]
    let turn = 0
    const chat = vi.spyOn(aiService, 'chatWithTools').mockImplementation(async () => {
      const call = calls[turn++]
      if (turn > 4) throw new Error('Unexpected additional model request')
      return { content: call ? spoken && turn === 2 ? authorReport : '' : '审阅没有取得完整结果。',
        toolCalls: call ? [{ id: 'review-' + turn, name: call.name, arguments: JSON.stringify(call.args) }] : [],
        reasoning: '', finishReason: call ? 'tool_calls' : 'stop',
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ runId, sessionId: session.id, userId: f.userId, novelId: novel.id,
      chapterId: null, mode: 'build', prompt, modelTier: 'speed' })
    const rows = await prisma.agentMessage.findMany({ where: { runId, role: 'assistant' }, orderBy: { createdAt: 'asc' } })
    const expected = spoken ? authorReport : '批量复查还有未完成的部分，我准备按章核对。'
    const fallback = rows[1]?.parts
    expect(fallback).toEqual(expect.arrayContaining([{ type: 'text', text: expected }]))
    expect(Array.isArray(fallback) && fallback.findIndex(p => (p as { type?: string })?.type === 'text'))
      .toBeLessThan(Array.isArray(fallback) ? fallback.findIndex(p => (p as { type?: string })?.type === 'tool-call') : -1)
    expect(JSON.stringify(rows[2]?.parts)).not.toContain(expected)
    const events = await prisma.agentRunEvent.findMany({ where: { runId, type: 'text.final', payload: { path: ['text'], equals: expected } } })
    expect(events).toHaveLength(1)
    expect(chat).toHaveBeenCalledTimes(4)
  }), 60000)

  it('updates existing deliverables while editing the next chapter and reads the saved revisions', async () => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '合成改稿', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '上卷', orderIndex: 1 } })
    const chapters = await Promise.all([16, 17].map(orderIndex => prisma.chapter.create({ data: {
      novelId: novel.id, authorId: f.userId, volumeId: volume.id, title: '合成章' + orderIndex,
      orderIndex, orderInVolume: orderIndex, content: '清晨，钟响了。' } })))
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '修订任务' } })
    const prompt = '把第十六章和第十七章的清晨改成傍晚，回读改好的地方。', runId = randomUUID()
    const subject = { runId, novelId: novel.id, userId: f.userId, sessionId: session.id }
    await prisma.agentRun.create({ data: { userId: f.userId, novelId: novel.id, sessionId: session.id, id: runId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator',
      engine: 'loop', status: 'queued', startRequest: withHumanAdmission({ prompt, novelId: novel.id, sessionId: session.id, mode: 'build' }) } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture', modelName: 'fixture-main',
      baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(storyMemory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: true })
    const todo = (...statuses: string[]) => ({ name: 'todo_write', args: { items: statuses.map((status, i) => ({
      content: ['修订第十六章开头', '修订第十七章开头', '回读两处改文'][i], status })) } })
    const read = (i: number) => ({ name: 'chapter_read', args: { chapterId: chapters[i].id, limit: 9 } })
    const edit = (i: number) => ({ name: 'chapter_edit_range', args: { chapterId: chapters[i].id, oldText: '清晨', newText: '傍晚' } })
    const turns = [
      [todo('in_progress', 'pending', 'pending'), read(0), read(1)], [edit(0)],
      [todo('completed', 'in_progress', 'pending'), edit(1)], [todo('completed', 'completed', 'in_progress'), read(0), read(1)],
      [todo('completed', 'completed', 'completed')], [],
    ]
    let turn = 0
    const chat = vi.spyOn(aiService, 'chatWithTools').mockImplementation(async request => {
      const calls = turns[turn++]
      if (!calls) throw new Error('Unexpected additional model request')
      if (turn === 1) expect(request.messages.some(m => typeof m.content === 'string' && m.content.includes('同一工具轮更新进度'))).toBe(true)
      return { content: calls.length ? '' : '两章的清晨都已改为傍晚，并已回读。',
        toolCalls: calls.map((call, i) => ({ id: 'edit-' + turn + '-' + i, name: call.name, arguments: JSON.stringify(call.args) })),
        reasoning: '', finishReason: calls.length ? 'tool_calls' : 'stop',
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...subject, chapterId: null, mode: 'build', prompt, modelTier: 'speed' })
    const rows = await prisma.agentRunEvent.findMany({ where: { runId, type: 'tool.result' }, orderBy: { seq: 'asc' } })
    const results = rows.map(row => row.payload as { ok: boolean; toolName: string;
      display?: { chapterId?: string; revision?: number; items?: { status: string }[] } })
    expect(results.every(r => r.ok)).toBe(true)
    expect(results.filter(r => r.toolName === 'todo_write').map(r => r.display?.items?.filter(i => i.status === 'completed').length)).toEqual([0, 1, 2, 3])
    for (const chapter of chapters) {
      const edits = results.filter(r => r.toolName === 'chapter_edit_range' && r.display?.chapterId === chapter.id)
      const reads = results.filter(r => r.toolName === 'chapter_read' && r.display?.chapterId === chapter.id)
      expect(edits).toHaveLength(1)
      expect(reads.at(-1)?.display?.revision).toBe(edits[0].display?.revision)
      expect(results.indexOf(reads.at(-1)!)).toBeGreaterThan(results.indexOf(edits[0]))
    }
    expect(chat).toHaveBeenCalledTimes(turns.length)
  }), 60000)

  it.each(['plan', 'build'] as const)('sequential writing in %s mode settles the same requests for accurate and stale IDs', mode => fixture(async f => {
    const memoryRefresh = vi.spyOn(storyMemory, 'syncNovelMemoryProjection').mockResolvedValue({
      chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: true,
    })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 500000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'deepseek', modelName: 'deepseek-flash',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['high'],
      thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 })
    async function simulate(stale: boolean) {
      memoryRefresh.mockClear()
      const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '三章合成样本', slug: randomUUID(), summary: '' } })
      const parent = mode === 'plan' ? (await createNovelPlanArtifact(f.userId, novel.id, '合成大纲', { planKind: 'outline' })).item : null
      if (mode === 'build') {
        const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '合成卷', orderIndex: 1 } })
        await prisma.chapter.createMany({ data: Array.from({ length: 15 }, (_, index) => ({ novelId: novel.id, authorId: f.userId, volumeId: volume.id,
          title: `既有章${index + 1}`, content: '既有内容。', orderIndex: index + 1, orderInVolume: index + 1 })) })
      }
      const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '顺序写细纲' } })
      const runId = randomUUID(), prompt = mode === 'plan' ? '按同一大纲依次写第十六、十七、十八章细纲，再回到第十六章细纲补上收据，然后在第十八章细纲末补上回信。'
        : '依次写第十六、十七、十八章正文。回到第十六章末补上收据，然后在第十八章末补上回信。'
      const subject = { runId, userId: f.userId, novelId: novel.id, sessionId: session.id }
      await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: novel.id, sessionId: session.id,
        mode: mode === 'build' ? 'act' : 'plan', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
        status: 'queued', startRequest: withHumanAdmission({ novelId: novel.id, sessionId: session.id, prompt, mode }) } })
      let requests = 0
      vi.stubGlobal('fetch', async () => {
        requests++
        const calls: Array<{ name: string; args: Record<string, unknown> }> = []
        if (parent) {
          const create = (n: number, planId?: string) => ({ name: 'plan_save', args: { title: `第${n}章细纲`, content: `合成小节${n}`,
            planId, target: { kind: 'future', targetOrderIndex: n }, planKind: 'detail', parentPlanId: parent.id, expectedParentPlanHash: parent.planHash } })
          const plans = (await listNovelPlanArtifacts(f.userId, novel.id)).items
          const sixteen = plans.find(item => item.title === '第16章细纲'), seventeen = plans.find(item => item.title === '第17章细纲')
          const eighteen = plans.find(item => item.title === '第18章细纲')
          switch (requests) {
            case 1: calls.push({ name: 'plan_read', args: { planId: parent.id } }); break
            case 2: calls.push(create(16)); break
            case 3: calls.push(create(17, stale ? sixteen!.id : undefined), { name: 'plan_read', args: { planId: sixteen!.id } }); break
            case 4: calls.push({ name: 'plan_save', args: { mode: 'append', title: seventeen!.title, content: '回读前章后继续十七。',
              ...(stale ? {} : { planId: seventeen!.id }) } }, create(18)); break
            case 5: calls.push({ name: 'plan_save', args: { mode: 'append', planId: sixteen!.id, title: sixteen!.title, content: '补上收据。' } },
              { name: 'plan_save', args: { mode: 'append', planId: stale ? sixteen!.id : eighteen!.id, title: eighteen!.title, content: '补上回信。' } }); break
            case 6: break
            default: throw new Error('unexpected additional model request')
          }
        } else {
          const chapters = await prisma.chapter.findMany({ where: { novelId: novel.id, orderIndex: { gte: 16 } }, orderBy: { orderIndex: 'asc' } })
          const [sixteen, seventeen, eighteen] = chapters
          const newChapter = (n: number) => ({ name: 'chapter_create', args: { position: n, title: `合成章${n}` } })
          switch (requests) {
            case 1: calls.push(newChapter(16)); break
            case 2: calls.push({ name: 'chapter_write', args: { chapterId: sixteen.id, content: '合成小节16' } }, newChapter(17)); break
            case 3: calls.push({ name: 'chapter_read', args: { chapterId: sixteen.id } },
              { name: 'chapter_write', args: { chapterId: stale ? sixteen.id : seventeen.id, content: '合成小节17' } }, newChapter(18)); break
            case 4: calls.push({ name: 'chapter_read', args: { chapterId: seventeen.id } },
              { name: 'chapter_write', args: { ...(stale ? {} : { chapterId: eighteen.id }), content: '合成小节18' } }); break
            case 5: calls.push({ name: 'chapter_append', args: { targetOrderIndex: 16, chapterId: sixteen.id, content: '补上收据。' } },
              { name: 'chapter_append', args: { targetOrderIndex: 18, chapterId: stale ? sixteen.id : eighteen.id, content: '补上回信。' } }); break
            case 6: break
            default: throw new Error('unexpected additional model request')
          }
        }
        const delta = calls.length ? { tool_calls: calls.map(({ name, args }, index) => ({ index, id: `r${requests}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { content: '三章均已保存，第十六章已补上收据，第十八章已补上回信。' }
        const frame = { choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } }
        return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      await executeAgentRun({ ...subject, chapterId: null, mode, prompt, modelTier: 'speed', reasoningEffort: 'high' })
      const result = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      expect(result.status, result.errorMessage ?? '').toBe('completed')
      const content = mode === 'plan' ? (await listNovelPlanArtifacts(f.userId, novel.id)).items.filter(item => item.planKind === 'detail')
        : await prisma.chapter.findMany({ where: { novelId: novel.id, orderIndex: { gte: 16 } }, orderBy: { orderIndex: 'asc' } })
      expect(content.map(item => item.content)).toEqual(['合成小节16\n\n补上收据。', mode === 'plan' ? '合成小节17\n\n回读前章后继续十七。' : '合成小节17', '合成小节18\n\n补上回信。'])
      const payments = await prisma.aiUsageLog.findMany({ where: { agentRunId: runId }, orderBy: { turn: 'asc' } })
      expect(payments).toHaveLength(6)
      expect(payments.every(item => item.billingStatus === 'settled' && item.creditChargeMilli > 0)).toBe(true)
      const charges = payments.reduce((sum, row) => sum + row.creditChargeMilli, 0)
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId, kind: 'usage', referenceId: runId } })
      expect(ledger).toHaveLength(payments.length)
      expect(ledger.reduce((sum, debit) => sum - debit.deltaMilli, 0)).toBe(charges)
      return { requests, charges, memoryRefreshes: memoryRefresh.mock.calls.length }
    }
    const control = await simulate(false)
    expect(control).toMatchObject({ requests: 6, charges: 6 * credits.calculateTokenChargeMilli(2000, 100) })
    expect(await simulate(true)).toEqual(control)
  }), 60000)

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
