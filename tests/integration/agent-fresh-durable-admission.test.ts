import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Response as ExpressResponse } from 'express'
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/runtime-bootstrap.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/runtime-bootstrap.js')>(), dispatchFreshDurableRun: vi.fn(async () => {}) }))
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import { getAgentDefinition } from '../../api/lib/agent/agents.js'
import * as context from '../../api/lib/agent/context.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as executor from '../../api/lib/agent/runtime-executor.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { startLoopRun, initializePersistedLoopRun, continueLoopRun, stopLoopRun, recoverDurableLoopRuns } from '../../api/lib/agent/run-service.js'
import * as runService from '../../api/lib/agent/run-service.js'
import { dispatchFreshDurableRun, pauseFreshBootstrap, readFreshBootstrapAdmission } from '../../api/lib/agent/runtime-bootstrap.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import * as executionState from '../../api/lib/agent/runtime-state.js'
import { loadDurableEvents, isDurablePauseResumed, publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { listLoopSessionMessages } from '../../api/lib/agent/session-messages.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { streamDurableRun } from '../../api/lib/agent/runtime-stream.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'
import { env } from '../../api/config/env.js'
import { createAgentGoal, actOnAgentGoal, readAgentGoal } from '../../api/lib/agent/goal-service.js'
import { superviseAgentGoal } from '../../api/lib/agent/goal-supervisor.js'
import { createDurableTestLifecycle, DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS, type DurableTestLifecycle } from '../support/durable-test-lifecycle.js'
import { startDurableTestCpuProfile } from '../support/durable-test-cpu.js'

const realBootstrap = await vi.importActual<typeof import('../../api/lib/agent/runtime-bootstrap.js')>('../../api/lib/agent/runtime-bootstrap.js')
const originalRollout = env.agentDurableRolloutUserIds
const originalGoalEnabled = env.agentGoalEnabled
class StreamResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  chunks: string[] = []
  writeHead = vi.fn()
  write(chunk: string) { this.chunks.push(chunk); return true }
  end() { this.writableEnded = true }
  destroy() { this.destroyed = true }
}
afterEach(() => {
  env.agentDurableRolloutUserIds = originalRollout; env.agentGoalEnabled = originalGoalEnabled
  vi.mocked(dispatchFreshDurableRun).mockReset().mockResolvedValue(undefined)
  vi.clearAllMocks(); vi.restoreAllMocks()
})

async function ready(f: { userId: string; runId: string; rootId: string }) {
  env.agentDurableRolloutUserIds = [f.userId]
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed' } })
  await prisma.agentTaskRoot.update({ where: { id: f.rootId }, data: { status: 'completed' } })
  vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
    baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
    reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
  const features = flags.resolveAgent2FeatureFlags(f.userId)
  vi.spyOn(flags, 'resolveAgent2FeatureFlags').mockReturnValue({ ...features, storyCompiler: true, humanityQuality: true })
  vi.spyOn(context, 'assembleContext').mockImplementation(async input => ({ messages: [{ role: 'system', content: '合成原始任务边界' }, { role: 'user', content: input.prompt }],
    skillRoute: null, availableSkillVersions: [], timings: {} }))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No supplier is allowed in this bootstrap matrix') }))
}

const unknownUsage = (userId: string, novelId: string, runId: string) => prisma.aiUsageLog.create({ data: {
  userId, novelId, agentRunId: runId, targetType: 'agentRun', targetId: runId, providerType: 'text', providerMode: 'platform',
  modelName: 'fixture', action: 'agent', modelTier: 'speed', billingStatus: 'pending_usage', usageSource: 'unknown', durationMs: 1,
} })

/** CI exposes failure annotations without requiring restricted raw logs.
 * Observe the actual adapter calls; do not substitute an execution outcome. */
function observeBootstrapFailures(lifecycle?: DurableTestLifecycle) {
  const failures: Array<{ stage: string; message: string; code?: string }> = []
  const record = (stage: string, error: unknown) => failures.push({ stage, message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DataAccessError ? { code: error.code } : {}) })
  const initialize = runService.initializePersistedLoopRun, execute = runService.executePersistedLoopRun
  vi.spyOn(runService, 'initializePersistedLoopRun').mockImplementation(async (...args) => {
    try { return await (lifecycle ? lifecycle.phase('runtime.seed', () => initialize(...args)) : initialize(...args)) } catch (error) { record('initialize', error); throw error }
  })
  vi.spyOn(runService, 'executePersistedLoopRun').mockImplementation(async (...args) => {
    try { return await (lifecycle ? lifecycle.phase('step', () => execute(...args)) : execute(...args)) } catch (error) { record('execute', error); throw error }
  })
  return failures
}

async function bootstrapDiagnostic(runId: string, failures: ReturnType<typeof observeBootstrapFailures>) {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, errorMessage: true, taskRootId: true } })
  const frame = run.taskRootId ? await prisma.agentExecutionFrame.findFirst({ where: { taskRootId: run.taskRootId }, orderBy: { revision: 'desc' }, select: { snapshot: true } }) : null
  const snapshot = frame?.snapshot && typeof frame.snapshot === 'object' && !Array.isArray(frame.snapshot) ? frame.snapshot : null
  const operations = run.taskRootId ? await prisma.agentOperation.findMany({ where: { taskRootId: run.taskRootId },
    select: { kind: true, action: true, status: true, effectReceipt: { select: { result: true } } }, orderBy: { createdAt: 'asc' } }) : []
  const bootstrapPause = await prisma.agentExecutionOutbox.findFirst({ where: { runId, type: 'execution.bootstrap.paused' },
    orderBy: { sequence: 'desc' }, select: { payload: true } })
  return JSON.stringify({ ...run, failures, bootstrapPause: bootstrapPause?.payload, phase: snapshot?.phase, pendingOperationId: snapshot?.pendingOperationId,
    operations: operations.map(item => ({ kind: item.kind, action: item.action, status: item.status,
      result: (JSON.stringify(item.effectReceipt?.result) ?? '').slice(0, 600) })) })
}

describe.runIf(available)('fresh native admission and unstarted bootstrap', () => {
  it.each([
    { protocol: 'chat', source: 'footer' },
    { protocol: 'terra', source: 'footer' },
    { protocol: 'chat', source: 'visible-offer' },
    { protocol: 'terra', source: 'skip' },
  ] as const)('carries a $protocol $source suggestion decision from the same model request to history', ({ protocol, source }) => fixture(async f => {
    await ready(f)
    const terra = protocol === 'terra'
    if (terra) {
      const runtime = await credits.getModelTierRuntime('speed', f.userId)
      vi.mocked(credits.getModelTierRuntime).mockResolvedValue({ ...runtime, modelName: 'gpt-6.1-terra', baseUrl: 'https://yunshu.chevolink.com/v1' })
    }
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const answer = source === 'footer' ? '你好。' : '渡桥放在第一卷收尾。\n下一步建议：把渡桥段落分成三个场景。'
    const nextPrompt = source === 'footer' ? '帮我想一个短篇故事的开头' : '帮我把渡桥段落分成三个场景。'
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      const system = (terra ? request.input : request.messages).find((item: { role?: string }) => item.role === 'system')
      const marker = String(system?.content).match(/\[\[CHEVOINK_NEXT_PROMPT_[a-f0-9]{8}\]\]/u)?.[0]
      expect(marker).toBeTruthy()
      const proposal = source === 'skip' ? '[[CHEVOINK_NO_NEXT_PROMPT]]' : nextPrompt
      const text = source === 'visible-offer' ? answer : [answer, [marker, proposal].join(' ')].join(terra ? '\r\n  ' : '\n')
      const frame = terra ? { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ], usage: { input_tokens: 20, output_tokens: 5 } } }
        : { choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
    })
    vi.stubGlobal('fetch', fetcher)
    const run = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: source === 'footer' ? '你好' : '渡桥段落放在哪一卷合适？', mode: 'build',
      predictNextPrompt: true }, { humanOrigin: 'http' })
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.runId)
    const state = await loadExecutionState(f.userId, run.runId)
    expect(state.frame.state).toMatchObject({ phase: 'completed' })
    const candidate = state.frame.state.messages.at(-1)
    expect(candidate).toMatchObject({ role: 'assistant', content: answer })
    if (source === 'footer') expect(candidate).toMatchObject({ nextPrompt })
    else expect(candidate).not.toHaveProperty('nextPrompt')
    if (source === 'skip') expect(candidate).toMatchObject({ nextPromptSuppressed: true })
    const history = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
    const events = await loadDurableEvents(f.userId, run.runId, 0)
    expect(events.filter(event => event.type === 'text.final')).toEqual([expect.objectContaining({ text: answer })])
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded', outputSummary: answer })
    if (source === 'footer') expect(events.at(-1)).toMatchObject({ nextPrompt })
    else expect(events.at(-1)).not.toHaveProperty('nextPrompt')
    const saved = await prisma.agentMessage.findFirstOrThrow({ where: { runId: run.runId, role: 'assistant' } })
    expect(saved.parts).toEqual([{ type: 'text', text: answer }])
    expect(history.nextPrompt).toEqual(source === 'footer' ? { runId: run.runId, text: nextPrompt } : undefined)
    expect(history.messages.find(message => message.id === saved.id)?.parts).toEqual(saved.parts)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(terra ? 'https://yunshu.chevolink.com/v1/responses' : 'https://provider.invalid/v1/chat/completions', expect.any(Object))
  }))

  it('saves a verified plan and omits the prediction when the model returns no footer', ({ onTestFinished }) => fixture(async f => {
    await ready(f)
    // Admission and both model turns read this profile. Give the fixture the real
    // plan tool without persisting unrelated schemas on every durable step.
    const orchestrator = getAgentDefinition('orchestrator')
    const originalTools = orchestrator.tools
    onTestFinished(() => { orchestrator.tools = originalTools })
    orchestrator.tools = ['plan_save']
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const title = '渡桥情节', answer = '渡桥情节计划已保存。'
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      const afterTool = request.messages.some((message: { role: string }) => message.role === 'tool')
      expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name).sort()).toEqual(['execution_context_read', 'plan_save'])
      const choice = afterTool ? { delta: { content: answer }, finish_reason: 'stop' } : { delta: { tool_calls: [{
        index: 0, id: 'call_save_plan', function: { name: 'plan_save', arguments: JSON.stringify({ title, content: '渡桥发生在第一卷收尾。', planKind: 'outline' }) },
      }] }, finish_reason: 'tool_calls' }
      const frame = { choices: [choice], usage: { prompt_tokens: 20, completion_tokens: 5 } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
    })
    vi.stubGlobal('fetch', fetcher)
    const run = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '请制定并保存渡桥情节计划。', mode: 'build',
      predictNextPrompt: true }, { humanOrigin: 'http' })
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.runId)
    const state = await loadExecutionState(f.userId, run.runId)
    expect(state.frame.state.phase).toBe('completed')
    expect(state.frame.state.messages.at(-1)).not.toHaveProperty('nextPrompt')
    const plan = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: run.runId, artifactType: 'chapterPlan' } })
    expect(plan).toMatchObject({ title, content: '渡桥发生在第一卷收尾。' })
    const history = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
    expect(history.nextPrompt).toBeUndefined()
    const finished = (await loadDurableEvents(f.userId, run.runId, 0)).at(-1)
    expect(finished).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(finished).not.toHaveProperty('nextPrompt')
    expect(fetcher).toHaveBeenCalledTimes(2)
  }))

  it.each(['separate silent turns', 'same silent turn', 'separate speaking turns', 'same speaking turn'] as const)('replays only streamed model prose around saved outlines in %s', scenario => fixture(async f => {
    await ready(f)
    const orchestrator = getAgentDefinition('orchestrator')
    const originalTools = orchestrator.tools
    onTestFinished(() => { orchestrator.tools = originalTools })
    orchestrator.tools = ['plan_read', 'plan_save']
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const parent = await prisma.agentArtifact.create({ data: {
      runId: f.runId, artifactType: 'chapterPlan', title: '合成总纲', content: '过桥之后回信。', metadata: { savedAsPlan: true, planKind: 'outline' },
    } })
    const save = (n: number) => ({ id: `outline-${n}`, name: 'plan_save', args: {
      title: `第${n}章情节计划`, content: `合成情节${n}：信使检查封条。`, planKind: 'outline',
    } })
    const read = (id: string) => ({ id, name: 'plan_read', args: { planId: parent.id } })
    const sameTurn = scenario.startsWith('same')
    const speaks = scenario.includes('speaking')
    const plans = sameTurn ? [[read('research')], [save(19), read('reference'), save(20)]]
      : [[read('research')], [save(19), read('reference')], [save(20)]]
    const authorText = ['总纲以过桥和回信串起两章。', '上一份已保存，接下来写第二份。']
    const final = '两份情节计划已保存。'
    let index = 0
    const fetcher = vi.fn(async () => {
      const turn = index++
      const calls = plans[turn]
      const content = speaks ? authorText[turn - 1] : undefined
      const usage = { prompt_tokens: 20, completion_tokens: 5 }
      const frames = calls ? [{ choices: [{ delta: { tool_calls: calls.map((call, offset) => ({ index: offset, id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] },
      { choices: [{ delta: { content }, finish_reason: 'tool_calls' }], usage }]
        : [{ choices: [{ delta: { content: final }, finish_reason: 'stop' }], usage }]
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
    })
    vi.stubGlobal('fetch', fetcher)
    const run = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, mode: 'build',
      prompt: '查看总纲后，依次制定并保存第十九和第二十章的情节计划。',
    }, { humanOrigin: 'http' })
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.runId)
    expect((await loadExecutionState(f.userId, run.runId)).frame.state.phase).toBe('completed')
    const history = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
    const events = await loadDurableEvents(f.userId, run.runId, 0)
    const at = (type: string, id: string) => events.findIndex(event => event.type === type && 'callId' in event && event.callId === id)
    const journal = events.flatMap(event => 'callId' in event ? [{ type: event.type, callId: event.callId,
      ...('toolName' in event ? { tool: event.toolName } : {}), ...('ok' in event ? { ok: event.ok } : {}) }] : [])
    expect(journal, JSON.stringify(journal)).toEqual(expect.arrayContaining(['research', 'outline-19', 'outline-20']
      .map(callId => expect.objectContaining({ type: 'tool.result', callId, ok: true }))))
    expect(at('tool.result', 'research'), JSON.stringify(journal)).toBeGreaterThanOrEqual(0)
    expect(at('tool.result', 'outline-19')).toBeGreaterThan(at('tool.result', 'research'))
    expect(at('tool.result', 'outline-20')).toBeGreaterThan(at('tool.result', 'outline-19'))
    const prose = [...(speaks ? authorText.slice(0, sameTurn ? 1 : 2) : []), final]
    expect(events.flatMap(event => event.type === 'text.final' && event.text ? [event.text] : [])).toEqual(prose)
    expect(history.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts
      .flatMap(part => part.type === 'text' ? [part.text] : []))).toEqual(prose)
    if (speaks) {
      const firstReport = events.findIndex(event => event.type === 'text.final' && event.text === authorText[0])
      expect(firstReport).toBeGreaterThan(at('tool.result', 'research'))
      expect(firstReport).toBeLessThan(at('tool.call', 'outline-19'))
      if (!sameTurn) {
        const secondReport = events.findIndex(event => event.type === 'text.final' && event.text === authorText[1])
        expect(secondReport).toBeGreaterThan(at('tool.result', 'outline-19'))
        expect(secondReport).toBeLessThan(at('tool.call', 'outline-20'))
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(plans.length + 1)
  }), 30_000)

  it.each(['fresh', 'resumed'] as const)('starts the %s live clock at the same activation as history', scenario => fixture(async f => {
    await ready(f)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '你好' }, { humanOrigin: 'http' })
    await initializePersistedLoopRun(f.userId, admitted.runId)
    const initial = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    let runId = initial.id, previousElapsed = 0
    if (scenario === 'resumed') {
      const first = vi.spyOn(executor, 'runReviewedDurableExecution').mockImplementationOnce(async lease => ({
        kind: 'needs_attention', reason: '合成暂停前边界', frame: (await loadExecutionState(lease.userId, lease.runId)).frame,
      }))
      await runService.executePersistedLoopRun(f.userId, runId)
      first.mockRestore()
      await stopLoopRun(f.userId, runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId, type: 'run.paused' } })
      const paused = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
      const pausedTiming = paused.messages.find(message => message.runId === runId)?.runTiming
      expect(pausedTiming).toMatchObject({ activeSince: null, status: 'paused' })
      previousElapsed = pausedTiming!.elapsedMs!
      expect(previousElapsed).toBeGreaterThan(0)
      runId = (await resumeDurableTask({ userId: f.userId, runId, pauseEventId: pause.id })).run.id
    }
    const response = new StreamResponse()
    const stream = streamDurableRun(f.userId, runId, 0, response as unknown as ExpressResponse, f.sessionId)
    const streamed = (): AgentStreamEvent[] => response.chunks.flatMap(chunk => chunk.split('\n')
      .flatMap(line => line.startsWith('data: ') ? [JSON.parse(line.slice(6)) as AgentStreamEvent] : []))
    let resolveProvider!: () => void
    const providerGate = new Promise<void>(resolve => { resolveProvider = resolve })
    const fetcher = vi.fn(async () => {
      await providerGate
      return new Response('data: {"choices":[{"delta":{"content":"你好。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\ndata: [DONE]\n\n')
    })
    vi.stubGlobal('fetch', fetcher)
    let work: ReturnType<typeof runService.executePersistedLoopRun> | undefined
    try {
      await vi.waitFor(() => expect(streamed().find(event => event.type === 'run.started')).toMatchObject({
        durableTiming: { sourceRunId: runId, activeSince: null, elapsedMs: previousElapsed },
      }), { timeout: 4000 })
      await new Promise(resolve => setTimeout(resolve, 5000))
      expect(fetcher).not.toHaveBeenCalled()
      expect(streamed().some(event => event.durableTiming?.activeSince)).toBe(false)
      work = runService.executePersistedLoopRun(f.userId, runId)
      await vi.waitFor(() => expect(streamed().find(event => event.type === 'execution.progress' && event.durableTiming?.activeSince)).toBeTruthy(), { timeout: 5000 })
      const live = streamed().find(event => event.type === 'execution.progress' && event.durableTiming?.activeSince)!
      const activated = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      const initialEvent = (await loadDurableEvents(f.userId, runId, 0)).find(event => event.type === 'run.started')!
      expect(initialEvent).not.toHaveProperty('durableTiming')
      expect(streamed().find(event => event.type === 'run.started')?.ts).toBe(initialEvent.ts)
      expect(activated.startedAt!.getTime() - Date.parse(initialEvent.ts)).toBeGreaterThanOrEqual(5000)
      expect(live.durableTiming).toMatchObject({ activeSince: activated.startedAt!.toISOString(), elapsedMs: previousElapsed, status: 'running' })
      const history = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
      expect(history.messages.find(message => message.runId === initial.id)?.runTiming).toEqual(live.durableTiming)
      resolveProvider()
      await work
      await stream
      const terminal = streamed().find(event => event.type === 'run.finished')?.durableTiming
      const after = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
      expect(terminal).toMatchObject({ status: 'finished', activeSince: null })
      expect(terminal).toEqual(after.messages.find(message => message.runId === initial.id)?.runTiming)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      resolveProvider()
      response.emit('close')
      await Promise.allSettled([stream, work])
    }
  }), 30_000)

  it('does not opt a fresh durable HTTP task into legacy terminal response schemas', () => fixture(async f => {
    const runtime = { tier: 'speed' as const, multiplierBps: 0, provider: 'fixture', modelName: 'fixture-main',
      baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high' as const, reasoningEfforts: ['high' as const],
      visionEnabled: false, contextWindowTokens: 128000 }
    vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    env.agentDurableRolloutUserIds = [f.userId]
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '新持久问答' } })
    const result = await startLoopRun(f.userId, { novelId: f.novelId, sessionId: session.id, chapterId: f.chapterId,
      prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })
    expect(run.runtimeProtocolVersion).toBe(1)
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(spec.responseDeliveryProtocol).toBeUndefined()
    const { getToolsForMode } = await import('../../api/lib/agent/tools/registry.js')
    const { restrictToolsToTask } = await import('../../api/lib/agent/tool-authority.js')
    expect(restrictToolsToTask(getToolsForMode('build'), spec).some(tool => tool.name === 'task_respond')).toBe(false)
  }))

  it('a fresh add-volumes confirmation in an old session freezes only named creates and executes the real durable create path', () => fixture(async f => {
    await ready(f)
    vi.mocked(flags.resolveAgent2FeatureFlags).mockReturnValue({ ...flags.resolveAgent2FeatureFlags(f.userId), volume: true })
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    await prisma.agentMessage.create({ data: { runId: f.runId, sessionId: f.sessionId, role: 'assistant', parts: [{ type: 'text',
      text: '请在目录里新增三个空卷，卷名是《第二卷 渡桥》《第三卷 灯塔》《第四卷 归港》。之后还可以挂细纲和核对卷序。' }] } })
    const admitted = await startLoopRun(f.userId, { novelId: f.novelId, sessionId: f.sessionId, prompt: '你帮我加', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(run.id).not.toBe(f.runId)
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: false, structure: false, artifact: false })
    expect(spec.scope.volumeCreateIntent?.targets.map(target => target.title)).toEqual(['渡桥', '灯塔', '归港'])
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).taskSpec).toEqual(before.taskSpec)
    const state = await initializePersistedLoopRun(f.userId, run.id)
    expect(state.configuration.toolAuthority.find(tool => tool.name === 'volume_create')?.permission).toBe('allow')
    expect(state.configuration.toolAuthority.some(tool => tool.name === 'volume_update')).toBe(true)
    const { acquireRunLease } = await import('../../api/lib/agent/runtime-lease.js')
    const { saveExecutionState } = await import('../support/native-tool-test-state.js')
    const { executeDurableToolStep } = await import('../../api/lib/agent/runtime-tool-step.js')
    const lease = await acquireRunLease({ userId: f.userId, runId: run.id, ownerId: 'named-volume-fixture', claimId: randomUUID() })
    const current = await loadExecutionState(f.userId, run.id)
    await saveExecutionState(lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: null, toolCalls: ['渡桥', '灯塔', '归港', '渡桥'].map((title, index) => ({ id: `create-${index}`, name: 'volume_create', arguments: JSON.stringify({ title }) })) }] } })
    for (let index = 0; index < 4; index++) expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { observedState: { kind: 'volume' } } })
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(4)
    expect((await prisma.volume.findMany({ where: { novelId: f.novelId }, orderBy: { orderIndex: 'asc' } })).slice(1).map(volume => volume.title)).toEqual(['渡桥', '灯塔', '归港'])
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('retains original HTTP bootstrap event identity after later goal activation binding', () => fixture(async f => {
    await ready(f)
    env.agentGoalEnabled = true
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    await pauseFreshBootstrap(f.userId, admitted.runId, 'SYNTHETIC_FAILURE')
    await continueLoopRun(f.userId, admitted.runId)
    await initializePersistedLoopRun(f.userId, admitted.runId)
    const history = await loadDurableEvents(f.userId, admitted.runId, 0)
    const originalPause = history.find(event => event.type === 'run.paused')!
    await stopLoopRun(f.userId, admitted.runId)
    const goal = await createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId: randomUUID(), objective: '保留原任务', options: { mode: 'build' } })
    try {
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
      // Replay the existing activation binding shape, not a new native issuer.
      await prisma.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: 1n, continuationIndex: 1,
        runId: run.id, taskRootId: run.taskRootId, trigger: 'author', sourceEventId: `activation:${goal.id}:${run.id}` } })
      expect((await prisma.$transaction(tx => readFreshBootstrapAdmission(tx, f.userId, run.id))).goalSource).toBeNull()
      expect(await isDurablePauseResumed(f.userId, run.id, originalPause.seq)).toBe(true)
      await publishDurableEvents(f.userId, run.id)
      expect((await loadDurableEvents(f.userId, run.id, 0)).at(-1)?.type).toBe('run.paused')
      expect(fetch).not.toHaveBeenCalled()
    } finally { await prisma.agentGoal.delete({ where: { id: goal.id } }) }
  }))

  it.each(['http', 'legacy-http', 'unmarked-http', 'internal', 'rollout-disabled', 'tampered-command', 'altered-start'] as const)('first goal %s uses its original creation authority, never a user-role inference', scenario => fixture(async f => {
    await ready(f)
    env.agentGoalEnabled = true
    if (scenario === 'rollout-disabled') env.agentDurableRolloutUserIds = []
    const objective = '完整重写第一章正文。'
    const requestId = randomUUID()
    const goal = await createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId, objective,
      options: { mode: 'build', chapterId: f.chapterId, qualityMode: 'balanced', creativeFreedom: 'balanced' } },
    scenario === 'internal' ? undefined : { authenticatedHttp: true })
    try {
      if (scenario === 'legacy-http' || scenario === 'unmarked-http') {
        const revision = await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: 1 } } })
        const request = revision.request as { nativeAdmission: { envelope: object }; [key: string]: unknown }
        const { nativeAdmission, ...options } = request
        const historical = runtimeJson({ ...options, ...(scenario === 'legacy-http'
          ? { nativeAdmission: { version: 1, origin: 'http', envelope: nativeAdmission.envelope } } : {}) }).value
        await prisma.agentGoalRevision.update({ where: { goalId_revision: { goalId: goal.id, revision: 1 } }, data: { request: historical,
          authorityHash: runtimeJson({ objective: revision.objective, request: historical, novelId: f.novelId, userId: f.userId }).hash } })
      }
      if (scenario === 'tampered-command') await prisma.agentGoalCommand.update({ where: { userId_requestId: { userId: f.userId, requestId } }, data: { requestHash: '0'.repeat(64) } })
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      if (scenario === 'tampered-command') {
        expect(await prisma.agentGoalExecution.count({ where: { goalId: goal.id } })).toBe(0)
        expect((await readAgentGoal(f.userId, f.sessionId))?.status).toBe('blocked')
        expect(dispatchFreshDurableRun).not.toHaveBeenCalled()
        return
      }
      const binding = await prisma.agentGoalExecution.findFirstOrThrow({ where: { goalId: goal.id } })
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: binding.runId } })
      if (scenario === 'internal' || scenario === 'rollout-disabled' || scenario === 'unmarked-http') {
        expect(run.runtimeProtocolVersion).toBe(0)
        expect(taskSpecSchema.parse(run.taskSpec).scope.continuityReportProtocol).toBeUndefined()
        expect(dispatchFreshDurableRun).not.toHaveBeenCalled()
        return
      }
      expect(run).toMatchObject({ runtimeProtocolVersion: 1, status: 'queued', taskRootId: binding.taskRootId })
      const scope = taskSpecSchema.parse(run.taskSpec).scope
      expect(scope.writingCoordinationProtocol).toBe(scenario === 'legacy-http' ? 1 : 2)
      if (scenario === 'legacy-http') expect(scope.continuityReportProtocol).toBeUndefined()
      else expect(scope.continuityReportProtocol).toBe(5)
      expect(binding).toMatchObject({ trigger: 'author', continuationIndex: 1, sourceEventId: `${goal.id}:1:1` })
      if (scenario === 'altered-start') {
        await prisma.agentRun.update({ where: { id: run.id }, data: { startRequest: { ...run.startRequest as object, qualityMode: 'premium' } } })
        await expect(prisma.$transaction(tx => readFreshBootstrapAdmission(tx, f.userId, run.id))).rejects.toMatchObject({ code: 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' })
        expect(context.assembleContext).not.toHaveBeenCalled()
      } else {
        const initialized = await initializePersistedLoopRun(f.userId, run.id)
        expect(initialized.frame.state.messages.some(message => message.content === objective)).toBe(true)
        expect((await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: run.id } })).taskRootId).toBe(run.taskRootId)
      }
      expect(executeAgentRun).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally { await prisma.agentGoal.delete({ where: { id: goal.id } }) }
  }))

  it.each(['bootstrap-error', 'goal-pause'] as const)('first goal %s resumes the same unstarted root via the real goal control', scenario => fixture(async f => {
    await ready(f)
    env.agentGoalEnabled = true
    const goal = await createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId: randomUUID(), objective: '写第2至6章正文。',
      options: { mode: 'build' }, limits: { activeTimeLimitMs: 60_000 } }, { authenticatedHttp: true })
    try {
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      const original = await prisma.agentRun.findFirstOrThrow({ where: { goalExecution: { goalId: goal.id } } })
      expect(original.runtimeProtocolVersion).toBe(1)
      expect(original.startRequest).not.toHaveProperty('creativeFreedom')
      expect(original.taskSpec).toMatchObject({ creativeFreedom: 'stable' })
      const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: original.taskRootId! } })
      if (scenario === 'bootstrap-error') {
        vi.mocked(context.assembleContext).mockRejectedValueOnce(new Error('synthetic initialization failure'))
        await realBootstrap.dispatchFreshDurableRun(f.userId, original.id)
      } else {
        const active = (await readAgentGoal(f.userId, f.sessionId))!
        await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: active.stateVersion, action: 'pause' })
      }
      const paused = (await readAgentGoal(f.userId, f.sessionId))!
      expect(paused.status).toBe(scenario === 'goal-pause' ? 'paused' : 'blocked')
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('paused')
      await expect(continueLoopRun(f.userId, original.id)).rejects.toMatchObject({ code: 'GOAL_RESUME_REQUIRED' })
      env.agentDurableRolloutUserIds = []
      const resumed = await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume' })
      expect(resumed).toMatchObject({ phase: 'executing', activeSince: expect.any(String) })
      expect(resumed.activeTimeMs).toBe(paused.activeTimeMs)
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      expect(await prisma.agentGoalExecution.count({ where: { goalId: goal.id } })).toBe(1)
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: original.taskRootId! } })).toEqual(budget)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('queued')
      const current = await prisma.agentGoal.findUniqueOrThrow({ where: { id: goal.id } })
      expect((await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: original.id } })).epoch).toBe(current.epoch)
      await initializePersistedLoopRun(f.userId, original.id)
      expect(await prisma.agentExecutionState.count({ where: { taskRootId: original.taskRootId! } })).toBe(1)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
      await prisma.agentGoal.update({ where: { id: goal.id }, data: { activeSince: new Date(Date.now() - 60_001) } })
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      expect((await readAgentGoal(f.userId, f.sessionId))?.status).toBe('budget_limited')
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: original.id } })).enabled).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally { await prisma.agentGoal.delete({ where: { id: goal.id } }) }
  }))

  it.each(['bounded-write', 'conversation', 'research', 'internal', 'rollout-disabled'] as const)('%s freezes identity before dispatch, without upgrading old runs', scenario => fixture(async f => {
    await ready(f)
    if (scenario === 'rollout-disabled') env.agentDurableRolloutUserIds = []
    const prompt = scenario === 'bounded-write' ? '续写下一章正文。' : scenario === 'research' ? '联网搜索《合成作品》，研究叙事技巧。' : '你好'
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt, mode: 'build' },
      scenario === 'internal' ? {} : { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    if (scenario === 'internal' || scenario === 'rollout-disabled') {
      expect(run.runtimeProtocolVersion).toBe(0)
      expect(run.taskRootId).toBeNull()
      expect(spec.scope.capabilityCatalog).toBeUndefined()
      expect(executeAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }))
      return
    }
    expect(run).toMatchObject({ runtimeProtocolVersion: 1, status: 'queued', taskRootId: spec.id })
    expect(dispatchFreshDurableRun).toHaveBeenCalledWith(f.userId, run.id)
    expect(executeAgentRun).not.toHaveBeenCalled()
    expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: run.id } })).enabled).toBe(true)
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: spec.id } })).toBe(0)
    const source = await prisma.$transaction(tx => readFreshBootstrapAdmission(tx, f.userId, run.id))
    expect(source.root.requestSnapshot).toEqual([{ type: 'text', text: prompt }])
    if (scenario === 'bounded-write') expect(spec.scope).toMatchObject({ writingCoordinationProtocol: 2, continuityReportProtocol: 5 })
    else expect(spec.scope.writingCoordinationProtocol).toBeUndefined()
    const initial = await initializePersistedLoopRun(f.userId, run.id)
    expect(initial.originalSpec).toEqual(source.root.specSnapshot)
    expect(initial.frame.state.messages.at(-1)?.content).toBe(prompt)
    expect(initial.configuration.tools.map(tool => tool.function.name)).toEqual(initial.configuration.toolAuthority.map(tool => tool.name))
    const before = { configuration: initial.head.configurationHash, frame: initial.frame.snapshotHash, budget: await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: spec.id } }) }
    vi.mocked(context.assembleContext).mockRejectedValueOnce(new Error('A saved frame must not assemble again'))
    expect((await initializePersistedLoopRun(f.userId, run.id)).head.configurationHash).toBe(before.configuration)
    expect((await loadExecutionState(f.userId, run.id)).frame.snapshotHash).toBe(before.frame)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: spec.id } })).toEqual(before.budget)
    expect(await pauseFreshBootstrap(f.userId, run.id, 'SYNTHETIC_FAILURE')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it.each(['bootstrap-error', 'user-stop', 'tampered-resume'] as const)('%s preserves the original request/budget and resumes without replaying an old terminal event', scenario => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: run.taskRootId! } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })
    if (scenario === 'user-stop') await stopLoopRun(f.userId, run.id)
    else {
      vi.mocked(context.assembleContext).mockRejectedValueOnce(new DataAccessError(409, 'SYNTHETIC_CONTEXT_UNAVAILABLE', 'synthetic'))
      await realBootstrap.dispatchFreshDurableRun(f.userId, run.id)
    }
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('paused')
    env.agentDurableRolloutUserIds = [] // stopping rollout never rewrites an admitted task
    const continued = await continueLoopRun(f.userId, run.id)
    expect(continued.runId).toBe(run.id)
    expect(continued.eventStartSeq).toBeGreaterThan(0)
    expect(await loadDurableEvents(f.userId, run.id, continued.eventStartSeq!)).toEqual([])
    const history = await loadDurableEvents(f.userId, run.id, 0)
    const paused = history.find(event => event.type === 'run.paused')!
    expect(history.at(-1)).toMatchObject({ type: 'run.started', authorContinue: { afterSeq: paused.seq } })
    expect(await isDurablePauseResumed(f.userId, run.id, paused.seq)).toBe(true)
    expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: root.id } })).toEqual({ ...root, status: 'active' })
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })).toEqual(budget)
    expect(await prisma.agentOperation.count({ where: { taskRootId: root.id } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: run.id } })).toBe(0)
    expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: root.id } })).toBe(0)
    expect(await prisma.agentMessage.count({ where: { runId: run.id, role: 'user' } })).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    if (scenario === 'tampered-resume') {
      const source = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `bootstrap-resume:${(await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: run.id, type: 'execution.bootstrap.paused' } })).id}` } })
      await prisma.agentExecutionOutbox.update({ where: { id: source.id }, data: { payload: { ...(source.payload as object), inputHash: '0'.repeat(64) } } })
      await expect(isDurablePauseResumed(f.userId, run.id, paused.seq)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    } else {
      await stopLoopRun(f.userId, run.id)
      await publishDurableEvents(f.userId, run.id)
      const stopped = (await loadDurableEvents(f.userId, run.id, continued.eventStartSeq!)).at(-1)!
      expect(stopped.type).toBe('run.paused')
      expect(await isDurablePauseResumed(f.userId, run.id, stopped.seq)).toBe(false)
    }
  }))

  it.each(['foreign', 'tampered-request', 'operation', 'unknown-usage', 'missing-legacy-source'] as const)('%s cannot acquire a fresh bootstrap recovery', scenario => fixture(async f => {
    await ready(f)
    if (scenario === 'missing-legacy-source') {
      await expect(pauseFreshBootstrap(f.userId, f.runId, 'FAILURE')).rejects.toMatchObject({ code: 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' })
      return
    }
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    if (scenario === 'foreign') {
      await expect(prisma.$transaction(tx => readFreshBootstrapAdmission(tx, 'foreign-owner', run.id))).rejects.toThrow()
      return
    }
    if (scenario === 'tampered-request') await prisma.agentRun.update({ where: { id: run.id }, data: { startRequest: { prompt: '修改其他章节' } } })
    if (scenario === 'operation') await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: run.taskRootId!, originRunId: run.id,
      operationKey: 'never-replay', kind: 'provider', action: 'chat', inputSnapshot: {}, inputHash: runtimeJson({}).hash } })
    if (scenario === 'unknown-usage') await unknownUsage(f.userId, f.novelId, run.id)
    await expect(pauseFreshBootstrap(f.userId, run.id, 'FAILURE')).rejects.toMatchObject({ code: scenario === 'tampered-request' ? 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' : 'RUNTIME_STATE_REQUIRED' })
    const assembleCalls = vi.mocked(context.assembleContext).mock.calls.length
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.id)
    expect(context.assembleContext).toHaveBeenCalledTimes(assembleCalls)
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('queued')
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('discovers a queued no-frame admission and dispatches the original native task only once', () => fixture(async f => {
    await ready(f)
    const failures = observeBootstrapFailures()
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    // Admission dispatch is intentionally async. Let its no-op fixture finish
    // before the recovery scan becomes the sole real dispatcher for this case.
    await vi.waitFor(() => expect(dispatchFreshDurableRun).toHaveBeenCalledWith(f.userId, admitted.runId))
    const execute = vi.spyOn(executor, 'runReviewedDurableExecution').mockImplementation(async lease => ({ kind: 'needs_attention', reason: 'synthetic boundary', frame: (await loadExecutionState(lease.userId, lease.runId)).frame }))
    // Discovery is global: another parallel fixture can precede this owner.
    // Exercise this exact source, never spend the one-shot mock on a peer run.
    vi.mocked(dispatchFreshDurableRun).mockImplementation(async (userId, runId) => {
      if (runId === admitted.runId) await realBootstrap.dispatchFreshDurableRun(userId, runId)
    })
    expect(await recoverDurableLoopRuns()).toContainEqual({ runId: admitted.runId, status: 'dispatched' })
    expect(execute, await bootstrapDiagnostic(admitted.runId, failures)).toHaveBeenCalledTimes(1)
    expect(executeAgentRun).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('a Stop during context assembly revokes the original admission before any frame or provider request', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const original = vi.mocked(context.assembleContext).getMockImplementation()!
    vi.mocked(context.assembleContext).mockImplementationOnce(async input => { await blocked; return original(input) })
    const work = realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
    try {
      await vi.waitFor(() => expect(context.assembleContext).toHaveBeenCalledTimes(1))
      await stopLoopRun(f.userId, admitted.runId)
    } finally { release() }
    await work
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    expect(run.status).toBe('paused')
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: run.id } })).enabled).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it.each(['fee-race', 'stop-after-lease'] as const)('%s is rechecked inside the original lease before the first frame', scenario => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: run.taskRootId! } })
    const initialize = executionState.initializeExecutionState
    vi.spyOn(executionState, 'initializeExecutionState').mockImplementationOnce(async (lease, input) => {
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: run.id } })).ownerId).toBe(lease.ownerId)
      if (scenario === 'stop-after-lease') await stopLoopRun(f.userId, run.id)
      else await unknownUsage(f.userId, f.novelId, run.id)
      return initialize(lease, input)
    })
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.id)
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: run.taskRootId! } })).toEqual(budget)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(scenario === 'stop-after-lease' ? 'paused' : 'queued')
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: run.id } })).toBe(scenario === 'fee-race' ? 1 : 0)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('a real DB-backed Continue stream waits for initialization instead of closing on its previous pause', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    await stopLoopRun(f.userId, admitted.runId)
    const resumed = await continueLoopRun(f.userId, admitted.runId)
    const response = new StreamResponse()
    const pending = streamDurableRun(f.userId, admitted.runId, resumed.eventStartSeq!, response as unknown as ExpressResponse)
    try {
      await vi.waitFor(() => expect(response.writeHead).toHaveBeenCalled())
      expect(response.writableEnded).toBe(false)
      await initializePersistedLoopRun(f.userId, admitted.runId)
      await vi.waitFor(() => expect(response.chunks.join('')).toContain(`id: ${resumed.eventStartSeq! + 1}\nevent: run.started`), { timeout: 2000, interval: 10 })
      expect(response.writableEnded).toBe(false)
    } finally { response.emit('close'); await pending }
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('two dispatchers share the original frame and cannot overlap a live executor', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const execute = vi.spyOn(executor, 'runReviewedDurableExecution').mockImplementation(async lease => {
      await blocked
      return { kind: 'needs_attention', reason: 'synthetic boundary', frame: (await loadExecutionState(lease.userId, lease.runId)).frame }
    })
    const first = realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      await realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await prisma.agentTaskRoot.count({ where: { userId: f.userId, status: 'active' } })).toBe(1)
    } finally { release(); await first }
    expect(context.assembleContext).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('current read-only policy narrows a fresh frozen writing catalog before the first model request', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt: '续写下一章正文。', mode: 'build' }, { humanOrigin: 'http' })
    await prisma.agentSession.update({ where: { id: f.sessionId }, data: { sandboxMode: 'read_only' } })
    const initial = await initializePersistedLoopRun(f.userId, admitted.runId)
    expect(initial.configuration.toolAuthority.some(grant => grant.name === 'chapter_write')).toBe(false)
    expect(initial.configuration.tools.some(tool => tool.function.name === 'chapter_write')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('runs a genuine fresh writer through real read, coordinated body/reviews/commit and natural completion', { timeout: DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS }, async ({ signal }) => {
    const lifecycle = createDurableTestLifecycle(signal, entry => console.info('[durable-quality-stage]', JSON.stringify(entry)))
    // Keep sampling opt-in: the timing control and covered run use the same
    // assertions without inspector startup cost.
    const stopCpu = process.env.CHEVOINK_TEST_CPU_PROFILE === '1' ? await startDurableTestCpuProfile() : undefined
    try { await fixture(async f => {
    await ready(f)
    const failures = observeBootstrapFailures(lifecycle)
    // The derivative is owned by the native executor, not a parallel legacy job.
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
      rateCardId: 'fresh-writer-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
    const content = '他停在原地，尚未行动。'
    const scene = { purpose: '等候', goal: '保留当前位置', obstacle: '尚未行动', choice: '继续等待', cost: '耗费时间', turn: '停在原地',
      entryState: {}, exitState: {}, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }
    let mainCalls = 0, criticCalls = 0
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      lifecycle.mockRequest()
      const body = JSON.parse(String(init.body))
      let delta: object
      if (body.tools) {
        mainCalls++
        if (mainCalls > 2) throw Error('Fresh completion must not request another main-model loop')
        const visible = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
        for (const name of ['story_compiler_prepare', 'scene_task_build', 'chapter_read', 'chapter_write', 'chapter_bridge_commit']) expect(visible).toContain(name)
        delta = mainCalls === 1 ? { tool_calls: [
          { index: 0, id: 'fresh-prepare', type: 'function', function: { name: 'story_compiler_prepare', arguments: JSON.stringify({ chapterId: f.chapterId, intentSummary: '完整重写第一章正文' }) } },
          { index: 1, id: 'fresh-scenes', type: 'function', function: { name: 'scene_task_build', arguments: JSON.stringify({ tasks: [scene] }) } },
          { index: 2, id: 'fresh-read', type: 'function', function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          { index: 3, id: 'fresh-writer', type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content }) } },
          { index: 4, id: 'fresh-quality', type: 'function', function: { name: 'quality_analyze', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          { index: 5, id: 'fresh-continuity', type: 'function', function: { name: 'continuity_validate', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          { index: 6, id: 'fresh-commit', type: 'function', function: { name: 'chapter_bridge_commit', arguments: JSON.stringify({ chapterSummary: '仍停在原地' }) } },
        ] } : { content: '第一章已保存并完成核对。' }
      } else {
        criticCalls++
        expect(body.reasoning_effort).toBe('none')
        expect(body.thinking?.type).not.toBe('enabled')
        if (criticCalls > 2) throw Error('A successful current-version report must not be paid twice')
        expect(body.messages[1].content).toContain(content)
        delta = { content: '{"findings":[]}' }
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt: '完整重写第一章正文。', mode: 'build', qualityMode: 'balanced' }, { humanOrigin: 'http' })
    const initial = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    expect(taskSpecSchema.parse(initial.taskSpec).scope).toMatchObject({ writingCoordinationProtocol: 2, continuityReportProtocol: 5 })
    await realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })).status,
      await bootstrapDiagnostic(admitted.runId, failures)).toBe('completed')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content, revision: 2 })
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: admitted.runId }, include: { bridge: true } })
    expect(compilation).toMatchObject({ status: 'completed', bridge: { committedAt: expect.any(Date) }, validation: { independentCheck: 'complete', checkedRevision: 2 } })
    expect(await prisma.chapterQualityReport.findFirstOrThrow({ where: { runId: admitted.runId } })).toMatchObject({ chapterRevision: 2 })
    expect(criticCalls).toBe(2)
    expect(mainCalls).toBeGreaterThanOrEqual(1)
    expect(await prisma.agentOperation.count({ where: { taskRootId: initial.taskRootId!, kind: 'tool', action: 'chapter_write' } })).toBe(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(fetcher.mock.calls.length)
    expect(executeAgentRun).not.toHaveBeenCalled()
    }, undefined, '修改本章', { lifecycle })
    } finally { if (stopCpu) console.info('[durable-quality-cpu]', JSON.stringify(await stopCpu())) }
  })
})
