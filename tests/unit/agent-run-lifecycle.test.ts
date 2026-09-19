import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentStreamEventBody, AgentTodoItem, TaskSpec } from '../../shared/contracts/index.js'
import type { AgentTool, ToolContext, ToolResult } from '../../api/lib/agent/tools/types.js'
import type { chatWithTools as chatType } from '../../api/lib/ai-service.js'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(), emit: vi.fn(), persist: vi.fn(async () => ({})), dispose: vi.fn(async () => {}),
  update: vi.fn<(input: { data: Record<string, unknown> }) => Promise<{ taskSpec: TaskSpec | null; usage?: unknown; currentTurn?: number; startedAt?: Date; events?: Array<{ type: string; createdAt: Date }> }>>(async () => ({ taskSpec: null })), previous: vi.fn(async () => null),
  todos: vi.fn(async (): Promise<AgentTodoItem[]> => []),
  priorRuns: vi.fn(),
  report: vi.fn(async () => ({ chineseCharacters: 0, content: '' })),
  original: vi.fn<() => Promise<{ parts: Array<{ type: string; text: string }> } | null>>(async () => ({ parts: [{ type: 'text', text: '核对原任务的剩余工作。' }] })),
  tools: [] as AgentTool[],
  hiddenTools: [] as AgentTool[],
  skillReceipt: vi.fn(async () => ({})), skillLoads: vi.fn(async (...args: unknown[]) => { void args }),
}))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message) }
  },
  prisma: {
    agentRun: { update: mocks.update, findFirst: mocks.previous, findMany: mocks.priorRuns },
    agentSession: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    agentMessage: { upsert: mocks.persist, findUnique: vi.fn(async () => null), findFirst: mocks.original },
    agentSkillRun: { upsert: mocks.skillReceipt },
  },
}))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: vi.fn(async () => ({ tier: 'speed', contextWindowTokens: 128000 })) }))
vi.mock('../../api/lib/agent/agents.js', () => ({
  getAgentDefinition: () => ({ type: 'test', model: 'test', title: '测试' }),
  getToolsForAgent: () => mocks.tools,
  applySessionToolPolicy: (tools: AgentTool[]) => tools,
}))
vi.mock('../../api/lib/agent/tools/registry.js', () => ({ allTools: [], getToolByName: (name: string) => [...mocks.tools, ...mocks.hiddenTools].find(tool => tool.name === name), toOpenAITools: () => [] }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ registerActiveRun: vi.fn(), deregisterActiveRun: vi.fn() }))
vi.mock('../../api/lib/agent/baseline.js', () => ({ clearRunBaselines: vi.fn() }))
vi.mock('../../api/lib/agent/context.js', () => ({ assembleContext: vi.fn(async () => ({ messages: [] })), insertSubagentCatalog: vi.fn() }))
vi.mock('../../api/lib/agent/skills/receipts.js', () => ({ recordSkillLoads: mocks.skillLoads }))
vi.mock('../../api/lib/agent/skills/service.js', async () => ({ resolveEnabledRuntimeSkills: vi.fn(async () => (await import('../../api/lib/agent/skills/index.js')).skillCatalog) }))
vi.mock('../../api/lib/agent/context-engine.js', () => ({ captureUserDirectives: vi.fn(), compactSessionContext: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/story-memory.js', () => ({ syncNovelMemoryProjection: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/research-sources.js', () => ({ readResearchReportForDelivery: mocks.report }))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ resolveAgent2FeatureFlags: () => ({}) }))
vi.mock('../../api/lib/agent/events.js', () => ({ createRunEventBus: () => ({ emit: mocks.emit, emitTransient: mocks.emit,
  commitTerminal: async (body: AgentStreamEventBody, work: (tx: { agentRun: { update: typeof mocks.update } }) => Promise<unknown>) => ({
    result: await work({ agentRun: { update: mocks.update } }), publish: () => mocks.emit(body),
  }),
}), disposeRunEventBus: mocks.dispose }))
vi.mock('../../api/lib/agent/permissions.js', () => ({ cancelAllQuestions: vi.fn(), grantAlwaysAllow: vi.fn(), hasAlwaysAllow: () => false, rejectAllApprovals: vi.fn(), waitForApproval: vi.fn() }))
vi.mock('../../api/lib/agent/tools/todo-tools.js', () => ({ loadSessionTodoItems: mocks.todos, renderTodoItems: (items: AgentTodoItem[]) => JSON.stringify(items) }))
vi.mock('../../api/lib/agent/task-lineage.js', () => ({ getTaskRunIds: async () => ['run'] }))
vi.mock('../../api/lib/agent/tools/task-orchestration-tools.js', () => ({ ORCHESTRATION_TOOL_NAMES: new Set(), assertOrchestrationResumeGuard: vi.fn(), buildOrchestrationResumeNote: vi.fn() }))
vi.mock('../../api/lib/agent/session-title.js', () => ({ autoNameSession: vi.fn() }))

const { executeAgentRun, handleToolCall } = await import('../../api/lib/agent/loop.js')
const { runSubagentInline } = await import('../../api/lib/agent/subagent-runner.js')
const { env } = await import('../../api/config/env.js')
const { buildTaskSpec } = await import('../../api/lib/agent/task-spec.js')
const { DataAccessError } = await import('../../api/lib/prisma.js')
const { assembleContext } = await import('../../api/lib/agent/context.js')
type Response = Awaited<ReturnType<typeof chatType>>
const response = (content = '已完成。', toolCalls: Response['toolCalls'] = [], tokens = 10): Response => ({ content, toolCalls, reasoning: '', finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens, promptCacheHitTokens: null, promptCacheMissTokens: null } })
const call = (id: string, name = 'chapter_read', args = '{}') => ({ id, name, arguments: args })
const events = () => mocks.emit.mock.calls.map(([event]) => event as AgentStreamEventBody)
function tool(name: string, execute: () => Promise<ToolResult>, readOnly = true): AgentTool {
  return { name, title: name, description: '', readOnly, parameters: z.any(), permission: { plan: 'allow', build: 'allow', review: 'allow' }, execute: vi.fn(execute) }
}
async function run(prompt = '检查当前章节', tokenBudget?: number) {
  await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt, tokenBudget })
  expect(events().filter(event => event.type === 'error')).toEqual([])
}
function queue(...responses: Response[]) {
  for (const item of responses) mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
    for (const pending of item.toolCalls) input.onChunk?.({ type: 'tool-call-start', id: pending.id, name: pending.name })
    return item
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.chat.mockReset()
  mocks.report.mockReset()
  mocks.report.mockResolvedValue({ chineseCharacters: 0, content: '' })
  mocks.original.mockReset()
  mocks.original.mockResolvedValue({ parts: [{ type: 'text', text: '核对原任务的剩余工作。' }] })
  mocks.todos.mockResolvedValue([])
  mocks.previous.mockResolvedValue(null)
  mocks.priorRuns.mockReset()
  mocks.priorRuns.mockResolvedValue([])
  mocks.tools = [tool('chapter_read', async () => ({ output: '当前章节正文' }))]
  mocks.hiddenTools = []
})

function context(): ToolContext {
  return {
    userId: 'user', novelId: 'novel', chapterId: null, sessionId: 'session', runId: 'run',
    callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
    signal: new AbortController().signal, emit: mocks.emit,
  }
}

describe('phase skills in the real execution loop', () => {
  it('restores cached phases across chapters and after the active hint is compacted away', async () => {
    const { routeSkills } = await import('../../api/lib/agent/skills/index.js')
    vi.mocked(assembleContext).mockResolvedValueOnce({ messages: [], skillRoute: routeSkills({ mode: 'build', intent: 'write', prompt: '续写正文', freedom: 'balanced' }) })
    mocks.tools = ['story_compiler_prepare', 'scene_task_build', 'chapter_write'].map(name => tool(name, async () => ({ output: '已完成阶段' })))
    const stages: Array<{ name: string; expected: string | null }> = [
      { name: 'story_compiler_prepare', expected: null },
      { name: 'scene_task_build', expected: '/ scene /' },
      { name: 'chapter_write', expected: '/ draft /' },
      { name: 'story_compiler_prepare', expected: '/ critique /' },
      { name: 'scene_task_build', expected: '/ scene /' },
      { name: 'chapter_write', expected: '/ draft /' },
    ]
    for (const [index, stage] of stages.entries()) mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      const hints = input.messages.filter(message => typeof message.content === 'string' && message.content.includes('系统·创作阶段工作方法'))
      if (stage.expected) { expect(hints).toHaveLength(1); expect(hints[0].content).toContain(stage.expected) }
      return response('', [call(`stage${index}`, stage.name, JSON.stringify({ chapter: index }))])
    })
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      const index = input.messages.findIndex(message => typeof message.content === 'string' && message.content.includes('系统·创作阶段工作方法'))
      expect(index).toBeGreaterThanOrEqual(0)
      input.messages.splice(index, 1) // emulate the existing checkpoint compactor
      return response('', [call('read-after-compaction', 'chapter_write', '{"chapter":7}')])
    })
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      expect(input.messages.filter(message => typeof message.content === 'string' && message.content.includes('系统·创作阶段工作方法'))).toHaveLength(1)
      return response('已完成。')
    })
    await run('续写正文')
    expect(mocks.chat).toHaveBeenCalledTimes(8)
    expect(events().filter(event => event.type === 'skill.route' && event.phase === 'scene')).toHaveLength(1)
  })
  it('loads the new phase once between complete tool batches without extra model requests', async () => {
    const { routeSkills } = await import('../../api/lib/agent/skills/index.js')
    vi.mocked(assembleContext).mockResolvedValueOnce({ messages: [], skillRoute: routeSkills({ mode: 'build', intent: 'plan', prompt: '规划大纲', freedom: 'balanced' }) })
    mocks.tools = [tool('scene_task_build', async () => ({ output: '场景已建立' }))]
    queue(response('', [call('s1', 'scene_task_build')]), response('', [call('s2', 'scene_task_build', '{"chapter":2}')]), response('已完成。'))
    await run('规划并续写正文')
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(events().filter(event => event.type === 'skill.route' && event.phase === 'draft')).toHaveLength(1)
    const messages = mocks.chat.mock.calls[1][0].messages as Array<{ role: string; content?: string; toolCallId?: string }>
    const digestAt = messages.findIndex(message => message.content?.includes('系统·创作阶段工作方法'))
    expect(digestAt).toBeGreaterThan(messages.findIndex(message => message.role === 'tool' && message.toolCallId === 's1'))
    expect(mocks.skillLoads.mock.calls.some(args => args[3] === 'phase')).toBe(true)
  })
  it('does not load a stage for a failed tool', async () => {
    const { routeSkills } = await import('../../api/lib/agent/skills/index.js')
    vi.mocked(assembleContext).mockResolvedValueOnce({ messages: [], skillRoute: routeSkills({ mode: 'build', intent: 'plan', prompt: '规划大纲', freedom: 'balanced' }) })
    mocks.tools = [tool('scene_task_build', async () => { throw new Error('fixture failure') })]
    queue(response('', [call('s1', 'scene_task_build')]), response('场景未完成。'))
    await run('规划并续写正文')
    expect(events().filter(event => event.type === 'skill.route')).toHaveLength(1)
  })
})

describe('BYOK paid-tool isolation', () => {
  it.each(['web_search', 'research_dossier_build', 'cover_generate', 'view_image'])('keeps %s quota failure local to the paid tool', async name => {
    const ctx = context()
    const runtime = await (await import('../../api/lib/credits.js')).getModelTierRuntime()
    ctx.modelRuntime = { ...runtime, tier: 'custom', multiplierBps: 0 }
    const admitted = tool(name, async () => { throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '平台额度不足') })
    const result = await handleToolCall(call('paid', name), [admitted], ctx, { emit: mocks.emit }, 'message', 'run')
    expect(result.part.status).toBe('failed')
    expect(result.observation).toContain('自定义文本模型')
    expect(result.observation).toContain('不要重复调用')
  })
  it('does not swallow platform quota errors for a built-in model', async () => {
    const admitted = tool('web_search', async () => { throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '平台额度不足') })
    await expect(handleToolCall(call('paid', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
  })
  it('keeps platform quota failure local to the paid tool for the zero-rate free tier', async () => {
    const ctx = context()
    const runtime = await (await import('../../api/lib/credits.js')).getModelTierRuntime()
    ctx.modelRuntime = { ...runtime, tier: 'lite', multiplierBps: 0, provider: 'deepseek', modelName: 'fixture-free', baseUrl: null, apiKey: null,
      reasoningEffort: 'low', reasoningEfforts: ['low', 'high', 'max'], visionEnabled: false }
    const admitted = tool('web_search', async () => { throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '平台额度不足') })
    const result = await handleToolCall(call('paid', 'web_search'), [admitted], ctx, { emit: mocks.emit }, 'message', 'run')
    expect(result.part.status).toBe('failed')
    expect(result.observation).toContain('免费模型')
    expect(result.observation).toContain('不要重复调用')
  })
})

describe('original task context on resume', () => {
  it.each(['quality_analyze', 'continuity_validate', 'creative_critique', 'cover_generate'])('stops repeated %s provider failures even when parameters change within a batch', async name => {
    const failing = tool(name, async () => { throw new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'gateway timeout') })
    mocks.tools = [failing]
    queue(response('', [call('q1', name, '{"compilationId":"first"}'), call('q2', name, '{"compilationId":"second"}'), call('q3', name, '{}')]), response('操作未完成，正文保留。'))
    await run()
    expect(failing.execute).toHaveBeenCalledTimes(2)
    expect(events().filter(event => event.type === 'tool.result')).toEqual(expect.arrayContaining([expect.objectContaining({ summary: '模型网关超时', ok: false })]))
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'failed' }))
  })
  it('announces parameter preparation before the model finishes, without admitting execution early', async () => {
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      input.onChunk?.({ type: 'tool-call-start', id: 'preparing-read', name: 'chapter_read' })
      expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.delta', callId: 'preparing-read', toolName: 'chapter_read', title: 'chapter_read', argsChars: 0 }))
      expect(events().filter(event => event.type === 'tool.call')).toEqual([])
      input.onChunk?.({ type: 'tool-call-arguments-delta', id: 'preparing-read', delta: ' '.repeat(1024) })
      expect(events().filter(event => event.type === 'tool.delta').at(-1)).toMatchObject({ toolName: 'chapter_read', argsChars: 1024 })
      expect(mocks.tools[0].execute).not.toHaveBeenCalled()
      return response('', [call('preparing-read')])
    })
    queue(response('已核对。'))
    await run()
    expect(events().filter(event => event.type === 'tool.call').map(event => event.callId)).toEqual(['preparing-read'])
    expect(mocks.tools[0].execute).toHaveBeenCalledOnce()
  })
  it('restores the complete research request on typed continue and does not revive legacy writing authority', async () => {
    const originalPrompt = '搜索并拆解这本小说，不要写章节。' + '核对人物与情节证据。'.repeat(130)
    const taskSpec = { ...buildTaskSpec({ runId: 'original', novelId: 'novel', prompt: originalPrompt }), intent: 'write' as const }
    const prior = { id: 'original', taskSpec, usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      status: 'paused', currentTurn: 1, startedAt: new Date() }
    mocks.previous.mockResolvedValue(prior as never)
    mocks.priorRuns.mockResolvedValue([prior])
    mocks.original.mockResolvedValue({ parts: [{ type: 'text', text: originalPrompt }] })
    const write = tool('chapter_write', async () => ({ output: 'must not write' }), false)
    mocks.tools.push(write)
    queue(response('', [call('forbidden', 'chapter_write')]), response('资料不足，未改动作品。'))
    await run('继续')
    expect(write.execute).not.toHaveBeenCalled()
    expect(assembleContext).toHaveBeenCalledWith(expect.objectContaining({
      prompt: originalPrompt + '\n\n[用户本次要求] 继续',
      taskSpec: expect.objectContaining({ id: taskSpec.id, intent: 'research_analysis' }),
    }))
    expect(mocks.original).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sessionId: 'session', role: 'user', run: expect.objectContaining({ userId: 'user', novelId: 'novel',
        taskSpec: { path: ['id'], equals: taskSpec.id } }),
    }) }))
  })
  it('does not call the model when typed continuation has lost the original request', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', prompt: '分析这本小说' })
    mocks.previous.mockResolvedValue({ id: 'original', taskSpec } as never)
    mocks.original.mockResolvedValue(null)
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null,
      mode: 'build', prompt: '继续' })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'run_input_required' }))
  })
  it('does not accept a claimed complete report when persisted sections are still short', async () => {
    mocks.chat.mockResolvedValue(response('完整研究报告已完成。'))
    await run('拆解这本小说，研究报告至少10000字。')
    expect(mocks.report).toHaveBeenCalledTimes(5)
    expect(mocks.report).toHaveBeenCalledWith({ userId: 'user', novelId: 'novel', sessionId: 'session', runId: 'run' })
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(mocks.tools.some(item => item.name === 'todo_write')).toBe(false)
  })
  it('continues missing report sections and finishes only after persisted length reaches the requirement', async () => {
    let saved = 100
    const content = '# 研究报告\n\n已经保存的结构与人物分析。'
    mocks.report.mockImplementation(async () => ({ chineseCharacters: saved, content }))
    mocks.tools.push(tool('research_report_save', async () => {
      saved = 10000
      return { output: '已保存缺失区块，报告共10000个汉字。' }
    }, false))
    queue(response('报告已完成。'), response('', [call('save-section', 'research_report_save')]), response('研究结果如下。'))
    await run('拆解这本小说，研究报告至少10000字。')
    expect(mocks.report).toHaveBeenCalledTimes(2)
    expect(mocks.tools.at(-1)?.execute).toHaveBeenCalledTimes(1)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'text.final', text: content, asReasoning: false }))
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      parts: expect.arrayContaining([{ type: 'text', text: content }]),
    }) }))
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('does not require a research artifact for ordinary chapter tasks', async () => {
    queue(response('已完成。'))
    await run('写第十九章。')
    expect(mocks.report).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('narrows a legacy misclassified research run on explicit resume and persists the same task identity', async () => {
    const prompt = '搜索并拆解这本小说，不要写章节。'
    const legacy = { ...buildTaskSpec({ runId: 'run', novelId: 'novel', prompt }), intent: 'write' as const }
    mocks.update.mockResolvedValueOnce({ ...{ taskSpec: legacy }, usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      currentTurn: 1, startedAt: new Date() })
    const write = tool('chapter_write', async () => ({ output: 'must not write' }), false)
    mocks.tools.push(write)
    queue(response('', [call('blocked-resume', 'chapter_write')]), response('资料不足，未改动作品。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null,
      mode: 'build', prompt, resume: true })
    expect(write.execute).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      taskSpec: expect.objectContaining({ id: legacy.id, intent: 'research_analysis' }),
    }) }))
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'blocked-resume', ok: false }))
  })
  it.each(['chapter_write', 'plan_save', 'memory_save', 'task_send', 'subagent_delegate'])('rejects model-requested %s during book research even with an allowed registry tool', async toolName => {
    const write = tool(toolName, async () => ({ output: 'must not write' }), false)
    mocks.tools.push(write)
    queue(response('', [call('forbidden-write', toolName)]), response('资料不足，未改动作品。'))
    await run('搜索并拆解这本小说，不要写章节。')
    expect(write.execute).not.toHaveBeenCalled()
    const { captureUserDirectives } = await import('../../api/lib/agent/context-engine.js')
    expect(captureUserDirectives).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'forbidden-write', ok: false }))
  })
  it.each([false, true])('preserves the exact request and run identity when resume=%s', async resume => {
    const prompt = '只完成第19章，不能重开旧章节的任务窗口。' + '原始详细要求。'.repeat(100)
    queue(response('已完成。'))
    if (resume) mocks.update.mockResolvedValueOnce({ taskSpec: null,
      ...{ usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 }, currentTurn: 1, startedAt: new Date() } })
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null,
      mode: 'build', prompt, resume, selection: { text: '本次选区', start: 0, end: 4 } })
    expect(assembleContext).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', prompt,
      includeCurrentRunHistory: resume, selection: { text: '本次选区', start: 0, end: 4 } }))
    expect(events().filter(event => event.type === 'error')).toEqual([])
    if (resume) {
      expect(mocks.persist).not.toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ role: 'user' }) }))
      expect(mocks.previous).not.toHaveBeenCalled()
    }
  })
})

describe('persisted legacy checkpoint budgets', () => {
  const resume = () => executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel',
    chapterId: null, mode: 'build', prompt: '继续原任务', resume: true })
  it('preserves the full previously granted slice after a provider response overshot the automatic ceiling', async () => {
    const started = Date.now() - 1000
    const tokenBudget = env.agentRunTokenBudgetCeiling + 2_006_003
    const checkpoint = { version: 1, runStartedAt: started, resumeCount: 2, compactionCount: 2,
      maxTurns: env.agentMaxTurns + 150, tokenBudget, manualResumeCount: 1,
      writeProgress: 2, writeBaseline: 2, readProgress: 2, readBaseline: 2, progressSignatures: [] }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 2, startedAt: new Date(started),
      usage: { promptTokens: tokenBudget - 3000, completionTokens: 0, totalTokens: tokenBudget - 3000, checkpoint } })
    queue(response('已完成。'))
    await resume()
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ checkpoint: { tokenBudget, manualResumeCount: 1 } })
  })
  it('resumes actual work after a paused gap without resetting token consumption', async () => {
    const now = Date.now(), started = now - (env.agentRunWallClockMinutes + 10) * 60_000
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 1, startedAt: new Date(started),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      events: [{ type: 'run.started', createdAt: new Date(started) },
        { type: 'run.paused', createdAt: new Date(started + 60_000) }] })
    queue(response('已完成。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded',
      usage: expect.objectContaining({ totalTokens: 130 }) }))
  })

  it('does not pay for another wrap-up when actual execution time is exhausted', async () => {
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 1,
      startedAt: new Date(Date.now() - (env.agentRunWallClockMinutes + 1) * 60_000),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } })
    await resume()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'failed',
      usage: expect.objectContaining({ totalTokens: 120 }) }))
  })

  it('retains cumulative usage, earned slices, progress and the original clock on resume', async () => {
    const started = Date.now() - 1000
    const checkpoint = { version: 1, runStartedAt: started, resumeCount: 1, compactionCount: 1,
      maxTurns: env.agentMaxTurns + 50, tokenBudget: 4000000,
      writeProgress: 2, writeBaseline: 2, readProgress: 3, readBaseline: 3, progressSignatures: ['existing-evidence'] }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 2, startedAt: new Date(started),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint } } })
    queue(response('已完成。'))
    await resume()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished',
      usage: expect.objectContaining({ promptTokens: 110, completionTokens: 20, totalTokens: 130 }) }))
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data).toMatchObject({ currentTurn: 3, usage: { checkpoint } })
    expect(mocks.update.mock.calls[0]?.[0].data).not.toHaveProperty('startedAt')
  })

  it('does not call the provider or overwrite corrupt saved usage with zero', async () => {
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 8,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint: { version: 999 } } } })
    await resume()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.update.mock.calls.every(([input]) => !Object.hasOwn(input.data, 'usage'))).toBe(true)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'run_checkpoint_unconfirmed' }))
  })

  it('grants a bounded manual slice to a ceiling-exhausted chain on explicit resume', async () => {
    const started = Date.now() - 60_000
    const ceiling = env.agentRunTokenBudgetCeiling
    const checkpoint = { version: 1, runStartedAt: started, resumeCount: 2, compactionCount: 2,
      maxTurns: env.agentMaxTurns + 100, tokenBudget: ceiling,
      writeProgress: 5, writeBaseline: 5, readProgress: 5, readBaseline: 5, progressSignatures: [],
      inheritedTokens: ceiling + 6_003 - 1_285_735, inheritedTurns: 56, inheritedExecutionMs: 60_000 }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 19, startedAt: new Date(started),
      usage: { promptTokens: 1_285_735, completionTokens: 0, totalTokens: 1_285_735, checkpoint } } })
    queue(response('已完成。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded' }))
    expect(events().some(event => event.type === 'text.final' && event.text.includes('手动续跑 1/2'))).toBe(true)
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ checkpoint: {
      manualResumeCount: 1, tokenBudget: ceiling + 6_003 + 2_000_000, maxTurns: env.agentMaxTurns + 150 } })
  })

  it('stops an explicit resume before any provider request once manual grants are used up', async () => {
    const ceiling = env.agentRunTokenBudgetCeiling
    const checkpoint = { version: 1, runStartedAt: Date.now(), resumeCount: 4, compactionCount: 4,
      maxTurns: env.agentMaxTurns + 300, tokenBudget: ceiling + 4_000_000,
      writeProgress: 5, writeBaseline: 5, readProgress: 5, readBaseline: 5, progressSignatures: [],
      inheritedTokens: ceiling + 4_000_000 - 1_000_000, inheritedTurns: 70, manualResumeCount: 2 }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 3, startedAt: new Date(),
      usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, checkpoint } } })
    await resume()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(events().some(event => event.type === 'text.final' && event.text.includes('手动续跑机会已用完'))).toBe(true)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'failed' }))
  })

  it('grants a bounded manual slice to a checkpoint-less exhausted historical run instead of a paid wrap-up', async () => {
    const ceiling = env.agentRunTokenBudgetCeiling
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 2, startedAt: new Date(),
      usage: { promptTokens: ceiling, completionTokens: 0, totalTokens: ceiling } } })
    queue(response('已完成。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded' }))
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ checkpoint: {
      manualResumeCount: 1, tokenBudget: ceiling + 2_000_000, maxTurns: env.agentMaxTurns + 50 } })
  })

  it('keeps confirmed stream usage when stopped before a complete model response', async () => {
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      input.onUsage?.({ promptTokens: 40, completionTokens: null, totalTokens: null })
      input.onUsage?.({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
      throw new DOMException('stopped', 'AbortError')
    })
    await run('检查当前章节')
    const paused = mocks.update.mock.calls.find(([input]) => input.data.status === 'paused')?.[0]
    expect(paused?.data.usage).toMatchObject({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
    expect(mocks.chat).toHaveBeenCalledOnce()
  })

  it('counts the final usage delta once after intermediate stream observations', async () => {
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      input.onUsage?.({ promptTokens: 20, completionTokens: null, totalTokens: null })
      input.onUsage?.({ promptTokens: 40, completionTokens: 0, totalTokens: 40 })
      return response('已完成。', [], 50)
    })
    await run('检查当前章节')
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished',
      usage: { promptTokens: 50, completionTokens: 0, totalTokens: 50 } }))
  })
})

describe('tool execution authority (real dispatch, mocked global registry)', () => {
  it('closes a resolved failure with a failed terminal event, without claiming an effect', async () => {
    const admitted = tool('chapter_write', async () => ({ outcome: 'failed', output: '正文已由作者修改，未覆盖。', summary: '正文变更未执行' }), false)
    const result = await handleToolCall(call('conflict', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(admitted.execute).toHaveBeenCalledOnce()
    expect(result.part).toMatchObject({ status: 'failed', summary: '正文变更未执行' })
    expect(result.part.snapshot).toBeUndefined()
    expect(result.observation).toContain('未覆盖')
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ callId: 'conflict', ok: false, summary: '正文变更未执行' }),
    ])
  })

  it('closes a throwing normalizer without executing or exposing its private exception', async () => {
    const admitted = { ...tool('scene_task_build', async () => ({ output: '不应执行' })), coerceArgs: vi.fn(() => { throw new Error('private-payload') }) }
    const result = await handleToolCall(call('normalize', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(admitted.execute).not.toHaveBeenCalled()
    expect(result.part.status).toBe('failed')
    expect(result.observation).not.toContain('private-payload')
    expect(events().filter(event => event.type === 'tool.call')).toHaveLength(1)
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ callId: 'normalize', ok: false, summary: '参数归一化失败' }),
    ])
  })

  it.each(['chapter_write', 'task_create', 'subagent_delegate', 'memory_save'])('cannot resurrect excluded %s from the global registry', async name => {
    const hidden = tool(name, async () => ({ output: '不应执行' }), false)
    mocks.hiddenTools = [hidden]
    const result = await handleToolCall(call('excluded', name), mocks.tools, context(), { emit: mocks.emit }, 'message', 'run')
    expect(hidden.execute).not.toHaveBeenCalled()
    expect(result.part.status).toBe('denied')
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ callId: 'excluded', ok: false }),
    ])
  })

  it('rejects an excluded malformed call before coercion or retry advice', async () => {
    const hidden = { ...tool('chapter_write', async () => ({ output: '' }), false), coerceArgs: vi.fn(() => ({})) }
    mocks.hiddenTools = [hidden]
    const result = await handleToolCall(call('excluded', hidden.name, '{'), [], context(), { emit: mocks.emit }, 'message', 'run')
    expect(result.part.status).toBe('denied')
    expect(result.observation).not.toContain('请修正后重试')
    expect(hidden.coerceArgs).not.toHaveBeenCalled()
    expect(hidden.execute).not.toHaveBeenCalled()
  })

  it('still executes an explicitly admitted writing tool', async () => {
    const admitted = tool('chapter_write', async () => ({ output: '合法写作' }), false)
    const result = await handleToolCall(call('allowed', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(admitted.execute).toHaveBeenCalledOnce()
    expect(result.part.status).toBe('success')
  })

  it('does not regain a hidden writing tool during a real continuation loop', async () => {
    const hidden = tool('chapter_write', async () => ({ output: '不应执行' }), false)
    mocks.hiddenTools = [hidden]
    queue(response('', [call('hidden-resume', hidden.name)]), response('当前任务无写入授权，未修改正文。'))
    await run('继续')
    expect(hidden.execute).not.toHaveBeenCalled()
    expect(events().filter(event => event.type === 'tool.result')).toContainEqual(expect.objectContaining({ callId: 'hidden-resume', ok: false }))
  })

  it.each(['granted', 'empty', 'missing', 'unknown-role', 'orchestrator-role'] as const)('respects a %s parent snapshot through the real inline runner', async authority => {
    const candidate = tool('chapter_read', async () => ({ output: '已读' }))
    candidate.permission = { plan: 'deny', build: 'deny', review: 'allow' }
    mocks.tools = [candidate]
    const parent = context()
    parent.mode = 'plan'
    if (authority !== 'missing') parent.toolAuthority = authority !== 'empty'
      ? new Map([['chapter_read', { permission: 'allow', alwaysConfirm: false, dangerous: false }]])
      : new Map()
    queue(response('', [call('child-read')]), response('已读取。'))
    const result = await runSubagentInline({
      subagentCallId: 'child', subtaskRunId: 'subrun', name: '一致性', role: authority === 'unknown-role' ? 'invalid' : authority === 'orchestrator-role' ? 'orchestrator' : 'continuity',
      triggerCondition: '', prompt: '', task: '读取', mode: 'review', parentRunId: 'run',
      sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, messageId: 'message',
      modelRuntime: await (await import('../../api/lib/credits.js')).getModelTierRuntime(),
      bus: { emit: mocks.emit }, toolContextBase: parent, sessionPolicy: null,
    })
    if (authority === 'granted') {
      expect(candidate.execute).toHaveBeenCalledOnce()
      expect(vi.mocked(candidate.execute).mock.calls[0][0].mode).toBe('review')
    } else {
      expect(candidate.execute).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: false, denied: true })
      if (authority !== 'empty') expect(mocks.chat).not.toHaveBeenCalled()
    }
  })

  it('honors an inherited forced confirmation even with automatic approval enabled', async () => {
    const admitted = tool('chapter_write', async () => ({ output: '不应执行' }), false)
    const ctx = context()
    ctx.toolAuthority = new Map([[admitted.name, { permission: 'ask', alwaysConfirm: true, dangerous: true }]])
    const { waitForApproval } = await import('../../api/lib/agent/permissions.js')
    vi.mocked(waitForApproval).mockResolvedValueOnce({ approved: false, alwaysAllow: false, timedOut: false })
    const previous = env.agentAutoApprove
    env.agentAutoApprove = true
    try {
      const result = await handleToolCall(call('confirm', admitted.name), [admitted], ctx, { emit: mocks.emit }, 'message', 'run')
      expect(waitForApproval).toHaveBeenCalledOnce()
      expect(admitted.execute).not.toHaveBeenCalled()
      expect(result.part.status).toBe('denied')
    } finally { env.agentAutoApprove = previous }
  })
})

describe('Agent run admission and completion lifecycle (real loop, mocked provider/persistence)', () => {
  it('does not pause or zero a run when resume admission loses its state fence', async () => {
    mocks.update.mockRejectedValueOnce(new DataAccessError(409, 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED', '任务状态已变化'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel',
      chapterId: null, mode: 'build', prompt: '原任务', resume: true })
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'task_authorization_runtime_upgrade_required' }))
    expect(events().some(event => event.type === 'run.finished' || event.type === 'run.paused')).toBe(false)
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it.each(['stored', 'previous'] as const)('does not downgrade a durable %s task into the legacy executor even when authorization JSON is absent', async source => {
    const durable = { taskSpec: null, taskRootId: 'durable-root', runtimeProtocolVersion: 1 }
    if (source === 'stored') mocks.update.mockResolvedValueOnce(durable as never)
    else mocks.previous.mockResolvedValueOnce(durable as never)
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '继续' })
      expect(mocks.chat).not.toHaveBeenCalled()
      expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'task_authorization_runtime_upgrade_required' }))
      expect(mocks.update).toHaveBeenCalledOnce()
      const { syncNovelMemoryProjection } = await import('../../api/lib/agent/story-memory.js')
      expect(syncNovelMemoryProjection).not.toHaveBeenCalled()
    } finally { logger.mockRestore() }
  })

  it.each(['stored', 'previous'] as const)('does not rebuild corrupt %s authorization as a default write task', async source => {
    const invalid = { taskSpec: { id: 'root', authorization: { version: 99 } } }
    if (source === 'stored') mocks.update.mockResolvedValueOnce(invalid as never)
    else mocks.previous.mockResolvedValueOnce(invalid as never)
    const write = tool('chapter_write', async () => ({ output: '不应写入' }), false)
    mocks.tools = [write]
    queue(response('', [call('must-not-write', 'chapter_write')]), response())
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '继续' })
      expect(write.execute).not.toHaveBeenCalled()
      expect(mocks.chat).not.toHaveBeenCalled()
      expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'task_authorization_invalid' }))
      const { syncNovelMemoryProjection } = await import('../../api/lib/agent/story-memory.js')
      expect(syncNovelMemoryProjection).not.toHaveBeenCalled()
    } finally { logger.mockRestore() }
  })
  it('terminates a blocked Reader card as failed without suggesting access-control bypass retries', async () => {
    mocks.tools = [tool('web_read', async () => { throw new DataAccessError(422, 'WEB_READ_BLOCKED', '[WEB_READ_BLOCKED] 目标页面要求登录，不得绕过。') })]
    queue(response('读取参考页面。', [call('reader-blocked', 'web_read')]), response('该来源要求登录，未取得正文。'))
    await run('读取公开网页资料')
    const results = events().filter(event => event.type === 'tool.result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ callId: 'reader-blocked', ok: false, summary: '网站要求验证或限制访问' })
    const nextContext = JSON.stringify(mocks.chat.mock.calls[1][0].messages)
    expect(nextContext).toContain('不得绕过')
    expect(nextContext).not.toContain('可以调整参数重试')
  })
  it('does not finalize a successful run again when its terminal journal flush fails', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.dispose.mockRejectedValueOnce(new Error('journal offline'))
    try {
      queue(response('核对完成。'))
      await run()
      expect(events().filter(event => event.type === 'run.finished')).toEqual([
        expect.objectContaining({ status: 'succeeded' }),
      ])
      expect(mocks.update.mock.calls.flatMap(([input]) => input.data.status ? [input.data.status] : [])).toEqual(['running', 'completed'])
      expect(mocks.dispose).toHaveBeenCalledOnce()
    } finally { logger.mockRestore() }
  })
  it('allows a completed continuation without inventing a todo plan at the end', async () => {
    queue(response('第二十二章正文已保存，校验已通过。'))
    await run('请继续完成之前的任务。')
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(events().filter(event => event.type === 'tool.call')).toHaveLength(0)
  })
  it('still follows through on promised work when a continuation has no todo list', async () => {
    queue(response('先读取章节。'), response('', [call('read')]), response('核对完成。'))
    await run('继续')
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it.each(['{', JSON.stringify({ _contextCompacted: true, originalChars: 4000, arguments: { content: 'excerpt' } })])('bounds repeated invalid arguments (%s) instead of spending the entire long-task budget', async args => {
    queue(...['bad1', 'bad2', 'bad3'].map(id => response('', [call(id, 'chapter_read', args)])), response('参数仍无效，已保存进度。'))
    await run()
    expect(mocks.tools[0].execute).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledTimes(4)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })
  it('never executes a provider-truncated tool even when its JSON can be repaired', async () => {
    queue(response('', [{ ...call('partial', 'chapter_read', '{"chapterId":"c'), incomplete: true }]), response('', [call('valid')]), response())
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(events().filter(event => event.type === 'tool.result')).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'partial', ok: false }), expect.objectContaining({ callId: 'valid', ok: true }),
    ]))
  })
  it('rejects duplicate calls before any running event/card, retaining one complete call/result pair', async () => {
    queue(response('', [call('a')]), response('', [call('b')]), response())
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(events().filter(event => event.type === 'tool.call').map(event => event.callId)).toEqual(['a'])
    expect(events().filter(event => event.type === 'tool.result').map(event => event.callId)).toEqual(['a'])
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('allows failed calls to retry and new-revision continuity validation to run', async () => {
    let count = 0
    mocks.tools = [tool('continuity_validate', async () => {
      count++
      if (count === 1) throw new Error('temporary failure')
      return count === 2 ? { output: '修订至 r2', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '章', before: '旧', after: '新', appliedDirectly: true, revision: 2 } } : { output: 'r2 已通过' }
    }, false)]
    queue(...['a', 'b', 'c', 'd'].map(id => response('', [call(id, 'continuity_validate')])), response())
    await run()
    expect(count).toBe(3)
    expect(events().filter(event => event.type === 'tool.call')).toHaveLength(3)
    expect(events().filter(event => event.type === 'tool.result')).toHaveLength(3)
  })

  it('invalidates continuity after a quality report actually rewrites text, then commits', async () => {
    let revision = 1, checkedRevision = 0, committed = false
    mocks.tools = [
      tool('continuity_validate', async () => { checkedRevision = revision; return { output: `r${revision}通过` } }, false),
      tool('quality_analyze', async () => {
        revision++
        return { output: '质量修订完成', display: { kind: 'qualityReport', reportId: 'q', chapterId: 'c', chapterRevision: revision,
          status: 'repaired', repairRound: 1, findings: [] },
          snapshot: { target: 'chapter', targetId: 'c', field: 'content', previousValue: '旧正文' } }
      }, false),
      tool('chapter_bridge_commit', async () => {
        committed = checkedRevision === revision
        return committed ? { output: '已提交' } : { outcome: 'failed', output: '旧版本不能提交' }
      }, false),
    ]
    queue(response('', [call('first', 'continuity_validate')]), response('', [call('quality', 'quality_analyze')]),
      response('', [call('verify', 'continuity_validate')]), response('', [call('commit', 'chapter_bridge_commit')]), response())
    await run('完成本章质量检查并提交章节终态')
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(2)
    expect(committed).toBe(true)
    expect(events().filter(event => event.type === 'tool.result' && !event.ok)).toHaveLength(0)
  })

  it('typed continue restores pending todos and never reports success on repeated empty steps', async () => {
    mocks.todos.mockResolvedValue([{ content: '完成第七章整改', status: 'pending' }])
    queue(...Array.from({ length: 5 }, () => response('现在写入正文。')))
    await run('请继续完成之前的任务。')
    expect(mocks.todos).toHaveBeenCalledWith('session', ['run'])
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it.each(['stop', 'length'] as const)('bounds thinking-only %s responses without replaying their reasoning or claiming completion', async finishReason => {
    const empty = { ...response(''), reasoning: '无效思考'.repeat(1000), finishReason }
    queue(empty, empty)
    await run()
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(JSON.stringify(mocks.chat.mock.calls[1][0].messages)).not.toContain('无效思考')
    expect(mocks.update.mock.calls.some(([arg]) => String(arg.data.errorMessage).includes('连续两轮'))).toBe(true)
  })

  it('recovers an empty response through real tools and preserves explicit user-facing refusal', async () => {
    queue(response(''), response('', [call('actual')]), response('无法完成该要求，请调整范围。'))
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(3)
  })

  it('bounds unchanged memory source failures instead of exhausting the task budget', async () => {
    mocks.tools = [tool('memory_save', async () => { throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '来源版本不匹配') }, false)]
    queue(...['one', 'two', 'three'].map(id => response('', [call(id, 'memory_save')])), response('来源仍未核实。'))
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(3)
    expect(events().filter(e => e.type === 'tool.result').every(e => e.type === 'tool.result' && e.summary === '记忆来源需要重新核对')).toBe(true)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('resets consecutive no-progress reminders after actual advancement, supporting more than four milestones', async () => {
    mocks.todos.mockResolvedValue([{ content: '整改全书', status: 'pending' }])
    mocks.tools.push(tool('todo_write', async () => ({ output: '已完成', display: { kind: 'todoList', items: [{ content: '整改全书', status: 'completed' }] } }), false))
    let chapter = 0
    mocks.tools[0] = tool('chapter_read', async () => ({ output: `第${++chapter}章的不同正文证据` }))
    for (let index = 0; index < 7; index++) queue(response('先读取章节。'), response('', [call(`r${index}`, 'chapter_read', JSON.stringify({ chapter: index }))]))
    queue(response('', [call('done', 'todo_write')]), response())
    await run('继续')
    expect(mocks.chat).toHaveBeenCalledTimes(16)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('no-tool retries cannot bypass token budget or spend on a wrap-up call after exhaustion', async () => {
    mocks.todos.mockResolvedValue([{ content: '整改', status: 'pending' }])
    queue(response('现在写入正文。', [], 600))
    await run('继续', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('a genuinely new request does not inherit unfinished work', async () => {
    mocks.todos.mockResolvedValue([{ content: '无关旧任务', status: 'pending' }])
    queue(response('这是当前章节的摘要。'))
    await run('总结当前章节')
    expect(mocks.todos).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('inherits the original goal on a typed continuation and persists it on the new run', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', chapterId: null, prompt: '整改前七章的人物动机' })
    const previous = { id: 'original', taskSpec, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
      status: 'paused', currentTurn: 1, startedAt: new Date() }
    mocks.previous.mockResolvedValue(previous as never)
    mocks.priorRuns.mockResolvedValue([previous])
    mocks.todos.mockResolvedValue([{ content: '整改前七章', status: 'completed' }])
    queue(response())
    await run('请继续完成之前的任务。')
    expect(mocks.update.mock.calls).toContainEqual([expect.objectContaining({ where: { id: 'run' },
      data: expect.objectContaining({ taskSpec: { ...taskSpec, runId: 'run' },
        usage: expect.objectContaining({ checkpoint: expect.objectContaining({ inheritedTokens: 100, inheritedTurns: 1 }) }) }) })])
    expect(mocks.priorRuns).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sessionId: 'session', userId: 'user', novelId: 'novel', taskSpec: { path: ['id'], equals: taskSpec.id },
    }) }))
  })

  it('typed continuation includes all local run usage once, without double-counting inherited snapshots', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', chapterId: null, prompt: '检查章节' })
    const base = { status: 'paused', currentTurn: 1, startedAt: new Date(), taskSpec }
    const first = { ...base, id: 'first', usage: { promptTokens: 300, completionTokens: 0, totalTokens: 300 } }
    const second = { ...base, id: 'second', usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200,
      checkpoint: { version: 1, runStartedAt: Date.now(), resumeCount: 0, compactionCount: 0,
        maxTurns: env.agentMaxTurns, tokenBudget: 500, writeProgress: 0, writeBaseline: 0, readProgress: 0,
        readBaseline: 0, progressSignatures: [], inheritedTokens: 300, inheritedTurns: 1, manualResumeCount: 2 } } }
    mocks.previous.mockResolvedValue(second as never)
    mocks.priorRuns.mockResolvedValue([first, second])
    await run('继续')
    expect(mocks.chat).not.toHaveBeenCalled()
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'failed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ totalTokens: 0,
      checkpoint: { inheritedTokens: 500, inheritedTurns: 2, tokenBudget: 500 } })
  })

  it('does not stop a batch that contains duplicates followed by new productive work', async () => {
    queue(response('', [call('a')]), response('', [...Array.from({ length: 4 }, (_, i) => call(`dup${i}`)), call('fresh', 'chapter_read', '{"chapter":2}')]), response())
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(2)
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('permits identical todo arguments to advance an atomically accepted partial completion', async () => {
    let completed = 0
    const items: AgentTodoItem[] = [{ content: '一', status: 'in_progress' }, { content: '二', status: 'pending' }]
    mocks.todos.mockResolvedValue(items)
    mocks.tools = [tool('todo_write', async () => ({ output: `完成${++completed}项`, display: { kind: 'todoList', items: items.map((item, i) => ({ ...item, status: i < completed ? 'completed' : 'in_progress' })) } }))]
    queue(response('', [call('t1', 'todo_write')]), response('', [call('t2', 'todo_write')]), response())
    await run('继续')
    expect(completed).toBe(2)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('auto-renews a productive checkpoint by two million tokens but stops at the run hard ceiling', async () => {
    const original = env.agentRunTokenBudgetCeiling
    env.agentRunTokenBudgetCeiling = 1200
    try {
      mocks.todos.mockResolvedValue([{ content: '整改', status: 'pending' }])
      mocks.tools = [tool('chapter_write', async () => ({ output: '已保存', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '章', before: '旧', after: '新', appliedDirectly: true } }), false)]
      queue(response('', [call('write', 'chapter_write')], 600), response('现在修订下一章。', [], 600))
      await run('继续', 500)
      expect(mocks.chat).toHaveBeenCalledTimes(2)
      expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(1)
      expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    } finally { env.agentRunTokenBudgetCeiling = original }
  })

  it.each([
    { toolName: 'chapter_read', prompt: '读取章节并完成检查' },
    { toolName: 'research_report_read', prompt: '分析这本小说' },
  ])('29 R08: a productive $toolName crosses a checkpoint without inventing todos', async ({ toolName, prompt }) => {
    mocks.tools = [tool(toolName, async () => ({ output: '已保存的正文片段，包含可核验的材料。' }))]
    queue(response('', [call('read', toolName)], 600), response('检查完成，结果如下。'))
    await run(prompt, 500)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(mocks.todos).not.toHaveBeenCalled()
  })

  it('29 R08: marking a checklist item complete alone cannot purchase a checkpoint', async () => {
    mocks.todos.mockResolvedValue([{ content: '整改正文', status: 'pending' }])
    mocks.tools = [tool('todo_write', async () => ({ output: '清单已完成',
      display: { kind: 'todoList', items: [{ content: '整改正文', status: 'completed' }] } }), false)]
    queue(response('', [call('todo', 'todo_write')], 600))
    await run('继续', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('29 R08: changed read arguments returning identical evidence cannot buy another slice', async () => {
    queue(response('', [call('read1', 'chapter_read', '{"start":0}')], 600),
      response('', [call('read2', 'chapter_read', '{"start":1}')], 2_000_000))
    await run('读取并检查章节', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('29 R08: failed reads do not renew a checkpoint', async () => {
    mocks.tools = [tool('chapter_read', async () => ({ outcome: 'failed', output: '正文读取失败' }))]
    queue(response('', [call('read')], 600))
    await run('读取并检查章节', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('29 R01/R09: unconfirmed DB finalization never emits a fabricated terminal status', async () => {
    const original = mocks.update.getMockImplementation()!
    mocks.update.mockImplementation(async input => {
      if (input.data.status === 'completed') throw new Error('fixture connection lost at commit')
      return original(input)
    })
    try {
      queue(response('已经完成的结果。'))
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '解释这段内容' })
      expect(events().filter(event => event.type === 'run.finished' || event.type === 'run.paused')).toHaveLength(0)
      expect(events().at(-1)).toMatchObject({ type: 'error', code: 'run_status_unconfirmed' })
      expect(mocks.update.mock.calls.filter(([input]) => ['completed', 'failed', 'paused'].includes(String(input.data.status)))).toHaveLength(1)
      expect(mocks.dispose).toHaveBeenCalledOnce()
    } finally { mocks.update.mockImplementation(original) }
  })
})
