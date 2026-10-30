import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SubagentInlineParams } from '../../api/lib/agent/subagent-runner.js'
const mocks = vi.hoisted(() => ({ chat: vi.fn(), tool: vi.fn(), catalog: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat }))
vi.mock('../../api/lib/agent/loop.js', () => ({ handleToolCall: mocks.tool }))
vi.mock('../../api/lib/agent/goal-runtime.js', () => ({ buildGoalContextMessages: async () => [] }))
vi.mock('../../api/lib/agent/agents.js', () => ({ getAgentDefinition: () => ({ title: '审阅', model: 'fixture' }), getToolsForAgent: () => [], applySessionToolPolicy: () => [] }))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ resolveAgent2FeatureFlags: () => ({}) }))
vi.mock('../../api/lib/agent/tool-authority.js', () => ({ intersectToolAuthority: () => [], snapshotToolAuthority: () => new Map() }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => 'key-' + value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { aiModelConfig: { findFirstOrThrow: mocks.catalog } } }))
import { runSubagentInline } from '../../api/lib/agent/subagent-runner.js'

const pool = { primaryWeight: 70, candidates: [
  { id: 'A', label: 'A', weight: 20, provider: 'relay-A', modelName: 'alias-A', baseUrl: 'https://a.invalid/v1', apiKeyCiphertext: 'cipher-A' },
  { id: 'B', label: 'B', weight: 10, provider: 'relay-B', modelName: 'alias-B', baseUrl: 'https://b.invalid/v1', apiKeyCiphertext: 'cipher-B' },
] }
function params(signal = new AbortController().signal): SubagentInlineParams {
  return { subagentCallId: 'call', subtaskRunId: 'child', name: '子任务', role: 'quality', triggerCondition: '', prompt: '审阅本章', task: '读取后给出结论', mode: 'review',
    parentRunId: 'parent', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'chapter', messageId: 'message',
    modelRuntime: { tier: 'speed', multiplierBps: 12000, provider: 'admitted-provider', modelName: 'admitted-model', baseUrl: 'https://admitted.invalid/v1', apiKey: 'admitted-key',
      reasoningEffort: 'high', reasoningEfforts: ['low', 'high'], reasoningParameterMode: 'native', thinkingEnabled: true, outputTokenParameter: 'max_completion_tokens',
      visionEnabled: true, contextWindowTokens: 16000, tokenPrice: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 12000 } },
    bus: { emit: vi.fn() }, toolContextBase: { userId: 'user', novelId: 'novel', runId: 'parent', sessionId: 'session', chapterId: 'chapter', mode: 'review', creativeFreedom: 'balanced',
      qualityMode: 'premium', emit: vi.fn(), signal, toolAuthority: new Map() }, sessionPolicy: null }
}
const primary = () => ({ provider: 'catalog-primary', modelName: 'catalog-model', baseUrl: 'https://catalog.invalid/v1', apiKeyCiphertext: 'catalog-key', metadata: { weightedRoutes: pool,
  reasoningEfforts: ['low'], defaultReasoningEffort: 'low', thinkingEnabled: false, contextWindowTokens: 4000000, visionEnabled: false },
  multiplierBps: 990000, tokenPrice: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 990000 } })
function progressingReply() {
  let calls = 0
  mocks.chat.mockImplementation(async () => ({ content: ++calls === 3 ? '已完成基于原文的审阅。' : '', reasoning: '', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    toolCalls: calls === 3 ? [] : [{ id: 'read-' + calls, name: 'chapter_read', arguments: '{}' }] }))
  mocks.tool.mockImplementation(async () => ({ observation: '原文证据-' + calls, part: { type: 'tool-call', callId: 'read-' + calls, toolName: 'chapter_read', title: '读取', status: 'success', args: {}, summary: '原文' } }))
}
beforeEach(() => { vi.clearAllMocks(); mocks.catalog.mockReset().mockRejectedValue(new Error('unexpected catalog read')); progressingReply() })
afterEach(() => vi.restoreAllMocks())

it.each(['legacy', 'empty'] as const)('uses the existing admitted %s runtime without a catalog read or a new draw', async mode => {
  const input = params(), random = vi.spyOn(Math, 'random')
  if (mode === 'empty') input.modelRuntime.weightedRoutes = { primaryWeight: 100, candidates: [] }
  await expect(runSubagentInline(input)).resolves.toMatchObject({ ok: true, turns: 3, toolCallCount: 2 })
  expect(mocks.catalog).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled()
  expect(mocks.tool.mock.calls[0][2].modelRuntime).toBe(input.modelRuntime)
  for (const [request] of mocks.chat.mock.calls) expect(request).toMatchObject({ provider: 'admitted-provider', model: 'admitted-model', usageLog: { modelTier: 'speed', multiplierBps: 12000 } })
})
it('selects once directly from an undecided admitted pool and retains that choice through tool roundtrips', async () => {
  const input = params(); input.modelRuntime.weightedRoutes = pool
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.75)
  await expect(runSubagentInline(input)).resolves.toMatchObject({ ok: true, turns: 3, toolCallCount: 2 })
  expect(mocks.catalog).not.toHaveBeenCalled(); expect(random).toHaveBeenCalledOnce()
  for (const [request] of mocks.chat.mock.calls) expect(request).toMatchObject({ provider: 'relay-A', model: 'alias-A', providerApiKey: 'key-cipher-A',
    weightedRoute: { source: 'candidate', candidateId: 'A' }, usageLog: { modelTier: 'speed', multiplierBps: 12000 } })
})
it('draws independently of a weighted parent while replacing only catalog connection fields, never admitted price/protocol/capabilities', async () => {
  const input = params(); input.modelRuntime.weightedRoutes = pool; input.modelRuntime.weightedRoute = { source: 'candidate', candidateId: 'A' }
  input.modelRuntime.provider = 'relay-A'; input.modelRuntime.modelName = 'alias-A'; input.modelRuntime.apiKey = 'parent-A-key'
  mocks.catalog.mockResolvedValue(primary())
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.95)
  await expect(runSubagentInline(input)).resolves.toMatchObject({ ok: true, turns: 3, toolCallCount: 2 })
  expect(mocks.catalog).toHaveBeenCalledExactlyOnceWith({ where: { ownerUserId: null, tier: 'speed', enabled: true },
    select: { provider: true, modelName: true, baseUrl: true, apiKeyCiphertext: true, metadata: true } })
  expect(random).toHaveBeenCalledOnce()
  for (const [request] of mocks.chat.mock.calls) expect(request).toMatchObject({ provider: 'relay-B', model: 'alias-B', providerApiKey: 'key-cipher-B',
    weightedRoute: { source: 'candidate', candidateId: 'B' }, reasoningEffort: 'high', reasoningParameterMode: 'native', thinkingEnabled: true, outputTokenParameter: 'max_completion_tokens',
    usageLog: { modelTier: 'speed', multiplierBps: 12000 } })
  const childRuntime = mocks.tool.mock.calls[0][2].modelRuntime
  expect(childRuntime).toMatchObject({ tier: 'speed', multiplierBps: 12000, tokenPrice: input.modelRuntime.tokenPrice,
    reasoningEfforts: ['low', 'high'], contextWindowTokens: 16000, visionEnabled: true })
  expect(childRuntime.tokenPrice).toBe(input.modelRuntime.tokenPrice)
  expect(input.modelRuntime.weightedRoute).toEqual({ source: 'candidate', candidateId: 'A' })
})
it('preserves the existing abort before the new necessary catalog await', async () => {
  const controller = new AbortController(); controller.abort()
  const input = params(controller.signal); input.modelRuntime.weightedRoute = { source: 'candidate', candidateId: 'A' }
  const random = vi.spyOn(Math, 'random')
  await expect(runSubagentInline(input)).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.catalog).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.tool).not.toHaveBeenCalled()
})
it('does not expand the admitted context window from current catalog capabilities', async () => {
  const input = params(); input.modelRuntime.weightedRoute = { source: 'candidate', candidateId: 'A' }; input.task = '原始任务上下文。'.repeat(20000)
  mocks.catalog.mockResolvedValue(primary()); vi.spyOn(Math, 'random').mockReturnValue(0.95)
  const result = await runSubagentInline(input)
  expect(result).toMatchObject({ ok: false, denied: false, toolCallCount: 0, usage: { totalTokens: 0 } })
  expect(result.report).toContain('上下文'); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.tool).not.toHaveBeenCalled()
})
it('reports an actual weighted-parent catalog failure without falling back, drawing, dispatching or claiming success', async () => {
  const input = params(); input.modelRuntime.weightedRoute = { source: 'candidate', candidateId: 'A' }
  mocks.catalog.mockRejectedValue(new Error('original catalog connection unavailable'))
  const random = vi.spyOn(Math, 'random'), result = await runSubagentInline(input)
  expect(result).toMatchObject({ ok: false, denied: false, turns: 0, toolCallCount: 0, usage: { totalTokens: 0 } })
  expect(result.report).toContain('original catalog connection unavailable')
  expect(mocks.catalog).toHaveBeenCalledOnce(); expect(random).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.tool).not.toHaveBeenCalled()
})
it('preserves the exact admitted BYOK account without catalog lookup or weighted selection', async () => {
  const input = params(); input.modelRuntime.tier = 'custom'; input.modelRuntime.multiplierBps = 0
  input.modelRuntime.weightedRoutes = pool; input.modelRuntime.weightedRoute = { source: 'candidate', candidateId: 'A' }
  const random = vi.spyOn(Math, 'random')
  await expect(runSubagentInline(input)).resolves.toMatchObject({ ok: true, turns: 3, toolCallCount: 2 })
  expect(mocks.catalog).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled()
  expect(mocks.tool.mock.calls[0][2].modelRuntime).toBe(input.modelRuntime)
  for (const [request] of mocks.chat.mock.calls) expect(request).toMatchObject({ provider: 'admitted-provider', model: 'admitted-model', providerApiKey: 'admitted-key', usageLog: { modelTier: 'custom', multiplierBps: 0 } })
})
