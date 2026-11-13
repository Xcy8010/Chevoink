import { describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_NOVEL_SUMMARY } from '../../shared/contracts/novel-publish.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as durableRollout from '../../api/lib/agent/fresh-durable-rollout.js'
import { readSessionPendingQuestion, resolveLoopRunQuestion } from '../../api/lib/agent/run-service.js'
import { runReviewedDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { parkDurableQuestion, resolveDurableQuestion } from '../../api/lib/agent/runtime-question.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { novelCreateTool } from '../../api/lib/agent/tools/novel-tools.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { initializeExecutionState, saveExecutionState } from '../support/native-tool-test-state.js'

vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/runtime-bootstrap.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/runtime-bootstrap.js')>(),
  dispatchFreshDurableRun: vi.fn(async () => {}),
}))

const prompt = '帮我创建一部末日生存类型的小说'
const fields = { title: '漫长的停电', summary: '旧城区的幸存者互助求生。', tags: ['都市'] }

async function completeNovelSetup(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  // An older task in the same session cannot provide this root's metadata proof.
  await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
    mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'completed', createdAt: new Date(0) } })
  await prisma.chapter.delete({ where: { id: f.chapterId } })
  await prisma.novel.update({ where: { id: f.novelId }, data: { title: '未命名作品', displayTitle: null, summary: BOOTSTRAP_NOVEL_SUMMARY } })
  let lease = await claim(f)
  const signal = new AbortController().signal
  const tools = [askUserTool, novelCreateTool]
  await initializeExecutionState(lease, { configuration: {
    version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
    nextPromptMarker: '[[CHEVOINK_NEXT_PROMPT_91a5ed28]]',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: toOpenAITools(tools, f.spec.scope),
    toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })),
    protectedChapterIds: [], pinnedSkillVersions: [],
  }, snapshot: {
    version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
    messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [{
      id: 'choose-direction', name: 'ask_user', arguments: JSON.stringify({ purpose: 'novel_direction', question: '你想写哪一种末日？',
        options: [{ label: '长期断电' }, { label: '冰期' }] }),
    }] }],
  } })
  const waiting = await executeDurableToolStep(lease, signal)
  if (waiting.kind !== 'waiting_question' || !waiting.requestId) throw new Error('Expected original question')
  if (waiting.longWait) await expect(parkDurableQuestion(lease, waiting.requestId)).resolves.toBe(true)
  await resolveDurableQuestion({ userId: f.userId, runId: f.runId, callId: 'choose-direction', requestId: waiting.requestId, answer: '长期断电' })
  if (waiting.longWait) lease = await claim(f)
  await executeDurableToolStep(lease, signal)
  const { frame } = await loadExecutionState(f.userId, f.runId)
  await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
    snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null,
      toolCalls: [{ id: 'confirmed-create', name: 'novel_create', arguments: JSON.stringify(fields) }] }] } })
  await expect(runReviewedDurableExecution(lease, signal)).resolves.toMatchObject({ kind: 'completed' })
}

describe.runIf(available)('completed durable question followup', () => {
  it.each(['answer', 'cancel', 'historical'] as const)('preserves completion and usage after %s', async scenario => {
    await fixture(async f => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('This fixture must never call a provider') }))
      await completeNovelSetup(f)
      const readQuestion = () => readSessionPendingQuestion(f.userId, f.sessionId).then(result => result.question)
      const question = await readQuestion()
      if (scenario === 'historical') {
        expect(question).toBeNull()
        return
      }
      expect(question).toMatchObject({ runId: f.runId, state: 'completed', question: '要不要先设置一下作品封面，还是直接开始写大纲？',
        options: [{ label: '先讨论并拟定作品封面方向' }, { label: '开始写大纲' }] })
      expect((await publishDurableEvents(f.userId, f.runId, 200)).at(-1)).toMatchObject({
        type: 'run.finished', status: 'succeeded', nextPrompt: '先讨论并拟定作品封面方向',
      })
      if (!question) throw new Error('Expected completed followup question')
      const { requestId, callId } = question
      const offer = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: requestId } })
      expect(offer).toMatchObject({ runId: f.runId, taskRootId: f.rootId, type: 'question.followup.offered' })
      await expect(resolveLoopRunQuestion(f.userId, f.runId, 'different-call', { answer: '开始写大纲' }, requestId))
        .rejects.toMatchObject({ code: 'QUESTION_NOT_PENDING' })
      const sourceBefore = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId }, select: { status: true, finishedAt: true, usage: true } })
      const usageBefore = await prisma.agentProviderUsageReceipt.count({ where: { attempt: { operation: { taskRootId: f.rootId } } } })
      const countRuns = () => prisma.agentRun.count({ where: { sessionId: f.sessionId } })
      const before = await countRuns()
      const submit = (decision: { answer: string } | { cancelled: true }) => resolveLoopRunQuestion(f.userId, f.runId, callId, decision, requestId)
      if (scenario === 'cancel') {
        await expect(submit({ cancelled: true })).resolves.toEqual({ resolved: true })
        await expect(submit({ cancelled: true })).resolves.toEqual({ resolved: true })
        await expect(submit({ answer: '开始写大纲' })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
        expect(await countRuns()).toBe(before)
      } else {
        vi.spyOn(durableRollout, 'isFreshDurableAdmissionEnabled').mockReturnValue(true)
        vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
        vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({
          tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-only',
          reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native',
          thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null,
        })
        const answer = '开始写大纲'
        const [first, replay] = await Promise.all([submit({ answer }), submit({ answer })])
        expect(first).toEqual({ resolved: true, runId: expect.any(String), messageId: expect.any(String) })
        expect(replay).toEqual(first)
        if (!first.runId) throw new Error('Expected a new continuation run')
        const target = await prisma.agentRun.findUniqueOrThrow({ where: { id: first.runId } })
        expect(target).toMatchObject({ sessionId: f.sessionId, userId: f.userId, novelId: f.novelId, startRequest: { prompt: answer, predictNextPrompt: true } })
        expect(target.taskRootId).not.toBe(f.rootId)
        await expect(submit({ answer: '先讨论大纲方向' })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
        expect(await countRuns()).toBe(before + 1)
      }
      expect(await readQuestion()).toBeNull()
      expect(sourceBefore.status).toBe('completed')
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId }, select: { status: true, finishedAt: true, usage: true } })).toEqual(sourceBefore)
      expect(await prisma.agentProviderUsageReceipt.count({ where: { attempt: { operation: { taskRootId: f.rootId } } } })).toBe(usageBefore)
      expect(await prisma.agentExecutionOutbox.count({ where: { eventKey: `question-followup-decision:${requestId}` } })).toBe(1)
    }, undefined, prompt, { novelInitializationProtocol: 2, agentQuestionProtocol: scenario === 'historical' ? 1 : 2 })
  })
})
