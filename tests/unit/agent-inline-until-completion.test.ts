import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ chat: vi.fn(), tool: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat }))
vi.mock('../../api/lib/agent/loop.js', () => ({ handleToolCall: mocks.tool }))
vi.mock('../../api/lib/agent/goal-runtime.js', () => ({ buildGoalContextMessages: async () => [] }))
vi.mock('../../api/lib/agent/agents.js', () => ({
  getAgentDefinition: () => ({ title: '审阅', model: 'fixture' }), getToolsForAgent: () => [], applySessionToolPolicy: () => [],
}))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ resolveAgent2FeatureFlags: () => ({}) }))
vi.mock('../../api/lib/agent/tool-authority.js', () => ({ intersectToolAuthority: () => [], snapshotToolAuthority: () => new Map() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: {} }))
import { runSubagentInline, type SubagentInlineParams } from '../../api/lib/agent/subagent-runner.js'

const params = (signal = new AbortController().signal): SubagentInlineParams => ({
  subagentCallId: 'same-call', subtaskRunId: 'same-child', name: '子任务', role: 'quality', triggerCondition: '本章', prompt: '审阅本章', task: '原任务',
  mode: 'review', parentRunId: 'same-parent', sessionId: 'same-session', userId: 'user', novelId: 'novel', chapterId: 'chapter', messageId: 'message',
  modelRuntime: { tier: 'speed', multiplierBps: 0, provider: 'fixture', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 16000 },
  bus: { emit: vi.fn() }, toolContextBase: { userId: 'user', novelId: 'novel', runId: 'same-parent', sessionId: 'same-session', chapterId: 'chapter',
    mode: 'review', creativeFreedom: 'balanced', qualityMode: 'premium', emit: vi.fn(), signal, toolAuthority: new Map() }, sessionPolicy: null,
})
const usage = { promptTokens: 1000000, completionTokens: 100, totalTokens: 1000100 }
beforeEach(() => vi.clearAllMocks())

it('keeps one progressing child beyond old 24 turns / 16000 tokens without a budget-summary request', async () => {
  let call = 0
  mocks.chat.mockImplementation(async () => ({ content: call >= 30 ? '依据真实已保存内容完成审阅。' : '', reasoning: '', usage,
    toolCalls: call++ >= 30 ? [] : [{ id: `tool-${call}`, name: 'chapter_read', arguments: '{}' }] }))
  mocks.tool.mockImplementation(async () => ({ observation: `正文证据${call}`, part: {
    type: 'tool-call', callId: `tool-${call}`, toolName: 'chapter_read', title: '读取章节', status: 'success', args: {}, summary: '读取真实内容',
  } }))
  const result = await runSubagentInline(params())
  expect(result).toMatchObject({ ok: true, denied: false, turns: 31, toolCallCount: 30 })
  expect(result.usage.totalTokens).toBe(31 * usage.totalTokens)
  expect(mocks.chat).toHaveBeenCalledTimes(31)
  expect(mocks.chat.mock.calls.every(([request]) => request.usageLog.targetId === 'same-child' && request.usageLog.agentRunId === 'same-parent')).toBe(true)
})

it('parks report-ID-only output and repeated failures truthfully without another paid formatting call', async () => {
  let call = 0
  mocks.chat.mockImplementation(async () => ({ content: '', reasoning: '', usage,
    toolCalls: [{ id: `report-${++call}`, name: 'quality_report_get', arguments: '{}' }] }))
  mocks.tool.mockImplementation(async () => ({ observation: `新报告ID-${call}`, part: {
    type: 'tool-call', callId: `report-${call}`, toolName: 'quality_report_get', title: '读取报告', status: 'success', args: {}, summary: '同一正文',
  } }))
  const result = await runSubagentInline(params())
  expect(result).toMatchObject({ ok: false, turns: 4, toolCallCount: 4 })
  expect(result.report).toContain('尚未完成')
  expect(mocks.chat).toHaveBeenCalledTimes(4)
})

it('preserves cancellation before dispatch instead of declaring completion', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(runSubagentInline(params(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.chat).not.toHaveBeenCalled()
})
